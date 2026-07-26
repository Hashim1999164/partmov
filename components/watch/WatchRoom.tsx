"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browseTitleFromUrl, normalizeBrowseUrl } from "@/lib/browse";
import { getCatalogFilm } from "@/lib/catalog";
import {
  DEFAULT_SESSION_MS,
  DEFAULT_SETTINGS,
  canControlPlayback,
  initials,
  type MediaDescriptor,
  type Role,
  type RoomEndReason,
  type RoomSettings,
} from "@/lib/sync-protocol";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useRoomMedia } from "@/hooks/useRoomMedia";
import { useSubtitles } from "@/hooks/useSubtitles";
import { CinemaStage } from "./CinemaStage";
import { VirtualBrowser } from "./VirtualBrowser";
import { ControlStrip } from "./ControlStrip";
import { SubtitleMenu } from "./SubtitleMenu";
import { MediaPanel } from "./MediaPanel";
import { PeoplePanel } from "./PeoplePanel";
import { ChatRail } from "./ChatRail";
import { SettingsPanel } from "./SettingsPanel";
import { InviteSheet } from "./InviteSheet";
import { TransferDock } from "./TransferDock";
import { SessionToast } from "./SessionToast";
import { useAdaptivePlayer } from "@/hooks/useAdaptivePlayer";
import { useWindowedR2Player } from "@/hooks/useWindowedR2Player";
import { fetchPlaybackUrl, refreshPlaybackUrl, streamingV2Enabled } from "@/lib/streaming";
import { clearPendingMedia, getPendingMedia } from "@/lib/pending-media";
import { clearRoomEnded, markRoomEnded } from "@/lib/session-storage";
import {
  clearR2UploadJob,
  getR2UploadJob,
  getR2UploadSubtitle,
  jobToTransferProgress,
  useR2UploadJob,
  useR2UploadUnloadGuard,
} from "@/lib/r2-upload-job";
import type { TransferProgress } from "@/hooks/useRoomMedia";

type RailTab = "chat" | "people" | "media" | "settings";

type Props = {
  code: string;
  role: Role;
  name: string;
  color: string;
  initialMediaId?: string | null;
  /** Host started from lobby with a stashed local file. */
  expectPendingFile?: boolean;
  /** Host started from lobby after uploading the film to R2. */
  expectR2Film?: boolean;
  /** Host started a co-browse room with this URL. */
  initialBrowseUrl?: string | null;
  passphraseGate?: string;
  /** Streaming V2 server room UUID */
  serverRoomId?: string;
  inviteToken?: string;
};

function loadSettings(): RoomSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem("partmov:settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

export function WatchRoom({
  code,
  role: initialRole,
  name,
  color,
  initialMediaId,
  expectPendingFile = false,
  expectR2Film = false,
  initialBrowseUrl = null,
  passphraseGate,
  serverRoomId,
  inviteToken,
}: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const idleTimer = useRef<number | null>(null);

  const [role, setRole] = useState<Role>(initialRole);
  const [playbackToken, setPlaybackToken] = useState<string | null>(null);
  const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);
  const [hlsSrc, setHlsSrc] = useState<string | null>(null);
  const [settings, setSettings] = useState<RoomSettings>(() => {
    const base = loadSettings();
    return { ...DEFAULT_SETTINGS, ...base, expiresAt: base.expiresAt ?? null };
  });
  const [railTab, setRailTab] = useState<RailTab | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [ended, setEnded] = useState(false);
  const [endedMessage, setEndedMessage] = useState(
    "Session ended. Local film data for this room was cleared on this device. Nothing was stored on Partmov’s servers.",
  );
  const [passphrase, setPassphrase] = useState("");
  const [passOk, setPassOk] = useState(!passphraseGate);
  const [roomPassphrase, setRoomPassphrase] = useState("");
  const [expireLeftMs, setExpireLeftMs] = useState<number | null>(null);
  const [expiryToast, setExpiryToast] = useState<string | null>(null);
  const expiryNoticesRef = useRef<Set<string>>(new Set());
  const [uploadInterrupted, setUploadInterrupted] = useState(false);
  const appliedR2KeyRef = useRef<string | null>(null);

  const isHost = role === "host";
  useR2UploadUnloadGuard();
  const uploadJob = useR2UploadJob(code);

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const base = `${window.location.origin}/watch/${code}?as=guest`;
    return roomPassphrase ? `${base}&gate=${encodeURIComponent(roomPassphrase)}` : base;
  }, [code, roomPassphrase]);

  const initialMedia: MediaDescriptor | null = useMemo(() => {
    if (initialMediaId) {
      const film = getCatalogFilm(initialMediaId);
      if (film) {
        return {
          kind: "catalog",
          id: film.id,
          title: film.title,
          src: film.src,
          poster: film.poster,
          credit: film.credit,
          license: film.license,
        };
      }
    }
    return null;
  }, [initialMediaId]);

  const syncSendRef = useRef<(msg: import("@/lib/sync-protocol").SyncMessage) => void>(() => undefined);
  const subsAddRef = useRef<(label: string, url: string) => void>(() => undefined);
  const wipeAllRef = useRef<() => void>(() => undefined);
  const reofferRef = useRef<() => void>(() => undefined);
  const mediaWelcomeRef = useRef<() => MediaDescriptor | null>(() => null);
  const partnerConnectedRef = useRef(false);

  const subs = useSubtitles();
  subsAddRef.current = subs.addTrackFromUrl;

  const [changingTitle, setChangingTitle] = useState<string | null>(null);

  const media = useRoomMedia({
    initial: initialMedia,
    allowCatalogDefault: false,
    code,
    getPartnerConnected: () => partnerConnectedRef.current,
    send: (msg) => syncSendRef.current(msg),
    onSubtitleReceived: (label, url) => subsAddRef.current(label, url),
    onChanging: setChangingTitle,
  });

  const jobTransfer = jobToTransferProgress(uploadJob) as TransferProgress;
  const dockTransfer: TransferProgress = jobTransfer || media.transfer;
  const uploadingCloud =
    Boolean(jobTransfer) ||
    Boolean(
      dockTransfer?.via === "r2" &&
        dockTransfer.direction === "send" &&
        (dockTransfer.phase === "sending" || dockTransfer.phase === "finalizing"),
    );

  reofferRef.current = () => {
    const current = media.currentMediaForWelcome();
    if (current?.kind === "r2" && current.objectKey) {
      syncSendRef.current({ type: "media_set", media: { ...current, src: undefined }, seq: Date.now() });
      return;
    }
    media.reofferHeldVideo();
  };
  mediaWelcomeRef.current = () => media.currentMediaForWelcome();

  const useHls =
    streamingV2Enabled &&
    (Boolean(hlsSrc) || media.media?.kind === "hls" || Boolean(media.media?.masterPlaylistUrl));

  const windowed = useWindowedR2Player({
    videoRef,
    code,
    objectKey: media.media?.kind === "r2" ? media.media.objectKey : null,
    enabled: media.media?.kind === "r2" && !useHls,
  });

  const refreshToken = useCallback(async () => {
    if (!serverRoomId) return;
    try {
      const data = await refreshPlaybackUrl(serverRoomId, { inviteToken });
      setPlaybackToken(data.token);
      setTokenExpiresAt(Date.parse(data.expiresAt));
      setHlsSrc(data.masterPlaylistUrl);
    } catch (err) {
      console.warn("token refresh failed", err);
    }
  }, [serverRoomId, inviteToken]);

  useEffect(() => {
    if (!streamingV2Enabled || !serverRoomId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchPlaybackUrl(serverRoomId, { inviteToken });
        if (cancelled) return;
        setPlaybackToken(data.token);
        setTokenExpiresAt(Date.parse(data.expiresAt));
        setHlsSrc(data.masterPlaylistUrl);
        media.onMediaFromPeer({
          kind: "hls",
          title: media.media?.title || "Stream",
          assetId: undefined,
          masterPlaylistUrl: data.masterPlaylistUrl,
          playbackSessionId: data.playbackSessionId,
          availableLevels: data.levels,
          poster: media.media?.poster,
        });
      } catch (err) {
        console.warn("playback-url failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRoomId, inviteToken]);

  const adaptive = useAdaptivePlayer({
    videoRef,
    src: useHls ? hlsSrc || media.media?.masterPlaylistUrl || null : null,
    token: playbackToken,
    tokenExpiresAt,
    onTokenExpiring: refreshToken,
    enabled: useHls,
    startLevel: 0,
  });

  const finishSession = useCallback(
    (_reason: RoomEndReason, message: string) => {
      wipeAllRef.current();
      if (isHost) {
        void import("@/lib/r2-client").then(({ purgeRoomR2 }) => purgeRoomR2(code));
      }
      markRoomEnded(code, message);
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      setEndedMessage(message);
      setEnded(true);
    },
    [code, isHost],
  );

  const sync = useRoomSync({
    code,
    role,
    name,
    color,
    videoRef,
    settings,
    onSettingsFromPeer: (s) => setSettings((prev) => ({ ...prev, ...s })),
    onMediaFromPeer: (m) => media.onMediaFromPeer(m),
    onFileMessage: (msg) => media.handleFileMessage(msg),
    onSubtitleFromPeer: (trackId) => {
      if (trackId === null) {
        subs.setActiveId(null);
        subs.setVisible(false);
      } else {
        subs.setActiveId(trackId);
        subs.setVisible(true);
      }
    },
    onRoomEnded: (reason, message) => finishSession(reason, message),
    onBecomeHost: () => {
      setRole("host");
      try {
        sessionStorage.setItem(`partmov:role:${code}`, "host");
      } catch {
        /* ignore */
      }
    },
    getCurrentMedia: () => mediaWelcomeRef.current(),
    onGuestNeedsMedia: () => reofferRef.current(),
    onMediaChanging: (title) => {
      setChangingTitle(title);
      media.onMediaChanging(title);
    },
    onMediaClear: () => media.onMediaClear(),
  });

  partnerConnectedRef.current = sync.partnerState === "connected";
  syncSendRef.current = sync.send;

  wipeAllRef.current = () => {
    media.wipeSession();
    subs.clearTracks();
    sync.setChat([]);
  };

  useEffect(() => {
    if (!isHost || !expectR2Film) return;
    let cancelled = false;

    async function applyFromKey(objectKey: string, assetId?: string, title?: string) {
      if (cancelled || appliedR2KeyRef.current === objectKey) return;
      await media.applyR2Film(
        {
          kind: "r2",
          title: title || sessionStorage.getItem(`partmov:r2Title:${code}`) || "Shared film",
          assetId,
          objectKey,
        },
        { broadcast: true },
      );
      if (cancelled) return;
      appliedR2KeyRef.current = objectKey;
      if (sessionStorage.getItem(`partmov:subsPending:${code}`) === "1") {
        const pending = await getPendingMedia(code);
        const subFromJob = getR2UploadSubtitle(code);
        const subFile = pending?.subtitle || subFromJob;
        if (subFile && !cancelled) {
          await media.sendSubtitleFile(subFile);
          const { fileToSubtitleVtt } = await import("@/lib/media-transfer");
          const { label, url } = await fileToSubtitleVtt(subFile);
          if (!cancelled) subs.addTrackFromUrl(label, url);
          await clearPendingMedia(code);
        }
        sessionStorage.removeItem(`partmov:subsPending:${code}`);
      }
      clearR2UploadJob(code);
    }

    void (async () => {
      try {
        const objectKey = sessionStorage.getItem(`partmov:r2Key:${code}`);
        const assetId = sessionStorage.getItem(`partmov:r2Asset:${code}`) || undefined;
        const title = sessionStorage.getItem(`partmov:r2Title:${code}`) || undefined;
        if (objectKey) {
          await applyFromKey(objectKey, assetId, title);
          return;
        }

        // Mid-upload entry: wait for background job (handled by uploadJob effect).
        const uploading = sessionStorage.getItem(`partmov:r2Uploading:${code}`) === "1";
        if (uploading && !getR2UploadJob(code) && !uploadJob) {
          // Reload wiped the in-memory File — cannot resume.
          setUploadInterrupted(true);
        }
      } catch {
        /* applyR2Film sets mediaError */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, expectR2Film, isHost]);

  useEffect(() => {
    if (!isHost || !uploadJob) return;
    if (uploadJob.status === "error") {
      setUploadInterrupted(false);
      return;
    }
    if (uploadJob.status !== "done" || !uploadJob.result) return;
    let cancelled = false;
    void (async () => {
      try {
        const { objectKey, assetId } = uploadJob.result!;
        if (cancelled || appliedR2KeyRef.current === objectKey) return;
        await media.applyR2Film(
          {
            kind: "r2",
            title: uploadJob.title,
            assetId,
            objectKey,
          },
          { broadcast: true },
        );
        if (cancelled) return;
        appliedR2KeyRef.current = objectKey;
        if (sessionStorage.getItem(`partmov:subsPending:${code}`) === "1") {
          const pending = await getPendingMedia(code);
          const subFile = pending?.subtitle || getR2UploadSubtitle(code);
          if (subFile && !cancelled) {
            await media.sendSubtitleFile(subFile);
            const { fileToSubtitleVtt } = await import("@/lib/media-transfer");
            const { label, url } = await fileToSubtitleVtt(subFile);
            if (!cancelled) subs.addTrackFromUrl(label, url);
            await clearPendingMedia(code);
          }
          sessionStorage.removeItem(`partmov:subsPending:${code}`);
        }
        clearR2UploadJob(code);
      } catch {
        /* applyR2Film sets mediaError */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isHost, uploadJob?.status, uploadJob?.result?.objectKey]);

  useEffect(() => {
    if (!isHost || !expectPendingFile) return;
    let cancelled = false;
    void (async () => {
      const pending = await getPendingMedia(code);
      if (cancelled || !pending) return;
      // Prefer cloud upload — never P2P-encode multi-GB files in the room.
      await media.sendLocalFile(pending.video, { replace: false });
      if (cancelled) return;
      if (pending.subtitle) {
        await media.sendSubtitleFile(pending.subtitle);
        const { fileToSubtitleVtt } = await import("@/lib/media-transfer");
        const { label, url } = await fileToSubtitleVtt(pending.subtitle);
        if (!cancelled) subs.addTrackFromUrl(label, url);
      }
      if (!cancelled) await clearPendingMedia(code);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, expectPendingFile, isHost]);

  useEffect(() => {
    if (!isHost || !initialBrowseUrl) return;
    const url = normalizeBrowseUrl(initialBrowseUrl);
    if (!url) return;
    media.setBrowseSite(url, browseTitleFromUrl(url), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, initialBrowseUrl, isHost]);

  // Wire media broadcast helpers to sync seq
  const pickCatalog = useCallback(
    (id: string) => {
      media.setCatalogFilm(id, false);
      const film = getCatalogFilm(id);
      if (film) {
        sync.broadcastMedia({
          kind: "catalog",
          id: film.id,
          title: film.title,
          src: film.src,
          poster: film.poster,
          credit: film.credit,
          license: film.license,
        });
      }
    },
    [media, sync],
  );

  const pasteUrl = useCallback(
    (url: string, title: string) => {
      const ok = media.setUrlFilm(url, title, false);
      if (ok) {
        sync.broadcastMedia({ kind: "url", title: title.trim() || "Pasted film", src: url });
      }
      return ok;
    },
    [media, sync],
  );

  const canPlay = canControlPlayback(role, sync.controlMode, sync.remoteHolder, "play");
  const canSeek = canControlPlayback(role, sync.controlMode, sync.remoteHolder, "seek");
  const canRate = canControlPlayback(role, sync.controlMode, sync.remoteHolder, "rate");
  const canPause = canControlPlayback(role, sync.controlMode, sync.remoteHolder, "pause");

  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (!settings.autoHideChrome) return;
    idleTimer.current = window.setTimeout(() => {
      if (railTab || inviteOpen || subsOpen) return;
      setChromeVisible(false);
    }, 5000);
  }, [settings.autoHideChrome, railTab, inviteOpen, subsOpen]);

  useEffect(() => {
    bumpChrome();
  }, [bumpChrome, railTab]);

  useEffect(() => {
    try {
      localStorage.setItem("partmov:settings", JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      const match = subs.tracks[i];
      const on = Boolean(subs.visible && match && match.id === subs.activeId);
      track.mode = on ? "showing" : "hidden";
    }
  }, [subs.activeId, subs.tracks, subs.visible, media.videoSrc]);

  const updateBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.buffered.length) {
      setBufferedEnd(video.buffered.end(video.buffered.length - 1));
    }
    setBuffering(video.readyState < 3 && sync.playState === "playing");
  }, [sync.playState]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const atEnd =
      video.ended ||
      (Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.paused &&
        video.currentTime >= video.duration - 0.35);

    if (atEnd) {
      if (!canPlay && !canSeek) return;
      if (canSeek) sync.seekTo(0);
      else video.currentTime = 0;
      if (canPlay) sync.requestPlayTogether();
      return;
    }

    if (!video.paused) {
      if (!canPause) return;
      sync.broadcastPause();
      return;
    }
    if (!canPlay) return;
    sync.requestPlayTogether();
  }, [canPause, canPlay, canSeek, sync]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const video = videoRef.current;
      if (!video) return;
      bumpChrome();
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft" && canSeek) {
        e.preventDefault();
        sync.seekTo(Math.max(0, video.currentTime - 5));
      } else if (e.key === "ArrowRight" && canSeek) {
        e.preventDefault();
        sync.seekTo(Math.min(video.duration || 0, video.currentTime + 5));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const v = Math.min(1, (muted ? 0 : volume) + 0.05);
        setVolume(v);
        setMuted(false);
        video.volume = v;
        video.muted = false;
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const v = Math.max(0, (muted ? 0 : volume) - 0.05);
        setVolume(v);
        video.volume = v;
      } else if (e.key === "m" || e.key === "M") {
        setMuted((m) => {
          video.muted = !m;
          return !m;
        });
      } else if (e.key === "f" || e.key === "F") {
        void stageRef.current?.requestFullscreen?.();
      } else if (e.key === "c" || e.key === "C") {
        subs.cycleCaptions();
      } else if (e.key === "Escape") {
        setRailTab(null);
        setInviteOpen(false);
        setSubsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bumpChrome, canSeek, muted, subs, sync, togglePlay, volume]);

  function leave() {
    sync.leaveRoom();
    router.push("/watch");
  }

  function endSession() {
    sync.endRoom("ended");
  }

  function forceEndSession() {
    sync.endRoom("force");
  }

  function updateSettings(next: RoomSettings) {
    setSettings(next);
    if (isHost) sync.broadcastSettings(next);
  }

  function setExpirePreset(ms: number) {
    const expiresAt = ms <= 0 ? null : Date.now() + ms;
    const next = { ...settings, expiresAt };
    setSettings(next);
    sync.setSessionExpire(expiresAt);
    if (isHost) sync.broadcastSettings(next);
  }

  // Default new rooms to a 3-hour session (host stamps once).
  useEffect(() => {
    if (!isHost || ended) return;
    if (settings.expiresAt != null) return;
    const expiresAt = Date.now() + DEFAULT_SESSION_MS;
    const next = { ...settings, expiresAt };
    setSettings(next);
    sync.setSessionExpire(expiresAt);
    sync.broadcastSettings(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, ended]);

  // Session expire countdown + advance warnings
  useEffect(() => {
    if (!settings.expiresAt || ended) {
      setExpireLeftMs(null);
      return;
    }
    const expiresAt = settings.expiresAt;
    const tick = () => {
      const left = expiresAt - Date.now();
      if (left <= 0) {
        setExpireLeftMs(0);
        if (isHost) {
          sync.endRoom("expired");
        } else {
          finishSession("expired", "Session expired. Local film data was cleared on each device.");
        }
        return;
      }
      setExpireLeftMs(left);

      const marks: Array<{ key: string; at: number; message: string }> = [
        { key: "30m", at: 30 * 60 * 1000, message: "Session ends in 30 minutes." },
        { key: "10m", at: 10 * 60 * 1000, message: "Session ends in 10 minutes." },
        { key: "5m", at: 5 * 60 * 1000, message: "Session ends in 5 minutes." },
        { key: "1m", at: 60 * 1000, message: "Session ends in 1 minute — wrapping up soon." },
      ];
      for (const m of marks) {
        if (left <= m.at && left > m.at - 1500 && !expiryNoticesRef.current.has(m.key)) {
          expiryNoticesRef.current.add(m.key);
          setExpiryToast(m.message);
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.expiresAt, ended, isHost]);

  useEffect(() => {
    if (!expiryToast) return;
    if (expireLeftMs !== null && expireLeftMs <= 60_000) return;
    const id = window.setTimeout(() => setExpiryToast(null), 12_000);
    return () => window.clearTimeout(id);
  }, [expiryToast, expireLeftMs]);

  if (passphraseGate && !passOk) {
    return (
      <div className="cinema-boot">
        <h1>Enter passphrase</h1>
        <p>This room has a client-side gate set by the host.</p>
        <form
          className="stack stack--sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (passphrase === passphraseGate) setPassOk(true);
            else sync.setStatus("Wrong passphrase");
          }}
        >
          <label className="watch-field">
            <span>Passphrase</span>
            <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </label>
          <button type="submit" className="btn btn--primary">
            Enter cinema
          </button>
        </form>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="cinema-boot">
        <h1>Session ended</h1>
        <p>{endedMessage}</p>
        <div className="cinema-boot__actions">
          <a
            className="btn btn--primary"
            href="/watch"
            onClick={() => {
              clearRoomEnded(code);
            }}
          >
            Back to lobby
          </a>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              clearRoomEnded(code);
              window.location.assign(`/watch/${encodeURIComponent(code)}`);
            }}
          >
            Try this room again
          </button>
        </div>
      </div>
    );
  }

  const title =
    settings.roomTitle || media.media?.title || "Private cinema";
  const isBrowse = media.media?.kind === "browse" && Boolean(media.media.src);
  const browseUrlLive = isBrowse ? media.media!.src! : "";

  function navigateBrowse(raw: string) {
    const url = normalizeBrowseUrl(raw);
    if (!url) return;
    media.setBrowseSite(url, browseTitleFromUrl(url), true);
  }

  return (
    <div
      className={`cinema${settings.reduceMotion ? " cinema--still" : ""}${chromeVisible ? "" : " cinema--idle"}`}
      onMouseMove={bumpChrome}
    >
      <header className="cinema-top">
        <div className="cinema-top__left">
          <span className="cinema-top__code">{code}</span>
          <strong>{title}</strong>
        </div>
        <div className="cinema-top__people">
          <span className="people-avatar people-avatar--sm" style={{ background: color }} title={name}>
            {initials(name)}
          </span>
          <span
            className="people-avatar people-avatar--sm"
            style={{ background: sync.partnerColor, opacity: sync.partnerName ? 1 : 0.4 }}
            title={sync.partnerName ?? "Waiting"}
          >
            {sync.partnerName ? initials(sync.partnerName) : "?"}
          </span>
          <span className="cinema-top__badge">{isHost ? "host" : "guest"}</span>
        </div>
        <div className="cinema-top__meta">
          <span className={`cinema-sync${sync.partnerState === "connected" ? " is-live" : ""}`}>
            {sync.syncLabel}
            {sync.partnerState === "connected" ? ` · ${sync.driftMs} ms` : ""}
          </span>
          {expireLeftMs !== null && expireLeftMs > 0 && expireLeftMs <= 60_000 && (
            <span className="cinema-top__expire cinema-top__expire--urgent" title="Session expires">
              {Math.ceil(expireLeftMs / 1000)}s
            </span>
          )}
          {expireLeftMs !== null && expireLeftMs > 60_000 && (
            <span className="cinema-top__expire" title="Session expires">
              {Math.floor(expireLeftMs / 60000)}m {Math.floor((expireLeftMs % 60000) / 1000)}s
            </span>
          )}
          {isHost && (
            <button type="button" className="btn btn--ghost cinema-top__invite" onClick={() => setInviteOpen(true)}>
              Invite
            </button>
          )}
        </div>
      </header>

      <div className="cinema-body">
        <div className="cinema-main" ref={stageRef}>
          {isBrowse ? (
            <VirtualBrowser
              url={browseUrlLive}
              canNavigate={isHost || sync.controlMode !== "host_only"}
              partnerName={sync.partnerName}
              onNavigate={navigateBrowse}
            />
          ) : (
            <CinemaStage
              videoRef={videoRef}
              src={
                useHls
                  ? undefined
                  : windowed.fallbackSrc ||
                    (media.media?.kind === "r2" && windowed.active ? undefined : media.videoSrc) ||
                    undefined
              }
              hlsManaged={useHls || (media.media?.kind === "r2" && windowed.active && !windowed.fallbackSrc)}
              poster={media.poster}
              tracks={subs.tracks}
              activeTrackId={subs.activeId}
              subtitleVisible={subs.visible}
              subtitleStyle={subs.style}
              countdown={sync.countdown}
              buffering={
                buffering ||
                (useHls && !adaptive.ready) ||
                (media.media?.kind === "r2" &&
                  !uploadingCloud &&
                  !windowed.ready &&
                  !windowed.error &&
                  !windowed.fallbackSrc)
              }
              waitingPartner={sync.partnerState !== "connected" && isHost && !uploadingCloud}
              partnerName={sync.partnerName}
              waitingMedia={!media.hasPlayableMedia && !useHls}
              changingTitle={
                uploadingCloud || dockTransfer ? null : changingTitle || media.changingTitle
              }
              transferLabel={
                uploadingCloud && dockTransfer
                  ? `${dockTransfer.pct}% · ${dockTransfer.fileName}`
                  : uploadInterrupted
                    ? "Upload was interrupted — reload clears in-progress uploads. Re-add the film from Media."
                    : uploadJob?.status === "error"
                      ? uploadJob.error || "Cloud upload failed"
                      : windowed.error
                        ? windowed.error
                        : null
              }
              reactions={sync.reactions}
              onTimeUpdate={() => {
                const v = videoRef.current;
                if (!v || sync.applyingRef.current) {
                  if (v) sync.setPosition(v.currentTime);
                  updateBuffered();
                  return;
                }
                sync.setPosition(v.currentTime);
                updateBuffered();
              }}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                if (v) sync.setDuration(v.duration || 0);
                updateBuffered();
              }}
              onPlay={() => {
                if (!sync.applyingRef.current) sync.setPlayState("playing");
              }}
              onPause={() => {
                if (!sync.applyingRef.current) sync.setPlayState("paused");
              }}
              onEnded={() => {
                if (sync.applyingRef.current) return;
                sync.setPlayState("paused");
                const v = videoRef.current;
                if (v && Number.isFinite(v.duration) && v.duration > 0) {
                  sync.setDuration(v.duration);
                  sync.setPosition(v.duration);
                }
              }}
              onError={media.onVideoError}
              onClickStage={togglePlay}
            />
          )}
          {!isBrowse && (
          <ControlStrip
            playing={sync.playState === "playing"}
            position={sync.position}
            duration={sync.duration}
            bufferedEnd={bufferedEnd}
            volume={volume}
            muted={muted}
            rate={sync.playbackRate}
            canPlay={canPlay || sync.playState === "playing"}
            canSeek={canSeek}
            canRate={canRate}
            onTogglePlay={togglePlay}
            onSeek={(t) => {
              if (!canSeek) return;
              sync.seekTo(t);
            }}
            onSkip={(delta) => {
              if (!canSeek) return;
              const video = videoRef.current;
              if (!video) return;
              const next = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
              sync.seekTo(next);
            }}
            onVolume={(v) => {
              setVolume(v);
              setMuted(v === 0);
              if (videoRef.current) {
                videoRef.current.volume = v;
                videoRef.current.muted = v === 0;
              }
            }}
            onMute={() => {
              setMuted((m) => {
                const next = !m;
                if (videoRef.current) videoRef.current.muted = next;
                return next;
              });
            }}
            onFullscreen={() => {
              const el = stageRef.current;
              if (!el) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void el.requestFullscreen();
            }}
            onPiP={async () => {
              const v = videoRef.current as HTMLVideoElement & {
                requestPictureInPicture?: () => Promise<void>;
              };
              if (v?.requestPictureInPicture) await v.requestPictureInPicture();
            }}
            onRate={(r) => {
              if (!canRate) return;
              sync.setRate(r);
            }}
            onOpenSubtitles={() => setSubsOpen(true)}
            captionsOn={subs.visible && Boolean(subs.activeId)}
            qualityLevels={useHls ? adaptive.levels.map((l) => ({ index: l.index, label: l.label })) : undefined}
            qualityValue={useHls ? (adaptive.autoLevel ? "auto" : adaptive.currentLevel) : "auto"}
            onQuality={useHls ? adaptive.setQuality : undefined}
          />
          )}
        </div>

        <aside className={`cinema-rail${railTab ? " is-open" : ""}`}>
          <div className="cinema-rail__tabs">
            {(["chat", "people", "media", "settings"] as RailTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={railTab === tab ? "is-on" : ""}
                onClick={() => setRailTab((t) => (t === tab ? null : tab))}
              >
                {tab}
              </button>
            ))}
          </div>
          {railTab === "chat" && (
            <ChatRail
              chat={sync.chat}
              partnerTyping={sync.partnerTyping}
              partnerName={sync.partnerName}
              onSend={sync.sendChat}
              onReaction={sync.sendReaction}
              onTyping={sync.sendTyping}
            />
          )}
          {railTab === "people" && (
            <PeoplePanel
              role={role}
              name={name}
              color={color}
              partnerName={sync.partnerName}
              partnerColor={sync.partnerColor}
              partnerState={sync.partnerState}
              selfReady={sync.selfReady}
              partnerReady={sync.partnerReady}
              controlMode={sync.controlMode}
              remoteHolder={sync.remoteHolder}
              controlRequested={sync.controlRequested}
              onSetMode={sync.setMode}
              onRequestControl={sync.requestControl}
              onApproveControl={() => {
                sync.setMode("handed_to_guest", "guest");
                sync.setControlRequested(false);
              }}
              onDenyControl={() => sync.setControlRequested(false)}
            />
          )}
          {railTab === "media" && (
            <MediaPanel
              isHost={isHost}
              currentTitle={media.media?.title}
              transfer={dockTransfer}
              changingTitle={changingTitle || media.changingTitle}
              error={
                media.mediaError ||
                (uploadJob?.status === "error" ? uploadJob.error : null) ||
                (uploadInterrupted
                  ? "Upload interrupted by a page reload. Choose the film again in Media."
                  : null)
              }
              onPickCatalog={pickCatalog}
              onPasteUrl={pasteUrl}
              onLocalFile={(file) => void media.sendLocalFile(file, { replace: true })}
              onBrowseUrl={(raw, label) => {
                const next = normalizeBrowseUrl(raw);
                if (!next) {
                  return false;
                }
                media.setBrowseSite(next, label || browseTitleFromUrl(next), true);
                return true;
              }}
            />
          )}
          {railTab === "settings" && (
            <SettingsPanel
              settings={settings}
              isHost={isHost}
              onChange={updateSettings}
              onClearChat={() => sync.setChat([])}
              onLeave={leave}
              onEndSession={isHost ? endSession : undefined}
              onForceEnd={isHost ? forceEndSession : undefined}
              onExpirePreset={isHost ? setExpirePreset : undefined}
            />
          )}
        </aside>
      </div>

      <p className="cinema-status" role="status">
        {windowed.error
          ? windowed.error
          : dockTransfer
          ? `${dockTransfer.via === "r2" ? (dockTransfer.direction === "send" ? "Uploading to cloud" : "Streaming from cloud") : dockTransfer.direction === "send" ? "Sending" : "Receiving"} “${dockTransfer.fileName}” · ${dockTransfer.pct}%`
          : uploadInterrupted
            ? "Upload interrupted — re-add the film from Media."
            : uploadJob?.status === "error"
              ? uploadJob.error || "Cloud upload failed"
              : changingTitle || media.changingTitle
                ? `Changing film to “${changingTitle || media.changingTitle}”…`
                : (sync.error ?? sync.status)}
        {media.media?.credit ? ` · ${media.media.credit}` : ""}
      </p>

      <TransferDock transfer={dockTransfer} />
      <SessionToast
        message={expiryToast}
        tone={expireLeftMs !== null && expireLeftMs <= 5 * 60 * 1000 ? "warn" : "info"}
        onDismiss={() => setExpiryToast(null)}
      />

      <SubtitleMenu
        open={subsOpen}
        onClose={() => setSubsOpen(false)}
        tracks={subs.tracks}
        activeId={subs.activeId}
        visible={subs.visible}
        style={subs.style}
        canAdd={isHost}
        onSelect={(id) => {
          subs.setActiveId(id);
          if (canControlPlayback(role, sync.controlMode, sync.remoteHolder, "subtitle_track") || isHost) {
            sync.broadcastSubtitle(id);
          }
        }}
        onVisible={(v) => {
          subs.setVisible(v);
          if (!v && (isHost || canControlPlayback(role, sync.controlMode, sync.remoteHolder, "subtitle_track"))) {
            sync.broadcastSubtitle(null);
          } else if (v && subs.activeId) {
            if (isHost || canControlPlayback(role, sync.controlMode, sync.remoteHolder, "subtitle_track")) {
              sync.broadcastSubtitle(subs.activeId);
            }
          }
        }}
        onStyle={subs.persistStyle}
        onAddFile={(file) => {
          void (async () => {
            const track = await subs.addTrackFromFile(file);
            await media.sendSubtitleFile(file);
            if (track) sync.broadcastSubtitle(track.id);
          })();
        }}
      />

      <InviteSheet
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        code={code}
        inviteUrl={inviteUrl}
        passphrase={roomPassphrase}
        onPassphrase={setRoomPassphrase}
      />
    </div>
  );
}

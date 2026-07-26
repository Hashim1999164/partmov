"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getCatalogFilm } from "@/lib/catalog";
import {
  DEFAULT_SETTINGS,
  canControlPlayback,
  initials,
  type MediaDescriptor,
  type Role,
  type RoomSettings,
} from "@/lib/sync-protocol";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useRoomMedia } from "@/hooks/useRoomMedia";
import { useSubtitles } from "@/hooks/useSubtitles";
import { CinemaStage } from "./CinemaStage";
import { ControlStrip } from "./ControlStrip";
import { SubtitleMenu } from "./SubtitleMenu";
import { MediaPanel } from "./MediaPanel";
import { PeoplePanel } from "./PeoplePanel";
import { ChatRail } from "./ChatRail";
import { SettingsPanel } from "./SettingsPanel";
import { InviteSheet } from "./InviteSheet";

type RailTab = "chat" | "people" | "media" | "settings";

type Props = {
  code: string;
  role: Role;
  name: string;
  color: string;
  initialMediaId?: string | null;
  passphraseGate?: string;
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

export function WatchRoom({ code, role, name, color, initialMediaId, passphraseGate }: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const idleTimer = useRef<number | null>(null);

  const [settings, setSettings] = useState<RoomSettings>(loadSettings);
  const [railTab, setRailTab] = useState<RailTab | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [ended, setEnded] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passOk, setPassOk] = useState(!passphraseGate);
  const [roomPassphrase, setRoomPassphrase] = useState("");

  const isHost = role === "host";

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

  const subs = useSubtitles();
  subsAddRef.current = subs.addTrackFromUrl;

  const media = useRoomMedia({
    initial: initialMedia,
    send: (msg) => syncSendRef.current(msg),
    onSubtitleReceived: (label, url) => subsAddRef.current(label, url),
  });

  const sync = useRoomSync({
    code,
    role,
    name,
    color,
    videoRef,
    settings,
    onSettingsFromPeer: (s) => setSettings(s),
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
    onRoomEnded: () => setEnded(true),
  });

  syncSendRef.current = sync.send;

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
    if (!video.paused) {
      if (!canPause) return;
      sync.broadcastPause();
      return;
    }
    if (!canPlay) return;
    sync.requestPlayTogether();
  }, [canPause, canPlay, sync]);

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
    router.push("/watch");
  }

  function endRoom() {
    sync.endRoom();
    setEnded(true);
  }

  function updateSettings(next: RoomSettings) {
    setSettings(next);
    if (isHost) sync.broadcastSettings(next);
  }

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
        <h1>Room closed</h1>
        <p>The host ended this private cinema.</p>
        <button type="button" className="btn btn--primary" onClick={leave}>
          Back to lobby
        </button>
      </div>
    );
  }

  const title =
    settings.roomTitle || media.media?.title || "Private cinema";

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
          {isHost && (
            <button type="button" className="btn btn--ghost cinema-top__invite" onClick={() => setInviteOpen(true)}>
              Invite
            </button>
          )}
        </div>
      </header>

      <div className="cinema-body">
        <div className="cinema-main" ref={stageRef}>
          <CinemaStage
            videoRef={videoRef}
            src={media.videoSrc}
            poster={media.poster}
            tracks={subs.tracks}
            activeTrackId={subs.activeId}
            subtitleVisible={subs.visible}
            subtitleStyle={subs.style}
            countdown={sync.countdown}
            buffering={buffering}
            waitingPartner={sync.partnerState !== "connected" && isHost}
            partnerName={sync.partnerName}
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
            onError={media.onVideoError}
            onClickStage={togglePlay}
          />
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
          />
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
              transfer={media.transfer}
              error={media.mediaError}
              onPickCatalog={pickCatalog}
              onPasteUrl={pasteUrl}
              onLocalFile={(file) => void media.sendLocalFile(file)}
            />
          )}
          {railTab === "settings" && (
            <SettingsPanel
              settings={settings}
              isHost={isHost}
              onChange={updateSettings}
              onClearChat={() => sync.setChat([])}
              onLeave={leave}
              onEndRoom={isHost ? endRoom : undefined}
            />
          )}
        </aside>
      </div>

      <p className="cinema-status" role="status">
        {sync.error ?? sync.status}
        {media.media?.credit ? ` · ${media.media.credit}` : ""}
      </p>

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

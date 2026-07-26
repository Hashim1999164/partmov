"use client";

/**
 * Streaming V2 cinema room — authoritative WebSocket sync + hls.js ABR.
 * Activated when NEXT_PUBLIC_STREAMING_V2=true and ?roomId= is present.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MediaDescriptor, RoomSettings } from "@partmov/protocol";
import { DEFAULT_SETTINGS } from "@partmov/protocol";
import { useAuthoritativeSync } from "@/hooks/useAuthoritativeSync";
import { useAdaptivePlayer } from "@/hooks/useAdaptivePlayer";
import { fetchPlaybackUrl, refreshPlaybackUrl, syncWsUrl } from "@/lib/streaming";
import { CinemaStage } from "./CinemaStage";
import { ControlStrip } from "./ControlStrip";

type Props = {
  code: string;
  roomId: string;
  name: string;
  color: string;
  inviteToken?: string;
};

export function StreamingWatchRoom({ code, roomId, name, color, inviteToken }: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [settings, setSettings] = useState<RoomSettings>(DEFAULT_SETTINGS);
  const [media, setMedia] = useState<MediaDescriptor | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenExp, setTokenExp] = useState<number | null>(null);
  const [hlsSrc, setHlsSrc] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [ended, setEnded] = useState<{ reason: string; message: string } | null>(null);
  const levelRef = useRef<number | undefined>(undefined);

  const refreshToken = useCallback(async () => {
    const data = await refreshPlaybackUrl(roomId, { inviteToken });
    setToken(data.token);
    setTokenExp(Date.parse(data.expiresAt));
    setHlsSrc(data.masterPlaylistUrl);
  }, [roomId, inviteToken]);

  useEffect(() => {
    void (async () => {
      const data = await fetchPlaybackUrl(roomId, { inviteToken });
      setToken(data.token);
      setTokenExp(Date.parse(data.expiresAt));
      setHlsSrc(data.masterPlaylistUrl);
      setMedia({
        kind: "hls",
        title: "Private stream",
        masterPlaylistUrl: data.masterPlaylistUrl,
        playbackSessionId: data.playbackSessionId,
        availableLevels: data.levels,
      });
    })().catch(console.error);
  }, [roomId, inviteToken]);

  const adaptive = useAdaptivePlayer({
    videoRef,
    src: hlsSrc,
    token,
    tokenExpiresAt: tokenExp,
    onTokenExpiring: refreshToken,
    enabled: Boolean(hlsSrc),
    startLevel: 0,
  });
  levelRef.current = adaptive.autoLevel ? undefined : adaptive.currentLevel;

  const sync = useAuthoritativeSync({
    roomId,
    wsUrl: syncWsUrl,
    displayName: name,
    color,
    inviteToken,
    videoRef,
    settings,
    onSettings: setSettings,
    onMedia: setMedia,
    onEnded: (reason, message) => setEnded({ reason, message }),
    getBufferedAheadMs: () => {
      const v = videoRef.current;
      if (!v || !v.buffered.length) return 0;
      return Math.max(0, (v.buffered.end(v.buffered.length - 1) - v.currentTime) * 1000);
    },
    getLevel: () => levelRef.current,
  });

  useEffect(() => {
    if (media?.masterPlaylistUrl) setHlsSrc(media.masterPlaylistUrl);
  }, [media]);

  // Welcome/reconnect often arrives before HLS is seekable — snap to room time once ready.
  useEffect(() => {
    if (!adaptive.ready) return;
    sync.resyncToSession(true);
  }, [adaptive.ready, sync.resyncToSession]);

  if (ended) {
    return (
      <div className="cinema-boot">
        <h1>Session ended</h1>
        <p>{ended.message}</p>
        <button type="button" className="btn btn--primary" onClick={() => router.push("/watch")}>
          Back to lobby
        </button>
      </div>
    );
  }

  const canPlay = sync.can("play");
  const canSeek = sync.can("seek");
  const canRate = sync.can("rate");

  return (
    <div className="cinema">
      <header className="cinema-top">
        <div className="cinema-top__left">
          <span className="cinema-top__code">{code}</span>
          <strong>{settings.roomTitle || media?.title || "Streaming room"}</strong>
        </div>
        <div className="cinema-top__meta">
          <span className={`cinema-sync${sync.connected ? " is-live" : ""}`}>
            {!sync.connected
              ? "Reconnecting…"
              : sync.catchingUp
                ? "Catching up to room time…"
                : "Room clock · everyone in sync"}{" "}
            · V2
          </span>
          {sync.role === "host" && (
            <button type="button" className="btn btn--ghost" onClick={() => sync.endRoom("ended")}>
              End
            </button>
          )}
        </div>
      </header>

      <div className="cinema-body">
        <div className="cinema-main" ref={stageRef}>
          <CinemaStage
            videoRef={videoRef}
            hlsManaged
            poster={media?.poster}
            tracks={[]}
            activeTrackId={null}
            subtitleVisible={false}
            subtitleStyle={{ size: "m", offset: 24, contrast: true }}
            countdown={sync.countdown}
            buffering={!adaptive.ready}
            waitingPartner={sync.partners.length < 2 && sync.role === "host"}
            partnerName={sync.partners.find((p) => p.displayName !== name)?.displayName ?? null}
            reactions={sync.reactions}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.buffered.length) setBufferedEnd(v.buffered.end(v.buffered.length - 1));
            }}
            onLoadedMetadata={() => undefined}
            onPlay={() => undefined}
            onPause={() => undefined}
            onError={() => undefined}
            onClickStage={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) {
                if (canPlay) sync.play(v.currentTime);
              } else {
                sync.pause(v.currentTime);
              }
            }}
          />
          <ControlStrip
            playing={sync.playing}
            position={sync.position}
            duration={videoRef.current?.duration || 0}
            bufferedEnd={bufferedEnd}
            volume={volume}
            muted={muted}
            rate={sync.rate}
            canPlay={canPlay || sync.playing}
            canSeek={canSeek}
            canRate={canRate}
            onTogglePlay={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) sync.play(v.currentTime);
              else sync.pause(v.currentTime);
            }}
            onSeek={(t) => canSeek && sync.seek(t)}
            onSkip={(d) => {
              const v = videoRef.current;
              if (!v || !canSeek) return;
              sync.seek(Math.max(0, Math.min(v.duration || 0, v.currentTime + d)));
            }}
            onVolume={(v) => {
              setVolume(v);
              if (videoRef.current) videoRef.current.volume = v;
            }}
            onMute={() => {
              setMuted((m) => {
                if (videoRef.current) videoRef.current.muted = !m;
                return !m;
              });
            }}
            onFullscreen={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void stageRef.current?.requestFullscreen();
            }}
            onPiP={async () => {
              const v = videoRef.current as HTMLVideoElement & {
                requestPictureInPicture?: () => Promise<void>;
              };
              if (v?.requestPictureInPicture) await v.requestPictureInPicture();
            }}
            onRate={(r) => canRate && sync.setRateCmd(r)}
            onOpenSubtitles={() => {
              if (adaptive.subtitleTracks[0]) adaptive.setSubtitleTrack(0);
            }}
            captionsOn={false}
            qualityLevels={adaptive.levels.map((l) => ({ index: l.index, label: l.label }))}
            qualityValue={adaptive.autoLevel ? "auto" : adaptive.currentLevel}
            onQuality={adaptive.setQuality}
          />
          {adaptive.error && <p className="rail-panel__error">{adaptive.error}</p>}
        </div>
      </div>
    </div>
  );
}

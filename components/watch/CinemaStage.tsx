"use client";

import type { RefObject } from "react";
import type { SubtitleStyle, SubtitleTrackInfo } from "@/lib/sync-protocol";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Progressive MP4/blob URL. Omit when hls.js owns the media element. */
  src?: string;
  poster?: string;
  /** When true, do not set the video src attribute (adaptive player attaches). */
  hlsManaged?: boolean;
  tracks: SubtitleTrackInfo[];
  activeTrackId: string | null;
  subtitleVisible: boolean;
  subtitleStyle: SubtitleStyle;
  countdown: number | null;
  buffering: boolean;
  waitingPartner: boolean;
  partnerName: string | null;
  waitingMedia?: boolean;
  changingTitle?: string | null;
  transferLabel?: string | null;
  reactions: { id: string; glyph: string; name: string }[];
  onTimeUpdate: () => void;
  onLoadedMetadata: () => void;
  onPlay: () => void;
  onPause: () => void;
  onEnded?: () => void;
  onError: () => void;
  onClickStage: () => void;
};

export function CinemaStage({
  videoRef,
  src,
  poster,
  hlsManaged = false,
  tracks,
  activeTrackId,
  subtitleVisible,
  subtitleStyle,
  countdown,
  buffering,
  waitingPartner,
  partnerName,
  waitingMedia = false,
  changingTitle = null,
  transferLabel = null,
  reactions,
  onTimeUpdate,
  onLoadedMetadata,
  onPlay,
  onPause,
  onEnded,
  onError,
  onClickStage,
}: Props) {
  const sizeClass =
    subtitleStyle.size === "s" ? "cinema-stage--cap-s" : subtitleStyle.size === "l" ? "cinema-stage--cap-l" : "cinema-stage--cap-m";

  return (
    <div
      className={`cinema-stage ${sizeClass}${subtitleStyle.contrast ? " cinema-stage--cap-contrast" : ""}`}
      style={{ ["--cap-offset" as string]: `${subtitleStyle.offset}px` }}
      onClick={onClickStage}
    >
      <video
        ref={videoRef}
        className="cinema-stage__video"
        {...(hlsManaged ? {} : { src })}
        poster={poster}
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onError={onError}
        onClick={(e) => e.stopPropagation()}
      >
        {tracks.map((t) => (
          <track
            key={t.id}
            kind="subtitles"
            src={t.url}
            srcLang={t.language}
            label={t.label}
            default={subtitleVisible && t.id === activeTrackId}
          />
        ))}
      </video>

      {countdown !== null && (
        <div className="cinema-stage__countdown" aria-live="polite">
          <span>{countdown}</span>
          <p>Starting together</p>
        </div>
      )}

      {changingTitle && !countdown && (
        <div className="cinema-stage__overlay">
          <div className="cinema-stage__spinner" />
          <p>Host is changing the film</p>
          <p className="cinema-stage__overlay-sub">{changingTitle}</p>
          {transferLabel ? <p className="cinema-stage__overlay-sub">{transferLabel}</p> : null}
        </div>
      )}

      {waitingMedia && !changingTitle && !buffering && countdown === null && (
        <div className="cinema-stage__overlay">
          <div className="cinema-stage__spinner" />
          {transferLabel ? (
            <>
              <p>{/\d+%/.test(transferLabel) ? "Uploading to cloud…" : "Can’t start playback"}</p>
              <p className="cinema-stage__overlay-sub">{transferLabel}</p>
            </>
          ) : (
            <p>Waiting for the film…</p>
          )}
        </div>
      )}

      {buffering && countdown === null && !changingTitle && (
        <div className="cinema-stage__overlay">
          <div className="cinema-stage__spinner" />
          <p>Buffering…</p>
        </div>
      )}

      {waitingPartner && !waitingMedia && !changingTitle && !buffering && countdown === null && (
        <div className="cinema-stage__overlay cinema-stage__overlay--soft">
          <p>Waiting for {partnerName ?? "your partner"}</p>
        </div>
      )}

      <div className="cinema-stage__reactions" aria-hidden>
        {reactions.map((r) => (
          <span key={r.id} className="cinema-stage__reaction">
            {r.glyph}
          </span>
        ))}
      </div>
    </div>
  );
}

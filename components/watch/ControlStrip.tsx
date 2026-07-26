"use client";

import { formatTime } from "@/lib/sync-protocol";

type Props = {
  playing: boolean;
  position: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  rate: number;
  canPlay: boolean;
  canSeek: boolean;
  canRate: boolean;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onSkip: (delta: number) => void;
  onVolume: (v: number) => void;
  onMute: () => void;
  onFullscreen: () => void;
  onPiP: () => void;
  onRate: (r: number) => void;
  onOpenSubtitles: () => void;
  captionsOn: boolean;
};

const RATES = [0.75, 1, 1.25, 1.5, 2];

export function ControlStrip({
  playing,
  position,
  duration,
  bufferedEnd,
  volume,
  muted,
  rate,
  canPlay,
  canSeek,
  canRate,
  onTogglePlay,
  onSeek,
  onSkip,
  onVolume,
  onMute,
  onFullscreen,
  onPiP,
  onRate,
  onOpenSubtitles,
  captionsOn,
}: Props) {
  const pct = duration > 0 ? (position / duration) * 100 : 0;
  const buf = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div className="control-strip" onClick={(e) => e.stopPropagation()}>
      <div className="control-strip__scrub">
        <div className="control-strip__buf" style={{ width: `${buf}%` }} />
        <div className="control-strip__played" style={{ width: `${pct}%` }} />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={position}
          disabled={!canSeek || !duration}
          aria-label="Seek"
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </div>

      <div className="control-strip__row">
        <div className="control-strip__left">
          <button
            type="button"
            className="control-strip__btn"
            disabled={!canSeek}
            onClick={() => onSkip(-10)}
            aria-label="Back 10 seconds"
          >
            −10
          </button>
          <button
            type="button"
            className="control-strip__btn"
            disabled={!canPlay && !playing}
            onClick={onTogglePlay}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="control-strip__btn"
            disabled={!canSeek}
            onClick={() => onSkip(10)}
            aria-label="Forward 10 seconds"
          >
            +10
          </button>
          <span className="control-strip__time">
            {formatTime(position)} / {formatTime(duration)}
          </span>
        </div>

        <div className="control-strip__right">
          <button type="button" className="control-strip__btn" onClick={onMute} aria-label="Mute">
            {muted || volume === 0 ? "Mute" : "Vol"}
          </button>
          <input
            className="control-strip__vol"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => onVolume(Number(e.target.value))}
          />
          <select
            className="control-strip__select"
            value={rate}
            disabled={!canRate}
            aria-label="Playback rate"
            onChange={(e) => onRate(Number(e.target.value))}
          >
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`control-strip__btn${captionsOn ? " is-on" : ""}`}
            onClick={onOpenSubtitles}
            aria-label="Subtitles"
          >
            CC
          </button>
          <button type="button" className="control-strip__btn" onClick={onPiP} aria-label="Picture in picture">
            PiP
          </button>
          <button type="button" className="control-strip__btn" onClick={onFullscreen} aria-label="Fullscreen">
            Full
          </button>
        </div>
      </div>
    </div>
  );
}

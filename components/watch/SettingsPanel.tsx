"use client";

import type { RoomEndReason, RoomSettings, SyncStrictness } from "@/lib/sync-protocol";
import { EXPIRE_PRESETS_MS } from "@/lib/sync-protocol";

type Props = {
  settings: RoomSettings;
  isHost: boolean;
  onChange: (next: RoomSettings) => void;
  onClearChat: () => void;
  onLeave: () => void;
  onEndSession?: () => void;
  onForceEnd?: () => void;
  onExpirePreset?: (ms: number) => void;
};

export function SettingsPanel({
  settings,
  isHost,
  onChange,
  onClearChat,
  onLeave,
  onEndSession,
  onForceEnd,
  onExpirePreset,
}: Props) {
  function patch(partial: Partial<RoomSettings>) {
    onChange({ ...settings, ...partial });
  }

  const expireValue =
    !settings.expiresAt
      ? "0"
      : String(
          EXPIRE_PRESETS_MS.find((p) => p.ms > 0 && Math.abs((settings.expiresAt ?? 0) - Date.now() - p.ms) < 60_000)
            ?.ms ?? "custom",
        );

  return (
    <div className="rail-panel">
      <h3>Settings</h3>

      {isHost && (
        <label className="watch-field">
          <span>Room title</span>
          <input
            value={settings.roomTitle}
            maxLength={48}
            placeholder="Friday night"
            onChange={(e) => patch({ roomTitle: e.target.value })}
          />
        </label>
      )}

      <label className="sheet__check">
        <input
          type="checkbox"
          checked={settings.courtesyPause}
          disabled={!isHost}
          onChange={(e) => patch({ courtesyPause: e.target.checked })}
        />
        Courtesy pause when partner buffers
      </label>

      <label className="watch-field">
        <span>Sync strictness</span>
        <select
          value={settings.syncStrictness}
          disabled={!isHost}
          onChange={(e) => patch({ syncStrictness: e.target.value as SyncStrictness })}
        >
          <option value="relaxed">Relaxed</option>
          <option value="normal">Normal</option>
          <option value="strict">Strict</option>
        </select>
      </label>

      <label className="sheet__check">
        <input
          type="checkbox"
          checked={settings.autoHideChrome}
          onChange={(e) => patch({ autoHideChrome: e.target.checked })}
        />
        Auto-hide player chrome
      </label>

      <label className="sheet__check">
        <input
          type="checkbox"
          checked={settings.reduceMotion}
          onChange={(e) => patch({ reduceMotion: e.target.checked })}
        />
        Reduce motion
      </label>

      <label className="sheet__check">
        <input
          type="checkbox"
          checked={settings.joinSound}
          disabled={!isHost}
          onChange={(e) => patch({ joinSound: e.target.checked })}
        />
        Soft sound when partner joins
      </label>

      {isHost && onExpirePreset && (
        <label className="watch-field">
          <span>Session expires in</span>
          <select
            value={expireValue === "custom" ? "0" : expireValue}
            onChange={(e) => onExpirePreset(Number(e.target.value))}
          >
            {EXPIRE_PRESETS_MS.map((p) => (
              <option key={p.label} value={p.ms}>
                {p.label}
              </option>
            ))}
          </select>
          {settings.expiresAt ? (
            <span className="rail-panel__muted">
              Ends {new Date(settings.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : null}
        </label>
      )}

      <button type="button" className="btn btn--ghost" onClick={onClearChat}>
        Clear chat
      </button>

      <button type="button" className="btn btn--ghost" onClick={onLeave}>
        Leave room
      </button>

      {isHost && onEndSession && (
        <button type="button" className="btn btn--ghost" onClick={onEndSession}>
          End session
        </button>
      )}

      {isHost && onForceEnd && (
        <button type="button" className="btn btn--primary" onClick={onForceEnd}>
          Force end session
        </button>
      )}

      <p className="rail-panel__muted">
        Leaving as host hands the room to your partner. Ending wipes local film data on each device — nothing is
        stored on Partmov servers.
      </p>
    </div>
  );
}

export type { RoomEndReason };

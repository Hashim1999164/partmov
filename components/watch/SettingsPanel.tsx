"use client";

import type { RoomSettings, SyncStrictness } from "@/lib/sync-protocol";

type Props = {
  settings: RoomSettings;
  isHost: boolean;
  onChange: (next: RoomSettings) => void;
  onClearChat: () => void;
  onLeave: () => void;
  onEndRoom?: () => void;
};

export function SettingsPanel({ settings, isHost, onChange, onClearChat, onLeave, onEndRoom }: Props) {
  function patch(partial: Partial<RoomSettings>) {
    onChange({ ...settings, ...partial });
  }

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

      <button type="button" className="btn btn--ghost" onClick={onClearChat}>
        Clear chat
      </button>

      <button type="button" className="btn btn--ghost" onClick={onLeave}>
        Leave room
      </button>

      {isHost && onEndRoom && (
        <button type="button" className="btn btn--primary" onClick={onEndRoom}>
          End room for everyone
        </button>
      )}
    </div>
  );
}

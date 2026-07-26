"use client";

import type { SubtitleStyle, SubtitleTrackInfo } from "@/lib/sync-protocol";

type Props = {
  open: boolean;
  onClose: () => void;
  tracks: SubtitleTrackInfo[];
  activeId: string | null;
  visible: boolean;
  style: SubtitleStyle;
  canAdd: boolean;
  onSelect: (id: string | null) => void;
  onVisible: (v: boolean) => void;
  onStyle: (s: SubtitleStyle) => void;
  onAddFile: (file: File) => void;
};

export function SubtitleMenu({
  open,
  onClose,
  tracks,
  activeId,
  visible,
  style,
  canAdd,
  onSelect,
  onVisible,
  onStyle,
  onAddFile,
}: Props) {
  if (!open) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet sheet--sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Subtitles">
        <header className="sheet__head">
          <h3>Subtitles</h3>
          <button type="button" className="sheet__x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <label className="sheet__check">
          <input type="checkbox" checked={visible} onChange={(e) => onVisible(e.target.checked)} />
          Show captions
        </label>

        <ul className="sheet__list">
          <li>
            <button
              type="button"
              className={!activeId || !visible ? "is-active" : ""}
              onClick={() => {
                onSelect(null);
                onVisible(false);
              }}
            >
              Off
            </button>
          </li>
          {tracks.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={activeId === t.id && visible ? "is-active" : ""}
                onClick={() => {
                  onSelect(t.id);
                  onVisible(true);
                }}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="sheet__row">
          <span>Size</span>
          {(["s", "m", "l"] as const).map((sz) => (
            <button
              key={sz}
              type="button"
              className={`chip${style.size === sz ? " is-on" : ""}`}
              onClick={() => onStyle({ ...style, size: sz })}
            >
              {sz.toUpperCase()}
            </button>
          ))}
        </div>

        <label className="watch-field">
          <span>Vertical offset ({style.offset}px)</span>
          <input
            type="range"
            min={-40}
            max={80}
            value={style.offset}
            onChange={(e) => onStyle({ ...style, offset: Number(e.target.value) })}
          />
        </label>

        <label className="sheet__check">
          <input
            type="checkbox"
            checked={style.contrast}
            onChange={(e) => onStyle({ ...style, contrast: e.target.checked })}
          />
          High contrast background
        </label>

        {canAdd && (
          <label className="btn btn--ghost sheet__file">
            Add track (.vtt / .srt)
            <input
              type="file"
              accept=".vtt,.srt,text/vtt"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onAddFile(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

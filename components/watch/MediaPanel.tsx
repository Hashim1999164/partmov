"use client";

import { useState } from "react";
import { CATALOG } from "@/lib/catalog";

type Transfer = {
  fileName: string;
  kind: "video" | "subtitle";
  pct: number;
  direction: "send" | "receive";
  phase?: string;
} | null;

type Props = {
  isHost: boolean;
  currentTitle?: string;
  transfer: Transfer;
  changingTitle?: string | null;
  error: string | null;
  onPickCatalog: (id: string) => void;
  onPasteUrl: (url: string, title: string) => boolean;
  onLocalFile: (file: File) => void;
};

export function MediaPanel({
  isHost,
  currentTitle,
  transfer,
  changingTitle,
  error,
  onPickCatalog,
  onPasteUrl,
  onLocalFile,
}: Props) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");

  if (!isHost) {
    return (
      <div className="rail-panel">
        <h3>Media</h3>
        <p className="rail-panel__muted">Now playing: {currentTitle ?? "Waiting for host…"}</p>
        <p className="rail-panel__muted">Only the host can change the film.</p>
        {changingTitle && <p className="rail-panel__muted">Host is changing to “{changingTitle}”…</p>}
        {transfer && (
          <div className="transfer-bar">
            <span>
              Receiving {transfer.fileName}… {transfer.pct}%
            </span>
            <div className="transfer-bar__track">
              <i style={{ width: `${transfer.pct}%` }} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rail-panel">
      <h3>Media</h3>
      <p className="rail-panel__muted">
        Now playing: {currentTitle ?? "—"}. Changing the film notifies your partner, transfers the new file, then wipes
        the previous one on every device.
      </p>

      <label className="btn btn--primary sheet__file">
        {currentTitle ? "Replace with local file" : "Choose local file"}
        <input
          type="file"
          accept="video/mp4,video/webm,video/ogg,.mp4,.webm"
          hidden
          disabled={Boolean(transfer)}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLocalFile(f);
            e.target.value = "";
          }}
        />
      </label>

      {transfer && (
        <div className="transfer-bar">
          <span>
            {transfer.phase === "waiting_peer"
              ? `Waiting for partner to finish receiving ${transfer.fileName}…`
              : `${transfer.direction === "send" ? "Sending" : "Receiving"} ${transfer.fileName}… ${transfer.pct}%`}
          </span>
          <div className="transfer-bar__track">
            <i style={{ width: `${transfer.pct}%` }} />
          </div>
        </div>
      )}

      {changingTitle && !transfer && (
        <p className="rail-panel__muted">Switching to “{changingTitle}”…</p>
      )}

      <details className="media-advanced">
        <summary>Catalog or public URL</summary>
        <div className="media-grid">
          {CATALOG.map((film) => (
            <button
              key={film.id}
              type="button"
              className="media-tile"
              disabled={Boolean(transfer)}
              onClick={() => onPickCatalog(film.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={film.poster}
                alt=""
                onError={(e) => {
                  const t = e.currentTarget;
                  if (film.fallbackPoster) t.src = film.fallbackPoster;
                }}
              />
              <span>{film.title}</span>
            </button>
          ))}
        </div>

        <form
          className="stack stack--sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (onPasteUrl(url, title)) {
              setUrl("");
              setTitle("");
            }
          }}
        >
          <label className="watch-field">
            <span>Public HTTPS URL</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/film.mp4" />
          </label>
          <label className="watch-field">
            <span>Title (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tonight’s pick" />
          </label>
          <button type="submit" className="btn btn--ghost" disabled={Boolean(transfer)}>
            Load URL for both
          </button>
        </form>
      </details>

      {error && <p className="rail-panel__error">{error}</p>}
    </div>
  );
}

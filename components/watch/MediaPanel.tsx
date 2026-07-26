"use client";

import { useState } from "react";
import { CATALOG } from "@/lib/catalog";
import { materializeFile } from "@/lib/read-blob";

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
  onBrowseUrl?: (url: string, title: string) => boolean;
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
  onBrowseUrl,
}: Props) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [browseDraft, setBrowseDraft] = useState("https://www.netflix.com/");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function pickLocal(raw: File) {
    setReadError(null);
    setReading(true);
    try {
      const durable = await materializeFile(raw);
      onLocalFile(durable);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Could not read that video");
    } finally {
      setReading(false);
    }
  }

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

      <div
        className={`upload-drop upload-drop--rail${dragOver ? " is-drag" : ""}${reading || transfer ? " is-busy" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!transfer && !reading) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!transfer && !reading) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !transfer && !reading) void pickLocal(f);
        }}
      >
        <label className="upload-drop__empty upload-drop__empty--rail">
          <strong>{reading ? "Reading file…" : currentTitle ? "Replace film" : "Choose a film"}</strong>
          <span>Drop a video here or browse</span>
          <input
            type="file"
            accept="video/mp4,video/webm,video/ogg,.mp4,.webm"
            hidden
            disabled={Boolean(transfer) || reading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void pickLocal(f);
            }}
          />
        </label>
      </div>

      <details className="media-advanced">
        <summary>Open a website instead</summary>
        <form
          className="stack stack--sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (onBrowseUrl?.(browseDraft.trim(), "Website")) {
              setBrowseDraft("https://www.netflix.com/");
            }
          }}
        >
          <label className="watch-field">
            <span>Website URL</span>
            <input
              value={browseDraft}
              onChange={(e) => setBrowseDraft(e.target.value)}
              placeholder="https://www.netflix.com/"
              spellCheck={false}
            />
          </label>
          <button type="submit" className="btn btn--ghost" disabled={!browseDraft.trim() || Boolean(transfer)}>
            Co-browse this site
          </button>
        </form>
      </details>

      {readError && <p className="rail-panel__error">{readError}</p>}

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

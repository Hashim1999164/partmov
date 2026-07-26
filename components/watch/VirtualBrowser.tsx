"use client";

import { useEffect, useId, useRef, useState } from "react";
import { browseTitleFromUrl, siteLikelyBlocksEmbed } from "@/lib/browse";

type Props = {
  url: string;
  canNavigate: boolean;
  partnerName?: string | null;
  onNavigate: (url: string) => void;
};

export function VirtualBrowser({ url, canNavigate, partnerName, onNavigate }: Props) {
  const inputId = useId();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [draft, setDraft] = useState(url);
  const [frameKey, setFrameKey] = useState(0);
  const [showHint, setShowHint] = useState(siteLikelyBlocksEmbed(url));

  useEffect(() => {
    setDraft(url);
    setShowHint(siteLikelyBlocksEmbed(url));
    setFrameKey((k) => k + 1);
  }, [url]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canNavigate) return;
    const next = draft.trim();
    if (!next) return;
    onNavigate(next);
  }

  const blocks = siteLikelyBlocksEmbed(url);
  const title = browseTitleFromUrl(url);

  return (
    <div className="vbrowser">
      <form className="vbrowser__chrome" onSubmit={submit}>
        <span className="vbrowser__pill" title="Lightweight co-browse (iframe in each browser)">
          Co-browse
        </span>
        <label className="vbrowser__addr" htmlFor={inputId}>
          <span className="sr-only">Address</span>
          <input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!canNavigate}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="https://…"
          />
        </label>
        {canNavigate ? (
          <button type="submit" className="btn btn--ghost btn--sm">
            Go
          </button>
        ) : (
          <span className="vbrowser__guest">Host navigates{partnerName ? ` · ${partnerName}` : ""}</span>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setFrameKey((k) => k + 1)}
          title="Reload frame"
        >
          Reload
        </button>
        <a className="btn btn--ghost btn--sm" href={url} target="_blank" rel="noreferrer">
          Open tab
        </a>
      </form>

      <div className="vbrowser__stage">
        {!blocks && (
          <iframe
            key={frameKey}
            ref={iframeRef}
            className="vbrowser__frame"
            src={url}
            title={`Co-browse · ${title}`}
            referrerPolicy="no-referrer-when-downgrade"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"
            allow="fullscreen; autoplay; encrypted-media; picture-in-picture"
          />
        )}

        {(blocks || showHint) && (
          <div className="vbrowser__fallback">
            <h3>{title} won’t load inside Partmov</h3>
            <p>
              Sites like Netflix send frame-blocking headers, so a real remote browser cannot run on Vercel’s
              serverless platform either. Both of you still share the same URL — open it in a normal tab and watch
              together on your own screens.
            </p>
            <div className="vbrowser__fallback-actions">
              <a className="btn btn--primary" href={url} target="_blank" rel="noreferrer">
                Open {title}
              </a>
              {!blocks && (
                <button type="button" className="btn btn--ghost" onClick={() => setShowHint(false)}>
                  Try iframe anyway
                </button>
              )}
            </div>
            <p className="vbrowser__fallback-note">
              Lightweight co-browse works for sites that allow embedding (Wikipedia, many docs). A full cloud
              Chromium needs a separate always-on host — not available on this Vercel deploy.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

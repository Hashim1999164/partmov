"use client";

import { useEffect, useMemo, useState } from "react";
import type { TransferProgress } from "@/hooks/useRoomMedia";

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEta(sec: number | null) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "…";
  if (sec < 60) return `${Math.max(1, Math.ceil(sec))}s`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  return `${m}m ${s}s`;
}

function phaseLabel(t: TransferProgress) {
  if (!t) return "";
  const cloud = t.via === "r2";
  if (t.phase === "reading") return "Reading";
  if (t.phase === "sending") return cloud ? "Uploading to cloud" : "Uploading to partner";
  if (t.phase === "waiting_peer") return "Waiting for partner";
  if (t.phase === "receiving") return cloud ? "Preparing stream" : "Downloading";
  if (t.phase === "finalizing") return cloud ? "Finalizing cloud upload" : "Finalizing";
  if (t.phase === "streaming") return cloud ? "Streaming from cloud" : "Streaming ahead";
  return t.direction === "send" ? "Uploading" : "Receiving";
}

type Props = {
  transfer: TransferProgress;
};

export function TransferDock({ transfer }: Props) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!transfer) setOpen(false);
  }, [transfer]);

  useEffect(() => {
    if (!transfer) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [transfer]);

  const eta = useMemo(() => {
    if (!transfer?.startedAt || !transfer.bytesTotal || transfer.pct <= 0) return null;
    const elapsed = (now - transfer.startedAt) / 1000;
    if (elapsed < 0.4) return null;
    const rate = (transfer.bytesLoaded || (transfer.pct / 100) * transfer.bytesTotal) / elapsed;
    if (rate <= 0) return null;
    const left = Math.max(0, transfer.bytesTotal - (transfer.bytesLoaded ?? 0));
    return left / rate;
  }, [now, transfer]);

  const speed = useMemo(() => {
    if (!transfer?.startedAt || !transfer.bytesLoaded) return null;
    const elapsed = (now - transfer.startedAt) / 1000;
    if (elapsed < 0.3) return null;
    return transfer.bytesLoaded / elapsed;
  }, [now, transfer]);

  if (!transfer) return null;

  const loaded = transfer.bytesLoaded ?? Math.round(((transfer.pct || 0) / 100) * (transfer.bytesTotal || 0));
  const total = transfer.bytesTotal || 0;
  const remaining = Math.max(0, total - loaded);

  return (
    <div className={`transfer-dock${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="transfer-dock__chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="transfer-dock__pulse" aria-hidden />
        <span className="transfer-dock__chip-text">
          {phaseLabel(transfer)} · {transfer.pct}%
        </span>
        <span className="transfer-dock__chev" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="transfer-dock__panel" role="status">
          <div className="transfer-dock__title">
            <strong>{transfer.fileName}</strong>
            <span>{phaseLabel(transfer)}</span>
          </div>
          <div className="transfer-dock__track">
            <i style={{ width: `${Math.min(100, Math.max(0, transfer.pct))}%` }} />
          </div>
          <dl className="transfer-dock__stats">
            <div>
              <dt>Progress</dt>
              <dd>{transfer.pct}%</dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>{formatBytes(loaded)}</dd>
            </div>
            <div>
              <dt>Remaining</dt>
              <dd>{total ? formatBytes(remaining) : "—"}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{total ? formatBytes(total) : "—"}</dd>
            </div>
            <div>
              <dt>Speed</dt>
              <dd>{speed ? `${formatBytes(speed)}/s` : "…"}</dd>
            </div>
            <div>
              <dt>ETA</dt>
              <dd>{formatEta(eta)}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

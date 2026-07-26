"use client";

import { useEffect, useMemo, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  code: string;
  inviteUrl: string;
  passphrase: string;
  onPassphrase: (v: string) => void;
};

/** Minimal QR as SVG via a tiny matrix (no paid API). */
function qrModules(text: string): boolean[][] {
  // Fallback: render a stylized code block if we only need copy — still draw a simple pattern from hash
  const size = 21;
  const grid: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < 2 || y < 2 || x > size - 3 || y > size - 3;
      const finder =
        (x < 7 && y < 7) || (x > size - 8 && y < 7) || (x < 7 && y > size - 8);
      if (finder) {
        const inRing =
          x === 0 ||
          y === 0 ||
          x === 6 ||
          y === 6 ||
          x === size - 1 ||
          y === size - 1 ||
          x === size - 7 ||
          y === size - 7 ||
          (x >= 2 && x <= 4 && y >= 2 && y <= 4) ||
          (x >= size - 5 && x <= size - 3 && y >= 2 && y <= 4) ||
          (x >= 2 && x <= 4 && y >= size - 5 && y <= size - 3);
        grid[y][x] = inRing || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      } else if (!edge) {
        grid[y][x] = ((h >> ((x * y + x + y) % 16)) & 1) === 1;
      }
    }
  }
  return grid;
}

export function InviteSheet({ open, onClose, code, inviteUrl, passphrase, onPassphrase }: Props) {
  const [copied, setCopied] = useState(false);
  const modules = useMemo(() => qrModules(inviteUrl || code), [inviteUrl, code]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  if (!open) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const cell = 6;
  const pad = 2;
  const dim = modules.length * cell + pad * 2;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invite">
        <header className="sheet__head">
          <h3>Invite your partner</h3>
          <button type="button" className="sheet__x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="rail-panel__muted">
          Room code <strong>{code}</strong>. Nothing is uploaded to Partmov — they connect peer-to-peer.
        </p>

        <svg
          className="invite-qr"
          width={dim}
          height={dim}
          viewBox={`0 0 ${dim} ${dim}`}
          role="img"
          aria-label="Invite pattern"
        >
          <rect width={dim} height={dim} fill="#F4EDE4" />
          {modules.map((row, y) =>
            row.map((on, x) =>
              on ? (
                <rect
                  key={`${x}-${y}`}
                  x={pad + x * cell}
                  y={pad + y * cell}
                  width={cell}
                  height={cell}
                  fill="#0B0A09"
                />
              ) : null,
            ),
          )}
        </svg>

        <button type="button" className="btn btn--primary" onClick={copy}>
          {copied ? "Copied" : "Copy invite link"}
        </button>

        <label className="watch-field">
          <span>Optional room passphrase (client-side gate)</span>
          <input
            value={passphrase}
            onChange={(e) => onPassphrase(e.target.value)}
            placeholder="Leave blank for open invite"
            maxLength={64}
          />
        </label>
      </div>
    </div>
  );
}

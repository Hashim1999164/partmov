"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

type Props = {
  open: boolean;
  onClose: () => void;
  code: string;
  inviteUrl: string;
  passphrase: string;
  onPassphrase: (v: string) => void;
};

export function InviteSheet({ open, onClose, code, inviteUrl, passphrase, onPassphrase }: Props) {
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!open || !inviteUrl) {
      setQrDataUrl(null);
      setQrError(null);
      return;
    }

    let cancelled = false;
    setQrError(null);
    QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
      color: {
        dark: "#1F1F21",
        light: "#FFFFFF",
      },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) {
          setQrDataUrl(null);
          setQrError(err instanceof Error ? err.message : "Could not generate QR code");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, inviteUrl]);

  if (!open) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

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

        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="invite-qr" src={qrDataUrl} width={240} height={240} alt="Scan to join this room" />
        ) : qrError ? (
          <p className="rail-panel__error" role="alert">
            QR unavailable — copy the link below instead.
          </p>
        ) : (
          <div className="invite-qr invite-qr--loading" aria-hidden="true" />
        )}

        <p className="invite-url mono" title={inviteUrl}>
          {inviteUrl}
        </p>

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

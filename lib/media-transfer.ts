import { readBlobBytes, readBlobText } from "@/lib/read-blob";

/** Convert basic SRT cue blocks into WebVTT text. */
export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const body = normalized
    .replace(/^\d+\n/gm, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}\n`;
}

export async function fileToSubtitleVtt(file: File): Promise<{ label: string; vtt: string; url: string }> {
  const text = await readBlobText(file);
  const isSrt = /\.srt$/i.test(file.name) || text.includes("-->") && text.includes(",");
  const vtt = isSrt && !text.trimStart().startsWith("WEBVTT") ? srtToVtt(text) : text.trimStart().startsWith("WEBVTT") ? text : `WEBVTT\n\n${text}`;
  const blob = new Blob([vtt], { type: "text/vtt" });
  const url = URL.createObjectURL(blob);
  const label = file.name.replace(/\.(srt|vtt)$/i, "") || "Subtitles";
  return { label, vtt, url };
}

const CHUNK_CHARS = 48_000; // ~36KB base64 payload per message

export type FileTransferHandlers = {
  onProgress?: (pct: number) => void;
};

/** Split an ArrayBuffer into base64 chunk messages for PeerJS. */
export async function encodeFileChunks(file: File): Promise<{ total: number; chunks: string[] }> {
  const buf = await readBlobBytes(file);
  const bytes = new Uint8Array(buf);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  const b64 = btoa(binary);
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) {
    chunks.push(b64.slice(i, i + CHUNK_CHARS));
  }
  return { total: chunks.length, chunks };
}

export function assembleBase64Chunks(chunks: string[]): Blob {
  const b64 = chunks.join("");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

/** Assemble only the contiguous prefix of chunks (for progressive blob playback). */
export function assemblePrefixBase64Chunks(chunks: Array<string | undefined>): Blob | null {
  const prefix: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c) break;
    prefix.push(c);
  }
  if (prefix.length === 0) return null;
  return assembleBase64Chunks(prefix);
}

export function estimateBytesFromBase64Chunks(chunks: Array<string | undefined>, filled: number): number {
  if (filled <= 0) return 0;
  let sample = 0;
  let n = 0;
  for (const c of chunks) {
    if (!c) continue;
    sample += c.length;
    n += 1;
    if (n >= 8) break;
  }
  if (n === 0) return 0;
  const avg = sample / n;
  // base64 → ~3/4 raw bytes
  return Math.round(filled * avg * 0.75);
}

export function makeTransferId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

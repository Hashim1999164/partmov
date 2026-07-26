export type Role = "host" | "guest";

export type SyncMessage =
  | { type: "hello"; role: Role; name: string }
  | { type: "welcome"; name: string }
  | { type: "partner_left" }
  | {
      type: "playback";
      state: "playing" | "paused";
      position: number;
      at: number;
      seq: number;
    }
  | { type: "seek"; position: number; state: "playing" | "paused"; at: number; seq: number }
  | { type: "heartbeat"; position: number; state: "playing" | "paused"; at: number; seq: number }
  | { type: "chat"; name: string; body: string; at: number }
  | { type: "reaction"; name: string; glyph: string; at: number };

export function channelName(code: string): string {
  return `partmov-room:${code}`;
}

export function peerIdForHost(code: string): string {
  return `partmov-${code}`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

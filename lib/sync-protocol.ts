export type Role = "host" | "guest";

export type ControlMode = "host_only" | "shared" | "handed_to_guest";

export type SyncStrictness = "relaxed" | "normal" | "strict";

export type PartnerState = "waiting" | "connecting" | "connected" | "reconnecting" | "left";

export type MediaKind = "catalog" | "url" | "file";

export type MediaDescriptor = {
  kind: MediaKind;
  id?: string;
  title: string;
  src?: string;
  poster?: string;
  credit?: string;
  license?: string;
};

export type RoomEndReason = "ended" | "force" | "expired";

export type RoomSettings = {
  courtesyPause: boolean;
  syncStrictness: SyncStrictness;
  autoHideChrome: boolean;
  reduceMotion: boolean;
  joinSound: boolean;
  roomTitle: string;
  /** Absolute epoch ms when the session auto-ends; null = no timer */
  expiresAt: number | null;
};

export const DEFAULT_SETTINGS: RoomSettings = {
  courtesyPause: true,
  syncStrictness: "normal",
  autoHideChrome: true,
  reduceMotion: false,
  joinSound: false,
  roomTitle: "",
  expiresAt: null,
};

export const EXPIRE_PRESETS_MS = [
  { label: "Off", ms: 0 },
  { label: "30 minutes", ms: 30 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "2 hours", ms: 2 * 60 * 60 * 1000 },
  { label: "6 hours", ms: 6 * 60 * 60 * 1000 },
] as const;

export type SyncThresholds = {
  lockMs: number;
  fineMs: number;
  coarseMs: number;
  hardSeekMs: number;
};

export function thresholdsFor(strictness: SyncStrictness): SyncThresholds {
  if (strictness === "strict") return { lockMs: 25, fineMs: 120, coarseMs: 500, hardSeekMs: 600 };
  if (strictness === "relaxed") return { lockMs: 80, fineMs: 350, coarseMs: 1200, hardSeekMs: 1800 };
  return { lockMs: 40, fineMs: 200, coarseMs: 800, hardSeekMs: 1000 };
}

export type SubtitleStyle = {
  size: "s" | "m" | "l";
  offset: number;
  contrast: boolean;
};

export type SubtitleTrackInfo = {
  id: string;
  label: string;
  language: string;
  /** Object URL or data URL for WebVTT */
  url: string;
};

export type SyncMessage =
  | { type: "hello"; role: Role; name: string; color: string }
  | { type: "welcome"; name: string; color: string; settings: RoomSettings; media: MediaDescriptor | null; controlMode: ControlMode; remoteHolder: Role }
  | { type: "partner_left" }
  | { type: "ready_state"; ready: boolean; bufferedAheadMs: number }
  | {
      type: "playback";
      state: "playing" | "paused";
      position: number;
      at: number;
      seq: number;
      startAt?: number;
    }
  | { type: "seek"; position: number; state: "playing" | "paused"; at: number; seq: number }
  | { type: "rate"; rate: number; seq: number }
  | {
      type: "heartbeat";
      position: number;
      state: "playing" | "paused";
      at: number;
      seq: number;
      bufferedAheadMs?: number;
    }
  | { type: "sync_ping"; t0: number }
  | { type: "sync_pong"; t0: number; t1: number; t2: number }
  | { type: "media_set"; media: MediaDescriptor; seq: number }
  | { type: "file_offer"; transferId: string; fileName: string; mime: string; size: number; kind: "video" | "subtitle"; label?: string }
  | { type: "file_chunk"; transferId: string; index: number; total: number; data: string }
  | { type: "file_done"; transferId: string; sha?: string }
  | { type: "subtitle_set"; trackId: string | null; seq: number }
  | { type: "track_changed"; subtitleTrackId: string | null; seq: number }
  | { type: "control_mode"; mode: ControlMode; remoteHolder: Role; seq: number }
  | { type: "control_request"; name: string }
  | { type: "chat"; name: string; body: string; at: number; color?: string }
  | { type: "reaction"; name: string; glyph: string; at: number }
  | { type: "typing"; name: string; on: boolean }
  | { type: "settings_changed"; settings: RoomSettings; seq: number }
  | { type: "host_transfer"; newHostName: string; reason: "left" | "handoff"; seq: number }
  | { type: "session_expire_at"; expiresAt: number | null; seq: number }
  | { type: "room_ended"; reason: RoomEndReason; message: string }
  | { type: "command_rejected"; reason: string; message: string; seq: number };

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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export const COLOR_CHIPS = ["#C4A484", "#86AB9D", "#D9A95C", "#A78BFA", "#F07178", "#7EB8DA"] as const;

export function canControlPlayback(role: Role, mode: ControlMode, remoteHolder: Role, action: "play" | "pause" | "seek" | "rate" | "media" | "subtitle_track"): boolean {
  if (action === "pause") return true;
  if (action === "media") return role === "host";
  if (mode === "shared") return true;
  if (mode === "handed_to_guest") return remoteHolder === role || (action === "play" && role === remoteHolder);
  // host_only
  if (role === "host") return true;
  if (action === "play") return false;
  if (action === "seek" || action === "rate" || action === "subtitle_track") return false;
  return false;
}

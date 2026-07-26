/** Shared Partmov Streaming V2 protocol — API + sync + media descriptors. */

export type Role = "host" | "guest";
export type ControlMode = "host_only" | "shared" | "handed_to_guest";
export type SyncStrictness = "relaxed" | "normal" | "strict";
export type RoomEndReason = "ended" | "force" | "expired";
export type AssetStatus =
  | "uploading"
  | "probing"
  | "queued"
  | "transcoding"
  | "ready"
  | "failed"
  | "purged";
export type JobStatus = "pending" | "leased" | "running" | "succeeded" | "failed" | "dead";
export type JobKind = "probe" | "transcode" | "poster" | "sprites" | "subtitles" | "purge";

/** Progressive demo kinds + production HLS. */
export type MediaKind = "catalog" | "url" | "file" | "hls";

export type MediaDescriptor = {
  kind: MediaKind;
  id?: string;
  title: string;
  src?: string;
  poster?: string;
  credit?: string;
  license?: string;
  /** Streaming V2 */
  assetId?: string;
  masterPlaylistUrl?: string;
  playbackSessionId?: string;
  durationMs?: number;
  availableLevels?: Array<{ height: number; bandwidth: number; label: string }>;
};

export type RoomSettings = {
  courtesyPause: boolean;
  syncStrictness: SyncStrictness;
  autoHideChrome: boolean;
  reduceMotion: boolean;
  joinSound: boolean;
  roomTitle: string;
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

/** ABR ladder targets (source-aware; never upscale). */
export const ABR_LADDER = [
  { height: 360, videoBitrateKbps: 700, audioBitrateKbps: 96, label: "360p" },
  { height: 540, videoBitrateKbps: 1400, audioBitrateKbps: 128, label: "540p" },
  { height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 128, label: "720p" },
  { height: 1080, videoBitrateKbps: 5500, audioBitrateKbps: 160, label: "1080p" },
] as const;

export const SEGMENT_DURATION_SEC = 2;

/** Authoritative sync messages (server-sequenced in Streaming V2). */
export type SyncClientMessage =
  | { type: "join"; roomId: string; displayName: string; color: string; inviteToken?: string; role?: Role }
  | { type: "reconnect"; roomId: string; participantId: string; displayName: string; color: string; inviteToken?: string }
  | { type: "ready_state"; ready: boolean; bufferedAheadMs: number; level?: number }
  | { type: "playback_cmd"; action: "play" | "pause"; position: number; commandId: string }
  | { type: "seek_cmd"; position: number; commandId: string }
  | { type: "rate_cmd"; rate: number; commandId: string }
  | { type: "control_mode_cmd"; mode: ControlMode; remoteHolder: Role; commandId: string }
  | { type: "track_cmd"; subtitleTrackId: string | null; audioTrackId?: string | null; commandId: string }
  | { type: "media_cmd"; media: MediaDescriptor; commandId: string }
  | { type: "heartbeat"; position: number; state: "playing" | "paused"; bufferedAheadMs: number; level?: number; droppedFrames?: number; rebuffering?: boolean; clockOffsetMs?: number }
  | { type: "sync_ping"; t0: number }
  | { type: "chat"; body: string }
  | { type: "reaction"; glyph: string }
  | { type: "typing"; on: boolean }
  | { type: "settings_cmd"; settings: Partial<RoomSettings>; commandId: string }
  | { type: "leave" }
  | { type: "host_transfer_cmd"; commandId: string }
  | { type: "end_room_cmd"; reason: RoomEndReason; commandId: string };

export type SyncServerMessage =
  | { type: "welcome"; roomId: string; participantId: string; role: Role; settings: RoomSettings; media: MediaDescriptor | null; controlMode: ControlMode; remoteHolder: Role; seq: number; anchor: PlaybackAnchor | null; serverNowMs: number; participants: ParticipantSnapshot[] }
  | { type: "partner_joined"; participant: ParticipantSnapshot }
  | { type: "partner_left"; participantId: string }
  | { type: "playback"; state: "playing" | "paused"; position: number; at: number; seq: number; startAt?: number; commandId: string; rate?: number }
  | { type: "seek"; position: number; state: "playing" | "paused"; at: number; seq: number; commandId: string; rate?: number }
  | { type: "rate"; rate: number; position: number; at: number; state: "playing" | "paused"; seq: number; commandId: string }
  | { type: "control_mode"; mode: ControlMode; remoteHolder: Role; seq: number; commandId: string }
  | { type: "media_set"; media: MediaDescriptor; seq: number; commandId: string }
  | { type: "track_changed"; subtitleTrackId: string | null; audioTrackId?: string | null; seq: number; commandId: string }
  | { type: "settings_changed"; settings: RoomSettings; seq: number; commandId: string }
  | { type: "ready_state"; participantId: string; ready: boolean; bufferedAheadMs: number }
  | { type: "sync_pong"; t0: number; t1: number; t2: number; anchor?: PlaybackAnchor; serverNowMs?: number }
  | { type: "heartbeat_ack"; seq: number; anchor: PlaybackAnchor; serverNowMs: number; driftMs: number; advised: "ok" | "nudge" | "seek" }
  | { type: "chat"; participantId: string; name: string; body: string; at: number; color?: string }
  | { type: "reaction"; participantId: string; name: string; glyph: string; at: number }
  | { type: "typing"; participantId: string; name: string; on: boolean }
  | { type: "host_transfer"; newHostParticipantId: string; reason: "left" | "handoff"; seq: number }
  | { type: "session_expire_at"; expiresAt: number | null; seq: number }
  | { type: "room_ended"; reason: RoomEndReason; message: string }
  | { type: "command_rejected"; reason: string; message: string; seq: number; commandId?: string }
  | { type: "reconnect_snapshot"; participantId: string; role: Role; seq: number; anchor: PlaybackAnchor; serverNowMs: number; media: MediaDescriptor | null; settings: RoomSettings; controlMode: ControlMode; remoteHolder: Role; participants: ParticipantSnapshot[] }
  | { type: "playback_token"; playbackSessionId: string; cookieHint?: string; expiresAt: number };

export type PlaybackAnchor = {
  /** Wall-clock epoch ms of last authoritative position sample */
  wallClockMs: number;
  positionSec: number;
  state: "playing" | "paused";
  rate: number;
};

/**
 * Room session clock: derive the position everyone should be watching right now.
 * While playing, advance from the last anchor by wall-clock elapsed × rate.
 */
export function authoritativePosition(anchor: PlaybackAnchor, nowMs: number): number {
  const rate = Number.isFinite(anchor.rate) && anchor.rate > 0 ? anchor.rate : 1;
  if (anchor.state !== "playing") return Math.max(0, anchor.positionSec);
  const elapsedSec = Math.max(0, (nowMs - anchor.wallClockMs) / 1000) * rate;
  return Math.max(0, anchor.positionSec + elapsedSec);
}

/** Re-sample the room clock so reconnects / heartbeats carry the live minute. */
export function liveAnchor(anchor: PlaybackAnchor, nowMs = Date.now()): PlaybackAnchor {
  return {
    wallClockMs: nowMs,
    positionSec: authoritativePosition(anchor, nowMs),
    state: anchor.state,
    rate: Number.isFinite(anchor.rate) && anchor.rate > 0 ? anchor.rate : 1,
  };
}

export type ParticipantSnapshot = {
  id: string;
  displayName: string;
  color: string;
  role: Role;
  ready: boolean;
  connected: boolean;
};

export type ApiErrorBody = {
  error: string;
  message: string;
  requestId: string;
  details?: unknown;
};

export type CreateRoomRequest = {
  assetId: string;
  title?: string;
  expiresInSec?: number;
  passphrase?: string;
};

export type CreateRoomResponse = {
  roomId: string;
  inviteToken: string;
  inviteUrl: string;
  expiresAt: string;
};

export type PlaybackUrlResponse = {
  playbackSessionId: string;
  masterPlaylistUrl: string;
  expiresAt: string;
  levels: Array<{ height: number; bandwidth: number; label: string }>;
};

export type AssetDto = {
  id: string;
  title: string;
  status: AssetStatus;
  durationMs: number | null;
  posterUrl: string | null;
  masterPlaylistUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export function peerIdForHost(code: string): string {
  return `partmov-${code}`;
}

export function channelName(code: string): string {
  return `partmov-room:${code}`;
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

export function canControlPlayback(
  role: Role,
  mode: ControlMode,
  remoteHolder: Role,
  action: "play" | "pause" | "seek" | "rate" | "media" | "subtitle_track",
): boolean {
  if (action === "pause") return true;
  if (action === "media") return role === "host";
  if (mode === "shared") return true;
  if (mode === "handed_to_guest") return remoteHolder === role || (action === "play" && role === remoteHolder);
  if (role === "host") return true;
  if (action === "play" || action === "seek" || action === "rate" || action === "subtitle_track") return false;
  return false;
}

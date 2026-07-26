/** Client-side Streaming V2 feature gates and endpoints. */

export const streamingV2Enabled =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_STREAMING_V2 === "true";

export const apiBase =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_BASE) || "http://127.0.0.1:8080";

export const syncWsUrl =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SYNC_WS) || "ws://127.0.0.1:8090/ws";

export async function fetchPlaybackUrl(
  roomId: string,
  opts?: { inviteToken?: string; participantId?: string },
): Promise<{
  playbackSessionId: string;
  token: string;
  masterPlaylistUrl: string;
  expiresAt: string;
  levels: Array<{ height: number; bandwidth: number; label: string }>;
}> {
  const res = await fetch(`${apiBase}/api/rooms/${roomId}/playback-url`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) throw new Error(`playback-url failed: ${res.status}`);
  return res.json();
}

export async function refreshPlaybackUrl(
  roomId: string,
  opts?: { inviteToken?: string; participantId?: string },
): Promise<{ token: string; expiresAt: string; playbackSessionId: string; masterPlaylistUrl: string }> {
  const res = await fetch(`${apiBase}/api/rooms/${roomId}/playback-refresh`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) throw new Error(`playback-refresh failed: ${res.status}`);
  return res.json();
}

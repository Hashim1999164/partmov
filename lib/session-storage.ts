/** Per-room sessionStorage keys and durable "ended" markers for the PeerJS demo path. */

export function roomKey(kind: "role" | "name" | "color" | "media" | "ended", code: string) {
  return `partmov:${kind}:${code}`;
}

export function markRoomEnded(code: string, message: string) {
  try {
    sessionStorage.setItem(roomKey("ended", code), JSON.stringify({ at: Date.now(), message }));
    sessionStorage.removeItem(roomKey("role", code));
    sessionStorage.removeItem(roomKey("name", code));
    sessionStorage.removeItem(roomKey("color", code));
    sessionStorage.removeItem(roomKey("media", code));
  } catch {
    /* ignore */
  }
}

export function readRoomEnded(code: string): { at: number; message: string } | null {
  try {
    const raw = sessionStorage.getItem(roomKey("ended", code));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; message?: string };
    if (!parsed?.message) return null;
    return { at: parsed.at ?? Date.now(), message: parsed.message };
  } catch {
    return null;
  }
}

export function clearRoomEnded(code: string) {
  try {
    sessionStorage.removeItem(roomKey("ended", code));
  } catch {
    /* ignore */
  }
}

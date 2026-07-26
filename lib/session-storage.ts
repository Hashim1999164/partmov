/** Per-room sessionStorage keys and durable "ended" markers for the PeerJS demo path. */

const ENDED_TTL_MS = 1000 * 60 * 60; // 1 hour — after that, the same code can be reused

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
    const at = parsed.at ?? Date.now();
    if (Date.now() - at > ENDED_TTL_MS) {
      sessionStorage.removeItem(roomKey("ended", code));
      return null;
    }
    return { at, message: parsed.message };
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

/** Clear every ended-room marker in this tab (used when returning to the lobby). */
export function clearAllRoomEnded() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith("partmov:ended:")) keys.push(k);
    }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

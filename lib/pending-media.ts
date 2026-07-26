/**
 * Stash a host-selected video (and optional subtitle) between lobby → room.
 * Uses an in-memory handoff for same-tab navigation, plus IndexedDB for refresh resilience.
 */

import { materializeFile, readBlobBytes } from "@/lib/read-blob";

const DB_NAME = "partmov-pending-media";
const STORE = "files";
const MEM = new Map<string, PendingMedia>();

export type PendingMedia = {
  video: File;
  subtitle?: File;
  title: string;
};

export { materializeFile, readBlobBytes };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

export async function stashPendingMedia(code: string, pending: PendingMedia): Promise<void> {
  MEM.set(code, pending);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        {
          videoName: pending.video.name,
          videoType: pending.video.type,
          videoBuf: pending.video,
          subName: pending.subtitle?.name,
          subType: pending.subtitle?.type,
          subBuf: pending.subtitle ?? null,
          title: pending.title,
        },
        code,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
    db.close();
  } catch {
    /* memory handoff still works for SPA navigation */
  }
}

/** Read pending media without consuming it (safe under React Strict Mode remounts). */
export async function getPendingMedia(code: string): Promise<PendingMedia | null> {
  const mem = MEM.get(code);
  if (mem) return mem;

  try {
    const db = await openDb();
    const row = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(code);
      req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
    db.close();
    if (!row?.videoBuf) return null;
    const videoBlob = row.videoBuf as Blob;
    const video = new File([videoBlob], String(row.videoName || "film.mp4"), {
      type: String(row.videoType || "video/mp4"),
    });
    let subtitle: File | undefined;
    if (row.subBuf) {
      subtitle = new File([row.subBuf as Blob], String(row.subName || "subs.vtt"), {
        type: String(row.subType || "text/vtt"),
      });
    }
    const pending = { video, subtitle, title: String(row.title || video.name) };
    // Warm memory so a concurrent remount does not re-decode while IDB clear races.
    MEM.set(code, pending);
    return pending;
  } catch {
    return null;
  }
}

/** @deprecated Prefer getPendingMedia + clearPendingMedia after successful apply. */
export async function takePendingMedia(code: string): Promise<PendingMedia | null> {
  const pending = await getPendingMedia(code);
  if (pending) await clearPendingMedia(code);
  return pending;
}

export async function clearPendingMedia(code: string): Promise<void> {
  MEM.delete(code);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(code);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** Read file with progress (0–100); falls back if FileReader hits NotReadableError. */
export async function readFileWithProgress(
  file: File,
  onProgress: (pct: number) => void,
): Promise<ArrayBuffer> {
  return readBlobBytes(file, onProgress);
}

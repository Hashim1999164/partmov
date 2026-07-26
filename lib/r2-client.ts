/** Browser upload to Cloudflare R2 via Partmov API (same-origin proxy — no bucket CORS required). */

import { R2_MULTIPART_PART_SIZE, R2_PROXY_PUT_MAX } from "@/lib/r2-constants";

export type R2UploadProgress = {
  pct: number;
  bytesLoaded: number;
  bytesTotal: number;
  phase: "starting" | "uploading" | "finalizing";
};

export type R2UploadResult = {
  assetId: string;
  objectKey: string;
  size: number;
  contentType: string;
};

/** @deprecated use R2_MULTIPART_PART_SIZE */
export const R2_PART_SIZE = R2_MULTIPART_PART_SIZE;

const PARALLEL_PARTS = 2;

async function apiJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Upload API failed (${res.status})`);
  return data;
}

export async function r2Status(): Promise<{ enabled: boolean; cors?: boolean }> {
  try {
    const res = await fetch("/api/r2/status", { cache: "no-store" });
    if (!res.ok) return { enabled: false };
    return (await res.json()) as { enabled: boolean; cors?: boolean };
  } catch {
    return { enabled: false };
  }
}

function friendlyFetchError(err: unknown, fallback: string) {
  const msg = err instanceof Error ? err.message : String(err || "");
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "Upload could not reach the cloud (network). Check your connection and try again.";
  }
  return msg || fallback;
}

export async function uploadFileToR2(
  file: File,
  code: string,
  onProgress?: (p: R2UploadProgress) => void,
): Promise<R2UploadResult> {
  onProgress?.({ pct: 0, bytesLoaded: 0, bytesTotal: file.size, phase: "starting" });

  const init = await apiJson<{
    mode: "put" | "multipart";
    assetId: string;
    objectKey: string;
    uploadId?: string;
    partSize?: number;
    contentType?: string;
  }>("/api/r2/upload/init", {
    code,
    fileName: file.name,
    mime: file.type || "video/mp4",
    size: file.size,
  });

  if (init.mode === "put") {
    onProgress?.({ pct: 5, bytesLoaded: 0, bytesTotal: file.size, phase: "uploading" });
    try {
      const qs = new URLSearchParams({
        objectKey: init.objectKey,
        contentType: init.contentType || file.type || "video/mp4",
      });
      const res = await fetch(`/api/r2/upload/put?${qs}`, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/octet-stream" },
      });
      const data = (await res.json().catch(() => ({}))) as {
        size?: number;
        contentType?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      onProgress?.({
        pct: 100,
        bytesLoaded: file.size,
        bytesTotal: file.size,
        phase: "finalizing",
      });
      return {
        assetId: init.assetId,
        objectKey: init.objectKey,
        size: data.size || file.size,
        contentType: data.contentType || file.type || "video/mp4",
      };
    } catch (err) {
      throw new Error(friendlyFetchError(err, "Cloud upload failed"));
    }
  }

  if (!init.uploadId) throw new Error("Missing multipart upload id");

  // ≥5 MiB parts via two (or more) same-origin staging chunks — no browser→R2 CORS.
  const partSize = Math.max(5 * 1024 * 1024, init.partSize || R2_MULTIPART_PART_SIZE);
  const chunkSize = R2_PROXY_PUT_MAX;
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const completed = new Map<number, string>();
  let uploaded = 0;

  const report = () => {
    const pct = Math.min(99, Math.round((uploaded / Math.max(1, file.size)) * 100));
    onProgress?.({
      pct,
      bytesLoaded: uploaded,
      bytesTotal: file.size,
      phase: "uploading",
    });
  };

  async function uploadPart(partNumber: number) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(file.size, start + partSize);
    const partBytes = end - start;
    const chunkCount = Math.max(1, Math.ceil(partBytes / chunkSize));

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const cStart = start + chunkIndex * chunkSize;
      const cEnd = Math.min(end, cStart + chunkSize);
      const blob = file.slice(cStart, cEnd);
      const qs = new URLSearchParams({
        objectKey: init.objectKey,
        uploadId: init.uploadId!,
        partNumber: String(partNumber),
        chunkIndex: String(chunkIndex),
      });
      const res = await fetch(`/api/r2/upload/stage?${qs}`, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": "application/octet-stream" },
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Staging chunk ${chunkIndex} failed (${res.status})`);
      }
      uploaded += blob.size;
      report();
    }

    const committed = await apiJson<{ etag: string }>("/api/r2/upload/commit-part", {
      objectKey: init.objectKey,
      uploadId: init.uploadId,
      partNumber,
      chunkCount,
    });
    completed.set(partNumber, committed.etag);
  }

  try {
    const allParts = Array.from({ length: totalParts }, (_, i) => i + 1);
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < PARALLEL_PARTS; w++) {
      workers.push(
        (async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= allParts.length) return;
            await uploadPart(allParts[idx]!);
          }
        })(),
      );
    }
    await Promise.all(workers);

    onProgress?.({
      pct: 99,
      bytesLoaded: file.size,
      bytesTotal: file.size,
      phase: "finalizing",
    });

    const parts = [...completed.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([PartNumber, ETag]) => ({ PartNumber, ETag }));

    const done = await apiJson<{ size: number; contentType: string }>("/api/r2/upload/complete", {
      objectKey: init.objectKey,
      uploadId: init.uploadId,
      parts,
    });

    onProgress?.({
      pct: 100,
      bytesLoaded: file.size,
      bytesTotal: file.size,
      phase: "finalizing",
    });

    return {
      assetId: init.assetId,
      objectKey: init.objectKey,
      size: done.size || file.size,
      contentType: done.contentType || file.type || "video/mp4",
    };
  } catch (err) {
    try {
      await apiJson("/api/r2/upload/abort", {
        objectKey: init.objectKey,
        uploadId: init.uploadId,
      });
    } catch {
      /* ignore */
    }
    throw new Error(friendlyFetchError(err, "Cloud upload failed"));
  }
}

export async function fetchR2PlaybackUrl(code: string, objectKey: string) {
  return apiJson<{ url: string; expiresAt: number }>("/api/r2/playback", { code, objectKey });
}

export async function purgeRoomR2(code: string) {
  try {
    await apiJson("/api/r2/purge", { code });
  } catch {
    /* best-effort */
  }
}

export async function openRoom(code: string, hostName?: string) {
  await apiJson<{ ok: boolean }>("/api/rooms/open", { code, hostName });
}

export async function checkRoomExists(code: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { exists?: boolean };
    return Boolean(data.exists);
  } catch {
    return false;
  }
}

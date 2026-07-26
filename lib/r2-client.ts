/** Browser multipart upload to Cloudflare R2 via Partmov API (no bucket CORS required). */

export const R2_PART_SIZE = 3.5 * 1024 * 1024; // stay under Vercel hobby body limits
const PARALLEL = 2;

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

export async function r2Status(): Promise<{ enabled: boolean }> {
  try {
    const res = await fetch("/api/r2/status", { cache: "no-store" });
    if (!res.ok) return { enabled: false };
    return (await res.json()) as { enabled: boolean };
  } catch {
    return { enabled: false };
  }
}

export async function uploadFileToR2(
  file: File,
  code: string,
  onProgress?: (p: R2UploadProgress) => void,
): Promise<R2UploadResult> {
  onProgress?.({ pct: 0, bytesLoaded: 0, bytesTotal: file.size, phase: "starting" });

  const init = await apiJson<{
    assetId: string;
    objectKey: string;
    uploadId: string;
    partSize: number;
  }>("/api/r2/upload/init", {
    code,
    fileName: file.name,
    mime: file.type || "video/mp4",
    size: file.size,
  });

  const partSize = Math.min(init.partSize || R2_PART_SIZE, R2_PART_SIZE);
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  const completed = new Map<number, string>();
  let uploaded = 0;
  let cursor = 1;

  const report = () => {
    const pct = Math.min(99, Math.round((uploaded / file.size) * 100));
    onProgress?.({
      pct,
      bytesLoaded: uploaded,
      bytesTotal: file.size,
      phase: "uploading",
    });
  };

  async function uploadOne(partNumber: number) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(file.size, start + partSize);
    const blob = file.slice(start, end);
    const qs = new URLSearchParams({
      objectKey: init.objectKey,
      uploadId: init.uploadId,
      partNumber: String(partNumber),
    });
    const res = await fetch(`/api/r2/upload/part?${qs}`, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": "application/octet-stream" },
    });
    const data = (await res.json().catch(() => ({}))) as { etag?: string; error?: string };
    if (!res.ok || !data.etag) {
      throw new Error(data.error || `Part ${partNumber} upload failed (${res.status})`);
    }
    completed.set(partNumber, data.etag);
    uploaded += blob.size;
    report();
  }

  try {
    const workers: Promise<void>[] = [];
    for (let i = 0; i < PARALLEL; i++) {
      workers.push(
        (async () => {
          while (true) {
            const n = cursor++;
            if (n > totalParts) return;
            await uploadOne(n);
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
    throw err;
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

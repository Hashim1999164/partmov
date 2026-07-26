/** Browser upload to Cloudflare R2 via Partmov API (+ direct signed parts for large films). */

import { R2_MULTIPART_PART_SIZE } from "@/lib/r2-constants";

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

/** @deprecated use R2_MULTIPART_PART_SIZE — kept for older imports */
export const R2_PART_SIZE = R2_MULTIPART_PART_SIZE;

const PARALLEL = 3;

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

function normalizeEtag(raw: string | null): string {
  if (!raw) return "";
  return raw.replaceAll('"', "").trim();
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
  }

  if (!init.uploadId) throw new Error("Missing multipart upload id");

  // Never go below R2’s 5 MiB non-final part minimum.
  const partSize = Math.max(5 * 1024 * 1024, init.partSize || R2_MULTIPART_PART_SIZE);
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

  async function signBatch(partNumbers: number[]) {
    const { urls } = await apiJson<{
      urls: Array<{ partNumber: number; url: string }>;
    }>("/api/r2/upload/sign-parts", {
      objectKey: init.objectKey,
      uploadId: init.uploadId,
      partNumbers,
    });
    return new Map(urls.map((u) => [u.partNumber, u.url]));
  }

  async function uploadOne(partNumber: number, url: string) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(file.size, start + partSize);
    const blob = file.slice(start, end);
    const res = await fetch(url, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Part ${partNumber} upload failed (${res.status})`);
    }
    const etag = normalizeEtag(res.headers.get("etag") || res.headers.get("ETag"));
    if (!etag) throw new Error(`Part ${partNumber} missing ETag`);
    completed.set(partNumber, etag);
    uploaded += blob.size;
    report();
  }

  try {
    const allParts = Array.from({ length: totalParts }, (_, i) => i + 1);
    for (let i = 0; i < allParts.length; i += 20) {
      const batch = allParts.slice(i, i + 20);
      const urlMap = await signBatch(batch);
      let bi = 0;
      const workers: Promise<void>[] = [];
      for (let w = 0; w < PARALLEL; w++) {
        workers.push(
          (async () => {
            while (true) {
              const idx = bi++;
              if (idx >= batch.length) return;
              const n = batch[idx]!;
              const url = urlMap.get(n);
              if (!url) throw new Error(`Missing signed URL for part ${n}`);
              await uploadOne(n, url);
            }
          })(),
        );
      }
      await Promise.all(workers);
    }

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

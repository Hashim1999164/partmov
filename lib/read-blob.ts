/**
 * Robust Blob/File reads. Some OS sources (iCloud, Photos, network drives,
 * Android content URIs) throw NotReadableError on FileReader even though
 * arrayBuffer() / a cloned Blob still works — and vice versa.
 */

function errMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.message) {
    return err.message;
  }
  return String(err ?? "Could not read file");
}

function isNotReadable(err: unknown): boolean {
  const msg = errMessage(err).toLowerCase();
  return (
    msg.includes("could not be read") ||
    msg.includes("notreadable") ||
    msg.includes("permission") ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      (err.name === "NotReadableError" || err.name === "NotAllowedError"))
  );
}

async function readViaFileReader(
  blob: Blob,
  onProgress?: (pct: number) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) {
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    };
    reader.onload = () => {
      onProgress?.(100);
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.onabort = () => reject(new Error("File read was aborted"));
    reader.readAsArrayBuffer(blob);
  });
}

async function readViaStream(blob: Blob, onProgress?: (pct: number) => void): Promise<ArrayBuffer> {
  if (typeof blob.stream !== "function") {
    throw new Error("Blob.stream is unavailable");
  }
  const reader = blob.stream().getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const total = blob.size || 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      if (onProgress && total > 0) {
        onProgress(Math.min(99, Math.round((loaded / total) * 100)));
      }
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  onProgress?.(100);
  return out.buffer;
}

/**
 * Read blob/file bytes with fallbacks when the primary path fails
 * (NotReadableError / stale file handle after picker).
 */
export async function readBlobBytes(
  blob: Blob,
  onProgress?: (pct: number) => void,
): Promise<ArrayBuffer> {
  const attempts: Array<() => Promise<ArrayBuffer>> = [
    () => readViaFileReader(blob, onProgress),
    async () => {
      onProgress?.(5);
      const buf = await blob.arrayBuffer();
      onProgress?.(100);
      return buf;
    },
    async () => {
      // Clone often succeeds when the original File handle is stale.
      onProgress?.(5);
      const clone = new Blob([blob], { type: blob.type || "application/octet-stream" });
      const buf = await clone.arrayBuffer();
      onProgress?.(100);
      return buf;
    },
    async () => {
      onProgress?.(5);
      const buf = await new Response(blob).arrayBuffer();
      onProgress?.(100);
      return buf;
    },
    () => readViaStream(blob, onProgress),
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      const buf = await attempt();
      if (buf.byteLength === 0 && blob.size > 0) {
        throw new Error("Read returned empty data");
      }
      return buf;
    } catch (err) {
      lastErr = err;
      // Keep trying all strategies for NotReadable-style failures;
      // also continue for other transient read errors.
      continue;
    }
  }

  const detail = errMessage(lastErr);
  throw new Error(
    isNotReadable(lastErr)
      ? `Could not read this file (${detail}). Try copying it to Downloads or Desktop and pick it again.`
      : detail || "Could not read file",
  );
}

/**
 * Copy a picker File into a durable in-memory File so later reads
 * (IndexedDB, PeerJS chunking) do not depend on the original OS path.
 */
export async function materializeFile(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<File> {
  const buf = await readBlobBytes(file, onProgress);
  return new File([buf], file.name || "file", {
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified || Date.now(),
  });
}

export async function readBlobText(blob: Blob): Promise<string> {
  try {
    return await blob.text();
  } catch {
    const buf = await readBlobBytes(blob);
    return new TextDecoder().decode(buf);
  }
}

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import { s3 } from "./minio.js";

/** Cloudflare R2 free-tier storage cap (10 GiB). */
export const DEFAULT_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Block new sessions when remaining capacity falls below this cushion —
 * i.e. storage is "about to" hit the free-tier limit.
 */
export const DEFAULT_STORAGE_GUARD_BYTES = 256 * 1024 * 1024;

/** Rough multiplier so originals + HLS renditions stay under the cap. */
export const UPLOAD_STORAGE_MULTIPLIER = 2;

export type StorageUsage = {
  usedBytes: number;
  limitBytes: number;
  guardBytes: number;
  remainingBytes: number;
  buckets: Record<string, number>;
};

export type StorageGuardResult = {
  allowed: boolean;
  reason?: "at_limit" | "would_exceed";
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  additionalBytes: number;
};

export function evaluateStorageGuard(input: {
  usedBytes: number;
  additionalBytes?: number;
  limitBytes?: number;
  guardBytes?: number;
}): StorageGuardResult {
  const usedBytes = Math.max(0, input.usedBytes);
  const additionalBytes = Math.max(0, input.additionalBytes ?? 0);
  const limitBytes = input.limitBytes ?? DEFAULT_STORAGE_LIMIT_BYTES;
  const guardBytes = input.guardBytes ?? DEFAULT_STORAGE_GUARD_BYTES;
  const projected = usedBytes + additionalBytes;
  const remainingBytes = Math.max(0, limitBytes - usedBytes);

  if (projected > limitBytes) {
    return {
      allowed: false,
      reason: "would_exceed",
      usedBytes,
      limitBytes,
      remainingBytes,
      additionalBytes,
    };
  }

  // New sessions with no (or tiny) payload: refuse once we're inside the guard cushion.
  if (additionalBytes === 0 && remainingBytes <= guardBytes) {
    return {
      allowed: false,
      reason: "at_limit",
      usedBytes,
      limitBytes,
      remainingBytes,
      additionalBytes,
    };
  }

  return {
    allowed: true,
    usedBytes,
    limitBytes,
    remainingBytes,
    additionalBytes,
  };
}

export function estimatedUploadFootprint(sizeBytes: number): number {
  return Math.max(0, Math.ceil(sizeBytes * UPLOAD_STORAGE_MULTIPLIER));
}

async function sumBucketBytes(bucket: string): Promise<number> {
  let total = 0;
  let token: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const obj of listed.Contents ?? []) {
      total += obj.Size ?? 0;
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return total;
}

let cached: { at: number; usage: StorageUsage } | null = null;
const CACHE_TTL_MS = 30_000;

export function invalidateStorageUsageCache() {
  cached = null;
}

export async function measureObjectStorageUsage(force = false): Promise<StorageUsage> {
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.usage;
  }

  const buckets = [env.MINIO_BUCKET_ORIGINALS, env.MINIO_BUCKET_RENDITIONS];
  const perBucket: Record<string, number> = {};
  let usedBytes = 0;
  for (const bucket of buckets) {
    const bytes = await sumBucketBytes(bucket);
    perBucket[bucket] = bytes;
    usedBytes += bytes;
  }

  const limitBytes = env.STORAGE_LIMIT_BYTES;
  const guardBytes = env.STORAGE_GUARD_BYTES;
  const usage: StorageUsage = {
    usedBytes,
    limitBytes,
    guardBytes,
    remainingBytes: Math.max(0, limitBytes - usedBytes),
    buckets: perBucket,
  };
  cached = { at: now, usage };
  return usage;
}

export async function assertStorageAllows(additionalBytes = 0): Promise<StorageGuardResult> {
  const usage = await measureObjectStorageUsage();
  return evaluateStorageGuard({
    usedBytes: usage.usedBytes,
    additionalBytes,
    limitBytes: usage.limitBytes,
    guardBytes: usage.guardBytes,
  });
}

export function storageLimitErrorBody(guard: StorageGuardResult) {
  return {
    error: "storage_limit",
    message:
      guard.reason === "would_exceed"
        ? "Object storage would exceed the 10 GB free-tier limit. New uploads and sessions are blocked."
        : "Object storage is near the 10 GB free-tier limit. New sessions are blocked until space is freed.",
    usedBytes: guard.usedBytes,
    limitBytes: guard.limitBytes,
    remainingBytes: guard.remainingBytes,
  };
}

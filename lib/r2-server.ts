import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { R2_MULTIPART_PART_SIZE, R2_PROXY_PUT_MAX } from "@/lib/r2-constants";

export { R2_MULTIPART_PART_SIZE, R2_PROXY_PUT_MAX };

const STORAGE_LIMIT_BYTES = Number(process.env.STORAGE_LIMIT_BYTES || 10 * 1024 * 1024 * 1024);
const STORAGE_GUARD_BYTES = Number(process.env.STORAGE_GUARD_BYTES || 256 * 1024 * 1024);

function required(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export function r2Configured() {
  return Boolean(
    process.env.R2_ENDPOINT &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_ORIGINALS,
  );
}

export function r2Client() {
  return new S3Client({
    region: "auto",
    endpoint: required("R2_ENDPOINT"),
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: true,
  });
}

export function originalsBucket() {
  return required("R2_BUCKET_ORIGINALS");
}

export function roomObjectKey(code: string, assetId: string, fileName: string) {
  const safe = fileName.replace(/[^\w.\-()+ ]+/g, "_").slice(0, 180) || "film.mp4";
  return `rooms/${code}/${assetId}/${safe}`;
}

export function assertRoomKey(code: string, objectKey: string) {
  const prefix = `rooms/${code}/`;
  if (!objectKey.startsWith(prefix) || objectKey.includes("..")) {
    throw new Error("Invalid object key for this room");
  }
}

export async function measureBucketBytes(client: S3Client, bucket: string) {
  let token: string | undefined;
  let bytes = 0;
  do {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const o of out.Contents || []) bytes += o.Size || 0;
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return bytes;
}

export async function assertStorageHeadroom(client: S3Client, incomingBytes: number) {
  const used = await measureBucketBytes(client, originalsBucket());
  if (used + incomingBytes > STORAGE_LIMIT_BYTES - STORAGE_GUARD_BYTES) {
    throw new Error(
      `R2 storage limit reached (${(used / (1024 * 1024 * 1024)).toFixed(2)} GiB used). Free space before uploading.`,
    );
  }
  return used;
}

export async function ensureR2Cors(client: S3Client) {
  // Signed browser PUTs need CORS. Allow any origin — objects stay private via signed URLs / server proxy.
  await client.send(
    new PutBucketCorsCommand({
      Bucket: originalsBucket(),
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ["*"],
            AllowedMethods: ["GET", "PUT", "HEAD", "POST"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "etag", "Content-Length", "Content-Range", "Accept-Ranges"],
            MaxAgeSeconds: 86400,
          },
        ],
      },
    }),
  );
}

export async function createMultipartUpload(opts: {
  code: string;
  fileName: string;
  mime: string;
  size: number;
}) {
  if (!r2Configured()) throw new Error("R2 is not configured");
  if (opts.size > STORAGE_LIMIT_BYTES) throw new Error("File exceeds storage limit");

  const client = r2Client();
  await assertStorageHeadroom(client, Math.max(0, opts.size));
  try {
    await ensureR2Cors(client);
  } catch {
    /* CORS update is best-effort — signed PUTs need it for large files */
  }

  const assetId = randomUUID();
  const objectKey = roomObjectKey(opts.code, assetId, opts.fileName);
  const out = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: originalsBucket(),
      Key: objectKey,
      ContentType: opts.mime || "video/mp4",
      Metadata: {
        room: opts.code,
        filename: opts.fileName.slice(0, 200),
      },
    }),
  );
  if (!out.UploadId) throw new Error("Could not start multipart upload");
  return { client, assetId, objectKey, uploadId: out.UploadId };
}

/** Prepare a single-PUT object key (no multipart — avoids R2’s 5 MiB part minimum). */
export async function preparePutUpload(opts: {
  code: string;
  fileName: string;
  mime: string;
  size: number;
}) {
  if (!r2Configured()) throw new Error("R2 is not configured");
  if (opts.size > STORAGE_LIMIT_BYTES) throw new Error("File exceeds storage limit");
  if (opts.size > R2_PROXY_PUT_MAX) {
    throw new Error("File too large for single PUT — use multipart");
  }

  const client = r2Client();
  await assertStorageHeadroom(client, Math.max(0, opts.size));
  const assetId = randomUUID();
  const objectKey = roomObjectKey(opts.code, assetId, opts.fileName);
  return { assetId, objectKey, contentType: opts.mime || "video/mp4" };
}

export async function putObjectBytes(opts: {
  objectKey: string;
  body: Buffer;
  contentType: string;
}) {
  const client = r2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: originalsBucket(),
      Key: opts.objectKey,
      Body: opts.body,
      ContentType: opts.contentType || "video/mp4",
    }),
  );
  const head = await client.send(
    new HeadObjectCommand({ Bucket: originalsBucket(), Key: opts.objectKey }),
  );
  return { size: head.ContentLength || opts.body.length, contentType: head.ContentType || opts.contentType };
}

/** Staging key for a proxy chunk that will be assembled into a multipart part. */
export function stagingChunkKey(
  objectKey: string,
  uploadId: string,
  partNumber: number,
  chunkIndex: number,
) {
  const safeUpload = uploadId.replace(/[^\w.-]+/g, "_").slice(0, 120);
  return `${objectKey}.parts/${safeUpload}/${partNumber}/${chunkIndex}`;
}

export async function putStagingChunk(opts: {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  chunkIndex: number;
  body: Buffer;
}) {
  if (!opts.objectKey.startsWith("rooms/")) throw new Error("Invalid object key");
  if (opts.partNumber < 1 || opts.chunkIndex < 0) throw new Error("Invalid part/chunk");
  const key = stagingChunkKey(opts.objectKey, opts.uploadId, opts.partNumber, opts.chunkIndex);
  await putObjectBytes({
    objectKey: key,
    body: opts.body,
    contentType: "application/octet-stream",
  });
  return { stagingKey: key, size: opts.body.length };
}

/**
 * Download staged chunks, UploadPart (≥5 MiB when assembled), then delete staging.
 * Avoids browser→R2 CORS and Vercel body limits on full parts.
 */
export async function commitStagedPart(opts: {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  chunkCount: number;
}) {
  if (!opts.objectKey.startsWith("rooms/")) throw new Error("Invalid object key");
  if (opts.chunkCount < 1 || opts.chunkCount > 8) throw new Error("Invalid chunk count");

  const client = r2Client();
  const bucket = originalsBucket();
  const chunks: Buffer[] = [];
  const stagingKeys: string[] = [];

  for (let i = 0; i < opts.chunkCount; i++) {
    const key = stagingChunkKey(opts.objectKey, opts.uploadId, opts.partNumber, i);
    stagingKeys.push(key);
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes?.length) throw new Error(`Missing staging chunk ${i} for part ${opts.partNumber}`);
    chunks.push(Buffer.from(bytes));
  }

  const body = Buffer.concat(chunks);
  const out = await client.send(
    new UploadPartCommand({
      Bucket: bucket,
      Key: opts.objectKey,
      UploadId: opts.uploadId,
      PartNumber: opts.partNumber,
      Body: body,
    }),
  );
  if (!out.ETag) throw new Error("Missing ETag from R2 UploadPart");

  try {
    await deleteObjectKeys(stagingKeys);
  } catch {
    /* best-effort cleanup */
  }

  return { etag: out.ETag.replaceAll('"', ""), size: body.length };
}

export function roomAliveKey(code: string) {
  return `rooms/${code}/.alive`;
}

export async function openRoomSession(code: string, meta?: { hostName?: string }) {
  if (!r2Configured()) throw new Error("R2 is not configured");
  const client = r2Client();
  const payload = JSON.stringify({
    code,
    openedAt: Date.now(),
    hostName: meta?.hostName || null,
  });
  await client.send(
    new PutObjectCommand({
      Bucket: originalsBucket(),
      Key: roomAliveKey(code),
      Body: payload,
      ContentType: "application/json",
    }),
  );
}

export async function roomSessionExists(code: string) {
  if (!r2Configured()) return false;
  try {
    const client = r2Client();
    await client.send(
      new HeadObjectCommand({ Bucket: originalsBucket(), Key: roomAliveKey(code) }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function closeRoomSession(code: string) {
  if (!r2Configured()) return;
  try {
    await deleteObjectKeys([roomAliveKey(code)]);
  } catch {
    /* ignore */
  }
}

export async function signUploadParts(opts: {
  objectKey: string;
  uploadId: string;
  partNumbers: number[];
}) {
  const client = r2Client();
  const bucket = originalsBucket();
  const urls: Array<{ partNumber: number; url: string }> = [];
  for (const partNumber of opts.partNumbers) {
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: opts.objectKey,
        UploadId: opts.uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: 60 * 60 },
    );
    urls.push({ partNumber, url });
  }
  return urls;
}

export async function completeMultipartUpload(opts: {
  objectKey: string;
  uploadId: string;
  parts: Array<{ PartNumber: number; ETag: string }>;
}) {
  const client = r2Client();
  const sorted = [...opts.parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: originalsBucket(),
      Key: opts.objectKey,
      UploadId: opts.uploadId,
      MultipartUpload: {
        Parts: sorted.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })),
      },
    }),
  );
  const head = await client.send(
    new HeadObjectCommand({ Bucket: originalsBucket(), Key: opts.objectKey }),
  );
  return { size: head.ContentLength || 0, contentType: head.ContentType || "video/mp4" };
}

export async function abortMultipartUpload(opts: { objectKey: string; uploadId: string }) {
  const client = r2Client();
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: originalsBucket(),
      Key: opts.objectKey,
      UploadId: opts.uploadId,
    }),
  );
}

export async function signPlaybackUrl(objectKey: string, expiresInSec = 2 * 60 * 60) {
  const client = r2Client();
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: originalsBucket(), Key: objectKey }),
    { expiresIn: expiresInSec },
  );
  return { url, expiresAt: Date.now() + expiresInSec * 1000 };
}

/** Byte-range fetch for windowed MSE streaming (inclusive start/end). */
export async function getObjectRange(objectKey: string, start: number, end: number) {
  const client = r2Client();
  const res = await client.send(
    new GetObjectCommand({
      Bucket: originalsBucket(),
      Key: objectKey,
      Range: `bytes=${start}-${end}`,
    }),
  );
  const body = res.Body;
  if (!body) throw new Error("Empty R2 range body");
  const bytes = await body.transformToByteArray();
  return {
    bytes: Buffer.from(bytes),
    contentLength: res.ContentLength || bytes.byteLength,
    contentRange: res.ContentRange || `bytes ${start}-${end}/*`,
    contentType: res.ContentType || "video/mp4",
    totalSize: parseTotalFromContentRange(res.ContentRange) ?? undefined,
  };
}

function parseTotalFromContentRange(range?: string) {
  if (!range) return null;
  const m = /\/(\d+)$/.exec(range);
  return m ? Number(m[1]) : null;
}

export async function headObjectSize(objectKey: string) {
  const client = r2Client();
  const head = await client.send(
    new HeadObjectCommand({ Bucket: originalsBucket(), Key: objectKey }),
  );
  return {
    size: head.ContentLength || 0,
    contentType: head.ContentType || "video/mp4",
  };
}

export async function purgeRoomPrefix(code: string) {
  const client = r2Client();
  const bucket = originalsBucket();
  const prefix = `rooms/${code}/`;
  let token: string | undefined;
  let deleted = 0;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (listed.Contents || []).map((o) => ({ Key: o.Key! })).filter((k) => k.Key);
    if (keys.length) {
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

export async function deleteObjectKeys(keys: string[]) {
  if (!keys.length) return 0;
  const client = r2Client();
  await client.send(
    new DeleteObjectsCommand({
      Bucket: originalsBucket(),
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  return keys.length;
}

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

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
  const origins = [
    process.env.PUBLIC_APP_URL || "https://partmov.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter(Boolean);
  await client.send(
    new PutBucketCorsCommand({
      Bucket: originalsBucket(),
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ["GET", "PUT", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "etag"],
            MaxAgeSeconds: 3600,
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
  if (opts.size <= 0) throw new Error("Empty file");
  if (opts.size > STORAGE_LIMIT_BYTES) throw new Error("File exceeds storage limit");

  const client = r2Client();
  await assertStorageHeadroom(client, opts.size);

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

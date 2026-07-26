import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { env } from "./env.js";

export const s3 = new S3Client({
  region: "us-east-1",
  endpoint: `${env.MINIO_USE_SSL ? "https" : "http"}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
});

export async function ensureBuckets() {
  for (const bucket of [env.MINIO_BUCKET_ORIGINALS, env.MINIO_BUCKET_RENDITIONS]) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer | Readable | string,
  contentType?: string,
) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
  });
  await upload.done();
}

export async function getObjectStream(bucket: string, key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body as Readable | undefined;
}

export async function deletePrefix(bucket: string, prefix: string) {
  let token: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((k) => k.Key);
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
}

export async function deleteObject(bucket: string, key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export function renditionKey(assetId: string, version: number, ...parts: string[]) {
  return `assets/${assetId}/v${version}/${parts.join("/")}`;
}

export function originalKey(ownerId: string, assetId: string, filename: string) {
  return `owners/${ownerId}/${assetId}/${filename}`;
}

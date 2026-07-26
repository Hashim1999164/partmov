#!/usr/bin/env node
/**
 * Careful R2 cleanup for Partmov buckets.
 * Reads .env.r2 (never commit that file). Lists objects, then deletes only after --confirm.
 *
 * Usage:
 *   node scripts/cleanup-r2.mjs              # dry-run list
 *   node scripts/cleanup-r2.mjs --confirm    # delete all listed objects
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

function loadEnvR2() {
  const path = resolve(process.cwd(), ".env.r2");
  if (!existsSync(path)) {
    console.error("Missing .env.r2 — aborting (no secrets guessed).");
    process.exit(1);
  }
  const raw = readFileSync(path, "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

async function listAll(client, bucket) {
  const keys = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const o of out.Contents || []) {
      if (o.Key) keys.push({ Key: o.Key, Size: o.Size || 0 });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteAll(client, bucket, keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000).map((k) => ({ Key: k.Key }));
    const out = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk, Quiet: true },
      }),
    );
    deleted += chunk.length - (out.Errors?.length || 0);
    if (out.Errors?.length) {
      console.error(`Delete errors in ${bucket}:`, out.Errors.slice(0, 5));
    }
  }
  return deleted;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const env = loadEnvR2();
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const buckets = [env.R2_BUCKET_ORIGINALS, env.R2_BUCKET_RENDITIONS].filter(Boolean);

  if (!endpoint || !accessKeyId || !secretAccessKey || buckets.length === 0) {
    console.error("Incomplete R2 credentials in .env.r2");
    process.exit(1);
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  console.log(confirm ? "CONFIRM delete mode" : "DRY-RUN (pass --confirm to delete)");
  let totalBytes = 0;
  let totalKeys = 0;

  for (const bucket of buckets) {
    const keys = await listAll(client, bucket);
    const bytes = keys.reduce((s, k) => s + k.Size, 0);
    totalBytes += bytes;
    totalKeys += keys.length;
    console.log(`\n[${bucket}] ${keys.length} objects · ${(bytes / (1024 * 1024)).toFixed(2)} MiB`);
    for (const k of keys.slice(0, 20)) {
      console.log(`  - ${k.Key} (${k.Size} B)`);
    }
    if (keys.length > 20) console.log(`  … +${keys.length - 20} more`);

    if (confirm && keys.length) {
      const n = await deleteAll(client, bucket, keys);
      console.log(`  deleted ${n}/${keys.length}`);
    }
  }

  console.log(
    `\nTotal: ${totalKeys} objects · ${(totalBytes / (1024 * 1024)).toFixed(2)} MiB` +
      (confirm ? " (deleted where possible)" : " (dry-run only)"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

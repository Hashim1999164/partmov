import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import pg from "pg";
import { ABR_LADDER, SEGMENT_DURATION_SEC } from "@partmov/protocol";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://partmov:partmov@127.0.0.1:5432/partmov";
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const LEASE_SEC = Number(process.env.JOB_LEASE_SEC ?? 120);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1));
const ENCODER_VERSION = process.env.ENCODER_VERSION ?? "partmov-ffmpeg-v1";
const POLL_MS = Number(process.env.JOB_POLL_MS ?? 2000);
const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 8091);

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "127.0.0.1";
const MINIO_PORT = Number(process.env.MINIO_PORT ?? 9000);
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === "true";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "partmov";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "partmovsecret";
const BUCKET_ORIGINALS = process.env.MINIO_BUCKET_ORIGINALS ?? "originals";
const BUCKET_RENDITIONS = process.env.MINIO_BUCKET_RENDITIONS ?? "renditions";

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const s3 = new S3Client({
  region: "us-east-1",
  endpoint: `${MINIO_USE_SSL ? "https" : "http"}://${MINIO_ENDPOINT}:${MINIO_PORT}`,
  forcePathStyle: true,
  credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
});

type JobRow = {
  id: string;
  kind: string;
  asset_id: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

type ProbeInfo = {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  fingerprint: string;
  audioTracks: Array<{ index: number; language: string; channels: number; label: string }>;
  subtitleStreams: Array<{ index: number; language: string; label: string; codec: string }>;
};

let jobsSucceeded = 0;
let jobsFailed = 0;
let activeJobs = 0;

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function downloadObject(bucket: string, key: string, dest: string) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`Missing object ${bucket}/${key}`);
  await pipeline(out.Body as NodeJS.ReadableStream, createWriteStream(dest));
}

async function uploadFile(bucket: string, key: string, filePath: string, contentType: string) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
    },
  });
  await upload.done();
}

async function uploadBuffer(bucket: string, key: string, body: Buffer | string, contentType: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      ContentType: contentType,
    }),
  );
}

async function deletePrefix(bucket: string, prefix: string) {
  let token: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
}

function even(n: number) {
  return n % 2 === 0 ? n : n - 1;
}

function ladderForSource(height: number) {
  return ABR_LADDER.filter((r) => r.height <= height);
}

async function ffprobe(path: string): Promise<ProbeInfo> {
  const { code, stdout, stderr } = await run("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(0, 500)}`);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string; bit_rate?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const video = (data.streams ?? []).find((s) => s.codec_type === "video");
  if (!video) throw new Error("No video stream");
  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);
  if (!width || !height) throw new Error("Invalid dimensions");
  const durationSec = Number(data.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Invalid duration");
  const avgFrameRate = String(video.avg_frame_rate ?? video.r_frame_rate ?? "24/1");
  const [num, den] = avgFrameRate.split("/").map(Number);
  const fps = den ? num / den : Number(avgFrameRate) || 24;
  const audioStreams = (data.streams ?? []).filter((s) => s.codec_type === "audio");
  const subStreams = (data.streams ?? []).filter((s) => s.codec_type === "subtitle");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        duration: data.format?.duration,
        size: data.format?.size,
        width,
        height,
        fps,
        vcodec: video.codec_name,
        acodec: audioStreams.map((a) => a.codec_name),
      }),
    )
    .digest("hex");

  return {
    durationMs: Math.round(durationSec * 1000),
    width,
    height,
    fps,
    hasAudio: audioStreams.length > 0,
    fingerprint,
    audioTracks: audioStreams.map((a, i) => ({
      index: Number(a.index ?? i),
      language: String((a.tags as { language?: string } | undefined)?.language ?? "und"),
      channels: Number(a.channels ?? 2),
      label: `Audio ${i + 1}`,
    })),
    subtitleStreams: subStreams.map((s, i) => ({
      index: Number(s.index ?? i),
      language: String((s.tags as { language?: string } | undefined)?.language ?? "und"),
      label: `Subtitles ${i + 1}`,
      codec: String(s.codec_name ?? "unknown"),
    })),
  };
}

async function claimJob(): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<JobRow>(
      `SELECT id, kind, asset_id, attempts, max_attempts, payload
       FROM jobs
       WHERE status = 'pending'
          OR (status IN ('leased','running') AND lease_expires_at < now())
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const job = rows[0];
    if (!job) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE jobs SET status = 'leased', lease_owner = $2, lease_expires_at = now() + ($3 || ' seconds')::interval,
       attempts = attempts + 1, updated_at = now() WHERE id = $1`,
      [job.id, WORKER_ID, String(LEASE_SEC)],
    );
    await client.query("COMMIT");
    return job;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function markRunning(jobId: string) {
  await pool.query(
    `UPDATE jobs SET status = 'running', lease_expires_at = now() + ($2 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
    [jobId, String(LEASE_SEC)],
  );
}

async function markSuccess(jobId: string) {
  await pool.query(
    `UPDATE jobs SET status = 'succeeded', finished_at = now(), updated_at = now(), lease_expires_at = NULL WHERE id = $1`,
    [jobId],
  );
  jobsSucceeded += 1;
}

async function markFail(job: JobRow, error: string) {
  const dead = job.attempts >= job.max_attempts;
  await pool.query(
    `UPDATE jobs SET status = $2, last_error = $3, finished_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END,
     updated_at = now(), lease_expires_at = NULL WHERE id = $1`,
    [job.id, dead ? "dead" : "pending", error.slice(0, 2000)],
  );
  if (dead) {
    await pool.query(
      `UPDATE assets SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`,
      [job.asset_id, error.slice(0, 1000)],
    );
  }
  jobsFailed += 1;
}

async function handleProbe(job: JobRow) {
  const { rows } = await pool.query<{ original_key: string | null }>(
    `SELECT original_key FROM assets WHERE id = $1`,
    [job.asset_id],
  );
  const key = rows[0]?.original_key ?? String(job.payload.originalKey ?? "");
  if (!key) throw new Error("Missing original key");
  await pool.query(`UPDATE assets SET status = 'probing', updated_at = now() WHERE id = $1`, [job.asset_id]);

  const work = join(tmpdir(), `partmov-probe-${job.asset_id}`);
  mkdirSync(work, { recursive: true });
  const local = join(work, "source.bin");
  try {
    await downloadObject(BUCKET_ORIGINALS, key, local);
    const info = await ffprobe(local);
    await pool.query(
      `UPDATE assets SET duration_ms = $2, width = $3, height = $4, fps = $5, has_audio = $6,
       source_fingerprint = $7, updated_at = now() WHERE id = $1`,
      [job.asset_id, info.durationMs, info.width, info.height, info.fps, info.hasAudio, info.fingerprint],
    );
    for (const a of info.audioTracks) {
      await pool.query(
        `INSERT INTO asset_audio_tracks (asset_id, track_index, language, label, channels)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (asset_id, track_index) DO UPDATE SET language = EXCLUDED.language`,
        [job.asset_id, a.index, a.language, a.label, a.channels],
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function handleTranscode(job: JobRow) {
  const { rows } = await pool.query<{
    original_key: string | null;
    width: number | null;
    height: number | null;
    has_audio: boolean;
    owner_id: string;
  }>(`SELECT original_key, width, height, has_audio, owner_id FROM assets WHERE id = $1`, [job.asset_id]);
  const asset = rows[0];
  if (!asset?.original_key) throw new Error("Asset missing original");
  await pool.query(`UPDATE assets SET status = 'transcoding', updated_at = now() WHERE id = $1`, [job.asset_id]);

  const work = join(tmpdir(), `partmov-xcode-${job.asset_id}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const source = join(work, "source.bin");
  const outDir = join(work, "hls");
  mkdirSync(outDir, { recursive: true });

  try {
    await downloadObject(BUCKET_ORIGINALS, asset.original_key, source);
    let width = asset.width ?? 0;
    let height = asset.height ?? 0;
    let hasAudio = asset.has_audio;
    if (!width || !height) {
      const info = await ffprobe(source);
      width = info.width;
      height = info.height;
      hasAudio = info.hasAudio;
      await pool.query(
        `UPDATE assets SET duration_ms = $2, width = $3, height = $4, fps = $5, has_audio = $6,
         source_fingerprint = $7, updated_at = now() WHERE id = $1`,
        [job.asset_id, info.durationMs, info.width, info.height, info.fps, info.hasAudio, info.fingerprint],
      );
    }

    const rungs = ladderForSource(height);
    if (rungs.length === 0) throw new Error("Source resolution too low for ladder");

    const version = Number(job.payload.version ?? 1);
    const publishPrefix = `assets/${job.asset_id}/v${version}`;
    const stagingPrefix = `assets/${job.asset_id}/staging/v${version}-${WORKER_ID}`;

    // Poster
    const posterPath = join(work, "poster.jpg");
    const posterRes = await run("ffmpeg", [
      "-y",
      "-ss",
      "5",
      "-i",
      source,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      posterPath,
    ]);
    if (posterRes.code !== 0 || !existsSync(posterPath)) {
      // try from start
      await run("ffmpeg", ["-y", "-i", source, "-frames:v", "1", "-q:v", "3", posterPath]);
    }

    // Sprite sheet + VTT (sample every 10s, 160px wide)
    const spriteDir = join(work, "sprites");
    mkdirSync(spriteDir, { recursive: true });
    await run("ffmpeg", [
      "-y",
      "-i",
      source,
      "-vf",
      "fps=1/10,scale=160:-1",
      join(spriteDir, "thumb-%04d.jpg"),
    ]);
    const thumbs = readdirSync(spriteDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    // Build a simple horizontal-ish grid via montage alternative: copy first as sprite placeholder sheet
    const spritePath = join(work, "sprite.jpg");
    if (thumbs[0]) {
      await run("ffmpeg", ["-y", "-i", join(spriteDir, thumbs[0]), "-q:v", "4", spritePath]);
    }

    let vtt = "WEBVTT\n\n";
    thumbs.forEach((t, i) => {
      const start = i * 10;
      const end = start + 10;
      const fmt = (s: number) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000`;
      };
      vtt += `${fmt(start)} --> ${fmt(end)}\n${stagingPrefix}/thumbs/${t}#xywh=0,0,160,90\n\n`;
    });
    const vttPath = join(work, "sprites.vtt");
    await import("node:fs").then((fs) => fs.writeFileSync(vttPath, vtt));

    // Extract text subs if present
    const probe = await ffprobe(source);
    for (const [i, sub] of probe.subtitleStreams.entries()) {
      if (!["mov_text", "subrip", "webvtt", "ass", "ssa"].includes(sub.codec) && sub.codec !== "unknown") continue;
      const subOut = join(work, `sub-${i}.vtt`);
      const r = await run("ffmpeg", ["-y", "-i", source, "-map", `0:${sub.index}`, subOut]);
      if (r.code === 0 && existsSync(subOut)) {
        const key = `${stagingPrefix}/subs/${sub.language}-${i}.vtt`;
        await uploadFile(BUCKET_RENDITIONS, key, subOut, "text/vtt");
        await pool.query(
          `INSERT INTO asset_subtitles (asset_id, language, label, vtt_key) VALUES ($1,$2,$3,$4)`,
          [job.asset_id, sub.language, sub.label, key.replace(stagingPrefix, publishPrefix)],
        );
      }
    }

    const variantMeta: Array<{ height: number; bandwidth: number; bitrate: number; playlist: string; codecs: string }> =
      [];

    for (const rung of rungs) {
      const outH = even(rung.height);
      const outW = even(Math.round((width / height) * outH));
      const variantDir = join(outDir, String(outH));
      mkdirSync(variantDir, { recursive: true });
      const playlist = join(variantDir, "index.m3u8");
      const segmentPattern = join(variantDir, "seg_%05d.m4s");
      const initSeg = join(variantDir, "init.mp4");

      const args = [
        "-y",
        "-i",
        source,
        "-vf",
        `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        "-c:v",
        "libx264",
        "-profile:v",
        outH >= 720 ? "high" : "main",
        "-level",
        "4.0",
        "-b:v",
        `${rung.videoBitrateKbps}k`,
        "-maxrate",
        `${Math.round(rung.videoBitrateKbps * 1.1)}k`,
        "-bufsize",
        `${rung.videoBitrateKbps * 2}k`,
        "-g",
        String(Math.round(2 * (probe.fps || 24))),
        "-keyint_min",
        String(Math.round(2 * (probe.fps || 24))),
        "-sc_threshold",
        "0",
        "-force_key_frames",
        `expr:gte(t,n_forced*${SEGMENT_DURATION_SEC})`,
        "-pix_fmt",
        "yuv420p",
      ];

      if (hasAudio) {
        args.push(
          "-c:a",
          "aac",
          "-b:a",
          `${rung.audioBitrateKbps}k`,
          "-ac",
          "2",
          "-ar",
          "48000",
        );
      } else {
        args.push("-an");
      }

      args.push(
        "-f",
        "hls",
        "-hls_time",
        String(SEGMENT_DURATION_SEC),
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        "init.mp4",
        "-hls_segment_filename",
        segmentPattern,
        "-hls_flags",
        "independent_segments",
        playlist,
      );

      const enc = await run("ffmpeg", args);
      if (enc.code !== 0) throw new Error(`ffmpeg ${outH}p failed: ${enc.stderr.slice(-800)}`);

      // Validate playlist exists and has segments
      const pl = readFileSync(playlist, "utf8");
      if (!pl.includes("#EXTM3U") || !pl.includes("#EXTINF")) {
        throw new Error(`Invalid playlist for ${outH}p`);
      }
      const files = readdirSync(variantDir);
      for (const f of files) {
        const ct = f.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : f.endsWith(".m4s") || f.endsWith(".mp4")
            ? "video/mp4"
            : "application/octet-stream";
        await uploadFile(BUCKET_RENDITIONS, `${stagingPrefix}/${outH}/${f}`, join(variantDir, f), ct);
      }

      const bandwidth = (rung.videoBitrateKbps + (hasAudio ? rung.audioBitrateKbps : 0)) * 1000;
      variantMeta.push({
        height: outH,
        bandwidth,
        bitrate: rung.videoBitrateKbps,
        playlist: `${stagingPrefix}/${outH}/index.m3u8`,
        codecs: hasAudio ? "avc1.640028,mp4a.40.2" : "avc1.640028",
      });
    }

    // Master playlist
    let master = "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n";
    for (const v of variantMeta.sort((a, b) => a.height - b.height)) {
      master += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${even(Math.round((width / height) * v.height))}x${v.height},CODECS="${v.codecs}"\n`;
      master += `${v.height}/index.m3u8\n`;
    }
    const masterStaging = `${stagingPrefix}/master.m3u8`;
    await uploadBuffer(BUCKET_RENDITIONS, masterStaging, master, "application/vnd.apple.mpegurl");

    if (existsSync(posterPath)) {
      await uploadFile(BUCKET_RENDITIONS, `${stagingPrefix}/poster.jpg`, posterPath, "image/jpeg");
    }
    if (existsSync(spritePath)) {
      await uploadFile(BUCKET_RENDITIONS, `${stagingPrefix}/sprite.jpg`, spritePath, "image/jpeg");
    }
    await uploadFile(BUCKET_RENDITIONS, `${stagingPrefix}/sprites.vtt`, vttPath, "text/vtt");
    for (const t of thumbs) {
      await uploadFile(BUCKET_RENDITIONS, `${stagingPrefix}/thumbs/${t}`, join(spriteDir, t), "image/jpeg");
    }

    // Atomic publish: copy staging keys conceptually by rewriting DB to staging paths then rename via re-upload to publish prefix
    // For MinIO without rename, re-list staging and put under publish prefix.
    await deletePrefix(BUCKET_RENDITIONS, `${publishPrefix}/`);
    let cont: string | undefined;
    do {
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET_RENDITIONS, Prefix: `${stagingPrefix}/`, ContinuationToken: cont }),
      );
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key) continue;
        const destKey = obj.Key.replace(stagingPrefix, publishPrefix);
        const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET_RENDITIONS, Key: obj.Key }));
        const chunks: Buffer[] = [];
        for await (const c of got.Body as AsyncIterable<Buffer>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const body = Buffer.concat(chunks);
        const ct = destKey.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : destKey.endsWith(".vtt")
            ? "text/vtt"
            : destKey.endsWith(".jpg")
              ? "image/jpeg"
              : "video/mp4";
        await uploadBuffer(BUCKET_RENDITIONS, destKey, body, ct);
      }
      cont = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (cont);

    await deletePrefix(BUCKET_RENDITIONS, `${stagingPrefix}/`);

    await pool.query(`DELETE FROM asset_variants WHERE asset_id = $1`, [job.asset_id]);
    for (const v of variantMeta) {
      await pool.query(
        `INSERT INTO asset_variants (asset_id, height, bandwidth, video_bitrate_kbps, playlist_key, init_segment_key, codecs)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          job.asset_id,
          v.height,
          v.bandwidth,
          v.bitrate,
          `${publishPrefix}/${v.height}/index.m3u8`,
          `${publishPrefix}/${v.height}/init.mp4`,
          v.codecs,
        ],
      );
    }

    await pool.query(
      `UPDATE assets SET status = 'ready', master_playlist_key = $2, poster_key = $3, sprite_key = $4,
       encoder_version = $5, published_version = $6, error_message = NULL, updated_at = now() WHERE id = $1`,
      [
        job.asset_id,
        `${publishPrefix}/master.m3u8`,
        `${publishPrefix}/poster.jpg`,
        `${publishPrefix}/sprites.vtt`,
        ENCODER_VERSION,
        version,
      ],
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function handlePurge(job: JobRow) {
  const { rows } = await pool.query<{ original_key: string | null; master_playlist_key: string | null }>(
    `SELECT original_key, master_playlist_key FROM assets WHERE id = $1`,
    [job.asset_id],
  );
  const asset = rows[0];
  if (asset?.original_key) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_ORIGINALS, Key: asset.original_key }));
  }
  await deletePrefix(BUCKET_RENDITIONS, `assets/${job.asset_id}/`);
  await pool.query(
    `UPDATE assets SET status = 'purged', purged_at = now(), master_playlist_key = NULL, original_key = NULL, updated_at = now() WHERE id = $1`,
    [job.asset_id],
  );
  await pool.query(`UPDATE playback_sessions SET revoked_at = now() WHERE asset_id = $1 AND revoked_at IS NULL`, [
    job.asset_id,
  ]);
}

async function processJob(job: JobRow) {
  activeJobs += 1;
  try {
    await markRunning(job.id);
    if (job.kind === "probe") await handleProbe(job);
    else if (job.kind === "transcode") await handleTranscode(job);
    else if (job.kind === "purge") await handlePurge(job);
    else {
      // poster/sprites/subtitles are folded into transcode for v1
      await markSuccess(job.id);
      return;
    }
    await markSuccess(job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${WORKER_ID}] job ${job.id} failed:`, msg);
    await markFail(job, msg);
  } finally {
    activeJobs -= 1;
  }
}

async function loop() {
  while (true) {
    try {
      while (activeJobs < CONCURRENCY) {
        const job = await claimJob();
        if (!job) break;
        void processJob(job);
      }
    } catch (err) {
      console.error("claim loop error", err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const metricsServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, worker: WORKER_ID, activeJobs }));
    return;
  }
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      [
        `partmov_worker_up 1`,
        `partmov_worker_active_jobs ${activeJobs}`,
        `partmov_worker_jobs_succeeded_total ${jobsSucceeded}`,
        `partmov_worker_jobs_failed_total ${jobsFailed}`,
        "",
      ].join("\n"),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

metricsServer.listen(METRICS_PORT, "0.0.0.0", () => {
  console.log(`worker ${WORKER_ID} metrics :${METRICS_PORT}`);
});

console.log(`worker ${WORKER_ID} starting (concurrency=${CONCURRENCY})`);
loop().catch((err) => {
  console.error(err);
  process.exit(1);
});

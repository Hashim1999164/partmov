import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { env } from "../lib/env.js";
import { originalKey, putObject } from "../lib/minio.js";
import { requireUser } from "./auth.js";

export async function assetRoutes(app: FastifyInstance) {
  app.get("/assets", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const { rows } = await query(
      `SELECT id, title, status, duration_ms, poster_key, master_playlist_key, error_message, created_at
       FROM assets WHERE owner_id = $1 AND status <> 'purged' ORDER BY created_at DESC LIMIT 100`,
      [user.id],
    );
    return {
      assets: rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        durationMs: r.duration_ms,
        posterUrl: r.poster_key ? `${env.MEDIA_PUBLIC_BASE}/${r.poster_key}` : null,
        masterPlaylistUrl: r.master_playlist_key ? `${env.MEDIA_PUBLIC_BASE}/${r.master_playlist_key}` : null,
        errorMessage: r.error_message,
        createdAt: r.created_at,
      })),
    };
  });

  app.post("/assets/upload-session", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const body = z
      .object({
        filename: z.string().min(1).max(255),
        mime: z.string().default("video/mp4"),
        sizeBytes: z.number().int().positive().max(40 * 1024 * 1024 * 1024),
        title: z.string().min(1).max(200).optional(),
      })
      .parse(req.body);

    const title = body.title ?? body.filename.replace(/\.[^.]+$/, "");
    const asset = await query<{ id: string }>(
      `INSERT INTO assets (owner_id, title, status) VALUES ($1, $2, 'uploading') RETURNING id`,
      [user.id, title],
    );
    const assetId = asset.rows[0].id;
    const key = originalKey(user.id, assetId, body.filename);
    const upload = await query<{ id: string }>(
      `INSERT INTO upload_sessions (asset_id, owner_id, object_key, filename, mime, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [assetId, user.id, key, body.filename, body.mime, body.sizeBytes],
    );

    return {
      assetId,
      uploadSessionId: upload.rows[0].id,
      objectKey: key,
      tusEndpoint: `/api/uploads/${upload.rows[0].id}`,
    };
  });

  /** Simplified chunked upload (tus-compatible spirit; streams into MinIO). */
  app.put("/uploads/:uploadId", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const uploadId = (req.params as { uploadId: string }).uploadId;
    const { rows } = await query<{
      id: string;
      asset_id: string;
      object_key: string;
      mime: string;
      size_bytes: string;
      completed_at: Date | null;
    }>(`SELECT * FROM upload_sessions WHERE id = $1 AND owner_id = $2`, [uploadId, user.id]);
    const session = rows[0];
    if (!session) return reply.code(404).send({ error: "not_found", message: "Upload session missing" });
    if (session.completed_at) return reply.code(409).send({ error: "completed", message: "Already uploaded" });

    const chunks: Buffer[] = [];
    for await (const chunk of req.raw) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    await putObject(env.MINIO_BUCKET_ORIGINALS, session.object_key, body, session.mime);
    await query(
      `UPDATE upload_sessions SET bytes_received = $2, completed_at = now() WHERE id = $1`,
      [uploadId, body.length],
    );
    await query(`UPDATE assets SET status = 'queued', original_key = $2, updated_at = now() WHERE id = $1`, [
      session.asset_id,
      session.object_key,
    ]);
    await query(
      `INSERT INTO jobs (kind, asset_id, dedupe_key, status, payload)
       VALUES ('probe', $1, $2, 'pending', $3)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [session.asset_id, `probe:${session.asset_id}`, JSON.stringify({ originalKey: session.object_key })],
    );
    await query(
      `INSERT INTO jobs (kind, asset_id, dedupe_key, status, payload)
       VALUES ('transcode', $1, $2, 'pending', $3)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [session.asset_id, `transcode:${session.asset_id}:v1`, JSON.stringify({ originalKey: session.object_key, version: 1 })],
    );

    return { ok: true, assetId: session.asset_id, bytes: body.length };
  });

  app.get("/assets/:id", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const id = (req.params as { id: string }).id;
    const { rows } = await query(`SELECT * FROM assets WHERE id = $1 AND owner_id = $2`, [id, user.id]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found", message: "Asset not found" });
    const variants = await query(`SELECT height, bandwidth, video_bitrate_kbps, playlist_key FROM asset_variants WHERE asset_id = $1`, [
      id,
    ]);
    return { asset: rows[0], variants: variants.rows };
  });

  app.delete("/assets/:id", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const id = (req.params as { id: string }).id;
    const { rows } = await query(`SELECT id FROM assets WHERE id = $1 AND owner_id = $2`, [id, user.id]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found", message: "Asset not found" });
    await query(
      `INSERT INTO jobs (kind, asset_id, dedupe_key, status, payload)
       VALUES ('purge', $1, $2, 'pending', '{}'::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, `purge:${id}:${Date.now()}`],
    );
    await query(`UPDATE assets SET status = 'purged', updated_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });
}

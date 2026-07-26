import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { env } from "../lib/env.js";
import { verifyPlaybackToken } from "../lib/crypto.js";
import { getObjectStream } from "../lib/minio.js";
import { query } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";

/**
 * Media edge authorization gate.
 * Validates signed cookie/query token and streams from MinIO renditions bucket.
 * Production puts nginx in front with auth_request to this handler or equivalent.
 */
export async function mediaRoutes(app: FastifyInstance) {
  app.get("/media/*", async (req, reply) => {
    const path = (req.params as { "*": string })["*"];
    if (!path || path.includes("..")) {
      return reply.code(400).send({ error: "bad_path", message: "Invalid media path" });
    }

    const cookieToken = req.cookies.partmov_playback;
    const queryToken = typeof req.query === "object" && req.query && "token" in req.query
      ? String((req.query as { token?: string }).token ?? "")
      : "";
    const token = cookieToken || queryToken;
    if (!token) return reply.code(401).send({ error: "unauthorized", message: "Playback token required" });

    const payload = verifyPlaybackToken(token);
    if (!payload) return reply.code(401).send({ error: "unauthorized", message: "Invalid playback token" });

    if (!path.startsWith(payload.pathPrefix) && !path.includes(payload.assetId)) {
      return reply.code(403).send({ error: "forbidden", message: "Path outside session scope" });
    }

    const session = await query(
      `SELECT id FROM playback_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sha256(token)],
    );
    if (!session.rows[0]) {
      return reply.code(401).send({ error: "unauthorized", message: "Playback session revoked or expired" });
    }

    const stream = await getObjectStream(env.MINIO_BUCKET_RENDITIONS, path);
    if (!stream) return reply.code(404).send({ error: "not_found", message: "Object missing" });

    const contentType = path.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : path.endsWith(".m4s") || path.endsWith(".mp4")
        ? "video/mp4"
        : path.endsWith(".vtt")
          ? "text/vtt"
          : "application/octet-stream";

    reply.header("Content-Type", contentType);
    reply.header("Cache-Control", path.endsWith(".m3u8") ? "private, max-age=3" : "public, max-age=86400, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(Readable.from(stream));
  });

  /** Auth subrequest for nginx auth_request — cookie or ?token= on original URI. */
  app.get("/internal/media-auth", async (req, reply) => {
    const originalUri = String(req.headers["x-original-uri"] ?? "");
    let token = req.cookies.partmov_playback ?? "";
    try {
      const u = new URL(originalUri, "http://edge.local");
      if (!token) token = u.searchParams.get("token") ?? "";
    } catch {
      /* ignore */
    }
    if (!token) return reply.code(401).send("deny");
    const payload = verifyPlaybackToken(token);
    if (!payload) return reply.code(401).send("deny");
    const path = originalUri
      .replace(/^\/hls\//, "")
      .replace(/^\/media\//, "")
      .split("?")[0];
    if (!path.startsWith(payload.pathPrefix) && !path.includes(payload.assetId)) {
      return reply.code(403).send("deny");
    }
    const session = await query(
      `SELECT id FROM playback_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sha256(token)],
    );
    if (!session.rows[0]) return reply.code(401).send("deny");
    return reply.code(200).send("allow");
  });
}

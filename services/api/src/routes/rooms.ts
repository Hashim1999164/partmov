import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_SETTINGS } from "@partmov/protocol";
import { query } from "../db/pool.js";
import { env } from "../lib/env.js";
import { randomToken, roomCode, sha256, signPlaybackToken } from "../lib/crypto.js";
import { requireUser } from "./auth.js";

export async function roomRoutes(app: FastifyInstance) {
  app.post("/rooms", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const body = z
      .object({
        assetId: z.string().uuid(),
        title: z.string().max(120).optional(),
        expiresInSec: z.number().int().positive().max(86400 * 7).default(86400),
        passphrase: z.string().max(64).optional(),
      })
      .parse(req.body);

    const asset = await query<{ id: string; title: string; status: string; master_playlist_key: string | null }>(
      `SELECT id, title, status, master_playlist_key FROM assets WHERE id = $1 AND owner_id = $2`,
      [body.assetId, user.id],
    );
    if (!asset.rows[0]) return reply.code(404).send({ error: "not_found", message: "Asset not found" });
    if (asset.rows[0].status !== "ready") {
      return reply.code(409).send({ error: "not_ready", message: "Asset still processing" });
    }

    const code = roomCode();
    const settings = { ...DEFAULT_SETTINGS, roomTitle: body.title ?? asset.rows[0].title };
    const room = await query<{ id: string }>(
      `INSERT INTO rooms (code, asset_id, title, host_user_id, settings, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now() + make_interval(secs => $6))
       RETURNING id`,
      [code, body.assetId, settings.roomTitle, user.id, JSON.stringify(settings), body.expiresInSec],
    );

    await query(
      `INSERT INTO room_participants (room_id, user_id, display_name, role, connection_state)
       VALUES ($1, $2, $3, 'host', 'disconnected')`,
      [room.rows[0].id, user.id, user.display_name || "Host"],
    );

    const inviteToken = randomToken(22);
    const passphraseHash = body.passphrase ? sha256(body.passphrase) : null;
    await query(
      `INSERT INTO room_invitations (room_id, token_hash, passphrase_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [room.rows[0].id, sha256(inviteToken), passphraseHash, body.expiresInSec],
    );

    return {
      roomId: room.rows[0].id,
      code,
      inviteToken,
      inviteUrl: `${env.PUBLIC_APP_URL}/watch/${code}?as=guest&token=${inviteToken}`,
      expiresAt: new Date(Date.now() + body.expiresInSec * 1000).toISOString(),
    };
  });

  app.post("/rooms/:id/playback-url", async (req, reply) => {
    const user = await requireUser(req);
    const roomId = (req.params as { id: string }).id;
    const body = z
      .object({
        participantId: z.string().uuid().optional(),
        inviteToken: z.string().optional(),
      })
      .parse(req.body ?? {});

    const room = await query<{
      id: string;
      asset_id: string;
      ended_at: Date | null;
      master_playlist_key: string | null;
      published_version: number;
    }>(
      `SELECT r.id, r.asset_id, r.ended_at, a.master_playlist_key, a.published_version
       FROM rooms r JOIN assets a ON a.id = r.asset_id WHERE r.id = $1`,
      [roomId],
    );
    if (!room.rows[0] || room.rows[0].ended_at) {
      return reply.code(404).send({ error: "not_found", message: "Room unavailable" });
    }
    if (!room.rows[0].master_playlist_key) {
      return reply.code(409).send({ error: "not_ready", message: "Media not published" });
    }

    // Allow host session or valid invite.
    if (!user && !body.inviteToken) {
      return reply.code(401).send({ error: "unauthorized", message: "Auth or invite required" });
    }
    if (body.inviteToken) {
      const inv = await query(
        `SELECT id FROM room_invitations
         WHERE room_id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > now() AND use_count < max_uses`,
        [roomId, sha256(body.inviteToken)],
      );
      if (!inv.rows[0]) return reply.code(403).send({ error: "forbidden", message: "Invalid invite" });
    }

    const pathPrefix = `assets/${room.rows[0].asset_id}/v${room.rows[0].published_version}/`;
    const exp = Math.floor(Date.now() / 1000) + 15 * 60;
    const sid = randomToken(16);
    const token = signPlaybackToken({
      sid,
      roomId,
      assetId: room.rows[0].asset_id,
      pathPrefix,
      exp,
    });
    await query(
      `INSERT INTO playback_sessions (id, room_id, asset_id, participant_id, token_hash, path_prefix, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, to_timestamp($7))`,
      [
        // use random uuid-ish from token hash prefix — better generate uuid
        cryptoRandomUuid(),
        roomId,
        room.rows[0].asset_id,
        body.participantId ?? null,
        sha256(token),
        pathPrefix,
        exp,
      ],
    );

    const variants = await query<{ height: number; bandwidth: number }>(
      `SELECT height, bandwidth FROM asset_variants WHERE asset_id = $1 ORDER BY height`,
      [room.rows[0].asset_id],
    );

    reply.setCookie("partmov_playback", token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 15 * 60,
    });

    // Also return token for hls.js custom loader (cross-origin edge).
    return {
      playbackSessionId: sid,
      token,
      masterPlaylistUrl: `${env.MEDIA_PUBLIC_BASE}/${room.rows[0].master_playlist_key}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      levels: variants.rows.map((v) => ({
        height: v.height,
        bandwidth: v.bandwidth,
        label: `${v.height}p`,
      })),
    };
  });

  /** Refresh playback authorization without interrupting video. */
  app.post("/rooms/:id/playback-refresh", async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const body = z
      .object({
        inviteToken: z.string().optional(),
        participantId: z.string().uuid().optional(),
      })
      .parse(req.body ?? {});
    const user = await requireUser(req);

    const room = await query<{
      id: string;
      asset_id: string;
      ended_at: Date | null;
      master_playlist_key: string | null;
      published_version: number;
    }>(
      `SELECT r.id, r.asset_id, r.ended_at, a.master_playlist_key, a.published_version
       FROM rooms r JOIN assets a ON a.id = r.asset_id WHERE r.id = $1`,
      [roomId],
    );
    if (!room.rows[0] || room.rows[0].ended_at || !room.rows[0].master_playlist_key) {
      return reply.code(404).send({ error: "not_found", message: "Room unavailable" });
    }
    if (!user && !body.inviteToken) {
      return reply.code(401).send({ error: "unauthorized", message: "Auth or invite required" });
    }

    // Revoke previous sessions for this participant/room to rotate.
    await query(
      `UPDATE playback_sessions SET revoked_at = now()
       WHERE room_id = $1 AND revoked_at IS NULL AND expires_at > now()
         AND ($2::uuid IS NULL OR participant_id = $2)`,
      [roomId, body.participantId ?? null],
    );

    const pathPrefix = `assets/${room.rows[0].asset_id}/v${room.rows[0].published_version}/`;
    const exp = Math.floor(Date.now() / 1000) + 15 * 60;
    const sid = randomToken(16);
    const token = signPlaybackToken({
      sid,
      roomId,
      assetId: room.rows[0].asset_id,
      pathPrefix,
      exp,
    });
    await query(
      `INSERT INTO playback_sessions (id, room_id, asset_id, participant_id, token_hash, path_prefix, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, to_timestamp($7))`,
      [cryptoRandomUuid(), roomId, room.rows[0].asset_id, body.participantId ?? null, sha256(token), pathPrefix, exp],
    );
    reply.setCookie("partmov_playback", token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 15 * 60,
    });
    return {
      playbackSessionId: sid,
      token,
      masterPlaylistUrl: `${env.MEDIA_PUBLIC_BASE}/${room.rows[0].master_playlist_key}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  });

  app.post("/rooms/:id/playback-revoke", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const roomId = (req.params as { id: string }).id;
    const room = await query(`SELECT id FROM rooms WHERE id = $1 AND host_user_id = $2`, [roomId, user.id]);
    if (!room.rows[0]) return reply.code(403).send({ error: "forbidden", message: "Host only" });
    await query(`UPDATE playback_sessions SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL`, [roomId]);
    reply.clearCookie("partmov_playback", { path: "/" });
    return { ok: true };
  });

  app.post("/rooms/:id/end", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
    const roomId = (req.params as { id: string }).id;
    const body = z.object({ reason: z.enum(["ended", "force", "expired"]).default("ended") }).parse(req.body ?? {});
    const room = await query(`SELECT id FROM rooms WHERE id = $1 AND host_user_id = $2`, [roomId, user.id]);
    if (!room.rows[0]) return reply.code(403).send({ error: "forbidden", message: "Host only" });
    await query(
      `UPDATE rooms SET ended_at = now(), end_reason = $2, updated_at = now() WHERE id = $1`,
      [roomId, body.reason],
    );
    await query(`UPDATE playback_sessions SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL`, [roomId]);
    await query(`UPDATE room_invitations SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL`, [roomId]);
    return { ok: true };
  });
}

function cryptoRandomUuid() {
  return globalThis.crypto.randomUUID();
}

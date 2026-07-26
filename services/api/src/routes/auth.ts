import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { rateLimit } from "../lib/redis.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/magic-link", async (req, reply) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    if (!(await rateLimit(`magic:${body.email}`, 5, 3600))) {
      return reply.code(429).send({ error: "rate_limited", message: "Too many magic links" });
    }
    const token = randomToken(24);
    await query(
      `INSERT INTO magic_link_tokens (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')`,
      [body.email.toLowerCase(), sha256(token)],
    );
    // Dev: return token; production would email it.
    return { ok: true, devToken: token, message: "Magic link created (dev returns token)" };
  });

  app.post("/auth/consume", async (req, reply) => {
    const body = z.object({ token: z.string().min(16) }).parse(req.body);
    const hash = sha256(body.token);
    const { rows } = await query<{ email: string; id: string }>(
      `UPDATE magic_link_tokens SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING id, email`,
      [hash],
    );
    if (!rows[0]) return reply.code(401).send({ error: "invalid_token", message: "Invalid or expired link" });

    let user = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [rows[0].email]);
    if (!user.rows[0]) {
      user = await query<{ id: string }>(
        `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
        [rows[0].email, rows[0].email.split("@")[0]],
      );
    }
    const sessionToken = randomToken(32);
    await query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`,
      [user.rows[0].id, sha256(sessionToken)],
    );
    reply.setCookie("partmov_session", sessionToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true, userId: user.rows[0].id };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies.partmov_session;
    if (token) {
      await query(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)]);
    }
    reply.clearCookie("partmov_session", { path: "/" });
    return { ok: true };
  });
}

export async function requireUser(req: { cookies: Record<string, string | undefined> }) {
  const token = req.cookies.partmov_session;
  if (!token) return null;
  const { rows } = await query<{ id: string; email: string; display_name: string }>(
    `SELECT u.id, u.email, u.display_name
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

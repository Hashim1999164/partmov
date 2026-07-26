import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { env } from "./lib/env.js";
import { ensureBuckets } from "./lib/minio.js";
import { redis } from "./lib/redis.js";
import { pool } from "./db/pool.js";
import { authRoutes } from "./routes/auth.js";
import { assetRoutes } from "./routes/assets.js";
import { roomRoutes } from "./routes/rooms.js";
import { mediaRoutes } from "./routes/media.js";
import { startRetentionScheduler } from "./lib/retention.js";
import { measureObjectStorageUsage } from "./lib/storage-quota.js";

async function main() {
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.PUBLIC_APP_URL,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    const status = typeof err === "object" && err && "statusCode" in err ? Number((err as { statusCode: number }).statusCode) : 500;
    reply.code(status >= 400 ? status : 500).send({
      error: status >= 500 ? "internal" : "request_error",
      message: err instanceof Error ? err.message : "Unknown error",
      requestId: req.id,
    });
  });

  app.get("/healthz", async () => ({ ok: true, service: "api" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      if (redis.status !== "ready") await redis.connect();
      await redis.ping();
      return { ok: true };
    } catch (err) {
      reply.code(503);
      return { ok: false, error: String(err) };
    }
  });

  app.get("/api/storage-quota", async (_req, reply) => {
    try {
      const usage = await measureObjectStorageUsage();
      const nearLimit = usage.remainingBytes <= usage.guardBytes;
      return {
        usedBytes: usage.usedBytes,
        limitBytes: usage.limitBytes,
        remainingBytes: usage.remainingBytes,
        guardBytes: usage.guardBytes,
        nearLimit,
        sessionsAllowed: !nearLimit,
        buckets: usage.buckets,
      };
    } catch (err) {
      reply.code(503);
      return { error: "storage_unavailable", message: String(err) };
    }
  });

  app.get("/metrics", async (_req, reply) => {
    // Minimal Prometheus exposition; full OTEL in observability stack.
    const body = [
      "# HELP partmov_api_up API process up",
      "# TYPE partmov_api_up gauge",
      "partmov_api_up 1",
      "",
    ].join("\n");
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return body;
  });

  await app.register(authRoutes, { prefix: "/api" });
  await app.register(assetRoutes, { prefix: "/api" });
  await app.register(roomRoutes, { prefix: "/api" });
  await app.register(mediaRoutes);

  await ensureBuckets();
  try {
    if (redis.status !== "ready") await redis.connect();
  } catch (err) {
    app.log.warn({ err }, "Redis not ready yet — continuing");
  }

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`API listening on :${env.PORT}`);
  startRetentionScheduler();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

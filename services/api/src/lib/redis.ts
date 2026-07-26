import { Redis } from "ioredis";
import { env } from "./env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return n <= limit;
}

export async function setRoomRoute(roomId: string, syncNodeId: string, ttlSec = 3600) {
  await redis.set(`room:route:${roomId}`, syncNodeId, "EX", ttlSec);
}

export async function getRoomRoute(roomId: string) {
  return redis.get(`room:route:${roomId}`);
}

import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function signPlaybackToken(payload: {
  sid: string;
  roomId: string;
  assetId: string;
  pathPrefix: string;
  exp: number;
}): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", env.MEDIA_HMAC_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPlaybackToken(token: string): {
  sid: string;
  roomId: string;
  assetId: string;
  pathPrefix: string;
  exp: number;
} | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", env.MEDIA_HMAC_SECRET).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sid: string;
      roomId: string;
      assetId: string;
      pathPrefix: string;
      exp: number;
    };
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function roomCode(): string {
  const words = ["dusk", "ember", "velvet", "harbor", "lantern", "cedar", "opal", "nova", "atlas", "plume"];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(10 + Math.random() * 89);
  return `${word}-${num}`;
}

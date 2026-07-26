import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ABR_LADDER, authoritativePosition, canControlPlayback, liveAnchor, thresholdsFor } from "@partmov/protocol";

const SECRET = "test-secret";

function signPlaybackToken(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyPlaybackToken(token: string) {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    pathPrefix: string;
    assetId: string;
    exp: number;
  };
}

test("playback token round-trip and path scope", () => {
  const token = signPlaybackToken({
    sid: "s1",
    roomId: "r1",
    assetId: "a1",
    pathPrefix: "assets/a1/v1/",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const payload = verifyPlaybackToken(token);
  assert.ok(payload);
  assert.equal(payload.pathPrefix, "assets/a1/v1/");
  assert.ok("assets/a1/v1/master.m3u8".startsWith(payload.pathPrefix));
  assert.equal("assets/other/v1/master.m3u8".startsWith(payload.pathPrefix), false);
});

test("expired token has past exp (caller must reject)", () => {
  const token = signPlaybackToken({
    sid: "s1",
    roomId: "r1",
    assetId: "a1",
    pathPrefix: "assets/a1/v1/",
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  const payload = verifyPlaybackToken(token);
  assert.ok(payload);
  assert.ok(payload.exp * 1000 < Date.now());
});

test("ABR ladder never upscales conceptually", () => {
  const sourceHeight = 720;
  const rungs = ABR_LADDER.filter((r) => r.height <= sourceHeight);
  assert.deepEqual(
    rungs.map((r) => r.height),
    [360, 540, 720],
  );
});

test("control mode host_only blocks guest seek", () => {
  assert.equal(canControlPlayback("guest", "host_only", "host", "seek"), false);
  assert.equal(canControlPlayback("guest", "host_only", "host", "pause"), true);
  assert.equal(canControlPlayback("host", "host_only", "host", "seek"), true);
});

test("anchor thresholds tighten with strictness", () => {
  assert.ok(thresholdsFor("strict").fineMs < thresholdsFor("normal").fineMs);
  assert.ok(thresholdsFor("normal").fineMs < thresholdsFor("relaxed").fineMs);
});

test("authoritativePosition advances with wall clock while playing", () => {
  const anchor = {
    wallClockMs: 1_000_000,
    positionSec: 120,
    state: "playing" as const,
    rate: 1,
  };
  assert.equal(authoritativePosition(anchor, 1_000_000), 120);
  assert.equal(authoritativePosition(anchor, 1_030_000), 150);
  assert.equal(authoritativePosition({ ...anchor, state: "paused" }, 1_030_000), 120);
  assert.equal(authoritativePosition({ ...anchor, rate: 2 }, 1_015_000), 150);
});

test("liveAnchor re-samples room clock for reconnect catch-up", () => {
  const live = liveAnchor(
    { wallClockMs: 0, positionSec: 10, state: "playing", rate: 1 },
    5_000,
  );
  assert.equal(live.positionSec, 15);
  assert.equal(live.wallClockMs, 5_000);
  assert.equal(live.state, "playing");
});

test("sha256 stable for invite hashing", () => {
  const h = createHash("sha256").update("invite").digest("hex");
  assert.equal(h.length, 64);
});

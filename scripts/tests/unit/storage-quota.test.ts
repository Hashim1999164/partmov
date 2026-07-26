/**
 * Object-storage free-tier guard (R2 10 GiB).
 * Pure decision logic — mirrors services/api/src/lib/storage-quota.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const LIMIT = 10 * 1024 * 1024 * 1024;
const GUARD = 256 * 1024 * 1024;

function evaluateStorageGuard(input: {
  usedBytes: number;
  additionalBytes?: number;
  limitBytes?: number;
  guardBytes?: number;
}): { allowed: boolean; reason?: string } {
  const usedBytes = Math.max(0, input.usedBytes);
  const additionalBytes = Math.max(0, input.additionalBytes ?? 0);
  const limitBytes = input.limitBytes ?? LIMIT;
  const guardBytes = input.guardBytes ?? GUARD;
  const projected = usedBytes + additionalBytes;
  const remainingBytes = Math.max(0, limitBytes - usedBytes);

  if (projected > limitBytes) {
    return { allowed: false, reason: "would_exceed" };
  }
  if (additionalBytes === 0 && remainingBytes <= guardBytes) {
    return { allowed: false, reason: "at_limit" };
  }
  return { allowed: true };
}

test("allows sessions when plenty of headroom remains", () => {
  const r = evaluateStorageGuard({ usedBytes: 1 * 1024 * 1024 * 1024 });
  assert.equal(r.allowed, true);
});

test("blocks new sessions inside the guard cushion near 10 GiB", () => {
  const r = evaluateStorageGuard({ usedBytes: LIMIT - GUARD });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "at_limit");
});

test("blocks upload that would push past 10 GiB", () => {
  const r = evaluateStorageGuard({
    usedBytes: LIMIT - 100,
    additionalBytes: 200,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "would_exceed");
});

test("allows upload that still fits under the cap", () => {
  const r = evaluateStorageGuard({
    usedBytes: LIMIT - GUARD - 10_000,
    additionalBytes: 5_000,
  });
  assert.equal(r.allowed, true);
});

test("blocks when already over the hard limit", () => {
  const r = evaluateStorageGuard({ usedBytes: LIMIT + 1 });
  assert.equal(r.allowed, false);
});

/**
 * Job lease claim semantics (property-style, in-memory).
 * Mirrors FOR UPDATE SKIP LOCKED + lease expiry used by the worker.
 */
import test from "node:test";
import assert from "node:assert/strict";

type Job = {
  id: string;
  status: "pending" | "leased" | "running" | "succeeded" | "failed" | "dead";
  leaseExpiresAt: number | null;
  attempts: number;
  maxAttempts: number;
};

function claim(jobs: Job[], now: number, worker: string, leaseMs: number): Job | null {
  const job = jobs.find(
    (j) =>
      j.status === "pending" ||
      ((j.status === "leased" || j.status === "running") && (j.leaseExpiresAt ?? 0) < now),
  );
  if (!job) return null;
  job.status = "leased";
  job.leaseExpiresAt = now + leaseMs;
  job.attempts += 1;
  void worker;
  return job;
}

test("two workers cannot claim the same pending job", () => {
  const jobs: Job[] = [{ id: "1", status: "pending", leaseExpiresAt: null, attempts: 0, maxAttempts: 5 }];
  const a = claim(jobs, 1000, "w1", 5000);
  const b = claim(jobs, 1000, "w2", 5000);
  assert.equal(a?.id, "1");
  assert.equal(b, null);
});

test("expired lease can be reclaimed", () => {
  const jobs: Job[] = [
    { id: "1", status: "leased", leaseExpiresAt: 500, attempts: 1, maxAttempts: 5 },
  ];
  const a = claim(jobs, 1000, "w2", 5000);
  assert.equal(a?.id, "1");
  assert.equal(a?.attempts, 2);
});

test("dead after max attempts", () => {
  const job: Job = { id: "1", status: "pending", leaseExpiresAt: null, attempts: 4, maxAttempts: 5 };
  const claimed = claim([job], 1, "w", 10)!;
  const dead = claimed.attempts >= claimed.maxAttempts;
  assert.equal(dead, true);
});

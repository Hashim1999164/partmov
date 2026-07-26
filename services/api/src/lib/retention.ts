import { query } from "../db/pool.js";
import { env } from "../lib/env.js";
import { deleteObject } from "../lib/minio.js";
import { invalidateStorageUsageCache } from "../lib/storage-quota.js";

/** Lifecycle: abandon stale uploads; enqueue purge for marked assets. */
export async function runRetentionSweep() {
  await query(
    `UPDATE upload_sessions SET abandoned_at = now()
     WHERE completed_at IS NULL AND abandoned_at IS NULL
       AND created_at < now() - interval '24 hours'`,
  );

  const abandoned = await query<{ id: string; object_key: string; asset_id: string }>(
    `SELECT id, object_key, asset_id FROM upload_sessions
     WHERE abandoned_at IS NOT NULL AND completed_at IS NULL
       AND abandoned_at > now() - interval '7 days'`,
  );
  let deleted = false;
  for (const row of abandoned.rows) {
    try {
      await deleteObject(env.MINIO_BUCKET_ORIGINALS, row.object_key);
      deleted = true;
    } catch {
      /* missing is fine */
    }
    await query(
      `INSERT INTO jobs (kind, asset_id, dedupe_key, status, payload)
       VALUES ('purge', $1, $2, 'pending', '{}'::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [row.asset_id, `purge-abandon:${row.asset_id}`],
    );
  }
  if (deleted) invalidateStorageUsageCache();

  // Expire rooms → revoke playback
  await query(
    `UPDATE rooms SET ended_at = now(), end_reason = 'expired', updated_at = now()
     WHERE ended_at IS NULL AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  await query(
    `UPDATE playback_sessions ps SET revoked_at = now()
     FROM rooms r
     WHERE ps.room_id = r.id AND r.ended_at IS NOT NULL AND ps.revoked_at IS NULL`,
  );
}

export function startRetentionScheduler(intervalMs = 15 * 60 * 1000) {
  const tick = () => {
    void runRetentionSweep().catch((err) => console.error("retention sweep failed", err));
  };
  tick();
  return setInterval(tick, intervalMs);
}

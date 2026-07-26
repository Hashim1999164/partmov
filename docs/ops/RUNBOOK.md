# Partmov Streaming V2 — operations runbook

## Topology

| Role | Process | Notes |
|------|---------|-------|
| App | Fastify API `:8080`, Sync WSS `:8090`, Valkey, Caddy | Session/auth, room mint, playback tokens |
| Media | PostgreSQL 16, PgBouncer, MinIO | Private originals + renditions |
| Transcode | FFmpeg worker(s) | `WORKER_CONCURRENCY` ≤ cores−1 |
| Edge | nginx cache ×2 | Combined egress ≥ 1 Gbps target |

Local: `npm run streaming:deps` then `npm run streaming:stack` (and optionally `streaming:obs`).

## SLOs

- p95 time-to-first-frame (warm edge) < 2.5s
- Rebuffer ratio < 0.5%
- p95 healthy-link drift < 100ms
- Playback success > 99.5%

Dashboards: Grafana `Partmov Streaming SLOs` (compose profile `obs`).

## Backups

### PostgreSQL (nightly)

```bash
pg_dump -Fc "$DATABASE_URL" -f "/backups/partmov-$(date +%F).dump"
# Off-host copy required
```

Restore drill (monthly):

```bash
pg_restore -c -d "$DATABASE_URL" /backups/partmov-YYYY-MM-DD.dump
# Verify: SELECT count(*) FROM assets WHERE status='ready';
```

### MinIO

Enable versioning + site replication to a second region/bucket. Weekly `mc mirror` to cold storage.

Restore drill: fetch one asset prefix `assets/<id>/vN/` and confirm master playlist + segments play through the edge with a fresh playback token.

## Failure modes

| Failure | Expected behavior |
|---------|-------------------|
| Sync process kill | Clients reconnect with exponential backoff; room state checkpointed every 5s |
| PostgreSQL restart | API `/readyz` 503; workers pause claims; no corrupt publishes (atomic DB switch after upload) |
| MinIO delay | Playlist retries (hls.js); edge serves cached segments |
| Edge bandwidth saturate | ABR downswitches per viewer independently; sync timeline unchanged |
| Token expiry mid-segment | Client refreshes ~2 min early via `/playback-refresh`; revoke ends access |
| Upload interrupt | Upload session abandoned; lifecycle sweeper deletes temp originals |

## Retention / purge

- Abandoned uploads: mark after 24h; enqueue `purge` job
- Room end / force / expire: revoke `playback_sessions` + invitations
- Asset delete: enqueue `purge` → delete MinIO originals + `assets/<id>/` renditions → `status=purged`

## Feature flag

Keep `NEXT_PUBLIC_STREAMING_V2=false` on Vercel until load/fault gates pass. Demo catalog + PeerJS P2P remains default.

When enabling: point `NEXT_PUBLIC_API_BASE` / `NEXT_PUBLIC_SYNC_WS` at the App VPS; never put MinIO or FFmpeg on Vercel.

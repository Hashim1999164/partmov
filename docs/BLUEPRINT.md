# Partmov — Product Spec and Technical Architecture

A privacy-first, fully open-source, low-latency co-watching platform for two people.
Version 1.0. This document is the engineering source of truth; the site under `app/` is
its presentation layer.

---

## 1. Product concept

Partmov is a private watch room for exactly two people and exactly one film. A host uploads
or selects a licensed title, sends one expiring invite link, and both people watch with a
single authoritative clock keeping them on the same frame.

The promise is narrow and testable:

- Both viewers see the same frame within tens of milliseconds.
- Playback starts together, on a scheduled timestamp, after both buffers are healthy.
- When one connection stumbles, the platform recovers — invisibly if possible.
- Nothing about the room is public, discoverable, or mined.

Explicit non-goals: public catalogue, discovery, recommendations, watch history, social feed,
group rooms, voice/video calls, DRM for user uploads.

Design test used throughout: if a feature does not make the two people more synchronised,
more private, or more comfortable, it does not ship.

---

## 2. User flow

1. **Sign in** — email in, magic link out, signed session cookie back. No password, no profile.
2. **Add a film** — resumable (tus) upload into a private MinIO bucket; `ffprobe` results shown
   within seconds; transcode job enqueued immediately.
3. **Pipeline prepares the title** — FFmpeg builds three renditions plus an HLS master playlist,
   extracts subtitles to WebVTT, grabs a poster, builds a sprite sheet. The title is playable
   as soon as the lowest rung lands.
4. **Create room + invite** — one room is bound to one asset and one invite link (22-char token,
   expiry, `max_uses = 1`, optional passphrase).
5. **Guest joins** — opens the link, picks a display name, no account required. Both clients
   fetch signed URLs, buffer, and report readiness.
6. **Start together** — host presses play; server schedules `startAt = now + ~400 ms`; both
   clients seek to the same position and unpause on that instant.
7. **Watch, drift, correct** — 1 s heartbeats; gaps close through playback-rate nudges; a stall
   on one side triggers courtesy pause for both (default in a two-person room).
8. **Leave and return** — room keeps position, subtitle, and audio selection. Reopening resumes.

### Room roles

| Role | Rights |
|---|---|
| Host | play, pause, seek, tracks, rate, handover, revoke invite, close room |
| Guest | pause for both, own volume/quality; seek and track changes gated |
| Shared control | room toggle; both hold equal rights, conflicts resolved by monotonic `seq` |
| Handover | host can pass the remote; recorded in the audit trail |

### Interface principles

| Surface | Behaviour |
|---|---|
| Stage | Player fills the viewport, no chrome over the picture; controls fade after 3 idle seconds |
| Status line | Who holds the remote, both-connected state, current sync delta in ms |
| Control strip | Pause for both, timeline with buffered range, subtitle/audio menus, quality, volume |
| Companion rail | Collapsed by default; chat and six reactions; opening shrinks the stage |
| Interstitials | Join/ready/rebuffer/reconnect are quiet lines under the player, never modals |

Palette: background `#0B0A09`, text `#F3EDE4`, accent `#C4A484`, healthy sync `#86AB9D`,
attention `#D9A95C`. Motion: 200 ms control fades, 400 ms rail, no bounce, honours
`prefers-reduced-motion`.

Named features: **start together**, **pause for both**, **rejoin session**,
**continue from last time**, **shared subtitles**.

---

## 3. Recommended open-source stack

| Layer | Choice | Why |
|---|---|---|
| Client | Next.js + React, hls.js | One codebase for desktop and mobile web; hls.js exposes precise position control and buffer telemetry that native HLS hides |
| API | Fastify (TypeScript) | Small, schema-validated, shares types with the client |
| Realtime | `ws` over WSS | Control traffic is a few hundred bytes/s with strict ordering — exactly what one TCP connection is good at |
| Database | PostgreSQL 16 | Metadata, rooms, invites, audit, job queue (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`) |
| Object storage | MinIO | S3 API, self-hosted, private buckets, per-owner prefixes, SSE via KES |
| Media | FFmpeg | Ladder, subtitles, poster, sprites — nothing else needed |
| Edge | Caddy or Nginx | TLS, HTTP/2, media token verification, optional on-disk segment cache |
| Identity | Magic-link sessions | No passwords to leak; Keycloak deferred until SSO is a real requirement |
| Observability | Prometheus, Grafana OSS, Loki, OpenTelemetry | Standard open stack; dashboards track playback, not people |
| Runtime | Docker Compose → Kubernetes | One VPS for MVP; identical images scale out |

### Two decisions stated explicitly

**PostgreSQL alone, or Redis too?** PostgreSQL alone for the MVP. A two-person room produces a
handful of state transitions per hour, and per-second heartbeats are aggregated in memory and
exported as metrics rather than persisted individually. The sync process holds hot room state in
a map and checkpoints to PostgreSQL every 5 seconds and on every transition, so a crash costs at
most 5 seconds of position accuracy. Redis earns its place at exactly one threshold: **more than
one sync node**, where cross-node pub/sub fan-out and shared rate-limit counters become necessary.

**WebSocket or WebRTC?** WebSocket. The realtime channel carries commands, heartbeats, presence,
and chat. Media is never peer-to-peer: both clients pull the same signed HLS segments over HTTPS,
which is what makes ABR and buffer control possible. WebRTC would add ICE, TURN, and codec
negotiation to solve a problem the product does not have. Consequence worth noting: the two
clients may sit on different quality rungs and still be perfectly in sync, because sync is
defined on the media timeline, not the bitstream.

---

## 4. Architecture diagram (text form)

```
                        ┌────────────────────────────────┐
                        │  Browser (host)  Browser(guest)│
                        │  Next.js · hls.js · drift ctrl │
                        └───┬─────────┬──────────┬───────┘
              REST/HTTPS    │         │ WSS      │  HLS GET (signed)
                            ▼         ▼          ▼
                     ┌───────────────────────────────────┐
                     │   Caddy / Nginx  (single TLS door)│
                     │   /api → api    /ws → sync        │
                     │   /media → token gate → MinIO     │
                     │   optional proxy_cache for .m4s   │
                     └───┬───────────┬──────────────┬────┘
                         │           │              │
             ┌───────────▼──┐  ┌─────▼───────┐  ┌───▼──────────┐
             │  API         │  │ Sync svc    │  │ Media gate   │
             │  Fastify     │  │ ws + clock  │  │ HMAC verify  │
             │  stateless   │  │ 1 authority │  │ range proxy  │
             └───┬───┬──────┘  └──┬───────┬──┘  └───┬──────────┘
                 │   │            │       │         │
        SQL      │   │ S3         │ SQL   │ pub/sub │ S3
                 ▼   ▼            ▼       ▼         ▼
        ┌────────────────┐  ┌──────────────┐  ┌──────────────┐
        │ PostgreSQL 16  │  │ Redis        │  │ MinIO        │
        │ metadata,rooms │  │ (scale-out   │  │ originals/   │
        │ invites, jobs, │  │  only: WS    │  │ renditions/  │
        │ audit          │  │  fan-out)    │  │ subs/posters │
        └───────┬────────┘  └──────────────┘  └──────▲───────┘
                │ LISTEN/NOTIFY job wakeup                  │
                ▼                                           │
        ┌────────────────────────┐    reads original,        │
        │ Transcode worker (n)   │────writes renditions──────┘
        │ FFmpeg · probe · VTT   │
        │ poster · sprite sheet  │
        └────────────────────────┘

   Observability side-channel:
     api / sync / worker  ──/metrics──▶ Prometheus ──▶ Grafana
                          ──stdout───▶ Promtail  ──▶ Loki
                          ──OTLP─────▶ OpenTelemetry Collector
```

### Service responsibilities

- **API (Fastify)** — stateless. Auth, room/invite lifecycle, library queries, upload initiation,
  signed URL minting, job enqueueing. Any instance serves any request.
- **Sync service** — the only stateful process. Hot room state, monotonic `seq` assignment,
  canonical position computation, event fan-out, checkpoints to PostgreSQL.
- **Transcode worker** — pulls jobs with `SELECT … FOR UPDATE SKIP LOCKED`, runs FFmpeg, writes
  renditions, updates rows. Interchangeable and restart-safe.
- **Media gate** — validates HMAC token, expiry, room binding, and Range before proxying bytes
  from MinIO. Storage is never directly reachable.
- **Edge proxy** — one TLS front door; path routing, no buffering for video, long WS read
  timeouts, optional disk cache for segments.

### Media pipeline

1. **Accept** — tus resumable upload; client-supplied SHA-256 re-verified server-side.
2. **Probe** — `ffprobe -v error -show_format -show_streams`; reject undecodable, over-long, or
   checksum-mismatched files.
3. **Ladder** — 1080p @ 5.0 Mbit/s, 720p @ 2.8 Mbit/s, 480p @ 1.2 Mbit/s; H.264 high, AAC-LC
   stereo 128 kbit/s; forced keyframes every 2 s so rungs switch at identical boundaries.
4. **Package** — fMP4 HLS, independent init segment per rung, master playlist. DASH can be
   emitted from the same segments later without re-encoding.
5. **Subtitles** — extract each embedded text stream to WebVTT; normalise uploaded SRT the same
   way; force UTF-8 and validate cue timings.
6. **Visuals** — poster from the 10 % mark; sprite sheet of 160×90 tiles every 5 s plus a WebVTT
   thumbnail index.
7. **Publish** — durations, resolutions, bitrates, languages, chapters written in one
   transaction; asset flips to `ready`; waiting rooms notified over WebSocket.

```bash
ffmpeg -i original.mkv \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
    [v1]scale=w=1920:h=1080[v1out]; \
    [v2]scale=w=1280:h=720[v2out]; \
    [v3]scale=w=854:h=480[v3out]" \
  -map "[v1out]" -c:v:0 libx264 -preset veryfast -crf 21 -maxrate 5000k -bufsize 7500k \
  -map "[v2out]" -c:v:1 libx264 -preset veryfast -crf 22 -maxrate 2800k -bufsize 4200k \
  -map "[v3out]" -c:v:2 libx264 -preset veryfast -crf 23 -maxrate 1200k -bufsize 1800k \
  -map a:0 -map a:0 -map a:0 -c:a aac -b:a 128k -ac 2 \
  -x264-params "keyint=48:min-keyint=48:scenecut=0" \
  -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_flags independent_segments \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0,name=1080p v:1,a:1,name=720p v:2,a:2,name=480p" \
  "hls/%v/index.m3u8"

ffmpeg -i original.mkv -map 0:s:0 -c:s webvtt subs/en.vtt
ffmpeg -i original.mkv -vf "fps=1/5,scale=160:90,tile=10x10" -qscale:v 4 sprites/%03d.jpg
```

Keyframe alignment is not optional: `keyint=48` at 24 fps puts an IDR frame on every 2-second
boundary in every rung, enabling invisible rung switching and cheap exact seeks.

### Storage layout

```
partmov-originals/                    # never web-reachable
  u/<user_id>/a/<asset_id>/source.mkv
  u/<user_id>/a/<asset_id>/source.sha256

partmov-renditions/                   # reachable only through the media gate
  a/<asset_id>/master.m3u8
  a/<asset_id>/1080p/init.mp4 + seg-00001.m4s …
  a/<asset_id>/720p/… · 480p/…
  a/<asset_id>/subs/en.vtt
  a/<asset_id>/poster.jpg
  a/<asset_id>/sprites/001.jpg + sprites.vtt
```

Originals are write-once. Renditions are gated, not public. Deletion is a purge job that verifies
an empty prefix. Server-side encryption is on.

---

## 5. Database schema outline

Nine core entities plus a job queue and an audit log. Position is **derived from an anchor**,
never stored as a live value.

```sql
-- identity
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  display_name text not null,
  role text not null default 'user' check (role in ('user','admin')),
  storage_quota_bytes bigint not null default 214748364800,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  deleted_at timestamptz
);

-- library
create type asset_status as enum
  ('uploading','probing','transcoding','ready','failed','deleting');

create table movie_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  origin text not null default 'user_upload' check (origin in ('user_upload','licensed')),
  license_ref text,
  status asset_status not null default 'uploading',
  source_key text not null,
  source_bytes bigint,
  source_sha256 char(64),
  container text,
  duration_ms integer,
  poster_key text,
  sprites_key text,
  chapters jsonb not null default '[]',      -- [{ start_ms, end_ms, title }]
  error_detail text,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  deleted_at timestamptz
);

create table transcode_variants (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references movie_assets(id) on delete cascade,
  name text not null,                        -- '1080p'
  width integer not null, height integer not null,
  bitrate_kbps integer not null,
  video_codec text not null default 'h264',
  audio_codec text not null default 'aac',
  playlist_key text not null,
  segment_duration_ms integer not null default 2000,
  bytes bigint,
  status text not null default 'pending',
  completed_at timestamptz,
  unique (asset_id, name)
);

create table subtitle_tracks (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references movie_assets(id) on delete cascade,
  language text not null,                    -- BCP-47
  label text not null,
  kind text not null default 'subtitles',
  format text not null default 'vtt',
  object_key text not null,
  source text not null check (source in ('extracted','uploaded')),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- the room
create type room_state  as enum ('idle','armed','playing','paused','ended');
create type room_status as enum ('active','closed','expired');

create table rooms (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references movie_assets(id) on delete cascade,
  host_id  uuid not null references users(id) on delete cascade,
  status room_status not null default 'active',
  state  room_state  not null default 'idle',
  anchor_position_ms integer not null default 0,
  anchor_server_ms   bigint  not null default 0,
  rate numeric(4,2) not null default 1.00,
  seq  bigint not null default 0,
  shared_control boolean not null default false,
  courtesy_pause boolean not null default true,
  active_subtitle_track_id uuid references subtitle_tracks(id) on delete set null,
  active_audio_track integer not null default 0,
  resume_position_ms integer not null default 0,
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table room_participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid references users(id) on delete set null,    -- null = link guest
  invitation_link_id uuid,                                 -- FK added below
  display_name text not null,
  role text not null check (role in ('host','guest')),
  connection_state text not null default 'connected'
    check (connection_state in ('connected','reconnecting','offline')),
  is_ready boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (room_id, role) deferrable initially deferred   -- enforces two-person rooms
);

-- access
create table invitation_links (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  created_by uuid not null references users(id) on delete cascade,
  token_hash char(64) not null unique,        -- sha256; plaintext never stored
  passphrase_hash text,                       -- argon2id, optional
  expires_at timestamptz not null,
  max_uses integer not null default 1,
  used_count integer not null default 0,
  first_used_at timestamptz,
  bound_session_id uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on invitation_links (room_id) where revoked_at is null;

alter table room_participants
  add constraint room_participants_invitation_fk
  foreign key (invitation_link_id) references invitation_links(id) on delete set null;

-- operational telemetry
create table playback_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  participant_id uuid not null references room_participants(id) on delete cascade,
  device_type text not null,                 -- desktop | tablet | phone | tv
  user_agent_class text not null,            -- coarse, e.g. 'chromium-130'
  player_version text not null,
  connection_quality text,                   -- good | fair | poor
  current_rung text,
  avg_throughput_kbps integer,
  buffer_ahead_ms integer,
  startup_ms integer,
  rebuffer_count integer not null default 0,
  rebuffer_ms_total integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table sync_heartbeats (
  id bigserial primary key,
  session_id uuid not null references playback_sessions(id) on delete cascade,
  at timestamptz not null default now(),
  local_position_ms integer not null,
  authoritative_position_ms integer not null,
  drift_ms integer not null,
  rtt_ms integer,
  clock_offset_ms integer,
  buffer_ahead_ms integer,
  action_taken text                          -- locked | nudge | seek | rearm
) partition by range (at);                   -- daily partitions, dropped after 7 days

-- work queue and audit
create table jobs (
  id bigserial primary key,
  kind text not null,                        -- probe | transcode | subtitles | sprites | purge
  asset_id uuid references movie_assets(id) on delete cascade,
  payload jsonb not null default '{}',
  state text not null default 'queued' check (state in ('queued','running','done','failed')),
  attempts integer not null default 0,
  last_error text,
  locked_by text, locked_at timestamptz,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid references users(id) on delete set null,
  room_id  uuid references rooms(id) on delete set null,
  asset_id uuid references movie_assets(id) on delete set null,
  action text not null,                      -- invite.created | asset.purged | room.closed …
  detail jsonb not null default '{}'
);
```

### Retention

| Data | Retention | Rationale |
|---|---|---|
| Account email | Until deletion | Only identifier stored |
| Assets and renditions | Until owner deletes | Purge job removes both prefixes |
| Room state | 30 days after last activity | Supports "continue from last time" |
| Chat | Room lifetime, max 7 days | Ephemeral by default |
| Playback sessions | 30 days | Rolled into daily QoE aggregates |
| Sync heartbeats | 7 days | Drift debugging window |
| Audit events | 365 days | Accountability for takedowns |
| Access logs | 14 days | Truncated IPs only |

---

## 6. API outline

### REST

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| POST | `/api/auth/request-link` | public | Magic link; 3/email/15 min, 20/IP/hour |
| POST | `/api/auth/verify` | public | Single-use token → 30-day session cookie |
| POST | `/api/auth/logout` | session | Server-side session revocation |
| POST | `/api/uploads` | session | Creates asset, returns tus endpoint. `{ title, bytes, sha256 }` |
| PATCH | `/api/uploads/:id/complete` | session | Verifies checksum/size, enqueues probe |
| GET | `/api/assets` | session | Library with status and variant readiness |
| GET | `/api/assets/:id` | owner | Variants, subtitles, chapters, progress |
| POST | `/api/assets/:id/subtitles` | owner | SRT/VTT upload, normalised to WebVTT |
| DELETE | `/api/assets/:id` | owner | Soft delete, closes rooms, enqueues purge (202) |
| POST | `/api/rooms` | session | `{ assetId, sharedControl?, courtesyPause?, expiresIn? }` |
| GET | `/api/rooms/:id` | participant | Canonical state snapshot |
| POST | `/api/rooms/:id/invites` | host | `{ expiresIn, maxUses, passphrase? }`; token returned once |
| DELETE | `/api/rooms/:id/invites/:inviteId` | host | Immediate revocation, closes bound sockets |
| POST | `/api/rooms/join` | public + token | `{ token, displayName, passphrase? }` → participant + WS ticket |
| POST | `/api/rooms/:id/close` | host | Ends room, preserves `resume_position_ms` |
| GET | `/api/rooms/:id/playback-urls` | participant | Signed manifest/subtitle/sprite URLs, TTL 120 s |
| POST | `/api/admin/assets/:id/takedown` | admin | Blocks playback, closes rooms, records reason |
| GET | `/api/healthz`, `/api/readyz`, `/metrics` | internal | Liveness, readiness, Prometheus |

REST over GraphQL is deliberate: ~20 stable endpoints, trivially per-endpoint rate limiting and
caching, no query-cost analysis required.

### WebSocket — client to server

| Event | Payload | Notes |
|---|---|---|
| `join_room` | `{ ticket, playerVersion, deviceType }` | 60-second room-scoped JWT |
| `ready_state` | `{ seq, bufferedAheadMs, isReady }` | Start gate |
| `play_requested` | `{ seq, atPositionMs? }` | Host, or either with shared control |
| `pause_requested` | `{ seq }` | Always allowed for both — "pause for both" |
| `seek_requested` | `{ seq, positionMs }` | Host only unless shared control |
| `rate_requested` | `{ seq, rate }` | Host only, 0.75–1.5 in 0.25 steps |
| `track_requested` | `{ seq, subtitleTrackId?, audioTrack? }` | Room-level, both switch together |
| `sync_ping` | `{ t0 }` | 10× in first 3 s, then every 5 s |
| `drift_report` | `{ localPositionMs, bufferedAheadMs, rung, droppedFrames, readyState }` | Every 1 s |
| `chat_send` | `{ body }` | ≤500 chars, 10/10 s |
| `reaction_send` | `{ glyph }` | 6 glyphs, 5/10 s |
| `leave_room` | `{}` | Graceful exit |

### WebSocket — server to client

| Event | Payload | Notes |
|---|---|---|
| `room_joined` | `{ room, participants, you, serverTimeMs, seq }` | Full snapshot on connect and reconnect |
| `participant_status_changed` | `{ participantId, connectionState, isReady, role }` | Presence, readiness, handover |
| `playback_started` | `{ anchorPositionMs, anchorServerMs, rate, seq }` | `anchorServerMs` is the future start instant |
| `playback_paused` | `{ anchorPositionMs, anchorServerMs, byParticipantId, seq }` | Who paused is in the payload |
| `seek_committed` | `{ positionMs, anchorServerMs, state:'armed', seq }` | Triggers re-arm then start handshake |
| `rate_changed` | `{ rate, seq }` | Room rate; correction nudges never broadcast |
| `track_changed` | `{ subtitleTrackId, audioTrack, seq }` | Subtitle change does not re-arm; audio does |
| `sync_pong` | `{ t0, t1, t2, state, anchor…, rate, seq }` | Four-timestamp reply plus state |
| `drift_ack` | `{ authoritativePositionMs, serverTimeMs, advisedAction, seq }` | `locked \| nudge \| seek \| rearm` |
| `buffer_warning` | `{ participantId, bufferedAheadMs }` | Soft "waiting for …" before any pause |
| `command_rejected` | `{ reason, currentState, seq }` | `stale \| forbidden \| invalid \| rate_limited \| room_closed` |
| `playback_urls_expiring` | `{ inMs }` | 30 s before TTL |
| `chat_message` / `reaction` | `{ participantId, body \| glyph, at }` | Fan-out only |
| `room_closed` | `{ reason }` | `host_closed \| expired \| asset_removed \| admin_action` |

### Join and arm sequence

```
client                          server                        postgres
  │  POST /api/rooms/join  ───────▶│ hash token, check expiry/  │
  │   { token, displayName }       │ revoked/used_count/pass ──▶│
  │◀── { participantId, wsTicket } │ insert room_participant     │
  │  WSS join_room { ticket } ────▶│ verify, bind socket         │
  │◀── room_joined { room, you }   │                             │
  │  GET /playback-urls  ─────────▶│ mint HMAC media tokens 120s │
  │◀── { master, subs, sprites }   │                             │
  │  buffer; ready_state ────────▶ │ all ready? startAt=now+400ms│
  │◀── playback_started { startAt }│ checkpoint anchor ─────────▶│
  │  seek + wait + play()          │                             │
  │  drift_report every 1 s ─────▶ │ compute authoritative pos   │
  │◀── drift_ack { advisedAction } │ aggregate into metrics      │
```

### Error semantics

- Commands carry a client-generated `commandId` → retries cannot double-apply.
- Stale `seq` → `command_rejected` with `currentState`, never a blind merge.
- Reconnect → full resync via `room_joined`; no event log to replay.
- `playback_urls_expiring` 30 s before TTL, so a 401 never reaches the buffer.
- Rate limits reject the command, not the socket.
- HTTP envelope: `{ error: { code, message, retryAfterMs? } }`; 401/403/404/409/413/415/429.

---

## 7. Realtime sync design

### Canonical state (anchor, not position)

| Field | Meaning |
|---|---|
| `state` | `idle \| armed \| playing \| paused \| ended`, transitions enumerated server-side |
| `anchor_position_ms` | Media position true at `anchor_server_ms` |
| `anchor_server_ms` | Server monotonic reading captured in the same instruction |
| `rate` | Room rate, default 1.0; client nudges never written here |
| `seq` | Monotonic command counter; older `seq` is discarded |
| `scheduled_start_ms` | Future server time for a start-together transition |

```js
function authoritativePosition(room, nowServerMs) {
  if (room.state !== 'playing') return room.anchorPositionMs;
  return room.anchorPositionMs + (nowServerMs - room.anchorServerMs) * room.rate;
}
```

### Offset estimation

```
client → { sync_ping, t0 }
server → { sync_pong, t0, t1(recv), t2(send), state, anchor…, seq }
client :  t3 = now()

rtt    = (t3 - t0) - (t2 - t1)
offset = ((t1 - t0) + (t2 - t3)) / 2

Keep the 5 lowest-RTT samples from the last 30 s; use their median offset.
Discard samples whose rtt > 2.5× the running median (queueing delay creates
asymmetric paths, which is what poisons naive offset math).
```

Cadence: 10 pings across the first 3 s, then 1 every 5 s. Heartbeat (`drift_report`) every
**1 s**, answered with the authoritative position so a client that missed a broadcast reconciles
within a second. Ping measures clock offset (slow-moving); heartbeat measures media drift
(fast-moving) — conflating them makes the controller chase noise.

### Correction ladder

| Drift | Response | Behaviour |
|---|---|---|
| ≤ 40 ms | locked | Report only |
| 40–250 ms | fine nudge | rate 1.00 ± ≤0.02 until closed |
| 250 ms–1.5 s | coarse nudge | rate 1.00 ± ≤0.05 (below speech perception threshold) |
| 1.5–10 s | silent seek | Seek to authoritative position at the next segment boundary |
| >10 s or explicit seek | re-arm | Pause, seek, refill, report ready, rejoin start handshake |

```js
const LOCK = 40, FINE = 250, COARSE = 1500, REARM = 10_000;

function correct(video, driftMs /* local - authoritative */) {
  const gap = Math.abs(driftMs);
  if (gap <= LOCK)   { setRate(video, 1); return 'locked'; }
  if (gap <= COARSE) {
    const span  = gap <= FINE ? 0.02 : 0.05;
    const nudge = Math.min(span, gap / 4000);   // close over ~4 s, self-damping
    setRate(video, driftMs < 0 ? 1 + nudge : 1 - nudge);
    return 'nudging';
  }
  if (gap <= REARM)  { seekAtSegmentBoundary(video, authoritative()); return 'seeking'; }
  return rearm(video);
}
```

Rate nudging beats seeking because a seek discards the decode pipeline and often the buffer
(200–800 ms of black frames, frequently causing the rebuffer it meant to fix), while a 3 % rate
change closes a 300 ms gap in 10 s with no perceptible artefact.

### Transitions

```
host   → play_requested { seq }
server : verify role/state, all participants ready
server : startAt = now() + max(400 ms, 2 × worst_rtt/2)
server → playback_started { anchorPositionMs, anchorServerMs: startAt, rate, seq }
client : targetLocal = startAt - clockOffset
client : currentTime = anchorPositionMs/1000; wait until targetLocal - 20 ms; play()
client : if the deadline already passed, play() now and let the controller absorb it
```

- `pause_requested` — either participant (pause for both); server anchors and broadcasts who did it.
- `seek_requested` — host only unless shared control; clamps, bumps `seq`, sets `armed`, then the
  start handshake re-runs automatically if the room was playing.
- `rate_changed` — host only; per-device correction layers on top.
- `track_changed` — room state; subtitles do not re-arm, audio does.

### Failure handling

- Missed broadcasts self-heal within one heartbeat (full state in every ack).
- Stale commands rejected with the current state.
- Reconnect: 0.5/1/2/4 s backoff capped at 10 s with ±20 % jitter; full resync on `room_joined`.
- 90-second grace period with a "reconnecting" status rather than eviction; courtesy pause is the
  default for two-person rooms.
- WS ping every 20 s, two missed pongs → offline; 5 s without heartbeats while playing raises
  `participant_status_changed`.
- Sync service restart: load checkpoints, treat rooms as `paused` at last anchor, clients re-arm.

---

## 8. Low-latency strategy

| Parameter | Value | Reasoning |
|---|---|---|
| Segment duration | 2 s | Cheap seeks and quality switches, quick start handshake, sane playlist size |
| Why not 1 s | rejected | Doubles request count/overhead, worse cache efficiency, noisier ABR estimates |
| Why not 6 s | rejected | Re-arm costs up to 6 s; mid-film switches become visible |
| Start gate | ≥3 s buffered on both, or 6 s timeout | Real buffer prevents instant stalls; timeout stops one weak link holding the room |
| Steady-state buffer | 18–24 s ahead | Rides out mobile handovers; irrelevant to accuracy since position is authoritative |
| Rebuffer response | Courtesy pause for both | Correct behaviour in a two-person room |
| ABR | Per-client, independent | Sync lives on the media timeline, so mismatched rungs are fine |
| Weak-link policy | Sticky lower rung 60 s after two stalls | Stops the optimistic climb-and-stall loop |

Delivery: Caddy/Nginx in front of MinIO with an on-disk segment cache is sufficient for two
viewers. A second cache node near the viewers, or a commodity CDN, is a pure optimisation — the
signed media path is cache-friendly, so it can be added with no code change. Nothing in the
protocol requires a CDN.

---

## 9. Privacy and security strategy

| Layer | Mechanism |
|---|---|
| Account | Magic link (single-use, 15 min) + HttpOnly/Secure/SameSite=Lax session, server-revocable |
| Room | Unlisted by construction: no listing endpoint, UUIDv4 ids, 404 for anything unknown |
| Invitation | SHA-256 token hash, 24 h default expiry, `max_uses = 1`, optional argon2id passphrase, live revocation |
| Socket | 60-second room- and role-scoped JWT ticket |
| Media | HMAC URLs, 120 s TTL, signature binds key + room + session + expiry + IP prefix |
| Storage | Per-owner prefixes, SSE via MinIO KES, no anonymous bucket policy |

```
# mint (API)
exp = now + 120s
msg = f"{object_key}|{room_id}|{session_id}|{exp}|{ip_prefix}"
sig = base64url(hmac_sha256(MEDIA_SIGNING_KEY, msg))

# verify (media gate, every segment)
1 exp not passed        2 sig matches        3 session is an active participant
4 room active + asset not taken down        5 ip_prefix matches /24 or /48
6 proxy the byte range from MinIO — never redirect to a storage URL
# two live signing keys (current + previous) so rotation never kills a playing film
```

Presigned S3 URLs are rejected: they are valid to any holder for the whole TTL and cannot be
revoked, whereas a gate re-checks membership, takedown status, and revocation on every request.

**Downloads.** Short-lived, IP-prefix-bound segment URLs stop casual scraping; a determined
participant can still reassemble segments they are authorised to watch. The design states this
rather than pretending otherwise.

**DRM.** Only if a licensor contractually requires it — Widevine/PlayReady with an open-source
packager (Shaka Packager) plus EME. Cost: per-title packaging, browser-specific failure modes,
and loss of fine-grained playback control on some platforms, which is the product's core promise.
Never applied to user uploads.

**Isolation and deletion.** Keys embed owner id; queries scoped by `owner_id`; the gate re-derives
ownership from the room. `DELETE /api/assets/:id` → mark `deleting`, close rooms
(`reason: asset_removed`), revoke invitations, purge worker deletes both prefixes and verifies an
empty listing before writing `asset.purged`. Media backups use `mc mirror --remove` so purges
propagate. Account deletion cascades and leaves only anonymised audit rows.

**Upload safety.** `ffprobe` must find a decodable video stream; container allowlist
(mkv, mp4, mov, webm, avi, ts); size and SHA-256 must match; anything else is deleted. FFmpeg runs
with no network, read-only root, dropped capabilities, memory ceiling, wall-clock timeout, and
protocol whitelisting. Content type comes from probing, never from extension or client MIME;
filenames are regenerated as UUIDs.

**Analytics — playback, not people.**

| Metric | Type | Target |
|---|---|---|
| `partmov_startup_ms` | histogram | p95 < 2.5 s |
| `partmov_rebuffer_ratio` | gauge | < 0.5 % of watch time |
| `partmov_sync_drift_ms` | histogram | p95 < 120 ms, p99 < 400 ms |
| `partmov_room_join_success` | counter pair | > 99 % first-attempt |
| `partmov_rate_nudge_seconds` | counter | proxy for network health |
| `partmov_hard_seek_total` | counter | ≈ 0 |
| `partmov_transcode_duration_ms` | histogram | worker capacity sizing |
| `partmov_ws_reconnects_total` | counter | by reason |

No third-party scripts, no fingerprinting, no cross-site cookies. Access logs keep IP prefixes
for 14 days. Metric labels are bounded — room and user ids are never label values, so dashboards
cannot become a viewing history.

**Threat model.** Defends against link leakage, room enumeration, cross-tenant reads, direct
storage access, casual scraping, and operator over-collection. Does not defend against a
participant recording their own screen, and does not claim to.

---

## 10. Deployment approach

```yaml
services:
  proxy:      # Caddy: TLS, routing, optional segment cache
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy-data:/data"]

  api:        # stateless
    build: ./services/api
    environment: [DATABASE_URL, S3_ENDPOINT, S3_KEY, S3_SECRET, MEDIA_SIGNING_KEY, SESSION_KEY]
    depends_on: [postgres, minio]

  sync:       # single authority for room clocks
    build: ./services/sync
    environment: [DATABASE_URL, SESSION_KEY]
    depends_on: [postgres]

  worker:     # FFmpeg
    build: ./services/worker
    environment: [DATABASE_URL, S3_ENDPOINT, S3_KEY, S3_SECRET]
    deploy: { replicas: 2 }

  postgres:   { image: postgres:16-alpine, volumes: ["pgdata:/var/lib/postgresql/data"] }
  minio:      { image: minio/minio, command: server /data --console-address ":9001" }
  prometheus: { image: prom/prometheus }
  grafana:    { image: grafana/grafana-oss }
  loki:       { image: grafana/loki }

volumes: { pgdata: {}, miniodata: {}, caddy-data: {} }
```

MVP host: 4 vCPU / 8 GB RAM / large disk runs everything including one FFmpeg job at
`veryfast` (roughly 3–6× realtime for the 1080p ladder).

| Growth step | Change |
|---|---|
| A few rooms | Single node, Compose, two workers, no Redis |
| Dozens of rooms | API to 3 replicas; workers to a second machine |
| Hundreds of rooms | Redis for WS fan-out + rate limits; shard rooms across sync nodes by consistent hash of `room_id` |
| Spread-out viewers | Optional cache in front of `/media` (nginx node or commodity CDN) |
| Storage growth | MinIO single-node → distributed erasure-coded set; keys unchanged |

Stateless API servers matter because room membership, position, and metadata live in PostgreSQL
or in the one sync process that owns the room — an API container can die mid-request with nothing
lost. Bandwidth is the first real ceiling: two 1080p viewers ≈ 10 Mbit/s, so a 1 Gbit/s uplink
saturates near 45 concurrent rooms.

### Operations

| Signal | Objective | Severity | Alert when |
|---|---|---|---|
| Room join success | > 99 % | page | < 97 % over 10 min |
| Startup p95 | < 2.5 s | notice | > 4 s for 15 min |
| Rebuffer ratio | < 0.5 % | notice | > 2 % for 15 min |
| Sync drift p95 | < 120 ms | page | > 500 ms for 5 min with active rooms |
| Hard seeks | ≈ 0 | notice | > 5 per room per hour |
| Transcode queue age | < 10 min | notice | oldest job > 30 min |
| API 5xx | < 0.1 % | page | > 1 % for 5 min |
| Storage headroom | > 20 % | notice/page | < 15 % / < 7 % |

Rate limits: magic links 3/email/15 min and 20/IP/hour; joins 5/IP/min, 20/room/hour, room locks
15 min after 10 failures; uploads 2 concurrent per account with quota pre-check; commands
10/10 s per participant; chat 10/10 s, reactions 5/10 s; segment requests capped at ~3× real
bitrate. In-process token buckets for MVP, Redis counters once the API has replicas.

Backups — two stores, two mechanisms, one drill:

```bash
# PostgreSQL, continuous PITR
pgbackrest --stanza=partmov backup --type=incr   # every 15 min, WAL archived continuously
pgbackrest --stanza=partmov backup --type=full   # weekly; retain 14 daily + 8 weekly
# RPO ≈ 5 min, RTO ≈ 15 min

# MinIO, nightly prefix mirror
mc mirror --overwrite --remove local/partmov-originals  offsite/partmov-originals
mc mirror --overwrite --remove local/partmov-renditions offsite/partmov-renditions
# renditions are reproducible from originals — sacrifice them first, never the reverse

# quarterly timed restore drill on a scratch host
# restore DB → mirror originals (verify sha256 on 10 assets) → boot services →
# join a canned room from a saved invite → record wall-clock RTO in the runbook
```

| Failure | Recovery |
|---|---|
| API container dies | Replica takes over; stateless |
| Sync process dies | Restart loads checkpoints; rooms resume paused at last anchor |
| Worker dies mid-transcode | Lock expires after 30 min, retried; output promoted atomically |
| PostgreSQL corruption | pgBackRest PITR; media untouched |
| MinIO disk loss | Restore originals, re-run transcodes to rebuild renditions |
| Whole host loss | Rebuild host, restore both stores, redeploy images; target < 4 h, verified quarterly |

---

## 11. MVP scope

**In:** magic-link accounts; resumable verified upload; three-rung HLS ladder with 2 s fMP4
segments; subtitle extraction/upload to WebVTT; poster, sprites, chapters; unlisted two-person
rooms; hashed expiring single-use invites with optional passphrase; canonical clock with
start-together, pause-for-both, host seek, and rate-nudge correction; reconnect with full resync,
courtesy pause, 90 s grace, re-arm; collapsible chat and six reactions; admin takedown/room
kill/invite revoke/audit view; Prometheus + Grafana + Loki with eight core metrics and two paging
alerts; Compose deployment with Caddy TLS, pgBackRest, and `mc mirror`.

**Out:** group rooms (3+), native apps, DRM, voice/video chat, public catalogue or discovery,
recommendations or watch history.

### Build order (8 weeks, 2 engineers)

| When | Phase | Work |
|---|---|---|
| 1–2 | Foundations | Compose stack, migrations, magic-link auth, verified upload with ffprobe gating |
| 3–4 | Pipeline | PostgreSQL job queue, FFmpeg ladder, subtitles, poster/sprites, atomic publish |
| 5–6 | Room and sync | Canonical clock, offset estimation, heartbeat loop, start-together, drift controller, reconnect |
| 7 | Experience | Room UI, status line, control strip, track menus, companion rail, mobile, reduced motion |
| 8 | Hardening | Rate limits, admin routes, dashboards/alerts, backups + timed restore drill, throttled-network load test |

### Acceptance criteria

1. Two devices on different networks start within 150 ms, measured from player timestamps, 20 runs.
2. Drift p95 < 120 ms over a 2-hour film with one device on throttled mobile conditions.
3. A forced 5-second stall recovers to locked without a hard seek.
4. Killing the sync container mid-film costs < 3 s and no position loss.
5. A revoked invite closes the socket and fails the next segment request within 2 s.
6. Deleting an asset leaves zero objects under both prefixes (verified by listing) plus an audit row.
7. A restore drill reaches a working room join in under 4 hours, timed and recorded.

---

## 12. Future enhancements

| Enhancement | What it involves |
|---|---|
| Shared control by default | Promote the toggle to a first-class mode with intent-based conflict resolution |
| Continue watching across rooms | Per-user, per-asset resume positions |
| Native apps | React Native or thin native shell over the same REST/WS contracts; sync logic ports directly |
| Redis scale-out | Cross-node fan-out, shared rate limits, consistent-hash room sharding |
| Optional edge caching | Cache node near viewers or commodity CDN in front of signed media; zero code change |
| Licensed catalogue | Admin-managed titles, licence refs, territory rules, curated shelf without public discovery |
| AV1 / HEVC rungs | ~30 % bitrate savings for encode time; gate on browser capability |
| Low-latency ambience | Optional whisper audio over WebRTC, strictly separate from media delivery |
| Keycloak | Only if organisations become users and SSO is required |
| Watch-together scheduling | Invites with a start time, calendar file, gentle reminder |

---

## 13. Why this design holds together

Partmov works because it refuses generality: one title per room, two people per room, one
authoritative clock, one delivery protocol. That narrowness is what lets a two-person team hold
drift to tens of milliseconds on commodity hardware, and what keeps the privacy story true —
there is no catalogue to browse, no history to mine, and no third party in the request path.

Every component named here — PostgreSQL, MinIO, FFmpeg, Caddy, Prometheus, Grafana, Loki, Docker
— is free software that runs on a single machine you control, and each is replaceable without
redesigning the system around it.

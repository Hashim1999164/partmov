import type { Metadata } from "next";
import { Callout, Code, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Data model",
  description:
    "Partmov PostgreSQL schema: users, movie assets, transcode variants, subtitle tracks, rooms, participants, playback sessions, sync heartbeats, and invitation links.",
};

const entities = [
  ["User", "Owns assets and rooms", "Minimal by design: id, email (unique, the only PII), display_name, role, created_at, last_seen_at, storage_quota_bytes, deleted_at. No name, no birthday, no avatar upload."],
  ["MovieAsset", "A film in the library", "owner_id, title, source_key, source_bytes, source_sha256, duration_ms, container, status (uploading → probing → transcoding → ready → failed → deleting), poster_key, sprites_key, chapters (jsonb), origin (user_upload | licensed), license_ref, error_detail."],
  ["TranscodeVariant", "One rung of the ladder", "asset_id, name (1080p), width, height, bitrate_kbps, codec, playlist_key, segment_duration_ms, status, bytes. A row appears the moment its rung is publishable."],
  ["SubtitleTrack", "One caption track", "asset_id, language (BCP-47), label, kind (subtitles | captions | forced), format (vtt), object_key, source (extracted | uploaded), is_default."],
  ["Room", "The shared session", "asset_id, host_id, status, state, anchor_position_ms, anchor_server_ms, rate, seq, shared_control, courtesy_pause, active_subtitle_track_id, active_audio_track, last_activity_at, resume_position_ms, expires_at."],
  ["RoomParticipant", "Membership and role", "room_id, user_id (nullable for link guests), display_name, role (host | guest), joined_at, left_at, connection_state, is_ready, invitation_link_id."],
  ["PlaybackSession", "One device attached to a room", "room_id, participant_id, device_type, user_agent_class, player_version, connection_quality, current_rung, avg_throughput_kbps, buffer_ahead_ms, rebuffer_count, rebuffer_ms_total, startup_ms, started_at, ended_at."],
  ["SyncHeartbeat", "Drift telemetry", "session_id, at, local_position_ms, authoritative_position_ms, drift_ms, rtt_ms, clock_offset_ms, buffer_ahead_ms, action_taken. Written as a rolling window, aggregated hourly, then dropped."],
  ["InvitationLink", "The only way in", "room_id, token_hash, created_by, expires_at, max_uses, used_count, passphrase_hash, revoked_at, first_used_at, bound_session_id."],
];

const schema = `-- ---------- identity ----------
create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               citext unique not null,
  display_name        text not null,
  role                text not null default 'user'      -- user | admin
                      check (role in ('user','admin')),
  storage_quota_bytes bigint not null default 214748364800,   -- 200 GiB
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz,
  deleted_at          timestamptz
);

-- ---------- library ----------
create type asset_status as enum
  ('uploading','probing','transcoding','ready','failed','deleting');

create table movie_assets (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references users(id) on delete cascade,
  title          text not null,
  origin         text not null default 'user_upload'
                 check (origin in ('user_upload','licensed')),
  license_ref    text,
  status         asset_status not null default 'uploading',
  source_key     text not null,                 -- partmov-originals/u/<uid>/a/<aid>/source.mkv
  source_bytes   bigint,
  source_sha256  char(64),
  container      text,
  duration_ms    integer,
  poster_key     text,
  sprites_key    text,
  chapters       jsonb not null default '[]',   -- [{ start_ms, end_ms, title }]
  error_detail   text,
  created_at     timestamptz not null default now(),
  ready_at       timestamptz,
  deleted_at     timestamptz
);
create index on movie_assets (owner_id, status);

create table transcode_variants (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null references movie_assets(id) on delete cascade,
  name                text not null,            -- '1080p'
  width               integer not null,
  height              integer not null,
  bitrate_kbps        integer not null,
  video_codec         text not null default 'h264',
  audio_codec         text not null default 'aac',
  playlist_key        text not null,
  segment_duration_ms integer not null default 2000,
  bytes               bigint,
  status              text not null default 'pending',
  completed_at        timestamptz,
  unique (asset_id, name)
);

create table subtitle_tracks (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references movie_assets(id) on delete cascade,
  language    text not null,                    -- BCP-47: 'en', 'pt-BR'
  label       text not null,
  kind        text not null default 'subtitles',
  format      text not null default 'vtt',
  object_key  text not null,
  source      text not null check (source in ('extracted','uploaded')),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------- the room ----------
create type room_state  as enum ('idle','armed','playing','paused','ended');
create type room_status as enum ('active','closed','expired');

create table rooms (
  id                       uuid primary key default gen_random_uuid(),
  asset_id                 uuid not null references movie_assets(id) on delete cascade,
  host_id                  uuid not null references users(id) on delete cascade,
  status                   room_status not null default 'active',
  state                    room_state  not null default 'idle',
  -- authoritative clock: position is derived, never polled-and-written
  anchor_position_ms       integer not null default 0,
  anchor_server_ms         bigint  not null default 0,
  rate                     numeric(4,2) not null default 1.00,
  seq                      bigint not null default 0,
  shared_control           boolean not null default false,
  courtesy_pause           boolean not null default true,
  active_subtitle_track_id uuid references subtitle_tracks(id) on delete set null,
  active_audio_track       integer not null default 0,
  resume_position_ms       integer not null default 0,   -- 'continue from last time'
  last_activity_at         timestamptz not null default now(),
  expires_at               timestamptz,
  created_at               timestamptz not null default now(),
  closed_at                timestamptz
);
create index on rooms (host_id, status);
create index on rooms (status, last_activity_at);

create table room_participants (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references rooms(id) on delete cascade,
  user_id            uuid references users(id) on delete set null,  -- null = link guest
  invitation_link_id uuid,                                       -- FK added after invitation_links
  display_name       text not null,
  role               text not null check (role in ('host','guest')),
  connection_state   text not null default 'connected'
                     check (connection_state in ('connected','reconnecting','offline')),
  is_ready           boolean not null default false,
  joined_at          timestamptz not null default now(),
  left_at            timestamptz,
  -- a two-person room means exactly one guest slot
  unique (room_id, role) deferrable initially deferred
);

-- ---------- access ----------
create table invitation_links (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references rooms(id) on delete cascade,
  created_by      uuid not null references users(id) on delete cascade,
  token_hash      char(64) not null unique,     -- sha256 of the token; plaintext never stored
  passphrase_hash text,                         -- argon2id, optional second factor
  expires_at      timestamptz not null,
  max_uses        integer not null default 1,
  used_count      integer not null default 0,
  first_used_at   timestamptz,
  bound_session_id uuid,                        -- pins the link to the first device that used it
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index on invitation_links (room_id) where revoked_at is null;

alter table room_participants
  add constraint room_participants_invitation_fk
  foreign key (invitation_link_id) references invitation_links(id) on delete set null;

-- ---------- telemetry (operational only) ----------
create table playback_sessions (
  id                  uuid primary key default gen_random_uuid(),
  room_id             uuid not null references rooms(id) on delete cascade,
  participant_id      uuid not null references room_participants(id) on delete cascade,
  device_type         text not null,            -- desktop | tablet | phone | tv
  user_agent_class    text not null,            -- 'chromium-130', coarse on purpose
  player_version      text not null,
  connection_quality  text,                     -- good | fair | poor, derived
  current_rung        text,
  avg_throughput_kbps integer,
  buffer_ahead_ms     integer,
  startup_ms          integer,
  rebuffer_count      integer not null default 0,
  rebuffer_ms_total   integer not null default 0,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz
);

create table sync_heartbeats (
  id                       bigserial primary key,
  session_id               uuid not null references playback_sessions(id) on delete cascade,
  at                       timestamptz not null default now(),
  local_position_ms        integer not null,
  authoritative_position_ms integer not null,
  drift_ms                 integer not null,
  rtt_ms                   integer,
  clock_offset_ms          integer,
  buffer_ahead_ms          integer,
  action_taken             text     -- locked | nudge | seek | rearm
) partition by range (at);          -- daily partitions, dropped after 7 days

-- ---------- work queue and audit ----------
create table jobs (
  id            bigserial primary key,
  kind          text not null,       -- probe | transcode | subtitles | sprites | purge
  asset_id      uuid references movie_assets(id) on delete cascade,
  payload       jsonb not null default '{}',
  state         text not null default 'queued'
                check (state in ('queued','running','done','failed')),
  attempts      integer not null default 0,
  last_error    text,
  locked_by     text,
  locked_at     timestamptz,
  run_after     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index on jobs (state, run_after);

create table audit_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor_id   uuid references users(id) on delete set null,
  room_id    uuid references rooms(id) on delete set null,
  asset_id   uuid references movie_assets(id) on delete set null,
  action     text not null,      -- invite.created | invite.revoked | room.closed | asset.purged …
  detail     jsonb not null default '{}'
);`;

export default function DataPage() {
  return (
    <>
      <PageHead
        eyebrow="Data model"
        title="Nine entities, one authoritative clock"
        lede="The schema is shaped by three requirements: derive playback position rather than store it, make access revocable at the row level, and keep personal data thin enough that a breach is boring."
      />

      <Section eyebrow="Entities" title="What each table is for" flush>
        <Table head={["Entity", "Purpose", "Fields that matter"]} rows={entities} />
      </Section>

      <Section
        eyebrow="Design notes"
        title="Three decisions embedded in the schema"
      >
        <List
          items={[
            <>
              <strong>Anchor, not position.</strong> <code>rooms.anchor_position_ms</code> plus{" "}
              <code>anchor_server_ms</code> and <code>rate</code> reconstruct the exact playback position at any
              instant. Storing a live position would mean writing to the same row many times per second and
              still being wrong between writes.
            </>,
            <>
              <strong>Tokens are hashed.</strong> <code>invitation_links.token_hash</code> holds a SHA-256 of the
              link secret, so a database dump does not hand over working invitations, exactly as with password
              hashes.
            </>,
            <>
              <strong>Heartbeats are partitioned and disposable.</strong> <code>sync_heartbeats</code> is a daily
              range partition that is aggregated into Prometheus histograms and dropped after seven days. It
              exists to debug drift, not to build a viewing history.
            </>,
            <>
              <strong>Guests need no account.</strong> <code>room_participants.user_id</code> is nullable; a link
              guest is identified only by a display name and the invitation row that admitted them.
            </>,
            <>
              <strong>The job queue is a table.</strong> <code>SELECT … FOR UPDATE SKIP LOCKED</code> with{" "}
              <code>LISTEN/NOTIFY</code> wakeups gives multi-worker, crash-safe queueing without a broker at this
              scale.
            </>,
          ]}
        />
      </Section>

      <Section
        eyebrow="Schema"
        title="PostgreSQL DDL"
        lede="Abridged to the fields that carry meaning for sync, security, and auditing. Timestamps are timestamptz throughout; identifiers are UUIDv4 so they can be generated client-side during uploads."
      >
        <div className="stack stack--md">
          <Code label="schema.sql">{schema}</Code>
          <Callout>
            <code>room_participants</code> declares <code>unique (room_id, role)</code>, which is how the
            two-person constraint is enforced by the database rather than by application checks. Group watch
            would begin by relaxing exactly this line.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Retention"
        title="What is kept, and for how long"
      >
        <Table
          head={["Data", "Retention", "Rationale"]}
          rows={[
            ["Account email", "Until account deletion", "Needed to send the sign-in link. The only identifier stored."],
            ["Assets and renditions", "Until the owner deletes them", "Deletion enqueues a purge job that removes both object prefixes and writes an audit row."],
            ["Room state", "30 days after last activity", "Supports 'continue from last time', then the room is expired and its invites are dead."],
            ["Chat messages", "Room lifetime, 7 days maximum", "Ephemeral by default; a room can be set to keep nothing at all."],
            ["Playback sessions", "30 days", "Rolled up into daily quality-of-experience aggregates, then deleted."],
            ["Sync heartbeats", "7 days", "Debugging window for drift regressions."],
            ["Audit events", "365 days", "Security and takedown accountability; contains actions, not viewing content."],
            ["Access logs", "14 days", "Truncated IP addresses only (last octet zeroed), for abuse investigation."],
          ]}
        />
      </Section>

      <Pager current="/data" />
    </>
  );
}

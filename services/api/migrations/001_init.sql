-- Partmov Streaming V2 schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  storage_quota_bytes BIGINT NOT NULL DEFAULT 53687091200,
  storage_used_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE magic_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading','probing','queued','transcoding','ready','failed','purged')),
  original_key TEXT,
  source_fingerprint TEXT,
  encoder_version TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  fps NUMERIC(8,3),
  has_audio BOOLEAN NOT NULL DEFAULT false,
  master_playlist_key TEXT,
  poster_key TEXT,
  sprite_key TEXT,
  error_message TEXT,
  published_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purged_at TIMESTAMPTZ
);

CREATE INDEX assets_owner_idx ON assets(owner_id);
CREATE INDEX assets_status_idx ON assets(status);

CREATE TABLE asset_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  height INTEGER NOT NULL,
  bandwidth INTEGER NOT NULL,
  video_bitrate_kbps INTEGER NOT NULL,
  playlist_key TEXT NOT NULL,
  init_segment_key TEXT,
  codecs TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, height)
);

CREATE TABLE asset_audio_tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  track_index INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  label TEXT NOT NULL,
  channels INTEGER NOT NULL DEFAULT 2,
  UNIQUE (asset_id, track_index)
);

CREATE TABLE asset_subtitles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'und',
  label TEXT NOT NULL,
  vtt_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id),
  tus_upload_id TEXT UNIQUE,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  bytes_received BIGINT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('probe','transcode','poster','sprites','subtitles','purge')),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','running','succeeded','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX jobs_claim_idx ON jobs(status, lease_expires_at, created_at);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  asset_id UUID REFERENCES assets(id),
  title TEXT NOT NULL DEFAULT '',
  host_user_id UUID REFERENCES users(id),
  control_mode TEXT NOT NULL DEFAULT 'host_only',
  remote_holder TEXT NOT NULL DEFAULT 'host',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  anchor_wall_clock_ms BIGINT,
  anchor_position_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  anchor_state TEXT NOT NULL DEFAULT 'paused',
  anchor_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
  command_seq BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  display_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#C4A484',
  role TEXT NOT NULL CHECK (role IN ('host','guest')),
  invitation_id UUID,
  connection_state TEXT NOT NULL DEFAULT 'disconnected',
  is_ready BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX room_one_host ON room_participants(room_id) WHERE role = 'host' AND left_at IS NULL;

CREATE TABLE room_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  passphrase_hash TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE playback_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id),
  participant_id UUID REFERENCES room_participants(id),
  token_hash TEXT NOT NULL UNIQUE,
  path_prefix TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX playback_sessions_lookup ON playback_sessions(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE qoe_aggregates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
  asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  startup_ms_p50 INTEGER,
  startup_ms_p95 INTEGER,
  rebuffer_ratio DOUBLE PRECISION,
  avg_bitrate_kbps INTEGER,
  drift_ms_p95 INTEGER,
  samples INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  room_id UUID REFERENCES rooms(id),
  asset_id UUID REFERENCES assets(id),
  action TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION notify_jobs() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('jobs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_jobs();

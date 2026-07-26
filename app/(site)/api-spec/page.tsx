import type { Metadata } from "next";
import { Callout, Code, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "API",
  description:
    "Partmov API surface: REST endpoints for uploads, library, rooms and invites, plus the full WebSocket event protocol with error handling for disconnects and stale commands.",
};

const rest = [
  ["POST", "/api/auth/request-link", "public", "Email in, magic link out. Rate limited to 3 per address per 15 minutes and 20 per IP per hour."],
  ["POST", "/api/auth/verify", "public", "Exchanges a single-use token for an HttpOnly, Secure, SameSite=Lax session cookie valid for 30 days."],
  ["POST", "/api/auth/logout", "session", "Revokes the session server-side, not just the cookie."],
  ["POST", "/api/uploads", "session", "Creates an asset row in state uploading and returns a tus endpoint plus the expected max size. Body: { title, bytes, sha256 }."],
  ["PATCH", "/api/uploads/:id/complete", "session", "Verifies checksum and size, then enqueues probe. Rejects on mismatch and deletes the partial object."],
  ["GET", "/api/assets", "session", "The caller's library. Returns status, duration, poster URL, variant readiness, subtitle languages."],
  ["GET", "/api/assets/:id", "owner", "Full detail including variants, subtitle tracks, chapters, and transcode progress."],
  ["POST", "/api/assets/:id/subtitles", "owner", "Uploads an SRT or VTT file; server normalises to WebVTT and validates cue timings."],
  ["DELETE", "/api/assets/:id", "owner", "Soft-deletes, closes dependent rooms, enqueues a purge job. Returns 202 with the purge job id."],
  ["POST", "/api/rooms", "session", "Creates a room bound to one asset. Body: { assetId, sharedControl?, courtesyPause?, expiresIn? }."],
  ["GET", "/api/rooms/:id", "participant", "Canonical room state snapshot: state, anchor, rate, seq, participants, active tracks."],
  ["POST", "/api/rooms/:id/invites", "host", "Mints an invitation link. Body: { expiresIn, maxUses, passphrase? }. Returns the plaintext token exactly once."],
  ["DELETE", "/api/rooms/:id/invites/:inviteId", "host", "Revokes immediately; any socket authenticated by that invite is closed."],
  ["POST", "/api/rooms/join", "public + token", "Body: { token, displayName, passphrase? }. Returns a participant session and a WebSocket ticket."],
  ["POST", "/api/rooms/:id/close", "host", "Ends the room, disconnects participants, preserves resume_position_ms."],
  ["GET", "/api/rooms/:id/playback-urls", "participant", "Returns short-lived signed URLs for the master playlist, subtitle tracks, and sprite index. TTL 120 s, refreshed by the client on a timer."],
  ["POST", "/api/admin/assets/:id/takedown", "admin", "Blocks playback, closes rooms, and marks the asset for purge with a reason recorded in the audit log."],
  ["GET", "/api/healthz · /api/readyz · /metrics", "internal", "Liveness, readiness, and Prometheus exposition. /metrics is bound to the internal network only."],
];

const clientEvents = [
  ["join_room", "{ ticket, playerVersion, deviceType }", "First frame after the socket opens. The ticket is a short-lived JWT minted by /rooms/join."],
  ["ready_state", "{ seq, bufferedAheadMs, isReady }", "Reports the start gate. The server will not schedule playback until all participants are ready or the 6 s timeout fires."],
  ["play_requested", "{ seq, atPositionMs? }", "Host, or either participant with shared control."],
  ["pause_requested", "{ seq }", "Always allowed for both participants — this is 'pause for both'."],
  ["seek_requested", "{ seq, positionMs }", "Host only unless shared control is on. Server clamps and re-arms."],
  ["rate_requested", "{ seq, rate }", "Host only. 0.75 to 1.5 in 0.25 steps."],
  ["track_requested", "{ seq, subtitleTrackId?, audioTrack? }", "Subtitle and audio selection are room state, so both clients switch together."],
  ["sync_ping", "{ t0 }", "Clock offset probe. Ten times in the first 3 s, then every 5 s."],
  ["drift_report", "{ localPositionMs, bufferedAheadMs, rung, droppedFrames, readyState }", "Every 1 s while attached. Doubles as the application-level heartbeat."],
  ["chat_send", "{ body }", "Max 500 characters, 10 messages per 10 seconds per participant."],
  ["reaction_send", "{ glyph }", "One of six glyphs, 5 per 10 seconds."],
  ["leave_room", "{}", "Graceful exit so the other viewer sees 'left' rather than 'reconnecting'."],
];

const serverEvents = [
  ["room_joined", "{ room, participants, you, serverTimeMs, seq }", "Full snapshot. Sent on connect and on every reconnect, which is why a client never needs to replay missed events."],
  ["participant_status_changed", "{ participantId, connectionState, isReady, role }", "Presence, readiness, and remote handover all surface through this one event."],
  ["playback_started", "{ anchorPositionMs, anchorServerMs, rate, seq }", "anchorServerMs is in the future: the scheduled start-together instant."],
  ["playback_paused", "{ anchorPositionMs, anchorServerMs, byParticipantId, seq }", "Who paused is part of the payload so the status line can say so."],
  ["seek_committed", "{ positionMs, anchorServerMs, state: 'armed', seq }", "Clients seek, refill, and report ready; the server then re-runs the start handshake if the room was playing."],
  ["rate_changed", "{ rate, seq }", "Room-level rate. Per-device correction nudges are never broadcast."],
  ["track_changed", "{ subtitleTrackId, audioTrack, seq }", "Subtitle changes do not re-arm playback; audio changes do."],
  ["sync_pong", "{ t0, t1, t2, state, anchorPositionMs, anchorServerMs, rate, seq }", "The four-timestamp reply plus canonical state."],
  ["drift_ack", "{ authoritativePositionMs, serverTimeMs, advisedAction, seq }", "Answer to every heartbeat. advisedAction is locked, nudge, seek, or rearm — the server's opinion, which the client is free to satisfy more gently."],
  ["buffer_warning", "{ participantId, bufferedAheadMs }", "One participant is running dry; the UI shows a soft 'waiting for Ayla' line before any pause happens."],
  ["command_rejected", "{ reason, currentState, seq }", "reason ∈ stale | forbidden | invalid | rate_limited | room_closed. Always carries the current state so the client can reconcile without a refetch."],
  ["playback_urls_expiring", "{ inMs }", "Prompts the client to refresh signed URLs before a segment request can 401."],
  ["chat_message · reaction", "{ participantId, body | glyph, at }", "Fan-out only; nothing is persisted beyond the room's retention setting."],
  ["room_closed", "{ reason }", "reason ∈ host_closed | expired | asset_removed | admin_action. Client shows a calm end card."],
];

const joinSequence = `client                          server                        postgres
  │  POST /api/rooms/join  ───────▶│                              │
  │   { token, displayName }       │ hash token, check expiry,    │
  │                                │ revoked_at, used_count,      │
  │                                │ passphrase ─────────────────▶│
  │                                │◀── invitation + room ────────│
  │◀── { participantId, wsTicket } │ insert room_participant       │
  │                                │                              │
  │  WSS  join_room { ticket } ───▶│ verify ticket signature,      │
  │                                │ bind socket to room + role    │
  │◀── room_joined { room, you }   │                              │
  │                                │                              │
  │  GET /playback-urls  ─────────▶│ mint HMAC media tokens (120s) │
  │◀── { master, subs, sprites }   │                              │
  │                                │                              │
  │  hls.js loads master, buffers  │                              │
  │  ready_state { isReady:true }─▶│ all ready?                    │
  │                                │ startAt = now + 400 ms        │
  │◀── playback_started { startAt }│ checkpoint anchor ───────────▶│
  │  seek + wait + play()          │                              │
  │                                │                              │
  │  drift_report (every 1 s) ────▶│ compute authoritative pos     │
  │◀── drift_ack { advisedAction } │ aggregate into metrics        │`;

export default function ApiPage() {
  return (
    <>
      <PageHead
        eyebrow="API and events"
        title="A small REST surface and one ordered channel"
        lede="REST handles everything that is a request with an answer. The WebSocket handles everything that is a shared fact changing over time. No feature is split across both."
      />

      <Section eyebrow="REST" title="HTTP endpoints" flush>
        <div className="stack stack--md">
          <Table
            head={["Method", "Path", "Auth", "Behaviour"]}
            rows={rest.map(([m, p, a, b]) => [<code key={p}>{m}</code>, <code key={`${p}-p`}>{p}</code>, a, b])}
          />
          <Callout>
            REST is chosen over GraphQL deliberately: the surface is roughly twenty endpoints, the response
            shapes are stable, and per-endpoint rate limiting and cache headers are trivial to reason about.
            GraphQL&rsquo;s flexibility would buy nothing and cost query-cost analysis.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Realtime"
        title="Client to server"
        lede="Every command carries the seq the client believes is current. That single field is what makes stale-intent rejection possible."
      >
        <Table head={["Event", "Payload", "Notes"]} rows={clientEvents.map(([e, p, n]) => [<code key={e}>{e}</code>, <code key={`${e}-p`}>{p}</code>, n])} />
      </Section>

      <Section eyebrow="Realtime" title="Server to client">
        <Table head={["Event", "Payload", "Notes"]} rows={serverEvents.map(([e, p, n]) => [<code key={e}>{e}</code>, <code key={`${e}-p`}>{p}</code>, n])} />
      </Section>

      <Section
        eyebrow="Sequence"
        title="Join to synchronised playback"
        lede="The full handshake, from opening an invite link to the steady-state heartbeat loop."
      >
        <Code label="Join and arm sequence">{joinSequence}</Code>
      </Section>

      <Section
        eyebrow="Errors"
        title="Failure semantics that clients can rely on"
      >
        <div className="stack stack--md">
          <List
            items={[
              <>
                <strong>Idempotent commands.</strong> Every command includes a client-generated{" "}
                <code>commandId</code>; retrying after a timeout cannot double-apply a seek.
              </>,
              <>
                <strong>Stale rejection over silent merge.</strong> A command whose <code>seq</code> is behind the
                room gets <code>command_rejected</code> with the current state rather than being applied on top
                of a world that has already moved.
              </>,
              <>
                <strong>Reconnect is a full resync.</strong> <code>room_joined</code> always carries complete
                state. There is no event log to replay and no gap window to reason about.
              </>,
              <>
                <strong>Signed URL expiry never interrupts playback.</strong>{" "}
                <code>playback_urls_expiring</code> arrives 30 seconds before the TTL, and hls.js is given
                refreshed URLs through its loader before a 401 can reach the buffer.
              </>,
              <>
                <strong>Rate limits are explicit.</strong> Exceeding a limit yields{" "}
                <code>command_rejected {"{"} reason: &quot;rate_limited&quot; {"}"}</code> with a retry hint; the
                socket is not dropped, because dropping it would look like a network fault to the user.
              </>,
              <>
                <strong>HTTP error shape.</strong> A single envelope,{" "}
                <code>{"{ error: { code, message, retryAfterMs? } }"}</code>, with 401 for no session, 403 for
                wrong role, 404 for anything the caller may not know exists, 409 for state conflicts, 413 for
                oversized uploads, 415 for rejected containers, and 429 for rate limits.
              </>,
            ]}
          />
          <Code label="Example: rejected seek from a guest without shared control">{`→ { "type": "seek_requested", "seq": 41, "positionMs": 3_600_000,
    "commandId": "01J8Z…" }

← { "type": "command_rejected",
    "reason": "forbidden",
    "message": "Only the host can seek while shared control is off",
    "currentState": { "state": "playing", "anchorPositionMs": 2_881_400,
                      "anchorServerMs": 1761500412345, "rate": 1, "seq": 41 } }`}</Code>
        </div>
      </Section>

      <Pager current="/api-spec" />
    </>
  );
}

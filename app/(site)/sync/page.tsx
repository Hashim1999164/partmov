import type { Metadata } from "next";
import { SyncVisual } from "@/components/SyncVisual";
import { Callout, Code, KeyValues, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Sync",
  description:
    "Partmov synchronisation design: canonical room clock, offset estimation, heartbeat cadence, invisible drift correction, buffering strategy, and disconnect recovery.",
};

const clockFields = [
  { k: "state", v: "idle · armed · playing · paused · ended — the only legal transitions are enumerated server-side." },
  { k: "anchor_position_ms", v: "The media position that was true at anchor_server_ms." },
  { k: "anchor_server_ms", v: "Server monotonic clock reading captured in the same instruction as the position." },
  { k: "rate", v: "Room playback rate, default 1.0. Client-side correction nudges are never written here." },
  { k: "seq", v: "Monotonic command counter. Any command carrying an older seq than the room's current value is discarded." },
  { k: "scheduled_start_ms", v: "For a start-together transition: the future server time at which playback must begin." },
];

const thresholds = [
  ["|drift| ≤ 40 ms", "Locked", "Do nothing. Report the value for metrics only."],
  ["40 ms – 250 ms", "Fine nudge", "Set rate to 1.00 ± up to 0.02 until the gap closes, then release to 1.0."],
  ["250 ms – 1.5 s", "Coarse nudge", "Set rate to 1.00 ± up to 0.05, which stays below the pitch-shift and lip-sync perception threshold for speech."],
  ["1.5 s – 10 s", "Silent seek", "Seek to the authoritative position, keep playing. Prefer executing at the next segment boundary so the buffer is not discarded."],
  ["> 10 s or after an explicit seek", "Re-arm", "Pause locally, seek, refill the buffer, report ready, and rejoin the start-together handshake."],
];

export default function SyncPage() {
  return (
    <>
      <PageHead
        eyebrow="Realtime sync"
        title="One authoritative clock, two obedient players"
        lede="Synchronisation is the product. This page specifies exactly what the server stores, how often clients speak, how offset is computed, and what a client is allowed to do about a gap."
      />

      <Section eyebrow="Live model" title="The correction loop, running" flush>
        <div className="stack stack--md">
          <SyncVisual />
          <p className="prose">
            The guest above periodically stalls, falls behind, and closes the gap by playing marginally faster.
            No seek occurs, no audio artefact is audible, and the status line never needs to apologise. That is
            the behaviour the rest of this page defines.
          </p>
        </div>
      </Section>

      <Section
        eyebrow="Canonical state"
        title="What the server considers true"
        lede="A room's playback state is stored as an anchor plus a rate, never as a continuously updated position. Position is always derived, which removes an entire class of write-contention bugs."
      >
        <div className="stack stack--md">
          <KeyValues items={clockFields} />
          <Code label="Deriving the authoritative position">{`function authoritativePosition(room, nowServerMs) {
  if (room.state !== 'playing') return room.anchorPositionMs;
  const elapsed = nowServerMs - room.anchorServerMs;
  return room.anchorPositionMs + elapsed * room.rate;
}

// every transition rewrites the anchor atomically
function applyPause(room, nowServerMs) {
  room.anchorPositionMs = authoritativePosition(room, nowServerMs);
  room.anchorServerMs   = nowServerMs;
  room.state            = 'paused';
  room.seq             += 1;
}`}</Code>
        </div>
      </Section>

      <Section
        eyebrow="Offset estimation"
        title="Measuring the gap between two clocks"
        lede="Before a client can judge its own drift, it needs to know how far its clock sits from the server's. Partmov uses the NTP-style four-timestamp exchange, filtered for jitter."
      >
        <div className="stack stack--md">
          <Code label="sync_ping / sync_pong">{`client → { type: "sync_ping", t0: <client monotonic ms> }
server → { type: "sync_pong", t0, t1: <server recv>, t2: <server send>,
           state, anchorPositionMs, anchorServerMs, rate, seq }
client:  t3 = now()

rtt    = (t3 - t0) - (t2 - t1)
offset = ((t1 - t0) + (t2 - t3)) / 2      // add offset to client clock → server clock

// keep the 5 lowest-RTT samples from the last 30 s; use their median offset.
// discard any sample whose rtt exceeds 2.5x the running median — that is queueing delay,
// and asymmetric delay is what poisons naive offset math.`}</Code>
          <List
            items={[
              <>
                <strong>Cadence.</strong> Ten pings over the first 3 seconds after joining to converge quickly,
                then one ping every 5 seconds in steady state. That is 12 messages a minute per client, which is
                free.
              </>,
              <>
                <strong>Heartbeat.</strong> Separately, every <code>1 s</code> the client emits a{" "}
                <code>drift_report</code> with its local position, buffered-ahead milliseconds, current rung,
                dropped frames, and readyState. The server replies with the authoritative position so the client
                can correct even if it missed a broadcast.
              </>,
              <>
                <strong>Why both.</strong> Ping measures clock offset, which changes slowly. Heartbeat measures
                media drift, which changes constantly. Conflating them makes the controller chase network noise.
              </>,
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow="Correction"
        title="A ladder of increasingly visible responses"
        lede="The controller always picks the least visible action that can close the gap, and it hysteresis-locks so it never oscillates between two remedies."
      >
        <div className="stack stack--md">
          <Table head={["Measured drift", "Response", "Client behaviour"]} rows={thresholds} />
          <Code label="The client-side controller">{`const LOCK = 40, FINE = 250, COARSE = 1500, REARM = 10_000;

function correct(video, driftMs /* local - authoritative */) {
  const gap = Math.abs(driftMs);

  if (gap <= LOCK) { setRate(video, 1); return 'locked'; }

  if (gap <= COARSE) {
    const span  = gap <= FINE ? 0.02 : 0.05;
    // close the gap over ~4 s rather than instantly: gentler and self-damping
    const nudge = Math.min(span, gap / 4000);
    setRate(video, driftMs < 0 ? 1 + nudge : 1 - nudge);
    return 'nudging';
  }

  if (gap <= REARM) { seekAtSegmentBoundary(video, authoritative()); return 'seeking'; }

  return rearm(video);   // pause, seek, refill, report ready, rejoin start handshake
}

// setRate never touches room state: the room's rate stays 1.0 and only this
// device's decoder runs marginally fast or slow. Audio uses the browser's
// pitch-preserving resampler, so ±5% is inaudible on dialogue.`}</Code>
          <Callout>
            <strong>Why rate nudging rather than seeking.</strong> A seek discards the decode pipeline and often
            the buffer, which costs 200–800 ms of black frames and frequently causes the very rebuffer it was
            meant to fix. A 3 percent rate change closes a 300 ms gap in 10 seconds with no visual or audible
            artefact at all.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Transitions"
        title="Start together, pause for both, seek once"
        lede="Every state change is scheduled rather than immediate, which is what turns two independent players into one shared timeline."
      >
        <div className="stack stack--md">
          <Code label="Start-together handshake">{`host   → play_requested { seq }
server : verify role, room state, and that every participant reported ready
server : startAt = now() + max(400 ms, 2 x worst_observed_rtt/2)
server → playback_started { anchorPositionMs, anchorServerMs: startAt, rate: 1, seq }

client : targetLocal = startAt - clockOffset      // convert to local time
client : video.currentTime = anchorPositionMs / 1000
client : wait until performance.now() >= targetLocal - 20 ms, then play()
client : if the deadline is already past, play() immediately and let the
         drift controller absorb the remainder — never delay the film to be tidy`}</Code>
          <Code label="Pause and seek semantics">{`pause_requested   : allowed for host and guest (this is 'pause for both').
                    Server anchors the position, broadcasts playback_paused,
                    and the room shows who paused it.

seek_requested    : host only, unless room.shared_control = true.
                    Server clamps the target to [0, duration], bumps seq,
                    sets state = 'armed', and broadcasts seek_committed.
                    Both clients seek, refill, report ready; the server then
                    re-runs the start-together handshake automatically if the
                    room was playing before the seek.

rate_changed      : host only. Applies to room.rate; the drift controller's own
                    nudges are layered on top of it per device.

track_changed     : subtitle and audio selection are room state, so both clients
                    switch at once. Subtitle changes never re-arm playback;
                    audio track changes do, because they reset the media element.`}</Code>
        </div>
      </Section>

      <Section
        eyebrow="Failure handling"
        title="Disconnects, packet loss, and stale commands"
      >
        <List
          items={[
            <>
              <strong>Missed broadcasts are self-healing.</strong> Because every heartbeat response carries the
              full canonical state and a <code>seq</code>, a client that missed a <code>playback_paused</code>{" "}
              frame discovers it within one second and reconciles.
            </>,
            <>
              <strong>Stale commands are dropped.</strong> Commands carry the <code>seq</code> the client
              believed was current. If it is lower than the room&rsquo;s, the server rejects it with{" "}
              <code>command_rejected {"{"} reason: &quot;stale&quot;, currentState {"}"}</code> instead of
              applying an out-of-order intent.
            </>,
            <>
              <strong>Reconnection is exponential and jittered.</strong> 0.5 s, 1 s, 2 s, 4 s, capped at 10 s
              with ±20 percent jitter. The socket reattaches with the same session and room token, receives{" "}
              <code>room_joined</code> with full state, and re-arms if it fell outside the seek threshold.
            </>,
            <>
              <strong>Grace period, not eviction.</strong> A dropped participant stays in the room for 90 seconds
              and the status line shows &ldquo;reconnecting&rdquo;. The film keeps playing for the person still
              present unless courtesy pause is enabled, which is the default for a two-person room.
            </>,
            <>
              <strong>Liveness.</strong> Server-initiated WebSocket ping every 20 seconds; two missed pongs mark
              the participant offline. Absent heartbeats for 5 seconds while a room is playing raise a{" "}
              <code>participant_status_changed</code> event so the other viewer is told something is wrong.
            </>,
            <>
              <strong>Server restart.</strong> On boot the sync service loads room checkpoints, treats every room
              as <code>paused</code> at its last known anchor, and lets clients re-arm. Restarting mid-film costs
              a two-second pause, never a lost position.
            </>,
          ]}
        />
      </Section>

      <Section
        eyebrow="Buffering"
        title="Low latency without gambling on the network"
        lede="Startup delay and rebuffering are the two ways sync fails in practice, so the buffer policy is part of the sync design rather than an afterthought."
      >
        <div className="stack stack--md">
          <Table
            head={["Parameter", "Value", "Reasoning"]}
            rows={[
              ["Segment duration", "2 s", "Short enough that a seek or quality switch costs little and that the start handshake is quick; long enough to keep request overhead and playlist size sane for a two-hour film."],
              ["Why not 1 s", "Rejected", "Doubles request count and per-segment overhead, hurts cache efficiency, and gives the ABR estimator less throughput signal per sample — more rung flapping, not less latency."],
              ["Why not 6 s", "Rejected", "A re-arm would cost up to six seconds of buffering and a mid-film quality switch becomes visible. Bad trade for a product whose promise is joint timing."],
              ["Start gate", "≥ 3 s buffered on both clients, or 6 s elapsed", "Waiting for a real buffer prevents an immediate stall; the timeout prevents one weak connection from holding the evening hostage."],
              ["Steady-state target", "18–24 s ahead", "Deep enough to ride out a mobile handover, and irrelevant to sync accuracy because position is authoritative, not buffer-derived."],
              ["Rebuffer response", "Courtesy pause for both", "In a two-person room, the correct behaviour when one person stalls is to wait, then resume together — not to let them fall a minute behind."],
              ["ABR", "Per-client, independent", "Each device picks its own rung from its own throughput estimate. Sync lives on the media timeline, so mismatched quality is fine."],
              ["Rung cap on weak links", "Sticky lower rung for 60 s after two stalls", "Stops the estimator from optimistically climbing back and stalling again, which is the main cause of repeat rebuffering."],
            ]}
          />
          <Callout>
            <strong>Delivery.</strong> The origin is Nginx or Caddy in front of MinIO with an on-disk segment
            cache, which is enough for two viewers. A CDN or a second cache node near the viewers is a pure
            optimisation and is never required by the protocol — the media gate signs URLs that any HTTP cache
            can serve, so it can be added later without a code change.
          </Callout>
        </div>
      </Section>

      <Pager current="/sync" />
    </>
  );
}

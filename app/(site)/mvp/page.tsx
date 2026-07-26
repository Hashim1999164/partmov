import type { Metadata } from "next";
import { Callout, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Roadmap",
  description:
    "Partmov MVP scope, explicit exclusions, an eight-week build order for a small team, acceptance criteria, and the enhancements that come after launch.",
};

const mvp = [
  ["Accounts", "Magic-link sign-in, session cookie, account deletion", "In"],
  ["Upload", "Resumable tus upload, checksum verification, ffprobe validation", "In"],
  ["Transcode", "Three-rung HLS ladder, fMP4, 2 s segments, aligned keyframes", "In"],
  ["Subtitles", "Extraction and upload, normalised to WebVTT, room-shared selection", "In"],
  ["Visual metadata", "Poster frame, sprite sheet with VTT index, chapter markers", "In"],
  ["Rooms", "One asset, one host, one guest, unlisted, resumable", "In"],
  ["Invites", "Hashed token, expiry, single use, optional passphrase, revocation", "In"],
  ["Sync", "Canonical clock, start-together, pause for both, host seek, rate nudge correction", "In"],
  ["Recovery", "Reconnect with full resync, courtesy pause, 90 s grace, re-arm on large drift", "In"],
  ["Companion", "Collapsible chat and six reactions, ephemeral", "In"],
  ["Admin", "Asset takedown, room kill, invite revocation, audit log view", "In"],
  ["Observability", "Prometheus, Grafana, Loki, eight core metrics, two paging alerts", "In"],
  ["Deployment", "Docker Compose on one VPS, Caddy TLS, pgBackRest, mc mirror", "In"],
  ["Group rooms (3+)", "Different sync and moderation trade-offs", "Out"],
  ["Native mobile apps", "The web room must be excellent first", "Out"],
  ["DRM", "Only if a licensor contractually requires it", "Out"],
  ["Voice or video chat", "Changes the product from co-watching to a call", "Out"],
  ["Public catalogue and discovery", "Contradicts private by construction", "Out"],
  ["Recommendations or watch history", "Requires the behavioural data the design refuses to collect", "Out"],
];

const weeks = [
  ["Weeks 1–2", "Foundations", "Compose stack up: PostgreSQL, MinIO, Caddy. Schema migrations. Magic-link auth. Upload with checksum verification and ffprobe gating."],
  ["Weeks 3–4", "Pipeline", "Worker with the PostgreSQL queue, FFmpeg ladder, subtitle extraction, poster and sprites, atomic publish, asset status streaming to the client."],
  ["Weeks 5–6", "Room and sync", "Sync service with canonical clock, ping/pong offset estimation, heartbeat loop, start-together handshake, drift controller in the client, reconnect path."],
  ["Week 7", "Experience", "Room UI, status line, control strip, subtitle and audio menus, collapsible companion rail, mobile layouts, reduced-motion support."],
  ["Week 8", "Hardening", "Rate limits, admin routes, dashboards and alerts, backup plus a timed restore drill, load test with simulated poor networks."],
];

const acceptance = [
  "Two devices on different networks start within 150 ms of each other, measured from player timestamps and repeated 20 times.",
  "Drift p95 stays under 120 ms across a 2-hour film with one device on throttled mobile network conditions.",
  "A forced 5-second stall on one device recovers to locked state without a hard seek.",
  "Killing the sync container mid-film costs under 3 seconds and no position loss.",
  "A revoked invite closes the guest's socket and fails the next segment request within 2 seconds.",
  "Deleting an asset leaves zero objects under both prefixes, verified by a list call, and writes an audit row.",
  "A restore drill from backups reaches a working room join in under 4 hours, timed and recorded.",
];

const later = [
  ["Shared control by default", "Promote the shared-control toggle to a first-class mode with intent-based conflict resolution, once real usage shows how often couples fight over the remote."],
  ["Continue watching across rooms", "Per-asset resume positions per user, so a film picks up wherever it was left even in a new room."],
  ["Native apps", "React Native or a thin Kotlin/Swift shell over the same REST and WebSocket contracts. Sync logic ports directly because the protocol is server-authoritative."],
  ["Redis scale-out", "Cross-node WebSocket fan-out and shared rate-limit counters, plus consistent-hash room sharding."],
  ["Optional edge caching", "A second cache node near the viewers, or a commodity CDN in front of the signed media path. Zero code change by design."],
  ["Licensed catalogue", "Admin-managed titles with licence references, territory rules, and a curated shelf that never becomes public discovery."],
  ["AV1 and HEVC rungs", "Roughly 30 percent bitrate savings at the cost of encode time; gate behind browser capability detection."],
  ["Low-latency ambience", "Optional whisper audio channel over WebRTC, strictly separate from media delivery so it can never destabilise sync."],
  ["Keycloak", "Only if teams or organisations become users and SSO is genuinely required."],
  ["Watch-together scheduling", "Invitations with a start time, a calendar file, and a gentle reminder — the one growth feature that fits the product's tone."],
];

export default function RoadmapPage() {
  return (
    <>
      <PageHead
        eyebrow="Roadmap"
        title="An eight-week MVP with a testable promise"
        lede="The MVP is the smallest system that can honestly claim two people watched the same film in sync, privately. Everything that does not serve that claim waits."
      />

      <Section eyebrow="Scope" title="In and out for v1" flush>
        <Table
          head={["Area", "Detail", "Status"]}
          rows={mvp.map(([area, detail, status]) => [
            area,
            detail,
            <strong key={area} style={{ color: status === "In" ? "var(--sage)" : "var(--ivory-3)" }}>
              {status}
            </strong>,
          ])}
        />
      </Section>

      <Section
        eyebrow="Build order"
        title="Eight weeks, two engineers"
        lede="Sequenced so the riskiest part — synchronisation — is exercised with real media by week six rather than discovered in week eight."
      >
        <Table head={["When", "Phase", "Work"]} rows={weeks} />
      </Section>

      <Section
        eyebrow="Definition of done"
        title="Acceptance criteria, all measurable"
        lede="Every item below is a test that either passes or fails. None of them are opinions about polish."
      >
        <div className="stack stack--md">
          <List items={acceptance} />
          <Callout>
            The first two criteria are the product. If start alignment and drift cannot be held on real networks,
            no amount of interface work makes Partmov worth using.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="After launch"
        title="Enhancements in the order they earn their keep"
      >
        <Table head={["Enhancement", "What it involves"]} rows={later} />
      </Section>

      <Section eyebrow="Closing" title="Why this design holds together">
        <div className="prose">
          <p>
            Partmov works because it refuses generality. One title per room, two people per room, one
            authoritative clock, one delivery protocol. That narrowness is what lets a two-person team hold sync
            accuracy to tens of milliseconds on commodity hardware, and it is what keeps the privacy story simple
            enough to be true: there is no catalogue to browse, no history to mine, and no third party in the
            request path.
          </p>
          <p>
            Every component named in this blueprint — PostgreSQL, MinIO, FFmpeg, Caddy, Prometheus, Grafana, Loki,
            Docker — is free software that runs on a single machine you control, and each one can be replaced
            without redesigning the system around it. That is the point of the architecture as much as the sync
            protocol is the point of the product.
          </p>
        </div>
      </Section>

      <Pager current="/mvp" />
    </>
  );
}

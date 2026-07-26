import Link from "next/link";
import { RoomMock } from "@/components/RoomMock";
import { SyncVisual } from "@/components/SyncVisual";
import { Callout, List, Pager, Section, Table, Tiles } from "@/components/primitives";
import { Reveal } from "@/components/Reveal";

const components = [
  { title: "Ingestion", body: "Resumable uploads land in a private MinIO bucket, checksummed and probed before anything else happens." },
  { title: "Transcoding", body: "FFmpeg builds a three-rung HLS ladder in fragmented MP4 with 2-second segments and aligned keyframes." },
  { title: "Subtitles & chapters", body: "Embedded tracks are extracted, normalised to WebVTT, and stored alongside chapter markers and language tags." },
  { title: "Private rooms", body: "Every room is unlisted. Access comes from a single-purpose invite link with an expiry and a revoke switch." },
  { title: "Sync service", body: "One WebSocket process owns the canonical room clock, orders commands, and rejects stale ones." },
  { title: "Drift correction", body: "Clients compare against server time every second and close gaps with playback-rate nudges, not seeks." },
  { title: "Chat & reactions", body: "A collapsible side rail. Ephemeral by default, never the centre of the screen." },
  { title: "Moderation tools", body: "Admin routes to inspect an asset, kill a room, revoke a link, and purge media on request." },
  { title: "Technical analytics", body: "Startup time, rebuffer ratio, drift percentiles, join success. No behavioural profiling." },
  { title: "Access control", body: "Short-lived signed media URLs, per-owner object prefixes, and hard deletion that actually deletes." },
];

const stack = [
  ["Client", "Next.js + React, hls.js", "One codebase for desktop and mobile web; hls.js gives frame-accurate position control and buffer telemetry that native HLS hides."],
  ["API", "Fastify (TypeScript)", "Small, fast, schema-validated routes. Shares types with the client, so command payloads cannot drift."],
  ["Realtime", "ws over WSS", "Control traffic is a few hundred bytes per second. WebRTC would add NAT traversal and codec negotiation for no gain."],
  ["Database", "PostgreSQL 16", "Rooms, assets, invites, audit trail, and the job queue. LISTEN/NOTIFY replaces a broker at this size."],
  ["Object storage", "MinIO", "S3 API without the bill. Private buckets, per-owner prefixes, server-side encryption, versioning off for media."],
  ["Media", "FFmpeg", "Ladder generation, subtitle extraction, poster frames, sprite sheets. Nothing else is needed."],
  ["Edge", "Caddy or Nginx", "TLS, HTTP/2, media token verification, and an optional segment cache in front of MinIO."],
  ["Identity", "Magic-link sessions", "Email link plus signed cookie. No passwords to leak; Keycloak stays on the shelf until SSO is a real requirement."],
  ["Observability", "Prometheus, Grafana, Loki, OpenTelemetry", "The standard open stack. Dashboards track playback health, not people."],
  ["Runtime", "Docker Compose, then Kubernetes", "One VPS runs the MVP. The same images scale out when concurrency demands it."],
];

export default function OverviewPage() {
  return (
    <>
      <header className="hero">
        <div className="hero__plane" aria-hidden="true">
          <div className="hero__beam" />
          <div className="hero__glow" />
          <div className="hero__horizon" />
        </div>
        <div className="shell hero__inner">
          <Reveal>
            <h1 className="hero__brand">Partmov</h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="hero__headline">A private cinema for two, synchronised to the frame.</p>
          </Reveal>
          <Reveal delay={260}>
            <p className="hero__sub">
              One room, one invite link, one canonical clock. Self-hosted on free software from the object
              store to the dashboards.
            </p>
          </Reveal>
          <Reveal delay={380}>
            <div className="hero__ctas">
              <Link className="btn btn--primary" href="/watch">
                Watch together
              </Link>
              <Link className="btn btn--ghost" href="/architecture">
                Read the architecture
              </Link>
            </div>
          </Reveal>
        </div>
      </header>

      <Section
        eyebrow="The room"
        title="Everything on screen serves the film"
        lede="A watch room is a player, a one-line status of who holds the remote and how tightly you are synced, and a control strip that fades away. Chat lives behind a collapsed rail. Nothing counts likes, nothing suggests what to watch next."
      >
        <div className="stack stack--md">
          <RoomMock />
          <List
            items={[
              <>
                <strong>Start together</strong> — playback begins on a scheduled timestamp once both clients
                report a healthy buffer, so nobody is left staring at a spinner.
              </>,
              <>
                <strong>Pause for both</strong> — either participant can stop the film; only the host can seek
                unless shared control is switched on.
              </>,
              <>
                <strong>Rejoin session</strong> — a reload or a dropped train tunnel restores the exact server
                position, not the last thing the browser remembered.
              </>,
              <>
                <strong>Continue from last time</strong> — the room keeps its position when both people leave,
                so tomorrow night resumes where tonight ended.
              </>,
              <>
                <strong>Shared subtitles</strong> — track selection is room state, so a subtitle change lands on
                both screens at once.
              </>,
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow="Sync"
        title="The server owns the clock"
        lede="Clients never guess where the film is. They report where they are, receive the authoritative position, and correct the difference so gently that neither viewer notices."
      >
        <div className="stack stack--md">
          <SyncVisual />
          <Callout>
            Drift under 40 ms counts as locked. Between 40 ms and 1.5 s the client trims playback rate by up to
            5 percent, which is inaudible on dialogue. Only past 1.5 s, or after an explicit seek, does anyone
            jump. <Link href="/sync" style={{ color: "var(--copper-bright)" }}>See the full protocol</Link>.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Scope"
        title="Ten components, nothing speculative"
        lede="Each part of the platform has a single job and a clear owner in the codebase."
      >
        <Tiles items={components} />
      </Section>

      <Section
        eyebrow="Stack"
        title="Free software, chosen on merit"
        lede="Every dependency below is open source and self-hostable. Where a managed service would normally appear, the design explains what replaces it."
      >
        <Table
          head={["Layer", "Choice", "Why this one"]}
          rows={stack.map(([layer, choice, why]) => [layer, <strong key={choice}>{choice}</strong>, why])}
        />
      </Section>

      <Pager current="/" />
    </>
  );
}

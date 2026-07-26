import type { Metadata } from "next";
import { Callout, Code, KeyValues, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Operations",
  description:
    "Partmov operations: open-source observability, SLOs and alerts, rate limiting, backup and restore for PostgreSQL and MinIO, disaster recovery drills, and the scaling path.",
};

const stack = [
  { k: "Prometheus", v: "Scrapes /metrics from api, sync, workers, MinIO, PostgreSQL exporter, and the proxy. 15-second interval, 30-day local retention, which is plenty for a two-person operations team." },
  { k: "Grafana OSS", v: "Three dashboards only: Playback Health (startup, rebuffer, drift, join success), Pipeline (queue depth, transcode duration, failure rate), Platform (CPU, disk, connections, error rate)." },
  { k: "Loki + Promtail", v: "Structured JSON logs shipped from container stdout. Every log line carries request_id, and room-scoped lines carry room_id so a session can be reconstructed without a tracing backend." },
  { k: "OpenTelemetry Collector", v: "Traces for the upload-to-ready path, which is the one flow that crosses three services and object storage. Sampled at 10 percent, plus 100 percent of errors." },
  { k: "Alertmanager", v: "Two channels: page (user-visible breakage) and notice (capacity and hygiene). Nothing else, so a page always means something." },
];

const slos = [
  ["Room join success", "> 99 % of valid invites", "page", "drops below 97 % over 10 minutes"],
  ["Startup time p95", "< 2.5 s", "notice", "above 4 s for 15 minutes"],
  ["Rebuffer ratio", "< 0.5 % of watch time", "notice", "above 2 % for 15 minutes"],
  ["Sync drift p95", "< 120 ms", "page", "above 500 ms for 5 minutes with rooms active"],
  ["Hard seeks", "≈ 0", "notice", "more than 5 per room per hour"],
  ["Transcode queue age", "< 10 min oldest queued job", "notice", "oldest job older than 30 minutes"],
  ["API 5xx rate", "< 0.1 %", "page", "above 1 % for 5 minutes"],
  ["Storage headroom", "> 20 % free", "notice", "below 15 %, page below 7 %"],
];

const limits = [
  ["Magic links", "3 per email / 15 min, 20 per IP / hour", "Stops mailbox flooding and enumeration."],
  ["Room join", "5 per IP / min, 20 per room / hour, room locks after 10 failures", "Makes token guessing pointless."],
  ["Uploads", "2 concurrent per account, per-file cap, quota check before the tus URL is issued", "Protects disk and encoder capacity."],
  ["Commands", "10 play/pause/seek per 10 s per participant", "Prevents a stuck key from thrashing the room clock."],
  ["Chat and reactions", "10 messages / 10 s, 5 reactions / 10 s", "Keeps the rail calm."],
  ["Segment requests", "Ceiling derived from real bitrate x 3", "A client pulling far faster than realtime is scraping, not watching."],
  ["Implementation", "In-process token buckets for MVP, Redis counters once the API runs multiple replicas", "The limiter must be shared the moment the API is not a single process."],
];

const backup = `# ---------- PostgreSQL: continuous, point-in-time ----------
# pgBackRest to a separate MinIO bucket or an offsite box
pgbackrest --stanza=partmov backup --type=incr        # every 15 min (WAL archived continuously)
pgbackrest --stanza=partmov backup --type=full        # weekly
# retention: 14 daily, 8 weekly. RPO ≈ 5 min, RTO ≈ 15 min for a full restore.

# ---------- MinIO: prefix mirror, separate schedule ----------
mc mirror --overwrite --remove \\
   local/partmov-originals  offsite/partmov-originals    # nightly
mc mirror --overwrite --remove \\
   local/partmov-renditions offsite/partmov-renditions   # nightly, lower priority
# renditions are reproducible from originals, so they are the first thing to
# sacrifice under storage pressure — never the other way round.

# ---------- restore drill, quarterly, on a scratch host ----------
1. pgbackrest restore --delta --type=time --target="…"   # verify row counts + a known room
2. mc mirror offsite/partmov-originals local/…            # verify sha256 on 10 sampled assets
3. boot api + sync + worker against the restored data
4. join a canned room from a saved invite and confirm start-together still works
5. record wall-clock RTO in the runbook; a drill that is not timed is not a drill`;

export default function OpsPage() {
  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Runnable by two people on a Tuesday night"
        lede="The operational design assumes there is no on-call rotation. That means few alerts, obvious dashboards, backups that are proven by restore drills, and failure modes that degrade quietly."
      />

      <Section eyebrow="Observability" title="The open-source stack" flush>
        <KeyValues items={stack} />
      </Section>

      <Section
        eyebrow="SLOs"
        title="What gets measured, and what wakes someone up"
        lede="Only two conditions page: people cannot get into their room, or the film is visibly out of sync. Everything else can wait until morning."
      >
        <Table head={["Signal", "Objective", "Severity", "Alert fires when"]} rows={slos} />
      </Section>

      <Section
        eyebrow="Rate limiting"
        title="Limits with a stated purpose"
        lede="Each limit exists to protect a specific resource, so the numbers can be argued about with evidence rather than vibes."
      >
        <Table head={["Surface", "Limit", "Protecting"]} rows={limits} />
      </Section>

      <Section
        eyebrow="Backup and recovery"
        title="Two data stores, two strategies, one drill"
        lede="Database and media fail differently and recover differently, so they are never backed up by the same mechanism."
      >
        <div className="stack stack--md">
          <Code label="backup + restore runbook">{backup}</Code>
          <Table
            head={["Failure", "Blast radius", "Recovery"]}
            rows={[
              ["API container dies", "In-flight HTTP requests", "Restart or replica takes over. Stateless, so nothing to reconcile."],
              ["Sync process dies", "Active rooms pause", "Restart loads checkpoints, rooms come back paused at their last anchor, clients re-arm within seconds."],
              ["Worker dies mid-transcode", "One asset stays in transcoding", "Job lock expires after 30 minutes, another worker retries. FFmpeg output is written to a temporary prefix and promoted atomically, so partial renditions never publish."],
              ["PostgreSQL corruption", "Everything stateful", "pgBackRest point-in-time restore. Media is untouched because it lives elsewhere."],
              ["MinIO disk loss", "Media bytes", "Restore originals from the offsite mirror, then re-run transcode jobs to rebuild renditions."],
              ["Whole host loss", "Everything", "Provision a new host, restore both stores, redeploy the same images. Documented target: under 4 hours, verified quarterly."],
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow="Scaling"
        title="From a few rooms to many concurrent sessions"
      >
        <div className="stack stack--md">
          <List
            items={[
              <>
                <strong>Bandwidth is the first ceiling, not CPU.</strong> Two viewers at the 1080p rung cost about
                10 Mbit/s. A 1 Gbit/s uplink saturates near 45 concurrent rooms with headroom, so the first
                scaling move is egress and caching, not more application servers.
              </>,
              <>
                <strong>Then the segment cache.</strong> Adding <code>proxy_cache</code> in front of MinIO turns
                two identical segment reads into one origin read, which matters most when both viewers are on the
                same rung.
              </>,
              <>
                <strong>Then API replicas.</strong> Stateless containers behind the proxy; the only change needed
                is moving rate-limit counters into Redis.
              </>,
              <>
                <strong>Then sharded sync nodes.</strong> Rooms are assigned to a sync node by consistent hash of{" "}
                <code>room_id</code>, so each room keeps exactly one authority. Redis pub/sub carries cross-node
                presence and chat.
              </>,
              <>
                <strong>Transcoding scales sideways trivially.</strong> Workers are stateless consumers of a
                PostgreSQL queue; add machines during backlogs and remove them after. Encoding never shares a host
                with the request path once there is more than one machine.
              </>,
              <>
                <strong>Kubernetes when, not if.</strong> Move off Compose when replica management, rolling
                deploys, or multi-host scheduling become manual chores. The container images do not change; only
                the scheduler does.
              </>,
            ]}
          />
          <Callout>
            Capacity rule of thumb for the MVP host: 4 vCPU and 8 GB of RAM comfortably serve a handful of
            concurrent rooms while one FFmpeg job runs at <code>veryfast</code>, roughly 3 to 6 times realtime for
            a 1080p ladder. Transcoding is the only component that will ever want a bigger machine.
          </Callout>
        </div>
      </Section>

      <Pager current="/ops" />
    </>
  );
}

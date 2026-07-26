import type { Metadata } from "next";
import { ArchDiagram } from "@/components/ArchDiagram";
import { Callout, Code, KeyValues, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "Partmov system architecture: service boundaries, the FFmpeg media pipeline, storage layout, container deployment, and the horizontal scaling path.",
};

const textDiagram = `                        ┌──────────────────────────────┐
                        │  Browser (host)  Browser(guest)│
                        │  Next.js · hls.js · drift ctrl │
                        └───┬─────────┬──────────┬───────┘
              REST/HTTPS    │         │ WSS      │  HLS GET (signed)
                            ▼         ▼          ▼
                     ┌───────────────────────────────────┐
                     │   Caddy / Nginx  (single TLS door)│
                     │   /api → api   /ws → sync         │
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
        │ audit          │  │  fan-out)    │  │ subs/ posters│
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
                          ──OTLP─────▶ OpenTelemetry Collector`;

const services = [
  {
    k: "API (Fastify)",
    v: "Completely stateless. Authentication, room and invite lifecycle, library queries, upload initiation, signed URL minting, and job enqueueing. Any instance can serve any request, so scaling is a replica count.",
  },
  {
    k: "Sync service (ws)",
    v: "The only stateful process. Holds hot room state in memory, assigns monotonic command sequence numbers, computes the canonical position, and fans out events. Checkpoints to PostgreSQL every 5 seconds and on every state transition.",
  },
  {
    k: "Transcode worker",
    v: "Pulls jobs from a PostgreSQL queue using SELECT … FOR UPDATE SKIP LOCKED, runs FFmpeg, writes renditions back to MinIO, updates asset rows. CPU-bound and horizontally scalable; workers are interchangeable and restart-safe.",
  },
  {
    k: "Media gate",
    v: "A thin request handler (or an Nginx secure_link block) that validates the HMAC token, expiry, room binding, and Range header before proxying bytes from MinIO. Object storage is never exposed directly.",
  },
  {
    k: "Edge proxy",
    v: "One TLS front door. Routes by path prefix, disables buffering for video, keeps WebSocket upgrades alive with generous read timeouts, and can cache segments on disk when a second viewer is on the same network.",
  },
];

const pipeline = [
  ["1. Accept", "tus resumable upload to /uploads; client-side SHA-256 sent as a trailer and re-verified server-side."],
  ["2. Probe", "ffprobe -v error -show_format -show_streams. Reject anything without a decodable video stream, longer than the configured limit, or with a mismatched checksum."],
  ["3. Ladder", "Three rungs — 1080p at 5.0 Mbit/s, 720p at 2.8 Mbit/s, 480p at 1.2 Mbit/s — H.264 high profile, AAC-LC stereo at 128 kbit/s, forced keyframes every 2 seconds so rungs are switchable at identical boundaries."],
  ["4. Package", "fMP4 HLS with an independent init segment per rung, a master playlist, and byte-aligned segment durations. DASH manifests can be emitted from the same segments later without re-encoding."],
  ["5. Subtitles", "Embedded tracks extracted per stream index and converted to WebVTT; uploaded SRT files are normalised the same way. Encoding is forced to UTF-8 and cue timings are validated."],
  ["6. Visuals", "Poster frame from the 10 percent mark, plus a sprite sheet of 160×90 tiles every 5 seconds with a matching WebVTT thumbnail index for scrub previews."],
  ["7. Publish", "Durations, resolutions, bitrates, languages, and chapter markers written to PostgreSQL in one transaction. The asset flips to ready and any waiting room is notified over WebSocket."],
];

export default function ArchitecturePage() {
  return (
    <>
      <PageHead
        eyebrow="Architecture"
        title="Four services, two data stores, one front door"
        lede="The system is small on purpose. Every box below exists because something in the product would break without it, and each one can be run by a single container on a single VPS for the MVP."
      />

      <Section eyebrow="Topology" title="System diagram" flush>
        <div className="stack stack--md">
          <ArchDiagram />
          <Code label="Same topology in text form">{textDiagram}</Code>
        </div>
      </Section>

      <Section
        eyebrow="Responsibilities"
        title="What lives where"
        lede="The split follows one rule: anything that must be authoritative and ordered goes in the sync service, everything else stays stateless."
      >
        <KeyValues items={services} />
      </Section>

      <Section
        eyebrow="Decisions"
        title="Two questions worth answering explicitly"
      >
        <div className="stack stack--md">
          <div className="prose">
            <p>
              <strong>Is PostgreSQL enough for room state, or is Redis needed?</strong> For the MVP, PostgreSQL
              is enough. A two-person room generates a handful of state transitions per hour, and the
              per-second heartbeats never need to be persisted individually — they are aggregated in memory and
              exported as metrics. The sync process keeps the hot copy of each room in a map and writes
              checkpoints so a crash costs at most 5 seconds of position accuracy.
            </p>
            <p>
              Redis becomes worth its operational cost at exactly one threshold: <strong>more than one sync
              node</strong>. At that point you need cross-node pub/sub for event fan-out and a shared counter
              store for rate limits. Until then it is a second failure domain guarding data that is already
              cheap to rebuild.
            </p>
            <p>
              <strong>WebSocket or WebRTC?</strong> WebSocket, unambiguously. The realtime channel carries
              control commands, heartbeats, chat, and presence — a few hundred bytes per second per participant
              with strict ordering requirements. That is exactly what a single TCP connection with a framing
              protocol is good at. WebRTC exists to move media peer-to-peer, and Partmov does not move media
              peer-to-peer: both clients pull the same HLS segments over HTTPS from the same origin, which is
              what makes adaptive bitrate and buffer control possible. Adding WebRTC would introduce ICE, TURN
              relays, and codec negotiation to solve a problem the product does not have.
            </p>
          </div>
          <Callout>
            One consequence of the HLS choice: the two clients can sit on completely different quality rungs and
            still be in sync, because synchronisation is defined on the media timeline, not on the bitstream.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Media pipeline"
        title="From an uploaded file to an adaptive stream"
        lede="Seven stages, all driven by FFmpeg, all idempotent so a failed job can simply be retried."
      >
        <div className="stack stack--md">
          <Table head={["Stage", "What happens"]} rows={pipeline} />
          <Code label="Ladder generation — the shape of the worker's FFmpeg invocation">{`ffmpeg -i original.mkv \\
  -filter_complex "[0:v]split=3[v1][v2][v3]; \\
    [v1]scale=w=1920:h=1080[v1out]; \\
    [v2]scale=w=1280:h=720[v2out]; \\
    [v3]scale=w=854:h=480[v3out]" \\
  -map "[v1out]" -c:v:0 libx264 -preset veryfast -crf 21 -maxrate 5000k -bufsize 7500k \\
  -map "[v2out]" -c:v:1 libx264 -preset veryfast -crf 22 -maxrate 2800k -bufsize 4200k \\
  -map "[v3out]" -c:v:2 libx264 -preset veryfast -crf 23 -maxrate 1200k -bufsize 1800k \\
  -map a:0 -map a:0 -map a:0 -c:a aac -b:a 128k -ac 2 \\
  -x264-params "keyint=48:min-keyint=48:scenecut=0" \\
  -f hls -hls_time 2 -hls_playlist_type vod \\
  -hls_segment_type fmp4 -hls_flags independent_segments \\
  -master_pl_name master.m3u8 \\
  -var_stream_map "v:0,a:0,name=1080p v:1,a:1,name=720p v:2,a:2,name=480p" \\
  "hls/%v/index.m3u8"

# subtitles: every embedded text stream, normalised to WebVTT
ffmpeg -i original.mkv -map 0:s:0 -c:s webvtt subs/en.vtt

# sprite sheet for scrub previews: one 160x90 tile every 5 seconds
ffmpeg -i original.mkv -vf "fps=1/5,scale=160:90,tile=10x10" -qscale:v 4 sprites/%03d.jpg`}</Code>
          <Callout>
            <strong>Keyframe alignment is not optional.</strong> Forcing <code>keyint=48</code> at 24 fps puts an
            IDR frame on every 2-second boundary in every rung, which is what lets a client switch quality
            mid-film without a visible reset — and what lets the drift controller seek to an exact position
            cheaply.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Storage"
        title="Bucket layout and lifecycle"
        lede="Two buckets with different exposure rules, addressed by owner so isolation is structural rather than enforced by query filters alone."
      >
        <div className="stack stack--md">
          <Code label="MinIO object layout">{`partmov-originals/                    # never web-reachable, no public policy, no signed reads
  u/<user_id>/a/<asset_id>/source.mkv
  u/<user_id>/a/<asset_id>/source.sha256

partmov-renditions/                   # reachable only through the media gate
  a/<asset_id>/master.m3u8
  a/<asset_id>/1080p/init.mp4 + seg-00001.m4s …
  a/<asset_id>/720p/…
  a/<asset_id>/480p/…
  a/<asset_id>/subs/en.vtt · es.vtt
  a/<asset_id>/poster.jpg
  a/<asset_id>/sprites/001.jpg + sprites.vtt`}</Code>
          <List
            items={[
              <>
                <strong>Originals are write-once.</strong> After transcoding they are read only by re-encode
                jobs. Nothing in the request path can reach them.
              </>,
              <>
                <strong>Renditions are gated, not public.</strong> The bucket policy denies anonymous access;
                the only reader is the media gate, which requires a valid token bound to a room and a session.
              </>,
              <>
                <strong>Deletion is a real job.</strong> Removing an asset marks it deleted, tears down rooms
                that reference it, then a purge worker deletes both prefixes and records the completion in the
                audit log.
              </>,
              <>
                <strong>Server-side encryption</strong> is enabled with MinIO KES so an exfiltrated disk does not
                equal exfiltrated films.
              </>,
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow="Deployment"
        title="One Compose file for the MVP"
        lede="A four-core VPS with 8 GB of RAM and a large disk runs everything below, including transcoding, for a handful of concurrent rooms."
      >
        <div className="stack stack--md">
          <Code label="docker-compose.yml (abridged)">{`services:
  proxy:      # Caddy: TLS, routing, optional segment cache
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy-data:/data"]

  api:        # stateless — scale with 'deploy.replicas'
    build: ./services/api
    environment: [DATABASE_URL, S3_ENDPOINT, S3_KEY, S3_SECRET, MEDIA_SIGNING_KEY, SESSION_KEY]
    depends_on: [postgres, minio]

  sync:       # single authority for room clocks
    build: ./services/sync
    environment: [DATABASE_URL, SESSION_KEY]
    depends_on: [postgres]

  worker:     # FFmpeg; scale to the number of spare cores
    build: ./services/worker
    environment: [DATABASE_URL, S3_ENDPOINT, S3_KEY, S3_SECRET]
    deploy: { replicas: 2 }

  postgres:
    image: postgres:16-alpine
    volumes: ["pgdata:/var/lib/postgresql/data"]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    volumes: ["miniodata:/data"]

  prometheus: { image: prom/prometheus }
  grafana:    { image: grafana/grafana-oss }
  loki:       { image: grafana/loki }

volumes: { pgdata: {}, miniodata: {}, caddy-data: {} }`}</Code>
          <Table
            head={["Growth step", "What changes"]}
            rows={[
              ["A few rooms", "Single node, Compose, two workers. No Redis. Segment cache off."],
              [
                "Dozens of rooms",
                "API scaled to 3 replicas behind the proxy; workers moved to a second machine so encoding never competes with the request path.",
              ],
              [
                "Hundreds of rooms",
                "Introduce Redis for WebSocket fan-out and rate limits; shard rooms across sync nodes by consistent hash of room_id so a room always has exactly one authority.",
              ],
              [
                "Geographically spread viewers",
                "Keep the origin as-is and put an optional cache in front of /media — nginx on a cheap VPS near the viewers, or a commodity CDN. The design never depends on it.",
              ],
              [
                "Storage growth",
                "MinIO moves from single-node to a distributed erasure-coded set; object keys do not change, so nothing else is touched.",
              ],
            ]}
          />
          <Callout>
            The reason stateless API servers matter here: room membership, playback position, and media metadata
            all live in PostgreSQL or in the one sync process that owns the room. An API container can be killed
            mid-request and nothing about the room is lost.
          </Callout>
        </div>
      </Section>

      <Pager current="/architecture" />
    </>
  );
}

type Layer = {
  label: string;
  nodes: { name: string; note: string }[];
};

const layers: Layer[] = [
  {
    label: "Clients — browser first, same contract for future native apps",
    nodes: [
      { name: "Watch room (Next.js)", note: "React client, hls.js, drift controller, room UI" },
      { name: "Library + upload", note: "Resumable tus uploads, asset status polling" },
      { name: "Admin console", note: "Same app, role-gated routes for takedowns" },
    ],
  },
  {
    label: "Edge — one Caddy/Nginx front door, TLS terminated once",
    nodes: [
      { name: "Reverse proxy", note: "Routes /api, /ws, /media; gzip off for video, HTTP/2" },
      { name: "Signed media gate", note: "Validates HMAC token + expiry before proxying to MinIO" },
      { name: "Optional edge cache", note: "nginx proxy_cache for segments; CDN is opt-in, never required" },
    ],
  },
  {
    label: "Application — stateless API, one stateful sync process",
    nodes: [
      { name: "API (Fastify)", note: "Auth, rooms, invites, library, signed URLs, job enqueue" },
      { name: "Sync service (ws)", note: "Canonical room clock, command ordering, fan-out" },
      { name: "Transcode workers", note: "FFmpeg ladder, subtitles, poster, sprite sheet" },
    ],
  },
  {
    label: "Data — durable state and bytes, backed up separately",
    nodes: [
      { name: "PostgreSQL 16", note: "Users, assets, rooms, invites, job queue, audit log" },
      { name: "MinIO", note: "Originals bucket (private) + renditions bucket (gated)" },
      { name: "Redis (scale-out only)", note: "WS fan-out + rate-limit counters once >1 sync node" },
    ],
  },
  {
    label: "Observability — operational metrics only, no user analytics",
    nodes: [
      { name: "Prometheus + Grafana", note: "Startup time, rebuffer ratio, drift p95, join success" },
      { name: "Loki + Promtail", note: "Structured logs, room_id correlation, 14-day retention" },
      { name: "OpenTelemetry", note: "Traces across API to worker to storage" },
    ],
  },
];

export function ArchDiagram() {
  return (
    <div className="arch">
      {layers.map((layer, i) => (
        <div key={layer.label}>
          {i > 0 && (
            <div className="arch__flowlabel">
              {i === 1 && "HTTPS REST  ·  WSS control channel  ·  HLS GET (signed)"}
              {i === 2 && "proxy_pass  ·  token verification  ·  segment cache hit or miss"}
              {i === 3 && "SQL  ·  S3 API  ·  LISTEN/NOTIFY job wakeups"}
              {i === 4 && "/metrics scrape  ·  stdout logs  ·  OTLP spans"}
            </div>
          )}
          <div className="arch__layer">
            <div className="arch__layerlabel">{layer.label}</div>
            <div className="arch__nodes">
              {layer.nodes.map((node) => (
                <div className="arch__node" key={node.name}>
                  <b>{node.name}</b>
                  <span>{node.note}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

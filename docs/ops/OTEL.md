# OpenTelemetry

Export traces from API / sync / worker via OTLP HTTP to the collector (add to compose profile `obs` when deploying).

Minimum spans:
- `http.request` (API)
- `ws.message` (sync commands)
- `job.claim` / `job.transcode` (worker)
- `media.auth` (edge auth subrequest)

Propagate `x-request-id` / `traceparent` into nginx access logs.

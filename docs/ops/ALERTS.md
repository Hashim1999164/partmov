# Alerting sketch (Alertmanager)

Groups:
- `partmov_api_down`: `partmov_api_up == 0` for 2m
- `partmov_sync_down`: absent(`partmov_sync_up`) for 2m
- `partmov_worker_dead_letter`: increase in failed jobs / dead status from DB exporter
- `partmov_edge_5xx`: nginx 5xx rate > 1% for 5m

Route pages/Slack to on-call. Correlate with OpenTelemetry `trace_id` in Loki.

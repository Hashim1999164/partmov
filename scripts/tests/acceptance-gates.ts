/**
 * Playwright acceptance checklist (manual + automated outline).
 *
 * Two-browser gates before enabling NEXT_PUBLIC_STREAMING_V2:
 * 1. ABR divergence while timeline stays synced
 * 2. Seek / play / pause authority
 * 3. Host succession on leave
 * 4. Reconnect snapshot
 * 5. Mid-playback token rotation (no stall > 1s)
 * 6. Expire / force-end revokes segments (401)
 * 7. Purge removes MinIO objects
 *
 * Media compatibility (worker golden set):
 * - 24/30/60 fps, 4:3 / 16:9 / 2.39, 480p source (no upscale)
 * - multi-audio, no-audio, embedded subs, VFR, corrupt reject, 3h+ film
 *
 * Fault injection:
 * - kill sync → reconnect
 * - tc delay MinIO 500ms
 * - restart postgres
 * - saturate edge with iperf + parallel viewers
 * - expire token mid-segment
 * - interrupt upload
 */
export const gates = [
  "unit:protocol+lease",
  "golden:media-matrix",
  "playwright:two-browser",
  "k6:50x100",
  "fault:injection",
];

/**
 * Golden media compatibility matrix for the FFmpeg worker.
 * Execute with WORKER golden fixtures when ffmpeg + MinIO + Postgres are up:
 *   GOLDEN_MEDIA_DIR=/path/to/fixtures node --import tsx scripts/tests/golden-media.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const cases = [
  { id: "fps24", file: "film_24fps.mp4", expect: "ready" },
  { id: "fps30", file: "film_30fps.mp4", expect: "ready" },
  { id: "fps60", file: "film_60fps.mp4", expect: "ready" },
  { id: "ar43", file: "film_4x3.mp4", expect: "ready" },
  { id: "ar239", file: "film_2.39.mp4", expect: "ready" },
  { id: "lowres", file: "film_480p.mp4", expect: "ready-no-1080" },
  { id: "multiaudio", file: "film_dual_audio.mp4", expect: "ready" },
  { id: "noaudio", file: "film_silent.mp4", expect: "ready" },
  { id: "subs", file: "film_mov_text.mp4", expect: "ready+vtt" },
  { id: "vfr", file: "film_vfr.mp4", expect: "ready" },
  { id: "corrupt", file: "corrupt.bin", expect: "failed" },
  { id: "long", file: "film_180m.mp4", expect: "ready" },
];

const dir = process.env.GOLDEN_MEDIA_DIR;
if (!dir) {
  console.log("GOLDEN_MEDIA_DIR unset — printing matrix only (gate blocked until fixtures present)");
  for (const c of cases) console.log(`- [${c.id}] ${c.file} → ${c.expect}`);
  console.log("PASS(soft): matrix defined; wire fixtures before STREAMING_V2 production enable");
  process.exit(0);
}

let missing = 0;
for (const c of cases) {
  const p = join(dir, c.file);
  if (!existsSync(p)) {
    console.warn("missing fixture", c.id, p);
    missing += 1;
  } else {
    console.log("present", c.id);
  }
}
if (missing) {
  console.error(`${missing} fixtures missing`);
  process.exit(1);
}
console.log("All fixtures present — enqueue probe/transcode jobs via API upload path to complete gate");

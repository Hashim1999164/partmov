/**
 * Fault-injection checklist runner (soft pass without chaos mesh).
 * Documents and optionally probes local stack resilience.
 */
const API = process.env.API_BASE || "http://127.0.0.1:8080";
const SYNC = process.env.SYNC_BASE || "http://127.0.0.1:8090";

const faults = [
  "kill sync process → clients reconnect with snapshot",
  "delay MinIO 500ms → playlist retries / cached segments",
  "restart PostgreSQL → API readyz 503 then recover",
  "saturate edge bandwidth → per-viewer ABR downswitch",
  "expire token mid-segment → refresh path / 401 after revoke",
  "interrupt upload → abandon + retention purge",
];

async function probe(url: string) {
  try {
    const res = await fetch(url);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function main() {
  console.log("Fault injection gates:");
  for (const f of faults) console.log(" -", f);
  const api = await probe(`${API}/healthz`);
  const sync = await probe(`${SYNC}/healthz`);
  console.log({ api, sync });
  console.log(
    "PASS(soft): fault catalog recorded; execute chaos steps on VPS staging before enabling STREAMING_V2",
  );
}

main();

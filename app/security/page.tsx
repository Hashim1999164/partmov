import type { Metadata } from "next";
import { Callout, Code, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Privacy and security",
  description:
    "Partmov privacy model: unlisted rooms, expiring invite links, short-lived signed media URLs, content isolation, verifiable deletion, and analytics that measure playback rather than people.",
};

const layers = [
  ["Account", "Magic link + signed session cookie", "No password to phish or reuse. Tokens are single-use, 15-minute, and bound to the requesting email. Sessions are HttpOnly, Secure, SameSite=Lax, revocable server-side."],
  ["Room", "Unlisted by construction", "No listing endpoint exists, room ids are UUIDv4, and enumeration returns 404 for anything the caller may not know about."],
  ["Invitation", "Hashed token + expiry + use limit", "The plaintext token is shown to the host once. The database stores only SHA-256. Default expiry 24 hours, default max_uses 1, optional argon2id passphrase, and revocation takes effect on live sockets."],
  ["Socket", "Short-lived ticket", "The WebSocket is authenticated by a 60-second JWT scoped to one room and one role, so a leaked URL is not a leaked session."],
  ["Media", "HMAC-signed, 120-second URLs", "Signature covers the object key, room id, session id, expiry, and client IP prefix. Object storage is never publicly reachable."],
  ["Storage", "Per-owner prefixes + SSE", "Keys are u/<user_id>/… so cross-tenant reads require a forged signature, not just a guessed id. Server-side encryption is on."],
];

const signing = `# minting (API, on GET /api/rooms/:id/playback-urls)
exp  = now + 120s
msg  = f"{object_key}|{room_id}|{session_id}|{exp}|{ip_prefix}"
sig  = base64url(hmac_sha256(MEDIA_SIGNING_KEY, msg))
url  = f"https://partmov.example/media/{object_key}?e={exp}&s={session_id}&r={room_id}&sig={sig}"

# verifying (media gate, per segment request)
1. exp has not passed                     → else 403 expired
2. sig matches recomputed HMAC            → else 403 bad_signature
3. session is an active participant of room → else 403 not_in_room
4. room.status = 'active' and asset not taken down → else 403 unavailable
5. ip_prefix matches /24 (v4) or /48 (v6) → else 403 moved
6. proxy the byte range from MinIO; never redirect to a storage URL

# rotation: two signing keys are live at once (current + previous) so key
# rotation never invalidates a film that is already playing.`;

const abuse = [
  ["Upload validation", "ffprobe must find a decodable video stream; container must be in an allowlist (mkv, mp4, mov, webm, avi, ts); declared size and SHA-256 must match the received bytes; anything else is deleted, not quarantined."],
  ["Dangerous input", "FFmpeg runs in a container with no network, a read-only root filesystem, a dropped capability set, a memory ceiling, and a wall-clock timeout. Protocol whitelisting is enabled so a crafted file cannot make FFmpeg fetch a remote URL."],
  ["Archive and script tricks", "Content type is decided by probing, never by extension or client-supplied MIME. Filenames are regenerated as UUIDs, so path traversal and double-extension tricks have no surface."],
  ["Storage abuse", "Per-account quota and per-file size cap, enforced before the tus endpoint is issued and re-checked on completion."],
  ["Link brute force", "Tokens are 132 bits of entropy. Join attempts are limited to 5 per IP per minute and 20 per room per hour, and a room locks joins for 15 minutes after 10 failures."],
  ["Traffic abuse", "Per-session segment request ceiling based on the film's real bitrate: a client that requests far more than realtime is scraping, and gets throttled then blocked."],
  ["Chat abuse", "Length caps, per-participant rate limits, and no link unfurling. In a two-person room the honest remedy is that either person can close the room instantly."],
];

export default function SecurityPage() {
  return (
    <>
      <PageHead
        eyebrow="Privacy and security"
        title="Private by construction, not by setting"
        lede="There is no privacy toggle in Partmov because there is nothing public to turn off. Rooms are unlisted, links expire, media URLs live for two minutes, and the analytics measure the player rather than the people."
      />

      <Section eyebrow="Layers" title="Six layers of access control" flush>
        <Table head={["Layer", "Mechanism", "Detail"]} rows={layers} />
      </Section>

      <Section
        eyebrow="Signed delivery"
        title="How a segment request is authorised"
        lede="Every media byte passes a gate that knows which room and which session asked for it. Storage credentials never leave the server side."
      >
        <div className="stack stack--md">
          <Code label="HMAC signing and verification">{signing}</Code>
          <List
            items={[
              <>
                <strong>Why not presigned S3 URLs?</strong> A presigned MinIO URL is valid for its whole TTL to
                anyone who holds it and cannot be revoked. A gate can check room membership, takedown status, and
                revocation on every single request.
              </>,
              <>
                <strong>Stopping casual downloads.</strong> Segment URLs are short-lived and IP-prefix bound, and
                the master playlist is signed separately. Someone determined can still reassemble segments they
                are authorised to watch — that is true of every non-DRM player on the web, and the design says so
                rather than pretending otherwise.
              </>,
              <>
                <strong>Where DRM would fit.</strong> If licensed catalogue content ever requires it, the path is
                Widevine or PlayReady with an open-source licence server such as Shaka Packager plus an EME
                integration. It costs a per-title packaging step, browser-specific failure modes, and — decisively
                — the loss of fine-grained playback control on some platforms, which is the product&rsquo;s core
                promise. So DRM stays out until a contract requires it, and never applies to user uploads.
              </>,
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow="Isolation and deletion"
        title="Content stays with its owner, and leaves when told"
      >
        <div className="stack stack--md">
          <List
            items={[
              <>
                <strong>Structural isolation.</strong> Object keys embed the owner id, every asset query is scoped
                by <code>owner_id</code>, and the media gate re-derives ownership from the room rather than
                trusting the request.
              </>,
              <>
                <strong>Deletion is a pipeline, not a flag.</strong> <code>DELETE /api/assets/:id</code> marks the
                asset <code>deleting</code>, closes dependent rooms with <code>reason: asset_removed</code>,
                revokes their invitations, then a purge worker deletes the originals prefix, the renditions
                prefix, subtitle objects, poster, and sprites — verifying with a list call that zero objects
                remain before writing <code>asset.purged</code> to the audit log.
              </>,
              <>
                <strong>Backups respect deletion.</strong> Media backups are prefix-synchronised with{" "}
                <code>mc mirror --remove</code>, so a purge propagates. Database backups older than the purge are
                the only place a title reference survives, and they age out on a 30-day schedule.
              </>,
              <>
                <strong>Account deletion.</strong> Cascades to assets, rooms, invitations, and sessions;
                enqueues purge jobs for every prefix; and leaves behind only anonymised audit rows with a null
                actor.
              </>,
            ]}
          />
          <Callout>
            The verification step matters. A purge that does not confirm an empty prefix is a promise, not a
            deletion — so the job fails loudly and retries rather than reporting success.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="Abuse prevention"
        title="Rejecting bad input before it becomes a problem"
      >
        <Table head={["Vector", "Control"]} rows={abuse} />
      </Section>

      <Section
        eyebrow="Analytics"
        title="Measure the playback, not the person"
        lede="Every metric below describes the system's behaviour. None of them describe what someone watched, when they watched it, or with whom."
      >
        <div className="stack stack--md">
          <Table
            head={["Metric", "Type", "Target"]}
            rows={[
              ["partmov_startup_ms", "histogram", "p95 under 2.5 s from room open to first frame"],
              ["partmov_rebuffer_ratio", "gauge", "under 0.5 percent of watch time"],
              ["partmov_sync_drift_ms", "histogram", "p95 under 120 ms, p99 under 400 ms"],
              ["partmov_room_join_success", "counter pair", "over 99 percent of valid invites join on first attempt"],
              ["partmov_rate_nudge_seconds", "counter", "how long clients spend correcting — a proxy for network health"],
              ["partmov_hard_seek_total", "counter", "should stay near zero; every one is a visible artefact"],
              ["partmov_transcode_duration_ms", "histogram", "per rung, to size worker capacity"],
              ["partmov_ws_reconnects_total", "counter", "by reason, to catch proxy timeout regressions"],
            ]}
          />
          <List
            items={[
              "No third-party scripts, no advertising or analytics SDKs, no fingerprinting, no cross-site cookies.",
              "Access logs store an IP prefix rather than a full address, and are dropped after 14 days.",
              "Metric labels are bounded: room and user ids never become label values, so cardinality stays flat and dashboards cannot become a viewing history.",
              "Client telemetry is aggregate-first: the browser reports buffer and drift numbers, never a list of titles.",
            ]}
          />
          <Callout>
            <strong>Threat model, stated plainly.</strong> Partmov defends against link leakage, room
            enumeration, cross-tenant reads, direct storage access, casual scraping, and operator over-collection.
            It does not defend against a participant recording their own screen, and it does not claim to.
          </Callout>
        </div>
      </Section>

      <Pager current="/security" />
    </>
  );
}

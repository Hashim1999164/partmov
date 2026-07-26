import type { Metadata } from "next";
import { RoomMock } from "@/components/RoomMock";
import { Callout, Flow, KeyValues, List, PageHead, Pager, Section, Table } from "@/components/primitives";

export const metadata: Metadata = {
  title: "Product",
  description:
    "Partmov product definition: who it is for, the end-to-end user flow, room roles, and the interface principles behind a shared cinema for two.",
};

const flow = [
  {
    title: "Host signs in with a link",
    body: "Email address in, magic link out, signed session cookie back. No password, no social login, no profile to fill in. The account exists to own media and rooms, nothing more.",
  },
  {
    title: "Host adds a film",
    body: "A resumable upload streams the original file into private object storage. The client shows probe results within seconds — container, duration, video and audio streams, embedded subtitle tracks — and the transcode job is queued immediately.",
  },
  {
    title: "The pipeline prepares the title",
    body: "FFmpeg produces three renditions and an HLS master playlist, extracts subtitles into WebVTT, grabs a poster frame, and builds a sprite sheet for scrub previews. The title becomes playable when the lowest rung finishes, and quality rungs light up as they land.",
  },
  {
    title: "Host creates a room and invites one person",
    body: "A room is bound to exactly one title and one invite link. The link carries a random 22-character token, an expiry, a use limit of one, and optionally a passphrase. Nothing about the room is discoverable.",
  },
  {
    title: "Guest joins and both arm playback",
    body: "The guest opens the link, picks a display name, and lands in the room. Each client fetches signed manifest URLs, buffers the first segments, and reports readiness. The room shows a calm 'ready when you are' state rather than autoplaying into a stall.",
  },
  {
    title: "Start together",
    body: "The host presses play. The server schedules a start timestamp roughly 400 ms in the future and broadcasts it. Both players seek to the same position and unpause on that shared instant.",
  },
  {
    title: "Watch, drift, correct, recover",
    body: "Every second each client reports its position and buffer health. The server answers with the authoritative position. Small gaps close through rate nudges; a rebuffer on one side triggers an optional courtesy pause for both, which is the default for two-person rooms.",
  },
  {
    title: "Leave and come back",
    body: "Closing the tab does not destroy the room. Position, subtitle choice, and audio track persist. Reopening the link resumes from the stored position with the same roles.",
  },
];

const roles = [
  {
    k: "Host",
    v: "Owns the room and the asset. Can play, pause, seek, change subtitle and audio tracks, adjust rate, hand over the remote, revoke the invite, and end the room.",
  },
  {
    k: "Guest",
    v: "Can always pause for both and change their own volume and quality. Seeking and track changes are gated unless the host enables shared control.",
  },
  {
    k: "Shared control",
    v: "A single room-level toggle. When on, both participants hold the same command rights and the server resolves conflicts by monotonic sequence number, last write wins.",
  },
  {
    k: "Remote handover",
    v: "The host can pass control to the guest without leaving; the room records the change in its audit trail and the status line updates for both.",
  },
];

const ui = [
  ["Stage", "The player fills the viewport with no chrome over the picture. Controls fade after three idle seconds and return on pointer move, tap, or key press."],
  ["Status line", "One row, always truthful: who holds the remote, whether both people are connected, and the current sync delta in milliseconds."],
  ["Control strip", "Pause for both, timeline with buffered range, subtitle and audio menus, quality override, volume. Nothing else."],
  ["Companion rail", "Collapsed by default. Holds chat and six reactions. Opening it shrinks the stage rather than covering it."],
  ["Interstitials", "Join, ready, rebuffer, and reconnect states are full-width whispers under the player, never modal dialogs that block the film."],
];

export default function ProductPage() {
  return (
    <>
      <PageHead
        eyebrow="Product"
        title="Built for two people and one film"
        lede="Partmov is not a streaming catalogue and not a video call with a player bolted on. It is a room that two people enter to watch one thing at the same time, and it optimises for that single case."
      />

      <Section
        eyebrow="Concept"
        title="What the product actually promises"
        flush
      >
        <div className="stack stack--md">
          <div className="prose">
            <p>
              The promise is narrow and testable: <strong>both viewers see the same frame within a few tens of
              milliseconds</strong>, playback starts together, and when one connection stumbles the recovery is
              handled by the platform rather than by two people typing &ldquo;wait, where are you?&rdquo;
            </p>
            <p>
              Everything else is subordinate. There is no feed, no recommendation engine, no public rooms, no
              follower graph. A room holds one title, two people, and a shared clock. That constraint is what
              makes the sync problem tractable and the privacy story honest.
            </p>
          </div>
          <Callout>
            Design test used throughout: if a feature does not make the two people more synchronised, more
            private, or more comfortable, it does not ship.
          </Callout>
        </div>
      </Section>

      <Section
        eyebrow="User flow"
        title="From empty account to shared film"
        lede="Eight steps, none of which require the guest to create an account or install anything."
      >
        <Flow steps={flow} />
      </Section>

      <Section
        eyebrow="Roles"
        title="Who can do what"
        lede="Two roles keep the permission model small enough to reason about, and the control model explicit enough that nobody fights over the remote."
      >
        <KeyValues items={roles} />
      </Section>

      <Section
        eyebrow="Interface"
        title="Five surfaces, one job each"
        lede="The room is quiet on purpose. Warm charcoal, ivory type, a single copper accent, and transitions measured in fractions of a second."
      >
        <div className="stack stack--md">
          <RoomMock />
          <Table head={["Surface", "Behaviour"]} rows={ui} />
          <List
            items={[
              <>
                <strong>Palette</strong> — background <code>#0B0A09</code>, text <code>#F3EDE4</code>, accent{" "}
                <code>#C4A484</code>, healthy-sync indicator <code>#86AB9D</code>, attention state{" "}
                <code>#D9A95C</code>. Nothing brighter than the film.
              </>,
              <>
                <strong>Motion</strong> — 200 ms fades for controls, 400 ms for rail expansion, no bounce, no
                parallax. Every animation respects <code>prefers-reduced-motion</code>.
              </>,
              <>
                <strong>Typography</strong> — an expressive serif for titles and a humanist sans for interface
                text, so the product reads like a cinema and not like a dashboard.
              </>,
              <>
                <strong>Mobile</strong> — the same room in portrait: stage on top, status line beneath, control
                strip as a bottom sheet, rail as a full-height drawer. Landscape goes edge to edge.
              </>,
            ]}
          />
        </div>
      </Section>

      <Section
        eyebrow="Non-goals"
        title="What Partmov deliberately is not"
      >
        <List
          items={[
            "Not a public catalogue. There is no browse page, no search across other people's libraries, and no shared index.",
            "Not a social network. Chat exists because pausing to type a full message is worse than a two-word reaction; it is not a feed.",
            "Not a rooms-for-twenty product. Group watch changes the sync trade-offs and the moderation surface, so it stays out of scope.",
            "Not a piracy tool. Uploads are private to the uploader, links are single-use, and takedown tooling exists from day one.",
            "Not DRM-first. Access control, expiring URLs, and audit logs cover self-owned files; DRM only enters if a licensor contractually demands it.",
          ]}
        />
      </Section>

      <Pager current="/product" />
    </>
  );
}

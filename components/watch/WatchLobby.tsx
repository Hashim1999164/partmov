"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CATALOG, createRoomCode, normalizeRoomCode } from "@/lib/catalog";
import { COLOR_CHIPS } from "@/lib/sync-protocol";

function loadPrefName() {
  if (typeof window === "undefined") return "You";
  return localStorage.getItem("partmov:pref:name") || "You";
}

function loadPrefColor() {
  if (typeof window === "undefined") return COLOR_CHIPS[0];
  return localStorage.getItem("partmov:pref:color") || COLOR_CHIPS[0];
}

export function WatchLobby() {
  const router = useRouter();
  const [name, setName] = useState("You");
  const [color, setColor] = useState<string>(COLOR_CHIPS[0]);
  const [joinCode, setJoinCode] = useState("");
  const [mediaId, setMediaId] = useState<string | "later">(CATALOG[0]?.id ?? "later");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setName(loadPrefName());
    setColor(loadPrefColor());
    setHydrated(true);
  }, []);

  function persistIdentity(who: string, chip: string) {
    localStorage.setItem("partmov:pref:name", who);
    localStorage.setItem("partmov:pref:color", chip);
  }

  function startRoom() {
    const code = createRoomCode();
    const who = name.trim() || "Host";
    persistIdentity(who, color);
    sessionStorage.setItem(`partmov:name:${code}`, who);
    sessionStorage.setItem(`partmov:role:${code}`, "host");
    sessionStorage.setItem(`partmov:color:${code}`, color);
    if (mediaId !== "later") sessionStorage.setItem(`partmov:media:${code}`, mediaId);
    router.push(`/watch/${code}`);
  }

  function joinRoom(e: React.FormEvent) {
    e.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (!code) return;
    const who = name.trim() || "Guest";
    persistIdentity(who, color);
    sessionStorage.setItem(`partmov:name:${code}`, who);
    sessionStorage.setItem(`partmov:role:${code}`, "guest");
    sessionStorage.setItem(`partmov:color:${code}`, color);
    router.push(`/watch/${code}?as=guest`);
  }

  return (
    <div className="watch-lobby shell">
      <header className="watch-lobby__hero">
        <span className="eyebrow">Try it live</span>
        <h1>Open a private cinema for two</h1>
        <p className="lede">
          No accounts. Choose a name and color, pick an open-source film (or bring your own later), then invite your
          partner. Sync stays on the wire — the film lives on each device for the session.
        </p>
      </header>

      <div className="watch-lobby__grid">
        <article className="watch-lobby__card">
          <div className="watch-lobby__poster-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="watch-lobby__poster"
              src={
                mediaId === "later"
                  ? CATALOG[0]?.poster
                  : CATALOG.find((f) => f.id === mediaId)?.poster ?? CATALOG[0]?.poster
              }
              alt=""
            />
          </div>
          <div className="watch-lobby__film">
            <span className="eyebrow">Opening film</span>
            <h2>
              {mediaId === "later"
                ? "Choose later in the room"
                : CATALOG.find((f) => f.id === mediaId)?.title ?? "Catalog"}
            </h2>
            <p>
              {mediaId === "later"
                ? "Host can load a catalog title, paste a public URL, or send a local file over WebRTC."
                : CATALOG.find((f) => f.id === mediaId)?.blurb}
            </p>
          </div>
        </article>

        <div className="watch-lobby__forms stack stack--md">
          <label className="watch-field">
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              placeholder="Ayla"
            />
          </label>

          <div className="watch-field">
            <span>Color</span>
            <div className="color-chips">
              {COLOR_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-chip${color === c ? " is-on" : ""}`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          <div className="watch-field">
            <span>Initial media (host)</span>
            <select
              value={mediaId}
              onChange={(e) => setMediaId(e.target.value as string | "later")}
              disabled={!hydrated}
            >
              {CATALOG.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
              <option value="later">Choose later in room</option>
            </select>
          </div>

          <div className="watch-lobby__panel">
            <h3>Start as host</h3>
            <p>You hold the remote. Share the invite when the room is ready.</p>
            <button type="button" className="btn btn--primary" onClick={startRoom}>
              Start private room
            </button>
          </div>

          <form className="watch-lobby__panel" onSubmit={joinRoom}>
            <h3>Join with a code</h3>
            <p>Prefer the invite link if you have it — or type the code here.</p>
            <label className="watch-field">
              <span>Room code</span>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="dusk-42"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <button type="submit" className="btn btn--ghost">
              Enter room
            </button>
          </form>

          <p className="watch-lobby__note">
            Tip: open two tabs to demo sync. Catalog films and public URLs load on each device; local files transfer
            peer-to-peer.
          </p>
        </div>
      </div>
    </div>
  );
}

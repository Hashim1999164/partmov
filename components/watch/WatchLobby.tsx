"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SAMPLE_FILM, createRoomCode, normalizeRoomCode } from "@/lib/sample";

export function WatchLobby() {
  const router = useRouter();
  const [name, setName] = useState("You");
  const [joinCode, setJoinCode] = useState("");

  function startRoom() {
    const code = createRoomCode();
    const who = name.trim() || "Host";
    sessionStorage.setItem(`partmov:name:${code}`, who);
    sessionStorage.setItem(`partmov:role:${code}`, "host");
    router.push(`/watch/${code}`);
  }

  function joinRoom(e: React.FormEvent) {
    e.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (!code) return;
    const who = name.trim() || "Guest";
    sessionStorage.setItem(`partmov:name:${code}`, who);
    sessionStorage.setItem(`partmov:role:${code}`, "guest");
    router.push(`/watch/${code}?as=guest`);
  }

  return (
    <div className="watch-lobby shell">
      <header className="watch-lobby__hero">
        <span className="eyebrow">Try it live</span>
        <h1>Open a private cinema for two</h1>
        <p className="lede">
          No accounts. Pick a name, start a room, send the invite link to your partner. You will both watch{" "}
          <strong>{SAMPLE_FILM.title}</strong> — a free open-source short film — kept roughly in sync.
        </p>
      </header>

      <div className="watch-lobby__grid">
        <article className="watch-lobby__card">
          <div className="watch-lobby__poster-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="watch-lobby__poster"
              src={SAMPLE_FILM.poster}
              alt={`${SAMPLE_FILM.title} poster`}
            />
          </div>
          <div className="watch-lobby__film">
            <span className="eyebrow">Tonight&apos;s film</span>
            <h2>{SAMPLE_FILM.title}</h2>
            <p>
              {SAMPLE_FILM.blurb} {SAMPLE_FILM.durationLabel} · {SAMPLE_FILM.license}.
            </p>
          </div>
        </article>

        <div className="watch-lobby__forms stack stack--md">
          <label className="watch-field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Ayla" />
          </label>

          <div className="watch-lobby__panel">
            <h3>Start as host</h3>
            <p>You hold the remote. Your partner joins with the invite link.</p>
            <button type="button" className="btn btn--primary" onClick={startRoom}>
              Start private room
            </button>
          </div>

          <form className="watch-lobby__panel" onSubmit={joinRoom}>
            <h3>Join with a code</h3>
            <p>If they already sent you a link, open that instead. Or type the code here.</p>
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
            Tip for a quick test: open this page twice (two tabs). Start a room in one, paste the invite into the
            other. Sync works across tabs and across devices.
          </p>
        </div>
      </div>
    </div>
  );
}

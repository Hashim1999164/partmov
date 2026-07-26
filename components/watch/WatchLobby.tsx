"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createRoomCode, normalizeRoomCode } from "@/lib/catalog";
import { readFileWithProgress, stashPendingMedia } from "@/lib/pending-media";
import { clearRoomEnded } from "@/lib/session-storage";
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
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [prepPct, setPrepPct] = useState<number | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
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

  async function startRoom() {
    if (!videoFile || starting) return;
    setPrepError(null);
    setStarting(true);
    setPrepPct(0);
    try {
      // Real read progress before the room exists (IndexedDB stash).
      await readFileWithProgress(videoFile, setPrepPct);
      if (subtitleFile) {
        setPrepPct(96);
        await readFileWithProgress(subtitleFile, (p) => setPrepPct(96 + Math.round(p * 0.04)));
      }
      const code = createRoomCode();
      const who = name.trim() || "Host";
      persistIdentity(who, color);
      clearRoomEnded(code);
      sessionStorage.setItem(`partmov:name:${code}`, who);
      sessionStorage.setItem(`partmov:role:${code}`, "host");
      sessionStorage.setItem(`partmov:color:${code}`, color);
      sessionStorage.setItem(`partmov:media:${code}`, "file");
      await stashPendingMedia(code, {
        video: videoFile,
        subtitle: subtitleFile ?? undefined,
        title: videoFile.name.replace(/\.[^.]+$/, "") || "Local film",
      });
      setPrepPct(100);
      router.push(`/watch/${code}`);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : "Could not prepare the video");
      setStarting(false);
      setPrepPct(null);
    }
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

  const canStart = Boolean(videoFile) && !starting && hydrated;

  return (
    <div className="watch-lobby shell">
      <header className="watch-lobby__hero">
        <span className="eyebrow">Try it live</span>
        <h1>Open a private cinema for two</h1>
        <p className="lede">
          Choose a video on your device first (subtitles optional). The room opens only after that file is ready —
          your partner receives the same film peer-to-peer, and you keep the remote.
        </p>
      </header>

      <div className="watch-lobby__grid">
        <article className="watch-lobby__card">
          <div className="watch-lobby__poster-wrap watch-lobby__poster-wrap--upload">
            {videoFile ? (
              <div className="watch-lobby__file-preview">
                <strong>{videoFile.name}</strong>
                <span>{(videoFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                {subtitleFile ? <span>Subtitles: {subtitleFile.name}</span> : null}
              </div>
            ) : (
              <div className="watch-lobby__file-preview watch-lobby__file-preview--empty">
                <strong>Select a video to begin</strong>
                <span>MP4 or WebM · stays on your devices</span>
              </div>
            )}
          </div>
          <div className="watch-lobby__film">
            <span className="eyebrow">Session media</span>
            <h2>{videoFile ? videoFile.name.replace(/\.[^.]+$/, "") : "No video selected"}</h2>
            <p>
              Upload is required before a room is created. When you change the film later, everyone waits until the
              new file finishes transferring — then the old one is wiped.
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

          <div className="watch-lobby__panel">
            <h3>Start as host</h3>
            <p>Pick the film first. The invite opens only after preparation finishes.</p>

            <label className="btn btn--ghost sheet__file">
              {videoFile ? "Change video" : "Select video"}
              <input
                type="file"
                accept="video/mp4,video/webm,video/ogg,.mp4,.webm,.mov"
                hidden
                disabled={starting}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setVideoFile(f);
                  setPrepError(null);
                  e.target.value = "";
                }}
              />
            </label>

            <label className="btn btn--ghost sheet__file">
              {subtitleFile ? "Change subtitles" : "Add subtitles (optional)"}
              <input
                type="file"
                accept=".vtt,.srt,text/vtt"
                hidden
                disabled={starting}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setSubtitleFile(f);
                  e.target.value = "";
                }}
              />
            </label>

            {prepPct !== null && (
              <div className="transfer-bar">
                <span>Preparing upload… {prepPct}%</span>
                <div className="transfer-bar__track">
                  <i style={{ width: `${prepPct}%` }} />
                </div>
              </div>
            )}

            {prepError && <p className="rail-panel__error">{prepError}</p>}

            <button type="button" className="btn btn--primary" onClick={() => void startRoom()} disabled={!canStart}>
              {starting ? "Preparing…" : "Start private room"}
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
            Tip: open two tabs to demo sync. Local files transfer peer-to-peer — nothing is stored on Partmov’s
            servers for this demo path.
          </p>
        </div>
      </div>
    </div>
  );
}

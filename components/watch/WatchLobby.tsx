"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BROWSE_PRESETS, browseTitleFromUrl, normalizeBrowseUrl, siteLikelyBlocksEmbed } from "@/lib/browse";
import { createRoomCode, normalizeRoomCode } from "@/lib/catalog";
import { materializeFile, stashPendingMedia } from "@/lib/pending-media";
import { clearAllRoomEnded, clearRoomEnded } from "@/lib/session-storage";
import { COLOR_CHIPS } from "@/lib/sync-protocol";
import { ensureR2UnloadGuard, useActiveR2UploadJob, useR2UploadUnloadGuard } from "@/lib/r2-upload-job";
import { r2Status } from "@/lib/r2-client";
import { TransferDock } from "./TransferDock";
import type { TransferProgress } from "@/hooks/useRoomMedia";

function loadPrefName() {
  if (typeof window === "undefined") return "You";
  return localStorage.getItem("partmov:pref:name") || "You";
}

function loadPrefColor() {
  if (typeof window === "undefined") return COLOR_CHIPS[0];
  return localStorage.getItem("partmov:pref:color") || COLOR_CHIPS[0];
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExt(name: string) {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toUpperCase() : "FILE";
}

export function WatchLobby() {
  const router = useRouter();
  const videoInputId = useId();
  const subInputId = useId();
  const videoInputRef = useRef<HTMLInputElement>(null);
  const subInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("You");
  const [color, setColor] = useState<string>(COLOR_CHIPS[0]);
  const [joinCode, setJoinCode] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [prepPct, setPrepPct] = useState<number | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [importing, setImporting] = useState<"video" | "subtitle" | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sourceMode, setSourceMode] = useState<"file" | "browse">("file");
  const [browseUrl, setBrowseUrl] = useState("https://www.netflix.com/");
  const [browsePreset, setBrowsePreset] = useState("netflix");

  useEffect(() => {
    setName(loadPrefName());
    setColor(loadPrefColor());
    setHydrated(true);
    clearAllRoomEnded();
    ensureR2UnloadGuard();
  }, []);

  useR2UploadUnloadGuard();
  const activeUpload = useActiveR2UploadJob();
  const lobbyTransfer: TransferProgress = activeUpload
    ? {
        transferId: `r2-job-${activeUpload.code}`,
        fileName: activeUpload.fileName,
        kind: "video",
        pct: activeUpload.pct,
        direction: "send",
        phase: activeUpload.status === "finalizing" || activeUpload.phase === "finalizing" ? "finalizing" : "sending",
        bytesLoaded: activeUpload.bytesLoaded,
        bytesTotal: activeUpload.bytesTotal,
        startedAt: activeUpload.startedAt,
        via: "r2",
      }
    : null;

  function persistIdentity(who: string, chip: string) {
    localStorage.setItem("partmov:pref:name", who);
    localStorage.setItem("partmov:pref:color", chip);
  }

  async function importVideo(raw: File) {
    if (!raw.type.startsWith("video/") && !/\.(mp4|webm|ogg|mov)$/i.test(raw.name)) {
      setPrepError("Choose a video file (.mp4, .webm, or .mov).");
      return;
    }
    setPrepError(null);
    setImporting("video");
    setPrepPct(0);
    try {
      const durable = await materializeFile(raw, setPrepPct);
      setVideoFile(durable);
      setPrepPct(null);
    } catch (err) {
      setVideoFile(null);
      setPrepPct(null);
      setPrepError(err instanceof Error ? err.message : "Could not read that video");
    } finally {
      setImporting(null);
    }
  }

  async function importSubtitle(raw: File) {
    if (!/\.(vtt|srt)$/i.test(raw.name) && !/text\/vtt|subrip/i.test(raw.type)) {
      setPrepError("Subtitles must be .vtt or .srt.");
      return;
    }
    setPrepError(null);
    setImporting("subtitle");
    try {
      const durable = await materializeFile(raw);
      setSubtitleFile(durable);
    } catch (err) {
      setSubtitleFile(null);
      setPrepError(err instanceof Error ? err.message : "Could not read those subtitles");
    } finally {
      setImporting(null);
    }
  }

  async function startRoom() {
    if (starting || importing) return;
    if (sourceMode === "browse") {
      const url = normalizeBrowseUrl(browseUrl);
      if (!url) {
        setPrepError("Enter a valid http(s) website URL.");
        return;
      }
      setPrepError(null);
      setStarting(true);
      try {
        const code = createRoomCode();
        const who = name.trim() || "Host";
        persistIdentity(who, color);
        clearRoomEnded(code);
        const { openRoom } = await import("@/lib/r2-client");
        await openRoom(code, who);
        sessionStorage.setItem(`partmov:name:${code}`, who);
        sessionStorage.setItem(`partmov:role:${code}`, "host");
        sessionStorage.setItem(`partmov:color:${code}`, color);
        sessionStorage.setItem(`partmov:media:${code}`, "browse");
        sessionStorage.setItem(`partmov:browseUrl:${code}`, url);
        router.push(`/watch/${code}`);
      } catch (err) {
        setPrepError(err instanceof Error ? err.message : "Could not open the room");
        setStarting(false);
      }
      return;
    }

    if (!videoFile) return;
    setPrepError(null);
    setStarting(true);
    setPrepPct(0);
    try {
      const status = await r2Status();
      if (!status.enabled) {
        throw new Error(
          "Cloud storage is not ready. Films upload to R2 first, then stream — check R2 env on the server.",
        );
      }

      const { startR2UploadJob } = await import("@/lib/r2-upload-job");
      const { openRoom } = await import("@/lib/r2-client");
      const code = createRoomCode();
      const who = name.trim() || "Host";
      const title = videoFile.name.replace(/\.[^.]+$/, "") || "Local film";
      persistIdentity(who, color);
      clearRoomEnded(code);
      await openRoom(code, who);
      sessionStorage.setItem(`partmov:name:${code}`, who);
      sessionStorage.setItem(`partmov:role:${code}`, "host");
      sessionStorage.setItem(`partmov:color:${code}`, color);
      sessionStorage.setItem(`partmov:media:${code}`, "r2");
      sessionStorage.setItem(`partmov:r2Uploading:${code}`, "1");
      sessionStorage.setItem(`partmov:r2Title:${code}`, title);

      if (subtitleFile) {
        await stashPendingMedia(code, {
          video: videoFile,
          subtitle: subtitleFile,
          title,
        });
        sessionStorage.setItem(`partmov:subsPending:${code}`, "1");
      }

      ensureR2UnloadGuard();
      startR2UploadJob({
        code,
        file: videoFile,
        title,
        subtitle: subtitleFile ?? undefined,
      });

      // Enter the room immediately — upload continues in the background.
      setPrepPct(null);
      router.push(`/watch/${code}`);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : "Could not start cloud upload");
      setStarting(false);
      setPrepPct(null);
    }
  }

  async function joinRoom(e: React.FormEvent) {
    e.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (!code) return;
    setPrepError(null);
    setStarting(true);
    try {
      const { checkRoomExists } = await import("@/lib/r2-client");
      const exists = await checkRoomExists(code);
      if (!exists) {
        setPrepError("That room isn’t open. Ask the host for a fresh invite, or check the code.");
        setStarting(false);
        return;
      }
      const who = name.trim() || "Guest";
      persistIdentity(who, color);
      sessionStorage.setItem(`partmov:name:${code}`, who);
      sessionStorage.setItem(`partmov:role:${code}`, "guest");
      sessionStorage.setItem(`partmov:color:${code}`, color);
      router.push(`/watch/${code}?as=guest`);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : "Could not check that room");
      setStarting(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (starting || importing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void importVideo(file);
  }

  const busy = starting || Boolean(importing);
  const browseNormalized = normalizeBrowseUrl(browseUrl);
  const canStart =
    hydrated &&
    !busy &&
    (sourceMode === "browse" ? Boolean(browseNormalized) : Boolean(videoFile));
  const title = videoFile ? videoFile.name.replace(/\.[^.]+$/, "") : null;
  const selectedPreset = BROWSE_PRESETS.find((p) => p.id === browsePreset);
  const browseBlocks = browseNormalized ? siteLikelyBlocksEmbed(browseNormalized) : false;

  return (
    <div className="watch-lobby shell">
      <header className="watch-lobby__hero">
        <span className="eyebrow">Try it live</span>
        <h1>Open a private cinema for two</h1>
        <p className="lede">
          Upload a film, open the room right away, and let the cloud upload finish in the background. Invite your
          partner and keep the remote — progress stays visible while you wait.
        </p>
      </header>

      <div className="watch-lobby__grid">
        <section className="upload-form" aria-labelledby="upload-form-title">
          <div className="upload-form__head">
            <span className="eyebrow">Step 1</span>
            <h2 id="upload-form-title">Choose what to watch</h2>
            <p>Local film on your devices, or a website opened in a lightweight co-browse frame.</p>
          </div>

          <div className="source-tabs" role="tablist" aria-label="Media source">
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === "file"}
              className={`source-tabs__btn${sourceMode === "file" ? " is-on" : ""}`}
              onClick={() => {
                setSourceMode("file");
                setPrepError(null);
              }}
            >
              Local video
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode === "browse"}
              className={`source-tabs__btn${sourceMode === "browse" ? " is-on" : ""}`}
              onClick={() => {
                setSourceMode("browse");
                setPrepError(null);
              }}
            >
              Website
            </button>
          </div>

          {sourceMode === "file" ? (
            <>
              <div
                className={`upload-drop${dragOver ? " is-drag" : ""}${videoFile ? " has-file" : ""}${busy ? " is-busy" : ""}`}
                onDragEnter={(e) => {
                  e.preventDefault();
                  if (!busy) setDragOver(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!busy) setDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  if (e.currentTarget === e.target) setDragOver(false);
                }}
                onDrop={onDrop}
              >
                <input
                  ref={videoInputRef}
                  id={videoInputId}
                  type="file"
                  accept="video/mp4,video/webm,video/ogg,.mp4,.webm,.mov"
                  className="upload-drop__input"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    if (f) void importVideo(f);
                  }}
                />

                {!videoFile ? (
                  <label htmlFor={videoInputId} className="upload-drop__empty">
                    <span className="upload-drop__icon" aria-hidden>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M12 16V4m0 0l-4 4m4-4l4 4M4 16.5V18a2 2 0 002 2h12a2 2 0 002-2v-1.5"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <strong>{importing === "video" ? "Reading video…" : "Drop a video here"}</strong>
                    <span>or click to browse your files</span>
                    <span className="upload-drop__hint">Uploads to R2 cloud storage · then streams in the room</span>
                  </label>
                ) : (
                  <div className="upload-file">
                    <div className="upload-file__badge" aria-hidden>
                      {fileExt(videoFile.name)}
                    </div>
                    <div className="upload-file__meta">
                      <strong title={videoFile.name}>{title}</strong>
                      <span>
                        {videoFile.name} · {formatBytes(videoFile.size)}
                        {videoFile.type ? ` · ${videoFile.type}` : ""}
                      </span>
                    </div>
                    <div className="upload-file__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => videoInputRef.current?.click()}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => {
                          setVideoFile(null);
                          setSubtitleFile(null);
                          setPrepError(null);
                          setPrepPct(null);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}

                {prepPct !== null && (
                  <div className="upload-progress" role="status" aria-live="polite">
                    <div className="upload-progress__row">
                      <span>{importing ? "Reading file" : "Preparing room"}</span>
                      <span>{prepPct}%</span>
                    </div>
                    <div className="upload-progress__track">
                      <i style={{ width: `${prepPct}%` }} />
                    </div>
                  </div>
                )}
              </div>

              <div className={`upload-sub${subtitleFile ? " has-file" : ""}`}>
                <input
                  ref={subInputRef}
                  id={subInputId}
                  type="file"
                  accept=".vtt,.srt,text/vtt"
                  className="upload-drop__input"
                  disabled={busy || !videoFile}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    if (f) void importSubtitle(f);
                  }}
                />
                {!subtitleFile ? (
                  <label
                    htmlFor={subInputId}
                    className={`upload-sub__empty${!videoFile ? " is-disabled" : ""}`}
                  >
                    <span>Add subtitles</span>
                    <em>Optional · VTT or SRT</em>
                  </label>
                ) : (
                  <div className="upload-sub__file">
                    <div>
                      <strong>{subtitleFile.name}</strong>
                      <span>{formatBytes(subtitleFile.size)}</span>
                    </div>
                    <div className="upload-file__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => subInputRef.current?.click()}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => setSubtitleFile(null)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="browse-form">
              <p className="browse-form__lede">
                Opens a shared address bar + page frame for both of you. This runs in each browser (not a remote
                Chromium on Vercel). Sites like Netflix block embedding — you’ll both open the same URL in a normal
                tab instead.
              </p>

              <div className="browse-presets" role="group" aria-label="Suggested sites">
                {BROWSE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`browse-presets__chip${browsePreset === preset.id ? " is-on" : ""}`}
                    onClick={() => {
                      setBrowsePreset(preset.id);
                      setBrowseUrl(preset.url);
                      setPrepError(null);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <label className="watch-field">
                <span>Website URL</span>
                <input
                  value={browseUrl}
                  onChange={(e) => {
                    setBrowseUrl(e.target.value);
                    setBrowsePreset("custom");
                  }}
                  placeholder="https://www.netflix.com/"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>

              {selectedPreset?.note && browsePreset === selectedPreset.id && (
                <p className="browse-form__note">{selectedPreset.note}</p>
              )}
              {browseBlocks && (
                <p className="browse-form__warn">
                  {browseTitleFromUrl(browseNormalized!)} typically blocks in-app frames. Co-browse will sync the URL
                  and offer “Open tab” for each of you.
                </p>
              )}
            </div>
          )}

          {prepError && (
            <p className="upload-form__error" role="alert">
              {prepError}
            </p>
          )}
        </section>

        <div className="watch-lobby__forms stack stack--md">
          <div className="watch-lobby__panel">
            <span className="eyebrow">Step 2</span>
            <h3>Your identity</h3>
            <p>Shown to your partner in the room.</p>

            <label className="watch-field">
              <span>Display name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                placeholder="Ayla"
                autoComplete="nickname"
              />
            </label>

            <div className="watch-field">
              <span>Accent color</span>
              <div className="color-chips" role="group" aria-label="Accent color">
                {COLOR_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`color-chip${color === c ? " is-on" : ""}`}
                    style={{ background: c }}
                    aria-label={`Color ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="watch-lobby__panel">
            <span className="eyebrow">Step 3</span>
            <h3>Start as host</h3>
            <p>
              {sourceMode === "browse"
                ? browseNormalized
                  ? `Ready to co-browse ${browseTitleFromUrl(browseNormalized)}.`
                  : "Enter a website URL first."
                : videoFile
                  ? `Ready to open a room with “${title}”. Upload continues in the background.`
                  : "Select a video first — the room opens immediately and the film uploads in the background."}
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void startRoom()}
              disabled={!canStart}
            >
              {starting
                ? "Opening room…"
                : importing
                  ? "Reading file…"
                  : sourceMode === "browse"
                    ? "Start co-browse room"
                    : "Start room — upload in background"}
            </button>
          </div>

          <form className="watch-lobby__panel" onSubmit={joinRoom}>
            <h3>Or join with a code</h3>
            <p>Have an invite? Paste the room code here.</p>
            <label className="watch-field">
              <span>Room code</span>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="dusk-42"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <button type="submit" className="btn btn--ghost" disabled={!joinCode.trim() || starting}>
              {starting ? "Checking room…" : "Enter room"}
            </button>
          </form>

          <p className="watch-lobby__note">
            Tip: the film uploads to R2 in the background after you enter. You’ll see progress in the room —
            don’t close or reload the tab until it finishes (the browser will warn you).
          </p>
        </div>
      </div>
      <TransferDock transfer={lobbyTransfer} />
    </div>
  );
}

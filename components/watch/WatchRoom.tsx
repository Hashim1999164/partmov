"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataConnection, Peer } from "peerjs";
import { SAMPLE_FILM } from "@/lib/sample";
import {
  channelName,
  formatTime,
  peerIdForHost,
  type Role,
  type SyncMessage,
} from "@/lib/sync-protocol";

type ChatLine = { id: string; name: string; body: string; at: number };
type ReactionBurst = { id: string; glyph: string; name: string };

const REACTIONS = ["♥", "👏", "🔥", "😮", "😂", "✨"] as const;
const LOCK_MS = 80;
const NUDGE_MS = 400;
const HARD_SEEK_MS = 1200;

type Props = {
  code: string;
  role: Role;
  name: string;
};

export function WatchRoom({ code, role, name }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const seqRef = useRef(0);
  const applyingRef = useRef(false);
  const lastLocalActionRef = useRef(0);

  const [partnerName, setPartnerName] = useState<string | null>(null);
  const [partnerState, setPartnerState] = useState<"waiting" | "connected" | "reconnecting">("waiting");
  const [playState, setPlayState] = useState<"paused" | "playing">("paused");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [driftMs, setDriftMs] = useState(0);
  const [linkCopied, setLinkCopied] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [reactions, setReactions] = useState<ReactionBurst[]>([]);
  const [status, setStatus] = useState("Opening the room…");
  const [error, setError] = useState<string | null>(null);

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/watch/${code}?as=guest`;
  }, [code]);

  const isHost = role === "host";

  const send = useCallback((msg: SyncMessage) => {
    channelRef.current?.postMessage(msg);
    const conn = connRef.current;
    if (conn?.open) conn.send(msg);
  }, []);

  const pushChat = useCallback((line: Omit<ChatLine, "id">) => {
    setChat((prev) => [...prev.slice(-40), { ...line, id: `${line.at}-${Math.random()}` }]);
  }, []);

  const burstReaction = useCallback((glyph: string, who: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setReactions((prev) => [...prev, { id, glyph, name: who }]);
    window.setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r.id !== id));
    }, 1600);
  }, []);

  const applyRemotePlayback = useCallback(
    (msg: Extract<SyncMessage, { type: "playback" | "seek" | "heartbeat" }>) => {
      const video = videoRef.current;
      if (!video) return;

      const now = performance.now();
      const travel = Math.max(0, (Date.now() - msg.at) / 1000);
      const target =
        msg.type === "heartbeat" || msg.state === "playing"
          ? msg.position + (msg.state === "playing" ? travel : 0)
          : msg.position;

      const local = video.currentTime;
      const drift = (local - target) * 1000;
      setDriftMs(Math.round(drift));

      applyingRef.current = true;

      if (msg.type === "seek" || Math.abs(drift) > HARD_SEEK_MS) {
        video.currentTime = Math.max(0, target);
        video.playbackRate = 1;
      } else if (Math.abs(drift) > NUDGE_MS) {
        video.playbackRate = drift < 0 ? 1.04 : 0.96;
      } else if (Math.abs(drift) > LOCK_MS) {
        video.playbackRate = drift < 0 ? 1.02 : 0.98;
      } else {
        video.playbackRate = 1;
      }

      if (msg.state === "playing" && video.paused) {
        void video.play().catch(() => undefined);
        setPlayState("playing");
      } else if (msg.state === "paused" && !video.paused) {
        video.pause();
        setPlayState("paused");
      }

      window.setTimeout(() => {
        applyingRef.current = false;
      }, 120);
      void now;
    },
    [],
  );

  const onMessage = useCallback(
    (msg: SyncMessage) => {
      if (msg.type === "hello") {
        setPartnerName(msg.name);
        setPartnerState("connected");
        setStatus(`${msg.name} joined the room`);
        send({ type: "welcome", name });
        if (isHost) {
          const video = videoRef.current;
          send({
            type: "playback",
            state: video && !video.paused ? "playing" : "paused",
            position: video?.currentTime ?? 0,
            at: Date.now(),
            seq: ++seqRef.current,
          });
        }
        return;
      }
      if (msg.type === "welcome") {
        setPartnerName(msg.name);
        setPartnerState("connected");
        setStatus(`Connected with ${msg.name}`);
        return;
      }
      if (msg.type === "partner_left") {
        setPartnerState("waiting");
        setStatus("Partner left — waiting to reconnect");
        return;
      }
      if (msg.type === "playback" || msg.type === "seek" || msg.type === "heartbeat") {
        if (isHost && msg.type === "heartbeat") return;
        if (seqRef.current && "seq" in msg && msg.seq < seqRef.current - 2 && msg.type !== "heartbeat") {
          return;
        }
        if ("seq" in msg) seqRef.current = Math.max(seqRef.current, msg.seq);
        applyRemotePlayback(msg);
        return;
      }
      if (msg.type === "chat") {
        pushChat({ name: msg.name, body: msg.body, at: msg.at });
        return;
      }
      if (msg.type === "reaction") {
        burstReaction(msg.glyph, msg.name);
      }
    },
    [applyRemotePlayback, burstReaction, isHost, pushChat, send],
  );

  // BroadcastChannel — same browser / two tabs (reliable for local demos)
  useEffect(() => {
    const channel = new BroadcastChannel(channelName(code));
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<SyncMessage>) => onMessage(event.data);
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [code, onMessage]);

  // PeerJS — cross-device partner over the internet
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { default: PeerCtor } = await import("peerjs");
        if (cancelled) return;

        const peer = isHost
          ? new PeerCtor(peerIdForHost(code), { debug: 0 })
          : new PeerCtor({ debug: 0 });
        peerRef.current = peer;

        peer.on("error", (err) => {
          const message = String(err?.type ?? err?.message ?? err);
          if (message.includes("unavailable-id") || message.includes("ID is taken")) {
            setError("That room code is already live. Ask your partner for a fresh invite, or pick a new code.");
            return;
          }
          // Peer broker flakiness is fine if BroadcastChannel is working in another tab.
          setStatus((prev) =>
            partnerState === "connected" ? prev : "Looking for your partner… (share the invite link)",
          );
        });

        peer.on("open", () => {
          if (cancelled) return;
          setStatus(isHost ? "Room ready — share the invite link" : "Connecting to host…");

          if (!isHost) {
            const conn = peer.connect(peerIdForHost(code), { reliable: true });
            wireConn(conn);
          }
        });

        if (isHost) {
          peer.on("connection", (conn) => {
            wireConn(conn);
          });
        }
      } catch {
        setStatus("Peer network unavailable — open a second tab on this device to demo sync");
      }
    }

    function wireConn(conn: DataConnection) {
      connRef.current = conn;
      conn.on("open", () => {
        setPartnerState("connected");
        send({ type: "hello", role, name });
      });
      conn.on("data", (data) => {
        onMessage(data as SyncMessage);
      });
      conn.on("close", () => {
        setPartnerState("reconnecting");
        setStatus("Connection dropped — trying to recover");
        send({ type: "partner_left" });
      });
    }

    void connect();

    // Announce on the local channel immediately so a second tab can find us
    const t = window.setTimeout(() => {
      send({ type: "hello", role, name });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      try {
        send({ type: "partner_left" });
      } catch {
        /* ignore */
      }
      connRef.current?.close();
      peerRef.current?.destroy();
      connRef.current = null;
      peerRef.current = null;
    };
    // intentionally mount-once per room identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isHost, name, role]);

  // Host heartbeats keep the guest locked
  useEffect(() => {
    if (!isHost) return;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || partnerState !== "connected") return;
      send({
        type: "heartbeat",
        position: video.currentTime,
        state: video.paused ? "paused" : "playing",
        at: Date.now(),
        seq: seqRef.current,
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isHost, partnerState, send]);

  // Guest soft-rate release when locked
  useEffect(() => {
    if (isHost) return;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (Math.abs(driftMs) <= LOCK_MS && video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [driftMs, isHost]);

  const broadcastPlayback = useCallback(
    (state: "playing" | "paused", positionOverride?: number) => {
      const video = videoRef.current;
      if (!video) return;
      const seq = ++seqRef.current;
      lastLocalActionRef.current = Date.now();
      send({
        type: "playback",
        state,
        position: positionOverride ?? video.currentTime,
        at: Date.now(),
        seq,
      });
    },
    [send],
  );

  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!isHost && partnerState === "connected") {
      // Guests may pause for both; play is host-led unless alone
    }
    if (video.paused) {
      try {
        await video.play();
        setPlayState("playing");
        broadcastPlayback("playing");
      } catch {
        setStatus("Tap play again — the browser blocked autoplay");
      }
    } else {
      video.pause();
      setPlayState("paused");
      broadcastPlayback("paused");
    }
  }, [broadcastPlayback, isHost, partnerState]);

  const onSeek = useCallback(
    (next: number) => {
      const video = videoRef.current;
      if (!video) return;
      if (!isHost) {
        setStatus("Only the host can scrub the timeline");
        return;
      }
      video.currentTime = next;
      setPosition(next);
      const seq = ++seqRef.current;
      send({
        type: "seek",
        position: next,
        state: video.paused ? "paused" : "playing",
        at: Date.now(),
        seq,
      });
    },
    [isHost, send],
  );

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      setStatus(`Copy this link: ${inviteUrl}`);
    }
  }, [inviteUrl]);

  const sendChat = useCallback(() => {
    const body = chatInput.trim();
    if (!body) return;
    const at = Date.now();
    pushChat({ name, body, at });
    send({ type: "chat", name, body, at });
    setChatInput("");
  }, [chatInput, name, pushChat, send]);

  const sendReaction = useCallback(
    (glyph: string) => {
      burstReaction(glyph, name);
      send({ type: "reaction", name, glyph, at: Date.now() });
    },
    [burstReaction, name, send],
  );

  const syncLabel =
    partnerState !== "connected"
      ? "waiting for partner"
      : Math.abs(driftMs) <= LOCK_MS
        ? "in sync"
        : Math.abs(driftMs) < HARD_SEEK_MS
          ? `nudging ${driftMs > 0 ? "+" : ""}${driftMs} ms`
          : `catching up ${driftMs > 0 ? "+" : ""}${driftMs} ms`;

  return (
    <div className="watch">
      <div className="watch__top">
        <div className="watch__meta">
          <span className="eyebrow">Private room · {code}</span>
          <h1 className="watch__title">{SAMPLE_FILM.title}</h1>
          <p className="watch__credit">
            {SAMPLE_FILM.credit} · {SAMPLE_FILM.license}
          </p>
        </div>
        <div className="watch__actions">
          {isHost && (
            <button type="button" className="btn btn--primary" onClick={copyInvite}>
              {linkCopied ? "Invite copied" : "Copy invite link"}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => setRailOpen((v) => !v)}>
            {railOpen ? "Hide chat" : "Chat & reactions"}
          </button>
        </div>
      </div>

      <div className={`watch__stage${railOpen ? " watch__stage--rail" : ""}`}>
        <div className="watch__player">
          <div className="room watch__room">
            <div className="room__bar">
              <span className="room__who">
                <span className={`dot${isHost ? " dot--copper" : ""}`} aria-hidden="true" />
                {isHost ? `${name} holds the remote` : `${partnerName ?? "Host"} holds the remote`}
              </span>
              <span className="room__who">
                <span className={`dot${partnerState === "connected" ? "" : " dot--copper"}`} aria-hidden="true" />
                {partnerState === "connected"
                  ? `${partnerName ?? "Partner"} connected · ${syncLabel}`
                  : status}
              </span>
            </div>

            <div className="watch__video-wrap">
              <video
                ref={videoRef}
                className="watch__video"
                poster={SAMPLE_FILM.poster}
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
                onError={(e) => {
                  const el = e.currentTarget;
                  if (el.dataset.fallback === "1") return;
                  el.dataset.fallback = "1";
                  el.src = SAMPLE_FILM.fallbackSrc;
                  el.poster = SAMPLE_FILM.fallbackPoster;
                  el.load();
                }}
                onPlay={() => {
                  setPlayState("playing");
                  if (!applyingRef.current && Date.now() - lastLocalActionRef.current > 80) {
                    broadcastPlayback("playing");
                  }
                }}
                onPause={() => {
                  setPlayState("paused");
                  if (!applyingRef.current && Date.now() - lastLocalActionRef.current > 80) {
                    broadcastPlayback("paused");
                  }
                }}
              >
                <source src={SAMPLE_FILM.src} type="video/mp4" />
                <source src={SAMPLE_FILM.fallbackSrc} type="video/mp4" />
              </video>
              <div className="watch__bursts" aria-hidden="true">
                {reactions.map((r) => (
                  <span key={r.id} className="watch__burst">
                    {r.glyph}
                  </span>
                ))}
              </div>
            </div>

            <div className="room__controls watch__controls">
              <button type="button" className="watch__play" onClick={togglePlay}>
                {playState === "playing" ? "Pause for both" : "Play together"}
              </button>
              <span className="mono watch__time">
                {formatTime(position)} / {formatTime(duration)}
              </span>
              <input
                className="watch__scrub"
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(position, duration || 0)}
                disabled={!isHost}
                onChange={(e) => onSeek(Number(e.target.value))}
                aria-label="Seek"
              />
              <span className="watch__sync mono">{syncLabel}</span>
            </div>
          </div>
          {error && <p className="watch__error">{error}</p>}
          <p className="watch__hint">{status}</p>
        </div>

        {railOpen && (
          <aside className="watch__rail">
            <div className="watch__rail-head">
              <span className="eyebrow">Together</span>
              <p>Soft notes while the film runs. Nothing is stored.</p>
            </div>
            <div className="watch__reactions">
              {REACTIONS.map((glyph) => (
                <button key={glyph} type="button" className="watch__reaction" onClick={() => sendReaction(glyph)}>
                  {glyph}
                </button>
              ))}
            </div>
            <div className="watch__chat">
              {chat.length === 0 && <p className="watch__chat-empty">No messages yet.</p>}
              {chat.map((line) => (
                <div key={line.id} className="watch__chat-line">
                  <strong>{line.name}</strong>
                  <span>{line.body}</span>
                </div>
              ))}
            </div>
            <form
              className="watch__chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                sendChat();
              }}
            >
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Say something quiet…"
                maxLength={200}
              />
              <button type="submit" className="btn btn--primary">
                Send
              </button>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
}

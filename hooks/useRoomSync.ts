"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DataConnection, Peer } from "peerjs";
import {
  channelName,
  peerIdForHost,
  thresholdsFor,
  type ControlMode,
  type MediaDescriptor,
  type PartnerState,
  type Role,
  type RoomSettings,
  type SyncMessage,
  DEFAULT_SETTINGS,
} from "@/lib/sync-protocol";

export type ChatLine = { id: string; name: string; body: string; at: number; color?: string };
export type ReactionBurst = { id: string; glyph: string; name: string };

type UseRoomSyncArgs = {
  code: string;
  role: Role;
  name: string;
  color: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  settings: RoomSettings;
  onSettingsFromPeer?: (s: RoomSettings) => void;
  onMediaFromPeer?: (m: MediaDescriptor) => void;
  onFileMessage?: (msg: SyncMessage) => void;
  onSubtitleFromPeer?: (trackId: string | null) => void;
  onRoomEnded?: (reason: string) => void;
};

export function useRoomSync({
  code,
  role,
  name,
  color,
  videoRef,
  settings,
  onSettingsFromPeer,
  onMediaFromPeer,
  onFileMessage,
  onSubtitleFromPeer,
  onRoomEnded,
}: UseRoomSyncArgs) {
  const isHost = role === "host";
  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const seqRef = useRef(0);
  const applyingRef = useRef(false);
  const lastLocalActionRef = useRef(0);
  const clockOffsetRef = useRef(0);
  const rttRef = useRef(80);
  const offsetSamplesRef = useRef<{ offset: number; rtt: number }[]>([]);
  const partnerReadyRef = useRef(false);
  const selfReadyRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [partnerName, setPartnerName] = useState<string | null>(null);
  const [partnerColor, setPartnerColor] = useState("#86AB9D");
  const [partnerState, setPartnerState] = useState<PartnerState>("waiting");
  const [partnerReady, setPartnerReady] = useState(false);
  const [selfReady, setSelfReady] = useState(false);
  const [playState, setPlayState] = useState<"paused" | "playing">("paused");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [driftMs, setDriftMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [controlMode, setControlMode] = useState<ControlMode>("host_only");
  const [remoteHolder, setRemoteHolder] = useState<Role>("host");
  const [status, setStatus] = useState("Opening the room…");
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [reactions, setReactions] = useState<ReactionBurst[]>([]);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [controlRequested, setControlRequested] = useState(false);

  const send = useCallback((msg: SyncMessage) => {
    try {
      channelRef.current?.postMessage(msg);
    } catch {
      /* ignore */
    }
    const conn = connRef.current;
    if (conn?.open) {
      try {
        conn.send(msg);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const pushChat = useCallback((line: Omit<ChatLine, "id">) => {
    setChat((prev) => [...prev.slice(-80), { ...line, id: `${line.at}-${Math.random()}` }]);
  }, []);

  const burstReaction = useCallback((glyph: string, who: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setReactions((prev) => [...prev, { id, glyph, name: who }]);
    window.setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), 1600);
  }, []);

  const applyRemotePlayback = useCallback(
    (msg: Extract<SyncMessage, { type: "playback" | "seek" | "heartbeat" }>) => {
      const video = videoRef.current;
      if (!video) return;
      const th = thresholdsFor(settingsRef.current.syncStrictness);

      const travel = Math.max(0, (Date.now() + clockOffsetRef.current - msg.at) / 1000);
      const target =
        msg.state === "playing" && msg.type !== "seek"
          ? msg.position + travel
          : msg.position;

      const local = video.currentTime;
      const drift = (local - target) * 1000;
      setDriftMs(Math.round(drift));

      applyingRef.current = true;

      if (msg.type === "seek" || Math.abs(drift) > th.hardSeekMs) {
        video.currentTime = Math.max(0, target);
        video.playbackRate = 1;
      } else if (Math.abs(drift) > th.coarseMs) {
        video.playbackRate = drift < 0 ? 1.05 : 0.95;
      } else if (Math.abs(drift) > th.fineMs) {
        video.playbackRate = drift < 0 ? 1.02 : 0.98;
      } else if (Math.abs(drift) > th.lockMs) {
        video.playbackRate = drift < 0 ? 1.01 : 0.99;
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
      }, 100);
    },
    [videoRef],
  );

  const scheduleStartTogether = useCallback(
    (positionSec: number) => {
      const delay = Math.max(300, rttRef.current * 1.5);
      const startAt = Date.now() + delay;
      const seq = ++seqRef.current;
      send({
        type: "playback",
        state: "playing",
        position: positionSec,
        at: Date.now(),
        seq,
        startAt,
      });

      const video = videoRef.current;
      if (video) {
        video.pause();
        video.currentTime = positionSec;
      }
      setPlayState("paused");

      const tick = () => {
        const left = startAt - Date.now();
        if (left <= 0) {
          setCountdown(null);
          if (video) {
            applyingRef.current = true;
            void video.play().catch(() => undefined);
            setPlayState("playing");
            window.setTimeout(() => {
              applyingRef.current = false;
            }, 80);
          }
          return;
        }
        setCountdown(Math.ceil(left / 1000));
        window.setTimeout(tick, 50);
      };
      tick();
    },
    [send, videoRef],
  );

  const onMessage = useCallback(
    (msg: SyncMessage) => {
      if (
        msg.type === "file_offer" ||
        msg.type === "file_chunk" ||
        msg.type === "file_done"
      ) {
        onFileMessage?.(msg);
        return;
      }

      if (msg.type === "hello") {
        setPartnerName(msg.name);
        setPartnerColor(msg.color);
        setPartnerState("connected");
        setStatus(`${msg.name} joined the room`);
        send({
          type: "welcome",
          name,
          color,
          settings: settingsRef.current,
          media: null,
          controlMode,
          remoteHolder,
        });
        if (settingsRef.current.joinSound) {
          try {
            const ctx = new AudioContext();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            o.frequency.value = 520;
            g.gain.value = 0.04;
            o.start();
            o.stop(ctx.currentTime + 0.12);
          } catch {
            /* ignore */
          }
        }
        return;
      }

      if (msg.type === "welcome") {
        setPartnerName(msg.name);
        setPartnerColor(msg.color);
        setPartnerState("connected");
        setControlMode(msg.controlMode);
        setRemoteHolder(msg.remoteHolder);
        onSettingsFromPeer?.(msg.settings);
        if (msg.media) onMediaFromPeer?.(msg.media);
        setStatus(`Connected with ${msg.name}`);
        return;
      }

      if (msg.type === "partner_left") {
        setPartnerState("waiting");
        setPartnerReady(false);
        partnerReadyRef.current = false;
        setStatus("Partner left — waiting to reconnect");
        return;
      }

      if (msg.type === "ready_state") {
        setPartnerReady(msg.ready);
        partnerReadyRef.current = msg.ready;
        return;
      }

      if (msg.type === "sync_ping") {
        send({ type: "sync_pong", t0: msg.t0, t1: Date.now(), t2: Date.now() });
        return;
      }

      if (msg.type === "sync_pong") {
        const t3 = Date.now();
        const rtt = t3 - msg.t0 - (msg.t2 - msg.t1);
        const offset = (msg.t1 - msg.t0 + (msg.t2 - t3)) / 2;
        if (rtt > 0 && rtt < 2000) {
          rttRef.current = rtt;
          offsetSamplesRef.current = [...offsetSamplesRef.current, { offset, rtt }]
            .sort((a, b) => a.rtt - b.rtt)
            .slice(0, 5);
          const samples = offsetSamplesRef.current;
          clockOffsetRef.current = samples.reduce((s, x) => s + x.offset, 0) / samples.length;
        }
        return;
      }

      if (msg.type === "playback") {
        if ("seq" in msg) seqRef.current = Math.max(seqRef.current, msg.seq);
        if (msg.startAt && msg.state === "playing") {
          const video = videoRef.current;
          const wait = msg.startAt - Date.now();
          if (video) {
            video.pause();
            video.currentTime = msg.position;
          }
          const run = () => {
            const left = msg.startAt! - Date.now();
            if (left <= 20) {
              setCountdown(null);
              applyRemotePlayback({ ...msg, startAt: undefined });
              return;
            }
            setCountdown(Math.ceil(left / 1000));
            window.setTimeout(run, 40);
          };
          run();
          return;
        }
        applyRemotePlayback(msg);
        return;
      }

      if (msg.type === "seek" || msg.type === "heartbeat") {
        if (isHost && msg.type === "heartbeat") {
          if (
            settingsRef.current.courtesyPause &&
            msg.bufferedAheadMs !== undefined &&
            msg.bufferedAheadMs < 400 &&
            playState === "playing"
          ) {
            const video = videoRef.current;
            if (video && !video.paused) {
              video.pause();
              setPlayState("paused");
              send({
                type: "playback",
                state: "paused",
                position: video.currentTime,
                at: Date.now(),
                seq: ++seqRef.current,
              });
              setStatus("Paused — partner was buffering");
            }
          }
          return;
        }
        if (msg.type !== "heartbeat" && msg.seq < seqRef.current - 2) return;
        if ("seq" in msg) seqRef.current = Math.max(seqRef.current, msg.seq);
        applyRemotePlayback(msg);
        return;
      }

      if (msg.type === "rate") {
        seqRef.current = Math.max(seqRef.current, msg.seq);
        const video = videoRef.current;
        if (video) video.playbackRate = msg.rate;
        setPlaybackRate(msg.rate);
        return;
      }

      if (msg.type === "media_set") {
        seqRef.current = Math.max(seqRef.current, msg.seq);
        onMediaFromPeer?.(msg.media);
        return;
      }

      if (msg.type === "control_mode") {
        seqRef.current = Math.max(seqRef.current, msg.seq);
        setControlMode(msg.mode);
        setRemoteHolder(msg.remoteHolder);
        setControlRequested(false);
        return;
      }

      if (msg.type === "control_request") {
        if (isHost) setControlRequested(true);
        setStatus(`${msg.name} asked for the remote`);
        return;
      }

      if (msg.type === "settings_changed") {
        seqRef.current = Math.max(seqRef.current, msg.seq);
        onSettingsFromPeer?.(msg.settings);
        return;
      }

      if (msg.type === "chat") {
        pushChat({ name: msg.name, body: msg.body, at: msg.at, color: msg.color });
        return;
      }

      if (msg.type === "reaction") {
        burstReaction(msg.glyph, msg.name);
        return;
      }

      if (msg.type === "typing") {
        setPartnerTyping(msg.on);
        return;
      }

      if (msg.type === "track_changed" || msg.type === "subtitle_set") {
        seqRef.current = Math.max(seqRef.current, msg.seq);
        const trackId = msg.type === "subtitle_set" ? msg.trackId : msg.subtitleTrackId;
        onSubtitleFromPeer?.(trackId);
        return;
      }

      if (msg.type === "room_ended") {
        onRoomEnded?.(msg.reason);
        setStatus(`Room ended — ${msg.reason}`);
        return;
      }

      if (msg.type === "command_rejected") {
        setStatus(msg.message);
      }
    },
    [
      applyRemotePlayback,
      burstReaction,
      color,
      controlMode,
      isHost,
      name,
      onFileMessage,
      onMediaFromPeer,
      onRoomEnded,
      onSettingsFromPeer,
      onSubtitleFromPeer,
      playState,
      pushChat,
      remoteHolder,
      send,
      videoRef,
    ],
  );

  // BroadcastChannel
  useEffect(() => {
    const channel = new BroadcastChannel(channelName(code));
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<SyncMessage>) => onMessage(event.data);
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [code, onMessage]);

  // PeerJS
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { default: PeerCtor } = await import("peerjs");
        if (cancelled) return;
        const peer = isHost ? new PeerCtor(peerIdForHost(code), { debug: 0 }) : new PeerCtor({ debug: 0 });
        peerRef.current = peer;

        peer.on("error", (err) => {
          const message = String((err as { type?: string }).type ?? err);
          if (message.includes("unavailable-id") || message.includes("ID is taken")) {
            setError("That room code is already live. Ask for a fresh invite.");
            return;
          }
          setStatus((prev) => (partnerState === "connected" ? prev : "Looking for your partner…"));
        });

        peer.on("open", () => {
          if (cancelled) return;
          setStatus(isHost ? "Room ready — share the invite link" : "Connecting to host…");
          if (!isHost) {
            setPartnerState("connecting");
            wireConn(peer.connect(peerIdForHost(code), { reliable: true }));
          }
        });

        if (isHost) peer.on("connection", (conn) => wireConn(conn));
      } catch {
        setStatus("Peer network unavailable — open a second tab on this device to demo sync");
      }
    }

    function wireConn(conn: DataConnection) {
      connRef.current = conn;
      conn.on("open", () => {
        setPartnerState("connected");
        send({ type: "hello", role, name, color });
      });
      conn.on("data", (data) => onMessage(data as SyncMessage));
      conn.on("close", () => {
        setPartnerState("reconnecting");
        setStatus("Connection dropped — trying to recover");
      });
    }

    void connect();
    const t = window.setTimeout(() => send({ type: "hello", role, name, color }), 250);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isHost, name, role, color]);

  // Clock pings
  useEffect(() => {
    let n = 0;
    const id = window.setInterval(() => {
      if (partnerState !== "connected") return;
      send({ type: "sync_ping", t0: Date.now() });
      n += 1;
      if (n > 10 && n % 5 !== 0) {
        /* steady: every 5s effectively by clearing? keep every 5s after burst */
      }
    }, partnerState === "connected" && n < 10 ? 300 : 5000);
    return () => window.clearInterval(id);
  }, [partnerState, send]);

  // Heartbeats
  useEffect(() => {
    const ms = playState === "playing" ? 250 : 1000;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || partnerState !== "connected") return;
      let bufferedAheadMs = 0;
      if (video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        bufferedAheadMs = Math.max(0, (end - video.currentTime) * 1000);
      }
      if (isHost) {
        send({
          type: "heartbeat",
          position: video.currentTime,
          state: video.paused ? "paused" : "playing",
          at: Date.now(),
          seq: seqRef.current,
          bufferedAheadMs,
        });
      } else {
        send({
          type: "heartbeat",
          position: video.currentTime,
          state: video.paused ? "paused" : "playing",
          at: Date.now(),
          seq: seqRef.current,
          bufferedAheadMs,
        });
      }
    }, ms);
    return () => window.clearInterval(id);
  }, [isHost, partnerState, playState, send, videoRef]);

  // Ready reporting
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const check = () => {
      const ready = video.readyState >= 3;
      selfReadyRef.current = ready;
      setSelfReady(ready);
      if (partnerState === "connected") {
        let bufferedAheadMs = 0;
        if (video.buffered.length) {
          bufferedAheadMs = Math.max(0, (video.buffered.end(video.buffered.length - 1) - video.currentTime) * 1000);
        }
        send({ type: "ready_state", ready, bufferedAheadMs });
      }
    };
    video.addEventListener("canplay", check);
    video.addEventListener("progress", check);
    check();
    return () => {
      video.removeEventListener("canplay", check);
      video.removeEventListener("progress", check);
    };
  }, [partnerState, send, videoRef]);

  const broadcastPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    applyingRef.current = true;
    video.pause();
    setPlayState("paused");
    lastLocalActionRef.current = Date.now();
    send({
      type: "playback",
      state: "paused",
      position: video.currentTime,
      at: Date.now(),
      seq: ++seqRef.current,
    });
    window.setTimeout(() => {
      applyingRef.current = false;
    }, 80);
  }, [send, videoRef]);

  const requestPlayTogether = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const alone = partnerState !== "connected";
    const bothReady = alone || (selfReadyRef.current && (partnerReadyRef.current || true));
    if (!bothReady) {
      setStatus("Waiting for buffers…");
    }
    scheduleStartTogether(video.currentTime);
  }, [partnerState, scheduleStartTogether, videoRef]);

  const seekTo = useCallback(
    (next: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = next;
      setPosition(next);
      lastLocalActionRef.current = Date.now();
      send({
        type: "seek",
        position: next,
        state: video.paused ? "paused" : "playing",
        at: Date.now(),
        seq: ++seqRef.current,
      });
    },
    [send, videoRef],
  );

  const setRate = useCallback(
    (rate: number) => {
      const video = videoRef.current;
      if (video) video.playbackRate = rate;
      setPlaybackRate(rate);
      send({ type: "rate", rate, seq: ++seqRef.current });
    },
    [send, videoRef],
  );

  const setMode = useCallback(
    (mode: ControlMode, holder: Role = mode === "handed_to_guest" ? "guest" : "host") => {
      setControlMode(mode);
      setRemoteHolder(holder);
      send({ type: "control_mode", mode, remoteHolder: holder, seq: ++seqRef.current });
    },
    [send],
  );

  const broadcastMedia = useCallback(
    (media: MediaDescriptor) => {
      send({ type: "media_set", media, seq: ++seqRef.current });
    },
    [send],
  );

  const broadcastSettings = useCallback(
    (next: RoomSettings) => {
      send({ type: "settings_changed", settings: next, seq: ++seqRef.current });
    },
    [send],
  );

  const endRoom = useCallback(() => {
    send({ type: "room_ended", reason: "host closed the room" });
  }, [send]);

  const sendChat = useCallback(
    (body: string) => {
      const at = Date.now();
      pushChat({ name, body, at, color });
      send({ type: "chat", name, body, at, color });
    },
    [color, name, pushChat, send],
  );

  const sendReaction = useCallback(
    (glyph: string) => {
      burstReaction(glyph, name);
      send({ type: "reaction", name, glyph, at: Date.now() });
    },
    [burstReaction, name, send],
  );

  const sendTyping = useCallback(
    (on: boolean) => {
      send({ type: "typing", name, on });
    },
    [name, send],
  );

  const requestControl = useCallback(() => {
    send({ type: "control_request", name });
    setStatus("Asked the host for the remote");
  }, [name, send]);

  const broadcastSubtitle = useCallback(
    (trackId: string | null) => {
      send({ type: "subtitle_set", trackId, seq: ++seqRef.current });
    },
    [send],
  );

  const th = thresholdsFor(settings.syncStrictness);
  const syncLabel =
    partnerState !== "connected"
      ? "waiting for partner"
      : Math.abs(driftMs) <= th.lockMs
        ? "in sync"
        : Math.abs(driftMs) < th.hardSeekMs
          ? `nudging ${driftMs > 0 ? "+" : ""}${driftMs} ms`
          : `catching up ${driftMs > 0 ? "+" : ""}${driftMs} ms`;

  return {
    send,
    connRef,
    applyingRef,
    lastLocalActionRef,
    partnerName,
    partnerColor,
    partnerState,
    partnerReady,
    selfReady,
    playState,
    setPlayState,
    position,
    setPosition,
    duration,
    setDuration,
    driftMs,
    playbackRate,
    controlMode,
    remoteHolder,
    status,
    setStatus,
    error,
    countdown,
    chat,
    setChat,
    reactions,
    partnerTyping,
    controlRequested,
    setControlRequested,
    syncLabel,
    broadcastPause,
    requestPlayTogether,
    seekTo,
    setRate,
    setMode,
    broadcastMedia,
    broadcastSettings,
    endRoom,
    sendChat,
    sendReaction,
    sendTyping,
    requestControl,
    broadcastSubtitle,
    pushChat,
  };
}

export { DEFAULT_SETTINGS };

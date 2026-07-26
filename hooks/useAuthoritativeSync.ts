"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  DEFAULT_SETTINGS,
  authoritativePosition,
  canControlPlayback,
  liveAnchor,
  thresholdsFor,
  type ControlMode,
  type MediaDescriptor,
  type PlaybackAnchor,
  type Role,
  type RoomEndReason,
  type RoomSettings,
  type SyncClientMessage,
  type SyncServerMessage,
} from "@partmov/protocol";

type Partner = {
  id: string;
  displayName: string;
  color: string;
  role: Role;
  ready: boolean;
};

type Options = {
  roomId: string;
  wsUrl: string;
  displayName: string;
  color: string;
  roleHint?: Role;
  inviteToken?: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  settings: RoomSettings;
  onSettings: (s: RoomSettings) => void;
  onMedia: (m: MediaDescriptor) => void;
  onEnded: (reason: RoomEndReason, message: string) => void;
  onPlaybackToken?: (token: string, expiresAt: number, sessionId: string) => void;
  getBufferedAheadMs?: () => number;
  getLevel?: () => number | undefined;
};

/**
 * Authoritative WebSocket room sync (Streaming V2).
 * The room session clock is the source of truth — every viewer (including
 * reconnects / stragglers) is pulled to the same minute.
 */
export function useAuthoritativeSync(opts: Options) {
  const {
    roomId,
    wsUrl,
    displayName,
    color,
    roleHint,
    inviteToken,
    videoRef,
    settings,
    onSettings,
    onMedia,
    onEnded,
    onPlaybackToken,
    getBufferedAheadMs,
    getLevel,
  } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const applyingRemote = useRef(false);
  const clockOffsetMs = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const participantIdRef = useRef<string | null>(null);
  const anchorRef = useRef<PlaybackAnchor | null>(null);
  const countdownTimerRef = useRef<number | undefined>(undefined);

  const [role, setRole] = useState<Role>(roleHint ?? "host");
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [controlMode, setControlMode] = useState<ControlMode>("host_only");
  const [remoteHolder, setRemoteHolder] = useState<Role>("host");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(1);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [chat, setChat] = useState<Array<{ id: string; name: string; body: string; at: number; color?: string }>>([]);
  const [reactions, setReactions] = useState<Array<{ id: string; glyph: string; name: string }>>([]);

  const send = useCallback((msg: SyncClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const cmdId = () => crypto.randomUUID();

  const serverNow = useCallback((serverNowMs?: number) => {
    if (typeof serverNowMs === "number") return serverNowMs;
    return Date.now() + clockOffsetMs.current;
  }, []);

  const applySessionClock = useCallback(
    (
      anchor: PlaybackAnchor,
      opts?: { startAt?: number; force?: boolean; serverNowMs?: number },
    ) => {
      const v = videoRef.current;
      const now = serverNow(opts?.serverNowMs);
      const live = liveAnchor(anchor, now);
      anchorRef.current = live;
      setRate(live.rate);
      setPosition(live.positionSec);
      setPlaying(live.state === "playing");

      if (!v) return;

      if (countdownTimerRef.current) {
        window.clearTimeout(countdownTimerRef.current);
        countdownTimerRef.current = undefined;
      }

      applyingRemote.current = true;
      const th = thresholdsFor(settingsRef.current.syncStrictness);
      const driftMs = Math.abs(v.currentTime - live.positionSec) * 1000;
      const hard = opts?.force || driftMs >= th.hardSeekMs;

      if (hard || driftMs > th.fineMs) {
        if (hard && driftMs >= th.hardSeekMs) setCatchingUp(true);
        try {
          v.currentTime = live.positionSec;
        } catch {
          /* media may not be seekable yet */
        }
        if (typeof v.playbackRate === "number") v.playbackRate = live.rate;
      } else if (driftMs > th.lockMs && live.state === "playing") {
        // Gentle rate nudge while close — still anchored to session clock.
        const ahead = v.currentTime > live.positionSec;
        v.playbackRate = Math.max(0.85, Math.min(1.15, live.rate * (ahead ? 0.95 : 1.05)));
      } else if (Math.abs(v.playbackRate - live.rate) > 0.02) {
        v.playbackRate = live.rate;
      }

      const finish = () => {
        applyingRemote.current = false;
        setCatchingUp(false);
      };

      if (live.state === "playing") {
        if (opts?.startAt && opts.startAt > Date.now()) {
          const wait = opts.startAt - Date.now();
          setCountdown(Math.ceil(wait / 1000));
          v.pause();
          countdownTimerRef.current = window.setTimeout(() => {
            setCountdown(null);
            void v.play().catch(() => undefined);
            finish();
          }, wait);
        } else {
          setCountdown(null);
          void v.play().catch(() => undefined);
          finish();
        }
      } else {
        setCountdown(null);
        v.pause();
        finish();
      }
    },
    [serverNow, videoRef],
  );

  /** Re-apply the last known room clock once media is seekable (welcome often arrives early). */
  const resyncToSession = useCallback(
    (force = true) => {
      if (!anchorRef.current) return;
      applySessionClock(anchorRef.current, { force });
    },
    [applySessionClock],
  );

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let pingTimer: number | undefined;
    let hbTimer: number | undefined;
    let driftTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        const pid = participantIdRef.current;
        if (pid) {
          send({
            type: "reconnect",
            roomId,
            participantId: pid,
            displayName,
            color,
            inviteToken,
          });
        } else {
          send({
            type: "join",
            roomId,
            displayName,
            color,
            inviteToken,
            role: roleHint,
          });
        }
        pingTimer = window.setInterval(() => send({ type: "sync_ping", t0: Date.now() }), 3000);
        hbTimer = window.setInterval(() => {
          const v = videoRef.current;
          if (!v) return;
          send({
            type: "heartbeat",
            position: v.currentTime,
            state: v.paused ? "paused" : "playing",
            bufferedAheadMs: getBufferedAheadMs?.() ?? 0,
            level: getLevel?.(),
            clockOffsetMs: clockOffsetMs.current,
            rebuffering: v.readyState < 3 && !v.paused,
          });
        }, 1000);

        // Continuous catch-up: free-running local video is pulled back to the room clock.
        driftTimer = window.setInterval(() => {
          const anchor = anchorRef.current;
          const v = videoRef.current;
          if (!anchor || !v || applyingRemote.current) return;
          const now = Date.now() + clockOffsetMs.current;
          const target = authoritativePosition(anchor, now);
          const th = thresholdsFor(settingsRef.current.syncStrictness);
          const driftMs = Math.abs(v.currentTime - target) * 1000;
          setPosition(target);
          if (driftMs < th.fineMs) {
            if (Math.abs(v.playbackRate - anchor.rate) > 0.02 && !v.paused) {
              v.playbackRate = anchor.rate;
            }
            return;
          }
          applySessionClock(anchor, { force: driftMs >= th.hardSeekMs, serverNowMs: now });
        }, 750);
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as SyncServerMessage;
        if ("seq" in msg && typeof msg.seq === "number") {
          if (msg.seq < seqRef.current && msg.type !== "welcome" && msg.type !== "reconnect_snapshot") return;
          seqRef.current = msg.seq;
        }

        switch (msg.type) {
          case "welcome":
          case "reconnect_snapshot": {
            const pid = msg.participantId;
            participantIdRef.current = pid;
            setParticipantId(pid);
            setRole(msg.role);
            setControlMode(msg.controlMode);
            setRemoteHolder(msg.remoteHolder);
            onSettings(msg.settings);
            if (msg.media) onMedia(msg.media);
            setPartners(msg.participants.map((p) => ({ ...p })));
            if (msg.anchor) {
              applySessionClock(msg.anchor, { force: true, serverNowMs: msg.serverNowMs });
            }
            break;
          }
          case "partner_joined":
            setPartners((prev) => [...prev.filter((p) => p.id !== msg.participant.id), msg.participant]);
            break;
          case "partner_left":
            setPartners((prev) => prev.filter((p) => p.id !== msg.participantId));
            break;
          case "playback":
            applySessionClock(
              {
                wallClockMs: msg.startAt ?? msg.at,
                positionSec: msg.position,
                state: msg.state,
                rate: msg.rate ?? anchorRef.current?.rate ?? 1,
              },
              { startAt: msg.startAt, force: true, serverNowMs: msg.at },
            );
            break;
          case "seek":
            applySessionClock(
              {
                wallClockMs: msg.at,
                positionSec: msg.position,
                state: msg.state,
                rate: msg.rate ?? anchorRef.current?.rate ?? 1,
              },
              { force: true, serverNowMs: msg.at },
            );
            break;
          case "rate":
            applySessionClock(
              {
                wallClockMs: msg.at,
                positionSec: msg.position,
                state: msg.state,
                rate: msg.rate,
              },
              { force: false, serverNowMs: msg.at },
            );
            break;
          case "control_mode":
            setControlMode(msg.mode);
            setRemoteHolder(msg.remoteHolder);
            break;
          case "media_set":
            onMedia(msg.media);
            break;
          case "settings_changed":
            onSettings(msg.settings);
            break;
          case "sync_pong": {
            const t3 = Date.now();
            const rtt = t3 - msg.t0;
            const mid = msg.t1 + (msg.t2 - msg.t1) / 2;
            clockOffsetMs.current = mid - (msg.t0 + rtt / 2);
            if (msg.anchor) {
              // Soft refresh of room clock from ping — do not force-seek every 3s.
              anchorRef.current = liveAnchor(msg.anchor, msg.serverNowMs ?? serverNow());
              setPlaying(msg.anchor.state === "playing");
              setRate(msg.anchor.rate);
            }
            break;
          }
          case "heartbeat_ack": {
            anchorRef.current = msg.anchor;
            if (msg.advised === "seek" || msg.advised === "nudge") {
              applySessionClock(msg.anchor, {
                force: msg.advised === "seek",
                serverNowMs: msg.serverNowMs,
              });
            } else {
              setPosition(authoritativePosition(msg.anchor, msg.serverNowMs));
              setPlaying(msg.anchor.state === "playing");
              setRate(msg.anchor.rate);
            }
            break;
          }
          case "command_rejected": {
            if (msg.reason === "protocol" && /Unknown participant/i.test(msg.message)) {
              participantIdRef.current = null;
              setParticipantId(null);
              send({
                type: "join",
                roomId,
                displayName,
                color,
                inviteToken,
                role: roleHint,
              });
            }
            break;
          }
          case "chat":
            setChat((c) => [
              ...c.slice(-199),
              { id: `${msg.at}-${msg.participantId}`, name: msg.name, body: msg.body, at: msg.at, color: msg.color },
            ]);
            break;
          case "reaction":
            setReactions((r) => [...r.slice(-20), { id: `${msg.at}-${msg.glyph}`, glyph: msg.glyph, name: msg.name }]);
            window.setTimeout(() => {
              setReactions((r) => r.filter((x) => x.id !== `${msg.at}-${msg.glyph}`));
            }, 2500);
            break;
          case "host_transfer": {
            const selfId = participantIdRef.current;
            setRole(selfId && msg.newHostParticipantId === selfId ? "host" : "guest");
            setPartners((prev) =>
              prev.map((p) =>
                p.id === msg.newHostParticipantId ? { ...p, role: "host" as const } : { ...p, role: "guest" as const },
              ),
            );
            setControlMode("host_only");
            setRemoteHolder("host");
            break;
          }
          case "room_ended":
            onEnded(msg.reason, msg.message);
            break;
          case "playback_token":
            onPlaybackToken?.(msg.cookieHint ?? "", msg.expiresAt, msg.playbackSessionId);
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingTimer) window.clearInterval(pingTimer);
        if (hbTimer) window.clearInterval(hbTimer);
        if (driftTimer) window.clearInterval(driftTimer);
        if (closed) return;
        const delay = Math.min(10_000, 500 * 2 ** retry);
        retry += 1;
        window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      send({ type: "leave" });
      wsRef.current?.close();
      if (countdownTimerRef.current) window.clearTimeout(countdownTimerRef.current);
    };
  }, [
    roomId,
    wsUrl,
    displayName,
    color,
    inviteToken,
    roleHint,
    send,
    videoRef,
    onSettings,
    onMedia,
    onEnded,
    onPlaybackToken,
    applySessionClock,
    getBufferedAheadMs,
    getLevel,
    serverNow,
  ]);

  const can = useCallback(
    (action: "play" | "pause" | "seek" | "rate" | "media" | "subtitle_track") =>
      canControlPlayback(role, controlMode, remoteHolder, action),
    [role, controlMode, remoteHolder],
  );

  return {
    role,
    setRole,
    participantId,
    connected,
    catchingUp,
    partners,
    controlMode,
    remoteHolder,
    playing,
    position,
    rate,
    countdown,
    chat,
    reactions,
    send,
    cmdId,
    can,
    resyncToSession,
    play: (positionSec: number) =>
      send({ type: "playback_cmd", action: "play", position: positionSec, commandId: cmdId() }),
    pause: (positionSec: number) =>
      send({ type: "playback_cmd", action: "pause", position: positionSec, commandId: cmdId() }),
    seek: (positionSec: number) => send({ type: "seek_cmd", position: positionSec, commandId: cmdId() }),
    setRateCmd: (r: number) => send({ type: "rate_cmd", rate: r, commandId: cmdId() }),
    setMedia: (media: MediaDescriptor) => send({ type: "media_cmd", media, commandId: cmdId() }),
    setControlModeCmd: (mode: ControlMode, holder: Role) =>
      send({ type: "control_mode_cmd", mode, remoteHolder: holder, commandId: cmdId() }),
    setSettingsCmd: (partial: Partial<RoomSettings>) =>
      send({ type: "settings_cmd", settings: partial, commandId: cmdId() }),
    endRoom: (reason: RoomEndReason) => send({ type: "end_room_cmd", reason, commandId: cmdId() }),
    transferHost: () => send({ type: "host_transfer_cmd", commandId: cmdId() }),
    readyState: (ready: boolean, bufferedAheadMs: number) =>
      send({ type: "ready_state", ready, bufferedAheadMs, level: getLevel?.() }),
    applyingRemote,
    DEFAULT_SETTINGS,
  };
}

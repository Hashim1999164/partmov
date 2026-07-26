import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pg from "pg";
import { Redis } from "ioredis";
import {
  DEFAULT_SETTINGS,
  authoritativePosition,
  canControlPlayback,
  liveAnchor,
  thresholdsFor,
  type ControlMode,
  type MediaDescriptor,
  type ParticipantSnapshot,
  type PlaybackAnchor,
  type Role,
  type RoomEndReason,
  type RoomSettings,
  type SyncClientMessage,
  type SyncServerMessage,
} from "@partmov/protocol";

const PORT = Number(process.env.SYNC_PORT ?? 8090);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://partmov:partmov@127.0.0.1:5432/partmov";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const NODE_ID = process.env.SYNC_NODE_ID ?? `sync-${process.pid}`;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
const redis = new Redis(REDIS_URL, { lazyConnect: true });

type Client = {
  ws: WebSocket;
  participantId: string;
  roomId: string;
  role: Role;
  displayName: string;
  color: string;
};

type RoomState = {
  roomId: string;
  code: string;
  settings: RoomSettings;
  media: MediaDescriptor | null;
  controlMode: ControlMode;
  remoteHolder: Role;
  seq: number;
  anchor: PlaybackAnchor;
  clients: Map<string, Client>;
  checkpointTimer?: NodeJS.Timeout;
};

const rooms = new Map<string, RoomState>();

function send(ws: WebSocket, msg: SyncServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: RoomState, msg: SyncServerMessage, except?: string) {
  for (const [id, c] of room.clients) {
    if (except && id === except) continue;
    send(c.ws, msg);
  }
}

async function loadOrCreateRoom(roomId: string): Promise<RoomState | null> {
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const { rows } = await pool.query(
    `SELECT r.*, a.title AS asset_title, a.master_playlist_key, a.id AS aid, a.duration_ms, a.poster_key
     FROM rooms r LEFT JOIN assets a ON a.id = r.asset_id WHERE r.id = $1`,
    [roomId],
  );
  const r = rows[0];
  if (!r || r.ended_at) return null;
  const settings = { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) } as RoomSettings;
  const media: MediaDescriptor | null = r.aid
    ? {
        kind: "hls",
        assetId: r.aid,
        title: r.asset_title ?? r.title,
        masterPlaylistUrl: r.master_playlist_key
          ? `${process.env.MEDIA_PUBLIC_BASE ?? "http://127.0.0.1:8088/media"}/${r.master_playlist_key}`
          : undefined,
        poster: r.poster_key
          ? `${process.env.MEDIA_PUBLIC_BASE ?? "http://127.0.0.1:8088/media"}/${r.poster_key}`
          : undefined,
        durationMs: r.duration_ms ?? undefined,
      }
    : null;

  const state: RoomState = {
    roomId,
    code: r.code,
    settings,
    media,
    controlMode: r.control_mode,
    remoteHolder: r.remote_holder,
    seq: Number(r.command_seq),
    anchor: {
      wallClockMs: r.anchor_wall_clock_ms ? Number(r.anchor_wall_clock_ms) : Date.now(),
      positionSec: Number(r.anchor_position_sec ?? 0),
      state: r.anchor_state === "playing" ? "playing" : "paused",
      rate: Number(r.anchor_rate ?? 1),
    },
    clients: new Map(),
  };
  state.checkpointTimer = setInterval(() => void checkpoint(state), 5000);
  rooms.set(roomId, state);
  await redis.set(`room:route:${roomId}`, NODE_ID, "EX", 3600);
  return state;
}

async function checkpoint(room: RoomState) {
  // Persist the live room clock so reconnects after a restart land on the same minute.
  room.anchor = liveAnchor(room.anchor);
  await pool.query(
    `UPDATE rooms SET command_seq = $2, anchor_wall_clock_ms = $3, anchor_position_sec = $4,
     anchor_state = $5, anchor_rate = $6, control_mode = $7, remote_holder = $8, settings = $9::jsonb, updated_at = now()
     WHERE id = $1`,
    [
      room.roomId,
      room.seq,
      room.anchor.wallClockMs,
      room.anchor.positionSec,
      room.anchor.state,
      room.anchor.rate,
      room.controlMode,
      room.remoteHolder,
      JSON.stringify(room.settings),
    ],
  );
  await redis.expire(`room:route:${room.roomId}`, 3600);
}

function snapshotForClient(room: RoomState, nowMs = Date.now()): PlaybackAnchor {
  return liveAnchor(room.anchor, nowMs);
}

function participantsOf(room: RoomState): ParticipantSnapshot[] {
  return [...room.clients.values()].map((c) => ({
    id: c.participantId,
    displayName: c.displayName,
    color: c.color,
    role: c.role,
    ready: false,
    connected: true,
  }));
}

function nextSeq(room: RoomState) {
  room.seq += 1;
  return room.seq;
}

async function handleMessage(client: Client, raw: SyncClientMessage) {
  const room = rooms.get(client.roomId);
  if (!room) return;

  if (raw.type === "sync_ping") {
    const now = Date.now();
    send(client.ws, {
      type: "sync_pong",
      t0: raw.t0,
      t1: now,
      t2: now,
      anchor: snapshotForClient(room, now),
      serverNowMs: now,
    });
    return;
  }

  if (raw.type === "ready_state") {
    broadcast(room, {
      type: "ready_state",
      participantId: client.participantId,
      ready: raw.ready,
      bufferedAheadMs: raw.bufferedAheadMs,
    });
    return;
  }

  if (raw.type === "heartbeat") {
    const now = Date.now();
    const authPos = authoritativePosition(room.anchor, now);
    const driftMs = Math.round((raw.position - authPos) * 1000);
    const th = thresholdsFor(room.settings.syncStrictness);
    const abs = Math.abs(driftMs);
    const advised = abs >= th.hardSeekMs ? "seek" : abs >= th.coarseMs ? "nudge" : "ok";
    // Always ack with the live room clock so lagged / reconnecting clients catch up.
    send(client.ws, {
      type: "heartbeat_ack",
      seq: room.seq,
      anchor: snapshotForClient(room, now),
      serverNowMs: now,
      driftMs,
      advised,
    });
    return;
  }

  if (raw.type === "chat") {
    broadcast(room, {
      type: "chat",
      participantId: client.participantId,
      name: client.displayName,
      body: raw.body.slice(0, 280),
      at: Date.now(),
      color: client.color,
    });
    return;
  }

  if (raw.type === "reaction") {
    broadcast(room, {
      type: "reaction",
      participantId: client.participantId,
      name: client.displayName,
      glyph: raw.glyph,
      at: Date.now(),
    });
    return;
  }

  if (raw.type === "typing") {
    broadcast(room, {
      type: "typing",
      participantId: client.participantId,
      name: client.displayName,
      on: raw.on,
    }, client.participantId);
    return;
  }

  const action =
    raw.type === "playback_cmd"
      ? raw.action === "pause"
        ? "pause"
        : "play"
      : raw.type === "seek_cmd"
        ? "seek"
        : raw.type === "rate_cmd"
          ? "rate"
          : raw.type === "media_cmd"
            ? "media"
            : raw.type === "track_cmd"
              ? "subtitle_track"
              : null;

  if (action && !canControlPlayback(client.role, room.controlMode, room.remoteHolder, action)) {
    send(client.ws, {
      type: "command_rejected",
      reason: "forbidden",
      message: "You do not hold the remote for that action",
      seq: room.seq,
      commandId: "commandId" in raw ? raw.commandId : undefined,
    });
    return;
  }

  if (raw.type === "playback_cmd") {
    const seq = nextSeq(room);
    const now = Date.now();
    // Pause always freezes the room clock (session SoT). Play uses the room
    // clock unless the room was paused — then honor the controller scrub.
    const position =
      raw.action === "pause"
        ? authoritativePosition(room.anchor, now)
        : room.anchor.state === "paused"
          ? Math.max(0, raw.position)
          : authoritativePosition(room.anchor, now);
    const startAt = raw.action === "play" ? now + 400 : undefined;
    room.anchor = {
      wallClockMs: startAt ?? now,
      positionSec: position,
      state: raw.action === "play" ? "playing" : "paused",
      rate: room.anchor.rate,
    };
    broadcast(room, {
      type: "playback",
      state: raw.action === "play" ? "playing" : "paused",
      position,
      at: now,
      seq,
      startAt,
      commandId: raw.commandId,
      rate: room.anchor.rate,
    });
    return;
  }

  if (raw.type === "seek_cmd") {
    const seq = nextSeq(room);
    const now = Date.now();
    const position = Math.max(0, raw.position);
    room.anchor = {
      wallClockMs: now,
      positionSec: position,
      state: room.anchor.state,
      rate: room.anchor.rate,
    };
    broadcast(room, {
      type: "seek",
      position,
      state: room.anchor.state,
      at: now,
      seq,
      commandId: raw.commandId,
      rate: room.anchor.rate,
    });
    return;
  }

  if (raw.type === "rate_cmd") {
    const seq = nextSeq(room);
    const now = Date.now();
    // Re-anchor at the live room time before changing rate so nobody jumps.
    const position = authoritativePosition(room.anchor, now);
    room.anchor = {
      wallClockMs: now,
      positionSec: position,
      state: room.anchor.state,
      rate: raw.rate,
    };
    broadcast(room, {
      type: "rate",
      rate: raw.rate,
      position,
      at: now,
      state: room.anchor.state,
      seq,
      commandId: raw.commandId,
    });
    return;
  }

  if (raw.type === "control_mode_cmd") {
    if (client.role !== "host") {
      send(client.ws, {
        type: "command_rejected",
        reason: "forbidden",
        message: "Only host can change control mode",
        seq: room.seq,
        commandId: raw.commandId,
      });
      return;
    }
    room.controlMode = raw.mode;
    room.remoteHolder = raw.remoteHolder;
    const seq = nextSeq(room);
    broadcast(room, {
      type: "control_mode",
      mode: raw.mode,
      remoteHolder: raw.remoteHolder,
      seq,
      commandId: raw.commandId,
    });
    return;
  }

  if (raw.type === "media_cmd") {
    room.media = raw.media;
    const seq = nextSeq(room);
    broadcast(room, { type: "media_set", media: raw.media, seq, commandId: raw.commandId });
    return;
  }

  if (raw.type === "track_cmd") {
    const seq = nextSeq(room);
    broadcast(room, {
      type: "track_changed",
      subtitleTrackId: raw.subtitleTrackId,
      audioTrackId: raw.audioTrackId ?? null,
      seq,
      commandId: raw.commandId,
    });
    return;
  }

  if (raw.type === "settings_cmd") {
    if (client.role !== "host") return;
    room.settings = { ...room.settings, ...raw.settings };
    const seq = nextSeq(room);
    if ("expiresAt" in raw.settings) {
      broadcast(room, { type: "session_expire_at", expiresAt: room.settings.expiresAt, seq });
    }
    broadcast(room, { type: "settings_changed", settings: room.settings, seq, commandId: raw.commandId });
    return;
  }

  if (raw.type === "host_transfer_cmd") {
    if (client.role !== "host") return;
    const guest = [...room.clients.values()].find((c) => c.role === "guest");
    if (!guest) return;
    client.role = "guest";
    guest.role = "host";
    room.remoteHolder = "host";
    room.controlMode = "host_only";
    const seq = nextSeq(room);
    broadcast(room, {
      type: "host_transfer",
      newHostParticipantId: guest.participantId,
      reason: "handoff",
      seq,
    });
    await pool.query(`UPDATE room_participants SET role = 'guest' WHERE id = $1`, [client.participantId]);
    await pool.query(`UPDATE room_participants SET role = 'host' WHERE id = $1`, [guest.participantId]);
    return;
  }

  if (raw.type === "end_room_cmd") {
    if (client.role !== "host") return;
    await endRoom(room, raw.reason);
    return;
  }

  if (raw.type === "leave") {
    await removeClient(client, true);
  }
}

async function endRoom(room: RoomState, reason: RoomEndReason) {
  const message =
    reason === "force"
      ? "Session force-ended. Local film data was cleared on each device."
      : reason === "expired"
        ? "Session expired. Local film data was cleared on each device."
        : "Session ended. Local film data was cleared on each device.";
  broadcast(room, { type: "room_ended", reason, message });
  await pool.query(
    `UPDATE rooms SET ended_at = now(), end_reason = $2, updated_at = now() WHERE id = $1`,
    [room.roomId, reason],
  );
  await pool.query(`UPDATE playback_sessions SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL`, [
    room.roomId,
  ]);
  for (const c of room.clients.values()) {
    try {
      c.ws.close();
    } catch {
      /* ignore */
    }
  }
  if (room.checkpointTimer) clearInterval(room.checkpointTimer);
  rooms.delete(room.roomId);
  await redis.del(`room:route:${room.roomId}`);
}

async function removeClient(client: Client, transferIfHost: boolean) {
  const room = rooms.get(client.roomId);
  if (!room) return;
  // Reconnect may have already replaced this socket — do not wipe the new client.
  if (room.clients.get(client.participantId) !== client) return;
  room.clients.delete(client.participantId);
  await pool.query(
    `UPDATE room_participants SET left_at = now(), connection_state = 'disconnected' WHERE id = $1`,
    [client.participantId],
  );

  if (transferIfHost && client.role === "host") {
    const guest = [...room.clients.values()].find((c) => c.role === "guest");
    if (guest) {
      guest.role = "host";
      room.remoteHolder = "host";
      room.controlMode = "host_only";
      const seq = nextSeq(room);
      broadcast(room, {
        type: "host_transfer",
        newHostParticipantId: guest.participantId,
        reason: "left",
        seq,
      });
      await pool.query(`UPDATE room_participants SET role = 'host' WHERE id = $1`, [guest.participantId]);
      await pool.query(`UPDATE room_participants SET role = 'guest' WHERE id = $1`, [client.participantId]);
    }
  }

  broadcast(room, { type: "partner_left", participantId: client.participantId });
  if (room.clients.size === 0) {
    await checkpoint(room);
  }
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "sync", node: NODE_ID }));
    return;
  }
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`partmov_sync_up 1\npartmov_sync_rooms ${rooms.size}\n`);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let client: Client | null = null;

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(String(data)) as SyncClientMessage;
      if (!client) {
        if (msg.type === "reconnect") {
          const room = await loadOrCreateRoom(msg.roomId);
          if (!room) {
            send(ws, {
              type: "room_ended",
              reason: "ended",
              message: "Room not found or already ended",
            });
            ws.close();
            return;
          }

          const existing = await pool.query<{ id: string; role: Role; left_at: Date | null }>(
            `SELECT id, role, left_at FROM room_participants WHERE id = $1 AND room_id = $2`,
            [msg.participantId, room.roomId],
          );
          const row = existing.rows[0];
          if (!row) {
            send(ws, {
              type: "command_rejected",
              reason: "protocol",
              message: "Unknown participant — send join instead",
              seq: room.seq,
            });
            return;
          }

          // Drop a stale socket if this participant already appears connected.
          const stale = room.clients.get(row.id);
          if (stale && stale.ws !== ws) {
            room.clients.delete(row.id);
            try {
              stale.ws.close();
            } catch {
              /* ignore */
            }
          }

          await pool.query(
            `UPDATE room_participants SET left_at = NULL, connection_state = 'connected',
             display_name = $2, color = $3 WHERE id = $1`,
            [row.id, msg.displayName.slice(0, 32) || "Viewer", msg.color || "#1868DB"],
          );

          // Keep host if still present; otherwise restore this participant's DB role.
          const hostPresent = [...room.clients.values()].some((c) => c.role === "host");
          const role: Role = hostPresent && row.role === "host" ? "guest" : (row.role as Role);

          client = {
            ws,
            participantId: row.id,
            roomId: room.roomId,
            role,
            displayName: msg.displayName.slice(0, 32) || "Viewer",
            color: msg.color || "#1868DB",
          };
          room.clients.set(client.participantId, client);

          const now = Date.now();
          send(ws, {
            type: "reconnect_snapshot",
            participantId: client.participantId,
            role: client.role,
            seq: room.seq,
            anchor: snapshotForClient(room, now),
            serverNowMs: now,
            media: room.media,
            settings: room.settings,
            controlMode: room.controlMode,
            remoteHolder: room.remoteHolder,
            participants: participantsOf(room),
          });
          broadcast(
            room,
            {
              type: "partner_joined",
              participant: {
                id: client.participantId,
                displayName: client.displayName,
                color: client.color,
                role: client.role,
                ready: false,
                connected: true,
              },
            },
            client.participantId,
          );
          return;
        }

        if (msg.type !== "join") {
          send(ws, {
            type: "command_rejected",
            reason: "protocol",
            message: "Send join or reconnect first",
            seq: 0,
          });
          return;
        }
        const room = await loadOrCreateRoom(msg.roomId);
        if (!room) {
          send(ws, {
            type: "room_ended",
            reason: "ended",
            message: "Room not found or already ended",
          });
          ws.close();
          return;
        }

        const role: Role =
          [...room.clients.values()].some((c) => c.role === "host") || msg.role === "guest"
            ? "guest"
            : "host";

        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO room_participants (room_id, display_name, color, role, connection_state)
           VALUES ($1, $2, $3, $4, 'connected') RETURNING id`,
          [room.roomId, msg.displayName.slice(0, 32) || "Viewer", msg.color || "#1868DB", role],
        );

        client = {
          ws,
          participantId: inserted.rows[0].id,
          roomId: room.roomId,
          role,
          displayName: msg.displayName.slice(0, 32) || "Viewer",
          color: msg.color || "#1868DB",
        };
        room.clients.set(client.participantId, client);

        const now = Date.now();
        send(ws, {
          type: "welcome",
          roomId: room.roomId,
          participantId: client.participantId,
          role,
          settings: room.settings,
          media: room.media,
          controlMode: room.controlMode,
          remoteHolder: room.remoteHolder,
          seq: room.seq,
          anchor: snapshotForClient(room, now),
          serverNowMs: now,
          participants: participantsOf(room),
        });
        broadcast(
          room,
          {
            type: "partner_joined",
            participant: {
              id: client.participantId,
              displayName: client.displayName,
              color: client.color,
              role: client.role,
              ready: false,
              connected: true,
            },
          },
          client.participantId,
        );
        return;
      }

      await handleMessage(client, msg);
    } catch (err) {
      console.error(err);
    }
  });

  ws.on("close", () => {
    if (!client) return;
    const snapshot = client;
    // Grace window: brief drops reconnect to the same room clock without host handoff.
    setTimeout(() => {
      void removeClient(snapshot, true);
    }, 5_000);
  });
});

async function boot() {
  try {
    await redis.connect();
  } catch (err) {
    console.warn("redis connect failed", err);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`sync ${NODE_ID} on :${PORT}`);
  });
}

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});

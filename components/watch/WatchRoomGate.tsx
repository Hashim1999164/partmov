"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { normalizeRoomCode } from "@/lib/catalog";
import { COLOR_CHIPS, type Role } from "@/lib/sync-protocol";
import { readRoomEnded } from "@/lib/session-storage";
import { WatchRoom } from "./WatchRoom";
import { StreamingWatchRoom } from "./StreamingWatchRoom";
import { streamingV2Enabled } from "@/lib/streaming";

export function WatchRoomGate({ code: rawCode }: { code: string }) {
  const params = useSearchParams();
  const code = normalizeRoomCode(rawCode);
  const asGuest = params.get("as") === "guest";
  const gate = params.get("gate") || undefined;
  const roomId = params.get("roomId") || undefined;
  const inviteToken = params.get("token") || undefined;

  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState<{ message: string } | null>(null);
  const [role, setRole] = useState<Role>("host");
  const [name, setName] = useState("You");
  const [color, setColor] = useState<string>(COLOR_CHIPS[0]);
  const [mediaId, setMediaId] = useState<string | null>(null);

  useEffect(() => {
    const closed = readRoomEnded(code);
    if (closed) {
      setEnded({ message: closed.message });
      setReady(true);
      return;
    }

    const storedRole = sessionStorage.getItem(`partmov:role:${code}`) as Role | null;
    const storedName = sessionStorage.getItem(`partmov:name:${code}`);
    const storedColor =
      sessionStorage.getItem(`partmov:color:${code}`) ||
      localStorage.getItem("partmov:pref:color") ||
      COLOR_CHIPS[0];
    const storedMedia = sessionStorage.getItem(`partmov:media:${code}`);
    // Only lobby "Start" stamps host into sessionStorage. Cold invite links default to guest
    // so a second tab/device does not fight the PeerJS host room id.
    const nextRole: Role = !asGuest && storedRole === "host" ? "host" : "guest";
    const nextName =
      storedName ||
      localStorage.getItem("partmov:pref:name") ||
      (nextRole === "host" ? "Host" : "Guest");
    sessionStorage.setItem(`partmov:role:${code}`, nextRole);
    sessionStorage.setItem(`partmov:name:${code}`, nextName);
    sessionStorage.setItem(`partmov:color:${code}`, storedColor);
    setRole(nextRole);
    setName(nextName);
    setColor(storedColor);
    setMediaId(nextRole === "host" && storedMedia ? storedMedia : null);
    setEnded(null);
    setReady(true);
  }, [asGuest, code]);

  if (!code) {
    return (
      <div className="cinema-boot">
        <p>That room code looks invalid.</p>
        <a className="btn btn--primary" href="/watch">
          Back to lobby
        </a>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="cinema-boot">
        <p>Preparing the room…</p>
      </div>
    );
  }

  if (ended) {
    return (
      <div className="cinema-boot">
        <p>{ended.message || "This session has ended."}</p>
        <a className="btn btn--primary" href="/watch">
          Start a new room
        </a>
      </div>
    );
  }

  if (streamingV2Enabled && roomId) {
    return (
      <StreamingWatchRoom
        code={code}
        roomId={roomId}
        name={name}
        color={color}
        inviteToken={inviteToken}
      />
    );
  }

  return (
    <WatchRoom
      code={code}
      role={role}
      name={name}
      color={color}
      initialMediaId={mediaId && mediaId !== "file" ? mediaId : null}
      expectPendingFile={mediaId === "file"}
      passphraseGate={gate}
      serverRoomId={roomId}
      inviteToken={inviteToken}
    />
  );
}

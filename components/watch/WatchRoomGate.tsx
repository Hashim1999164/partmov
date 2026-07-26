"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { normalizeRoomCode } from "@/lib/catalog";
import { COLOR_CHIPS, type Role } from "@/lib/sync-protocol";
import { WatchRoom } from "./WatchRoom";

export function WatchRoomGate({ code: rawCode }: { code: string }) {
  const params = useSearchParams();
  const code = normalizeRoomCode(rawCode);
  const asGuest = params.get("as") === "guest";
  const gate = params.get("gate") || undefined;

  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<Role>("host");
  const [name, setName] = useState("You");
  const [color, setColor] = useState<string>(COLOR_CHIPS[0]);
  const [mediaId, setMediaId] = useState<string | null>(null);

  useEffect(() => {
    const storedRole = sessionStorage.getItem(`partmov:role:${code}`) as Role | null;
    const storedName = sessionStorage.getItem(`partmov:name:${code}`);
    const storedColor =
      sessionStorage.getItem(`partmov:color:${code}`) ||
      localStorage.getItem("partmov:pref:color") ||
      COLOR_CHIPS[0];
    const storedMedia = sessionStorage.getItem(`partmov:media:${code}`);
    const nextRole: Role = asGuest ? "guest" : storedRole === "guest" ? "guest" : "host";
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
    setMediaId(nextRole === "host" ? storedMedia : null);
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

  return (
    <WatchRoom
      code={code}
      role={role}
      name={name}
      color={color}
      initialMediaId={mediaId}
      passphraseGate={gate}
    />
  );
}

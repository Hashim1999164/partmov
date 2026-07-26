"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { normalizeRoomCode } from "@/lib/sample";
import type { Role } from "@/lib/sync-protocol";
import { WatchRoom } from "./WatchRoom";

export function WatchRoomGate({ code: rawCode }: { code: string }) {
  const params = useSearchParams();
  const code = normalizeRoomCode(rawCode);
  const asGuest = params.get("as") === "guest";

  const [ready, setReady] = useState(false);
  const [role, setRole] = useState<Role>("host");
  const [name, setName] = useState("You");

  useEffect(() => {
    const storedRole = sessionStorage.getItem(`partmov:role:${code}`) as Role | null;
    const storedName = sessionStorage.getItem(`partmov:name:${code}`);
    const nextRole: Role = asGuest ? "guest" : storedRole === "guest" ? "guest" : "host";
    const nextName = storedName || (nextRole === "host" ? "Host" : "Guest");
    sessionStorage.setItem(`partmov:role:${code}`, nextRole);
    sessionStorage.setItem(`partmov:name:${code}`, nextName);
    setRole(nextRole);
    setName(nextName);
    setReady(true);
  }, [asGuest, code]);

  if (!code) {
    return (
      <div className="shell watch-lobby">
        <p className="lede">That room code looks invalid.</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="shell watch-lobby">
        <p className="lede">Preparing the room…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <WatchRoom code={code} role={role} name={name} />
    </div>
  );
}

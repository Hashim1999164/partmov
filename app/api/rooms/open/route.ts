import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { openRoomSession, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

/** Host opens / refreshes a live room marker in R2. */
export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "Cloud storage is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as { code?: string; hostName?: string };
    const code = normalizeRoomCode(body.code || "");
    if (!code) return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
    await openRoomSession(code, { hostName: body.hostName });
    return NextResponse.json({ ok: true, code });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not open room" },
      { status: 400 },
    );
  }
}

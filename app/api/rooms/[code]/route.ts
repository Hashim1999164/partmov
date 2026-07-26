import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { closeRoomSession, r2Configured, roomSessionExists } from "@/lib/r2-server";

export const runtime = "nodejs";

/** Guest checks whether a host has opened this room. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  try {
    const { code: raw } = await ctx.params;
    const code = normalizeRoomCode(raw || "");
    if (!code) return NextResponse.json({ exists: false }, { status: 400 });
    if (!r2Configured()) {
      return NextResponse.json({ exists: false, error: "Cloud storage is not configured" }, { status: 503 });
    }
    const exists = await roomSessionExists(code);
    return NextResponse.json({ exists, code });
  } catch (err) {
    return NextResponse.json(
      { exists: false, error: err instanceof Error ? err.message : "Lookup failed" },
      { status: 400 },
    );
  }
}

/** Explicit close (purge also removes the marker). */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  try {
    const { code: raw } = await ctx.params;
    const code = normalizeRoomCode(raw || "");
    if (!code) return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
    await closeRoomSession(code);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Close failed" },
      { status: 400 },
    );
  }
}

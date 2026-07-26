import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { purgeRoomPrefix, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as { code?: string };
    const code = normalizeRoomCode(body.code || "");
    if (!code) return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
    const deleted = await purgeRoomPrefix(code);
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Purge failed" },
      { status: 400 },
    );
  }
}

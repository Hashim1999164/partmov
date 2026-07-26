import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { assertRoomKey, r2Configured, signPlaybackUrl } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as { code?: string; objectKey?: string };
    const code = normalizeRoomCode(body.code || "");
    if (!code || !body.objectKey) {
      return NextResponse.json({ error: "code and objectKey required" }, { status: 400 });
    }
    assertRoomKey(code, body.objectKey);
    const signed = await signPlaybackUrl(body.objectKey);
    return NextResponse.json(signed);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Playback URL failed" },
      { status: 400 },
    );
  }
}

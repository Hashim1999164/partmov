import { NextResponse } from "next/server";
import { putObjectBytes, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function PUT(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const url = new URL(req.url);
    const objectKey = url.searchParams.get("objectKey") || "";
    const contentType = url.searchParams.get("contentType") || "video/mp4";
    if (!objectKey.startsWith("rooms/")) {
      return NextResponse.json({ error: "Invalid object key" }, { status: 400 });
    }

    const buf = Buffer.from(await req.arrayBuffer());
    const result = await putObjectBytes({ objectKey, body: buf, contentType });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Put upload failed" },
      { status: 400 },
    );
  }
}

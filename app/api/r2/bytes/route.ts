import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { assertRoomKey, getObjectRange, headObjectSize, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Inclusive byte-range proxy for windowed R2 streaming. */
export async function GET(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const url = new URL(req.url);
    const code = normalizeRoomCode(url.searchParams.get("code") || "");
    const objectKey = url.searchParams.get("objectKey") || "";
    const start = Number(url.searchParams.get("start") || "0");
    const end = Number(url.searchParams.get("end") || "-1");
    const metaOnly = url.searchParams.get("meta") === "1";

    if (!code || !objectKey) {
      return NextResponse.json({ error: "code and objectKey required" }, { status: 400 });
    }
    assertRoomKey(code, objectKey);

    if (metaOnly) {
      const head = await headObjectSize(objectKey);
      return NextResponse.json(head);
    }

    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start) {
      return NextResponse.json({ error: "Invalid byte range" }, { status: 400 });
    }
    // Cap each request to keep serverless payloads small.
    if (end - start + 1 > 2 * 1024 * 1024) {
      return NextResponse.json({ error: "Range too large (max 2 MiB)" }, { status: 413 });
    }

    const part = await getObjectRange(objectKey, start, end);
    return new NextResponse(new Uint8Array(part.bytes), {
      status: 206,
      headers: {
        "Content-Type": part.contentType,
        "Content-Length": String(part.bytes.length),
        "Content-Range": part.contentRange,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Range fetch failed" },
      { status: 400 },
    );
  }
}

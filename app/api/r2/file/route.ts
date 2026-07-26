import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { assertRoomKey, getObjectRange, headObjectSize, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Max bytes per response — keep under serverless payload limits. Players re-request. */
const MAX_RANGE = 2 * 1024 * 1024;

/**
 * Same-origin progressive MP4 proxy for <video src>.
 * Forwards / clamps Range so seeking works without browser→R2 CORS.
 */
export async function GET(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const url = new URL(req.url);
    const code = normalizeRoomCode(url.searchParams.get("code") || "");
    const objectKey = url.searchParams.get("objectKey") || "";
    if (!code || !objectKey) {
      return NextResponse.json({ error: "code and objectKey required" }, { status: 400 });
    }
    assertRoomKey(code, objectKey);

    const head = await headObjectSize(objectKey);
    const total = head.size;
    if (!total) return NextResponse.json({ error: "Empty object" }, { status: 404 });

    const rangeHeader = req.headers.get("range") || req.headers.get("Range");
    let start = 0;
    let end = Math.min(total - 1, MAX_RANGE - 1);

    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (m) {
        start = m[1] ? Number(m[1]) : 0;
        end = m[2] ? Number(m[2]) : Math.min(total - 1, start + MAX_RANGE - 1);
      }
    }

    if (!Number.isFinite(start) || start < 0 || start >= total) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    end = Math.min(end, total - 1, start + MAX_RANGE - 1);
    if (end < start) end = start;

    const part = await getObjectRange(objectKey, start, end);
    return new NextResponse(new Uint8Array(part.bytes), {
      status: 206,
      headers: {
        "Content-Type": part.contentType || head.contentType || "video/mp4",
        "Content-Length": String(part.bytes.length),
        "Content-Range": `bytes ${start}-${start + part.bytes.length - 1}/${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=120",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "File proxy failed" },
      { status: 400 },
    );
  }
}

export async function HEAD(req: Request) {
  try {
    if (!r2Configured()) {
      return new NextResponse(null, { status: 503 });
    }
    const url = new URL(req.url);
    const code = normalizeRoomCode(url.searchParams.get("code") || "");
    const objectKey = url.searchParams.get("objectKey") || "";
    if (!code || !objectKey) return new NextResponse(null, { status: 400 });
    assertRoomKey(code, objectKey);
    const head = await headObjectSize(objectKey);
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": head.contentType || "video/mp4",
        "Content-Length": String(head.size),
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return new NextResponse(null, { status: 400 });
  }
}

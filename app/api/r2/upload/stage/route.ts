import { NextResponse } from "next/server";
import { putStagingChunk, r2Configured } from "@/lib/r2-server";
import { R2_PROXY_PUT_MAX } from "@/lib/r2-constants";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Upload one staging chunk (≤ ~3.5 MiB) that will later be assembled into an R2 multipart part. */
export async function PUT(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const url = new URL(req.url);
    const objectKey = url.searchParams.get("objectKey") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const partNumber = Number(url.searchParams.get("partNumber") || "0");
    const chunkIndex = Number(url.searchParams.get("chunkIndex") || "-1");
    if (!objectKey.startsWith("rooms/") || !uploadId || partNumber < 1 || chunkIndex < 0) {
      return NextResponse.json({ error: "Invalid staging params" }, { status: 400 });
    }

    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > R2_PROXY_PUT_MAX + 64 * 1024) {
      return NextResponse.json({ error: "Chunk too large for proxy" }, { status: 413 });
    }

    const result = await putStagingChunk({
      objectKey,
      uploadId,
      partNumber,
      chunkIndex,
      body: buf,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Staging chunk failed" },
      { status: 400 },
    );
  }
}

import { NextResponse } from "next/server";
import { UploadPartCommand } from "@aws-sdk/client-s3";
import { originalsBucket, r2Client, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";
/** Allow large part bodies on platforms that support it. */
export const maxDuration = 60;

export async function PUT(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const url = new URL(req.url);
    const objectKey = url.searchParams.get("objectKey") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const partNumber = Number(url.searchParams.get("partNumber") || "0");
    if (!objectKey.startsWith("rooms/") || !uploadId || partNumber < 1) {
      return NextResponse.json({ error: "Invalid part params" }, { status: 400 });
    }

    const buf = Buffer.from(await req.arrayBuffer());
    // Proxy path kept for legacy; large films use signed direct-to-R2 parts.
    const out = await r2Client().send(
      new UploadPartCommand({
        Bucket: originalsBucket(),
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: buf,
      }),
    );
    if (!out.ETag) return NextResponse.json({ error: "Missing ETag from R2" }, { status: 502 });
    return NextResponse.json({ etag: out.ETag.replaceAll('"', "") });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Part upload failed" },
      { status: 400 },
    );
  }
}

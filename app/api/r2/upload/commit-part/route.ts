import { NextResponse } from "next/server";
import { commitStagedPart, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Assemble staged proxy chunks into one R2 multipart UploadPart (≥5 MiB). */
export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as {
      objectKey?: string;
      uploadId?: string;
      partNumber?: number;
      chunkCount?: number;
    };
    if (!body.objectKey || !body.uploadId || !body.partNumber || !body.chunkCount) {
      return NextResponse.json(
        { error: "objectKey, uploadId, partNumber, chunkCount required" },
        { status: 400 },
      );
    }
    const result = await commitStagedPart({
      objectKey: body.objectKey,
      uploadId: body.uploadId,
      partNumber: body.partNumber,
      chunkCount: body.chunkCount,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Commit part failed" },
      { status: 400 },
    );
  }
}

import { NextResponse } from "next/server";
import { completeMultipartUpload, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as {
      objectKey?: string;
      uploadId?: string;
      parts?: Array<{ PartNumber: number; ETag: string }>;
    };
    if (!body.objectKey || !body.uploadId || !body.parts?.length) {
      return NextResponse.json({ error: "objectKey, uploadId, parts required" }, { status: 400 });
    }
    const result = await completeMultipartUpload({
      objectKey: body.objectKey,
      uploadId: body.uploadId,
      parts: body.parts,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Complete upload failed" },
      { status: 400 },
    );
  }
}

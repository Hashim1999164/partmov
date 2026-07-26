import { NextResponse } from "next/server";
import { abortMultipartUpload, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as { objectKey?: string; uploadId?: string };
    if (!body.objectKey || !body.uploadId) {
      return NextResponse.json({ error: "objectKey and uploadId required" }, { status: 400 });
    }
    await abortMultipartUpload({ objectKey: body.objectKey, uploadId: body.uploadId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Abort failed" },
      { status: 400 },
    );
  }
}

import { NextResponse } from "next/server";
import { r2Configured, signUploadParts } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured" }, { status: 503 });
    }
    const body = (await req.json()) as {
      objectKey?: string;
      uploadId?: string;
      partNumbers?: number[];
    };
    if (!body.objectKey || !body.uploadId || !body.partNumbers?.length) {
      return NextResponse.json({ error: "objectKey, uploadId, partNumbers required" }, { status: 400 });
    }
    if (body.partNumbers.length > 20) {
      return NextResponse.json({ error: "Too many parts in one request" }, { status: 400 });
    }
    const urls = await signUploadParts({
      objectKey: body.objectKey,
      uploadId: body.uploadId,
      partNumbers: body.partNumbers,
    });
    return NextResponse.json({ urls });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sign parts failed" },
      { status: 400 },
    );
  }
}

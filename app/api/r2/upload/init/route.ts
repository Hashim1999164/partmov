import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import { createMultipartUpload, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

const PART_SIZE = Math.floor(3.5 * 1024 * 1024);

export async function POST(req: Request) {
  try {
    if (!r2Configured()) {
      return NextResponse.json({ error: "R2 is not configured on this deployment" }, { status: 503 });
    }
    const body = (await req.json()) as {
      code?: string;
      fileName?: string;
      mime?: string;
      size?: number;
    };
    const code = normalizeRoomCode(body.code || "");
    if (!code) return NextResponse.json({ error: "Invalid room code" }, { status: 400 });
    if (!body.fileName || !body.size) {
      return NextResponse.json({ error: "fileName and size required" }, { status: 400 });
    }

    const { assetId, objectKey, uploadId } = await createMultipartUpload({
      code,
      fileName: body.fileName,
      mime: body.mime || "video/mp4",
      size: body.size,
    });

    return NextResponse.json({
      assetId,
      objectKey,
      uploadId,
      partSize: PART_SIZE,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload init failed" },
      { status: 400 },
    );
  }
}

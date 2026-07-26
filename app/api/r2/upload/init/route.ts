import { NextResponse } from "next/server";
import { normalizeRoomCode } from "@/lib/catalog";
import {
  createMultipartUpload,
  preparePutUpload,
  R2_MULTIPART_PART_SIZE,
  R2_PROXY_PUT_MAX,
  r2Configured,
} from "@/lib/r2-server";

export const runtime = "nodejs";

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
    if (!body.fileName || typeof body.size !== "number" || body.size < 0) {
      return NextResponse.json({ error: "fileName and size required" }, { status: 400 });
    }

    const mime = body.mime || "video/mp4";

    // Small files: single PutObject (no multipart → no 5 MiB part minimum).
    if (body.size <= R2_PROXY_PUT_MAX) {
      const prepared = await preparePutUpload({
        code,
        fileName: body.fileName,
        mime,
        size: body.size,
      });
      return NextResponse.json({
        mode: "put" as const,
        assetId: prepared.assetId,
        objectKey: prepared.objectKey,
        contentType: prepared.contentType,
      });
    }

    // Large films: multipart with ≥5 MiB parts via signed URLs (direct to R2).
    const { assetId, objectKey, uploadId } = await createMultipartUpload({
      code,
      fileName: body.fileName,
      mime,
      size: body.size,
    });

    return NextResponse.json({
      mode: "multipart" as const,
      assetId,
      objectKey,
      uploadId,
      partSize: R2_MULTIPART_PART_SIZE,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload init failed" },
      { status: 400 },
    );
  }
}

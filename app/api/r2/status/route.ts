import { NextResponse } from "next/server";
import { ensureR2Cors, r2Client, r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function GET() {
  if (!r2Configured()) {
    return NextResponse.json({ enabled: false, cors: false });
  }
  let cors = false;
  let corsError: string | null = null;
  try {
    await ensureR2Cors(r2Client());
    cors = true;
  } catch (err) {
    corsError = err instanceof Error ? err.message : "CORS update failed";
  }
  return NextResponse.json({ enabled: true, cors, corsError });
}

import { NextResponse } from "next/server";
import { r2Configured } from "@/lib/r2-server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ enabled: r2Configured() });
}

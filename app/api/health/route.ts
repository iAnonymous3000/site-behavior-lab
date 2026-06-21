import { NextResponse } from "next/server";
import { runtimeStatus } from "@/lib/runtime-status";
import { corsPreflight, withScanCors } from "../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(request: Request) {
  return withScanCors(
    request,
    NextResponse.json(await runtimeStatus(), {
      headers: {
        "Cache-Control": "no-store"
      }
    })
  );
}

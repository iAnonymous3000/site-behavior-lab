import { NextResponse } from "next/server";
import { corsPreflight, withScanCors } from "../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETIRED_SCAN_API_BODY = Object.freeze({
  ok: false as const,
  error: "The legacy v1/v2 scan endpoint has been retired. Submit scans to POST /api/v3/scan.",
  migration: "/api/v3/scan" as const,
  cause: "feature-unavailable" as const
});

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function POST(request: Request): Promise<Response> {
  return withScanCors(
    request,
    NextResponse.json(RETIRED_SCAN_API_BODY, {
      status: 410,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    })
  );
}

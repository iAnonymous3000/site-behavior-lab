import { NextResponse } from "next/server";
import { runScanRequest } from "@/lib/scan-api";
import { asyncScanModeEnabled, submitScanJobRequest } from "@/lib/scan-jobs";
import { toPublicError } from "@/lib/public-errors";
import { corsPreflight, withScanCors } from "../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  return withScanCors(request, await handleScan(request));
}

async function handleScan(request: Request): Promise<Response> {
  try {
    if (asyncScanModeEnabled()) {
      const submission = await submitScanJobRequest(request);
      return NextResponse.json(submission, { status: 202 });
    }

    const result = await runScanRequest(request);
    return NextResponse.json(result);
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

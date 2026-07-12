import { NextResponse } from "next/server";
import { cancelScanJob, getScanJobStatus } from "@/lib/scan-jobs";
import { toPublicError } from "@/lib/public-errors";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
import { assertScanAccess } from "@/lib/access-control";
import { corsPreflight, withScanCors } from "../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withScanCors(request, await handleJobStatus(request, context));
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return withScanCors(request, await handleJobCancellation(request, context));
}

async function handleJobStatus(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertScanAccess(request);
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const { id } = await context.params;
    const status = getScanJobStatus(id);

    if (!status) {
      return NextResponse.json({ ok: false, error: "Scan job not found." }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

async function handleJobCancellation(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    // Cancellation uses the same access control and bounded capability-read
    // budget as polling, so it cannot become an unauthenticated control plane
    // or a high-rate job-id existence oracle.
    assertScanAccess(request);
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const { id } = await context.params;
    const status = cancelScanJob(id);

    if (!status) {
      return NextResponse.json({ ok: false, error: "Scan job not found." }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

import { NextResponse } from "next/server";
import { readScanReport } from "@/lib/report-store";
import { toPublicError } from "@/lib/public-errors";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
import { corsPreflight, withScanCors } from "../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withScanCors(request, await handleReportRead(request, context));
}

async function handleReportRead(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const { id } = await context.params;
    const report = await readScanReport(id);

    if (!report) {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }

    return NextResponse.json(report);
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

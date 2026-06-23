import { NextResponse } from "next/server";
import { readReportForId } from "@/lib/report-source";
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
    // Resolve through the unified accessor (committed public/reports first, then
    // the runtime share store) so the report body matches the page's
    // server-rendered title/JSON-LD. Reading only the share store here left
    // committed-report permalinks 404ing in the Node app even though their
    // metadata resolved.
    const report = await readReportForId(id);

    if (!report) {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }

    return NextResponse.json(report);
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

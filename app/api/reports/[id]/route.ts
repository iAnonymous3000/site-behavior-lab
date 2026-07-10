import { NextResponse } from "next/server";
import { readStoredReportForId } from "@/lib/report-source";
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
    const result = await readStoredReportForId(id);

    if (result.outcome === "not-found") {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }
    // A report the server HOLDS but cannot read is a server-side problem, not
    // a 404: corrupt bytes are a data fault, and a newer schema is a
    // capability gap this deployment must name instead of hiding.
    if (result.outcome === "unreadable") {
      const message =
        result.error === "unsupported-version" || result.error === "unsupported-revision"
          ? "This report was written by a newer scanner version; this deployment cannot read it yet."
          : "The stored report exists but is unreadable.";
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }

    // The original stored wire, byte-for-byte: the API never re-serializes a
    // parsed report, so downloads match the committed/static JSON exactly.
    return new NextResponse(result.wire, {
      headers: { "content-type": "application/json" }
    });
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

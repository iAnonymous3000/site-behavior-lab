import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import { readStoredReportForId } from "@/lib/report-source";
import {
  ReportPdfUnavailableError,
  renderReportPdf,
  reportPdfFilename
} from "@/lib/report-pdf";
import { REPORT_ID_PATTERN } from "@/lib/report-validation";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
import { toReportView } from "@/lib/scan-report-views";
import { corsPreflight, withScanCors } from "../../../cors";

/**
 * A report as a PDF file.
 *
 * This renders the container's own printable page, so the file a reader
 * downloads is byte-for-byte the page they would get from Ctrl+P, including the
 * evidence footer, the wire digest, the approved use boundary and the standing
 * scope caveat. The PDF is a rendering, not the evidence; the JSON wire remains
 * canonical, and the footer inside the document says so.
 *
 * Container-only, like the printable page it renders: the static export carries
 * neither, because a Pages deployment has no browser to render with.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withScanCors(request, await handleReportPdf(request, context));
}

async function handleReportPdf(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    // Rendering costs a browser tab, so it is rate limited on the same client
    // key as report reads before any work begins.
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const { id } = await context.params;
    if (!REPORT_ID_PATTERN.test(id)) {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }

    // Resolve the report BEFORE launching anything: a missing or unreadable
    // report must answer without ever starting a browser.
    const result = await readStoredReportForId(id);
    if (result.outcome === "not-found") {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }
    if (result.outcome === "unreadable") {
      const message =
        result.error === "unsupported-version" || result.error === "unsupported-revision"
          ? "This report was written by a newer scanner version; this deployment cannot read it yet."
          : "The stored report exists but is unreadable.";
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }

    const pdf = await renderReportPdf(id);
    const filename = reportPdfFilename(id, toReportView(result.stored).domain);

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.byteLength),
        "content-disposition": `attachment; filename="${filename}"`,
        // A generated rendering is not a citable surface; the interactive
        // report is. Keep it out of indexes even if a link leaks.
        "x-robots-tag": "noindex, nofollow",
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    if (error instanceof ReportPdfUnavailableError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

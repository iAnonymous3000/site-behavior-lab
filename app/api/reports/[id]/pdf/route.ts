import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import { readStoredReportForId } from "@/lib/report-source";
import {
  ReportPdfUnavailableError,
  renderReportPdf,
  reportPdfFilename
} from "@/lib/report-pdf";
import { REPORT_ID_PATTERN } from "@/lib/report-validation";
import {
  assertReportPdfRateLimit,
  assertReportReadRateLimit,
  clientKeyFromRequest
} from "@/lib/scan-limits";
import { toReportView } from "@/lib/scan-report-views";
import { corsPreflight, withScanCors } from "../../../cors";

/**
 * A report as a PDF file.
 *
 * This renders the container's own printable page, so the file a reader
 * downloads carries what that page carries: the evidence footer, the wire
 * digest, the approved use boundary and the standing scope caveat. The PDF is a
 * rendering, not the evidence; the JSON wire remains canonical, and the footer
 * inside the document says so.
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
    // The read limit covers the report lookup this shares with every other
    // representation, so it is charged up front like any read. The RENDER limit
    // is charged later, once a render is actually going to happen: charging it
    // here spent a reader's ten-per-minute browser budget on requests that
    // never start Chromium, so ten 404s locked them out of a report that exists.
    const clientKey = clientKeyFromRequest(request);
    assertReportReadRateLimit(clientKey);

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

    // Charged here, not with the read limit: this is the point past which a
    // browser navigation and a PDF write are actually going to happen.
    assertReportPdfRateLimit(clientKey);

    // A reader who navigates away should not keep the single render slot busy
    // producing a document nobody will receive.
    const pdf = await renderReportPdf(id, { signal: request.signal });
    const filename = reportPdfFilename(id, toReportView(result.stored).domain);

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.byteLength),
        // `inline`, so the browser's own PDF viewer renders it in the tab the
        // control already opens instead of the tab flashing blank and a file
        // appearing in a downloads folder. A reader gets to SEE the document
        // before deciding to keep it, which matters more here than elsewhere:
        // this is evidence someone may forward, and the first chance to notice
        // a cut-short visit or the wrong report is looking at it.
        //
        // Saving is not lost. Every viewer offers a save control, `filename`
        // is still honoured when they use it, and saving from the viewer spends
        // no second render because the bytes are already fetched. So preview
        // then keep costs exactly what blind download used to.
        "content-disposition": `inline; filename="${filename}"`,
        // A generated rendering is not a citable surface; the interactive
        // report is. Keep it out of indexes even if a link leaks.
        // No cache-control here: next.config.mjs already applies `no-store` to
        // every /api path, and a second copy of that decision would be a rule
        // stated twice with the config half silently winning.
        "x-robots-tag": "noindex, nofollow"
      }
    });
  } catch (error) {
    if (error instanceof ReportPdfUnavailableError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    // A reader who navigated away is not a server fault. Ask the request, not
    // the error: the rejection is whatever `signal.reason` happened to be, and
    // matching on its shape would miss a runtime that aborts with something
    // else. Without this the expected case logged an exception and answered
    // 500, which is a lie about what went wrong and buries real 500s in noise.
    // 499 is the code the edge worker already uses for the same situation.
    if (request.signal.aborted) {
      return NextResponse.json({ ok: false, error: "The request ended before the PDF finished." }, { status: 499 });
    }
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import {
  assertReportPdfRateLimit,
  assertReportReadRateLimit,
  clientKeyFromRequest
} from "@/lib/scan-limits";
import {
  renderHtmlToPdfLocallyV3,
  renderReportV3Pdf,
  renderReportV3PrintHtml
} from "@/lib/v3/pdf/browser-rendering-pdf";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { loadReportV3, pdfBlobKeyV3, V3_REPORT_ID_RE } from "@/lib/v3/storage/blob-store";
import { corsPreflight, withScanCors } from "../../../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  return withScanCors(request, await handleReportPdfV3(request, context));
}

async function handleReportPdfV3(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const clientKey = clientKeyFromRequest(request);
    const url = new URL(request.url);
    const isHtmlPreview = url.searchParams.get("format") === "html";
    // Charge only the read budget up front; never burn the tighter PDF render
    // quota on malformed IDs, 404s, expired reports, or cached PDFs.
    assertReportReadRateLimit(clientKey);

    const { id } = await context.params;
    if (!V3_REPORT_ID_RE.test(id)) {
      return NextResponse.json(
        { ok: false, error: "Invalid v3 report ID." },
        { status: 400, headers: { "x-content-type-options": "nosniff" } }
      );
    }

    const ctx = await getV3RuntimeContext();
    const [report, meta] = await Promise.all([
      loadReportV3(ctx.blobStore, id),
      ctx.reportIndex.getReportMeta(id)
    ]);
    if (!report || (meta?.expiresAt && Date.parse(meta.expiresAt) <= Date.now())) {
      return NextResponse.json(
        { ok: false, error: "Report not found." },
        { status: 404, headers: { "x-content-type-options": "nosniff" } }
      );
    }

    const isPublic = meta?.visibility === "corpus" || meta?.visibility === "public";

    if (isHtmlPreview) {
      const html = renderReportV3PrintHtml(report);
      return new NextResponse(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none';",
          "cache-control": isPublic ? "public, max-age=300" : "private, no-store",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, noarchive"
        }
      });
    }

    // Only charge the render budget when an uncached PDF render is needed.
    const cachedPdf = await ctx.blobStore.getBinary(pdfBlobKeyV3(report.reportId)).catch(() => null);
    let pdf: Uint8Array;
    let source: "r2-cache" | "cloudflare-browser-rendering" | "local-fallback";
    if (
      cachedPdf &&
      cachedPdf.byteLength >= 5 &&
      cachedPdf[0] === 0x25 &&
      cachedPdf[1] === 0x50 &&
      cachedPdf[2] === 0x44 &&
      cachedPdf[3] === 0x46 &&
      cachedPdf[4] === 0x2d
    ) {
      pdf = cachedPdf;
      source = "r2-cache";
    } else {
      assertReportPdfRateLimit(clientKey);
      const rendered = await renderReportV3Pdf(report, {
        cacheStore: ctx.blobStore,
        cloudflareBrowserRendering: ctx.browserRendering,
        localHtmlToPdf: (html) => renderHtmlToPdfLocallyV3(html, { signal: request.signal })
      });
      pdf = rendered.pdf;
      source = rendered.source;
    }

    const safeDomain = report.canonicalDomain.replace(/[^a-z0-9.-]/gi, "_").slice(0, 120);
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.byteLength),
        "content-disposition": `inline; filename="site-behavior-lab-${safeDomain}-${report.reportId}.pdf"`,
        "x-sbl-pdf-source": source,
        "x-content-type-options": "nosniff",
        "cache-control": isPublic ? "public, max-age=3600" : "private, no-store",
        "x-robots-tag": "noindex, noarchive"
      }
    });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json(
        { ok: false, error: "The request ended before the PDF finished." },
        { status: 499, headers: { "x-content-type-options": "nosniff" } }
      );
    }
    if (error instanceof Error && (/No PDF renderer configured/i.test(error.message) || /renderer busy/i.test(error.message))) {
      return NextResponse.json(
        {
          ok: false,
          error: "PDF renderer is temporarily busy; retry shortly or append ?format=html for printable HTML."
        },
        {
          status: 503,
          headers: { "retry-after": "10", "x-content-type-options": "nosniff" }
        }
      );
    }
    const publicError = toPublicError(error);
    const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
    if (publicError.status === 429) headers["retry-after"] = "60";
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status, headers });
  }
}

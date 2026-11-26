import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import {
  assertReportPdfRateLimit,
  assertReportReadRateLimit,
  clientKeyFromRequest
} from "@/lib/scan-limits";
import { renderReportV3Pdf, renderReportV3PrintHtml } from "@/lib/v3/pdf/browser-rendering-pdf";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { loadReportV3, V3_REPORT_ID_RE } from "@/lib/v3/storage/blob-store";
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
    if (isHtmlPreview) {
      assertReportReadRateLimit(clientKey);
    } else {
      assertReportPdfRateLimit(clientKey);
    }

    const { id } = await context.params;
    if (!V3_REPORT_ID_RE.test(id)) {
      return NextResponse.json({ ok: false, error: "Invalid v3 report ID." }, { status: 400 });
    }

    const ctx = await getV3RuntimeContext();
    const [report, meta] = await Promise.all([
      loadReportV3(ctx.blobStore, id),
      ctx.reportIndex.getReportMeta(id)
    ]);
    if (!report) {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }

    const isPublic = meta?.visibility === "corpus" || meta?.visibility === "public";

    if (isHtmlPreview) {
      const html = renderReportV3PrintHtml(report);
      return new NextResponse(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline';",
          "cache-control": isPublic ? "public, max-age=300" : "private, no-store",
          "x-robots-tag": "noindex, noarchive"
        }
      });
    }

    const { pdf, source } = await renderReportV3Pdf(report, {
      cacheStore: ctx.blobStore,
      cloudflareBrowserRendering: ctx.browserRendering
    });

    const safeDomain = report.canonicalDomain.replace(/[^a-z0-9.-]/gi, "_").slice(0, 120);
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="site-behavior-lab-${safeDomain}-${report.reportId}.pdf"`,
        "x-sbl-pdf-source": source,
        "cache-control": isPublic ? "public, max-age=3600" : "private, no-store",
        "x-robots-tag": "noindex, noarchive"
      }
    });
  } catch (error) {
    if (error instanceof Error && /No PDF renderer configured/i.test(error.message)) {
      return NextResponse.json(
        {
          ok: false,
          error: "PDF rendering requires Cloudflare Browser Rendering credentials; append ?format=html for printable HTML."
        },
        { status: 503 }
      );
    }
    const publicError = toPublicError(error);
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status });
  }
}

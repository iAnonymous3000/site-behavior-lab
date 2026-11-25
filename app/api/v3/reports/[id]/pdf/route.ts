import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
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
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const { id } = await context.params;
    if (!V3_REPORT_ID_RE.test(id)) {
      return NextResponse.json({ ok: false, error: "Invalid v3 report ID." }, { status: 400 });
    }

    const ctx = await getV3RuntimeContext();
    const report = await loadReportV3(ctx.blobStore, id);
    if (!report) {
      return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
    }

    const url = new URL(request.url);
    if (url.searchParams.get("format") === "html") {
      const html = renderReportV3PrintHtml(report);
      return new NextResponse(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline';",
          "cache-control": "public, max-age=300"
        }
      });
    }

    const { pdf, source } = await renderReportV3Pdf(report, {
      cacheStore: ctx.blobStore,
      cloudflareBrowserRendering: ctx.browserRendering
    });

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="site-behavior-lab-${report.canonicalDomain}-${report.reportId}.pdf"`,
        "x-sbl-pdf-source": source,
        "cache-control": "public, max-age=3600"
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

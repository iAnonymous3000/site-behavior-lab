import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { loadReportV3, V3_REPORT_ID_RE } from "@/lib/v3/storage/blob-store";
import { corsPreflight, withScanCors } from "../../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  return withScanCors(request, await handleGetReportV3(request, context));
}

async function handleGetReportV3(
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

    const cacheControl =
      meta?.visibility === "corpus" || meta?.visibility === "public"
        ? "public, max-age=300"
        : "private, no-store";

    return new NextResponse(JSON.stringify(report), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, noarchive"
      }
    });
  } catch (error) {
    const publicError = toPublicError(error);
    const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
    if (publicError.status === 429) headers["retry-after"] = "60";
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status, headers });
  }
}

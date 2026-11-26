import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { diffScanReportsV3 } from "@/lib/v3/runtime/watch-diff";
import { loadReportV3, V3_REPORT_ID_RE } from "@/lib/v3/storage/blob-store";
import { corsPreflight, withScanCors } from "../../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(request: Request): Promise<Response> {
  return withScanCors(request, await handleDiffGet(request));
}

async function handleDiffGet(request: Request): Promise<Response> {
  try {
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const params = new URL(request.url).searchParams;
    const previousId = params.get("previous")?.trim() ?? "";
    const currentId = params.get("current")?.trim() ?? "";

    if (!V3_REPORT_ID_RE.test(previousId) || !V3_REPORT_ID_RE.test(currentId)) {
      return NextResponse.json(
        { ok: false, error: "Both previous and current must be valid v3 report IDs." },
        { status: 400 }
      );
    }

    const ctx = await getV3RuntimeContext();
    const [previous, current] = await Promise.all([
      loadReportV3(ctx.blobStore, previousId),
      loadReportV3(ctx.blobStore, currentId)
    ]);

    if (!previous || !current) {
      return NextResponse.json(
        { ok: false, error: "One or both reports were not found." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      diff: diffScanReportsV3(previous, current)
    });
  } catch (error) {
    const publicError = toPublicError(error);
    const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
    if (publicError.status === 429) headers["retry-after"] = "60";
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status, headers });
  }
}

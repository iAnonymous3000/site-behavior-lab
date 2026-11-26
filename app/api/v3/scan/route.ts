import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { assertScanAccess } from "@/lib/access-control";
import { readRequestBodyWithinLimit } from "@/lib/edge-scan-gate";
import { PublicScanError, toPublicError } from "@/lib/public-errors";
import {
  acquireScanSlot,
  assertRateLimit,
  clientKeyFromRequest,
  MAX_BODY_BYTES
} from "@/lib/scan-limits";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import { dispatchScanV3, type ScanRegionIdV3 } from "@/lib/v3/runtime/worker-dispatch";
import { scanSiteV3, type ScanRequestV3 } from "@/lib/v3/scanner";
import type { ComparisonAxisV3, ConsentModeV3, ScanDeviceV3, ShieldsModeV3 } from "@/lib/v3/schema";
import { saveReportV3 } from "@/lib/v3/storage/blob-store";
import type { IndexedReportVisibilityV3 } from "@/lib/v3/storage/report-index";
import { corsPreflight, withScanCors } from "../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_DEVICES = new Set<ScanDeviceV3>(["desktop", "mobile"]);
const VALID_SHIELDS = new Set<ShieldsModeV3>(["off", "standard", "aggressive"]);
const VALID_CONSENT = new Set<ConsentModeV3>(["observe", "accept-all", "reject-all"]);
const VALID_REGIONS = new Set<ScanRegionIdV3>(["auto", "us-east", "eu-central", "ap-northeast"]);
const VALID_COMPARISONS = new Set<ComparisonAxisV3>([
  "shields-standard",
  "shields-aggressive",
  "gpc",
  "consent-accept",
  "consent-reject"
]);
const VALID_VISIBILITY = new Set<IndexedReportVisibilityV3>(["public", "unlisted", "corpus"]);

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function POST(request: Request): Promise<Response> {
  return withScanCors(request, await handleScanV3(request));
}

async function handleScanV3(request: Request): Promise<Response> {
  let releaseSlot: (() => void) | null = null;
  try {
    assertScanAccess(request);
    // Stream-bounded body read prevents Transfer-Encoding: chunked memory exhaustion
    const rawBody = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES, { signal: request.signal });
    if (rawBody === null) {
      throw new PublicScanError("Request body is too large.", 413, "request-rejected");
    }

    let raw: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = null;
    }
    if (!raw || typeof raw.url !== "string" || !raw.url.trim()) {
      throw new PublicScanError("A valid http(s) URL is required.", 400, "request-rejected");
    }

    const isOperatorAuthenticated = Boolean(process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim());

    const device: ScanDeviceV3 =
      typeof raw.device === "string" && VALID_DEVICES.has(raw.device as ScanDeviceV3)
        ? (raw.device as ScanDeviceV3)
        : "desktop";
    const shieldsMode: ShieldsModeV3 =
      typeof raw.shieldsMode === "string" && VALID_SHIELDS.has(raw.shieldsMode as ShieldsModeV3)
        ? (raw.shieldsMode as ShieldsModeV3)
        : "off";
    const consentMode: ConsentModeV3 =
      typeof raw.consentMode === "string" && VALID_CONSENT.has(raw.consentMode as ConsentModeV3)
        ? (raw.consentMode as ConsentModeV3)
        : "observe";
    const region: ScanRegionIdV3 =
      typeof raw.region === "string" && VALID_REGIONS.has(raw.region as ScanRegionIdV3)
        ? (raw.region as ScanRegionIdV3)
        : "auto";

    let visibility: IndexedReportVisibilityV3 =
      typeof raw.visibility === "string" && VALID_VISIBILITY.has(raw.visibility as IndexedReportVisibilityV3)
        ? (raw.visibility as IndexedReportVisibilityV3)
        : "unlisted";
    // Prevent unauthenticated callers from poisoning the curated "corpus" tier.
    if (visibility === "corpus" && !isOperatorAuthenticated) {
      throw new PublicScanError("Curated corpus visibility requires operator authorization.", 403, "request-rejected");
    }

    const comparisons: ComparisonAxisV3[] = [];
    if (Array.isArray(raw.comparisons)) {
      for (const item of raw.comparisons) {
        if (typeof item === "string" && VALID_COMPARISONS.has(item as ComparisonAxisV3)) {
          const axis = item as ComparisonAxisV3;
          if (!comparisons.includes(axis)) comparisons.push(axis);
        }
      }
    }
    const maxComparisons = isOperatorAuthenticated ? 4 : 2;
    if (comparisons.length > maxComparisons) {
      throw new PublicScanError(
        `At most ${maxComparisons} comparison arms may be requested per scan.`,
        400,
        "request-rejected"
      );
    }

    const clientKey = clientKeyFromRequest(request);
    const rateCost = comparisons.length > 0 ? 2 : 1;
    assertRateLimit(clientKey, Date.now(), rateCost);
    releaseSlot = await acquireScanSlot(undefined, request.signal);

    const scanRequest: ScanRequestV3 = {
      url: raw.url.trim(),
      device,
      gpcEnabled: Boolean(raw.gpcEnabled),
      shieldsMode,
      consentMode,
      scrollCheck: raw.scrollCheck !== false,
      activeInputProbe: raw.activeInputProbe !== false,
      policyCheck: raw.policyCheck !== false,
      comparisons,
      acquisition: "live-api"
    };

    const ctx = await getV3RuntimeContext();
    const { report: dispatchedReport, backend } = await dispatchScanV3(scanRequest, {
      region,
      upstreams: ctx.regionalUpstreams,
      signal: request.signal,
      defaultExecutor: (req) => scanSiteV3(req, { signal: request.signal })
    });

    // Always mint a coordinator-owned reportId for regional-worker results so a
    // remote worker can never overwrite an existing report in R2 or D1.
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const report =
      backend === "regional-http-worker"
        ? { ...dispatchedReport, reportId: `${ymd}-${randomBytes(16).toString("hex")}` }
        : dispatchedReport;

    const r2Key = await saveReportV3(ctx.blobStore, report);
    await ctx.reportIndex.indexReport(report, {
      r2Key,
      visibility
    });

    return NextResponse.json({
      ok: true,
      backend,
      reportId: report.reportId,
      sharePath: `/v3/reports/${report.reportId}`,
      apiPath: `/api/v3/reports/${report.reportId}`,
      pdfPath: `/api/v3/reports/${report.reportId}/pdf`,
      report
    });
  } catch (error) {
    const publicError = toPublicError(error);
    return NextResponse.json(
      { ok: false, error: publicError.message, cause: publicError.cause },
      { status: publicError.status }
    );
  } finally {
    if (releaseSlot) releaseSlot();
  }
}

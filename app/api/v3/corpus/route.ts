import { NextResponse } from "next/server";
import { toPublicError } from "@/lib/public-errors";
import { assertReportReadRateLimit, clientKeyFromRequest } from "@/lib/scan-limits";
import { getV3RuntimeContext } from "@/lib/v3/runtime/store-context";
import type { ServiceCategoryV3 } from "@/lib/v3/schema";
import type { CorpusQueryFiltersV3 } from "@/lib/v3/storage/report-index";
import { corsPreflight, withScanCors } from "../../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CATEGORIES = new Set<ServiceCategoryV3>([
  "advertising",
  "analytics",
  "session-replay",
  "cdp",
  "consent-platform",
  "anti-bot",
  "tag-manager",
  "social-widget",
  "cdn-infra",
  "error-monitoring",
  "marketing-automation",
  "identity-broker",
  "server-side-tagging",
  "other"
]);

const VALID_SORTS = new Set<NonNullable<CorpusQueryFiltersV3["sort"]>>([
  "newest",
  "third-parties",
  "dark-patterns",
  "tracking-requests",
  "cookies"
]);

export function OPTIONS(request: Request): Response {
  return corsPreflight(request);
}

export async function GET(request: Request): Promise<Response> {
  return withScanCors(request, await handleCorpusQueryV3(request));
}

async function handleCorpusQueryV3(request: Request): Promise<Response> {
  try {
    assertReportReadRateLimit(clientKeyFromRequest(request));
    const ctx = await getV3RuntimeContext();
    const params = new URL(request.url).searchParams;

    const view = params.get("view");
    if (view === "stats") {
      const stats = await ctx.reportIndex.getCorpusOverviewStats();
      return NextResponse.json({ ok: true, stats });
    }

    const footprintEntity = params.get("footprint")?.trim().slice(0, 128);
    if (footprintEntity) {
      const limit = parsePositiveInt(params.get("limit"), 100, 500);
      const footprint = await ctx.reportIndex.getEntityFootprint(footprintEntity, limit);
      return NextResponse.json({ ok: true, footprint });
    }

    const domain = params.get("domain")?.trim().slice(0, 128);
    if (domain) {
      const limit = parsePositiveInt(params.get("limit"), 25, 100);
      const history = await ctx.reportIndex.getSiteHistory(domain, limit);
      return NextResponse.json({ ok: true, domain: domain.toLowerCase(), history });
    }

    const rawCategory = params.get("category")?.trim();
    const category =
      rawCategory && VALID_CATEGORIES.has(rawCategory as ServiceCategoryV3)
        ? (rawCategory as ServiceCategoryV3)
        : undefined;

    const rawSort = params.get("sort")?.trim();
    const sort =
      rawSort && VALID_SORTS.has(rawSort as NonNullable<CorpusQueryFiltersV3["sort"]>)
        ? (rawSort as NonNullable<CorpusQueryFiltersV3["sort"]>)
        : "newest";

    const filters: CorpusQueryFiltersV3 = {
      query: params.get("q")?.trim().slice(0, 128) || undefined,
      entity: params.get("entity")?.trim().slice(0, 128) || undefined,
      parentOrg: params.get("parentOrg")?.trim().slice(0, 128) || undefined,
      category,
      region: params.get("region")?.trim().slice(0, 32) || undefined,
      latestPerSite: params.get("allHistory") === "1" ? false : true,
      hasKeystrokeLeaks: params.get("keystrokes") === "1",
      hasCnameCloaks: params.get("cname") === "1",
      hasServerSideTagging: params.get("sgtm") === "1",
      hasFingerprinting: params.get("fingerprinting") === "1",
      minDarkPatternScore: parseOptionalInt(params.get("minDarkPatternScore")),
      minThirdPartyDomains: parseOptionalInt(params.get("minThirdPartyDomains")),
      sort,
      limit: parsePositiveInt(params.get("limit"), 50, 200),
      offset: parseOptionalInt(params.get("offset")) ?? 0
    };

    const result = await ctx.reportIndex.queryCorpus(filters);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const publicError = toPublicError(error);
    const headers: Record<string, string> = { "x-content-type-options": "nosniff" };
    if (publicError.status === 429) headers["retry-after"] = "60";
    return NextResponse.json({ ok: false, error: publicError.message }, { status: publicError.status, headers });
  }
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function parseOptionalInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

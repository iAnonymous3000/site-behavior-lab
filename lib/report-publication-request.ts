import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { redactUrlV2, INVALID_URL_MARKER } from "./redaction-v2";
import type { StoredScanReport } from "./scan-report-reader";
import { axisStateFor, type InterventionAxis } from "./scan-report-v2";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import { readStaticReportBundle, StaticReportBundleError } from "./static-report-files";
import { parseStrictJson } from "./strict-json";
import { normalizeHttpUrlInput } from "./url-normalization";
import { assertPublicHttpUrlShape } from "./url-safety";

const FEATURED_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const FEATURED_CATALOG_MAX_SITES = 10_000;
const FEATURED_CATEGORY_MAX_COUNT = 100;
const FEATURED_LIMIT_MAX = 10_000;
const ALLOWED_FEATURED_CATALOGS = new Set([
  "public/featured-sites.json",
  "public/corpus-seed-sites.json"
]);

export type ReportPublicationComparisonAxis = "gpc" | "shields" | "consent" | null;

export type ReportPublicationRequest = {
  targets: string[];
  device: "desktop" | "mobile";
  comparisonAxis: ReportPublicationComparisonAxis;
  gpcEnabled: boolean;
};

export function singleReportPublicationRequest(
  environment: NodeJS.ProcessEnv = process.env
): ReportPublicationRequest {
  const target = environment.SCAN_URL?.trim();
  if (!target) throw new Error("Trusted single-report publication requires SCAN_URL.");
  return {
    targets: [target],
    device: scanDevice(environment.SCAN_DEVICE),
    comparisonAxis: comparisonAxis(environment, "SCAN"),
    gpcEnabled: booleanSetting(environment.SCAN_GPC_ENABLED, true)
  };
}

export async function featuredReportPublicationRequest(
  checkoutRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<ReportPublicationRequest> {
  const relativeCatalog = environment.FEATURED_SITES_FILE?.trim() || "public/featured-sites.json";
  if (!ALLOWED_FEATURED_CATALOGS.has(relativeCatalog)) {
    throw new Error("Featured publication catalog must be one of the two reviewed repository catalogs.");
  }
  if (booleanSetting(environment.FEATURED_INCLUDE_UNAVAILABLE, false)) {
    throw new Error("Committed featured publication does not allow FEATURED_INCLUDE_UNAVAILABLE.");
  }

  const catalog = await readFeaturedCatalog(path.join(checkoutRoot, ...relativeCatalog.split("/")));
  const categories = categorySetting(environment.FEATURED_CATEGORIES);
  const catalogCategories = new Set(catalog.sites.map((site) => site.category.toLowerCase()));
  for (const category of categories) {
    if (!catalogCategories.has(category)) {
      throw new Error(`FEATURED_CATEGORIES contains an unknown catalog category: ${category}.`);
    }
  }
  let sites = catalog.sites;
  if (categories.length > 0) {
    sites = sites.filter((site) => categories.includes(site.category.toLowerCase()));
  }
  const limit = positiveIntegerOrZero(environment.FEATURED_LIMIT);
  if (limit > 0) sites = sites.slice(0, limit);
  // The acquisition orchestrator excludes every valid temporary-unavailability
  // entry. If one expires without a reviewed catalog edit, acquisition itself
  // fails closed; treating metadata presence as excluded here cannot admit a
  // target that the exact-SHA orchestrator did not select.
  sites = sites.filter((site) => site.scanAvailability === undefined);
  if (sites.length === 0) throw new Error("Trusted featured publication selected no catalog targets.");

  return {
    targets: sites.map((site) => site.url),
    device: scanDevice(environment.FEATURED_DEVICE),
    comparisonAxis: comparisonAxis(environment, "FEATURED"),
    // run-featured-scans pins SCAN_GPC_ENABLED=true for every site; for a GPC
    // comparison the canonical arms below must instead be false/true.
    gpcEnabled: true
  };
}

export async function assertReportPublicationRequest(input: {
  reportsDir: string;
  reportIds: readonly string[];
  sourceCommit: string;
  request: ReportPublicationRequest;
}): Promise<void> {
  if (input.reportIds.length === 0) throw new Error("Publication request binding requires at least one new report.");
  const remainingTargets = new Map<string, number>();
  for (const target of input.request.targets) {
    const shape = publicRequestedSubject(target);
    remainingTargets.set(shape, (remainingTargets.get(shape) ?? 0) + 1);
  }

  for (const reportId of input.reportIds) {
    const bundle = await readStaticReportBundle(input.reportsDir, reportId);
    if (bundle.outcome !== "found") {
      throw new StaticReportBundleError(
        reportId,
        bundle.outcome === "not-found" ? "missing-report" : bundle.reason
      );
    }
    const facts = requestFacts(bundle.stored, input.sourceCommit);
    const expectedCount = remainingTargets.get(facts.requestedSubject) ?? 0;
    if (expectedCount < 1) {
      throw new Error(`New report ${reportId} does not match a selected workflow target.`);
    }
    remainingTargets.set(facts.requestedSubject, expectedCount - 1);
    assertRequestFacts(facts, input.request, reportId);
  }
}

/**
 * Validate one already-canonical stored report against a trusted dispatch
 * request. Exported so callers that already hold a canonical bundle can apply
 * the same binding without weakening it to top-level report metadata.
 */
export function assertStoredReportPublicationRequest(input: {
  stored: StoredScanReport;
  sourceCommit: string;
  request: ReportPublicationRequest;
  reportId?: string;
}): void {
  const reportId = input.reportId ?? "candidate";
  const facts = requestFacts(input.stored, input.sourceCommit);
  const selectedSubjects = new Set(input.request.targets.map(publicRequestedSubject));
  if (!selectedSubjects.has(facts.requestedSubject)) {
    throw new Error(`New report ${reportId} does not match a selected workflow target.`);
  }
  assertRequestFacts(facts, input.request, reportId);
}

type ReportPublicationRequestFacts = {
  requestedSubject: string;
  device: "desktop" | "mobile";
  comparisonAxis: ReportPublicationComparisonAxis | "unsupported-comparison";
  gpcStates: boolean[];
};

function assertRequestFacts(
  facts: ReportPublicationRequestFacts,
  request: ReportPublicationRequest,
  reportId: string
): void {
  if (facts.device !== request.device) {
    throw new Error(`New report ${reportId} device ${facts.device} does not match ${request.device}.`);
  }
  if (facts.comparisonAxis !== request.comparisonAxis) {
    throw new Error(`New report ${reportId} does not match the selected comparison request.`);
  }
  if (request.comparisonAxis === "gpc") {
    if (facts.gpcStates.length !== 2 || facts.gpcStates[0] !== false || facts.gpcStates[1] !== true) {
      throw new Error(`New report ${reportId} does not contain the requested GPC off/on arms.`);
    }
  } else if (facts.gpcStates.some((state) => state !== request.gpcEnabled)) {
    throw new Error(`New report ${reportId} does not match the selected GPC state.`);
  }
}

function requestFacts(
  stored: StoredScanReport,
  sourceCommit: string
): ReportPublicationRequestFacts {
  if (stored.schemaVersion === 1) {
    const report = stored.report;
    const runs = report.reportType === "comparison" ? [report.baseline, report.variant] : [report];
    if (runs.some((run) => run.conditions.automation !== "playwright-chromium")) {
      throw new Error("Committed workflow reports must come from the Node Playwright producer.");
    }
    const subjects = report.reportType === "comparison"
      ? [report.requestedUrl, ...runs.map((run) => run.conditions.requestedUrl)]
      : runs.map((run) => run.conditions.requestedUrl);
    const requestedSubject = oneRequestedSubject(subjects);
    const device = report.reportType === "comparison"
      ? report.device
      : runs[0].conditions.viewport.isMobile ? "mobile" : "desktop";
    if (runs.some((run) => run.conditions.viewport.isMobile !== (device === "mobile"))) {
      throw new Error("Committed workflow report device facts disagree.");
    }
    return {
      requestedSubject,
      device,
      comparisonAxis: report.reportType === "comparison" &&
        (report.comparisonType === "gpc" || report.comparisonType === "shields" || report.comparisonType === "consent")
        ? report.comparisonType
        : report.reportType === "comparison" ? "unsupported-comparison" : null,
      gpcStates: [...new Set(runs.map((run) => run.conditions.gpcEnabled))].sort()
    };
  }

  const report = stored.report;
  const primaryRuns = report.reportType === "comparison" ? [report.baseline, report.variant] : [report.run];
  const supportingPairs = stored.schemaRevision === 2 && stored.report.reportType === "comparison" &&
    stored.report.experiment.kind === "intervention"
    ? stored.report.experiment.supportingPairs ?? []
    : [];
  const runs = [
    ...primaryRuns,
    ...supportingPairs.flatMap((pair) => [pair.baseline, pair.variant])
  ];
  for (const run of runs) {
    if (
      run.provenance.observer !== "node-playwright" ||
      run.provenance.acquisition !== "ci-workflow" ||
      run.provenance.buildCommit !== sourceCommit ||
      run.conditions.automation !== "playwright-chromium"
    ) {
      throw new Error("Committed r2 workflow report provenance does not match the exact Node acquisition source.");
    }
  }
  const requestedSubject = oneRequestedSubject(
    runs.map((run) => `${run.subject.requested.origin}${run.subject.requested.routeShape}`)
  );
  const device = runs[0].conditions.device.kind;
  if (runs.some((run) => run.conditions.device.kind !== device)) {
    throw new Error("Committed workflow report device facts disagree.");
  }
  const comparisonAxis = report.reportType === "comparison"
    ? report.experiment.kind === "intervention" ? report.experiment.axis : "unsupported-comparison"
    : null;
  if (report.reportType === "comparison" && report.experiment.kind === "intervention") {
    assertCanonicalInterventionPair(report.baseline, report.variant, report.experiment.axis, "primary pair");
    for (const [index, pair] of supportingPairs.entries()) {
      // Pair order records chronology only. Baseline and variant retain their
      // semantic arms, so every embedded pair must carry the same canonical
      // axis states as the trusted scanner request.
      assertCanonicalInterventionPair(
        pair.baseline,
        pair.variant,
        report.experiment.axis,
        `supporting pair ${index + 1}`
      );
    }
  }
  return {
    requestedSubject,
    device,
    comparisonAxis,
    gpcStates: [...new Set(runs.map((run) => run.conditions.gpc))].sort()
  };
}

function assertCanonicalInterventionPair(
  baseline: ScanRunV2R2,
  variant: ScanRunV2R2,
  axis: InterventionAxis,
  label: string
): void {
  const expected = axis === "gpc"
    ? ["gpc:off", "gpc:on"]
    : axis === "shields"
      ? ["shields:classification", "shields:block-simulation"]
      : ["consent:accept-all", "consent:reject-all"];
  const actual = [axisStateFor(axis, baseline.conditions), axisStateFor(axis, variant.conditions)];
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    throw new Error(`Committed workflow report ${label} does not contain the canonical ${axis} request arms.`);
  }
}

function oneRequestedSubject(subjects: readonly string[]): string {
  const unique = [...new Set(subjects)];
  if (unique.length !== 1) throw new Error("Committed workflow report requested-subject facts disagree.");
  return unique[0];
}

function publicRequestedSubject(value: string): string {
  const normalized = normalizeHttpUrlInput(value);
  if (!normalized.ok) throw new Error(`Invalid trusted workflow target: ${normalized.message}`);
  assertPublicHttpUrlShape(normalized.url);
  const subject = redactUrlV2(normalized.url.href, { preserveQueryKeys: false }).value;
  if (subject === INVALID_URL_MARKER) throw new Error("Trusted workflow target has no public subject identity.");
  return subject;
}

function scanDevice(value: string | undefined): "desktop" | "mobile" {
  if (value === undefined || value === "") return "desktop";
  if (value === "desktop" || value === "mobile") return value;
  throw new Error("Trusted publication device must be exactly desktop or mobile.");
}

function comparisonAxis(
  environment: NodeJS.ProcessEnv,
  prefix: "SCAN" | "FEATURED"
): ReportPublicationComparisonAxis {
  if (booleanSetting(environment[`${prefix}_COMPARE_SHIELDS`], false)) return "shields";
  if (booleanSetting(environment[`${prefix}_COMPARE_CONSENT`], false)) return "consent";
  if (booleanSetting(environment[`${prefix}_COMPARE_GPC`], prefix === "FEATURED")) return "gpc";
  return null;
}

function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Trusted publication boolean setting is malformed: ${value}.`);
}

function positiveIntegerOrZero(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > FEATURED_LIMIT_MAX) {
    throw new Error(`FEATURED_LIMIT must be an integer from 0 to ${FEATURED_LIMIT_MAX}.`);
  }
  return parsed;
}

function categorySetting(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const categories = value.split(",").map((category) => category.trim().toLowerCase());
  if (
    categories.length > FEATURED_CATEGORY_MAX_COUNT ||
    categories.some((category) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(category))
  ) {
    throw new Error("FEATURED_CATEGORIES is malformed.");
  }
  return [...new Set(categories)];
}

async function readFeaturedCatalog(file: string): Promise<{
  sites: Array<{ url: string; domain: string; category: string; scanAvailability?: unknown }>;
}> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > FEATURED_CATALOG_MAX_BYTES) {
      throw new Error("Featured catalog is not a bounded regular file.");
    }
    bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw new Error("Featured catalog changed while it was read.");
  } finally {
    await handle.close();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Featured catalog is not valid UTF-8.");
  }
  const value = parseStrictJson(text, FEATURED_CATALOG_MAX_BYTES);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Featured catalog is invalid.");
  const sites = (value as { sites?: unknown }).sites;
  if (!Array.isArray(sites)) throw new Error("Featured catalog has no sites array.");
  if (sites.length === 0 || sites.length > FEATURED_CATALOG_MAX_SITES) {
    throw new Error(`Featured catalog must contain from 1 to ${FEATURED_CATALOG_MAX_SITES} sites.`);
  }
  const parsedSites = sites.map((site) => {
    if (!site || typeof site !== "object" || Array.isArray(site)) throw new Error("Featured catalog site is invalid.");
    const record = site as Record<string, unknown>;
    if (typeof record.url !== "string" || typeof record.domain !== "string" || typeof record.category !== "string") {
      throw new Error("Featured catalog site is invalid.");
    }
    publicRequestedSubject(record.url);
    return {
      url: record.url,
      domain: record.domain,
      category: record.category,
      ...(record.scanAvailability !== undefined ? { scanAvailability: record.scanAvailability } : {})
    };
  });
  return { sites: parsedSites };
}

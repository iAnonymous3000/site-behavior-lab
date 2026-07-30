import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { readLoadedReport } from "./client-report-reader";
import { buildCorpusExportPayload, buildCorpusExportRows } from "./corpus-export";
import { corpusCohortIdentityForView } from "./corpus-cohort";
import { loadCorpusOverview } from "./corpus-overview";
import { corpusSiteDomainKey } from "./corpus-site-domain";
import { isCorpusStats, type CorpusStats } from "./corpus-stats";
import { serializeJsonLd } from "./jsonld-script";
import { isReservedReportDomain } from "./reserved-report-domains";
import { validateReportPresentation } from "./report-consistency";
import { trackingServiceRequests } from "./report-insights";
import { buildReportDataset } from "./report-jsonld";
import {
  loadedReportFromStored,
  publicWireForExportOrPersistence
} from "./scan-report-view";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  runHitRequestRecordingCap,
  type ReportView,
  type RunView
} from "./scan-report-views";
import {
  listStaticReportCandidateIds,
  readStaticReportBundle
} from "./static-report-files";
import { buildStaticReportManifest } from "./static-report-manifest";
import {
  comparisonHistoryPairingKey,
  temporalPairingKey
} from "./temporal-deltas";
import {
  comparisonHistoryCohortForStoredReport,
  consentClicksForView,
  temporalCohortForStoredReport
} from "./temporal-report-identity";
import { sha256Hex } from "./sha256";
import type { StaticReportManifestEntry } from "./types";

// A FLOOR, deliberately not an exact count. Reports now arrive through
// reviewed automation/* proposals whose whole content is generated data, so an
// exact pin here would make every legitimate publication fail CI inside its
// own proposal. The floor still catches silent corpus shrinkage; it moves only
// on a deliberate, reviewed prune event.
const MINIMUM_COMMITTED_BUNDLES = 514;
const SITE_ORIGIN = "https://sitebehavior.org";
const FIXED_BUILD_TIME = new Date("2026-07-29T00:00:00.000Z");
const REPORT_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;

type Presentation = ReturnType<typeof validateReportPresentation>;

type AcceptedBundle = {
  id: string;
  stored: StoredScanReport;
  wire: string;
  view: ReportView;
  presentation: Presentation;
};

test("every committed bundle stays faithful across every public report surface", async () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const ids = await listStaticReportCandidateIds(reportsDir);
  assert.equal(
    ids.length >= MINIMUM_COMMITTED_BUNDLES,
    true,
    `committed corpus shrank below its reviewed floor: ${ids.length} < ${MINIMUM_COMMITTED_BUNDLES}; lower the floor only on a deliberate prune`
  );
  assert.equal(new Set(ids).size, ids.length, "report ids must be unique");
  assert.equal(ids.every((id) => REPORT_ID_PATTERN.test(id)), true, "every candidate must have a canonical report id");

  const corpus = await readProductionCorpusStats();
  const bundles: AcceptedBundle[] = [];

  for (const id of ids) {
    const managed = await readStaticReportBundle(reportsDir, id);
    assert.equal(managed.outcome, "found", `${id}: managed bundle reader`);
    if (managed.outcome !== "found") continue;

    const parsed: unknown = JSON.parse(managed.wire);
    const generic = readStoredScanReport(parsed);
    assert.equal(generic.ok, true, `${id}: generic stored-report reader`);
    if (!generic.ok) continue;
    assert.deepEqual(generic.stored, managed.stored, `${id}: managed and generic readers disagree`);

    const loaded = loadedReportFromStored(generic.stored);
    const expectedSource =
      generic.stored.schemaVersion === 1
        ? "v1"
        : generic.stored.schemaRevision === 1
          ? "v2-public"
          : "v2-r2-public";
    assert.equal(loaded.source, expectedSource, `${id}: loaded source`);
    assert.equal(loaded.view.reportType, generic.stored.report.reportType, `${id}: view report type`);

    const client = await readLoadedReport(parsed, `Committed report ${id}`);
    assert.equal(client.ok, true, `${id}: browser/client report reader`);
    if (client.ok) {
      assert.deepEqual(client.loaded.view, loaded.view, `${id}: client and canonical views disagree`);
    }

    const publicWire = publicWireForExportOrPersistence(loaded);
    assert.deepEqual(publicWire, parsed, `${id}: public export wire changed the committed representation`);

    const presentation = validateReportPresentation(loaded.view, corpus);
    assert.deepEqual(presentation.violations, [], `${id}: presentation consistency contradictions`);
    assert.equal(presentation.facts.view, loaded.view, `${id}: presentation facts use another view`);
    assert.notEqual(presentation.headline.headline.trim(), "", `${id}: empty headline`);
    assert.notEqual(presentation.headline.subhead.trim(), "", `${id}: empty headline explanation`);
    assert.equal(presentation.findings.length > 0, true, `${id}: empty findings board`);
    assert.equal(
      new Set(presentation.findings.map((finding) => finding.id)).size,
      presentation.findings.length,
      `${id}: duplicate finding ids`
    );

    assertJsonLdFidelity(id, loaded.view, presentation);
    bundles.push({
      id,
      stored: generic.stored,
      wire: managed.wire,
      view: loaded.view,
      presentation
    });
  }

  assert.equal(bundles.length, ids.length, "every committed bundle must complete every read/render path");

  await assertCorpusProjection(bundles, corpus);
  await assertManifestProjection(reportsDir, bundles);
});

async function readProductionCorpusStats(): Promise<CorpusStats> {
  const value: unknown = JSON.parse(
    await readFile(path.join(process.cwd(), "public", "corpus-stats.json"), "utf8")
  );
  assert.equal(isCorpusStats(value), true, "the committed production corpus stats must be readable");
  return value as CorpusStats;
}

function assertJsonLdFidelity(id: string, view: ReportView, presentation: Presentation): void {
  const url = `${SITE_ORIGIN}/reports/${id}/`;
  const jsonUrl = `${SITE_ORIGIN}/reports/${id}.json`;
  const dataset = buildReportDataset(view, { url, jsonUrl });
  const serialized = serializeJsonLd(dataset);
  const parsed: unknown = JSON.parse(serialized);

  assert.deepEqual(parsed, dataset, `${id}: serialized JSON-LD changed the dataset`);
  assert.equal(serialized.includes("<"), false, `${id}: JSON-LD retained raw <`);
  assert.equal(serialized.includes(">"), false, `${id}: JSON-LD retained raw >`);
  assert.equal(serialized.includes("&"), false, `${id}: JSON-LD retained raw &`);
  assert.equal(serialized.includes("\u2028"), false, `${id}: JSON-LD retained U+2028`);
  assert.equal(serialized.includes("\u2029"), false, `${id}: JSON-LD retained U+2029`);

  const arms = comparisonArmViews(view);
  const subjectEstablished = arms
    ? presentation.facts.sameSubject === true &&
      presentation.facts.arms?.baseline.subject.describesSubject === true &&
      presentation.facts.arms.variant.subject.describesSubject === true
    : presentation.facts.display.subject.describesSubject;
  const subjectRun = arms ? arms.variant : displayRunView(view);
  const expectedName = subjectEstablished
    ? `Site Behavior Lab scan of ${presentation.headline.domain}`
    : `Site Behavior Lab returned-document scan while requesting ${presentation.headline.domain}`;

  assert.equal(dataset["@context"], "https://schema.org", `${id}: JSON-LD context`);
  assert.equal(dataset["@type"], "Dataset", `${id}: JSON-LD type`);
  assert.equal(dataset.name, expectedName, `${id}: JSON-LD subject framing`);
  assert.equal(dataset.description, presentation.headline.subhead, `${id}: JSON-LD/headline disagreement`);
  assert.equal(dataset.url, url, `${id}: JSON-LD report URL`);
  assert.equal(dataset.dateCreated, view.scannedAt, `${id}: JSON-LD scan time`);
  assert.deepEqual(
    dataset.distribution,
    { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: jsonUrl },
    `${id}: JSON-LD public-wire link`
  );

  if (subjectEstablished) {
    const expectedAbout: Record<string, unknown> = {
      "@type": "WebSite",
      name: presentation.headline.domain
    };
    if (
      !subjectRun.conditions.urlsAreRouteShapes &&
      urlBelongsToSubject(subjectRun.conditions.requestedUrl, subjectRun.domain)
    ) {
      expectedAbout.url = subjectRun.conditions.requestedUrl;
    }
    assert.deepEqual(dataset.about, expectedAbout, `${id}: JSON-LD site attribution`);
  } else {
    assert.equal(dataset.about, undefined, `${id}: unverified subject received WebSite attribution`);
  }

  const measured = dataset.variableMeasured;
  assert.equal(Array.isArray(measured), true, `${id}: JSON-LD measurements`);
  const expectedMeasurements = jsonLdCountExpectations(view);
  const expectedQualityNames = jsonLdQualityNames(view);
  const observedNames = new Set<string>();

  for (const value of measured as unknown[]) {
    assert.equal(isRecord(value), true, `${id}: malformed JSON-LD PropertyValue`);
    if (!isRecord(value)) continue;
    assert.equal(value["@type"], "PropertyValue", `${id}: JSON-LD measurement type`);
    assert.equal(typeof value.name, "string", `${id}: JSON-LD measurement name`);
    if (typeof value.name !== "string") continue;
    assert.equal(observedNames.has(value.name), false, `${id}: duplicate JSON-LD measurement ${value.name}`);
    observedNames.add(value.name);

    if (expectedQualityNames.has(value.name)) {
      assert.equal(typeof value.value, "string", `${id}: JSON-LD quality value`);
      assert.equal("minValue" in value, false, `${id}: JSON-LD quality cannot be a numeric lower bound`);
      continue;
    }

    const expected = expectedMeasurements.get(value.name);
    assert.notEqual(expected, undefined, `${id}: unexpected JSON-LD measurement ${value.name}`);
    const hasExact = "value" in value;
    const hasLowerBound = "minValue" in value;
    assert.notEqual(hasExact, hasLowerBound, `${id}: ${value.name} must have exactly one numeric value form`);
    const observed = hasExact ? value.value : value.minValue;
    assert.equal(typeof observed, "number", `${id}: ${value.name} must be numeric`);
    assert.equal(Number.isFinite(observed), true, `${id}: ${value.name} must be finite`);
    assert.equal(observed, expected, `${id}: ${value.name} disagrees with the report view`);
  }
}

function jsonLdCountExpectations(view: ReportView): Map<string, number> {
  const arms = comparisonArmViews(view);
  if (!arms) return runCountExpectations(displayRunView(view), "");
  const labels = view.comparison?.runLabels;
  return new Map([
    ...runCountExpectations(arms.baseline, ` (${labels?.baseline ?? "baseline"})`),
    ...runCountExpectations(arms.variant, ` (${labels?.variant ?? "variant"})`)
  ]);
}

function jsonLdQualityNames(view: ReportView): Set<string> {
  const arms = comparisonArmViews(view);
  if (!arms) return new Set(["Measurement quality"]);
  const labels = view.comparison?.runLabels;
  return new Set([
    `Measurement quality (${labels?.baseline ?? "baseline"})`,
    `Measurement quality (${labels?.variant ?? "variant"})`
  ]);
}

function runCountExpectations(run: RunView, suffix: string): Map<string, number> {
  return new Map([
    [`Third-party requests${suffix}`, run.counts.thirdPartyRequests],
    [`Catalogued service requests${suffix}`, run.counts.knownTrackerRequests],
    [`Third-party domains${suffix}`, run.counts.thirdPartyDomains],
    [`Third-party cookies${suffix}`, run.counts.thirdPartyCookies],
    [`Fingerprint-like API calls${suffix}`, run.counts.fingerprintEvents]
  ]);
}

function urlBelongsToSubject(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const subject = domain.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (host === "" || subject === "" || host === "unknown" || subject === "unknown") return false;
    return host === subject || host.endsWith(`.${subject}`) || subject.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

async function assertCorpusProjection(bundles: AcceptedBundle[], corpus: CorpusStats): Promise<void> {
  const publicBundles = bundles.filter(
    ({ view }) => !isReservedReportDomain(displayRunView(view).domain)
  );
  const expectedIds = publicBundles.map(({ id }) => id).sort();
  const overview = await loadCorpusOverview();
  const overviewIds = overview.entries.map(({ id }) => id).sort();
  assert.deepEqual(overviewIds, expectedIds, "corpus export must contain exactly the non-reserved committed bundles");

  const rows = buildCorpusExportRows(overview.entries, SITE_ORIGIN);
  assert.deepEqual(
    rows.map(({ id }) => id).sort(),
    expectedIds,
    "corpus export rows must project every public committed bundle exactly once"
  );

  const bundleById = new Map(publicBundles.map((bundle) => [bundle.id, bundle]));
  for (const row of rows) {
    const bundle = bundleById.get(row.id);
    assert.ok(bundle, `${row.id}: corpus row has no committed bundle`);
    if (!bundle) continue;
    const run = displayRunView(bundle.view);
    const arms = comparisonArmViews(bundle.view);
    const cohort = corpusCohortIdentityForView(bundle.view);
    const decision = bundle.view.claims.decision;
    const expectedComparisonType =
      bundle.view.reportType === "comparison"
        ? bundle.view.comparison?.axis ??
          (bundle.view.comparison?.temporalPair ? "temporal" : "custom")
        : null;
    const expectedShieldsChange =
      arms &&
      bundle.view.comparison?.axis === "shields" &&
      bundle.view.claims.pairComparison?.allowed === true &&
      bundle.view.claims.familyDeltas?.["raw-counts"]?.allowed === true
        ? arms.variant.counts.thirdPartyRequests - arms.baseline.counts.thirdPartyRequests
        : null;

    assert.equal(row.domain, bundle.presentation.headline.domain, `${row.id}: corpus domain`);
    assert.equal(row.headline, bundle.presentation.headline.headline, `${row.id}: corpus headline`);
    assert.equal(row.thirdPartyRequests, run.counts.thirdPartyRequests, `${row.id}: corpus request count`);
    assert.equal(row.trackerRequests, trackingServiceRequests(run.evidence), `${row.id}: corpus tracker count`);
    assert.equal(row.thirdPartyCookies, run.counts.thirdPartyCookies, `${row.id}: corpus cookie count`);
    assert.equal(row.shieldsThirdPartyChange, expectedShieldsChange, `${row.id}: corpus Shields change`);
    assert.equal(row.scannedAt, bundle.view.scannedAt, `${row.id}: corpus scan time`);
    assert.equal(row.reportType, bundle.view.reportType, `${row.id}: corpus report type`);
    assert.equal(row.comparisonType, expectedComparisonType, `${row.id}: corpus comparison type`);
    assert.equal(row.device, run.conditions.viewport.isMobile ? "mobile" : "desktop", `${row.id}: corpus device`);
    assert.equal(row.gpcEnabled, run.conditions.gpcEnabled, `${row.id}: corpus GPC condition`);
    assert.equal(row.consentMode, run.conditions.consentMode, `${row.id}: corpus consent mode`);
    assert.equal(row.consentClicks, consentClicksForView(bundle.view), `${row.id}: corpus consent dispatch`);
    assert.equal(row.status, run.status, `${row.id}: corpus status`);
    assert.equal(row.runOutcome, run.quality.outcome, `${row.id}: corpus run outcome`);
    assert.equal(row.requestCapped, runHitRequestRecordingCap(run), `${row.id}: corpus cap flag`);
    assert.equal(row.requestEvidenceComplete, !familyCensoredOnRun(run, "requests"), `${row.id}: corpus completeness`);
    assert.equal(row.schemaVersion, bundle.stored.schemaVersion, `${row.id}: corpus schema version`);
    assert.equal(row.schemaRevision, bundle.view.revision, `${row.id}: corpus schema revision`);
    assert.equal(row.schemaOrigin, bundle.view.origin, `${row.id}: corpus schema origin`);
    assert.equal(row.limited, bundle.view.limited, `${row.id}: corpus limited marker`);
    assert.equal(row.producer, run.provenance?.observer ?? null, `${row.id}: corpus producer`);
    assert.equal(row.acquisition, run.provenance?.acquisition ?? null, `${row.id}: corpus acquisition`);
    assert.equal(row.buildCommit, run.provenance?.buildCommit ?? null, `${row.id}: corpus build commit`);
    assert.equal(row.browserName, run.conditions.browserName, `${row.id}: corpus browser name`);
    assert.equal(row.browserVersion, run.conditions.browserVersion, `${row.id}: corpus browser version`);
    assert.equal(row.egressLabel, run.conditions.scannerEgress, `${row.id}: corpus egress`);
    assert.equal(row.egressRegion, run.conditions.scannerEgressRegion, `${row.id}: corpus egress region`);
    assert.equal(row.corpusCohortId, cohort.id, `${row.id}: corpus cohort`);
    assert.equal(row.methodologyVersion, cohort.methodologyVersion, `${row.id}: corpus methodology`);
    assert.equal(row.methodologyOrigin, cohort.methodologyOrigin, `${row.id}: corpus methodology origin`);
    assert.equal(row.consentChoiceState, run.consent?.choiceState ?? null, `${row.id}: corpus consent state`);
    assert.equal(
      row.variantConsentChoiceState,
      arms?.variant.consent?.choiceState ?? null,
      `${row.id}: corpus variant consent state`
    );
    assert.equal(row.comparisonDecisionMode, decision?.mode ?? null, `${row.id}: corpus comparison decision`);
    assert.equal(
      row.compatibilityFingerprintOrigin,
      decision?.compatibility.origin ?? null,
      `${row.id}: corpus compatibility origin`
    );
    assert.equal(
      row.compatibilityFingerprintMatched,
      decision?.compatibility.matched ?? null,
      `${row.id}: corpus compatibility match`
    );
    assert.equal(row.reportUrl, `${SITE_ORIGIN}/reports/${row.id}/`, `${row.id}: corpus report URL`);
    assert.equal(row.jsonUrl, `${SITE_ORIGIN}/reports/${row.id}.json`, `${row.id}: corpus JSON URL`);
  }

  const expectedCounts = independentCorpusSiteCounts(publicBundles);
  assert.equal(overview.attemptedSiteCount, expectedCounts.attempted, "corpus attempted-site count");
  assert.equal(overview.coverageSiteCount, expectedCounts.coverage, "corpus coverage-site count");
  assert.equal(overview.failedSiteCount, expectedCounts.failed, "corpus failed-site count");
  assert.equal(overview.cappedSiteCount, expectedCounts.capped, "corpus capped-site count");
  assert.equal(overview.siteCount, corpus.sampleSize, "directory and corpus-stats measured denominators");
  assert.equal(overview.aggregateCohort?.id ?? null, corpus.primaryCohortId ?? null, "directory and stats primary cohort");
  assert.equal(corpus.coverageSiteCount, expectedCounts.coverage, "committed stats coverage count");
  assert.equal(corpus.cappedSiteCount, expectedCounts.capped, "committed stats capped count");

  const payload = buildCorpusExportPayload(rows, {
    generatedAt: FIXED_BUILD_TIME.toISOString(),
    siteCount: expectedCounts.coverage,
    measuredSampleSize: corpus.sampleSize,
    primaryCohortId: corpus.primaryCohortId
  });
  assert.equal(payload.reportCount, expectedIds.length, "corpus JSON report count");
  assert.equal(payload.reports.length, expectedIds.length, "corpus JSON row count");
  assert.equal(payload.siteCount, expectedCounts.coverage, "corpus JSON site count");
  assert.equal(payload.measuredSampleSize, corpus.sampleSize, "corpus JSON measured count");
  assert.equal(payload.primaryCohortId, corpus.primaryCohortId ?? null, "corpus JSON primary cohort");

  for (const cohort of payload.cohorts) {
    const cohortRows = rows.filter((row) => row.corpusCohortId === cohort.id);
    const included = cohortRows.filter((row) => row.corpusInclusion === "included");
    const denominator = new Set(
      included.map((row) => corpusSiteDomainKey(row.domain) || row.domain.toLowerCase())
    ).size;
    assert.equal(cohort.denominator, denominator, `${cohort.id}: exported cohort denominator`);
    assert.equal(cohort.includedRows, included.length, `${cohort.id}: exported included rows`);
    assert.equal(cohort.excludedRows, cohortRows.length - included.length, `${cohort.id}: exported excluded rows`);
    assert.equal(
      cohortRows.every((row) => row.corpusCohortDenominator === denominator),
      true,
      `${cohort.id}: row-level cohort denominator`
    );
  }

  const shieldsChanges = rows
    .map((row) => row.shieldsThirdPartyChange)
    .filter((value): value is number => value !== null);
  assert.deepEqual(
    payload.shieldsChangeSummary,
    {
      pairedReports: shieldsChanges.length,
      decreased: shieldsChanges.filter((value) => value < 0).length,
      flat: shieldsChanges.filter((value) => value === 0).length,
      increased: shieldsChanges.filter((value) => value > 0).length
    },
    "corpus Shields aggregate"
  );
}

function independentCorpusSiteCounts(bundles: AcceptedBundle[]): {
  attempted: number;
  coverage: number;
  failed: number;
  capped: number;
} {
  const attempted = new Set<string>();
  const coverage = new Set<string>();
  const capped = new Set<string>();

  for (const bundle of bundles) {
    const domain =
      corpusSiteDomainKey(bundle.presentation.headline.domain) ||
      bundle.presentation.headline.domain.toLowerCase();
    attempted.add(domain);
    const successfulRuns = bundle.view.runs.filter(
      (run) =>
        run.quality.outcome === "complete" &&
        typeof run.status === "number" &&
        run.status < 400
    );
    if (successfulRuns.length === 0) continue;
    coverage.add(domain);
    if (successfulRuns.some(runHitRequestRecordingCap)) capped.add(domain);
  }

  return {
    attempted: attempted.size,
    coverage: coverage.size,
    failed: [...attempted].filter((domain) => !coverage.has(domain)).length,
    capped: capped.size
  };
}

async function assertManifestProjection(
  reportsDir: string,
  bundles: AcceptedBundle[]
): Promise<void> {
  const built = await buildStaticReportManifest(reportsDir, FIXED_BUILD_TIME);
  const expected = bundles
    .map(expectedManifestEntry)
    .filter((entry): entry is StaticReportManifestEntry => entry !== null)
    .sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));

  assert.deepEqual(built.warnings, [], "managed manifest build must not skip a bundle");
  assert.equal(built.manifest.generatedAt, FIXED_BUILD_TIME.toISOString(), "manifest generation time");
  assert.equal(built.manifest.reports.length, expected.length, "manifest public entry count");
  assert.deepEqual(built.manifest.reports, expected, "manifest entries must be exact view/wire projections");
}

function expectedManifestEntry(bundle: AcceptedBundle): StaticReportManifestEntry | null {
  const { id, stored, view, wire, presentation } = bundle;
  const lead = displayRunView(view);
  const tail = view.runs[view.runs.length - 1];
  if (!lead || !tail || isReservedReportDomain(lead.domain)) return null;
  const comparison = view.reportType === "comparison";
  const comparisonType = comparison
    ? view.comparison?.axis ??
      (view.comparison?.temporalPair ? ("temporal" as const) : ("custom" as const))
    : undefined;
  const historyKey = temporalPairingKey({
    domain: lead.domain,
    reportType: view.reportType,
    comparisonType,
    consentClicks: consentClicksForView(view),
    requestedUrl: lead.conditions.requestedUrl,
    finalUrl: lead.conditions.finalUrl,
    temporalCohort: temporalCohortForStoredReport(stored, view)
  });
  const comparisonHistoryKey = comparisonHistoryPairingKey({
    domain: lead.domain,
    reportType: view.reportType,
    comparisonType,
    consentClicks: consentClicksForView(view),
    requestedUrl: lead.conditions.requestedUrl,
    finalUrl: lead.conditions.finalUrl,
    comparisonHistoryCohort: comparisonHistoryCohortForStoredReport(stored, view)
  });
  const facts = presentation.facts.display;

  return {
    id,
    reportWireBytes: new TextEncoder().encode(wire).byteLength,
    reportWireSha256: sha256Hex(wire),
    title: (view.title ?? "").trim() || lead.pageTitle || lead.domain,
    headline: presentation.headline.headline,
    tone: presentation.headline.tone,
    domain: presentation.headline.domain,
    requestedUrl: (comparison ? tail : lead).conditions.requestedUrl,
    scannedAt: view.scannedAt ?? "",
    reportType: view.reportType,
    ...(comparison ? { comparisonType } : {}),
    device: (comparison ? tail : lead).conditions.viewport.isMobile ? "mobile" : "desktop",
    gpcEnabled: comparison ? "comparison" : lead.conditions.gpcEnabled,
    ...(runHitRequestRecordingCap(lead) ? { requestCapped: true } : {}),
    ...(historyKey ? { historyKey } : {}),
    ...(comparisonHistoryKey ? { comparisonHistoryKey } : {}),
    metrics: {
      totalRequests: lead.counts.totalRequests,
      thirdPartyRequests: lead.counts.thirdPartyRequests,
      knownTrackerRequests: lead.counts.knownTrackerRequests,
      thirdPartyDomains: lead.counts.thirdPartyDomains,
      cookies: lead.counts.cookies,
      thirdPartyCookies: lead.counts.thirdPartyCookies,
      ...(facts.claims["fingerprint-apis"].exactCountAllowed
        ? { fingerprintEvents: lead.counts.fingerprintEvents }
        : {}),
      ...(lead.counts.shieldsBlockedRequests !== null
        ? { shieldsBlockedRequests: lead.counts.shieldsBlockedRequests }
        : {})
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

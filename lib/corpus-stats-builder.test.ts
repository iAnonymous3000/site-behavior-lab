import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createComparisonReport } from "./compare-reports";
import { buildCorpusStats } from "./corpus-stats-builder";
import { loadCorpusOverview } from "./corpus-overview";
import { runInCorpusDistributionPopulation, type RunView } from "./scan-report-view";
import { LEGACY_V1_METHODOLOGY_UNSPECIFIED, NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildStaticReportShare } from "./report-locator";
import { scannerDisclosure } from "./scan-condition-disclosure";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { currentR2NormalizationForObserver } from "./scan-report-v2-normalization";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import {
  r2ReportRuns,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

let reportsDir = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-corpus-stats-"));
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

function makeResult(overrides: {
  firstPartyDomain?: string;
  /** The URL the visit was asked for; defaults to the first-party host's root. */
  requestedUrl?: string;
  thirdPartyRequests?: number;
  status?: number;
  scannedAt?: string;
  gpcEnabled?: boolean;
} = {}): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType === "comparison") throw new Error("fixture must be a single report");
  const thirdPartyRequests = overrides.thirdPartyRequests ?? base.summary.thirdPartyRequests;
  const firstPartyDomain = overrides.firstPartyDomain ?? "shop-fixture.dev";
  const subjectUrl = `https://${firstPartyDomain}/`;
  const requestedUrl = overrides.requestedUrl ?? subjectUrl;
  return {
    ...base,
    requests:
      overrides.thirdPartyRequests === undefined
        ? base.requests
        : Array.from({ length: thirdPartyRequests }, (_, index) => ({
            id: index + 1,
            url: `https://tracker.example.net/privacy?utm_source=${index}`,
            domain: "tracker.example.net",
            method: "GET",
            resourceType: "image",
            status: 200,
            thirdParty: true,
            tracker: null,
            startedAtMs: index
          })),
    summary: {
      ...base.summary,
      firstPartyDomain,
      totalRequests: overrides.thirdPartyRequests === undefined ? base.summary.totalRequests : thirdPartyRequests,
      thirdPartyRequests,
      status: overrides.status ?? base.summary.status
    },
    conditions: {
      ...base.conditions,
      requestedUrl,
      finalUrl: subjectUrl,
      scannedAt: overrides.scannedAt ?? base.conditions.scannedAt,
      gpcEnabled: overrides.gpcEnabled ?? base.conditions.gpcEnabled
    }
  };
}

async function writeReport(id: string, report: unknown): Promise<void> {
  const redacted = redactScanReportV1(report as ScanReport).report;
  await writeReportAndSidecar(id, redacted);
}

async function writeRawManagedReport(id: string, report: unknown): Promise<void> {
  await writeReportAndSidecar(id, report);
}

async function writeReportAndSidecar(id: string, report: unknown): Promise<void> {
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report)}\n`);
  const value = report as {
    scannedAt?: unknown;
    conditions?: { scannedAt?: unknown };
    run?: { startedAt?: unknown };
  };
  const createdAt = value.scannedAt ?? value.conditions?.scannedAt ?? value.run?.startedAt;
  if (typeof createdAt !== "string") throw new Error("fixture needs a recorded scan time");
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: "2026-07-12T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
}

function currentR2FixedPoint(report: ReturnType<typeof makePublicSingleReportV2R2>) {
  for (const run of r2ReportRuns(report)) {
    run.privacy.redactionVersion = REDACTION_VERSION;
    const normalization = currentR2NormalizationForObserver(run.provenance.observer);
    if (normalization === null) throw new Error("fixture observer has no current normalization");
    run.toolchain.normalizationVersion = normalization;
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  const redacted = redactPublicScanReportV2R2(report);
  if (redacted.reportType !== "single") throw new Error("expected a single fixture");
  return redacted;
}

test("one data point per site, newest scan wins, percentiles over real sites", async () => {
  await writeReport(
    "20260601-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "one-fixture.dev", thirdPartyRequests: 10, scannedAt: "2026-06-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    makeResult({ firstPartyDomain: "one-fixture.dev", thirdPartyRequests: 40, scannedAt: "2026-07-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-cccccccccccccccccccccccccccccccc",
    makeResult({ firstPartyDomain: "two-fixture.dev", thirdPartyRequests: 20, scannedAt: "2026-07-01T00:00:00.000Z" })
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.sampleSize, 2);
  // one-fixture.dev contributes its NEWEST scan (40), not the older 10.
  assert.equal(stats.metrics.thirdPartyRequests?.max, 40);
  assert.equal(stats.metrics.thirdPartyRequests?.min, 20);
});

test("v4 publishes distinct catalogued-service and tracking-service distributions", async () => {
  const report = makeResult({ firstPartyDomain: "dual-metric-fixture.dev" });
  report.requests = [
    {
      id: 1,
      url: "https://dual-metric-fixture.dev/pixel",
      domain: "dual-metric-fixture.dev",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: false,
      tracker: {
        domain: "dual-metric-fixture.dev",
        entity: "dual-metric-fixture.dev",
        category: "tracking (Brave Shields list)",
        confidence: "shields-list"
      },
      startedAtMs: 0
    }
  ];
  report.summary.totalRequests = 1;
  report.summary.thirdPartyRequests = 0;
  report.summary.knownTrackerRequests = 1;
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", report);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.version, 4);
  assert.equal(stats.metricContractVersion, METRIC_CONTRACT_VERSION);
  assert.equal(stats.metricContractDigest, METRIC_CONTRACT_DIGEST);
  assert.equal(stats.metrics.cataloguedServiceRequests?.min, 1);
  assert.equal(stats.metrics.trackingServiceRequests?.max, 0);
  assert.equal("knownTrackerRequests" in stats.metrics, false);
});

test("equal timestamps choose the lexicographically larger immutable report id", async () => {
  const scannedAt = "2026-07-01T00:00:00.000Z";
  await writeReport(
    "20260701-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "tie-fixture.dev", thirdPartyRequests: 10, scannedAt })
  );
  await writeReport(
    "20260701-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    makeResult({ firstPartyDomain: "tie-fixture.dev", thirdPartyRequests: 40, scannedAt })
  );

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.metrics.thirdPartyRequests?.min, 40);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 40);
});

test("a visit asked for a generalized sub-property neither represents its apex nor adds a site", async () => {
  // This used to pin the opposite: a newer `{label}.mit.edu` report "wins" as
  // mit.edu's data point. The premise, that the marker host is a redacted
  // spelling of the same site, does not hold: the seed catalog curates
  // ocw.mit.edu beside mit.edu and plato.stanford.edu beside stanford.edu, and
  // the real redaction below turns each sub-property into `{label}.<apex>`.
  // On 2026-08-24 the plato scan landed 41 s after www.stanford.edu's, so the
  // published stanford.edu distribution point, directory row and history
  // header were plato's (3 third-party requests in place of 71). A visit whose
  // requested host the reader cannot recover names no site: it must not stand
  // in for the apex and must not count as a site of its own. A visit asked
  // for the apex that merely LANDED on a generalized host (www.clevelandclinic
  // .org answers from my.clevelandclinic.org) is still that site's own visit.
  await writeReport(
    "20260601-12121212121212121212121212121212",
    makeResult({ firstPartyDomain: "www.mit.edu", thirdPartyRequests: 10, scannedAt: "2026-06-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-34343434343434343434343434343434",
    makeResult({ firstPartyDomain: "ocw.mit.edu", thirdPartyRequests: 40, scannedAt: "2026-07-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260701-56565656565656565656565656565656",
    makeResult({ firstPartyDomain: "www.stanford.edu", thirdPartyRequests: 20, scannedAt: "2026-07-01T00:00:00.000Z" })
  );
  await writeReport(
    "20260702-78787878787878787878787878787878",
    makeResult({ firstPartyDomain: "home.unicode.org", thirdPartyRequests: 60, scannedAt: "2026-07-02T00:00:00.000Z" })
  );
  await writeReport(
    "20260703-9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
    makeResult({
      firstPartyDomain: "my.clevelandclinic.org",
      requestedUrl: "https://www.clevelandclinic.org/",
      thirdPartyRequests: 30,
      scannedAt: "2026-07-03T00:00:00.000Z"
    })
  );

  // The fixture goes through the real publication redaction, so the marker
  // is the one the corpus carries, not a hand-written spelling.
  const ocw = JSON.parse(await readFile(path.join(reportsDir, "20260701-34343434343434343434343434343434.json"), "utf8")) as {
    conditions: { requestedUrl: string };
  };
  assert.equal(ocw.conditions.requestedUrl, "https://{label}.mit.edu/");
  const clinic = JSON.parse(await readFile(path.join(reportsDir, "20260703-9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a.json"), "utf8")) as {
    conditions: { requestedUrl: string; finalUrl: string };
  };
  assert.equal(clinic.conditions.requestedUrl, "https://www.clevelandclinic.org/");
  assert.equal(clinic.conditions.finalUrl, "https://{label}.clevelandclinic.org/");

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 3, "mit.edu, stanford.edu and clevelandclinic.org; the generalized subjects add no site");
  assert.equal(stats.coverageSiteCount, 3);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 30, "the clinic's own redirected visit is measured");
  assert.equal(stats.metrics.thirdPartyRequests?.min, 10, "www.mit.edu stays mit.edu's data point over the newer ocw visit");
  assert.equal(stats.metrics.thirdPartyRequests?.count, 3);
  assert.equal(stats.metrics.thirdPartyRequests?.p50, 20);
});

test("a loaded v2 site stays covered even though its metrics are never measured", async () => {
  await writeReport(
    "20260701-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "legacy-fixture.dev", thirdPartyRequests: 20 })
  );

  const id = "20260710-cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
  let r2 = makePublicSingleReportV2R2();
  const subject = { origin: "https://covered-fixture.dev", registrableDomain: "covered-fixture.dev", routeShape: "/" };
  r2.run.subject = { requested: subject, observed: { ...subject } };
  r2.share = buildStaticReportShare(id);
  r2 = currentR2FixedPoint(r2);
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(r2, null, 2)}\n`);
  await writeFile(
    path.join(reportsDir, committedSidecarFilename(id)),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: r2,
        writtenAt: "2026-07-14T00:00:00.000Z",
        createdAt: r2.run.startedAt,
        expiresAt: null
      })
    )}\n`
  );

  const { stats } = await buildCorpusStats(reportsDir);
  // Coverage must not shrink as a site's newest evidence migrates from v1 to
  // v2: the v2 site loaded, so it is covered; only measurement stays v1-only.
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.coverageSiteCount, 2);
});

test("a failed v2 run is not counted as successful coverage even with status 200", async () => {
  const id = "20260710-efefefefefefefefefefefefefefefef";
  let r2 = makePublicSingleReportV2R2();
  const subject = { origin: "https://blocked-fixture.dev", registrableDomain: "blocked-fixture.dev", routeShape: "/" };
  r2.run.subject = { requested: subject, observed: { ...subject } };
  r2.run.summary.status = 200;
  r2.run.qualityFacts = { ...r2.run.qualityFacts, botWallTitleMatched: true };
  r2.run.quality = evaluateQuality(r2.run.qualityFacts, { observedRequests: r2.run.evidence.requests.length });
  r2.share = buildStaticReportShare(id);
  r2 = currentR2FixedPoint(r2);
  await writeRawManagedReport(id, r2);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 0);
  assert.equal(stats.coverageSiteCount, 0);
});

test("r2 reports get a separate methodology cohort and never enter the legacy v1 compatibility view", async () => {
  await writeReport(
    "20260701-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    makeResult({ firstPartyDomain: "legacy-fixture.dev", thirdPartyRequests: 20 })
  );

  const id = "20260710-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let r2 = makePublicSingleReportV2R2();
  const subject = { origin: "https://r2-fixture.dev", registrableDomain: "r2-fixture.dev", routeShape: "/" };
  r2.run.subject = { requested: subject, observed: { ...subject } };
  r2.run.qualityFacts = {
    ...r2.run.qualityFacts,
    captureLoss: [{ family: "cookies", phaseId: null, kind: "dropped", count: 1 }]
  };
  r2.run.quality = evaluateQuality(r2.run.qualityFacts, { observedRequests: r2.run.evidence.requests.length });
  r2.share = buildStaticReportShare(id);
  r2 = currentR2FixedPoint(r2);
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(r2, null, 2)}\n`);
  await writeFile(
    path.join(reportsDir, committedSidecarFilename(id)),
    `${JSON.stringify(
      buildProvenanceEntry({
        reportId: id,
        publicReport: r2,
        writtenAt: "2026-07-12T00:00:00.000Z",
        createdAt: r2.run.startedAt,
        expiresAt: null
      })
    )}\n`
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.metrics.thirdPartyRequests?.min, 20);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 20);
  assert.equal(stats.coverageSiteCount, 2);
  assert.equal(stats.version, 4);
  assert.equal(stats.cohorts?.length, 2);
  const r2Cohort = stats.cohorts?.find((cohort) => cohort.schemaVersion === 2);
  assert.equal(r2Cohort?.sampleSize, 1);
  assert.equal(r2Cohort?.metrics.thirdPartyRequests?.count, 1);
  assert.equal(r2Cohort?.metrics.thirdPartyCookies, undefined, "cookie-only loss reduces only that metric denominator");
  assert.equal(r2Cohort?.methodologyOrigin, "recorded");
  assert.equal(r2Cohort?.producer, "node-playwright");
  assert.equal(r2Cohort?.trackerCatalogDigest, r2.run.toolchain.trackerCatalog.digest);
  assert.equal(r2Cohort?.trackerCatalogOrigin, "recorded");
  assert.match(r2Cohort?.serviceRoleTaxonomyVersion ?? "", /^service-role-taxonomy-v\d+$/);
  assert.match(r2Cohort?.serviceRoleTaxonomyDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(r2Cohort?.metricContractVersion, METRIC_CONTRACT_VERSION);
  assert.equal(r2Cohort?.metricContractDigest, METRIC_CONTRACT_DIGEST);
  assert.deepEqual(warnings, []);
});

test("an incomplete detector removes only its own metric from the corpus distribution", async () => {
  const id = "20260710-12121212121212121212121212121212";
  let r2 = makePublicSingleReportV2R2();
  const subject = {
    origin: "https://detector-gap-fixture.dev",
    registrableDomain: "detector-gap-fixture.dev",
    routeShape: "/"
  };
  r2.run.subject = { requested: subject, observed: { ...subject } };
  r2.run.detectors["fingerprint-heuristics"] = {
    ...r2.run.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "engine-unavailable",
    phaseId: 0
  };
  r2.run.qualityFacts.captureLoss.push({
    family: "fingerprinting",
    phaseId: 0,
    kind: "dropped",
    count: 1,
    detail: "fingerprint-observer"
  });
  r2.run.quality = evaluateQuality(r2.run.qualityFacts, {
    observedRequests: r2.run.evidence.requests.length
  });
  assert.equal(r2.run.quality.byFamily.fingerprinting.outcome, "censored");
  r2.share = buildStaticReportShare(id);
  r2 = currentR2FixedPoint(r2);
  await writeRawManagedReport(id, r2);

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.coverageSiteCount, 1, "the loaded site remains covered");
  const cohort = stats.cohorts?.find((candidate) => candidate.schemaVersion === 2);
  assert.equal(cohort?.sampleSize, 1, "the site remains in its compatible cohort");
  assert.equal(cohort?.metrics.fingerprintEvents, undefined, "the unmeasured zero cannot enter a percentile");
  assert.equal(cohort?.metrics.thirdPartyRequests?.count, 1, "unrelated request metrics remain measured");
  assert.equal(cohort?.metrics.thirdPartyCookies?.count, 1, "unrelated cookie metrics remain measured");
});

test("a GPC-requesting run never shares a distribution with a plain visit", async () => {
  // The GPC lane and the plain lane did not observe the same population: while
  // every scan sent the signal, the injector blocked blob: workers and censored
  // the request family on the heaviest sites, so pooling the two eras pools two
  // inclusion criteria. Comparison eligibility already refuses to compare arms
  // that differ here; the corpus must refuse to rank them together.
  await writeReport(
    "20260701-1111111111111111111111111111aaaa",
    makeResult({ firstPartyDomain: "gpc-on-fixture.dev", thirdPartyRequests: 12, gpcEnabled: true })
  );
  await writeReport(
    "20260701-2222222222222222222222222222bbbb",
    makeResult({ firstPartyDomain: "gpc-off-fixture.dev", thirdPartyRequests: 40, gpcEnabled: false })
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  const cohorts = stats.cohorts ?? [];
  assert.equal(cohorts.length, 2);
  const on = cohorts.find((cohort) => cohort.gpc);
  const off = cohorts.find((cohort) => !cohort.gpc);
  assert.ok(on && off, "the two eras must be separate cohorts");
  // The ids differ only by the condition that separates them.
  assert.equal(on.id.replace(":gpc-on", ""), off.id.replace(":gpc-off", ""));
  assert.equal(on.sampleSize, 1);
  assert.equal(off.sampleSize, 1);
  // Neither distribution may carry the other era's value.
  assert.equal(on.metrics.thirdPartyRequests?.max, 12);
  assert.equal(off.metrics.thirdPartyRequests?.max, 40);
});

test("different legacy methodology tokens produce separate distributions", async () => {
  const oldMethod = makeResult({ firstPartyDomain: "old-method.dev", thirdPartyRequests: 10 });
  const newMethod = makeResult({ firstPartyDomain: "new-method.dev", thirdPartyRequests: 90 });
  newMethod.conditions.scannerDisclosure = scannerDisclosure("node-playwright", {
    chromiumVersion: newMethod.conditions.chromiumVersion,
    locale: newMethod.conditions.locale,
    scannerEgress: newMethod.conditions.scannerEgress,
    shieldsMode: newMethod.conditions.shieldsMode,
    timezone: newMethod.conditions.timezone
  });
  await writeReport("20260701-10101010101010101010101010101010", oldMethod);
  await writeReport("20260701-20202020202020202020202020202020", newMethod);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.cohorts?.length, 2);
  assert.deepEqual(
    stats.cohorts?.map((cohort) => ({ method: cohort.methodologyVersion, count: cohort.sampleSize, min: cohort.metrics.thirdPartyRequests?.min })),
    [
      { method: LEGACY_V1_METHODOLOGY_UNSPECIFIED, count: 1, min: 10 },
      { method: NODE_SCANNER_METHODOLOGY_VERSION, count: 1, min: 90 }
    ]
  );
  assert.equal(stats.sampleSize, 1, "the compatibility view selects one cohort instead of pooling both sites");
});

test("malformed reports fail the managed corpus build, never zero-coerce into the distribution", async () => {
  await writeReport(
    "20260701-dddddddddddddddddddddddddddddddd",
    makeResult({ firstPartyDomain: "real-fixture.dev", thirdPartyRequests: 50 })
  );
  const malformed = makeResult({ firstPartyDomain: "broken-fixture.dev" }) as unknown as {
    summary: Record<string, unknown>;
  };
  malformed.summary.thirdPartyRequests = "many";
  await writeRawManagedReport("20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", malformed);

  await assert.rejects(() => buildCorpusStats(reportsDir), /invalid-report/);
});

test("error/block-page loads and reserved domains stay out of the distribution", async () => {
  await writeReport(
    "20260701-ffffffffffffffffffffffffffffffff",
    makeResult({ firstPartyDomain: "walled-fixture.dev", status: 403 })
  );
  await writeReport("20260701-abababababababababababababababab", makeResult({ firstPartyDomain: "example.com" }));

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  assert.equal(stats.sampleSize, 0);
});

test("request-capped runs stay out of the distribution: their counts are floors, not behavior", async () => {
  const capped = makeResult({ firstPartyDomain: "heavy-fixture.dev", thirdPartyRequests: 900 });
  capped.summary.totalRequests = 1200;
  capped.warnings = ["The scan stopped recording or loading additional requests after 1000 requests."];
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", capped);
  await writeReport(
    "20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    makeResult({ firstPartyDomain: "light-fixture.dev", thirdPartyRequests: 20 })
  );

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  assert.deepEqual(warnings, []);
  // Only the uncapped site contributes: a capped run's counts were cut off
  // mid-collection and would clamp the distribution's tail to the cap.
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.metrics.thirdPartyRequests?.max, 20);
  assert.equal(stats.cappedSiteCount, 1);
});

test("comparison coverage and cap totals consider a successful variant when the lead arm failed", async () => {
  const baseline = makeResult({ firstPartyDomain: "paired-fixture.dev", status: 403 });
  const variant = makeResult({ firstPartyDomain: "paired-fixture.dev", thirdPartyRequests: 900 });
  variant.summary.totalRequests = 1200;
  variant.warnings = ["The scan stopped recording or loading additional requests after 1000 requests."];
  const comparison = createComparisonReport({
    comparisonType: "custom",
    title: "Two-arm coverage fixture",
    runLabels: { baseline: "Failed lead", variant: "Loaded capped variant" },
    baseline,
    variant,
    warningPrefix: "Sequential fixture."
  });
  await writeReport("20260701-cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", comparison);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 0, "the failed lead still cannot enter the percentile cohort");
  assert.equal(stats.coverageSiteCount, 1, "the successful variant covers the site");
  assert.equal(stats.cappedSiteCount, 1, "the successful capped variant contributes to the cap total");
});

test("cohort recency reads the report-level scan time the directory aggregate also ranks by", async () => {
  // selectPrimaryCorpusCohort ranks on recency first, and lib/corpus-overview
  // feeds it view.scannedAt. The lead run's own start is a DIFFERENT clock on
  // every v1 comparison, where the wire's report-level time is the variant
  // arm's start, so these two cohorts invert depending on which clock the
  // builder reads: on the lead run's start the GPC cohort is newest, on the
  // report-level time the plain cohort is. Two surfaces ranking the same
  // cohorts on two clocks can name two different primary cohorts.
  const plain = createComparisonReport({
    comparisonType: "custom",
    title: "Two-clock fixture",
    runLabels: { baseline: "Baseline", variant: "Variant" },
    baseline: makeResult({ firstPartyDomain: "plain-clock-fixture.dev", scannedAt: "2026-07-01T10:00:00.000Z" }),
    variant: makeResult({ firstPartyDomain: "plain-clock-fixture.dev", scannedAt: "2026-07-01T10:00:40.000Z" }),
    warningPrefix: "Sequential fixture."
  });
  const gpc = createComparisonReport({
    comparisonType: "custom",
    title: "Two-clock GPC fixture",
    runLabels: { baseline: "Baseline", variant: "Variant" },
    baseline: makeResult({
      firstPartyDomain: "gpc-clock-fixture.dev",
      scannedAt: "2026-07-01T10:00:20.000Z",
      gpcEnabled: true
    }),
    variant: makeResult({
      firstPartyDomain: "gpc-clock-fixture.dev",
      scannedAt: "2026-07-01T10:00:30.000Z",
      gpcEnabled: true
    }),
    warningPrefix: "Sequential fixture."
  });
  await writeReport("20260701-1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a", plain);
  await writeReport("20260701-2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b", gpc);

  const { stats } = await buildCorpusStats(reportsDir);
  const cohorts = stats.cohorts ?? [];
  assert.equal(cohorts.length, 2, "the requested-GPC split must hold these two apart");
  const plainCohort = cohorts.find((cohort) => cohort.gpc === false);
  const gpcCohort = cohorts.find((cohort) => cohort.gpc === true);
  assert.ok(plainCohort && gpcCohort, "both requested-GPC lanes must be published");

  assert.equal(plainCohort.latestRunAt, "2026-07-01T10:00:40.000Z", "cohort recency is the report-level scan time");
  assert.equal(gpcCohort.latestRunAt, "2026-07-01T10:00:30.000Z", "cohort recency is the report-level scan time");
  assert.equal(stats.primaryCohortId, plainCohort.id, "the newest report-level scan time takes the aggregate");
});

test("a missing reports directory yields an empty distribution", async () => {
  const { stats } = await buildCorpusStats(path.join(reportsDir, "missing"));
  assert.equal(stats.sampleSize, 0);
  assert.deepEqual(stats.metrics, {});
});

test("null-status runs stay out of coverage and measurement: the main document never answered", async () => {
  const nullStatus = makeResult({ firstPartyDomain: "silent-fixture.dev" });
  nullStatus.summary = { ...nullStatus.summary, status: null };
  await writeReport("20260701-dddddddddddddddddddddddddddddddd", makeResult({ firstPartyDomain: "ok-fixture.dev" }));
  await writeReport("20260701-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", nullStatus);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  assert.equal(stats.coverageSiteCount, 1);
});

test("a consent-interaction arm is covered but never measured: accept-all is not a default visit", async () => {
  const acceptArm = makeResult({ firstPartyDomain: "consent-fixture.dev" });
  acceptArm.conditions = { ...acceptArm.conditions, consentMode: "accept-all" };
  await writeReport("20260701-ffffffffffffffffffffffffffffffff", makeResult({ firstPartyDomain: "ok-fixture.dev" }));
  await writeReport("20260701-abababababababababababababababab", acceptArm);

  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.sampleSize, 1);
  // The site still counts as covered: it loaded, it is in the corpus.
  assert.equal(stats.coverageSiteCount, 2);
});

test("missing or mismatched sidecars fail the corpus build", async () => {
  const missingId = "20260701-11111111111111111111111111111111";
  const report = redactScanReportV1(makeResult()).report;
  await writeFile(path.join(reportsDir, `${missingId}.json`), `${JSON.stringify(report)}\n`);
  await assert.rejects(() => buildCorpusStats(reportsDir), /no-sidecar/);

  await rm(path.join(reportsDir, `${missingId}.json`));
  const mismatchId = "20260701-22222222222222222222222222222222";
  await writeReport(mismatchId, makeResult());
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(mismatchId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, redactionVersion: 999 })}\n`);
  await assert.rejects(() => buildCorpusStats(reportsDir), /redaction-version-mismatch/);
});

test("the published artifact and the rendered aggregate name the same cohort", async () => {
  // The selection rule used to be restated in two files: this builder chose
  // primaryCohortId while lib/corpus-overview chose the leaderboard's cohort.
  // Both now call selectPrimaryCorpusCohort, and this proves it over the real
  // committed corpus rather than a fixture, so a re-added local sort in either
  // file fails here. It asserts agreement only, never a count, so an ordinary
  // corpus refresh cannot redden it.
  const committedReportsDir = path.join(process.cwd(), "public", "reports");
  const { stats } = await buildCorpusStats(committedReportsDir);
  const overview = await loadCorpusOverview();

  assert.equal(
    overview.aggregateCohort?.id ?? null,
    stats.primaryCohortId ?? null,
    "the corpus artifact and the directory aggregate must describe one cohort"
  );

  // The cohort the aggregates speak for must also be one a reader can date;
  // the status page derives its freshness badge from exactly this cohort.
  const primary = (stats.cohorts ?? []).find((cohort) => cohort.id === stats.primaryCohortId);
  assert.ok(primary, "the named primary cohort must be present among the published cohorts");
  assert.ok(
    primary.latestRunAt !== null && Number.isFinite(Date.parse(primary.latestRunAt)),
    "the primary cohort must carry a parseable newest measurement"
  );
});

test("the renderer and the builder share one corpus-population rule", () => {
  // The builder drops a run from the distribution when its request family was
  // censored or it hit the recording cap; the findings board used to check only
  // completion and consent mode. A v2 run that exhausted its request budget
  // stays quality.outcome === "complete" (budget-exhausted lands in reasons,
  // never failureReasons) with only the requests family censored, so the board
  // rendered a percentile badge ranking it against a population the builder had
  // excluded it from. Both now read runInCorpusDistributionPopulation.
  const capped = makeRunView({ requestsCensored: true });
  assert.equal(
    capped.quality.outcome,
    "complete",
    "the case only bites because an exhausted request budget still completes"
  );
  assert.equal(runInCorpusDistributionPopulation(capped), false);

  for (const consentMode of ["accept-all", "reject-all"] as const) {
    assert.equal(runInCorpusDistributionPopulation(makeRunView({ consentMode })), false);
  }
  assert.equal(runInCorpusDistributionPopulation(makeRunView({ failed: true })), false);

  // Inverse, so a predicate that always returned false could not pass.
  assert.equal(runInCorpusDistributionPopulation(makeRunView({})), true);
});

function makeRunView(options: {
  requestsCensored?: boolean;
  consentMode?: "observe" | "accept-all" | "reject-all";
  failed?: boolean;
}): RunView {
  const view = {
    quality: {
      outcome: options.failed ? "failed" : "complete",
      reasons: options.requestsCensored ? ["budget-exhausted:request-capture"] : [],
      byFamily: {
        requests: {
          outcome: options.requestsCensored ? "censored" : "complete",
          reasons: options.requestsCensored ? ["budget-exhausted:request-capture"] : []
        }
      }
    },
    conditions: { consentMode: options.consentMode ?? "observe" },
    warnings: []
  } as unknown as RunView;
  return view;
}

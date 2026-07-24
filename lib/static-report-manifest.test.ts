import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildStaticReportShare } from "./report-locator";
import { buildStaticReportManifest } from "./static-report-manifest";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { currentR2NormalizationForObserver } from "./scan-report-v2-normalization";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { r2ReportRuns, redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";
import { aggregateByteBudgetWarning } from "./scan-runtime";
import type { ScanReport, ScanResult } from "./types";

let reportsDir = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-manifest-"));
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
});

function makeResult(overrides: { firstPartyDomain?: string; totalRequests?: number; status?: number | null } = {}): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType === "comparison") throw new Error("fixture must be a single report");
  const totalRequests = overrides.totalRequests ?? base.summary.totalRequests;
  const firstPartyDomain = overrides.firstPartyDomain ?? "shop.example.org";
  const subjectUrl = `https://${firstPartyDomain}/`;
  return {
    ...base,
    requests:
      overrides.totalRequests === undefined
        ? base.requests
        : Array.from({ length: totalRequests }, (_, index) => ({
            id: index + 1,
            url: `https://cdn.example.net/privacy?utm_source=${index}`,
            domain: "cdn.example.net",
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
      status: overrides.status ?? base.summary.status,
      totalRequests
    },
    conditions: {
      ...base.conditions,
      requestedUrl: subjectUrl,
      finalUrl: subjectUrl
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
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const createdAt = reportCreationTime(report);
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport: report,
    writtenAt: "2026-07-12T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
}

function reportCreationTime(report: unknown): string {
  const value = report as { scannedAt?: unknown; conditions?: { scannedAt?: unknown }; run?: { startedAt?: unknown } };
  const scannedAt = value.scannedAt ?? value.conditions?.scannedAt ?? value.run?.startedAt;
  if (typeof scannedAt !== "string") throw new Error("fixture needs a recorded scan time");
  return scannedAt;
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

test("builds entries for valid v1 reports and ignores non-report files", async () => {
  const report = makeResult();
  report.conditions.requestedUrl = "https://shop.example.org/";
  report.conditions.finalUrl = report.conditions.requestedUrl;
  report.conditions.shieldsMode = "classification";
  report.conditions.adblock = {
    active: true,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: "2026-07-01T00:00:00.000Z"
  };
  report.conditions.scannerDisclosure = `test scanner under methodology ${NODE_SCANNER_METHODOLOGY_VERSION}`;
  await writeReport("20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", report);
  await writeFile(path.join(reportsDir, "index.json"), "{}\n");
  await writeFile(path.join(reportsDir, "notes.txt"), "not a report\n");
  await mkdir(path.join(reportsDir, "subdir"));

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 1);
  assert.deepEqual(warnings, []);
  const entry = manifest.reports[0];
  assert.equal(entry.id, "20260618-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const reportWire = await readFile(path.join(reportsDir, `${entry.id}.json`), "utf8");
  assert.equal(entry.reportWireBytes, new TextEncoder().encode(reportWire).byteLength);
  assert.equal(entry.reportWireSha256, createHash("sha256").update(reportWire, "utf8").digest("hex"));
  assert.equal(entry.domain, "shop.example.org");
  assert.equal(entry.reportType, "single");
  assert.equal(typeof entry.headline, "string");
  assert.ok(["alarm", "warn", "info", "calm"].includes(entry.tone));
  assert.equal(typeof entry.historyKey, "string");
  assert.equal(typeof entry.comparisonHistoryKey, "string");
  assert.equal(typeof entry.metrics.totalRequests, "number");
});

test("comparison history permits only snapshot-date drift in successful passive visits", async () => {
  const before = makeResult();
  before.conditions.requestedUrl = "https://shop.example.org/news";
  before.conditions.finalUrl = before.conditions.requestedUrl;
  before.conditions.scannedAt = "2026-07-01T00:00:00.000Z";
  before.conditions.shieldsMode = "classification";
  before.conditions.scannerDisclosure = `test scanner under methodology ${NODE_SCANNER_METHODOLOGY_VERSION}`;
  before.conditions.adblock = {
    active: true,
    source: "Brave default ad-block lists",
    lists: 31,
    fetchedAt: "2026-07-01T00:00:00.000Z"
  };
  const after = structuredClone(before);
  after.conditions.scannedAt = "2026-07-02T00:00:00.000Z";
  after.conditions.adblock!.fetchedAt = "2026-07-02T00:00:00.000Z";

  await writeReport("20260701-11111111111111111111111111111111", before);
  await writeReport("20260702-22222222222222222222222222222222", after);
  const { manifest } = await buildStaticReportManifest(reportsDir);
  const [latest, earlier] = manifest.reports;
  assert.notEqual(latest.historyKey, earlier.historyKey);
  assert.equal(latest.comparisonHistoryKey, earlier.comparisonHistoryKey);

  const listMismatch = structuredClone(after);
  listMismatch.conditions.scannedAt = "2026-07-03T00:00:00.000Z";
  listMismatch.conditions.adblock!.lists = 30;
  await writeReport("20260703-33333333333333333333333333333333", listMismatch);
  const rebuilt = await buildStaticReportManifest(reportsDir);
  assert.notEqual(rebuilt.manifest.reports[0].comparisonHistoryKey, latest.comparisonHistoryKey);
});

test("r2 archive entries expose one methodology-aware history group", async () => {
  const before = makePublicSingleReportV2R2();
  before.run.runId = "r2-history-before";
  before.run.startedAt = "2026-07-01T00:00:00.000Z";
  before.run.privacy.redactionVersion = REDACTION_VERSION;
  before.run.subject.requested = {
    origin: "https://shop.nike.com",
    registrableDomain: "nike.com",
    routeShape: "/products/{seg}"
  };
  before.run.subject.observed = { ...before.run.subject.requested };
  before.run.evidence.requests[0].url = "https://shop.nike.com/products/{seg}";
  before.run.evidence.requests[0].domain = "shop.nike.com";
  const beforeId = "20260701-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  before.share = buildStaticReportShare(beforeId);
  const currentBefore = currentR2FixedPoint(before);

  const after = structuredClone(currentBefore);
  after.run.runId = "r2-history-after";
  after.run.startedAt = "2026-07-02T00:00:00.000Z";
  const afterId = "20260702-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  after.share = buildStaticReportShare(afterId);
  const currentAfter = currentR2FixedPoint(after);

  await writeRawManagedReport(beforeId, currentBefore);
  await writeRawManagedReport(afterId, currentAfter);

  const { manifest } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 2);
  assert.match(manifest.reports[0].comparisonHistoryKey ?? "", /^comparison-history-key-v2\|/);
  assert.equal(manifest.reports[0].comparisonHistoryKey, manifest.reports[1].comparisonHistoryKey);
});

test("comparison history excludes failed, capped, and block-simulation visits", async () => {
  const failed = makeResult({ status: 403 });
  failed.conditions.shieldsMode = "classification";
  const capped = makeResult({ totalRequests: 1_000 });
  capped.conditions.shieldsMode = "classification";
  const simulated = makeResult();
  simulated.conditions.shieldsMode = "block-simulation";
  await writeReport("20260701-44444444444444444444444444444444", failed);
  await writeReport("20260702-55555555555555555555555555555555", capped);
  await writeReport("20260703-66666666666666666666666666666666", simulated);

  const { manifest } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 3);
  assert.equal(manifest.reports.every((entry) => entry.comparisonHistoryKey === undefined), true);
});

test("manifest requestCapped marks the request-count cap, not generic request-family truncation", async () => {
  const requestCapped = makeResult({ totalRequests: 1_000 });
  const responseBytesCapped = makeResult();
  responseBytesCapped.warnings.push(aggregateByteBudgetWarning("response", 64 * 1024 * 1024));
  const v2Incomplete = makePublicSingleReportV2R2();
  const v2Id = "20260703-99999999999999999999999999999999";
  v2Incomplete.share = buildStaticReportShare(v2Id);
  v2Incomplete.run.privacy.redactionVersion = REDACTION_VERSION;
  v2Incomplete.run.qualityFacts.captureLoss.push({
    family: "requests",
    phaseId: 0,
    kind: "timeout",
    count: 1,
    detail: "network-observer"
  });
  v2Incomplete.run.quality = evaluateQuality(v2Incomplete.run.qualityFacts, {
    observedRequests: v2Incomplete.run.evidence.requests.length
  });
  const currentV2Incomplete = currentR2FixedPoint(v2Incomplete);
  await writeReport("20260701-77777777777777777777777777777777", requestCapped);
  await writeReport("20260702-88888888888888888888888888888888", responseBytesCapped);
  await writeRawManagedReport(v2Id, currentV2Incomplete);

  const { manifest } = await buildStaticReportManifest(reportsDir);
  const byId = new Map(manifest.reports.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("20260701-77777777777777777777777777777777")?.requestCapped, true);
  assert.equal(byId.get("20260702-88888888888888888888888888888888")?.requestCapped, undefined);
  assert.equal(byId.get(v2Id)?.requestCapped, undefined);
});

test("manifest headlines preserve failed-load evidence instead of inferring calm from counts", async () => {
  await writeReport(
    "20260618-99999999999999999999999999999999",
    makeResult({ firstPartyDomain: "blocked.example.org", totalRequests: 1, status: 403 })
  );

  const { manifest } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 1);
  assert.match(manifest.reports[0].headline, /error|block|HTTP 403/i);
  assert.notEqual(manifest.reports[0].tone, "calm");
});

test("history identity is omitted when redaction generalized the measured route", async () => {
  const report = makeResult();
  report.conditions.requestedUrl = "https://shop.example.org/alice-private-route";
  report.conditions.finalUrl = report.conditions.requestedUrl;
  await writeReport("20260618-88888888888888888888888888888888", report);

  const { manifest } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports[0].historyKey, undefined);
});

test("comparison reports lead with the baseline and carry the comparison type", async () => {
  const comparison = createGpcComparisonReport(makeResult({ totalRequests: 80 }), makeResult({ totalRequests: 30 }));
  await writeReport("20260618-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", comparison);

  const { manifest } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 1);
  const entry = manifest.reports[0];
  assert.equal(entry.reportType, "comparison");
  assert.equal(entry.comparisonType, "gpc");
  assert.equal(entry.gpcEnabled, "comparison");
  assert.equal(entry.metrics.totalRequests, 80);
});

test("a malformed metric fails the managed manifest build instead of zero-coercing", async () => {
  // The former MJS builder turned a malformed count into a silent 0 and
  // published the entry anyway; the deep reader refuses the whole report.
  const report = makeResult() as unknown as { summary: Record<string, unknown> };
  report.summary.totalRequests = "twelve";
  await writeRawManagedReport("20260618-cccccccccccccccccccccccccccccccc", report);

  await assert.rejects(() => buildStaticReportManifest(reportsDir), /invalid-report/);
});

test("a deep-shape violation fails the managed manifest build", async () => {
  await writeRawManagedReport("20260618-dddddddddddddddddddddddddddddddd", { ...makeResult(), requests: [null] });

  await assert.rejects(() => buildStaticReportManifest(reportsDir), /invalid-report/);
});

test("reserved/test domains stay out of the public gallery", async () => {
  await writeReport("20260618-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", makeResult({ firstPartyDomain: "example.com" }));

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  assert.equal(manifest.reports.length, 0);
  assert.deepEqual(warnings, []);
});

test("a missing reports directory yields an empty manifest", async () => {
  const { manifest, warnings } = await buildStaticReportManifest(path.join(reportsDir, "does-not-exist"));
  assert.deepEqual(manifest.reports, []);
  assert.deepEqual(warnings, []);
});

test("a missing or mismatched sidecar fails the manifest build", async () => {
  const missingId = "20260618-11111111111111111111111111111111";
  const report = redactScanReportV1(makeResult()).report;
  await writeFile(path.join(reportsDir, `${missingId}.json`), `${JSON.stringify(report)}\n`);
  await assert.rejects(() => buildStaticReportManifest(reportsDir), /no-sidecar/);

  await rm(path.join(reportsDir, `${missingId}.json`));
  const mismatchId = "20260618-22222222222222222222222222222222";
  await writeReport(mismatchId, makeResult());
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(mismatchId));
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  await writeFile(sidecarPath, `${JSON.stringify({ ...sidecar, publicDigest: "0".repeat(64) })}\n`);
  await assert.rejects(() => buildStaticReportManifest(reportsDir), /digest-mismatch/);
});

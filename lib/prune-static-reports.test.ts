import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { spawnSyncBounded } from "./bounded-spawn";
import { CURRENT_MEASUREMENT_LINE_METHODOLOGY, REVIEWED_MEASUREMENT_LINES, corpusCohortIdentityForView } from "./corpus-cohort";
import { buildCorpusStats } from "./corpus-stats-builder";
import { createShieldsComparisonReport } from "./compare-reports";
import { frozenReportView, frozenReportWire } from "./pinned-reports";
import { DECIDED_PACKAGE_INPUT_FILES, pruneStaticReportsWithCorrections } from "./prune-static-reports";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { scannerDisclosure } from "./scan-condition-disclosure";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";
import { r2ReportRuns, redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";
import type { ScanReport, ScanResult } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

let reportsDir = "";
let ledgerDir = "";
/**
 * These tests drive the production entry point, so the corrections ledger is
 * real. It is written outside reportsDir because the report reader treats every
 * file in that directory as a static-report candidate.
 */
let emptyLedgerPath = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-prune-"));
  ledgerDir = await mkdtemp(path.join(tmpdir(), "sbl-prune-ledger-"));
  emptyLedgerPath = path.join(ledgerDir, "corrections.json");
  await writeFile(
    emptyLedgerPath,
    `${JSON.stringify({
      $schema: "https://sitebehavior.org/corrections.schema.json",
      schemaVersion: 1,
      policy: "https://sitebehavior.org/corrections/",
      entries: []
    })}\n`
  );
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
  await rm(ledgerDir, { recursive: true, force: true });
});

function makeResult(domain: string, scannedAt: string): ScanResult {
  const base = makeScanReportV1();
  if (base.reportType === "comparison") throw new Error("fixture must be a single report");
  const shieldsMode = "classification" as const;
  return {
    ...base,
    summary: { ...base.summary, firstPartyDomain: domain },
    conditions: {
      ...base.conditions,
      requestedUrl: `https://${domain}/`,
      finalUrl: `https://${domain}/`,
      scannedAt,
      shieldsMode,
      adblock: {
        active: true,
        source: "Brave default ad-block lists",
        lists: 31,
        fetchedAt: "2026-06-01T00:00:00.000Z"
      },
      scannerDisclosure: scannerDisclosure("node-playwright", {
        chromiumVersion: base.conditions.chromiumVersion,
        locale: base.conditions.locale,
        scannerEgress: base.conditions.scannerEgress,
        shieldsMode,
        timezone: base.conditions.timezone
      })
    }
  };
}

type TestReport = ScanReport | PublicScanReportV2R2;

async function writeReport(id: string, report: TestReport): Promise<void> {
  if (report.schemaVersion === 1) {
    await writeManagedPublicReport(id, redactScanReportV1(report).report);
    return;
  }
  // A schema-r2 fixture declares its producer's redaction version and still
  // carries a page title. The managed reader serves it only as a fixed point
  // of the current sanitizer, so it is relabelled and redacted once.
  const current = structuredClone(report);
  for (const run of r2ReportRuns(current)) run.privacy.redactionVersion = REDACTION_VERSION;
  await writeManagedPublicReport(id, redactPublicScanReportV2R2(current));
}

async function writeManagedPublicReport(
  id: string,
  publicReport: TestReport,
  writtenAt = "2026-07-12T00:00:00.000Z"
): Promise<void> {
  await writeFile(path.join(reportsDir, `${id}.json`), `${JSON.stringify(publicReport)}\n`);
  const createdAt =
    publicReport.schemaVersion === 1
      ? publicReport.reportType === "comparison"
        ? publicReport.scannedAt
        : publicReport.conditions.scannedAt
      : publicReport.reportType === "comparison"
        ? publicReport.variant.startedAt
        : publicReport.run.startedAt;
  const sidecar = buildProvenanceEntry({
    reportId: id,
    publicReport,
    writtenAt,
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, committedSidecarFilename(id)), `${JSON.stringify(sidecar)}\n`);
}

test("age pruning removes stale reports but keeps each exact cohort's newest generations", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  // Three generations for one site: the newest two are protected, the third
  // is stale and prunable.
  await writeReport("20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeResult("one-fixture.dev", "2026-01-01T00:00:00.000Z"));
  await writeReport("20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeResult("one-fixture.dev", "2026-03-01T00:00:00.000Z"));
  await writeReport("20260501-cccccccccccccccccccccccccccccccc", makeResult("one-fixture.dev", "2026-05-01T00:00:00.000Z"));

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now
  });

  assert.deepEqual(warnings, []);
  assert.equal(removed.length, 1);
  assert.match(removed[0], /20260101-a+\.json$/);
  const remaining = await readdir(reportsDir);
  assert.equal(remaining.filter((file) => /^\d{8}-[a-f0-9]{32}\.json$/.test(file)).length, 2);
  assert.equal(remaining.filter((file) => file.endsWith(".provenance.json")).length, 2);
  await assert.rejects(
    () => access(path.join(reportsDir, "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.provenance.json")),
    /ENOENT/
  );
});

const COHORT_MISMATCHES: { name: string; mutate: (report: ScanResult) => void }[] = [
  {
    name: "methodology",
    mutate: (report) => {
      report.conditions.scannerDisclosure =
        "Automated Chromium scan from test with browser test, timezone UTC, locale en-US, the listed viewport, and Brave Shields classification only. Treat results as reproducible evidence for this scan configuration, not a universal claim about all visitors.";
    }
  },
  {
    name: "filter-list snapshot",
    mutate: (report) => {
      if (!report.conditions.adblock) throw new Error("fixture must carry adblock provenance");
      report.conditions.adblock.fetchedAt = "2026-06-02T00:00:00.000Z";
    }
  },
  {
    name: "device",
    mutate: (report) => {
      report.conditions.viewport = { width: 390, height: 844, isMobile: true };
    }
  },
  {
    name: "recorded condition",
    mutate: (report) => {
      report.conditions.gpcEnabled = true;
    }
  },
  {
    name: "subject",
    mutate: (report) => {
      report.conditions.requestedUrl = "https://one-fixture.dev/privacy";
      report.conditions.finalUrl = "https://one-fixture.dev/privacy";
    }
  }
];

for (const mismatch of COHORT_MISMATCHES) {
  test(`${mismatch.name} mismatch cannot evict the only compatible predecessor`, async () => {
    const now = Date.parse("2026-07-10T00:00:00.000Z");
    const oldestId = "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await writeReport(oldestId, makeResult("one-fixture.dev", "2026-01-01T00:00:00.000Z"));

    const incompatible = makeResult("one-fixture.dev", "2026-03-01T00:00:00.000Z");
    mismatch.mutate(incompatible);
    await writeReport("20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", incompatible);
    await writeReport(
      "20260501-cccccccccccccccccccccccccccccccc",
      makeResult("one-fixture.dev", "2026-05-01T00:00:00.000Z")
    );

    const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
      maxAgeMs: 7 * DAY_MS,
      maxCount: 1_000,
      keepPerSite: 2,
      now
    });

    assert.deepEqual(warnings, []);
    assert.deepEqual(removed, []);
    await access(path.join(reportsDir, `${oldestId}.json`));
    await access(path.join(reportsDir, committedSidecarFilename(oldestId)));
  });
}

test("a forged tracker catalog cannot evict the only compatible predecessor", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const oldestId = "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const forgedId = "20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await writeReport(oldestId, makeResult("one-fixture.dev", "2026-01-01T00:00:00.000Z"));

  // v3 canonicalizes every Node v1 tracker catalog at the public boundary, so
  // two differently versioned *managed* v1 catalogs cannot legitimately
  // coexist. Model the only possible mismatch: bytes changed after redaction,
  // with a freshly forged current sidecar. The fixed-point gate must still
  // reject the report, and retention must never delete evidence it cannot trust.
  const forged = redactScanReportV1(makeResult("one-fixture.dev", "2026-03-01T00:00:00.000Z")).report;
  forged.conditions.trackerCatalog = { ...forged.conditions.trackerCatalog, version: "forged-catalog-v2" };
  await writeManagedPublicReport(forgedId, forged);

  await writeReport(
    "20260501-cccccccccccccccccccccccccccccccc",
    makeResult("one-fixture.dev", "2026-05-01T00:00:00.000Z")
  );

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now
  });

  assert.deepEqual(removed, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`${forgedId}\\.json.*redaction-not-idempotent`));
  await access(path.join(reportsDir, `${oldestId}.json`));
  await access(path.join(reportsDir, `${forgedId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(forgedId)));
});

test("schema mismatch cannot evict the only compatible predecessor", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const oldestId = "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeReport(oldestId, makeResult("example.com", "2026-01-01T00:00:00.000Z"));

  const v2 = makePublicSingleReportV2R2();
  v2.run.startedAt = "2026-03-01T00:00:00.000Z";
  v2.run.subject = {
    requested: { origin: "https://example.com", registrableDomain: "example.com", routeShape: "/" },
    observed: { origin: "https://example.com", registrableDomain: "example.com", routeShape: "/" }
  };
  v2.run.evidence.requests[0].url = "https://example.com/";
  await writeReport("20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", v2);
  await writeReport(
    "20260501-cccccccccccccccccccccccccccccccc",
    makeResult("example.com", "2026-05-01T00:00:00.000Z")
  );

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now
  });

  assert.deepEqual(warnings, []);
  assert.deepEqual(removed, []);
  await access(path.join(reportsDir, `${oldestId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(oldestId)));
});

test("null cohorts never compare, while the newest broad report keeps the site present", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const ids = [
    "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "20260501-cccccccccccccccccccccccccccccccc"
  ];
  const dates = ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"];
  for (const [index, id] of ids.entries()) {
    const report = makeResult("unknown.example.dev", dates[index]);
    report.conditions.scannerEgress = "unknown";
    await writeReport(id, report);
  }

  const { removed } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now
  });

  assert.deepEqual(
    removed.map((file) => path.basename(file)),
    [`${ids[0]}.json`, `${ids[1]}.json`]
  );
  await access(path.join(reportsDir, `${ids[2]}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(ids[2])));
});

test("generalized v1 subjects never compare, while the newest broad report keeps the site present", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const ids = [
    "20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "20260301-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "20260501-cccccccccccccccccccccccccccccccc"
  ];
  const dates = ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"];
  for (const [index, id] of ids.entries()) {
    const report = makeResult("generalized.example.dev", dates[index]);
    report.conditions.requestedUrl = "https://generalized.example.dev/patient/alice";
    report.conditions.finalUrl = "https://generalized.example.dev/patient/alice";
    await writeReport(id, report);
  }

  const { removed } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now
  });

  assert.deepEqual(
    removed.map((file) => path.basename(file)),
    [`${ids[0]}.json`, `${ids[1]}.json`]
  );
  await access(path.join(reportsDir, `${ids[2]}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(ids[2])));
});

test("a file the reader cannot read is never deleted", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  await writeFile(path.join(reportsDir, "20250101-dddddddddddddddddddddddddddddddd.json"), "{\n");
  await writeFile(
    path.join(reportsDir, "20250101-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json"),
    `${JSON.stringify({ ...makeResult("two.example.dev", "2025-01-01T00:00:00.000Z"), requests: [null] })}\n`
  );

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1,
    keepPerSite: 0,
    now
  });

  // Both files are ancient and over the count cap, but retention must not
  // destroy evidence it cannot understand.
  assert.deepEqual(removed, []);
  assert.equal(warnings.length, 2);
  assert.equal((await readdir(reportsDir)).length, 2);
});

test("the count cap trims oldest unprotected reports first", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  await writeReport("20260708-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeResult("a.example.dev", "2026-07-08T00:00:00.000Z"));
  await writeReport("20260709-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeResult("b.example.dev", "2026-07-09T00:00:00.000Z"));
  await writeReport("20260710-cccccccccccccccccccccccccccccccc", makeResult("c.example.dev", "2026-07-10T00:00:00.000Z"));

  const { removed } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 365 * DAY_MS,
    maxCount: 2,
    keepPerSite: 0,
    now
  });

  assert.equal(removed.length, 1);
  assert.match(removed[0], /20260708-a+\.json$/);
});

test("correction-linked evidence and replacement reports survive age and count pruning", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const evidenceId = "20250101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const replacementId = "20250102-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const unpinnedId = "20260710-cccccccccccccccccccccccccccccccc";
  await writeReport(evidenceId, makeResult("evidence.example.dev", "2025-01-01T00:00:00.000Z"));
  await writeReport(replacementId, makeResult("replacement.example.dev", "2025-01-02T00:00:00.000Z"));
  await writeReport(unpinnedId, makeResult("unpinned.example.dev", "2026-07-10T00:00:00.000Z"));
  const ledgerPath = path.join(reportsDir, "corrections.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries: [{
      eventId: "SBL-CORR-2026-001",
      publishedAt: "2026-07-09T00:00:00.000Z",
      state: "corrected",
      reportIds: [evidenceId],
      replacementReportIds: [replacementId],
      summary: "A corrected test fixture keeps both immutable evidence bundles.",
      detailsUrl: "https://example.test/corrections/1"
    }]
  })}\n`);

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, ledgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1,
    keepPerSite: 0,
    now
  });

  assert.deepEqual(removed, [path.join(reportsDir, `${unpinnedId}.json`)]);
  assert.match(warnings.at(-1) ?? "", /Keeping 2 correction-linked static reports.*count cap is 1/);
  for (const id of [evidenceId, replacementId]) {
    await access(path.join(reportsDir, `${id}.json`));
    await access(path.join(reportsDir, committedSidecarFilename(id)));
  }
});

test("a corrections ledger cannot reference an absent static evidence bundle", async () => {
  const existingId = "20250101-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const missingId = "20250102-ffffffffffffffffffffffffffffffff";
  await writeReport(existingId, makeResult("preserved.example.dev", "2025-01-01T00:00:00.000Z"));
  const ledgerPath = path.join(reportsDir, "corrections.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries: [{
      eventId: "SBL-CORR-2026-001",
      publishedAt: "2026-07-09T00:00:00.000Z",
      state: "active",
      reportIds: [missingId],
      summary: "This deliberately broken fixture references absent evidence.",
      detailsUrl: "https://example.test/corrections/1"
    }]
  })}\n`);

  await assert.rejects(
    () => pruneStaticReportsWithCorrections(reportsDir, ledgerPath, {
      maxAgeMs: 1,
      maxCount: 1,
      keepPerSite: 0,
      now: Date.parse("2026-07-10T00:00:00.000Z")
    }),
    new RegExp(`Correction-linked report ${missingId}.*pruning aborted`)
  );
  await access(path.join(reportsDir, `${existingId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(existingId)));
});

test("an original removed for privacy does not abort pruning, and its replacement stays pinned", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const removedId = "20250101-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const replacementId = "20250101-ffffffffffffffffffffffffffffffff";
  const unpinnedId = "20260710-cccccccccccccccccccccccccccccccc";
  await writeReport(replacementId, makeResult("replacement.example.dev", "2025-01-01T00:00:00.000Z"));
  await writeReport(unpinnedId, makeResult("unpinned.example.dev", "2026-07-10T00:00:00.000Z"));
  const ledgerPath = path.join(ledgerDir, "privacy-corrections.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries: [{
      eventId: "SBL-CORR-2026-001",
      publishedAt: "2026-07-08T00:00:00.000Z",
      state: "active",
      reportIds: [removedId],
      summary: "A clarification that the privacy replacement inherits.",
      detailsUrl: "https://example.test/corrections/1"
    }, {
      eventId: "SBL-CORR-2026-002",
      publishedAt: "2026-07-09T00:00:00.000Z",
      state: "privacy-superseded",
      reportIds: [removedId],
      replacementReportIds: [replacementId],
      summary: "A redacted copy replaced a report that exposed a scanner network address.",
      detailsUrl: "https://example.test/corrections/2"
    }]
  })}\n`);

  const { removed } = await pruneStaticReportsWithCorrections(reportsDir, ledgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1,
    keepPerSite: 0,
    now
  });

  assert.deepEqual(removed, [path.join(reportsDir, `${unpinnedId}.json`)]);
  await access(path.join(reportsDir, `${replacementId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(replacementId)));
});

test("a malformed corrections ledger aborts before any report is pruned", async () => {
  const reportId = "20250101-dddddddddddddddddddddddddddddddd";
  await writeReport(reportId, makeResult("preserved.example.dev", "2025-01-01T00:00:00.000Z"));
  const ledgerPath = path.join(reportsDir, "corrections.json");
  await writeFile(ledgerPath, '{"schemaVersion":1,"entries":"malformed"}\n');

  await assert.rejects(
    () => pruneStaticReportsWithCorrections(reportsDir, ledgerPath, {
      maxAgeMs: 1,
      maxCount: 1,
      keepPerSite: 0,
      now: Date.parse("2026-07-10T00:00:00.000Z")
    }),
    /Corrections ledger .* is invalid/
  );
  await access(path.join(reportsDir, `${reportId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(reportId)));
});

test("unknown provenance is retained while verified pruning removes the whole bundle", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const missingId = "20250101-11111111111111111111111111111111";
  const missing = redactScanReportV1(makeResult("unknown.example.dev", "2025-01-01T00:00:00.000Z")).report;
  await writeFile(path.join(reportsDir, `${missingId}.json`), `${JSON.stringify(missing)}\n`);

  const verifiedId = "20250101-22222222222222222222222222222222";
  await writeReport(verifiedId, makeResult("verified.example.dev", "2025-01-01T00:00:00.000Z"));
  const danglingId = "20250101-33333333333333333333333333333333";
  await writeFile(path.join(reportsDir, committedSidecarFilename(danglingId)), "{}\n");

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 100,
    keepPerSite: 0,
    now
  });

  assert.deepEqual(removed, [path.join(reportsDir, `${verifiedId}.json`)]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings.some((warning) => warning.includes("no-sidecar")), true);
  assert.equal(warnings.some((warning) => warning.includes("dangling")), true);
  await access(path.join(reportsDir, `${missingId}.json`));
  await access(path.join(reportsDir, committedSidecarFilename(danglingId)));
  await assert.rejects(() => access(path.join(reportsDir, `${verifiedId}.json`)), /ENOENT/);
  await assert.rejects(() => access(path.join(reportsDir, committedSidecarFilename(verifiedId))), /ENOENT/);
});

// A decided research package is built from committed reports, and its numbers
// are true only while every one of them is committed. The calibration-censoring
// package cites its inputs in a pin file the prune CLI reads, so retention can
// never take one away. These tests drive the compiled CLI itself, in a scratch
// repository root, so they cover the path the scan workflow runs.
const CENSUS_REPORT_ID = "20260714-be94cc2d911e26d027950a336147917e";
const CENSUS_PIN_FILE = path.join("research", "calibration-censoring", "corpus-censoring-inputs.json");

async function censusCliRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sbl-prune-cli-"));
  await mkdir(path.join(root, "public", "reports"), { recursive: true });
  await mkdir(path.join(root, "research", "calibration-censoring"), { recursive: true });
  await writeFile(path.join(root, "public", "corrections.json"), await readFile(emptyLedgerPath, "utf8"));
  // The frozen copy is the r2 report the package cites, byte for byte.
  for (const name of [`${CENSUS_REPORT_ID}.json`, `${CENSUS_REPORT_ID}.provenance.json`]) {
    await copyFile(path.join(process.cwd(), "test-fixtures", "reports", name), path.join(root, "public", "reports", name));
  }
  return root;
}

async function writeCensusPins(root: string, reportIds: readonly string[]): Promise<void> {
  await writeFile(
    path.join(root, CENSUS_PIN_FILE),
    `${JSON.stringify({ package: "corpus-censoring-findings.txt", runCount: reportIds.length * 2, reportIds }, null, 2)}\n`
  );
}

function runPruneCli(root: string) {
  // Pure age pruning: nothing protects the July report except its pin.
  return spawnSyncBounded(process.execPath, [path.join(__dirname, "prune-static-reports-cli.js")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SITE_BEHAVIOR_LAB_STATIC_REPORT_KEEP_PER_SITE: "0" }
  });
}

test("the prune CLI never removes a report the calibration-censoring package cites", async () => {
  const root = await censusCliRoot();
  try {
    const reportPath = path.join(root, "public", "reports", `${CENSUS_REPORT_ID}.json`);
    await writeCensusPins(root, [CENSUS_REPORT_ID]);
    const pinned = runPruneCli(root);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.stdout, /Pruned 0 static reports\./);
    await access(reportPath);
    await access(path.join(root, "public", "reports", committedSidecarFilename(CENSUS_REPORT_ID)));

    // Without the citation the same CLI ages the report out, so the pin, not
    // some other protection, is what kept it.
    await writeCensusPins(root, []);
    const unpinned = runPruneCli(root);
    assert.equal(unpinned.status, 0, unpinned.stderr);
    assert.match(unpinned.stdout, /Pruned 1 static report\./);
    await assert.rejects(() => access(reportPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the prune CLI aborts before any removal when the census pin file is missing", async () => {
  const root = await censusCliRoot();
  try {
    const result = runPruneCli(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /corpus-censoring-inputs\.json/);
    assert.doesNotMatch(result.stdout, /Pruned/);
    await access(path.join(root, "public", "reports", `${CENSUS_REPORT_ID}.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a census pin naming an absent bundle aborts the prune before any removal", async () => {
  const root = await censusCliRoot();
  const absentId = "20260714-ffffffffffffffffffffffffffffffff";
  try {
    await writeCensusPins(root, [CENSUS_REPORT_ID, absentId]);
    const result = runPruneCli(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${absentId}.*pruning aborted`));
    assert.doesNotMatch(result.stdout, /Pruned/);
    await access(path.join(root, "public", "reports", `${CENSUS_REPORT_ID}.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("census pins outrank the count cap, and the cap warning counts them apart from correction pins", async () => {
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const citedIds = ["20250101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "20250102-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
  const unpinnedId = "20260710-cccccccccccccccccccccccccccccccc";
  await writeReport(citedIds[0], makeResult("cited-one.example.dev", "2025-01-01T00:00:00.000Z"));
  await writeReport(citedIds[1], makeResult("cited-two.example.dev", "2025-01-02T00:00:00.000Z"));
  await writeReport(unpinnedId, makeResult("unpinned.example.dev", "2026-07-10T00:00:00.000Z"));
  const pinPath = path.join(ledgerDir, "inputs.json");
  await writeFile(pinPath, `${JSON.stringify({ reportIds: citedIds })}\n`);

  const { removed, warnings } = await pruneStaticReportsWithCorrections(
    reportsDir,
    emptyLedgerPath,
    { maxAgeMs: 7 * DAY_MS, maxCount: 1, keepPerSite: 0, now },
    [pinPath]
  );

  assert.deepEqual(removed, [path.join(reportsDir, `${unpinnedId}.json`)]);
  assert.match(warnings.at(-1) ?? "", /Keeping 0 correction-linked static reports and 2 decided-package inputs.*count cap is 1/);
  for (const id of citedIds) await access(path.join(reportsDir, `${id}.json`));
});

test("a malformed census pin file aborts before any report is pruned", async () => {
  const reportId = "20250101-dddddddddddddddddddddddddddddddd";
  await writeReport(reportId, makeResult("preserved.example.dev", "2025-01-01T00:00:00.000Z"));
  for (const [name, body] of [
    ["not-an-object", "[]\n"],
    ["ids-not-a-list", '{"reportIds":"20250101-dddddddddddddddddddddddddddddddd"}\n'],
    ["bad-id", '{"reportIds":["../corrections"]}\n'],
    ["duplicate-id", `{"reportIds":["${reportId}","${reportId}"]}\n`]
  ] as const) {
    const pinPath = path.join(ledgerDir, `${name}.json`);
    await writeFile(pinPath, body);
    await assert.rejects(
      () =>
        pruneStaticReportsWithCorrections(
          reportsDir,
          emptyLedgerPath,
          { maxAgeMs: 1, maxCount: 1, keepPerSite: 0, now: Date.parse("2026-07-10T00:00:00.000Z") },
          [pinPath]
        ),
      /Decided-package pin file .* is invalid/,
      name
    );
  }
  await access(path.join(reportsDir, `${reportId}.json`));
});

test("the prune reads the census pin file the calibration-censoring analyzer binds", async () => {
  const nativeImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<{ CENSUS_INPUTS_RELATIVE_PATH: string }>;
  const census = await nativeImport(
    pathToFileURL(path.join(process.cwd(), "research", "calibration-censoring", "census-inputs.mjs")).href
  );
  assert.deepEqual(DECIDED_PACKAGE_INPUT_FILES, [census.CENSUS_INPUTS_RELATIVE_PATH]);
  assert.equal(census.CENSUS_INPUTS_RELATIVE_PATH, CENSUS_PIN_FILE.split(path.sep).join("/"));
});

// Retention keeps every corpus cohort's eligible sites against age pruning.
// The published aggregate rolls up each cohort's newest eligible report per
// site and hands a new measurement line the aggregate only once that line
// retains the incumbent's sites, so a report retention does not know the
// aggregate needs can move what the homepage publishes with no site behaving
// differently.
const OCT19_SHIELDS_ID = "20261019-c35def81f59a9c087376db846202b22a";
const AUG24_SHIELDS_ID = "20260824-662c9f2fe6a2a45af8356a647ab41042";
// Synthetic: no report has this id. The newer-line rescan is built in memory
// from the frozen Oct 19 copy and never committed.
const NEWER_LINE_SYNTHETIC_ID = "20261118-00000000000000000000000000000001";

/**
 * A report in the off-line cohort a disclosure with no methodology token
 * joins. The public boundary admits only a disclosure that matches its
 * producer's template, so this is the way a fixture leaves the current line.
 */
function offLine(report: ScanResult, gpcEnabled = false): ScanResult {
  COHORT_MISMATCHES[0].mutate(report);
  report.conditions.gpcEnabled = gpcEnabled;
  return report;
}

async function copyFrozenBundle(id: string): Promise<void> {
  for (const name of [`${id}.json`, `${id}.provenance.json`]) {
    await copyFile(path.join(process.cwd(), "test-fixtures", "reports", name), path.join(reportsDir, name));
  }
}

async function cohortStats(): Promise<{ id: string; methodologyVersion: string; sampleSize: number; latestRunAt: string | null }[]> {
  const { stats } = await buildCorpusStats(reportsDir);
  return stats.cohorts.map(({ id, methodologyVersion, sampleSize, latestRunAt }) => ({ id, methodologyVersion, sampleSize, latestRunAt }));
}

test("a rescan on a new measurement line does not age out the previous line's report for the site", async () => {
  // The 2026-11-18 shape: craigslist.org's Oct 19 Shields comparison (the
  // 1.63.0 line, published, frozen byte for byte), its corrections-pinned
  // Aug 24 predecessor, and a rescan on the current line. A v1 Shields
  // comparison carries no pairing key, so retention protected only the
  // newest report per site and kind, and the rescan cost the Oct 19 cohort
  // the site.
  await copyFrozenBundle(OCT19_SHIELDS_ID);
  await copyFrozenBundle(AUG24_SHIELDS_ID);
  const oct19 = JSON.parse(frozenReportWire(OCT19_SHIELDS_ID)) as Extract<ScanReport, { reportType: "comparison" }>;
  const oct19Line = corpusCohortIdentityForView(frozenReportView(OCT19_SHIELDS_ID)).methodologyVersion;
  const rescan = structuredClone(oct19);
  const shift = Date.parse("2026-11-18T17:45:00.000Z") - Date.parse(oct19.scannedAt);
  const shifted = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
  const playwright = (line: string) => /-playwright-(\d+\.\d+\.\d+)/.exec(line)?.[1] ?? "";
  rescan.scannedAt = shifted(oct19.scannedAt);
  for (const arm of [rescan.baseline, rescan.variant]) {
    arm.conditions.scannedAt = shifted(arm.conditions.scannedAt);
    arm.conditions.scannerDisclosure = (arm.conditions.scannerDisclosure ?? "")
      .replace(oct19Line, CURRENT_MEASUREMENT_LINE_METHODOLOGY)
      .replace(`using Playwright ${playwright(oct19Line)} `, `using Playwright ${playwright(CURRENT_MEASUREMENT_LINE_METHODOLOGY)} `);
  }
  rescan.share = {
    id: NEWER_LINE_SYNTHETIC_ID,
    path: `/reports/${NEWER_LINE_SYNTHETIC_ID}/`,
    jsonPath: `/reports/${NEWER_LINE_SYNTHETIC_ID}.json`
  };
  await writeManagedPublicReport(NEWER_LINE_SYNTHETIC_ID, redactScanReportV1(rescan).report, "2026-11-18T18:00:00.000Z");
  const ledgerPath = path.join(ledgerDir, "aug24-pinned.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries: [{
      eventId: "SBL-CORR-2026-001",
      publishedAt: "2026-08-25T00:00:00.000Z",
      state: "active",
      reportIds: [AUG24_SHIELDS_ID],
      summary: "A fixture clarification that pins the Aug 24 report, as the published ledger does.",
      detailsUrl: "https://example.test/corrections/1"
    }]
  })}\n`);

  const before = await cohortStats();
  // Fixture invariants: three cohorts, one site each, the rescan on the
  // current line and the Oct 19 report on the line before it.
  assert.equal(before.length, 3);
  assert.deepEqual(before.map((cohort) => cohort.sampleSize), [1, 1, 1]);
  assert.ok(before.some((cohort) => cohort.methodologyVersion === CURRENT_MEASUREMENT_LINE_METHODOLOGY));
  assert.ok(before.some((cohort) => cohort.methodologyVersion === oct19Line));
  assert.notEqual(oct19Line, CURRENT_MEASUREMENT_LINE_METHODOLOGY);

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, ledgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now: Date.parse("2026-11-18T19:00:00.000Z")
  });

  assert.deepEqual(warnings, []);
  assert.deepEqual(removed, []);
  await access(path.join(reportsDir, `${OCT19_SHIELDS_ID}.json`));
  assert.deepEqual(await cohortStats(), before);
});

test("age pruning never shrinks a cohort's eligible sites, while it still removes what no cohort needs", async () => {
  // Shields comparisons that landed on a path redaction generalizes, so they
  // carry no pairing key, as the six Oct 19 reports did: each site has a
  // stale report in one cohort, a staler one in the same cohort, and a fresh
  // one in another (the requested GPC condition is part of the cohort key).
  const sites = ["one-site.dev", "two-site.dev", "three-site.dev"];
  const write = async (id: string, domain: string, scannedAt: string, gpcEnabled: boolean) => {
    const arm = (shieldsMode: "classification" | "block-simulation", at: string) => {
      const run = makeResult(domain, at);
      run.conditions.gpcEnabled = gpcEnabled;
      run.conditions.shieldsMode = shieldsMode;
      run.conditions.finalUrl = `https://${domain}/patient/alice`;
      run.conditions.scannerDisclosure = scannerDisclosure("node-playwright", {
        chromiumVersion: run.conditions.chromiumVersion,
        locale: run.conditions.locale,
        scannerEgress: run.conditions.scannerEgress,
        shieldsMode,
        timezone: run.conditions.timezone
      });
      return run;
    };
    const variantAt = new Date(Date.parse(scannedAt) + 60_000).toISOString();
    await writeReport(id, createShieldsComparisonReport(arm("classification", scannedAt), arm("block-simulation", variantAt)));
  };
  const stalest = sites.map((_, index) => `20260101-${String(index + 1).repeat(32)}`);
  const olderLine = sites.map((_, index) => `20260201-${String(index + 4).repeat(32)}`);
  const currentLine = sites.map((_, index) => `20260701-${String(index + 7).repeat(32)}`);
  for (const [index, domain] of sites.entries()) {
    await write(stalest[index], domain, "2026-01-01T00:00:00.000Z", true);
    await write(olderLine[index], domain, "2026-02-01T00:00:00.000Z", true);
    await write(currentLine[index], domain, "2026-07-01T00:00:00.000Z", false);
  }
  const before = await cohortStats();
  assert.deepEqual(before.map((cohort) => cohort.sampleSize), [3, 3], "fixture invariant: two cohorts of three sites");

  const { removed } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 7 * DAY_MS,
    maxCount: 1_000,
    keepPerSite: 2,
    now: Date.parse("2026-07-10T00:00:00.000Z")
  });

  assert.deepEqual(removed.map((file) => path.basename(file, ".json")), stalest);
  assert.deepEqual(await cohortStats(), before);
});

test("the count cap trims the aggregate selection's representatives last, and names a site a cohort loses", async () => {
  // Two off-line cohorts that differ only in the requested GPC condition.
  // The one without GPC has the newest evidence and is the aggregate's; its
  // oldest site is the oldest report in the corpus, so plain oldest-first
  // trimming would take that site from the published aggregate.
  const write = async (id: string, domain: string, scannedAt: string, gpcEnabled: boolean) =>
    writeReport(id, offLine(makeResult(domain, scannedAt), gpcEnabled));
  const aggregateOldest = "20260701-dddddddddddddddddddddddddddddddd";
  const otherOldest = "20260705-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await write(aggregateOldest, "d-site.dev", "2026-07-01T00:00:00.000Z", false);
  await write(otherOldest, "a-site.dev", "2026-07-05T00:00:00.000Z", true);
  await write("20260706-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "b-site.dev", "2026-07-06T00:00:00.000Z", true);
  await write("20260709-cccccccccccccccccccccccccccccccc", "c-site.dev", "2026-07-09T00:00:00.000Z", false);
  const { stats } = await buildCorpusStats(reportsDir);
  assert.equal(stats.cohorts.length, 2, "fixture invariant: two cohorts");
  const aggregateCohort = stats.cohorts.find((cohort) => !cohort.gpc);
  const otherCohort = stats.cohorts.find((cohort) => cohort.gpc);
  assert.ok(aggregateCohort && otherCohort);
  assert.deepEqual([aggregateCohort.sampleSize, otherCohort.sampleSize], [2, 2]);
  assert.equal(stats.primaryCohortId, aggregateCohort.id, "fixture invariant: the newer cohort is the aggregate's");

  const { removed, warnings } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 365 * DAY_MS,
    maxCount: 3,
    keepPerSite: 2,
    now: Date.parse("2026-07-10T00:00:00.000Z")
  });

  assert.deepEqual(removed, [path.join(reportsDir, `${otherOldest}.json`)]);
  await access(path.join(reportsDir, `${aggregateOldest}.json`));
  assert.deepEqual(warnings, [
    `The count cap removed the last eligible report (${otherOldest}) for site a-site.dev in corpus cohort ${otherCohort.id}.`
  ]);
});

test("the count cap trims last the cohort whose veto decides the selection, though it is no incumbent", async () => {
  // The off-line incumbent holds two sites. On a retired line, a broad GPC-on
  // cohort vetoes a narrow GPC-off one (the 2026-07-27 shape): the narrow one
  // covers the incumbent's sites and would take the aggregate, but the veto
  // keeps it from contending, and the broad one cannot retain the incumbent's
  // sites. So the vetoer, which never holds the aggregate, decides it.
  const retired = REVIEWED_MEASUREMENT_LINES[REVIEWED_MEASUREMENT_LINES.length - 2];
  const playwright = (line: string) => /-playwright-(\d+\.\d+\.\d+)/.exec(line)?.[1] ?? "";
  const onRetiredLine = (report: ScanResult, gpcEnabled: boolean): ScanResult => {
    report.conditions.gpcEnabled = gpcEnabled;
    report.conditions.scannerDisclosure = (report.conditions.scannerDisclosure ?? "")
      .replace(CURRENT_MEASUREMENT_LINE_METHODOLOGY, retired)
      .replace(`using Playwright ${playwright(CURRENT_MEASUREMENT_LINE_METHODOLOGY)} `, `using Playwright ${playwright(retired)} `);
    return report;
  };
  const vetoer = ["20260701-11111111111111111111111111111111", "20260702-22222222222222222222222222222222", "20260703-33333333333333333333333333333333"];
  const vetoed = ["20260704-44444444444444444444444444444444", "20260705-55555555555555555555555555555555"];
  for (const [index, id] of vetoer.entries()) {
    await writeReport(id, onRetiredLine(makeResult(`broad-${index}.dev`, `2026-07-0${index + 1}T00:00:00.000Z`), true));
  }
  for (const [index, id] of vetoed.entries()) {
    await writeReport(id, onRetiredLine(makeResult(`shared-${index}.dev`, `2026-07-0${index + 4}T00:00:00.000Z`), false));
  }
  await writeReport("20260706-66666666666666666666666666666666", offLine(makeResult("shared-0.dev", "2026-07-06T00:00:00.000Z")));
  await writeReport("20260707-77777777777777777777777777777777", offLine(makeResult("shared-1.dev", "2026-07-07T00:00:00.000Z")));

  const selected = async () => (await buildCorpusStats(reportsDir)).stats;
  const before = await selected();
  const incumbent = before.cohorts.find((cohort) => cohort.methodologyVersion !== retired);
  assert.ok(incumbent);
  assert.equal(before.cohorts.length, 3, "fixture invariant: an incumbent and two retired-line cohorts");
  assert.equal(before.primaryCohortId, incumbent.id, "fixture invariant: the veto keeps the incumbent publishing");

  const { removed } = await pruneStaticReportsWithCorrections(reportsDir, emptyLedgerPath, {
    maxAgeMs: 365 * DAY_MS,
    maxCount: 5,
    keepPerSite: 2,
    now: Date.parse("2026-07-10T00:00:00.000Z")
  });

  assert.deepEqual(
    removed.map((file) => path.basename(file, ".json")),
    vetoed,
    "the cap trims the vetoed cohort, never the vetoer's sites"
  );
  assert.equal((await selected()).primaryCohortId, before.primaryCohortId);
});

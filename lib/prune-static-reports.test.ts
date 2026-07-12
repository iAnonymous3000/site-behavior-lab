import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pruneStaticReports } from "./prune-static-reports";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { scannerDisclosure } from "./scan-condition-disclosure";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { PublicScanReportV2 } from "./scan-report-v2";
import type { ScanReport, ScanResult } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

let reportsDir = "";

beforeEach(async () => {
  reportsDir = await mkdtemp(path.join(tmpdir(), "sbl-prune-"));
});

afterEach(async () => {
  await rm(reportsDir, { recursive: true, force: true });
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

type TestReport = ScanReport | PublicScanReportV2;

async function writeReport(id: string, report: TestReport): Promise<void> {
  const publicReport = report.schemaVersion === 1 ? redactScanReportV1(report).report : structuredClone(report);
  if (publicReport.schemaVersion === 2) {
    if (publicReport.reportType === "comparison") {
      publicReport.baseline.privacy.redactionVersion = REDACTION_VERSION;
      publicReport.variant.privacy.redactionVersion = REDACTION_VERSION;
    } else {
      publicReport.run.privacy.redactionVersion = REDACTION_VERSION;
    }
  }
  await writeManagedPublicReport(id, publicReport);
}

async function writeManagedPublicReport(id: string, publicReport: TestReport): Promise<void> {
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
    writtenAt: "2026-07-12T00:00:00.000Z",
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

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
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

    const { removed, warnings } = await pruneStaticReports(reportsDir, {
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

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
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

  const v2 = makePublicSingleReportV2();
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

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
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

  const { removed } = await pruneStaticReports(reportsDir, {
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

  const { removed } = await pruneStaticReports(reportsDir, {
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

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
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

  const { removed } = await pruneStaticReports(reportsDir, {
    maxAgeMs: 365 * DAY_MS,
    maxCount: 2,
    keepPerSite: 0,
    now
  });

  assert.equal(removed.length, 1);
  assert.match(removed[0], /20260708-a+\.json$/);
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

  const { removed, warnings } = await pruneStaticReports(reportsDir, {
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

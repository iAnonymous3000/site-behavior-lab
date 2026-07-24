import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  assertReportPublicationRequest,
  assertStoredReportPublicationRequest,
  featuredReportPublicationRequest,
  singleReportPublicationRequest
} from "./report-publication-request";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import {
  makeScanRunV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type {
  InterventionExperimentR2,
  PublicComparisonReportV2R2,
  PublicScanReportV2R2
} from "./scan-report-v2-r2";
import type { ScanReport, ScanResult } from "./types";

const SOURCE_COMMIT = "a".repeat(40);
const WRONG_COMMIT = "b".repeat(40);
const SINGLE_ID = `20260721-${"1".repeat(32)}`;
const COMPARISON_ID = `20260721-${"2".repeat(32)}`;
const R2_ID = `20260721-${"3".repeat(32)}`;

let testRoot = "";
let reportsDir = "";

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "sbl-publication-request-"));
  reportsDir = path.join(testRoot, "reports");
  await mkdir(reportsDir);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("single report binding accepts the redacted requested target while allowing an honest redirect", async () => {
  const report = singleReport({
    requestedUrl: "https://shop.example.com/account/alice?token=secret",
    finalUrl: "https://checkout.example.net/finished?receipt=secret",
    finalDomain: "checkout.example.net",
    gpcEnabled: true
  });
  await writeBundle(SINGLE_ID, report);

  await assertReportPublicationRequest({
    reportsDir,
    reportIds: [SINGLE_ID],
    sourceCommit: SOURCE_COMMIT,
    request: {
      targets: ["https://shop.example.com/account/bob?other=secret"],
      device: "desktop",
      comparisonAxis: null,
      gpcEnabled: true
    }
  });

  await assert.rejects(
    () => assertReportPublicationRequest({
      reportsDir,
      reportIds: [SINGLE_ID],
      sourceCommit: SOURCE_COMMIT,
      request: {
        targets: ["https://unrelated.example.net/"],
        device: "desktop",
        comparisonAxis: null,
        gpcEnabled: true
      }
    }),
    /does not match a selected workflow target/
  );
});

test("single report binding rejects device and GPC request drift", async () => {
  await writeBundle(SINGLE_ID, singleReport({ gpcEnabled: false }));
  const request = {
    targets: ["https://shop.example.com/"],
    device: "desktop" as const,
    comparisonAxis: null,
    gpcEnabled: false
  };
  await assert.rejects(
    () => assertReportPublicationRequest({
      reportsDir,
      reportIds: [SINGLE_ID],
      sourceCommit: SOURCE_COMMIT,
      request: { ...request, device: "mobile" }
    }),
    /device desktop does not match mobile/
  );
  await assert.rejects(
    () => assertReportPublicationRequest({
      reportsDir,
      reportIds: [SINGLE_ID],
      sourceCommit: SOURCE_COMMIT,
      request: { ...request, gpcEnabled: true }
    }),
    /does not match the selected GPC state/
  );
});

test("comparison binding accepts only the selected comparison axis", async () => {
  const baseline = singleReport({ gpcEnabled: false, scannedAt: "2026-07-21T10:00:00.000Z" });
  const variant = singleReport({ gpcEnabled: true, scannedAt: "2026-07-21T10:01:00.000Z" });
  const comparison = redactScanReportV1(
    createGpcComparisonReport(baseline, variant, { executedFirst: "baseline" })
  ).report;
  await writeBundle(COMPARISON_ID, comparison);
  const common = {
    reportsDir,
    reportIds: [COMPARISON_ID],
    sourceCommit: SOURCE_COMMIT,
    request: {
      targets: ["https://shop.example.com/"],
      device: "desktop" as const,
      comparisonAxis: "gpc" as const,
      gpcEnabled: true
    }
  };
  await assertReportPublicationRequest(common);
  await assert.rejects(
    () => assertReportPublicationRequest({
      ...common,
      request: { ...common.request, comparisonAxis: "shields" }
    }),
    /does not match the selected comparison request/
  );
});

test("r2 binding requires exact Node/ci-workflow build provenance", async () => {
  const report = toPublicScanReportR2(
    buildRuntimeScanReportV2R2(
      scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2({ startedAt: "2026-07-21T12:00:00.000Z" })),
      "ci-workflow",
      { SITE_BEHAVIOR_LAB_BUILD_COMMIT: SOURCE_COMMIT } as NodeJS.ProcessEnv
    )
  );
  await writeBundle(R2_ID, report);
  const request = {
    targets: ["https://shop.example.com/products/anything?ignored=1"],
    device: report.run.conditions.device.kind,
    comparisonAxis: null,
    gpcEnabled: report.run.conditions.gpc
  };
  await assertReportPublicationRequest({
    reportsDir,
    reportIds: [R2_ID],
    sourceCommit: SOURCE_COMMIT,
    request
  });
  await assert.rejects(
    () => assertReportPublicationRequest({
      reportsDir,
      reportIds: [R2_ID],
      sourceCommit: WRONG_COMMIT,
      request
    }),
    /provenance does not match the exact Node acquisition source/
  );
});

test("r2 binding validates provenance, target, device, and axis semantics in every supporting pair", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  if (report.experiment.kind !== "intervention" || !report.experiment.supportingPairs?.[0]) {
    throw new Error("expected supporting-pair fixture");
  }
  const interventionReport = report as PublicComparisonReportV2R2 & { experiment: InterventionExperimentR2 };
  const allRuns = [
    interventionReport.baseline,
    interventionReport.variant,
    ...interventionReport.experiment.supportingPairs!.flatMap((pair) => [pair.baseline, pair.variant])
  ];
  for (const run of allRuns) {
    run.provenance = {
      ...run.provenance,
      observer: "node-playwright",
      acquisition: "ci-workflow",
      buildCommit: SOURCE_COMMIT
    };
  }
  const stored = { schemaVersion: 2 as const, schemaRevision: 2 as const, report: interventionReport };
  const request = {
    targets: ["https://shop.example.com/products/example"],
    device: "desktop" as const,
    comparisonAxis: "shields" as const,
    gpcEnabled: true
  };
  assertStoredReportPublicationRequest({ stored, sourceCommit: SOURCE_COMMIT, request });

  const wrongProvenance = structuredClone(stored);
  wrongProvenance.report.experiment.supportingPairs![0].variant.provenance.buildCommit = WRONG_COMMIT;
  assert.throws(
    () => assertStoredReportPublicationRequest({ stored: wrongProvenance, sourceCommit: SOURCE_COMMIT, request }),
    /provenance does not match the exact Node acquisition source/
  );

  const wrongTarget = structuredClone(stored);
  wrongTarget.report.experiment.supportingPairs![0].baseline.subject.requested = {
    origin: "https://unrelated.example.net",
    registrableDomain: "example.net",
    routeShape: "/"
  };
  assert.throws(
    () => assertStoredReportPublicationRequest({ stored: wrongTarget, sourceCommit: SOURCE_COMMIT, request }),
    /requested-subject facts disagree/
  );

  const wrongDevice = structuredClone(stored);
  wrongDevice.report.experiment.supportingPairs![0].variant.conditions.device = {
    kind: "mobile",
    viewport: { width: 390, height: 844, isMobile: true }
  };
  assert.throws(
    () => assertStoredReportPublicationRequest({ stored: wrongDevice, sourceCommit: SOURCE_COMMIT, request }),
    /device facts disagree/
  );

  const wrongAxisArm = structuredClone(stored);
  wrongAxisArm.report.experiment.supportingPairs![0].baseline.conditions.shields = "block-simulation";
  assert.throws(
    () => assertStoredReportPublicationRequest({ stored: wrongAxisArm, sourceCommit: SOURCE_COMMIT, request }),
    /does not contain the canonical shields request arms/
  );
});

test("featured request selection is exact-SHA catalog bounded and honors filters", async () => {
  const selected = await featuredReportPublicationRequest(process.cwd(), {
    FEATURED_SITES_FILE: "public/corpus-seed-sites.json",
    FEATURED_CATEGORIES: "reference",
    FEATURED_LIMIT: "2",
    FEATURED_COMPARE_SHIELDS: "true",
    FEATURED_DEVICE: "mobile"
  } as NodeJS.ProcessEnv);
  assert.deepEqual(selected, {
    targets: ["https://www.w3.org/", "https://www.ietf.org/"],
    device: "mobile",
    comparisonAxis: "shields",
    gpcEnabled: true
  });

  const full = await featuredReportPublicationRequest(process.cwd(), {} as NodeJS.ProcessEnv);
  assert.equal(full.targets.includes("https://www.coinbase.com/"), false, "temporary-unavailability entries stay excluded");
  await assert.rejects(
    () => featuredReportPublicationRequest(process.cwd(), {
      FEATURED_SITES_FILE: "package.json"
    } as NodeJS.ProcessEnv),
    /two reviewed repository catalogs/
  );
});

test("single request selection mirrors scanner comparison precedence", () => {
  assert.deepEqual(
    singleReportPublicationRequest({
      SCAN_URL: "example.com",
      SCAN_DEVICE: "mobile",
      SCAN_GPC_ENABLED: "false",
      SCAN_COMPARE_GPC: "true",
      SCAN_COMPARE_CONSENT: "true",
      SCAN_COMPARE_SHIELDS: "true"
    } as NodeJS.ProcessEnv),
    {
      targets: ["example.com"],
      device: "mobile",
      comparisonAxis: "shields",
      gpcEnabled: false
    }
  );
});

test("trusted request parsing rejects malformed booleans, devices, limits, and categories", async () => {
  assert.throws(
    () => singleReportPublicationRequest({ SCAN_URL: "example.com", SCAN_GPC_ENABLED: "sometimes" } as NodeJS.ProcessEnv),
    /boolean setting is malformed/
  );
  assert.throws(
    () => singleReportPublicationRequest({ SCAN_URL: "example.com", SCAN_DEVICE: "tablet" } as NodeJS.ProcessEnv),
    /device must be exactly/
  );
  await assert.rejects(
    () => featuredReportPublicationRequest(process.cwd(), { FEATURED_LIMIT: "-1" } as NodeJS.ProcessEnv),
    /FEATURED_LIMIT must be an integer/
  );
  await assert.rejects(
    () => featuredReportPublicationRequest(process.cwd(), { FEATURED_CATEGORIES: "reference,,gov" } as NodeJS.ProcessEnv),
    /FEATURED_CATEGORIES is malformed/
  );
  await assert.rejects(
    () => featuredReportPublicationRequest(process.cwd(), { FEATURED_CATEGORIES: "not-a-real-category" } as NodeJS.ProcessEnv),
    /unknown catalog category/
  );
});

test("featured request rejects catalog cardinality before mapping untrusted site entries", async () => {
  const checkoutRoot = path.join(testRoot, "catalog-checkout");
  await mkdir(path.join(checkoutRoot, "public"), { recursive: true });
  await writeFile(
    path.join(checkoutRoot, "public", "featured-sites.json"),
    `${JSON.stringify({ sites: Array.from({ length: 10_001 }, () => null) })}\n`
  );
  await assert.rejects(
    () => featuredReportPublicationRequest(checkoutRoot, {} as NodeJS.ProcessEnv),
    /must contain from 1 to 10000 sites/
  );
});

function singleReport(input: {
  requestedUrl?: string;
  finalUrl?: string;
  finalDomain?: string;
  gpcEnabled?: boolean;
  scannedAt?: string;
} = {}): ScanResult {
  const fixture = makeScanReportV1();
  if (fixture.reportType === "comparison") throw new Error("expected a single fixture");
  const requestedUrl = input.requestedUrl ?? "https://shop.example.com/";
  const finalUrl = input.finalUrl ?? requestedUrl;
  const report: ScanResult = {
    ...fixture,
    summary: {
      ...fixture.summary,
      firstPartyDomain: input.finalDomain ?? new URL(finalUrl).hostname
    },
    conditions: {
      ...fixture.conditions,
      requestedUrl,
      finalUrl,
      scannedAt: input.scannedAt ?? "2026-07-21T10:00:00.000Z",
      gpcEnabled: input.gpcEnabled ?? fixture.conditions.gpcEnabled
    }
  };
  return redactScanReportV1(report).report;
}

async function writeBundle(reportId: string, report: ScanReport | PublicScanReportV2R2): Promise<void> {
  const createdAt = report.schemaVersion === 1
    ? report.reportType === "comparison" ? report.scannedAt : report.conditions.scannedAt
    : report.reportType === "comparison" ? report.baseline.startedAt : report.run.startedAt;
  const sidecar = buildProvenanceEntry({
    reportId,
    publicReport: report,
    writtenAt: createdAt,
    createdAt,
    expiresAt: null
  });
  await writeFile(path.join(reportsDir, `${reportId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(reportsDir, committedSidecarFilename(reportId)),
    `${JSON.stringify(sidecar, null, 2)}\n`
  );
}

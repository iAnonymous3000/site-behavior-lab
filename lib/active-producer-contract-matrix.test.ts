import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { buildCorpusExportRows } from "./corpus-export";
import {
  corpusExportMetadataForView,
  entryEligibleForCorpusRollups,
  type DirectoryEntry
} from "./corpus-overview";
import { featuredReportPreflight } from "./featured-report-preflight";
import { readManagedReport } from "./managed-report-reader";
import {
  buildPageGraphScanReportV2R2,
  type PageGraphCaptureMetadataV1
} from "./pagegraph-v2-r2-builder";
import { buildProvenanceEntry } from "./redaction-provenance";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { buildReportDataset } from "./report-jsonld";
import {
  activeReportProducerCapabilities,
  producerCapability
} from "./report-producers";
import { trackingServiceRequests } from "./report-insights";
import { loadedReportFromStored, type LoadedReport } from "./scan-report-view";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  familyUnsupportedOnRun,
  runHitRequestRecordingCap,
  runQualitySummary,
  type ReportView
} from "./scan-report-views";
import { sha256BytesHex } from "./sha256";
import { createLoadedTemporalComparison } from "./temporal-report-comparison";
import {
  comparisonHistoryCohortForStoredReport,
  consentClicksForView
} from "./temporal-report-identity";

const BUILD_COMMIT = "a".repeat(40);
const WRITTEN_AT = "2026-07-22T12:00:00.000Z";
const PAGEGRAPH_FIXTURE_DIR = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");
const PAGEGRAPH_BYTES = new Uint8Array(
  readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml"))
);
const PAGEGRAPH_TEXT = new TextDecoder().decode(PAGEGRAPH_BYTES);
const PAGEGRAPH_METADATA = JSON.parse(
  readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "real-wikipedia-2026-07-19.meta.json"), "utf8")
) as PageGraphCaptureMetadataV1;

type ManagedArtifact = {
  reportId: string;
  report: PublicScanReportV2R2;
  stored: StoredScanReport;
  loaded: LoadedReport;
  publicDigest: string;
};

type ProducerLane = {
  name: string;
  artifact: ManagedArtifact;
  observer: "node-playwright" | "pagegraph-import";
  acquisition: "public-api" | "upload";
  corpusEligible: boolean;
};

function nodeInput(input: {
  startedAt: string;
  egressLabel: string;
  egressRegion: string;
}): Parameters<typeof scanMeasurementEnvelopeWithR2Run>[0] {
  const source = makeScanRunV2R2({ startedAt: input.startedAt });
  source.conditions = {
    ...source.conditions,
    egress: { label: input.egressLabel, region: input.egressRegion }
  };
  return source;
}

function nodeReport(input: Parameters<typeof nodeInput>[0], environment: NodeJS.ProcessEnv): PublicScanReportV2R2 {
  const envelope = scanMeasurementEnvelopeWithR2Run(nodeInput(input));
  return toPublicScanReportR2(buildRuntimeScanReportV2R2(envelope, "public-api", environment));
}

function pageGraphReport(runId: string): PublicScanReportV2R2 {
  return buildPageGraphScanReportV2R2(PAGEGRAPH_BYTES, structuredClone(PAGEGRAPH_METADATA), {
    buildCommit: BUILD_COMMIT,
    runId
  });
}

function laterPageGraphReport(runId: string): PublicScanReportV2R2 {
  const metadata = structuredClone(PAGEGRAPH_METADATA);
  metadata.capture.scannedAt = "2026-07-19T23:48:29.150Z";
  const text = PAGEGRAPH_TEXT.replace(
    "<date>1784504849.150528</date>",
    "<date>1784504909.150528</date>"
  );
  assert.notEqual(text, PAGEGRAPH_TEXT, "the real fixture date must be advanced for the second visit");
  const bytes = new TextEncoder().encode(text);
  metadata.artifact.bytes = bytes.byteLength;
  metadata.artifact.sha256 = sha256BytesHex(bytes);
  return buildPageGraphScanReportV2R2(bytes, metadata, { buildCommit: BUILD_COMMIT, runId });
}

function managedArtifact(report: PublicScanReportV2R2, reportId: string): ManagedArtifact {
  const initial = readStoredScanReport(report);
  assert.equal(initial.ok, true, `${reportId} must pass the canonical reader before provenance is attached`);
  if (!initial.ok) throw new Error(`unreadable producer artifact: ${reportId}`);
  const createdAt = committedReportCreatedAt(initial.stored);
  const provenance = buildProvenanceEntry({
    reportId,
    publicReport: report,
    writtenAt: WRITTEN_AT,
    createdAt,
    expiresAt: null
  });
  const managed = readManagedReport({
    reportId,
    reportContents: JSON.stringify(report),
    sidecarContents: JSON.stringify(provenance),
    retention: { createdAt, expiresAt: null }
  });
  assert.equal(managed.ok, true, `${reportId} must pass the managed report + receipt reader`);
  if (!managed.ok) throw new Error(`unreadable managed producer artifact: ${reportId}`);
  return {
    reportId,
    report,
    stored: managed.stored,
    loaded: loadedReportFromStored(managed.stored),
    publicDigest: managed.provenance.publicDigest
  };
}

function directoryEntry(artifact: ManagedArtifact): DirectoryEntry {
  const view = artifact.loaded.view;
  const run = displayRunView(view);
  const headline = buildReportHeadline(view);
  const successfulRuns = view.runs.filter(
    (candidate) =>
      candidate.quality.outcome === "complete" &&
      typeof candidate.status === "number" &&
      candidate.status < 400
  );
  const arms = comparisonArmViews(view);
  return {
    id: artifact.reportId,
    domain: headline.domain,
    tone: headline.tone,
    headline: headline.headline,
    thirdPartyRequests: run.counts.thirdPartyRequests,
    trackerRequests: trackingServiceRequests(run.evidence),
    thirdPartyCookies: run.counts.thirdPartyCookies,
    shieldsThirdPartyChange: null,
    category: "contract-matrix",
    categoryLabel: "Contract matrix",
    scannedAt: view.scannedAt ?? "",
    reportType: view.reportType,
    device: run.conditions.viewport.isMobile ? "mobile" : "desktop",
    gpcEnabled: run.conditions.gpcEnabled,
    consentMode: run.conditions.consentMode,
    consentClicks: consentClicksForView(view),
    status: run.status,
    runOutcome: run.quality.outcome,
    reportHasSuccessfulLoad: successfulRuns.length > 0,
    reportHasRequestCappedLoad: successfulRuns.some(runHitRequestRecordingCap),
    requestEvidenceComplete: !familyCensoredOnRun(run, "requests"),
    cookieEvidenceComplete: !familyCensoredOnRun(run, "cookies"),
    capped: runHitRequestRecordingCap(run),
    requestedUrl: run.conditions.requestedUrl,
    finalUrl: run.conditions.finalUrl,
    schemaVersion: artifact.stored.schemaVersion,
    schemaRevision: view.revision,
    schemaOrigin: view.origin,
    limited: view.limited,
    ...corpusExportMetadataForView(view),
    ...(arms && view.comparison
      ? {
          comparisonType: view.comparison.axis ?? (view.comparison.temporalPair ? "temporal" : "custom")
        }
      : {})
  };
}

function assertRenderingModel(view: ReportView, reportId: string): void {
  const headline = buildReportHeadline(view);
  const findings = buildFindings(view, null);
  const dataset = buildReportDataset(view, {
    url: `https://sitebehavior.org/reports/${reportId}/`,
    jsonUrl: `https://sitebehavior.org/reports/${reportId}.json`
  });
  assert.ok(headline.headline.length > 0);
  assert.ok(headline.subhead.length > 0);
  assert.ok(findings.length > 0);
  assert.equal(dataset["@type"], "Dataset");
  assert.equal(Array.isArray(dataset.variableMeasured), true);
}

function assertTemporalPath(before: ManagedArtifact, after: ManagedArtifact): LoadedReport {
  const comparison = createLoadedTemporalComparison(before.loaded, after.loaded);
  assert.equal(comparison.ok, true, `${before.reportId} and ${after.reportId} must support their recorded temporal path`);
  assert.equal(comparison.generation, "v2-r2");
  assert.equal(comparison.loaded.source, "v2-r2-public");
  if (comparison.loaded.source !== "v2-r2-public") throw new Error("expected a public r2 temporal report");
  assert.equal(comparison.loaded.wire.reportType, "comparison");
  const reread = readStoredScanReport(comparison.loaded.wire);
  assert.equal(reread.ok, true, "derived temporal wire must remain reader-valid");
  assert.equal(comparison.loaded.view.claims.temporalChange, true);
  return comparison.loaded;
}

test("the active producer registry excludes retired Browser Run from parity scope", () => {
  assert.deepEqual(
    activeReportProducerCapabilities().map((entry) => entry.producer).sort(),
    ["node", "pagegraph"]
  );
  assert.equal(producerCapability("node").lifecycle, "active");
  assert.equal(producerCapability("pagegraph").lifecycle, "active");
  assert.equal(producerCapability("cloudflare-worker").lifecycle, "retired-legacy");
});

test("every active r2 producer lane survives managed reading, rendering, provenance, and corpus shaping", () => {
  const directEnvironment = {
    NODE_ENV: "test",
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD_COMMIT
  } as NodeJS.ProcessEnv;
  const featuredPlan = featuredReportPreflight({
    mode: "r2",
    eventName: "schedule",
    eventCommit: BUILD_COMMIT,
    checkoutCommit: BUILD_COMMIT,
    worktreeClean: true,
    compareGpc: "false",
    compareShields: "false",
    compareConsent: "false",
    runnerEnvironment: "self-hosted",
    egressLabel: "controlled-egress",
    egressRegion: "iad-egress-1",
    egressAttested: "1",
    chromiumSandbox: "1",
    controlledRunnerConfigured: true
  });
  const featuredEnvironment = {
    NODE_ENV: "test",
    ...featuredPlan.environment
  } as NodeJS.ProcessEnv;

  const lanes: ProducerLane[] = [
    {
      name: "Node public r2",
      artifact: managedArtifact(
        nodeReport(
          {
            startedAt: "2026-07-20T12:00:00.000Z",
            egressLabel: "public-scanner",
            egressRegion: "us-west"
          },
          directEnvironment
        ),
        `20260720-${"1".repeat(32)}`
      ),
      observer: "node-playwright",
      acquisition: "public-api",
      corpusEligible: true
    },
    {
      name: "controlled featured CI r2 through the public API",
      artifact: managedArtifact(
        nodeReport(
          {
            startedAt: "2026-07-20T12:10:00.000Z",
            egressLabel: "controlled-egress",
            egressRegion: "iad-egress-1"
          },
          featuredEnvironment
        ),
        `20260720-${"2".repeat(32)}`
      ),
      observer: "node-playwright",
      acquisition: "public-api",
      corpusEligible: true
    },
    {
      name: "PageGraph upload r2",
      artifact: managedArtifact(
        pageGraphReport("matrix-pagegraph-1"),
        `20260719-${"3".repeat(32)}`
      ),
      observer: "pagegraph-import",
      acquisition: "upload",
      corpusEligible: false
    }
  ];

  assert.equal(featuredPlan.environment.SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS, "1");
  assert.equal(featuredPlan.summary.some((line) => line.includes("operator-attested self-hosted")), true);

  for (const lane of lanes) {
    const { artifact } = lane;
    assert.equal(artifact.stored.schemaVersion, 2, lane.name);
    assert.equal(artifact.loaded.view.revision, 2, lane.name);
    assert.equal(artifact.loaded.view.reportType, "single", lane.name);
    const run = displayRunView(artifact.loaded.view);
    assert.equal(run.provenance?.observer, lane.observer, lane.name);
    assert.equal(run.provenance?.acquisition, lane.acquisition, lane.name);
    assert.equal(run.provenance?.buildCommit, BUILD_COMMIT, lane.name);
    assert.match(artifact.publicDigest, /^[0-9a-f]{64}$/, lane.name);
    assertRenderingModel(artifact.loaded.view, artifact.reportId);

    const historyCohort = comparisonHistoryCohortForStoredReport(
      artifact.stored,
      artifact.loaded.view
    );
    assert.notEqual(historyCohort, null, `${lane.name} must identify a supported request-history cohort`);

    const entry = directoryEntry(artifact);
    assert.equal(entry.producer, lane.observer, lane.name);
    assert.equal(entry.acquisition, lane.acquisition, lane.name);
    assert.equal(entryEligibleForCorpusRollups(entry), lane.corpusEligible, lane.name);
    const [row] = buildCorpusExportRows([entry], "https://sitebehavior.org");
    assert.equal(row.producer, lane.observer, lane.name);
    assert.equal(row.acquisition, lane.acquisition, lane.name);
    assert.equal(row.corpusInclusion, lane.corpusEligible ? "included" : "excluded", lane.name);
    if (!lane.corpusEligible) {
      assert.deepEqual(row.corpusExclusionReasons, ["missing-http-status"], lane.name);
    }
  }
});

test("each active producer supports its honest temporal diff surface and PageGraph gaps fail explicitly", () => {
  const directEnvironment = {
    NODE_ENV: "test",
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD_COMMIT
  } as NodeJS.ProcessEnv;
  const featuredPlan = featuredReportPreflight({
    mode: "r2",
    eventName: "schedule",
    eventCommit: BUILD_COMMIT,
    checkoutCommit: BUILD_COMMIT,
    worktreeClean: true,
    compareGpc: "false",
    compareShields: "false",
    compareConsent: "false",
    runnerEnvironment: "self-hosted",
    egressLabel: "controlled-egress",
    egressRegion: "iad-egress-1",
    egressAttested: "1",
    chromiumSandbox: "1",
    controlledRunnerConfigured: true
  });
  const featuredEnvironment = { NODE_ENV: "test", ...featuredPlan.environment } as NodeJS.ProcessEnv;

  const nodeTemporal = assertTemporalPath(
    managedArtifact(
      nodeReport(
        {
          startedAt: "2026-07-20T12:00:00.000Z",
          egressLabel: "public-scanner",
          egressRegion: "us-west"
        },
        directEnvironment
      ),
      `20260720-${"4".repeat(32)}`
    ),
    managedArtifact(
      nodeReport(
        {
          startedAt: "2026-07-20T12:05:00.000Z",
          egressLabel: "public-scanner",
          egressRegion: "us-west"
        },
        directEnvironment
      ),
      `20260720-${"5".repeat(32)}`
    )
  );
  assert.equal(nodeTemporal.view.claims.familyDeltas?.["raw-counts"].allowed, true);
  assertRenderingModel(nodeTemporal.view, `20260720-${"a".repeat(32)}`);

  const featuredTemporal = assertTemporalPath(
    managedArtifact(
      nodeReport(
        {
          startedAt: "2026-07-20T12:10:00.000Z",
          egressLabel: "controlled-egress",
          egressRegion: "iad-egress-1"
        },
        featuredEnvironment
      ),
      `20260720-${"6".repeat(32)}`
    ),
    managedArtifact(
      nodeReport(
        {
          startedAt: "2026-07-20T12:15:00.000Z",
          egressLabel: "controlled-egress",
          egressRegion: "iad-egress-1"
        },
        featuredEnvironment
      ),
      `20260720-${"7".repeat(32)}`
    )
  );
  assert.equal(featuredTemporal.view.claims.familyDeltas?.["raw-counts"].allowed, true);

  const pageGraphBefore = managedArtifact(
    pageGraphReport("matrix-pagegraph-before"),
    `20260719-${"8".repeat(32)}`
  );
  const pageGraphAfter = managedArtifact(
    laterPageGraphReport("matrix-pagegraph-after"),
    `20260719-${"9".repeat(32)}`
  );
  const pageGraphRun = displayRunView(pageGraphBefore.loaded.view);
  const unsupportedFamilies = [
    "cookies",
    "storage",
    "fingerprinting",
    "detector-output",
    "consent-verification"
  ] as const;
  for (const family of unsupportedFamilies) {
    assert.equal(familyUnsupportedOnRun(pageGraphRun, family), true, family);
  }
  assert.deepEqual(
    pageGraphRun.quality.facts?.captureLoss
      .filter((loss) => loss.detail === "pagegraph-unsupported")
      .map((loss) => loss.family)
      .sort(),
    [...unsupportedFamilies].sort(),
    "PageGraph must emit exactly one explicit sentinel for every unsupported family"
  );
  assert.match(runQualitySummary(pageGraphRun), /complete for supported evidence; unsupported:/);

  const datasetMeasurements = buildReportDataset(pageGraphBefore.loaded.view, {
    url: "https://sitebehavior.org/reports/pagegraph-matrix/"
  }).variableMeasured as Array<Record<string, unknown>>;
  assert.equal(datasetMeasurements.some((entry) => entry.name === "Third-party requests"), true);
  assert.equal(datasetMeasurements.some((entry) => entry.name === "Third-party cookies"), false);
  assert.equal(datasetMeasurements.some((entry) => entry.name === "Fingerprint-like API calls"), false);
  assert.match(
    String(datasetMeasurements.find((entry) => entry.name === "Measurement quality")?.description),
    /Unsupported measurements omitted/
  );
  const findings = buildFindings(pageGraphBefore.loaded.view, null);
  assert.equal(findings.find((finding) => finding.id === "third-party-cookies")?.title, "Cookie evidence was not captured");
  assert.equal(findings.find((finding) => finding.id === "fingerprint-apis")?.title, "Fingerprinting evidence was not captured");

  const pageGraphTemporal = assertTemporalPath(pageGraphBefore, pageGraphAfter);
  assert.equal(pageGraphTemporal.view.claims.familyDeltas?.["tracker-classification"].allowed, true);
  assert.equal(pageGraphTemporal.view.claims.familyDeltas?.["raw-counts"].allowed, false);
  assert.equal(pageGraphTemporal.view.claims.familyDeltas?.["detector-findings"].allowed, false);
  assert.equal(pageGraphTemporal.view.claims.familyDeltas?.["consent-verification"].allowed, false);
  const unsupportedRawCountReasons =
    pageGraphTemporal.view.claims.familyDeltas?.["raw-counts"].reasons.join(" ") ?? "";
  assert.match(unsupportedRawCountReasons, /PageGraph.*did not capture.*unavailable/i);
  assert.doesNotMatch(unsupportedRawCountReasons, /recording cap|cut short/i);

  const missingSentinel = structuredClone(pageGraphBefore.report);
  assert.equal(missingSentinel.reportType, "single");
  if (missingSentinel.reportType !== "single") throw new Error("expected PageGraph single report");
  missingSentinel.run.qualityFacts.captureLoss = missingSentinel.run.qualityFacts.captureLoss.filter(
    (loss) => !(loss.family === "cookies" && loss.detail === "pagegraph-unsupported")
  );
  const rejected = readStoredScanReport(missingSentinel);
  assert.deepEqual(rejected, { ok: false, error: "invalid" });
});

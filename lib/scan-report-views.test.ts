import assert from "node:assert/strict";
import { test } from "node:test";
import { createGpcComparisonReport } from "./compare-reports";
import {
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeScanReportV1,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import {
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";
import {
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION
} from "./legacy-methodology";
import {
  familyCensoredOnRun,
  requestEvidenceState,
  runHitRequestRecordingCap,
  viewFromV1Report,
  viewFromV2
} from "./scan-report-views";
import { runRequestEvidenceCapped } from "./comparison-eligibility";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { INVALID_UPSTREAM_RESPONSE_WARNING, UNSETTLED_ROUTED_REQUEST_WARNING } from "./scan-runtime";
import type { ScanResult } from "./types";

// ---------------------------------------------------------------------------
// The expanded evidence surface (survey: phases, mutations, detector ledger,
// capture loss, toolchain identity, attempts/failures, configured-vs-verified).
// v1 never recorded these: every block must be null ("never recorded"), so no
// renderer can present a derived stand-in as recorded fact. v2 blocks must
// carry the wire's recorded values.
// ---------------------------------------------------------------------------

test("v1 views null every never-recorded block, on singles and comparisons", () => {
  const single = viewFromV1Report(makeScanReportV1());
  const run = single.runs[0];
  assert.equal(run.phases, null);
  assert.equal(run.countsByPhase, null);
  assert.equal(run.detectors, null);
  assert.equal(run.fingerprints, null);
  assert.equal(run.provenance, null);
  assert.equal(run.redactionVersion, null);
  assert.equal(run.toolchainIdentity, null);
  assert.equal(run.verificationFacts, null);
  assert.equal(run.evidence.cookieMutations, null);
  assert.equal(run.evidence.storageMutations, null);
  assert.equal(run.quality.facts, null);

  const v1Single = makeScanReportV1() as ScanResult;
  const comparison = viewFromV1Report(createGpcComparisonReport(structuredClone(v1Single), structuredClone(v1Single)));
  assert.equal(comparison.comparison?.verification, null);
  assert.equal(comparison.comparison?.order, null);
  assert.equal(comparison.comparison?.evidenceStrength, null);
  assert.equal(comparison.comparison?.supportingPairs, null);
  for (const arm of comparison.runs) {
    assert.equal(arm.phases, null);
    assert.equal(arm.verificationFacts, null);
  }
});

test("methodology views expose only the Playwright version recorded by the report", () => {
  const v1 = makeScanReportV1() as ScanResult;
  v1.conditions.scannerDisclosure =
    `Automated Chromium scan using Playwright ${NODE_PLAYWRIGHT_VERSION} under methodology ` +
    `${NODE_SCANNER_METHODOLOGY_VERSION}.`;
  assert.equal(viewFromV1Report(v1).runs[0].conditions.playwrightVersion, NODE_PLAYWRIGHT_VERSION);

  const oldV1 = makeScanReportV1() as ScanResult;
  oldV1.conditions.scannerDisclosure = "Automated Chromium scan with browser 149.0.7827.55.";
  assert.equal(viewFromV1Report(oldV1).runs[0].conditions.playwrightVersion, null);

  const v2 = makePublicSingleReportV2R2();
  v2.run.provenance.methodologyVersion = `${NODE_SCANNER_METHODOLOGY_VERSION}+test-kernel-v1`;
  assert.equal(viewFromV2(v2, 2).runs[0].conditions.playwrightVersion, NODE_PLAYWRIGHT_VERSION);

  const unrecordedV2 = makePublicSingleReportV2();
  assert.equal(viewFromV2(unrecordedV2, 1).runs[0].conditions.playwrightVersion, null);
});

test("v2 run views carry the recorded phases, ledgers, identity, and quality facts", () => {
  const report = makePublicSingleReportV2();
  const view = viewFromV2(report, 1);
  const run = view.runs[0];
  assert.equal(run.redactionVersion, report.run.privacy.redactionVersion);
  const wire = report.run;

  assert.deepEqual(run.phases, wire.phases);
  assert.deepEqual(run.countsByPhase, wire.summary.countsByPhase);
  assert.deepEqual(run.fingerprints, wire.fingerprints);
  assert.deepEqual(run.evidence.cookieMutations, wire.evidence.cookieMutations);
  assert.deepEqual(run.evidence.storageMutations, wire.evidence.storageMutations);

  // Detector ledger, normalized: optional reason/phaseId become explicit nulls.
  assert.notEqual(run.detectors, null);
  for (const [id, entry] of Object.entries(wire.detectors)) {
    const viewEntry = run.detectors?.[id];
    assert.equal(viewEntry?.version, entry.version, id);
    assert.equal(viewEntry?.status, entry.status, id);
    assert.equal(viewEntry?.reason, entry.reason ?? null, id);
    assert.equal(viewEntry?.phaseId, entry.phaseId ?? null, id);
  }

  // Measurement identity and instrument digests.
  assert.deepEqual(run.provenance, {
    observer: wire.provenance.observer,
    acquisition: wire.provenance.acquisition,
    buildCommit: wire.provenance.buildCommit,
    methodologyVersion: wire.provenance.methodologyVersion,
    detectorRegistry: wire.provenance.detectorRegistry,
    sourceArtifactDigest: wire.provenance.sourceArtifactDigest ?? null
  });
  assert.deepEqual(run.toolchainIdentity, {
    trackerCatalogDigest: wire.toolchain.trackerCatalog.digest,
    adblock: wire.toolchain.adblock
      ? { manifestDigest: wire.toolchain.adblock.manifestDigest, engineVersion: wire.toolchain.adblock.engineVersion }
      : null,
    normalizationVersion: wire.toolchain.normalizationVersion
  });

  // Recorded quality facts (capture loss, budgets, settlement).
  assert.deepEqual(run.quality.facts, {
    botWallTitleMatched: wire.qualityFacts.botWallTitleMatched,
    navigationSettled: wire.qualityFacts.navigationSettled,
    budgetsExhausted: wire.qualityFacts.budgetsExhausted,
    captureLoss: wire.qualityFacts.captureLoss
  });

  // r1 runs never recorded axis readbacks.
  assert.equal(run.verificationFacts, null);
});

test("v2 intervention comparisons expose configured-vs-verified experiment metadata", () => {
  const report = makeInterventionComparisonReportV2();
  const view = viewFromV2(report, 1);
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") return;

  assert.deepEqual(view.comparison?.verification, report.experiment.verification);
  assert.equal(view.comparison?.order, report.experiment.order);
  assert.equal(view.comparison?.evidenceStrength, report.experiment.evidence.strength);
  // r1 interventions cannot carry replication pairs.
  assert.equal(view.comparison?.supportingPairs, null);

  // Non-intervention designs never carry the block.
  const temporal = viewFromV2(makeTemporalComparisonReportV2(), 1);
  assert.equal(temporal.comparison?.verification, null);
  assert.equal(temporal.comparison?.order, null);
  assert.equal(temporal.comparison?.evidenceStrength, null);
  assert.equal(temporal.comparison?.supportingPairs, null);
});

test("r2 views surface the recorded axis readbacks and replication-pair count", () => {
  // GPC readback facts flow through when the r2 run recorded them.
  const gpc = makeGpcInterventionReportV2R2();
  const gpcView = viewFromV2(gpc, 2);
  for (const [index, wireRun] of [gpc.baseline, gpc.variant].entries()) {
    const viewRun = gpcView.runs[index];
    if (wireRun.verificationFacts) {
      assert.deepEqual(viewRun.verificationFacts, {
        gpc: wireRun.verificationFacts.gpc ?? null,
        shields: wireRun.verificationFacts.shields ?? null
      });
    } else {
      assert.equal(viewRun.verificationFacts, null);
    }
  }

  const shields = makeShieldsInterventionReportV2R2();
  const shieldsView = viewFromV2(shields, 2);
  const shieldsFacts = [shields.baseline, shields.variant].map((run) => run.verificationFacts?.shields ?? null);
  assert.deepEqual(
    shieldsView.runs.map((run) => run.verificationFacts?.shields ?? null),
    shieldsFacts
  );

  // Replication pairs: counted when recorded, null when the wire has none.
  const supported = makeSupportingPairInterventionReportV2R2();
  const supportedView = viewFromV2(supported, 2);
  const wirePairs =
    supported.experiment.kind === "intervention" && "supportingPairs" in supported.experiment
      ? supported.experiment.supportingPairs?.length ?? null
      : null;
  assert.equal(supportedView.comparison?.supportingPairs, wirePairs);
  assert.notEqual(supportedView.comparison?.supportingPairs, null);

  const temporalR2 = viewFromV2(makeTemporalReportV2R2(), 2);
  assert.equal(temporalR2.comparison?.supportingPairs, null);

  // A single r2 report's run still nulls the wrapper when nothing was recorded.
  const single = makePublicSingleReportV2R2();
  const singleView = viewFromV2(single, 2);
  if (!single.run.verificationFacts) {
    assert.equal(singleView.runs[0].verificationFacts, null);
  }
});

// ---------------------------------------------------------------------------
// One producer warning, two readers. The scanner's request-family capture-loss
// warnings are recognized in two independent places: comparison-eligibility's
// fragment predicates, and runViewFromV1's derived quality reasons. Both halves
// pass their own tests while disagreeing, which is exactly how a degraded visit
// shipped as "complete": the v2 kernel censored the requests family and the v1
// wire did not. This table is the shared contract; a new producer warning that
// is not taught to both halves fails here.
// ---------------------------------------------------------------------------

const REQUEST_EVIDENCE_LOSS_WARNINGS: { name: string; warning: string }[] = [
  { name: "GPC_WORKER_CAPTURE_LOSS_WARNING", warning: GPC_WORKER_CAPTURE_LOSS_WARNING },
  { name: "INVALID_UPSTREAM_RESPONSE_WARNING", warning: INVALID_UPSTREAM_RESPONSE_WARNING },
  { name: "UNSETTLED_ROUTED_REQUEST_WARNING", warning: UNSETTLED_ROUTED_REQUEST_WARNING }
];

test("every producer request-loss warning censors the requests family on both halves", () => {
  for (const { name, warning } of REQUEST_EVIDENCE_LOSS_WARNINGS) {
    const report = makeScanReportV1();
    report.warnings = [warning];

    // Half one: the eligibility predicate the corpus and export paths read.
    assert.equal(runRequestEvidenceCapped(report as unknown as ScanResult), true, name);

    // Half two: the rendered view. A run whose warning says its request
    // evidence is incomplete may never render as complete, and may never be
    // ranked against a corpus percentile.
    const run = viewFromV1Report(report).runs[0];
    assert.equal(familyCensoredOnRun(run, "requests"), true, name);
    assert.notEqual(requestEvidenceState(run), "complete", name);

    // Scoped, not global: a lost request log says nothing about cookies or
    // storage, so a `budget-exhausted:` slug here would over-censor the run.
    assert.equal(familyCensoredOnRun(run, "cookies"), false, name);
    assert.equal(familyCensoredOnRun(run, "storage"), false, name);
  }
});

test("an unsettled routed request is a capture loss, never the recording cap", () => {
  const report = makeScanReportV1();
  report.warnings = [UNSETTLED_ROUTED_REQUEST_WARNING];
  const run = viewFromV1Report(report).runs[0];

  // "capped" names the 1,000-request budget and tells the reader its size. A
  // deadline that arrived mid-flight truncated the log by a clock instead, so
  // the honest state is "incomplete".
  assert.equal(runHitRequestRecordingCap(run), false);
  assert.equal(requestEvidenceState(run), "incomplete");
  assert.ok(run.quality.reasons.includes("capture-loss:unsettled-routed-requests"));
});

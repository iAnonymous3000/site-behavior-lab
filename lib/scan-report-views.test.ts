import assert from "node:assert/strict";
import { test } from "node:test";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { createGpcComparisonReport } from "./compare-reports";
import { shieldsRunMeasurement } from "./report-insights";
import { readStoredScanReport } from "./scan-report-reader";
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
  LEGACY_CONSENT_INTERACTION_LEFT_SUBJECT_REASON,
  LEGACY_KEYSTROKE_PROBE_NAVIGATION_STOPPED_REASON,
  LEGACY_KEYSTROKE_PROBE_REQUESTS_OMITTED_REASON,
  LEGACY_KEYSTROKE_PROBE_REQUEST_UNREAD_REASON,
  LEGACY_KEYSTROKE_PROBE_SUBJECT_LOST_REASON,
  LEGACY_KEYSTROKE_PROBE_TEST_INCOMPLETE_REASON,
  LEGACY_LISTENER_DETECTION_WITHHELD_REASON,
  requestEvidenceState,
  runHitRequestRecordingCap,
  runInCorpusDistributionPopulation,
  viewFromV1Report,
  viewFromV2
} from "./scan-report-views";
import { degradedRunNotice, runCensorshipNotes } from "./scan-report-censorship";
import { evaluateQuality } from "./scan-report-v2-evaluators";
import {
  runConsentInteractionLeftSubject,
  runHitFingerprintListenerAttributionLoss,
  runHitFingerprintObserverCaptureLoss,
  runHitKeystrokeProbeCaptureLoss,
  runHitKeystrokeProbeNavigationStopped,
  runHitKeystrokeProbeRequestsOmitted,
  runHitKeystrokeProbeRequestUnread,
  runHitKeystrokeProbeTestIncomplete,
  runHitListenerDetectionWithheld,
  runHitUnsettledRoutedRequests,
  runKeystrokeProbeLeftSubject,
  runRequestEvidenceCapped
} from "./comparison-eligibility";
import { CONSENT_INTERACTION_LEFT_SUBJECT_WARNING } from "./consent-subject-loss-warning";
import { ACTIVE_PROBE_SUBJECT_WARNING, CONSENT_RELOAD_SUBJECT_WARNING } from "./active-probe-subject-warnings";
import { createCorpusStatsAccumulator } from "./corpus-stats-builder";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { buildReportFacts } from "./report-facts";
import { buildReportHeadline } from "./report-headline";
import { redactScanResultV1 } from "./redact-scan-report-v1";
import {
  FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING,
  KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING,
  KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING,
  LISTENER_DETECTION_WITHHELD_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING
} from "./scan-runtime";
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
// Configured is not measured. A v2 run without a shields readback carries one
// piece of engine evidence, its toolchain: a run that pinned no filter lists
// never loaded an engine. Deriving "the engine was active" from the REQUESTED
// mode manufactures an absence claim ("no requests matched the filter lists")
// out of a measurement that never ran.
// ---------------------------------------------------------------------------

test("a v2 run that pinned no filter lists never reads as an active engine", () => {
  // Control: the engine facts are recorded, so the classification run reads as
  // active and its zero is a real, published filter-match measurement.
  const loaded = makePublicSingleReportV2();
  loaded.run.summary = { ...loaded.run.summary, counts: { ...loaded.run.summary.counts, shieldsBlockedRequests: 0 } };
  assert.notEqual(loaded.run.toolchain.adblock, null);
  const loadedRun = viewFromV2(loaded, 1).runs[0];
  assert.equal(loadedRun.conditions.adblockActive, true);
  assert.deepEqual(shieldsRunMeasurement(loadedRun), { kind: "filter-matches", count: 0, origin: "legacy-derived", evaluated: null });

  // Same wire, same requested condition, engine never loaded.
  const neverLoaded = makePublicSingleReportV2();
  neverLoaded.run.summary = {
    ...neverLoaded.run.summary,
    counts: { ...neverLoaded.run.summary.counts, shieldsBlockedRequests: 0 }
  };
  neverLoaded.run.toolchain = { ...neverLoaded.run.toolchain, adblock: null };
  const neverLoadedRun = viewFromV2(neverLoaded, 1).runs[0];
  assert.equal(neverLoadedRun.conditions.shieldsMode, "classification");
  assert.equal(neverLoadedRun.conditions.adblockLists, null);
  assert.equal(neverLoadedRun.conditions.adblockActive, false);
  // The reader consequence: nothing was classified, so there is no Shields
  // measurement to publish and no reassuring "matched zero" card.
  assert.equal(shieldsRunMeasurement(neverLoadedRun), null);

  // An r2 readback still outranks the toolchain in both directions.
  const readback = makeShieldsInterventionReportV2R2();
  const readbackFacts = readback.variant.verificationFacts?.shields;
  if (!readbackFacts) assert.fail("expected recorded shields facts on the r2 fixture");
  readback.variant.toolchain = { ...readback.variant.toolchain, adblock: null };
  assert.equal(viewFromV2(readback, 2).runs[1].conditions.adblockActive, readbackFacts.engineLoaded);
});

// ---------------------------------------------------------------------------
// One "newest contributing run" contract, two derivations. The view's
// sort/retention clock and the provenance sidecar's createdAt must agree, or a
// report is pruned before the timestamp its own sidecar records and the page
// prints a "latest visit" that is not the latest visit.
// ---------------------------------------------------------------------------

test("the view's sort clock covers every embedded run, supporting pairs included", () => {
  const report = makeSupportingPairInterventionReportV2R2();
  const supportingPairs =
    report.experiment.kind === "intervention" && "supportingPairs" in report.experiment
      ? report.experiment.supportingPairs ?? []
      : [];
  assert.notEqual(supportingPairs.length, 0);

  const embedded = [
    report.baseline,
    report.variant,
    ...supportingPairs.flatMap((pair) => [pair.baseline, pair.variant])
  ].map((run) => run.startedAt);
  const newest = embedded.reduce((latest, startedAt) => (Date.parse(startedAt) > Date.parse(latest) ? startedAt : latest));
  // The fixture's supporting pair ran after both primary arms, so the primary
  // arms alone are demonstrably the wrong clock.
  assert.equal([report.baseline.startedAt, report.variant.startedAt].includes(newest), false);

  const view = viewFromV2(report, 2);
  assert.equal(view.latestRunAt, newest);
  // Rendering is untouched: the view still shows the two primary arms.
  assert.equal(view.runs.length, 2);

  // The sidecar clock walks the same runs; the two derivations must not drift.
  const stored = readStoredScanReport(report);
  if (!stored.ok) assert.fail(`fixture should be readable (${stored.error})`);
  assert.equal(view.latestRunAt, committedReportCreatedAt(stored.stored));
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
  { name: "UNSETTLED_ROUTED_REQUEST_WARNING", warning: UNSETTLED_ROUTED_REQUEST_WARNING },
  { name: "KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING", warning: KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING }
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

test("an incomplete v1 pixel-body read censors detector output only", () => {
  const report = makeScanReportV1();
  report.warnings = [PIXEL_DECODE_CAPTURE_LOSS_WARNING];
  const run = viewFromV1Report(report).runs[0];

  assert.ok(run.quality.reasons.includes("capture-loss:pixel-decode"));
  assert.equal(familyCensoredOnRun(run, "detector-output"), true);
  assert.equal(familyCensoredOnRun(run, "requests"), false);
  assert.equal(familyCensoredOnRun(run, "cookies"), false);
  assert.equal(familyCensoredOnRun(run, "storage"), false);
  assert.equal(familyCensoredOnRun(run, "fingerprinting"), false);
});

test("a v1 listener-attribution line censors fingerprinting exactly as the unreadable-frame line", () => {
  // fingerprint-observer@4 reads a frame whose listener attribution was
  // bounded, so the frame line would be false there and the scanner writes the
  // listener line instead. Both must leave the same benchmark gate and the
  // same corpus population. Each variant runs through the real view, facts
  // and corpus accumulator, never a hand-built view.
  assert.equal(runHitFingerprintObserverCaptureLoss({ warnings: [FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING] }), false);
  assert.equal(runHitFingerprintListenerAttributionLoss({ warnings: [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING] }), false);
  assert.equal(runHitFingerprintListenerAttributionLoss({ warnings: [FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING] }), true);

  const outcome = (warnings: string[]) => {
    const report = makeScanReportV1() as ScanResult;
    report.summary.firstPartyDomain = "listener-fixture.net";
    report.conditions.requestedUrl = "https://listener-fixture.net/";
    report.conditions.finalUrl = "https://listener-fixture.net/";
    report.summary.totalRequests = 12;
    report.summary.thirdPartyRequests = 5;
    report.summary.fingerprintEvents = 4;
    report.fingerprintEvents = [{ api: "canvas.toDataURL", count: 4 }];
    report.warnings = warnings;
    const view = viewFromV1Report(report);
    const run = view.runs[0];
    const facts = buildReportFacts(view).display;
    const corpus = createCorpusStatsAccumulator(new Date("2026-09-23T00:00:00.000Z"));
    corpus.add(`20260709-${"f".repeat(32)}`, view);
    return {
      run,
      reasons: run.quality.reasons,
      censored: ["requests", "cookies", "storage", "fingerprinting", "detector-output"].map((family) =>
        familyCensoredOnRun(run, family as Parameters<typeof familyCensoredOnRun>[1])
      ),
      claims: {
        fingerprint: facts.claims["fingerprint-apis"],
        listeners: facts.claims["session-recording-input-monitoring"],
        requests: facts.claims["third-party-services"]
      },
      cohorts: corpus.finish().cohorts
    };
  };
  const clean = outcome([]);
  const frame = outcome([FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING]);
  const listener = outcome([FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING]);

  assert.deepEqual(listener.reasons, ["capture-loss:fingerprint-observer"]);
  assert.deepEqual(listener.reasons, frame.reasons);
  assert.deepEqual(listener.censored, frame.censored);
  assert.deepEqual(listener.censored, [false, false, false, true, true]);
  assert.deepEqual(listener.claims, frame.claims);
  assert.equal(listener.claims.fingerprint.benchmarkAllowed, false);
  assert.deepEqual(listener.claims.fingerprint.blockers, ["family-censored"]);
  assert.equal(clean.claims.fingerprint.benchmarkAllowed, true);
  // The corpus: identical cohorts for both lines, the run still measured for
  // requests, and fingerprintEvents admitted only when neither line is present.
  assert.deepEqual(listener.cohorts, frame.cohorts);
  assert.equal(listener.cohorts.length, 1);
  assert.equal(listener.cohorts[0]?.metrics.thirdPartyRequests?.count, 1);
  assert.equal(listener.cohorts[0]?.metrics.fingerprintEvents, undefined);
  assert.equal(clean.cohorts[0]?.metrics.fingerprintEvents?.count, 1);

  // Only the prose differs, and each says what its own line says.
  const frameNotes = runCensorshipNotes(frame.run).join(" ");
  const listenerNotes = runCensorshipNotes(listener.run).join(" ");
  assert.match(frameNotes, /could not read every frame/);
  assert.doesNotMatch(listenerNotes, /could not read every frame/);
  assert.match(listenerNotes, /could not attribute every event listener/);
  assert.doesNotMatch(listenerNotes, /capture-loss:/);
});

test("a v1 withheld listener detection censors the listener claim and nothing else", () => {
  // The line shares its tail with the listener-attribution line, so each
  // predicate must recognize only its own line.
  assert.equal(runHitListenerDetectionWithheld({ warnings: [LISTENER_DETECTION_WITHHELD_WARNING] }), true);
  assert.equal(runHitListenerDetectionWithheld({ warnings: [FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING] }), false);
  assert.equal(runHitListenerDetectionWithheld({ warnings: [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING] }), false);
  assert.equal(runHitFingerprintListenerAttributionLoss({ warnings: [LISTENER_DETECTION_WITHHELD_WARNING] }), false);
  assert.equal(runHitFingerprintObserverCaptureLoss({ warnings: [LISTENER_DETECTION_WITHHELD_WARNING] }), false);

  // Both runs go through the real sanitizer, view, facts and corpus
  // accumulator. The only difference is one listener detection whose script
  // origin (path-style S3) has no publishable registrable domain.
  const outcome = (withheld: boolean) => {
    const input = makeScanReportV1() as ScanResult;
    input.summary.firstPartyDomain = "listener-fixture.net";
    input.conditions.requestedUrl = "https://listener-fixture.net/";
    input.conditions.finalUrl = "https://listener-fixture.net/";
    input.summary.fingerprintEvents = 4;
    input.fingerprintEvents = [{ api: "canvas.toDataURL", count: 4 }];
    input.fingerprintDetections = withheld
      ? [
          {
            kind: "session-recording",
            heuristic: "interaction-listener-coverage-v1",
            count: 1,
            evidence: {
              eventTypes: ["mousemove", "click", "scroll"],
              listenerTargets: ["document"],
              thirdPartyOrigins: ["https://s3.us-east-1.amazonaws.com"],
              totalListenerCalls: 3
            }
          }
        ]
      : [];
    input.pixelEvents = [];
    input.cnameCloaks = [];
    const report = redactScanResultV1(input).report;
    const view = viewFromV1Report(report);
    const run = view.runs[0];
    const facts = buildReportFacts(view).display;
    const corpus = createCorpusStatsAccumulator(new Date("2026-09-24T00:00:00.000Z"));
    corpus.add(`20260709-${"f".repeat(32)}`, view);
    return {
      view,
      run,
      facts,
      censored: ["requests", "cookies", "storage", "fingerprinting", "detector-output"].map((family) =>
        familyCensoredOnRun(run, family as Parameters<typeof familyCensoredOnRun>[1])
      ),
      cohorts: corpus.finish().cohorts
    };
  };
  const clean = outcome(false);
  const withheld = outcome(true);

  assert.deepEqual(clean.run.quality.reasons, []);
  assert.deepEqual(withheld.run.quality.reasons, [LEGACY_LISTENER_DETECTION_WITHHELD_REASON]);
  assert.equal(withheld.run.quality.outcome, "complete");

  const listener = withheld.facts.claims["session-recording-input-monitoring"];
  assert.equal(clean.facts.claims["session-recording-input-monitoring"].allowed, true);
  assert.equal(listener.allowed, false);
  assert.deepEqual(listener.blockers, ["family-censored"]);
  // Every other claim, keystroke exfiltration included, reads as measured:
  // on v1 a keystroke recipient redacts to a host marker the guard accepts,
  // so this path never withholds a keystroke detection.
  for (const claim of Object.keys(clean.facts.claims) as (keyof typeof clean.facts.claims)[]) {
    if (claim === "session-recording-input-monitoring") continue;
    assert.deepEqual(withheld.facts.claims[claim], clean.facts.claims[claim], claim);
  }
  assert.deepEqual(withheld.facts.evidence, clean.facts.evidence);
  assert.deepEqual(withheld.censored, clean.censored);
  assert.deepEqual(withheld.censored, [false, false, false, false, false]);

  // The corpus population is unchanged: fingerprintEvents and request counts
  // still admit the run.
  assert.deepEqual(withheld.cohorts, clean.cohorts);
  assert.equal(withheld.cohorts[0]?.metrics.fingerprintEvents?.count, 1);
  assert.equal(withheld.cohorts[0]?.metrics.thirdPartyRequests?.count, 1);

  const notes = runCensorshipNotes(withheld.run).join(" ");
  assert.match(notes, /named a script origin with no publishable registrable domain/);
  assert.doesNotMatch(notes, /capture-loss:/);
  assert.equal(degradedRunNotice(clean.view), null);
  assert.notEqual(degradedRunNotice(withheld.view), null);
});

test("a v1 probe that stopped or could not read a request censors the keystroke claim and nothing else", () => {
  // Both probe lines open with the same words, so each predicate must
  // recognize only its own line; the incomplete-probe reason censors whole
  // families.
  assert.equal(runHitKeystrokeProbeRequestUnread({ warnings: [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING] }), true);
  assert.equal(runHitKeystrokeProbeRequestUnread({ warnings: [KEYSTROKE_PROBE_INCOMPLETE_WARNING] }), false);
  assert.equal(runHitKeystrokeProbeRequestUnread({ warnings: [LISTENER_DETECTION_WITHHELD_WARNING] }), false);
  assert.equal(runHitKeystrokeProbeCaptureLoss({ warnings: [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING] }), false);
  assert.equal(runHitListenerDetectionWithheld({ warnings: [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING] }), false);

  // Both runs go through the real sanitizer, view, facts and corpus
  // accumulator. The only difference is the scanner's line for a probe that
  // finished but stopped, or could not read, a request that may have carried
  // its test value; r2 leaves that probe's detector partial with scan-failed.
  const outcome = (unread: boolean, fingerprintEvents = 4) => {
    const input = makeScanReportV1() as ScanResult;
    input.summary.firstPartyDomain = "probe-fixture.net";
    input.conditions.requestedUrl = "https://probe-fixture.net/";
    input.conditions.finalUrl = "https://probe-fixture.net/";
    input.summary.fingerprintEvents = fingerprintEvents;
    input.fingerprintEvents = fingerprintEvents > 0 ? [{ api: "canvas.toDataURL", count: fingerprintEvents }] : [];
    input.fingerprintDetections = [];
    input.pixelEvents = [];
    input.cnameCloaks = [];
    input.warnings = unread ? [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING] : [];
    const report = redactScanResultV1(input).report;
    const view = viewFromV1Report(report);
    const run = view.runs[0];
    const facts = buildReportFacts(view).display;
    const corpus = createCorpusStatsAccumulator(new Date("2026-09-25T00:00:00.000Z"));
    corpus.add(`20260709-${"e".repeat(32)}`, view);
    return {
      report,
      view,
      run,
      facts,
      censored: ["requests", "cookies", "storage", "fingerprinting", "detector-output"].map((family) =>
        familyCensoredOnRun(run, family as Parameters<typeof familyCensoredOnRun>[1])
      ),
      cohorts: corpus.finish().cohorts
    };
  };
  const clean = outcome(false);
  const unread = outcome(true);

  assert.deepEqual(unread.report.warnings, [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING]);
  assert.deepEqual(clean.run.quality.reasons, []);
  assert.deepEqual(unread.run.quality.reasons, [LEGACY_KEYSTROKE_PROBE_REQUEST_UNREAD_REASON]);
  assert.equal(unread.run.quality.outcome, "complete");

  const keystroke = unread.facts.claims["keystroke-exfiltration"];
  assert.equal(clean.facts.claims["keystroke-exfiltration"].allowed, true);
  assert.equal(keystroke.allowed, false);
  assert.deepEqual(keystroke.blockers, ["family-censored"]);
  assert.equal(unread.facts.calmEligible, false);
  // Every other claim, the listener claim on the same family included, reads
  // as measured, and so does the request log.
  for (const claim of Object.keys(clean.facts.claims) as (keyof typeof clean.facts.claims)[]) {
    if (claim === "keystroke-exfiltration") continue;
    assert.deepEqual(unread.facts.claims[claim], clean.facts.claims[claim], claim);
  }
  assert.deepEqual(unread.facts.evidence, clean.facts.evidence);
  assert.deepEqual(unread.censored, clean.censored);
  assert.deepEqual(unread.censored, [false, false, false, false, false]);
  assert.equal(requestEvidenceState(unread.run), requestEvidenceState(clean.run));
  assert.equal(runRequestEvidenceCapped(unread.report), false);

  // The corpus population is unchanged: request counts and fingerprintEvents
  // still admit the run.
  assert.deepEqual(unread.cohorts, clean.cohorts);
  assert.equal(unread.cohorts[0]?.metrics.fingerprintEvents?.count, 1);
  assert.equal(unread.cohorts[0]?.metrics.thirdPartyRequests?.count, 1);

  const notes = runCensorshipNotes(unread.run).join(" ");
  assert.match(notes, /could not read in full, a request that may have carried its test value/);
  assert.doesNotMatch(notes, /capture-loss:/);
  assert.equal(degradedRunNotice(clean.view), null);
  assert.notEqual(degradedRunNotice(unread.view), null);
  // On a quiet visit the rendered headline names the unproven input check
  // instead of reading the visit as complete.
  const quiet = buildReportHeadline(outcome(true, 0).view);
  assert.match(quiet.subhead, /may have carried its test value/);
  assert.doesNotMatch(buildReportHeadline(outcome(false, 0).view).subhead, /test value/);
  // The probe finished, so the headline may not say a check did not finish,
  // and each sentence of the subhead opens as a sentence.
  assert.match(quiet.headline, /recorded no listed activity, but another check is incomplete\.$/);
  assert.doesNotMatch(quiet.headline, /did not finish/);
  assert.match(quiet.subhead, /^The request log recorded no cross-site hosts/);
  assert.match(quiet.subhead, /instrumented API events\. The synthetic form-input probe stopped/);
});

// The typed-field disclosure the input probe adds, in both admitted
// generations (lib/redact-scan-report-v1.ts). The probe writes the omitted form
// only when the page left the recorded site after it typed.
const REQUESTS_OMITTED_TAIL = "Requests from this incomplete probe were omitted from the recorded request log and counts.";
const typedFieldDisclosure = (tail: "retained" | "omitted", fields = 1) =>
  `This scan typed a synthetic test value into ${fields === 1 ? "1 form field" : `${fields} form fields`} with native form submission blocked. Focus, input and blur handlers may run and send requests. The value is synthetic and is not stored. ${
    tail === "retained"
      ? "Observed requests during typing and the following wait are included in the request log. Teardown-only transmissions are not measured."
      : REQUESTS_OMITTED_TAIL
  }`;
const HISTORICAL_TYPED_FIELD_DISCLOSURE =
  "This scan typed a synthetic test value into 2 form fields (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored.";
const HISTORICAL_RETAINED_TAIL =
  "Requests the page sent during and after this typing, including any unload beacons, are part of the recorded request log and counts.";

test("each probe and request-loss line is recognized by its own predicate alone", () => {
  // Every probe line opens with the same words and two share their tail with
  // the unsettled line, so a fragment that also matched a sibling would move
  // a line into the wrong scope: a claim-scoped line would censor the request
  // family, or the request-loss line would censor the keystroke claim.
  const lines: [string, string][] = [
    ["incomplete", KEYSTROKE_PROBE_INCOMPLETE_WARNING],
    ["unread", KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING],
    ["test", KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING],
    ["navigation", KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING],
    ["unsettled", UNSETTLED_ROUTED_REQUEST_WARNING],
    ["listener", LISTENER_DETECTION_WITHHELD_WARNING],
    ["consent-subject", CONSENT_INTERACTION_LEFT_SUBJECT_WARNING],
    ["reload-subject", CONSENT_RELOAD_SUBJECT_WARNING],
    ["probe-subject", ACTIVE_PROBE_SUBJECT_WARNING],
    ["typed-retained", typedFieldDisclosure("retained")],
    ["typed-omitted", typedFieldDisclosure("omitted")],
    ["historical-typed", HISTORICAL_TYPED_FIELD_DISCLOSURE],
    ["historical-typed-retained", `${HISTORICAL_TYPED_FIELD_DISCLOSURE} ${HISTORICAL_RETAINED_TAIL}`],
    ["historical-typed-omitted", `${HISTORICAL_TYPED_FIELD_DISCLOSURE} ${REQUESTS_OMITTED_TAIL}`]
  ];
  const predicates: [string, (run: { warnings: string[] }) => boolean, string[]][] = [
    ["incomplete", runHitKeystrokeProbeCaptureLoss, ["incomplete"]],
    ["unread", runHitKeystrokeProbeRequestUnread, ["unread"]],
    ["test", runHitKeystrokeProbeTestIncomplete, ["test"]],
    ["navigation", runHitKeystrokeProbeNavigationStopped, ["navigation"]],
    ["unsettled", runHitUnsettledRoutedRequests, ["unsettled"]],
    ["listener", runHitListenerDetectionWithheld, ["listener"]],
    ["subject", runKeystrokeProbeLeftSubject, ["consent-subject", "reload-subject", "probe-subject"]],
    ["consent", runConsentInteractionLeftSubject, ["consent-subject"]],
    ["omitted", runHitKeystrokeProbeRequestsOmitted, ["typed-omitted", "historical-typed-omitted"]]
  ];
  for (const [predicateName, predicate, own] of predicates) {
    for (const [lineName, line] of lines) {
      assert.equal(predicate({ warnings: [line] }), own.includes(lineName), `${predicateName} on ${lineName}`);
    }
  }
});

test("every other v1 line for an incomplete input probe censors the keystroke claim and nothing else", () => {
  // r2 withholds the keystroke claim whenever its detector is not complete.
  // Besides the unread-request line, v1 records that with the line for a test
  // the probe did not complete and with the three lines for a page that was
  // off the recorded site when the probe was skipped or stopped. The consent
  // interaction's line also censors the four families r2 drops beside it, so
  // it has its own test below. Each run goes through the real sanitizer, view,
  // facts and corpus accumulator.
  const outcome = (warnings: string[], fingerprintEvents = 4) => {
    const input = makeScanReportV1() as ScanResult;
    input.summary.firstPartyDomain = "probe-fixture.net";
    input.conditions.requestedUrl = "https://probe-fixture.net/";
    input.conditions.finalUrl = "https://probe-fixture.net/";
    input.summary.fingerprintEvents = fingerprintEvents;
    input.fingerprintEvents = fingerprintEvents > 0 ? [{ api: "canvas.toDataURL", count: fingerprintEvents }] : [];
    input.fingerprintDetections = [];
    input.pixelEvents = [];
    input.cnameCloaks = [];
    input.warnings = warnings;
    const report = redactScanResultV1(input).report;
    const view = viewFromV1Report(report);
    const run = view.runs[0];
    const corpus = createCorpusStatsAccumulator(new Date("2026-09-25T00:00:00.000Z"));
    corpus.add(`20260709-${"e".repeat(32)}`, view);
    return {
      report,
      view,
      run,
      facts: buildReportFacts(view).display,
      censored: ["requests", "cookies", "storage", "fingerprinting", "detector-output"].map((family) =>
        familyCensoredOnRun(run, family as Parameters<typeof familyCensoredOnRun>[1])
      ),
      cohorts: corpus.finish().cohorts
    };
  };
  const clean = outcome([]);
  const cases: [string, string, RegExp][] = [
    [KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING, LEGACY_KEYSTROKE_PROBE_TEST_INCOMPLETE_REASON, /probe did not complete its test/],
    [CONSENT_RELOAD_SUBJECT_WARNING, LEGACY_KEYSTROKE_PROBE_SUBJECT_LOST_REASON, /off the recorded site before or during the synthetic form-input probe/],
    [ACTIVE_PROBE_SUBJECT_WARNING, LEGACY_KEYSTROKE_PROBE_SUBJECT_LOST_REASON, /off the recorded site before or during the synthetic form-input probe/]
  ];
  for (const [warning, reason, note] of cases) {
    const incomplete = outcome([warning]);
    assert.deepEqual(incomplete.report.warnings, [warning], warning);
    assert.deepEqual(incomplete.run.quality.reasons, [reason], warning);
    assert.equal(incomplete.run.quality.outcome, "complete", warning);

    const keystroke = incomplete.facts.claims["keystroke-exfiltration"];
    assert.equal(clean.facts.claims["keystroke-exfiltration"].allowed, true, warning);
    assert.equal(keystroke.allowed, false, warning);
    assert.deepEqual(keystroke.blockers, ["family-censored"], warning);
    assert.equal(incomplete.facts.calmEligible, false, warning);
    for (const claim of Object.keys(clean.facts.claims) as (keyof typeof clean.facts.claims)[]) {
      if (claim === "keystroke-exfiltration") continue;
      assert.deepEqual(incomplete.facts.claims[claim], clean.facts.claims[claim], `${warning} ${claim}`);
    }
    assert.deepEqual(incomplete.facts.evidence, clean.facts.evidence, warning);
    assert.deepEqual(incomplete.censored, [false, false, false, false, false], warning);
    assert.equal(runRequestEvidenceCapped(incomplete.report), false, warning);
    assert.deepEqual(incomplete.cohorts, clean.cohorts, warning);

    const notes = runCensorshipNotes(incomplete.run).join(" ");
    assert.match(notes, note, warning);
    assert.doesNotMatch(notes, /capture-loss:/, warning);
    assert.notEqual(degradedRunNotice(incomplete.view), null, warning);
    assert.match(buildReportHeadline(outcome([warning], 0).view).subhead, note, warning);
  }
});

test("a v1 probe-stopped navigation censors request evidence, not the keystroke claim", () => {
  // r2's page route records every navigation the probe stops as a dropped
  // requests-family loss, carrying the value or not: it censors the request
  // family, leaves the run out of the corpus distribution population and
  // withholds third-party services. The v1 line is read the same way, and the
  // keystroke claim stays with the probe's own lines.
  const outcome = (warnings: string[]) => {
    const input = makeScanReportV1() as ScanResult;
    input.summary.firstPartyDomain = "probe-fixture.net";
    input.conditions.requestedUrl = "https://probe-fixture.net/";
    input.conditions.finalUrl = "https://probe-fixture.net/";
    input.fingerprintDetections = [];
    input.pixelEvents = [];
    input.cnameCloaks = [];
    input.warnings = warnings;
    const report = redactScanResultV1(input).report;
    const view = viewFromV1Report(report);
    const corpus = createCorpusStatsAccumulator(new Date("2026-09-25T00:00:00.000Z"));
    corpus.add(`20260709-${"e".repeat(32)}`, view);
    return { report, view, run: view.runs[0], facts: buildReportFacts(view).display, cohorts: corpus.finish().cohorts };
  };
  const clean = outcome([]);
  const stopped = outcome([KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING]);

  assert.deepEqual(stopped.report.warnings, [KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING]);
  assert.deepEqual(stopped.run.quality.reasons, [LEGACY_KEYSTROKE_PROBE_NAVIGATION_STOPPED_REASON]);
  assert.equal(stopped.run.quality.outcome, "complete");
  assert.equal(runRequestEvidenceCapped(stopped.report), true);
  assert.equal(familyCensoredOnRun(stopped.run, "requests"), true);
  for (const family of ["cookies", "storage", "fingerprinting", "detector-output"] as const) {
    assert.equal(familyCensoredOnRun(stopped.run, family), false, family);
  }
  assert.equal(requestEvidenceState(stopped.run), "incomplete");
  assert.equal(runInCorpusDistributionPopulation(clean.run), true);
  assert.equal(runInCorpusDistributionPopulation(stopped.run), false);
  assert.equal(clean.cohorts[0]?.metrics.thirdPartyRequests?.count, 1);
  assert.equal(stopped.cohorts[0]?.metrics.thirdPartyRequests?.count ?? 0, 0);

  const services = stopped.facts.claims["third-party-services"];
  assert.equal(clean.facts.claims["third-party-services"].benchmarkAllowed, true);
  assert.equal(services.allowed, false);
  assert.deepEqual(services.blockers, ["family-censored"]);
  assert.equal(services.benchmarkAllowed, false);
  assert.deepEqual(stopped.facts.claims["keystroke-exfiltration"], clean.facts.claims["keystroke-exfiltration"]);

  const notes = runCensorshipNotes(stopped.run).join(" ");
  assert.match(notes, /stopped one or more navigations started while it ran, so the request evidence is incomplete/);
  assert.doesNotMatch(notes, /capture-loss:/);
});

test("a v1 typed-field disclosure that omitted the probe's requests censors request evidence", () => {
  // The probe writes this form of its disclosure only when the page left the
  // recorded site after it typed, and r2 records that probe as a dropped
  // requests-family loss. The v1 report said its own request log left the
  // probe's requests out while its reader called the log complete, kept the
  // run in the corpus population and benchmarked third-party services.
  const outcome = (warnings: string[]) => {
    const input = makeScanReportV1() as ScanResult;
    input.summary.firstPartyDomain = "probe-fixture.net";
    input.conditions.requestedUrl = "https://probe-fixture.net/";
    input.conditions.finalUrl = "https://probe-fixture.net/";
    input.fingerprintDetections = [];
    input.pixelEvents = [];
    input.cnameCloaks = [];
    input.warnings = warnings;
    const report = redactScanResultV1(input).report;
    const view = viewFromV1Report(report);
    const corpus = createCorpusStatsAccumulator(new Date("2026-09-25T00:00:00.000Z"));
    corpus.add(`20260709-${"e".repeat(32)}`, view);
    return { report, view, run: view.runs[0], facts: buildReportFacts(view).display, cohorts: corpus.finish().cohorts };
  };
  const clean = outcome([typedFieldDisclosure("retained", 2)]);
  assert.deepEqual(clean.run.quality.reasons, []);
  assert.equal(runRequestEvidenceCapped(clean.report), false);

  for (const disclosure of [typedFieldDisclosure("omitted", 2), `${HISTORICAL_TYPED_FIELD_DISCLOSURE} ${REQUESTS_OMITTED_TAIL}`]) {
    const omitted = outcome([disclosure]);
    assert.deepEqual(omitted.report.warnings, [disclosure]);
    assert.deepEqual(omitted.run.quality.reasons, [LEGACY_KEYSTROKE_PROBE_REQUESTS_OMITTED_REASON]);
    assert.equal(omitted.run.quality.outcome, "complete");
    assert.equal(runRequestEvidenceCapped(omitted.report), true);
    assert.equal(familyCensoredOnRun(omitted.run, "requests"), true);
    for (const family of ["cookies", "storage", "fingerprinting", "detector-output"] as const) {
      assert.equal(familyCensoredOnRun(omitted.run, family), false, family);
    }
    assert.equal(requestEvidenceState(omitted.run), "incomplete");
    assert.equal(runInCorpusDistributionPopulation(clean.run), true);
    assert.equal(runInCorpusDistributionPopulation(omitted.run), false);
    assert.equal(clean.cohorts[0]?.metrics.thirdPartyRequests?.count, 1);
    assert.equal(omitted.cohorts[0]?.metrics.thirdPartyRequests?.count ?? 0, 0);

    const services = omitted.facts.claims["third-party-services"];
    assert.equal(clean.facts.claims["third-party-services"].benchmarkAllowed, true);
    assert.equal(services.allowed, false);
    assert.deepEqual(services.blockers, ["family-censored"]);
    assert.equal(services.benchmarkAllowed, false);
    // The subject line beside it on the wire carries the keystroke claim.
    assert.deepEqual(omitted.facts.claims["keystroke-exfiltration"], clean.facts.claims["keystroke-exfiltration"]);
    assert.deepEqual(omitted.facts.claims["fingerprint-apis"], clean.facts.claims["fingerprint-apis"]);

    const notes = runCensorshipNotes(omitted.run).join(" ");
    assert.match(notes, /omitted from the recorded request log and counts, so the request evidence is incomplete/);
    assert.doesNotMatch(notes, /capture-loss:/);
  }
});

test("a v1 consent interaction that left the site censors the four families r2 drops beside it", () => {
  // The producer adds the line only where r2 records dropped request, cookie,
  // storage and fingerprinting losses and ends the fingerprint detector
  // partial, and the line says later page state was not used. v1 readers read
  // all four as complete and allowed every claim on them.
  const outcome = (warnings: string[]) => {
    const input = makeScanReportV1() as ScanResult;
    input.summary.firstPartyDomain = "probe-fixture.net";
    input.conditions.requestedUrl = "https://probe-fixture.net/";
    input.conditions.finalUrl = "https://probe-fixture.net/";
    input.summary.fingerprintEvents = 4;
    input.fingerprintEvents = [{ api: "canvas.toDataURL", count: 4 }];
    input.fingerprintDetections = [];
    input.pixelEvents = [];
    input.cnameCloaks = [];
    input.warnings = warnings;
    const report = redactScanResultV1(input).report;
    const view = viewFromV1Report(report);
    return { report, view, run: view.runs[0], facts: buildReportFacts(view).display };
  };
  const clean = outcome([]);
  const left = outcome([CONSENT_INTERACTION_LEFT_SUBJECT_WARNING]);

  assert.deepEqual(left.run.quality.reasons, [
    LEGACY_CONSENT_INTERACTION_LEFT_SUBJECT_REASON,
    LEGACY_KEYSTROKE_PROBE_SUBJECT_LOST_REASON
  ]);
  assert.equal(left.run.quality.outcome, "complete");
  assert.equal(runRequestEvidenceCapped(left.report), true);
  for (const family of ["requests", "cookies", "storage", "fingerprinting"] as const) {
    assert.equal(familyCensoredOnRun(left.run, family), true, family);
    assert.equal(left.facts.evidence[family].state, "censored", family);
  }
  // r2 scopes its detector-output losses here to the consent, keystroke and
  // policy claims; the family itself stays as measured on v1.
  assert.equal(familyCensoredOnRun(left.run, "detector-output"), false);
  assert.equal(requestEvidenceState(left.run), "incomplete");
  assert.equal(runInCorpusDistributionPopulation(left.run), false);

  const withheld = [
    "third-party-services",
    "named-platforms",
    "ga-remarketing",
    "third-party-cookies",
    "fingerprint-apis",
    "session-recording-input-monitoring",
    "keystroke-exfiltration",
    "storage-keys",
    "shields-blocked"
  ] as const;
  for (const claim of withheld) {
    assert.equal(clean.facts.claims[claim].allowed, true, claim);
    assert.equal(left.facts.claims[claim].allowed, false, claim);
    assert.deepEqual(left.facts.claims[claim].blockers, ["family-censored"], claim);
  }
  assert.deepEqual(left.facts.claims["cname-cloaking"], clean.facts.claims["cname-cloaking"]);

  const notes = runCensorshipNotes(left.run).join(" ");
  assert.match(notes, /consent interaction left the recorded site, so the request, cookie, storage and fingerprinting evidence stops before the choice/);
  assert.match(notes, /off the recorded site before or during the synthetic form-input probe/);
  assert.doesNotMatch(notes, /capture-loss:/);
});

test("a timed-out v1 synthetic-input probe censors detector and request evidence", () => {
  const report = makeScanReportV1();
  report.warnings = [KEYSTROKE_PROBE_INCOMPLETE_WARNING];
  const run = viewFromV1Report(report).runs[0];

  assert.ok(run.quality.reasons.includes("capture-loss:keystroke-probe"));
  assert.equal(familyCensoredOnRun(run, "detector-output"), true);
  assert.equal(familyCensoredOnRun(run, "requests"), true);
  assert.equal(familyCensoredOnRun(run, "cookies"), false);
  assert.equal(requestEvidenceState(run), "incomplete");
});

test("an r2 listener-attribution loss is named as that loss, not as an observer that did not finish", () => {
  // fingerprint-observer@4 records an unreadable frame and a read frame with
  // bounded listener attribution under the same capture-loss detail. Only the
  // run's warning tells them apart, as it does on the v1 path.
  const render = (warnings: string[]) => {
    const report = makePublicSingleReportV2R2();
    report.run.warnings.push(...warnings);
    report.run.qualityFacts.captureLoss = [
      { family: "fingerprinting", phaseId: 0, kind: "dropped", count: 1, detail: "fingerprint-observer" }
    ];
    report.run.quality = evaluateQuality(report.run.qualityFacts, {
      observedRequests: report.run.summary.counts.totalRequests
    });
    const view = viewFromV2(report, 2);
    assert.equal(familyCensoredOnRun(view.runs[0], "fingerprinting"), true);
    return {
      notes: runCensorshipNotes(view.runs[0]).filter((note) => note.startsWith("fingerprinting evidence")),
      notice: degradedRunNotice(view) ?? ""
    };
  };

  const listener = render([FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING]);
  assert.equal(listener.notes.length, 1);
  assert.match(
    listener.notes[0],
    /the in-page fingerprint observer could not attribute every event listener to the script that registered it \(recorded loss count: 1\)$/
  );
  for (const text of [...listener.notes, listener.notice]) {
    assert.doesNotMatch(text, /did not finish|could not read/);
  }
  assert.match(listener.notice, /could not attribute every event listener/);

  // An unreadable frame, alone or beside the listener line, keeps the
  // observer sentence: the frame line already covers a bounded listener.
  for (const warnings of [
    [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING],
    [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING, FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING]
  ]) {
    const frame = render(warnings);
    assert.equal(frame.notes.length, 1);
    assert.match(frame.notes[0], /the in-page fingerprint observer did not finish \(recorded loss count: 1\)$/);
    assert.doesNotMatch(frame.notes[0], /attribute every event listener/);
    assert.doesNotMatch(frame.notice, /attribute every event listener/);
  }
});

test("historical response-byte loss names the ceiling and counts streams, never missing requests", () => {
  const report = makePublicSingleReportV2R2();
  report.run.summary.counts.totalRequests = 164;
  report.run.warnings.push(
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget."
  );
  report.run.qualityFacts.budgetsExhausted = ["request-capture"];
  report.run.qualityFacts.captureLoss = [
    { family: "requests", phaseId: null, kind: "cap", count: 74, detail: "request-capture" },
    { family: "detector-output", phaseId: 2, kind: "dropped", count: 1, detail: "policy-visit" }
  ];
  report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: 164 });

  const notes = runCensorshipNotes(viewFromV2(report, 2).runs[0]);
  assert.ok(notes.includes("the visit exhausted its 64 MiB aggregate response-byte budget"));
  assert.ok(
    notes.some((note) =>
      note.includes(
        "74 response streams or proxy tunnels were truncated or refused at or after the 64 MiB aggregate response-byte ceiling"
      )
    )
  );
  assert.ok(notes.some((note) => note.includes("1 privacy-policy visit did not produce usable evidence")));
  assert.equal(notes.some((note) => /74 (?:further |missing )?requests/.test(note)), false);
  assert.equal(notes.some((note) => /capture-loss:|request-capture/.test(note)), false);
});

test("a merged historical byte-and-count loss never invents a partition for its count", () => {
  const report = makePublicSingleReportV2R2();
  report.run.summary.counts.totalRequests = 1_000;
  report.run.warnings.push(
    "The scan stopped recording or loading additional requests after 1000 requests.",
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget."
  );
  report.run.qualityFacts.budgetsExhausted = ["request-capture"];
  report.run.qualityFacts.captureLoss = [
    { family: "requests", phaseId: null, kind: "cap", count: 91, detail: "request-capture" }
  ];
  report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: 1_000 });

  const notes = runCensorshipNotes(viewFromV2(report, 2).runs[0]);
  assert.ok(notes.includes("the visit exhausted both its request-count and aggregate response-byte budgets"));
  assert.ok(notes.some((note) => note.includes("combined recorded loss count: 91")));
  assert.ok(notes.some((note) => note.includes("cannot be partitioned between the two ceilings")));
  assert.equal(notes.some((note) => /91 (?:requests|response streams|proxy tunnels)/.test(note)), false);
});

test("a split byte-and-count loss renders both independent counts without historical merged copy", () => {
  const report = makePublicSingleReportV2R2();
  report.run.summary.counts.totalRequests = 1_000;
  report.run.warnings.push(
    "The scan stopped recording or loading additional requests after 1000 requests.",
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget."
  );
  report.run.qualityFacts.budgetsExhausted = ["request-capture", "response-bytes"];
  report.run.qualityFacts.captureLoss = [
    { family: "requests", phaseId: null, kind: "cap", count: 91, detail: "request-capture" },
    { family: "requests", phaseId: null, kind: "cap", count: 74, detail: "response-bytes" }
  ];
  report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: 1_000 });

  const notes = runCensorshipNotes(viewFromV2(report, 2).runs[0]);
  assert.ok(notes.includes("the visit exhausted its 1,000-request routing and recording budget"));
  assert.ok(notes.includes("the visit exhausted its 64 MiB aggregate response-byte budget"));
  assert.ok(notes.some((note) => note.includes("91 request routing or recording events were cut off")));
  assert.ok(notes.some((note) => note.includes("74 response streams or proxy tunnels were truncated or refused")));
  assert.equal(notes.some((note) => note.includes("both its request-count and aggregate response-byte budgets")), false);
  assert.equal(notes.some((note) => /combined|cannot be partitioned/.test(note)), false);
});

test("a historical request cap is read from its warning instead of today's live limit", () => {
  const report = makePublicSingleReportV2R2();
  report.run.summary.counts.totalRequests = 750;
  report.run.warnings.push("The scan stopped recording or loading additional requests after 750 requests.");
  report.run.qualityFacts.budgetsExhausted = ["request-capture"];
  report.run.qualityFacts.captureLoss = [
    { family: "requests", phaseId: null, kind: "cap", count: 3, detail: "request-capture" }
  ];
  report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: 750 });

  const notes = runCensorshipNotes(viewFromV2(report, 2).runs[0]);
  assert.ok(notes.includes("the visit exhausted its 750-request routing and recording budget"));
  assert.equal(notes.some((note) => note.includes("1,000-request")), false);
});

test("an open-schema capture-loss detail gets generic copy without leaking its token", () => {
  const report = makePublicSingleReportV2R2();
  report.run.qualityFacts.captureLoss = [
    { family: "requests", phaseId: 0, kind: "dropped", count: 7, detail: "future-producer-token" }
  ];
  report.run.quality = evaluateQuality(report.run.qualityFacts, { observedRequests: 1 });

  const notes = runCensorshipNotes(viewFromV2(report, 2).runs[0]);
  assert.ok(notes.some((note) => note.includes("producer recorded an additional collection loss")));
  assert.ok(notes.some((note) => note.includes("recorded loss count: 7")));
  assert.equal(notes.some((note) => note.includes("future-producer-token")), false);
  assert.equal(notes.some((note) => note.includes("capture-loss:")), false);
});

test("an open-schema budget reason gets generic copy without leaking its token", () => {
  const report = makePublicSingleReportV2R2();
  report.run.quality.run.reasons = ["budget-exhausted:future-producer-token"];

  const notes = runCensorshipNotes(viewFromV2(report, 2).runs[0]);
  assert.ok(notes.includes("the visit exhausted a producer-defined collection budget"));
  assert.equal(notes.some((note) => note.includes("future-producer-token")), false);
  assert.equal(notes.some((note) => note.includes("budget-exhausted:")), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeDetectorCalibrationStudy,
  currentDetectorCalibrationReleaseIdentity,
  detectorCalibrationImplementationDigest,
  detectorCalibrationMeasurementCondition,
  detectorCalibrationReadiness,
  detectorCalibrationRuntimeDigest,
  detectorCalibrationStudyIssues,
  DETECTOR_CALIBRATION_ANALYSIS_VERSION,
  type DetectorCalibrationAnalysisContext,
  type DetectorCalibrationCaseV3,
  type DetectorCalibrationRuntimeIdentity,
  type DetectorCalibrationStudyV3
} from "./detector-calibration";
import { NODE_PLAYWRIGHT_VERSION } from "./legacy-methodology";
import { sha256Hex } from "./sha256";

const BUILD_COMMIT = "a".repeat(40);
const EXPECTED_RUNTIME = runtimeIdentity();
const ANALYSIS_CONTEXT: DetectorCalibrationAnalysisContext = {
  expectedBuildCommit: BUILD_COMMIT,
  expectedRuntimeDigest: EXPECTED_RUNTIME.runtimeDigest
};

test("acceptance fixtures remain explicitly separate from calibration evidence", () => {
  assert.deepEqual(detectorCalibrationReadiness(), {
    status: "external-labeled-corpus-required",
    acceptanceFixtureCases: 20,
    acceptanceFixturesExcludedFromCalibration: true,
    calibrationStudies: 0,
    eligibleCalibrationStudies: 0,
    labeledCalibrationCases: 0,
    ineligibleStudyLabeledCases: 0,
    calibrationRateClaimsAvailable: false,
    studies: [],
    studySchema: "detector-calibration-study.v3",
    studySchemaPath: "/schemas/detector-calibration-study.v3.schema.json",
    releaseIdentityGate:
      "Eligibility requires the exact build commit, detector implementation and registry digests, methodology, normalization, tracker-catalog revision, Brave-list revision, and an independently pinned runtime-identity digest.",
    labelProvenanceGate:
      "Every complete case requires immutable prediction, evidence, and label artifacts plus at least two distinct labeler ids and an independent precommitted blind-tiebreaker identity.",
    evidenceGate:
      "A preselected, release-bound, independently labeled case corpus with a declared sampling frame, immutable artifacts, and complete planned denominator is still required."
  });
});

test("readiness derives from re-analysis: descriptive studies never clear the claim gate", () => {
  // Self-consistent study bound to a DIFFERENT build: exactly the committed
  // pilot's situation after any later commit to main.
  const ineligible = analyze((() => {
    const input = study("convenience");
    input.release = currentDetectorCalibrationReleaseIdentity(
      "fingerprint-heuristics",
      "b".repeat(40),
      runtimeIdentity()
    );
    return input;
  })());
  assert.equal(ineligible.status, "ineligible", ineligible.issues.join("; "));

  const staleOnly = detectorCalibrationReadiness([ineligible]);
  assert.equal(staleOnly.status, "committed-studies-ineligible");
  assert.equal(staleOnly.calibrationStudies, 1);
  assert.equal(staleOnly.eligibleCalibrationStudies, 0);
  assert.equal(staleOnly.labeledCalibrationCases, 0);
  assert.equal(staleOnly.ineligibleStudyLabeledCases, 4);
  assert.equal(staleOnly.calibrationRateClaimsAvailable, false);
  assert.equal(staleOnly.studies[0]?.ineligibilityReasons.includes("build-commit-mismatch"), true);

  const descriptive = analyze(study("convenience"));
  assert.equal(descriptive.status, "descriptive-only");
  const descriptiveOnly = detectorCalibrationReadiness([
    ineligible,
    descriptive
  ]);
  assert.equal(descriptiveOnly.status, "committed-studies-ineligible");
  assert.equal(descriptiveOnly.eligibleCalibrationStudies, 0);
  assert.equal(descriptiveOnly.labeledCalibrationCases, 0);
  assert.equal(descriptiveOnly.calibrationRateClaimsAvailable, false);

  const eligible = analyze(study("simple-random"));
  assert.equal(eligible.status, "sample-estimate");
  const flipped = detectorCalibrationReadiness([
    ineligible,
    descriptive,
    eligible
  ]);
  assert.equal(flipped.status, "eligible-studies-recorded");
  assert.equal(flipped.calibrationStudies, 3);
  assert.equal(flipped.eligibleCalibrationStudies, 1);
  assert.equal(flipped.labeledCalibrationCases, 4);
  assert.equal(flipped.ineligibleStudyLabeledCases, 4);
  assert.equal(flipped.calibrationRateClaimsAvailable, true);
});

test("a complete convenience study reports denominators and point rates without population uncertainty", () => {
  const analysis = analyze(study("convenience"));
  assert.equal(analysis.analysisVersion, DETECTOR_CALIBRATION_ANALYSIS_VERSION);
  assert.equal(analysis.status, "descriptive-only");
  assert.equal(analysis.studyDigest?.length, 64);
  assert.deepEqual(analysis.denominators, {
    plannedCases: 4,
    recordedCases: 4,
    completeCases: 4,
    censoredCases: 0,
    referencePresent: 2,
    referenceAbsent: 2,
    predictedDetected: 2,
    predictedNotDetected: 2
  });
  assert.deepEqual(analysis.confusionMatrix, {
    truePositive: 1,
    falsePositive: 1,
    trueNegative: 1,
    falseNegative: 1
  });
  assert.equal(analysis.rates?.sensitivity.estimate, 0.5);
  assert.equal(analysis.rates?.specificity.estimate, 0.5);
  assert.equal(analysis.rates?.accuracy.denominator, 4);
  assert.equal(analysis.rates?.accuracy.interval95, null);
  assert.deepEqual(analysis.uncertainty, {
    method: "none",
    reason: "descriptive-census-or-convenience-sample"
  });
  assert.equal(
    analysis.inference.scope,
    "recorded-cases-only-under-fixed-measurement-condition"
  );
  assert.deepEqual(
    analysis.inference.measurementCondition,
    detectorCalibrationMeasurementCondition("fingerprint-heuristics")
  );
  assert.equal(analysis.inference.conditionalRateClaim, null);
  assert.equal(analysis.inference.conditionalTargetPopulationRateClaimAllowed, false);
});

test("Wilson intervals are emitted only when every declared simple-random design gate passes", () => {
  const analysis = analyze(study("simple-random"));
  assert.equal(analysis.status, "sample-estimate");
  assert.deepEqual(analysis.uncertainty, {
    method: "wilson-score-95",
    reason: "conditional-on-declared-simple-random-design"
  });
  const sensitivity = analysis.rates?.sensitivity;
  assert.notEqual(sensitivity, undefined);
  assert.equal(sensitivity!.estimate, 0.5);
  assert.equal(sensitivity!.interval95?.method, "wilson-score");
  assert.equal((sensitivity!.interval95?.lower ?? 1) < 0.5, true);
  assert.equal((sensitivity!.interval95?.upper ?? 0) > 0.5, true);
  assert.equal(
    analysis.inference.scope,
    "conditional-on-declared-target-population-and-fixed-measurement-condition"
  );
  assert.equal(analysis.inference.targetPopulation, "Public English-language pages in the declared July frame");
  assert.deepEqual(
    analysis.inference.measurementCondition,
    detectorCalibrationMeasurementCondition("fingerprint-heuristics")
  );
  assert.match(
    analysis.inference.conditionalRateClaim ?? "",
    /fixed measurement condition/
  );
  assert.equal(analysis.inference.conditionalTargetPopulationRateClaimAllowed, true);

  const unblinded = study("simple-random");
  unblinded.design.referenceBlindedToPrediction = false;
  const downgraded = analyze(unblinded);
  assert.equal(downgraded.status, "descriptive-only");
  assert.equal(downgraded.rates?.sensitivity.interval95, null);
  assert.equal(downgraded.uncertainty.reason, "simple-random-design-gates-not-met");
  assert.equal(downgraded.inference.conditionalTargetPopulationRateClaimAllowed, false);
});

test("published v1 studies remain readable but cannot publish an unconditioned rate", () => {
  const current = study("simple-random");
  const legacy = structuredClone(current) as unknown as {
    schemaVersion: number;
    labelRosterAuthorizationSha256?: string;
    rosterSelectionLedgerSha256?: string;
    acquisitionAttemptLedgerSha256?: string;
    design: Record<string, unknown>;
    cases: Array<Record<string, unknown>>;
  };
  legacy.schemaVersion = 1;
  delete legacy.labelRosterAuthorizationSha256;
  delete legacy.rosterSelectionLedgerSha256;
  delete legacy.acquisitionAttemptLedgerSha256;
  delete legacy.design.measurementCondition;
  for (const calibrationCase of legacy.cases) {
    if (calibrationCase.outcome !== "complete") continue;
    const reference = calibrationCase.reference as Record<string, unknown>;
    const adjudication = reference.adjudication as Record<string, unknown>;
    reference.adjudication =
      adjudication.status === "labelers-agreed"
        ? {
            status: "labelers-agreed",
            adjudicatorId: null,
            artifactDigest: null
          }
        : {
            status: "disagreement-adjudicated",
            adjudicatorId: adjudication.tiebreakerId,
            artifactDigest: adjudication.artifactDigest
          };
  }
  const analysis = analyzeDetectorCalibrationStudy(legacy, ANALYSIS_CONTEXT);
  assert.equal(analysis.status, "ineligible");
  assert.equal(
    analysis.ineligibilityReasons.includes("measurement-condition-unbound"),
    true
  );
  assert.equal(analysis.rates, null);
  assert.equal(
    analysis.inference.conditionalTargetPopulationRateClaimAllowed,
    false
  );
  assert.equal(analysis.inference.conditionalRateClaim, null);
});

test("one censored case suppresses the complete-case confusion matrix and every rate", () => {
  const input = study("simple-random");
  input.cases[1] = {
    caseId: "positive-missed",
    outcome: "censored",
    reason: "capture-failed",
    conditionDigest: digest("positive-missed-condition"),
    attemptArtifactDigest: digest("positive-missed-attempt")
  };
  const analysis = analyze(input);
  assert.equal(analysis.status, "ineligible");
  assert.equal(analysis.ineligibilityReasons.includes("censored-cases-present"), true);
  assert.equal(analysis.denominators.plannedCases, 4);
  assert.equal(analysis.denominators.recordedCases, 4);
  assert.equal(analysis.denominators.completeCases, 3);
  assert.equal(analysis.denominators.censoredCases, 1);
  assert.equal(analysis.confusionMatrix, null);
  assert.equal(analysis.rates, null);
  assert.equal(analysis.inference.scope, "none");
});

test("analysis without a current exact build commit fails closed", () => {
  const analysis = analyzeDetectorCalibrationStudy(study("convenience"), {
    ...ANALYSIS_CONTEXT,
    expectedBuildCommit: null
  });
  assert.equal(analysis.status, "ineligible");
  assert.deepEqual(analysis.ineligibilityReasons, ["current-build-commit-unavailable"]);
  assert.equal(analysis.confusionMatrix, null);
});

test("analysis without a well-formed independently pinned runtime identity fails closed", () => {
  for (const expectedRuntimeDigest of [null, "A".repeat(64)]) {
    const analysis = analyzeDetectorCalibrationStudy(study("convenience"), {
      expectedBuildCommit: BUILD_COMMIT,
      expectedRuntimeDigest
    });
    assert.equal(analysis.status, "ineligible");
    assert.deepEqual(analysis.ineligibilityReasons, ["expected-runtime-identity-unavailable"]);
    assert.equal(analysis.confusionMatrix, null);
  }
});

test("all current release identities and the planned denominator are eligibility gates", () => {
  const input = study("convenience");
  input.plannedCases = 5;
  input.release.buildCommit = "b".repeat(40);
  input.release.detectorVersion = "stale-detector";
  input.release.registryVersion = "stale-registry";
  input.release.registryDigest = "b".repeat(64);
  input.release.detectorImplementationDigest = detectorCalibrationImplementationDigest({
    buildCommit: input.release.buildCommit,
    detector: input.detector,
    detectorVersion: input.release.detectorVersion,
    registryVersion: input.release.registryVersion,
    registryDigest: input.release.registryDigest
  });
  input.release.methodologyVersion = "stale-methodology";
  input.release.normalizationVersion = "stale-normalization";
  input.release.trackerCatalog.version = "stale-catalog";
  // Perturbs the manifest digest, not `fetchedAt`. This test's purpose is that
  // the Brave-list identity is a gate at all, and the timestamp was only a
  // convenient field to move. It is no longer part of the comparison -- a
  // refetch of identical rules is not a new revision -- so moving it here would
  // assert the opposite of what the analyzer now means and stop exercising the
  // gate this line exists for.
  input.release.braveLists.manifestDigest = "b".repeat(64);
  input.cases = input.cases.filter(
    (entry) => entry.outcome !== "complete" || entry.reference.value === "present"
  );
  const analysis = analyze(input);
  assert.equal(analysis.status, "ineligible");
  assert.deepEqual(analysis.ineligibilityReasons, [
    "planned-denominator-mismatch",
    "build-commit-mismatch",
    "detector-implementation-digest-mismatch",
    "detector-version-mismatch",
    "registry-version-mismatch",
    "registry-digest-mismatch",
    "methodology-version-mismatch",
    "normalization-version-mismatch",
    "tracker-catalog-revision-mismatch",
    "brave-list-revision-mismatch",
    "missing-negative-reference-denominator"
  ]);
  assert.equal(analysis.confusionMatrix, null);
  assert.equal(analysis.rates, null);
});

test("runtime and detector implementation digests must match their own declarations", () => {
  const runtimeMismatch = study("convenience");
  runtimeMismatch.release.runtime.nodeVersion = "v0.0.0";
  const runtimeIssues = detectorCalibrationStudyIssues(runtimeMismatch);
  assert.equal(
    runtimeIssues.includes("release.runtime.runtimeDigest does not match the declared runtime identity"),
    true
  );
  assert.equal(analyze(runtimeMismatch).status, "invalid");

  const implementationMismatch = study("convenience");
  implementationMismatch.release.detectorImplementationDigest = "f".repeat(64);
  const implementationIssues = detectorCalibrationStudyIssues(implementationMismatch);
  assert.equal(
    implementationIssues.includes(
      "release.detectorImplementationDigest does not match the declared build, detector, and registry identity"
    ),
    true
  );
  assert.equal(analyze(implementationMismatch).status, "invalid");
});

test("self-consistent runtime versions that contradict the current release are ineligible", () => {
  const input = study("convenience");
  input.release.runtime.nodeVersion = "23.0.0";
  input.release.runtime.playwrightVersion = "1.61.0";
  input.release.runtime.runtimeDigest = detectorCalibrationRuntimeDigest({
    observer: input.release.runtime.observer,
    automation: input.release.runtime.automation,
    nodeVersion: input.release.runtime.nodeVersion,
    playwrightVersion: input.release.runtime.playwrightVersion,
    browserName: input.release.runtime.browserName,
    browserVersion: input.release.runtime.browserVersion,
    operatingSystem: input.release.runtime.operatingSystem,
    architecture: input.release.runtime.architecture
  });
  const analysis = analyze(input);
  assert.equal(analysis.status, "ineligible");
  assert.deepEqual(analysis.ineligibilityReasons, [
    "runtime-identity-digest-mismatch",
    "node-version-mismatch",
    "playwright-version-mismatch"
  ]);
});

test("browser and host runtime drift is ineligible even when the study recomputes its digest", () => {
  const input = study("convenience");
  input.release.runtime.browserVersion = "999.0.0.0";
  input.release.runtime.operatingSystem = "other-os";
  input.release.runtime.architecture = "other-architecture";
  input.release.runtime.runtimeDigest = detectorCalibrationRuntimeDigest({
    observer: input.release.runtime.observer,
    automation: input.release.runtime.automation,
    nodeVersion: input.release.runtime.nodeVersion,
    playwrightVersion: input.release.runtime.playwrightVersion,
    browserName: input.release.runtime.browserName,
    browserVersion: input.release.runtime.browserVersion,
    operatingSystem: input.release.runtime.operatingSystem,
    architecture: input.release.runtime.architecture
  });
  const analysis = analyze(input);
  assert.equal(analysis.status, "ineligible");
  assert.deepEqual(analysis.ineligibilityReasons, ["runtime-identity-digest-mismatch"]);
});

test("complete cases require independent label and adjudication provenance", () => {
  const duplicateLabeler = study("convenience");
  const first = duplicateLabeler.cases[0];
  assert.equal(first.outcome, "complete");
  if (first.outcome !== "complete") return;
  first.reference.labelerIds = ["labeler-alpha", "labeler-alpha"];
  assert.equal(
    detectorCalibrationStudyIssues(duplicateLabeler).some((issue) =>
      issue.includes("reference.labelerIds must be unique")
    ),
    true
  );

  const conflictedAdjudicator = study("convenience");
  const second = conflictedAdjudicator.cases[0];
  assert.equal(second.outcome, "complete");
  if (second.outcome !== "complete") return;
  second.reference.adjudication = {
    status: "disagreement-resolved-by-blind-tiebreaker",
    tiebreakerId: "labeler-alpha",
    artifactDigest: digest("adjudication")
  };
  assert.equal(
    detectorCalibrationStudyIssues(conflictedAdjudicator).some((issue) =>
      issue.includes("tiebreakerId must differ")
    ),
    true
  );
});

test("undefined metric denominators stay null instead of becoming zero-rate claims", () => {
  const input = study("convenience");
  input.cases = [
    completeCase("positive-one", "present", "not-detected"),
    completeCase("negative-one", "absent", "not-detected")
  ];
  input.plannedCases = 2;
  const analysis = analyze(input);
  assert.equal(analysis.status, "descriptive-only");
  assert.deepEqual(analysis.rates?.precision, {
    numerator: 0,
    denominator: 0,
    estimate: null,
    interval95: null
  });
  assert.equal(analysis.rates?.sensitivity.estimate, 0);
  assert.equal(analysis.rates?.specificity.estimate, 1);
});

test("malformed, duplicate, extra-field, and over-broad study shapes are rejected", () => {
  const duplicate = study("convenience") as DetectorCalibrationStudyV3 & {
    extra?: boolean;
  };
  duplicate.cases[1] = structuredClone(duplicate.cases[0]);
  duplicate.extra = true;
  const issues = detectorCalibrationStudyIssues(duplicate);
  assert.equal(issues.some((issue) => issue === "study has unexpected or missing fields"), true);
  assert.equal(issues.some((issue) => issue.includes("repeats caseId")), true);
  const analysis = analyze(duplicate);
  assert.equal(analysis.status, "invalid");
  assert.equal(analysis.studyDigest, null);
  assert.equal(analysis.rates, null);
});

test("the confusion matrix distinguishes every cell, not just their total", () => {
  const asymmetric = study("convenience");
  asymmetric.plannedCases = 7;
  asymmetric.cases = [
    completeCase("tp-1", "present", "detected"),
    completeCase("tp-2", "present", "detected"),
    completeCase("tp-3", "present", "detected"),
    completeCase("fn-1", "present", "not-detected"),
    completeCase("fp-1", "absent", "detected"),
    completeCase("fp-2", "absent", "detected"),
    completeCase("tn-1", "absent", "not-detected")
  ];

  const analysis = analyze(asymmetric);
  assert.deepEqual(analysis.confusionMatrix, {
    truePositive: 3,
    falsePositive: 2,
    trueNegative: 1,
    falseNegative: 1
  });
  assert.deepEqual(analysis.denominators, {
    plannedCases: 7,
    recordedCases: 7,
    completeCases: 7,
    censoredCases: 0,
    referencePresent: 4,
    referenceAbsent: 3,
    predictedDetected: 5,
    predictedNotDetected: 2
  });
  assert.equal(analysis.rates?.sensitivity.estimate, 0.75);
  assert.equal(analysis.rates?.specificity.estimate, 1 / 3);
  assert.equal(analysis.rates?.sensitivity.denominator, 4);
  assert.equal(analysis.rates?.specificity.denominator, 3);
});

function study(
  sampling: DetectorCalibrationStudyV3["design"]["sampling"]
): DetectorCalibrationStudyV3 {
  return {
    schemaVersion: 3,
    studyId: "fp-july-calibration-v1",
    detector: "fingerprint-heuristics",
    release: currentDetectorCalibrationReleaseIdentity(
      "fingerprint-heuristics",
      BUILD_COMMIT,
      runtimeIdentity()
    ),
    targetPopulation: "Public English-language pages in the declared July frame",
    plannedCases: 4,
    labelRosterAuthorizationSha256: digest("label-roster-authorization"),
    rosterSelectionLedgerSha256: digest("roster-selection-ledger"),
    acquisitionAttemptLedgerSha256: digest("acquisition-attempt-ledger"),
    design: {
      sampling,
      samplingFrame: "Frozen frame digest 0123456789abcdef",
      samplingFrameDigest: digest("sampling-frame"),
      selectionProtocol: "Select case ids before detector output is available.",
      referenceProtocol: "Two blinded reviewers label presence from independent source evidence.",
      referenceProtocolDigest: digest("reference-protocol"),
      adjudicationProtocol: "A third blinded reviewer precommits a full-frame tiebreaker before detector acquisition.",
      adjudicationProtocolDigest: digest("adjudication-protocol"),
      measurementCondition: detectorCalibrationMeasurementCondition(
        "fingerprint-heuristics"
      ),
      independentUnits: true,
      predictionBlindedToReference: true,
      referenceBlindedToPrediction: true
    },
    cases: [
      completeCase("positive-detected", "present", "detected"),
      completeCase("positive-missed", "present", "not-detected"),
      completeCase("negative-clear", "absent", "not-detected"),
      completeCase("negative-flagged", "absent", "detected", true)
    ]
  };
}

function runtimeIdentity(): DetectorCalibrationRuntimeIdentity {
  const declared = {
    observer: "node-playwright",
    automation: "playwright-chromium",
    nodeVersion: "24.14.1",
    // Eligibility gates this against the live pin, so these cases are about a
    // study run on the CURRENT toolchain. A literal here would silently turn
    // every one of them into a drift case at the next measurement epoch; the
    // drift cases below state their mismatch explicitly instead.
    playwrightVersion: NODE_PLAYWRIGHT_VERSION,
    browserName: "chromium",
    browserVersion: "145.0.7632.6",
    operatingSystem: "linux",
    architecture: "x64"
  } as const;
  return { ...declared, runtimeDigest: detectorCalibrationRuntimeDigest(declared) };
}

function completeCase(
  caseId: string,
  reference: "present" | "absent",
  prediction: "detected" | "not-detected",
  adjudicated = false
): Extract<DetectorCalibrationCaseV3, { outcome: "complete" }> {
  return {
    caseId,
    outcome: "complete",
    conditionDigest: digest(`${caseId}-condition`),
    prediction: {
      value: prediction,
      artifactDigest: digest(`${caseId}-prediction`)
    },
    reference: {
      value: reference,
      evidenceArtifactDigest: digest(`${caseId}-evidence`),
      labelArtifactDigest: digest(`${caseId}-label`),
      labelerIds: ["labeler-alpha", "labeler-beta"],
      adjudication: adjudicated
        ? {
            status: "disagreement-resolved-by-blind-tiebreaker",
            tiebreakerId: "tiebreaker-gamma",
            artifactDigest: digest(`${caseId}-adjudication`)
          }
        : {
            status: "labelers-agreed",
            tiebreakerId: null,
            artifactDigest: null
          }
    }
  };
}

function analyze(input: unknown) {
  return analyzeDetectorCalibrationStudy(input, ANALYSIS_CONTEXT);
}

function digest(value: string): string {
  return sha256Hex(value);
}

test("a refetched but unchanged Brave snapshot does not retire a study", () => {
  // The analyzer compared `release.braveLists` by full-object equality, so a
  // refetch of byte-identical lists moved `fetchedAt` and pushed
  // brave-list-revision-mismatch, retiring an otherwise eligible study over a
  // timestamp that records only when the download happened. The producer tuple
  // had the same defect; both now read one definition, so the two cannot drift
  // into disagreeing about what the field means.
  const input = study("simple-random");
  input.release = currentDetectorCalibrationReleaseIdentity(
    "fingerprint-heuristics",
    input.release.buildCommit,
    runtimeIdentity()
  );
  const refetched = {
    ...input.release.braveLists,
    fetchedAt: "2099-01-01T00:00:00.000Z"
  };
  assert.notEqual(
    refetched.fetchedAt,
    input.release.braveLists.fetchedAt,
    "the fixture must actually differ in the field under test"
  );
  input.release = { ...input.release, braveLists: refetched };

  const analysis = analyze(input);
  assert.equal(
    analysis.ineligibilityReasons.includes("brave-list-revision-mismatch"),
    false,
    "a refetch of identical rules is not a new Brave-list revision"
  );

  // The other direction: a moved manifest digest is a real revision and must
  // still retire the study, or dropping the timestamp would have loosened the
  // gate rather than corrected it.
  const changed = { ...input.release, braveLists: { ...refetched, manifestDigest: "0".repeat(64) } };
  assert.equal(
    analyze({ ...input, release: changed }).ineligibilityReasons.includes("brave-list-revision-mismatch"),
    true,
    "changed Brave rules must still be a different revision"
  );
});

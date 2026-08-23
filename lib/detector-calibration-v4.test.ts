import assert from "node:assert/strict";
import { test } from "node:test";
import { detectorCalibrationStudyIssues } from "./detector-calibration";
import {
  DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_VERSION,
  analyzeDetectorCalibrationStudyV4,
  censoringCasesFromStudyV4,
  detectorCalibrationV4CaseIssues,
  detectorCalibrationV4StudyIssues,
  type DetectorCalibrationCaseV4,
  type DetectorCalibrationStudyV4
} from "./detector-calibration-v4";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

function label(labelerId: string, value: "present" | "absent" | "uncertain") {
  return {
    labelerId,
    value,
    evidenceSha256: sha(labelerId.slice(-1) || "e"),
    evidenceProvenance: `har-capture://${labelerId}/run-1`,
    labelArtifactDigest: sha("d")
  };
}

const TASK = { protocolId: "cname-independent-v1", taskSha256: sha("a") };

function knownReference(
  value: "present" | "absent",
  labels = [label("labeler-1", value), label("labeler-2", value)]
): DetectorCalibrationCaseV4["reference"] {
  return {
    status: "known",
    value,
    task: TASK,
    labels,
    adjudication: { status: "labelers-agreed", tiebreakerId: null, artifactDigest: null }
  };
}

function uncertainReference(
  labels = [label("labeler-1", "uncertain"), label("labeler-2", "uncertain")]
): DetectorCalibrationCaseV4["reference"] {
  return {
    status: "unknown",
    reason: "reference-label-uncertain",
    task: TASK,
    labels,
    adjudication: { status: "labelers-agreed", tiebreakerId: null, artifactDigest: null }
  };
}

function v4Case(
  caseId: string,
  prediction: DetectorCalibrationCaseV4["prediction"],
  reference: DetectorCalibrationCaseV4["reference"]
): DetectorCalibrationCaseV4 {
  return { caseId, conditionDigest: sha("c"), prediction, reference };
}

const KNOWN_DETECTED = { status: "known", value: "detected", artifactDigest: sha("1") } as const;
const KNOWN_NOT = { status: "known", value: "not-detected", artifactDigest: sha("2") } as const;
const UNKNOWN_PREDICTION = {
  status: "unknown",
  reason: "capture-failed",
  attemptArtifactDigest: sha("3")
} as const;

function v4Study(cases: DetectorCalibrationCaseV4[]): DetectorCalibrationStudyV4 {
  return {
    schemaVersion: 4,
    studyId: "cname-uncloaking-v4-test",
    detector: "cname-uncloaking",
    release: {} as DetectorCalibrationStudyV4["release"],
    targetPopulation: "test population",
    plannedCases: cases.length,
    labelRosterAuthorizationSha256: sha("7"),
    rosterSelectionLedgerSha256: sha("8"),
    acquisitionAttemptLedgerSha256: sha("9"),
    design: {} as DetectorCalibrationStudyV4["design"],
    cases
  };
}

test("the four side combinations project onto the analyzer's quadrants exactly", () => {
  const projected = censoringCasesFromStudyV4([
    v4Case("scored", KNOWN_DETECTED, knownReference("present")),
    v4Case("ref-unknown", KNOWN_NOT, uncertainReference()),
    v4Case("pred-unknown", UNKNOWN_PREDICTION, knownReference("absent")),
    v4Case("both", UNKNOWN_PREDICTION, uncertainReference())
  ]);
  assert.deepEqual(projected, [
    { caseId: "scored", kind: "scored", reference: "present", prediction: "detected" },
    // PREDICTION RETENTION: the surviving prediction is exactly what v3's
    // flattened model could not say, and it must survive projection.
    {
      caseId: "ref-unknown",
      kind: "reference-unknown",
      prediction: "not-detected",
      reason: "reference-label-uncertain"
    },
    { caseId: "pred-unknown", kind: "prediction-unknown", reference: "absent", reason: "capture-failed" },
    { caseId: "both", kind: "both-unknown", reason: "capture-failed+reference-label-uncertain" }
  ]);
});

test("uncertainty cannot become absence anywhere in the v4 model", () => {
  // As a known value: refused by the validator.
  const smuggled = v4Case("s", KNOWN_DETECTED, {
    ...knownReference("absent"),
    value: "uncertain"
  } as unknown as DetectorCalibrationCaseV4["reference"]);
  assert.ok(
    detectorCalibrationV4CaseIssues(smuggled).some((issue) =>
      /uncertainty is the unknown status, never a value/.test(issue)
    )
  );
  // As an unknown reason: only reference-label-uncertain is admissible.
  const wrongReason = v4Case("r", KNOWN_DETECTED, {
    ...uncertainReference(),
    reason: "capture-failed"
  } as unknown as DetectorCalibrationCaseV4["reference"]);
  assert.ok(
    detectorCalibrationV4CaseIssues(wrongReason).some((issue) =>
      /must be reference-label-uncertain/.test(issue)
    )
  );
  // Through projection: an uncertain reference NEVER lands in a reference
  // margin. The analyzer's guaranteed margins count it toward neither class.
  const analysis = analyzeDetectorCalibrationStudyV4(
    v4Study([
      v4Case("a", KNOWN_DETECTED, knownReference("present")),
      v4Case("b", KNOWN_NOT, knownReference("absent")),
      v4Case("c", KNOWN_DETECTED, uncertainReference())
    ])
  );
  assert.equal(analysis.policyC.guaranteedMargins.referenceAbsent, 1);
  assert.equal(analysis.policyC.guaranteedMargins.referencePresent, 1);
  assert.deepEqual(analysis.policyB.coverage.lossReasons, { "reference-label-uncertain": 1 });
});

test("the prediction side refuses the reference-side reason and vice versa is total", () => {
  const crossed = v4Case(
    "x",
    { status: "unknown", reason: "reference-label-uncertain" as never, attemptArtifactDigest: sha("3") },
    knownReference("present")
  );
  assert.ok(
    detectorCalibrationV4CaseIssues(crossed).some((issue) =>
      /reference-label-uncertain is a reference-side outcome/.test(issue)
    )
  );
});

test("adjudication must be what it claims: agreement is unanimity, a tiebreaker needs a disagreement", () => {
  // labelers-agreed beside disagreeing labels: refused.
  const fakeAgreement = v4Case("f", KNOWN_DETECTED, {
    ...knownReference("present", [label("labeler-1", "present"), label("labeler-2", "absent")])
  });
  assert.ok(
    detectorCalibrationV4CaseIssues(fakeAgreement).some((issue) =>
      /claims labelers-agreed but the labels do not unanimously/.test(issue)
    )
  );
  // A tiebreaker beside unanimous labels: refused.
  const needlessTiebreaker = v4Case("t", KNOWN_DETECTED, {
    status: "known",
    value: "present",
    task: TASK,
    labels: [label("labeler-1", "present"), label("labeler-2", "present")],
    adjudication: {
      status: "disagreement-resolved-by-blind-tiebreaker",
      tiebreakerId: "tiebreaker-1",
      artifactDigest: sha("b")
    }
  });
  assert.ok(
    detectorCalibrationV4CaseIssues(needlessTiebreaker).some((issue) =>
      /claims a tiebreaker but the primary labels are unanimous/.test(issue)
    )
  );
  // The tiebreaker must be a distinct actor.
  const selfTiebreak = v4Case("d", KNOWN_DETECTED, {
    status: "known",
    value: "present",
    task: TASK,
    labels: [label("labeler-1", "present"), label("labeler-2", "absent")],
    adjudication: {
      status: "disagreement-resolved-by-blind-tiebreaker",
      tiebreakerId: "labeler-1",
      artifactDigest: sha("b")
    }
  });
  assert.ok(
    detectorCalibrationV4CaseIssues(selfTiebreak).some((issue) =>
      /distinct from the primary labelers/.test(issue)
    )
  );
});

test("reviewer evidence is per source: distinct digests validate, and provenance is required", () => {
  const independent = v4Case("i", KNOWN_DETECTED, {
    status: "known",
    value: "present",
    task: TASK,
    labels: [
      { ...label("labeler-1", "present"), evidenceSha256: sha("1") },
      { ...label("labeler-2", "present"), evidenceSha256: sha("2") }
    ],
    adjudication: { status: "labelers-agreed", tiebreakerId: null, artifactDigest: null }
  });
  assert.deepEqual(detectorCalibrationV4CaseIssues(independent), []);
  const missingProvenance = v4Case("p", KNOWN_DETECTED, {
    ...knownReference("present", [
      { ...label("labeler-1", "present"), evidenceProvenance: "" },
      label("labeler-2", "present")
    ])
  });
  assert.ok(
    detectorCalibrationV4CaseIssues(missingProvenance).some((issue) =>
      /needs evidence provenance/.test(issue)
    )
  );
});

test("v3 and v4 refuse each other's rows; the generations cannot blur", () => {
  // A v3 merged-outcome row is refused by the v4 validator by name.
  assert.ok(
    detectorCalibrationV4CaseIssues({
      caseId: "legacy",
      outcome: "complete",
      conditionDigest: sha("c"),
      prediction: { value: "detected", artifactDigest: sha("1") },
      reference: { value: "present" }
    }).some((issue) => /v3 rows are refused/.test(issue))
  );
  // A v4 study is refused by the v3 validator (wrong schemaVersion).
  assert.ok(detectorCalibrationStudyIssues(v4Study([v4Case("a", KNOWN_DETECTED, knownReference("present"))])).length > 0);
  // And the v4 validator refuses earlier generations.
  assert.ok(
    detectorCalibrationV4StudyIssues({ schemaVersion: 3 }).some((issue) =>
      /historical machinery/.test(issue)
    )
  );
  assert.equal(DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_VERSION, 4);
});

test("conservation holds through the guarded analyze step", () => {
  const study = v4Study([
    v4Case("a", KNOWN_DETECTED, knownReference("present")),
    v4Case("b", KNOWN_NOT, knownReference("absent"))
  ]);
  const analysis = analyzeDetectorCalibrationStudyV4(study);
  assert.equal(analysis.plannedCases, 2);
  assert.equal(analysis.policyB.coverage.analyzedCases, 2);
  assert.throws(
    () => analyzeDetectorCalibrationStudyV4({ ...study, plannedCases: 3 }),
    /every planned attempt appears exactly once/
  );
});

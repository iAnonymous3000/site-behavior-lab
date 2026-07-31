import assert from "node:assert/strict";
import { test } from "node:test";
import {
  committedCalibrationStudyAnalyses,
  committedDetectorCalibrationReadiness
} from "./detector-calibration-source";

// These tests read the REAL committed calibration corpus. They pin behavior,
// not history: the pilot's exact numbers are asserted because its bytes are
// committed and immutable; totals use floors so a future study does not turn
// this red.

test("the committed pixel pilot is discovered and demotes itself against the current identity", () => {
  const studies = committedCalibrationStudyAnalyses();
  const pilot = studies.find((study) => study.studyDir === "pixel-events-pilot-2026-07-28");
  assert.ok(pilot, "the committed pilot study must be discovered");
  // The pilot is bound to build 6579e6b and ships no independent runtime
  // receipt, so re-analysis at any current HEAD must fail closed on identity,
  // never on structure.
  assert.equal(pilot.analysis.status, "ineligible");
  assert.equal(pilot.analysis.detector, "pixel-events");
  assert.equal(pilot.analysis.denominators.completeCases, 15);
  assert.equal(pilot.analysis.denominators.censoredCases, 9);
  assert.equal(
    pilot.analysis.ineligibilityReasons.includes("expected-runtime-identity-unavailable"),
    true,
    pilot.analysis.ineligibilityReasons.join(", ")
  );
});

test("committed readiness reports ineligible labeled cases without minting a claim", () => {
  const readiness = committedDetectorCalibrationReadiness();
  assert.equal(readiness.calibrationStudies >= 1, true);
  assert.equal(readiness.status !== "external-labeled-corpus-required", true);
  // No study in the repository is eligible against the current release
  // identity today; when one lands, THIS assertion is the one that moves.
  assert.equal(readiness.eligibleCalibrationStudies, 0);
  assert.equal(readiness.labeledCalibrationCases, 0);
  assert.equal(readiness.ineligibleStudyLabeledCases >= 15, true);
  assert.equal(readiness.calibrationRateClaimsAvailable, false);
});

test("a missing calibration directory reads as no studies, not an error", () => {
  const readiness = committedDetectorCalibrationReadiness("/nonexistent-root", {});
  assert.equal(readiness.status, "external-labeled-corpus-required");
  assert.equal(readiness.calibrationStudies, 0);
});

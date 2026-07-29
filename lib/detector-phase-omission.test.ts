import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PHASE_OMISSION_CONTRACT_VERSION,
  phaseOmissionExplainedByDetector
} from "./detector-phase-omission";
import { DETECTOR_REASON_CODES } from "./measurement-kernel";
import type { DetectorStatus } from "./scan-report-v2";

const STATUSES: DetectorStatus[] = ["complete", "partial", "skipped", "unsupported", "failed"];

// The test's OWN oracle, written out rather than imported. The production
// vocabulary is private on purpose; re-exporting it for the test would make
// the test agree with any drift instead of catching it.
const EXPLAINING_REASONS = ["budget-unavailable", "unsupported", "load-failed", "scan-failed", "engine-unavailable"];

test("phase omission is explained by the full status/reason truth table", () => {
  assert.equal(PHASE_OMISSION_CONTRACT_VERSION, "phase-omission-v1");
  const explaining = new Set(EXPLAINING_REASONS);

  // Every status crossed with every reason the registry can emit, plus the
  // absent-reason case. The builder and the r2 consent evaluator spelled this
  // rule differently (`status !== complete && !== partial` versus
  // `!detectorReportedActivity`); over the closed union those are the same
  // set, and this table is what proves it rather than reading the two.
  for (const status of STATUSES) {
    const reportsActivity = status === "complete" || status === "partial";
    for (const reason of [...DETECTOR_REASON_CODES, undefined, null]) {
      const expected = !reportsActivity && typeof reason === "string" && explaining.has(reason);
      assert.equal(
        phaseOmissionExplainedByDetector({ status, reason }),
        expected,
        `${status}/${String(reason)}`
      );
    }
  }
});

test("an active detector never explains a missing phase, whatever its reason", () => {
  for (const reason of EXPLAINING_REASONS) {
    assert.equal(phaseOmissionExplainedByDetector({ status: "complete", reason }), false);
    assert.equal(phaseOmissionExplainedByDetector({ status: "partial", reason }), false);
  }
});

test("the explaining vocabulary is drawn from the emittable reason registry", () => {
  // A reason that explains an omission must be one a producer can actually emit.
  for (const reason of EXPLAINING_REASONS) {
    assert.ok(
      (DETECTOR_REASON_CODES as readonly string[]).includes(reason),
      `${reason} is not an emittable detector reason`
    );
  }
  // Deliberate non-members: a probe the operator turned off, or never asked
  // for, does not EXPLAIN a missing phase; the conditions block already says
  // the phase was never requested.
  assert.equal(phaseOmissionExplainedByDetector({ status: "skipped", reason: "probe-disabled" }), false);
  assert.equal(phaseOmissionExplainedByDetector({ status: "skipped", reason: "not-requested" }), false);
});

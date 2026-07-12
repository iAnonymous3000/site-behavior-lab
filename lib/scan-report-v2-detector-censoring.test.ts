import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvidenceFamily, ScanRunV2 } from "./scan-report-v2";
import {
  METRIC_EVIDENCE_SOURCES,
  evaluateComparability,
  evaluateQuality,
  scanReportV2SemanticViolations
} from "./scan-report-v2-evaluators";
import {
  makeScanRunV2,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import {
  evaluateComparabilityR2,
  scanReportV2R2SemanticViolations
} from "./scan-report-v2-r2-evaluators";
import {
  makeScanRunV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";

const DETECTOR_EVIDENCE_SOURCES = ["requests", "fingerprinting", "detector-output"] as const;

function censor(run: ScanRunV2, family: EvidenceFamily): void {
  run.qualityFacts = {
    ...run.qualityFacts,
    captureLoss: [{ family, phaseId: 0, kind: "clipped", count: 1 }]
  };
  run.quality = evaluateQuality(run.qualityFacts, { observedRequests: run.evidence.requests.length });
}

test("the detector-findings registry covers every evidence source used by the family", () => {
  assert.deepEqual(METRIC_EVIDENCE_SOURCES["detector-findings"], DETECTOR_EVIDENCE_SOURCES);
});

test("r1 detector-findings eligibility is censored by every required source on either arm", () => {
  for (const source of DETECTOR_EVIDENCE_SOURCES) {
    for (const arm of ["baseline", "variant"] as const) {
      const baseline = makeScanRunV2({ runId: "r1-baseline", startedAt: "2026-06-18T10:00:00.000Z" });
      const variant = makeScanRunV2({ runId: "r1-variant", startedAt: "2026-07-09T10:00:00.000Z" });
      censor(arm === "baseline" ? baseline : variant, source);

      const comparability = evaluateComparability(
        { kind: "temporal", pairId: `r1-${source}-${arm}` },
        baseline,
        variant
      );

      assert.deepEqual(
        comparability.perMetric["detector-findings"],
        { eligible: false, reasons: [`family-censored:${arm}`] },
        `${source} loss on the ${arm} arm must censor r1 detector findings`
      );
    }
  }
});

test("r2 detector-findings eligibility inherits the same complete censoring registry", () => {
  for (const source of DETECTOR_EVIDENCE_SOURCES) {
    for (const arm of ["baseline", "variant"] as const) {
      const baseline = makeScanRunV2R2({ runId: "r2-baseline", startedAt: "2026-06-18T10:00:00.000Z" });
      const variant = makeScanRunV2R2({ runId: "r2-variant", startedAt: "2026-07-09T10:00:00.000Z" });
      censor(arm === "baseline" ? baseline : variant, source);

      const comparability = evaluateComparabilityR2(
        { kind: "temporal", pairId: `r2-${source}-${arm}` },
        baseline,
        variant
      );

      assert.deepEqual(
        comparability.perMetric["detector-findings"],
        { eligible: false, reasons: [`family-censored:${arm}`] },
        `${source} loss on the ${arm} arm must censor r2 detector findings`
      );
    }
  }
});

test("r1 and r2 semantic validation reject stored detector eligibility after source loss", () => {
  const r1 = makeTemporalComparisonReportV2();
  censor(r1.baseline, "fingerprinting");
  assert.deepEqual(scanReportV2SemanticViolations(r1), [
    "comparability: does not equal the shared evaluator's output"
  ]);

  const r2 = makeTemporalReportV2R2();
  censor(r2.variant, "fingerprinting");
  assert.deepEqual(scanReportV2R2SemanticViolations(r2), [
    "comparability: perMetric.detector-findings disagrees with the r2 evaluator (derived reasons: family-censored:variant)"
  ]);
});

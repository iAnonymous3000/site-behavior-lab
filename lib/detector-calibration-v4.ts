/**
 * The v4 side-separated detector-calibration study model
 * (docs/calibration-v4-reference-architecture.md).
 *
 * v4 exists because v3 structurally cannot represent independent reference
 * information: its frame binds a scanner-derived presence fact and its
 * pipeline forces every final label to equal it. Here the two sides of a case
 * are independent records. A case has no single `outcome`: its PREDICTION
 * side is known or unknown for scan-side reasons, and its REFERENCE side is
 * known or unknown because the reviewers' tri-state resolution came out
 * `uncertain`. The four combinations are exactly the B/C analyzer's input
 * quadrants, and a surviving prediction beside an uncertain reference, which
 * v3 could not say, is the `reference-unknown` case the analyzer was built
 * expecting.
 *
 * v3 (lib/detector-calibration.ts) is preserved strictly for historical
 * verification. Nothing here touches its types, validators, schemas, or
 * analyzer path, and each generation's validator refuses the other's rows.
 */

import type {
  DetectorCalibrationMeasurementCondition,
  DetectorCalibrationReleaseIdentity,
  DetectorCalibrationStudyV2
} from "./detector-calibration";
import { DETECTOR_IDS, type DetectorId } from "./scan-report-v2";
import {
  analyzeCensoring,
  type CensoringAnalysis,
  type CensoringAnalysisCase
} from "./calibration-censoring-analysis";

export const DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_VERSION = 4;
export const DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_ID =
  "detector-calibration-study.v4";

/**
 * Scan-side censor reasons only. `reference-label-uncertain` is exclusively a
 * reference-side outcome in v4; a prediction can never be censored by it, and
 * the validator refuses the string on this side.
 */
export type V4PredictionCensorReason =
  | "capture-failed"
  | "artifact-unreadable"
  | "eligibility-criteria-not-met";

export type V4PredictionSide =
  | {
      status: "known";
      value: "detected" | "not-detected";
      artifactDigest: string;
    }
  | {
      status: "unknown";
      reason: V4PredictionCensorReason;
      attemptArtifactDigest: string;
    };

/**
 * One reviewer's independent label. Evidence is the reviewer's OWN, digested
 * and attributed per source; byte-identity across reviewers is neither
 * required nor checked, which is the independence the architecture buys.
 */
export type V4ReferenceLabelRecord = {
  labelerId: string;
  value: "present" | "absent" | "uncertain";
  evidenceSha256: string;
  /** Where the evidence came from: a run id, capture path, or resolver log. */
  evidenceProvenance: string;
  labelArtifactDigest: string;
};

/** The frame binds a task, never an answer. */
export type V4ReferenceTask = {
  protocolId: string;
  taskSha256: string;
};

export type V4Adjudication =
  | { status: "labelers-agreed"; tiebreakerId: null; artifactDigest: null }
  | {
      status: "disagreement-resolved-by-blind-tiebreaker";
      tiebreakerId: string;
      artifactDigest: string;
      /**
       * The tiebreaker's OWN resolved tri-state, bound to the side by the
       * validator. Without this the record bound only a digest, and the
       * adversarial review reproduced a digest-authentic "uncertain"
       * adjudication sitting beside a known "absent" side: the exact
       * uncertainty-becomes-absence path the architecture forbids. A known
       * side requires equality with its value; the unknown side requires
       * exactly "uncertain".
       */
      value: "present" | "absent" | "uncertain";
    };

export type V4ReferenceSide =
  | {
      status: "known";
      value: "present" | "absent";
      task: V4ReferenceTask;
      labels: V4ReferenceLabelRecord[];
      adjudication: V4Adjudication;
    }
  | {
      status: "unknown";
      reason: "reference-label-uncertain";
      task: V4ReferenceTask;
      labels: V4ReferenceLabelRecord[];
      adjudication: V4Adjudication;
    };

export type DetectorCalibrationCaseV4 = {
  caseId: string;
  conditionDigest: string;
  prediction: V4PredictionSide;
  reference: V4ReferenceSide;
};

export type DetectorCalibrationStudyV4 = {
  schemaVersion: typeof DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_VERSION;
  studyId: string;
  detector: DetectorId;
  release: DetectorCalibrationReleaseIdentity;
  targetPopulation: string;
  plannedCases: number;
  labelRosterAuthorizationSha256: string;
  rosterSelectionLedgerSha256: string;
  acquisitionAttemptLedgerSha256: string;
  design: DetectorCalibrationStudyV2["design"];
  cases: DetectorCalibrationCaseV4[];
};

const SHA256 = /^[0-9a-f]{64}$/;
const PREDICTION_CENSOR_REASONS = new Set<string>([
  "capture-failed",
  "artifact-unreadable",
  "eligibility-criteria-not-met"
]);
const LABEL_VALUES = new Set<string>(["present", "absent", "uncertain"]);
export type { DetectorCalibrationMeasurementCondition };

function push(issues: string[], issue: string): void {
  issues.push(issue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  issues: string[],
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string
): void {
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    push(issues, `${context} must carry exactly [${expected.join(", ")}], found [${present.join(", ")}]`);
  }
}

function validateTask(issues: string[], task: unknown, context: string): void {
  if (!isRecord(task)) {
    push(issues, `${context} reference task must be a record`);
    return;
  }
  exactKeys(issues, task, ["protocolId", "taskSha256"], `${context} task`);
  if (typeof task.protocolId !== "string" || task.protocolId.length === 0) {
    push(issues, `${context} task needs a protocolId`);
  }
  if (typeof task.taskSha256 !== "string" || !SHA256.test(task.taskSha256)) {
    push(issues, `${context} task needs a sha256 task digest`);
  }
}

function validateLabels(
  issues: string[],
  labels: unknown,
  context: string
): V4ReferenceLabelRecord[] {
  if (!Array.isArray(labels) || labels.length < 2) {
    push(issues, `${context} needs at least two independent labeler records`);
    return [];
  }
  const seen = new Set<string>();
  const records: V4ReferenceLabelRecord[] = [];
  for (const [index, label] of labels.entries()) {
    const where = `${context} label ${index + 1}`;
    if (!isRecord(label)) {
      push(issues, `${where} must be a record`);
      continue;
    }
    exactKeys(
      issues,
      label,
      ["labelerId", "value", "evidenceSha256", "evidenceProvenance", "labelArtifactDigest"],
      where
    );
    if (typeof label.labelerId !== "string" || label.labelerId.length === 0) {
      push(issues, `${where} needs a labelerId`);
      continue;
    }
    if (seen.has(label.labelerId)) push(issues, `${where} duplicates labeler ${label.labelerId}`);
    seen.add(label.labelerId);
    if (typeof label.value !== "string" || !LABEL_VALUES.has(label.value)) {
      push(issues, `${where} value must be present, absent, or uncertain`);
    }
    if (typeof label.evidenceSha256 !== "string" || !SHA256.test(label.evidenceSha256)) {
      push(issues, `${where} needs its own evidence sha256; reviewer evidence is per source`);
    }
    if (typeof label.evidenceProvenance !== "string" || label.evidenceProvenance.length === 0) {
      push(issues, `${where} needs evidence provenance`);
    }
    if (typeof label.labelArtifactDigest !== "string" || !SHA256.test(label.labelArtifactDigest)) {
      push(issues, `${where} needs a label artifact digest`);
    }
    records.push(label as V4ReferenceLabelRecord);
  }
  return records;
}

function validateReferenceSide(issues: string[], side: unknown, context: string): void {
  if (!isRecord(side)) {
    push(issues, `${context} reference side must be a record`);
    return;
  }
  const status = side.status;
  if (status !== "known" && status !== "unknown") {
    push(issues, `${context} reference status must be known or unknown`);
    return;
  }
  exactKeys(
    issues,
    side,
    status === "known"
      ? ["status", "value", "task", "labels", "adjudication"]
      : ["status", "reason", "task", "labels", "adjudication"],
    `${context} reference`
  );
  if (status === "known") {
    // The known side is binary BY TYPE. "uncertain" here is the exact
    // uncertainty-becomes-a-value confusion v4 exists to make impossible.
    if (side.value !== "present" && side.value !== "absent") {
      push(
        issues,
        `${context} known reference value must be present or absent; uncertainty is the unknown status, never a value`
      );
    }
  } else if (side.reason !== "reference-label-uncertain") {
    push(issues, `${context} unknown reference reason must be reference-label-uncertain`);
  }
  validateTask(issues, side.task, context);
  const labels = validateLabels(issues, side.labels, `${context} reference`);
  const adjudication = side.adjudication;
  if (!isRecord(adjudication)) {
    push(issues, `${context} needs an adjudication record`);
    return;
  }
  if (adjudication.status === "labelers-agreed") {
    exactKeys(issues, adjudication, ["status", "tiebreakerId", "artifactDigest"], `${context} adjudication`);
    if (adjudication.tiebreakerId !== null || adjudication.artifactDigest !== null) {
      push(issues, `${context} an agreed adjudication carries no tiebreaker`);
    }
    // Agreement must actually be agreement: every primary label equals the
    // resolved value (or every one is uncertain for an unknown side).
    const resolved = status === "known" ? side.value : "uncertain";
    if (labels.length > 0 && !labels.every((label) => label.value === resolved)) {
      push(
        issues,
        `${context} claims labelers-agreed but the labels do not unanimously say ${String(resolved)}`
      );
    }
  } else if (adjudication.status === "disagreement-resolved-by-blind-tiebreaker") {
    exactKeys(
      issues,
      adjudication,
      ["status", "tiebreakerId", "artifactDigest", "value"],
      `${context} adjudication`
    );
    // Bind the recorded side to what the tiebreaker actually resolved. The
    // digest authenticates the artifact; only this equality authenticates the
    // TRANSFER of its value into the side.
    const expected = status === "known" ? side.value : "uncertain";
    if (adjudication.value !== expected) {
      push(
        issues,
        `${context} tiebreaker resolved "${String(adjudication.value)}" but the side records ${
          status === "known" ? `known "${String(side.value)}"` : "unknown"
        }; the resolution and the side must agree`
      );
    }
    if (typeof adjudication.tiebreakerId !== "string" || adjudication.tiebreakerId.length === 0) {
      push(issues, `${context} tiebreaker adjudication needs a tiebreakerId`);
    } else if (labels.some((label) => label.labelerId === adjudication.tiebreakerId)) {
      push(issues, `${context} the tiebreaker must be distinct from the primary labelers`);
    }
    if (typeof adjudication.artifactDigest !== "string" || !SHA256.test(adjudication.artifactDigest)) {
      push(issues, `${context} tiebreaker adjudication needs an artifact digest`);
    }
    // A tiebreaker exists only where the primaries disagreed.
    const distinct = new Set(labels.map((label) => label.value));
    if (labels.length > 0 && distinct.size <= 1) {
      push(issues, `${context} claims a tiebreaker but the primary labels are unanimous`);
    }
  } else {
    push(issues, `${context} adjudication status is not a v4 status`);
  }
}

function validatePredictionSide(issues: string[], side: unknown, context: string): void {
  if (!isRecord(side)) {
    push(issues, `${context} prediction side must be a record`);
    return;
  }
  if (side.status === "known") {
    exactKeys(issues, side, ["status", "value", "artifactDigest"], `${context} prediction`);
    if (side.value !== "detected" && side.value !== "not-detected") {
      push(issues, `${context} known prediction value must be detected or not-detected`);
    }
    if (typeof side.artifactDigest !== "string" || !SHA256.test(side.artifactDigest)) {
      push(issues, `${context} known prediction needs an artifact digest`);
    }
  } else if (side.status === "unknown") {
    exactKeys(issues, side, ["status", "reason", "attemptArtifactDigest"], `${context} prediction`);
    if (typeof side.reason !== "string" || !PREDICTION_CENSOR_REASONS.has(side.reason)) {
      push(
        issues,
        `${context} unknown prediction reason must be a scan-side reason; reference-label-uncertain is a reference-side outcome`
      );
    }
    if (
      typeof side.attemptArtifactDigest !== "string" ||
      !SHA256.test(side.attemptArtifactDigest)
    ) {
      push(issues, `${context} unknown prediction needs an attempt artifact digest`);
    }
  } else {
    push(issues, `${context} prediction status must be known or unknown`);
  }
}

/**
 * Structural validation for a v4 study's cases. Deep release/design identity
 * validation is deliberately deferred to the ceremony-wiring step that the
 * censoring decision reserves for named-human approval (the schema enforces
 * their shape meanwhile); this validator owns everything the side separation
 * introduces, and it REFUSES v3 rows: a case carrying `outcome` is the merged
 * model, not this one.
 */
export function detectorCalibrationV4CaseIssues(input: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(input)) return ["case must be a record"];
  if ("outcome" in input) {
    return ["a v4 case has independent sides, never a merged outcome; v3 rows are refused"];
  }
  exactKeys(issues, input, ["caseId", "conditionDigest", "prediction", "reference"], "case");
  const caseId = typeof input.caseId === "string" && input.caseId.length > 0 ? input.caseId : "?";
  if (caseId === "?") push(issues, "case needs a caseId");
  if (typeof input.conditionDigest !== "string" || !SHA256.test(input.conditionDigest)) {
    push(issues, `${caseId} needs a condition digest`);
  }
  validatePredictionSide(issues, input.prediction, caseId);
  validateReferenceSide(issues, input.reference, caseId);
  return issues;
}

export function detectorCalibrationV4StudyIssues(input: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(input)) return ["study must be a record"];
  if (input.schemaVersion !== DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_VERSION) {
    return [
      `schemaVersion must be ${DETECTOR_CALIBRATION_STUDY_V4_SCHEMA_VERSION}; earlier generations are validated by their own, historical machinery`
    ];
  }
  exactKeys(
    issues,
    input,
    [
      "schemaVersion",
      "studyId",
      "detector",
      "release",
      "targetPopulation",
      "plannedCases",
      "labelRosterAuthorizationSha256",
      "rosterSelectionLedgerSha256",
      "acquisitionAttemptLedgerSha256",
      "design",
      "cases"
    ],
    "study"
  );
  if (typeof input.studyId !== "string" || input.studyId.length === 0) {
    push(issues, "study needs a studyId");
  }
  if (!DETECTOR_IDS.includes(input.detector as DetectorId)) {
    push(issues, `study detector "${String(input.detector)}" is not a governed detector`);
  }
  if (typeof input.targetPopulation !== "string" || input.targetPopulation.length === 0) {
    push(issues, "study needs a target population");
  }
  if (!Number.isSafeInteger(input.plannedCases) || (input.plannedCases as number) <= 0) {
    push(issues, "study needs a positive plannedCases");
  }
  for (const digestField of [
    "labelRosterAuthorizationSha256",
    "rosterSelectionLedgerSha256",
    "acquisitionAttemptLedgerSha256"
  ]) {
    if (typeof input[digestField] !== "string" || !SHA256.test(input[digestField] as string)) {
      push(issues, `study needs a sha256 ${digestField}`);
    }
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    push(issues, "study needs cases");
    return issues;
  }
  if (Number.isSafeInteger(input.plannedCases) && input.cases.length !== input.plannedCases) {
    push(
      issues,
      `study records ${input.cases.length} cases against ${input.plannedCases} planned; every planned attempt appears exactly once`
    );
  }
  const seen = new Set<string>();
  for (const entry of input.cases) {
    issues.push(...detectorCalibrationV4CaseIssues(entry));
    if (isRecord(entry) && typeof entry.caseId === "string") {
      if (seen.has(entry.caseId)) push(issues, `duplicate case ${entry.caseId}`);
      seen.add(entry.caseId);
    }
  }
  return issues;
}

/**
 * Project v4 cases into the B/C analyzer's domain: the four side combinations
 * map one-to-one onto the analyzer's quadrants, and unlike the v3 projector
 * nothing is flattened away. A reference-unknown case RETAINS its prediction,
 * a prediction-unknown case retains its reference, and every unknown carries
 * its reason so policy B's loss accounting conserves them.
 */
export function censoringCasesFromStudyV4(
  cases: readonly DetectorCalibrationCaseV4[]
): CensoringAnalysisCase[] {
  return cases.map((entry) => {
    const predictionKnown = entry.prediction.status === "known";
    const referenceKnown = entry.reference.status === "known";
    if (predictionKnown && referenceKnown) {
      return {
        caseId: entry.caseId,
        kind: "scored",
        reference: (entry.reference as Extract<V4ReferenceSide, { status: "known" }>).value,
        prediction: (entry.prediction as Extract<V4PredictionSide, { status: "known" }>).value
      };
    }
    if (predictionKnown) {
      return {
        caseId: entry.caseId,
        kind: "reference-unknown",
        prediction: (entry.prediction as Extract<V4PredictionSide, { status: "known" }>).value,
        reason: "reference-label-uncertain"
      };
    }
    if (referenceKnown) {
      return {
        caseId: entry.caseId,
        kind: "prediction-unknown",
        reference: (entry.reference as Extract<V4ReferenceSide, { status: "known" }>).value,
        reason: (entry.prediction as Extract<V4PredictionSide, { status: "unknown" }>).reason
      };
    }
    return {
      caseId: entry.caseId,
      kind: "both-unknown",
      reason: `${(entry.prediction as Extract<V4PredictionSide, { status: "unknown" }>).reason}+reference-label-uncertain`
    };
  });
}

/** Validate, project, and analyze a v4 study in one guarded step. */
export function analyzeDetectorCalibrationStudyV4(
  study: DetectorCalibrationStudyV4
): CensoringAnalysis {
  const issues = detectorCalibrationV4StudyIssues(study);
  if (issues.length > 0) {
    throw new Error(`v4 study is invalid: ${issues.join("; ")}`);
  }
  return analyzeCensoring({
    plannedCases: study.plannedCases,
    cases: censoringCasesFromStudyV4(study.cases)
  });
}

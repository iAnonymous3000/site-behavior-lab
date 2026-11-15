// What REA 6.8.0 writes, read strictly: the release the owner confirmed for the workspace on
// 2026-11-15, after the S4 fixture runs (local pages, linux/arm64 only). Its identity below is the
// release, the commit its signed build provenance names, and the sha512 of the package that provenance
// covers, the same three facts recorder-shapes.ts pins for 6.5.0.
//
// 6.8.0 keeps 6.5.0's envelope: the same sixteen keys, the same provider for both outputs read here
// (rea-cdp-browser 2) and the same nested subject and environment keys, in every S4 fixture output. Its
// observe-web-execution output writes the same twelve limitation sentences, word for word. Its
// inspect-web-page output writes the same seven and one more, about worker targets. So the 6.5.0 readers
// read 6.8.0's two outputs, each given 6.8.0's sentence table below, and a sentence outside that table
// is still a shape this does not know.
//
// One thing does not carry over: 6.5.0's evidence-id recipe (checkEvidenceId) does not recompute the
// ids 6.8.0 writes, on unedited 6.8.0 output. 6.8.0's own recipe has not been read, so this adapter
// offers no id check, and an id in 6.8.0 output is a name REA gave it, not something checked here.
//
// 6.8.0 also reports a failed call as a typed failure object instead of an envelope. The workspace
// needs one fact from it before any other: which kind of refusal it was, so a budget refusal, a
// cleanup that could not be confirmed and an output REA could not read are three outcomes, not one
// "REA refused". readRecorderFailure reads that object strictly and keeps REA's own words for the kind
// (code, category, operation, cleanup), the reported budget figures as numbers, and never the message
// or the remediation sentence, which this adapter does not hold to a fixed list.
//
// The one sentence quoted here that 6.5.0 does not write is 6.8.0's. The package's MIT notice for it,
// copied from 6.8.0's own LICENSE file, is in docs/third-party/rea-agents-6.8.0-notice.md.

import {
  RECORDER_LIMITATIONS,
  isCount,
  isPlain,
  isShapeRefusal,
  readInspectOutput,
  readObserveOutput,
  readProvenance,
  recorderIdentityOf,
  shapeRefusal,
  type InspectView,
  type LimitationTable,
  type ObserveView,
  type Provenance,
  type RecorderIdentity,
  type RecorderPin,
  type ShapeRefusal
} from "./recorder-shapes";

export const RECORDER_6_8_0: RecorderPin = {
  name: "REA",
  release: "6.8.0",
  commit: "160d821ac9a0310afcb8d1fc427862dd6508add5",
  integrity: "sha512:f500de4671aa103cc0059cabd3878b9c15c1bff73a23dfd35aeffa334303e2911f932488fc1220c1338321b011797dc2d71ea18f0f7e265c78036c9448f67dc3"
};

/** Where a provenance record for 6.8.0 sits inside a run folder: the one path read for it. */
export const PROVENANCE_PATH_6_8_0 = "provenance-check/rea-agents-6.8.0.attestations.json";

/** 6.8.0's sentence table: 6.5.0's, word for word, and the one inspection sentence 6.8.0 adds. */
export const RECORDER_LIMITATIONS_6_8_0: LimitationTable = {
  "rea.observe-web-execution": RECORDER_LIMITATIONS["rea.observe-web-execution"],
  "rea.web-page-inspection": {
    ...RECORDER_LIMITATIONS["rea.web-page-inspection"],
    "Worker targets are a final inventory snapshot, not worker-session observation. Their attached flag describes any debugging client; this page-session collector does not observe worker network, console, or script events, and short-lived workers may be absent from the snapshot.": "worker-targets-snapshot-only"
  }
};

/** An observe-web-execution output written by 6.8.0. */
export function readObserveOutput680(file: string, value: unknown): ObserveView | ShapeRefusal {
  return readObserveOutput(file, value, RECORDER_LIMITATIONS_6_8_0);
}

/** An inspect-web-page output written by 6.8.0. */
export function readInspectOutput680(file: string, value: unknown): InspectView | ShapeRefusal {
  return readInspectOutput(file, value, RECORDER_LIMITATIONS_6_8_0);
}

/** What a provenance record says of 6.8.0, by the same rule as 6.5.0's. Signatures are not verified. */
export function readProvenance680(file: string, value: unknown): Provenance | ShapeRefusal {
  return readProvenance(file, value, RECORDER_6_8_0);
}

/** The recorder's identity for a run that pins 6.8.0, by the one rule recorder-shapes.ts states. */
export function recorderIdentity680(input: Readonly<{ provenance: Provenance | ShapeRefusal | null; declaredRelease: string | null; outputsRead: number; outputRefusal: ShapeRefusal | null }>): RecorderIdentity {
  return recorderIdentityOf({ ...input, recorder: RECORDER_6_8_0, provenancePath: PROVENANCE_PATH_6_8_0 });
}

/** One word of REA's own vocabulary. Anything longer could carry what a page said. */
const WORD = /^[a-z][a-z_-]{0,47}$/;

/** The keys every 6.8.0 failure object holds, and the two more an input refusal adds. */
const FAILURE_KEYS = ["category", "code", "details", "message", "remediation", "retryable"];
const INPUT_REFUSAL_KEYS = [...FAILURE_KEYS, "error", "recovery"];

/** The outcomes a workspace attempt can record from a 6.8.0 failure, each from REA's own code. */
export const FAILURE_OUTCOMES = ["budget-refused", "unreadable-output", "cleanup-unconfirmed", "cancelled", "input-refused", "other-failure"] as const;
export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number];

export type ReportedBudget = Readonly<{ boundary: string; kind: string; retainedBytes: number; limitBytes: number }>;

export type RecorderFailure = Readonly<{
  code: string;
  category: string;
  retryable: boolean;
  operation: string;
  /** REA's word for the cleanup it reports, or null where it reports none. */
  cleanup: string | null;
  /** The budget a resource refusal reports, as numbers, or null where it reports none. */
  budget: ReportedBudget | null;
  outcome: FailureOutcome;
}>;

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

function budgetOf(file: string, value: unknown): ReportedBudget | null | ShapeRefusal {
  if (value === undefined) return null;
  if (!isPlain(value) || !hasKeys(value, ["boundary", "kind", "retained_bytes", "limit_bytes"])) return shapeRefusal(file, "details.reported_limits");
  const { boundary, kind, retained_bytes: retained, limit_bytes: limit } = value;
  if (typeof boundary !== "string" || !WORD.test(boundary) || typeof kind !== "string" || !WORD.test(kind) || !isCount(retained) || !isCount(limit)) return shapeRefusal(file, "details.reported_limits");
  return { boundary, kind, retainedBytes: retained, limitBytes: limit };
}

/**
 * The outcome a failure stands for. A resource refusal that reports its budget is a budget refusal;
 * REA's own unreadable_output code stays its own outcome, so the two never read as one. A cleanup REA
 * could not confirm is recorded as that, whatever the primary error was, since the next attempt must
 * know the target may not be clean.
 */
function outcomeOf(code: string, budget: ReportedBudget | null): FailureOutcome {
  if (code === "resource_constraint" && budget !== null) return "budget-refused";
  if (code === "unreadable_output") return "unreadable-output";
  if (code === "cleanup_incomplete") return "cleanup-unconfirmed";
  if (code === "cancelled") return "cancelled";
  if (code === "invalid_request") return "input-refused";
  return "other-failure";
}

/** A failure object a 6.8.0 call wrote in place of an envelope. */
export function readRecorderFailure(file: string, value: unknown): RecorderFailure | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value) || !(hasKeys(value, FAILURE_KEYS) || hasKeys(value, INPUT_REFUSAL_KEYS))) return shapeRefusal(file, "failure keys");
  const { code, category, retryable, details, message, remediation } = value;
  if (typeof code !== "string" || !WORD.test(code)) return shapeRefusal(file, "code");
  if (typeof category !== "string" || !WORD.test(category)) return shapeRefusal(file, "category");
  if (typeof retryable !== "boolean") return shapeRefusal(file, "retryable");
  if (typeof message !== "string") return shapeRefusal(file, "message");
  if (!isPlain(remediation)) return shapeRefusal(file, "remediation");
  if (!isPlain(details) || typeof details.operation !== "string" || !WORD.test(details.operation)) return shapeRefusal(file, "details.operation");
  if (details.cleanup !== undefined && (typeof details.cleanup !== "string" || !WORD.test(details.cleanup))) return shapeRefusal(file, "details.cleanup");
  const budget = budgetOf(file, details.reported_limits);
  if (isShapeRefusal(budget)) return budget;
  return {
    code,
    category,
    retryable,
    operation: details.operation,
    cleanup: typeof details.cleanup === "string" ? details.cleanup : null,
    budget,
    outcome: outcomeOf(code, budget)
  };
}

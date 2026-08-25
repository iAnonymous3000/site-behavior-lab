/**
 * The ONE reader of a calibration candidate-set file.
 *
 * This grammar was written for the reliability sweep and is lifted here
 * UNCHANGED so that every consumer of a candidate set reads it identically.
 * It had grown a second reader: the frame producer read `{studyId,
 * candidates}` while the reviewer's reference instrument required a bare
 * array and refused the committed pilot set outright, so the one command the
 * whole labeling pipeline hangs off could not run on the file the runbook
 * handed reviewers. Two readers of one file is the same defect as two writers
 * of one contract: each side passes its own tests while disagreeing with the
 * other.
 *
 * Callers enforce WHICH study they expect; this module decides only what a
 * candidate set is. Refusal-only: nothing here repairs, coerces, or defaults.
 */

import { createHash } from "node:crypto";

const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(record, allowed, context) {
  for (const key of Object.keys(record)) {
    require(allowed.has(key), `${context} carries unexpected field "${key}"`);
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Parse the candidate-set file from its exact bytes. The digest is computed
 * over the bytes, never a re-serialization, so the receipt names the committed
 * file and not a formatting of it.
 */
export function parseCandidateSet(bytes) {
  require(
    typeof bytes === "string" && bytes.length > 0,
    "candidate set requires the file's exact contents"
  );
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("candidate set is not valid JSON");
  }
  require(isRecord(parsed), "candidate set must be an object");
  only(parsed, new Set(["studyId", "candidates"]), "candidate set");
  require(
    typeof parsed.studyId === "string" && parsed.studyId.length > 0,
    "candidate set requires a study id"
  );
  require(
    Array.isArray(parsed.candidates) && parsed.candidates.length > 0,
    "candidate set requires at least one candidate"
  );
  const seen = new Set();
  const candidates = parsed.candidates.map((entry, index) => {
    require(isRecord(entry), `candidate ${index + 1} must be an object`);
    only(entry, new Set(["caseId", "url"]), `candidate ${index + 1}`);
    require(
      typeof entry.caseId === "string" && CASE_ID.test(entry.caseId),
      `candidate ${index + 1} needs a lowercase alphanumeric caseId`
    );
    require(!seen.has(entry.caseId), `duplicate caseId ${entry.caseId}`);
    seen.add(entry.caseId);
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`candidate ${entry.caseId} has an unparseable url`);
    }
    require(
      url.protocol === "https:",
      `candidate ${entry.caseId} must be https; the sweep frames public https sites only`
    );
    return { caseId: entry.caseId, url: entry.url };
  });
  return {
    studyId: parsed.studyId,
    candidates,
    candidateSetDigest: sha256Hex(bytes)
  };
}

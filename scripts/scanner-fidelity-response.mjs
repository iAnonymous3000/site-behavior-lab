import { readResponseJsonWithinLimit } from "./http-response.mjs";
import { SWEEP_TARGET_FAILURE_CAUSES } from "./calibration-reliability-sweep-response-lib.mjs";

/**
 * Which failures are the target's, as the owner ruled them for the reliability
 * sweep on 2026-10-03 (docs/reliability-sweep-cluster-design.md). Imported,
 * never restated, so the two gates cannot disagree about a cause.
 */
const TARGET_FAILURE_CAUSES = new Set(SWEEP_TARGET_FAILURE_CAUSES);

/**
 * Read one scan answer into a tagged result:
 *   - "answered": the scanner returned a report;
 *   - "refused": the scanner declared a cause that the target's own behaviour
 *     explains (a name that does not resolve, a page that did not load in
 *     time). Not evidence of scanner health, and not a scanner defect;
 *   - "scanner-failure": every other refusal. A declared service cause or no
 *     cause at all is the instrument failing.
 * A body that cannot be read throws, and attemptScanRequest records the throw
 * as a scanner failure.
 *
 * The declared cause decides, never the status: the service answers a page
 * that did not load with 504 and a failed page load with 502, so "every 5xx is
 * the scanner's" turns third-party downtime into a red gate, and "every
 * readable refusal is the target's" hides a busy or broken scanner.
 */
export async function readScannerFidelityResponse(response, label) {
  const body = await readResponseJsonWithinLimit(response, {
    maxBytes: 32 * 1024 * 1024,
    label
  });
  if (response.ok && body?.ok !== false) {
    return { kind: "answered", report: body?.report ?? body };
  }
  const message =
    typeof body?.error === "string" && body.error.trim() ? body.error : `HTTP ${response.status}`;
  const cause = typeof body?.cause === "string" ? body.cause : null;
  if (cause !== null && TARGET_FAILURE_CAUSES.has(cause)) {
    return { kind: "refused", reason: message };
  }
  return {
    kind: "scanner-failure",
    reason: `scanner refused the request (HTTP ${response.status}, cause ${cause ?? "none"}): ${message}`
  };
}

/**
 * Run one scan request. A throw (a transport error, the driver's own timeout,
 * or a body that cannot be read) is the instrument failing: the driver waits
 * longer than the longest answer the scanner states for itself
 * (scanResponseDeadlineMs in lib/scan-deadlines.ts), so a target cannot
 * explain it.
 */
export async function attemptScanRequest(scan) {
  try {
    return await scan();
  } catch (error) {
    return {
      kind: "scanner-failure",
      reason: `scan request failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** The ledger attempt for one tagged result and, when answered, its evaluation. */
export function attemptRecord(site, repetition, result, evaluation = null) {
  const base = { url: site.url, shape: site.shape, repetition };
  if (result.kind === "refused") {
    return { ...base, outcome: "scan-failure", reason: result.reason, censoredFamilies: [], observation: null };
  }
  if (result.kind === "scanner-failure") {
    return { ...base, outcome: "scanner-failure", reason: result.reason, censoredFamilies: [], observation: null };
  }
  if (result.kind !== "answered" || evaluation === null) {
    throw new Error("An answered scan needs its evaluation, and no other result kind exists.");
  }
  const clean = evaluation.failures.length === 0;
  return {
    ...base,
    outcome: clean ? "pass" : "invariant-failure",
    reason: clean ? null : evaluation.failures.join(" | "),
    censoredFamilies: evaluation.censored,
    observation: evaluation.observation ?? null
  };
}

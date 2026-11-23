/**
 * Which worker calls a fingerprint-calls count can hold, from what the shown
 * arm records. The card's limit sentence says what the count excludes, and
 * that changed when the observer began to read dedicated workers: observer @5,
 * declared together with the v1 methodology component fingerprint-surface-v2.
 *
 * - "page-only": recorded before that, so the count excludes Web and Service
 *   Workers.
 * - "workers-read": recorded with worker reading, so the count excludes
 *   Service Workers but can include some Web Worker calls. Some, because a
 *   worker that could not be read in full, or was never tied to a document,
 *   is not credited.
 * - "unknown": the arm records neither, or records something this code has not
 *   reviewed. The sentence then claims neither inclusion nor exclusion.
 *
 * v1 records no observer version, so a v1 arm is classed by its methodology
 * token alone. v1 and these fields are self-reported; this classes what the
 * arm records, not what ran.
 */

import { REVIEWED_MEASUREMENT_LINES } from "./corpus-cohort";
import { LEGACY_V1_METHODOLOGY_UNSPECIFIED, legacyV1MethodologyIdentity } from "./legacy-methodology";
import type { RunView } from "./scan-report-views";

export type FingerprintWorkerScope = "page-only" | "workers-read" | "unknown";

/** The first observer that read dedicated workers back into the count. */
export const FIRST_WORKER_READING_OBSERVER = 5;

/**
 * The newest observer this classification was reviewed for. A newer one is
 * unknown until someone reads what it records; lib/fingerprint-worker-scope.test.ts
 * holds this equal to the kernel's current observer, so a version bump that
 * forgets it fails there instead of moving new scans to "unknown".
 */
export const NEWEST_REVIEWED_OBSERVER = 15;

/** The v1 component that names the worker-reading surface. */
export const WORKER_READING_SURFACE = "fingerprint-surface-v2";

/**
 * The v1 tokens without that component which the public sanitizer keeps
 * (HISTORICAL_NODE_SCANNER_METHODOLOGIES in lib/redact-scan-report-v1.ts,
 * restated here so that the sanitizer stays out of the client bundle).
 * lib/fingerprint-worker-scope.test.ts holds this list to the sanitizer's,
 * both ways.
 */
export const PAGE_ONLY_V1_METHODOLOGIES: readonly string[] = Object.freeze([
  "shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2",
  "shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v3+detector-coverage-v2",
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1+subject-validity-v3+detector-coverage-v2",
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1+subject-validity-v2+detector-coverage-v2",
  "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+subject-validity-v2+detector-coverage-v2"
]);

/**
 * The two older token shapes the sanitizer accepts by pattern: a token that
 * ends at the Playwright version, and one that ends before it. Both predate
 * the component, which only a later revision carries.
 */
const PAGE_ONLY_V1_SHAPE =
  /^shields-request-context-v2-adblock-rust-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-request-method-v1(?:-playwright-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?$/;

const OBSERVER_VERSION = /^fingerprint-observer@([1-9]\d*)$/;

export function fingerprintWorkerScope(run: Pick<RunView, "detectors" | "conditions">): FingerprintWorkerScope {
  if (run.detectors !== null) {
    const version = run.detectors["fingerprint-heuristics"]?.version ?? "";
    const n = Number(OBSERVER_VERSION.exec(version)?.[1] ?? Number.NaN);
    if (!Number.isSafeInteger(n) || n > NEWEST_REVIEWED_OBSERVER) return "unknown";
    return n < FIRST_WORKER_READING_OBSERVER ? "page-only" : "workers-read";
  }
  const token = legacyV1MethodologyIdentity(run.conditions.disclosure ?? undefined);
  if (token === LEGACY_V1_METHODOLOGY_UNSPECIFIED) return "unknown";
  if (PAGE_ONLY_V1_METHODOLOGIES.includes(token) || PAGE_ONLY_V1_SHAPE.test(token)) return "page-only";
  if (REVIEWED_MEASUREMENT_LINES.includes(token) && token.split("+").includes(WORKER_READING_SURFACE)) {
    return "workers-read";
  }
  return "unknown";
}

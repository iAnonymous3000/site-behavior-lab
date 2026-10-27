/**
 * Shared workers that ended at once (fingerprint-observer@10, owner call 3):
 * the bound, the r2 capture-loss detail, and the v1 sentence and r2 note that
 * report them, in one dependency-free module, so the producer, the reader and
 * the client bundles take every word from one place.
 *
 * A shared worker the scanner's attacher never reached (no pause, and no
 * script of it seen parsed) that ended within the bound of its creation, by
 * the attacher's own receive times, is reported apart from the worker realms
 * that ran unread: whether it ran any code is not known. Readers still treat
 * the visit's fingerprinting evidence as incomplete for it (owner call 3b).
 *
 * The sentence is the owner's approved v1 draft; its singular form is the
 * implementer's corrected draft. lib/redact-scan-report-v1.ts admits both
 * forms through a pattern of its own, which a test holds to these words.
 */

/** A shared worker the attacher never reached that ended within this many milliseconds of its creation ended at once. */
export const SHARED_WORKER_ENDED_AT_ONCE_MS = 10;

/** The r2 capture-loss detail for them, under the fingerprinting family, apart from `fingerprint-observer`. */
export const FINGERPRINT_SHARED_WORKER_ENDED_DETAIL = "fingerprint-shared-worker-ended";

/** In both forms of the sentence and in no other scanner line. */
export const SHARED_WORKER_ENDED_AT_ONCE_WARNING_FRAGMENT = `ended within ${SHARED_WORKER_ENDED_AT_ONCE_MS} ms, before the fingerprint observer could reach`;

/** The report's clause for `count` such workers, lower-case and unpunctuated, as a reader's note runs it. */
export function sharedWorkersEndedAtOnceClause(count: number): string {
  const bound = `${SHARED_WORKER_ENDED_AT_ONCE_MS} ms`;
  // The approved draft: "The page started <n> shared workers that ended
  // within 10 ms, before the fingerprint observer could reach them, so
  // whether they ran any code is not known." The singular is the
  // implementer's corrected draft of it.
  return count === 1
    ? `the page started 1 shared worker that ended within ${bound}, before the fingerprint observer could reach it, so whether it ran any code is not known`
    : `the page started ${count} shared workers that ended within ${bound}, before the fingerprint observer could reach them, so whether they ran any code is not known`;
}

/** The v1 warning line for `count` (a positive integer) such workers. */
export function sharedWorkersEndedAtOnceWarning(count: number): string {
  const clause = sharedWorkersEndedAtOnceClause(count);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

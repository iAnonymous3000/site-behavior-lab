/**
 * How long the server may legitimately take to answer one scan request, in
 * the one place both the server and the browser read.
 *
 * A synchronous `/api/scan` answers only when its visits are done, so the
 * browser's wait for that answer has to be built from the bounds the server
 * itself enforces. A second copy of them in the client is how the two drift:
 * a fixed 10 second wait for response headers ends every scan slower than
 * that while the server is still well inside its own 45 second budget, after
 * the visit it cancels has been charged.
 *
 * No imports, so the homepage bundle and the Node scanner can both read it.
 */

/** The longest a request waits for one of the scan slots (lib/scan-limits.ts). */
export const QUEUE_TIMEOUT_MS = 15_000;

/** One visit's whole budget, the scanner's browser setup included (lib/scanner.ts). */
export const MAX_SCAN_DURATION_MS = 45_000;

/**
 * An after-scrolling check's own budget, counted from the end of the visit it
 * follows (SCROLL_CHECK_TIMING in lib/scroll-check.ts).
 */
export const SCROLL_CHECK_PHASE_DEADLINE_MS = 45_000;

/**
 * What a request spends outside those budgets: verifying the target before
 * the queue (5 s at most), closing the browser, the few seconds a check may
 * run past its budget to finish its fixed sequence, and building and saving
 * the report. A judgment, not a server bound: a save can be configured to
 * take longer, and a wait this long has already outlasted any healthy one.
 */
export const SCAN_RESPONSE_MARGIN_MS = 20_000;

/**
 * The longest a synchronous scan answer can take: the queue wait, one visit
 * budget per visit (a comparison makes two, one after the other, in a single
 * slot), a check's own phase, and the margin.
 */
export function scanResponseDeadlineMs(request: { comparison: boolean; scrollCheck: boolean }): number {
  return (
    QUEUE_TIMEOUT_MS +
    (request.comparison ? 2 : 1) * MAX_SCAN_DURATION_MS +
    (request.scrollCheck ? SCROLL_CHECK_PHASE_DEADLINE_MS : 0) +
    SCAN_RESPONSE_MARGIN_MS
  );
}

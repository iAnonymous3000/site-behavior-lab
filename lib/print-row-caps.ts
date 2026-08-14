/**
 * Row ceilings the evidence tables use when rendering for print.
 *
 * The screen caps exist so an interactive page stays responsive while a reader
 * scrolls and filters. Paper has neither problem and cannot be expanded, so a
 * screen cap on paper is silent truncation of evidence a reader asked for.
 *
 * Derived from the committed corpus rather than chosen: measured across 1,448
 * runs in 725 committed reports, the per-run maxima are 1,000 requests (which
 * is the scanner's own recording cap, not a tail), 188 domains, 329 cookies,
 * 150 storage keys and 411 state changes. Each cap below clears its observed
 * maximum, so a printed
 * report truncates only where the SCAN truncated, and the existing
 * capped-evidence qualification already covers that case.
 *
 * Those figures were true when this was written, and the corpus grows every
 * Monday. `lib/print-row-caps.test.ts` re-derives the maxima through the same
 * reader the print route renders from and fails if any cap stops clearing its
 * family, so the paragraph above cannot quietly become false: a report large
 * enough to breach a cap reddens the suite instead of silently losing rows on
 * paper.
 *
 * These are still ceilings, not a promise of completeness. `listOverflowCopy`
 * derives its "showing N of M" note from the numbers actually rendered and
 * returns null once nothing is withheld, so raising a cap can never leave a
 * stale claim behind, and exceeding one still says so on the page.
 */
export const PRINT_ROW_CAPS = {
  /** Equal to the scanner's per-scan recording cap: paper never truncates first. */
  requests: 1_000,
  domains: 200,
  cookies: 350,
  storage: 200,
  stateChanges: 450
} as const;

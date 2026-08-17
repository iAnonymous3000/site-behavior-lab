/**
 * What each schema era's passive-history pairing identity holds constant.
 *
 * Two surfaces render this answer, the archive's compare picker
 * (app/_components/static-gallery.tsx) and the site profile's "Comparable
 * visits" note (app/sites/[domain]/page.tsx), and they must agree per era:
 * the site profile once restated the v1 rule as the v2 rule, telling readers
 * the pairing "deliberately omits the ad-block source, list count and
 * snapshot" over pairs whose v1 identity binds source and list count and
 * lets only the snapshot date drift. One constant per era, rendered verbatim
 * by both surfaces, closes that class; lib/comparison-history-copy.test.ts
 * pins both consumers to these constants and checks the sentence selected
 * for the committed corpus's pairs against their actual schema era.
 *
 * Kept dependency-free: the archive gallery is a client component, so this
 * module must not pull server-only or report modules into its bundle.
 */
export const COMPARISON_HISTORY_IDENTITY_SENTENCES = {
  v1: "This v1 history holds the route, scanner method, browser, device, conditions, catalog, Brave-list source and list count constant.",
  v2: "This v2/r2 history holds the route, device, condition vector, execution environment, methodology, normalization and tracker-catalog snapshot constant."
} as const;

export type ComparisonHistoryEra = keyof typeof COMPARISON_HISTORY_IDENTITY_SENTENCES;

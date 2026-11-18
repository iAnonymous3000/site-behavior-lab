/**
 * How many days a live share report is kept by default, before an operator's
 * SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS (lib/report-store.ts clamps either
 * below the bucket's own lifecycle rule).
 *
 * Its own module, with no imports, because reader pages state it: the privacy
 * page and the unavailable-report page render this number, and the store uses
 * it as its default. The privacy page used to restate it by hand, and a page
 * importing lib/report-store.ts would pull node:crypto and the R2 backend into
 * a static route.
 */
export const DEFAULT_REPORT_MAX_AGE_DAYS = 7;

/**
 * How many live share reports the store keeps by default, before an operator's
 * SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT (lib/report-store.ts clamps it to the
 * publication capacity). Count pruning keeps the newest this many and deletes
 * older shares once each has lasted the store's minimum survival time, so a
 * share can go well before DEFAULT_REPORT_MAX_AGE_DAYS. The same two pages
 * state it beside the age, for the same reason the age lives here.
 */
export const DEFAULT_REPORT_MAX_COUNT = 500;

/**
 * How long the reference deployment keeps every share before count pruning
 * may remove it, in minutes (its SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS in
 * wrangler.container.jsonc, and the durable-job default in
 * lib/report-store.ts). The privacy page and README state it; a test holds
 * both settings to this one value.
 */
export const REFERENCE_REPORT_MIN_SURVIVAL_MINUTES = 75;

/**
 * Advertising and analytics platforms a headline may name.
 *
 * Its own module because the HOMEPAGE needs this list and nothing else from
 * the report-insights graph. Importing it from there pulled a 572-line module
 * plus inline-screenshot, reviewed-ownership and text-format into the
 * homepage's initial JavaScript, which is measured against an enforced gzip
 * budget. That budget has twice blocked a correctness fix for want of tens of
 * bytes, so a seven-string constant must not be the reason a report module
 * ships to a visitor who has not asked for a report.
 *
 * Same reasoning as the deliberate inline copy in saved-report-client: a
 * client entry point never statically imports a report-reading module.
 */
export const HEADLINE_PLATFORMS = ["Google", "Meta", "TikTok", "X", "Microsoft", "LinkedIn", "Pinterest"];

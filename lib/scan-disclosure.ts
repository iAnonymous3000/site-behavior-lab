/**
 * What a scan does to the page, stated under the URL field before anyone
 * presses Scan.
 *
 * The homepage described the visit as "read what the page actually loaded" and
 * never said that it types into the page's form fields; the plain disclosure
 * appeared only after submission, under the progress bar (journey audit gap
 * 4). Every clause restates the scanner's own admitted wording:
 *
 * - the visit: "one automated, headless Chromium visit from a fixed en-US /
 *   UTC profile, with no scrolling, clicking, or consent interaction";
 * - the typing test: "typed a synthetic test value into N form fields (never
 *   submitting the form)";
 * - the privacy-policy read: "Read the site's privacy policy ... and compared
 *   its text against this visit's observed behavior";
 * - the comparison modes' two visits, and consent mode's scripted attempts to
 *   activate one choice on the cookie/consent banner.
 *
 * lib/scan-disclosure.test.ts holds each to the admitted vocabulary. The
 * homepage's server component renders it and hands the client form the
 * markup, so none of it ships in the homepage's JavaScript.
 */

/** The first sentence: what one single scan is. */
export const SCAN_DISCLOSURE_VISIT =
  "A single scan is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking or consent interaction.";

/**
 * The first sentence while a "Check after scrolling" arrival holds (owner's
 * approval, 2026-10-23): a check is that same single scan, then the
 * scrolling. The server component renders both, and the form shows this one
 * only in check mode, so it costs HTML, never homepage JavaScript.
 */
export const SCROLL_CHECK_DISCLOSURE_VISIT =
  "A check is one automated, headless Chromium visit from a fixed en-US / UTC profile: a single scan, then up to 8 screens of scrolling, with no clicking.";

/** The rest of the first paragraph, true of every visit. */
export const SCAN_DISCLOSURE_VISIT_REST =
  "Each visit types a made-up test value into form fields, never submitting the form, and reads the site's privacy policy when it finds one.";

export const SCAN_DISCLOSURE: readonly string[] = Object.freeze([
  `${SCAN_DISCLOSURE_VISIT} ${SCAN_DISCLOSURE_VISIT_REST}`,
  "Comparison modes run two visits, and consent mode tries to click the cookie banner's Accept all in one and Reject all in the other."
]);

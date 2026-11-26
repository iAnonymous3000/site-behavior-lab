/**
 * What a scan does to the page, stated under the URL field before anyone
 * presses Scan.
 *
 * The homepage's server component renders it and hands the client form the
 * markup, so none of it ships in the homepage's JavaScript.
 */

/** The first sentence: what one single v3 scan is. */
export const SCAN_DISCLOSURE_VISIT =
  "A single scan is one automated, headless Chromium visit that lets the page settle, scrolls to observe lazy-loaded traffic, and records requests, cookies, storage, and script signals.";

/** The rest of the first paragraph, true of every visit. */
export const SCAN_DISCLOSURE_VISIT_REST =
  "Each visit types a made-up test value into visible form fields, never submitting the form, and reads the site's privacy policy when it finds one.";

export const SCAN_DISCLOSURE: readonly string[] = Object.freeze([
  `${SCAN_DISCLOSURE_VISIT} ${SCAN_DISCLOSURE_VISIT_REST}`,
  "Comparison modes run two isolated visits side by side, and consent mode tries to click Accept all in one and Reject all in the other."
]);

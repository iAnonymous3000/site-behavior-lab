/**
 * The size step a report page sets its site name at, from the length of the
 * name as shown. The name is the page's largest type, and a long one at the
 * full size leaves a few letters alone on a second line; a step down keeps it
 * on one line where it can fit. Decided on the server, from the string, so no
 * script measures anything.
 *
 *   up to 18 characters   the full size
 *   19 to 26              "long"
 *   27 or more            "longer"
 *
 * The sizes themselves are the stylesheet's (app/_design/tokens.css).
 */
export type SiteNameStep = "full" | "long" | "longer";

export const SITE_NAME_LONG_FROM = 19;
export const SITE_NAME_LONGER_FROM = 27;

export function siteNameStep(shownName: string): SiteNameStep {
  const length = [...shownName].length;
  if (length >= SITE_NAME_LONGER_FROM) return "longer";
  return length >= SITE_NAME_LONG_FROM ? "long" : "full";
}

/**
 * The request side of "Check after scrolling": the one value a scan request
 * names, and the refusal sentences the scan API, the edge and the browser
 * share (owner's approval, 2026-10-23, section 4 of the build brief). No
 * imports, so the homepage bundle and the edge Worker can read it.
 */

/** The value of a scan body's `check` field that asks for the after-scrolling check. */
export const SCROLL_CHECK_REQUEST_VALUE = "scroll";

/** A check named beside a comparison or an inspection. */
export const SCROLL_CHECK_SINGLE_ONLY_REFUSAL = "A check after scrolling runs on a single scan only.";

/**
 * A `check` field with any other value. Drafted for the owner's review: the
 * brief names no sentence for it.
 */
export const SCROLL_CHECK_UNKNOWN_REFUSAL = "The only check a scan can ask for is the after-scrolling check.";

/**
 * While the scanner admits scans as durable jobs, whose exact-keyed admission
 * commitment has no place for a check. The browser says it before minting an
 * admission credential, and the edge and the Node durable preparation say
 * the same.
 */
export const SCROLL_CHECK_DURABLE_REFUSAL =
  "This deployment queues scans, and an after-scrolling check cannot run from the queue.";

/** From a scanner that writes version 1 reports, which have no immediate-only block to carry a check. */
export const SCROLL_CHECK_V1_PRODUCER_REFUSAL = "This deployment's scanner cannot carry an after-scrolling check.";

/** One check already holds the container's check slot (owner call 3). */
export const SCROLL_CHECK_BUSY_REFUSAL = "Another after-scrolling check is running; try again in a minute.";

/**
 * Whether a scan request body names a check at all, whatever its value: the
 * durable edge refuses any such body before it looks for an admission
 * capability, which such a body could never carry.
 */
export function scanBodyNamesScrollCheck(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "check");
}

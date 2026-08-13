/**
 * Declared causes for a failed scan, and the one sentence each owes a visitor.
 *
 * WHY THIS REPLACES SUBSTRING MATCHING.
 *
 * The client used to infer why a scan failed by testing the server's free-text
 * message for substrings, in order. That is not a translation layer, it is a
 * guess, and it guessed wrong in ways that made the product state things it had
 * never established:
 *
 *   - "Durable scan admission must use the private coordinator" contains
 *     "private", so a server misconfiguration rendered as "That address can't
 *     be scanned. The scanner only visits public web pages" -- blaming the
 *     visitor's perfectly public URL for the operator's config.
 *   - "...wrong lease token" contains "token", so an internal lease conflict
 *     rendered as "This scanner requires a valid access key" on a scanner whose
 *     own status line reads "No access key required".
 *   - Every Turnstile message matched nothing and rendered raw operator prose,
 *     while the client had already consumed and reset the challenge token. The
 *     visitor was left looking at a fresh unsolved challenge with no idea that
 *     solving it again was the fix.
 *
 * The failure mode is structural: prose is owned by whoever writes the throw,
 * the matcher is owned by the client, and nothing couples them. Adding a
 * message containing "rate" or "access" silently reroutes it.
 *
 * So the cause is DECLARED at the throw and carried to the client. This module
 * is the only place that maps a cause to reader-facing words, and both
 * producers -- the Node route and the Cloudflare Worker -- reach it through the
 * same `toPublicError`. It imports nothing, so it is safe in the Worker bundle.
 *
 * FAIL OPEN TOWARD SILENCE, NEVER TOWARD INVENTION. An unrecognized or absent
 * cause renders the server's own words with NO added instruction. Saying less
 * than we know is a smaller error than telling someone to retry something that
 * cannot succeed.
 */

export type ScanFailureCause =
  /** The address is not a scannable public URL. */
  | "invalid-url"
  /** The target resolves to localhost, a private network, or a reserved range. */
  | "private-target"
  /** The host did not resolve, or the page could not be fetched at all. */
  | "target-unreachable"
  /** The site answered, and refused an undisguised automated visit. */
  | "target-refused-automation"
  /** The page did not finish loading inside the scan's time budget. */
  | "page-load-timeout"
  /** The scanner itself is at capacity right now. */
  | "scanner-busy"
  /** This client has used its allowance for the moment. */
  | "rate-limited"
  /** A human-verification challenge must be solved (again) first. */
  | "challenge-required"
  /** This deployment gates scanning behind an access key. */
  | "access-key-required"
  /** The request itself was malformed or oversized. */
  | "request-rejected"
  /** A scanner capability is switched off or not deployed here. */
  | "feature-unavailable"
  /** This scan's lifecycle already moved past the requested action. */
  | "scan-conflict"
  /** Anything the server could not classify. */
  | "service-error";

export type ScanFailureNotice = {
  /** What happened, in the visitor's language. Never blames them for our state. */
  message: string;
  /** The single next action, or null when no action of theirs would help. */
  action: string | null;
  /**
   * Whether repeating the SAME request could plausibly succeed.
   *
   * `target-refused-automation` is deliberately false. A site that refuses an
   * undisguised automated visit refuses it every time; the old copy ended
   * "Try again, or try a different page", which invited a visitor to retry a
   * permanent refusal. The report surface already states this case honestly,
   * and the error surface used to contradict it on the same fact.
   */
  retryable: boolean;
};

const NOTICES: Record<ScanFailureCause, ScanFailureNotice> = {
  "invalid-url": {
    message: "That doesn't look like a scannable web address.",
    action: "Use a full public URL, such as https://example.com.",
    retryable: false
  },
  "private-target": {
    message:
      "That address points somewhere private. The scanner only visits public web pages, not localhost, private networks, or internal hosts.",
    action: "Scan a publicly reachable page instead.",
    retryable: false
  },
  "target-unreachable": {
    message: "The scanner couldn't reach that page. The site may be down, or the address may not resolve.",
    action: "Check the address, or try again later.",
    retryable: true
  },
  "target-refused-automation": {
    message:
      "That site refused an automated visit. This is the site's choice, and it is a real result rather than a scanner error.",
    // Deliberately not "try again": the refusal is deterministic.
    action: "Scanning it again will be refused the same way. Try a different page or site.",
    retryable: false
  },
  "page-load-timeout": {
    message: "The page didn't finish loading inside the scan's time limit. It may be very slow or very large.",
    action: "Try again, or try a lighter page on the same site.",
    retryable: true
  },
  "scanner-busy": {
    message: "The scanner is at capacity right now. Nothing is wrong with the address you gave it.",
    action: "Wait a few seconds and scan again.",
    retryable: true
  },
  "rate-limited": {
    message: "You've run several scans in a short window, so this one was held back.",
    action: "Wait a moment and scan again.",
    retryable: true
  },
  "challenge-required": {
    message: "The human-verification check didn't pass, so the scan wasn't started.",
    // The token is single-use and the client resets it, so the challenge on
    // screen is genuinely unsolved. This sentence is the whole fix.
    action: "Solve the verification challenge above, then scan again.",
    retryable: true
  },
  "access-key-required": {
    message: "This scanner is gated, and the request carried no valid access key.",
    action: "Add the scanner access key under More options, or ask whoever runs this instance.",
    retryable: false
  },
  "request-rejected": {
    message: "The scanner rejected the request itself, before visiting anything.",
    action: null,
    retryable: false
  },
  "feature-unavailable": {
    message: "That part of the scanner isn't available on this deployment. This is a server-side limit, not a problem with your address.",
    action: null,
    retryable: false
  },
  "scan-conflict": {
    message: "This scan had already moved on, so that action no longer applies to it.",
    action: null,
    retryable: false
  },
  "service-error": {
    message: "The scanner couldn't complete this request.",
    action: "Try again shortly.",
    retryable: true
  }
};

const CAUSES = new Set<string>(Object.keys(NOTICES));

export function isScanFailureCause(value: unknown): value is ScanFailureCause {
  return typeof value === "string" && CAUSES.has(value);
}

export function scanFailureNotice(cause: ScanFailureCause): ScanFailureNotice {
  return NOTICES[cause];
}

/**
 * The sentence a visitor reads for a failed scan.
 *
 * `serverMessage` is the fallback, used verbatim when the server declared no
 * cause. It is deliberately returned WITHOUT an action: an unclassified failure
 * is exactly the case where the old code guessed, and guessing is what produced
 * the false instructions this module exists to remove.
 */
export function scanFailureText(
  cause: unknown,
  serverMessage: string,
  options: { openAccessScanner?: boolean } = {}
): ScanFailureNotice {
  if (!isScanFailureCause(cause)) {
    return { message: serverMessage, action: null, retryable: false };
  }
  if (cause === "access-key-required" && options.openAccessScanner) {
    // An open deployment rejecting an open scan is the operator's problem, and
    // telling the visitor to find an access key would send them after one that
    // is not supposed to exist.
    return {
      message: "This scanner is meant to be open, but it rejected the request as unauthorized.",
      action: "This is a deployment problem rather than something you can fix.",
      retryable: true
    };
  }
  return NOTICES[cause];
}

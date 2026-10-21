import type { ComparisonRunMode } from "./run-mode-copy";

/**
 * Normalize a scan target before it can leave the browser. The scanner reports
 * a page by origin and path, while query strings and fragments commonly carry
 * tracking identifiers, account details, or bearer-like secrets.
 */
/**
 * Rejecting a malformed target must not depend on `new URL()` throwing, because the two
 * runtimes this function ships to disagree about when it does. Node rejects a space in
 * the authority; Chromium percent-encodes it and returns a URL whose hostname is
 * `not%20a%20url`. So a Node-only test could assert this returned null for input the
 * browser happily accepted, and the visitor got no "enter a valid public URL" message
 * for the single most likely typo. Validate the parsed hostname explicitly instead.
 */
export function isScannableHostname(hostname: string): boolean {
  if (!hostname) return false;
  // Percent-encoding in a host is never a real host; it is Chromium salvaging bytes a
  // host may not contain (spaces, control characters) rather than failing the parse.
  if (hostname.includes("%")) return false;
  if (/[\s_]/.test(hostname)) return false;
  // Bracketed IPv6 and dotted IPv4/registrable names only.
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  if (!hostname.includes(".")) return false;
  // A trailing-dot root is fine; empty labels ("a..b", ".a", "a.") are not.
  const labels = hostname.replace(/\.$/, "").split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}

export function normalizeScanUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept bare domains (e.g. "fidelity.com") by assuming https://. If the user
  // already typed any scheme, keep it and let the scanner validate it.
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // Refuse credentials HERE, not at the scanner. The server rejects them too,
    // but by then the password has already left the browser inside the scan
    // POST body and can reach a WAF, an access log, or an error report. This
    // boundary strips query and fragment for exactly that reason; userinfo is
    // the same class of secret and was the one part it kept. Mirrors the guard
    // in lib/scheduled-rescan-ui.ts so both entry points refuse identically.
    if (parsed.username || parsed.password) return null;
    if (!isScannableHostname(parsed.hostname)) return null;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Never send an unparsable value: its query or fragment could contain the
    // private data this boundary promises to remove.
    return null;
  }
}

/**
 * The form's comparison modes, the only values a scan link's `mode` may take.
 * Typed as a record over the run modes, so a comparison mode added to the
 * form fails to compile until it is named here, and nothing else can be.
 */
export const SCAN_PREFILL_MODES: Readonly<Record<ComparisonRunMode, true>> = {
  gpc: true,
  shields: true,
  consent: true
};

function scanPrefillMode(value: string): ComparisonRunMode | null {
  return Object.prototype.hasOwnProperty.call(SCAN_PREFILL_MODES, value) ? (value as ComparisonRunMode) : null;
}

/**
 * Build a deep link whose scan target exists only in the client-side fragment.
 * Normalize first so even copied browser history does not retain target query
 * secrets. Fragments are not included in the HTTP request for the page. A
 * mode asks the form to select that comparison once the scanner's health
 * says it is offered; the link never submits anything.
 */
export function scanPrefillHref(value: string, mode?: ComparisonRunMode): string | null {
  const normalized = normalizeScanUrl(value);
  if (!normalized) return null;
  const href = `/#scan?url=${encodeURIComponent(normalized)}`;
  return mode ? `${href}&mode=${mode}` : href;
}

export type ScanPrefillNavigation = {
  targetUrl: string | null;
  /** The comparison the link asked for, only beside a target the form accepted. */
  mode: ComparisonRunMode | null;
  cleanHref: string;
  scrollToScan: boolean;
};

/**
 * Resolve and scrub a scan deep link before React writes the target into UI
 * state. Legacy `?url=` links are cleaned but deliberately not trusted for
 * prefill because their target already crossed an HTTP request boundary.
 *
 * A fragment prefill holds exactly one `url` and at most one `mode`, in either
 * order, the mode one of SCAN_PREFILL_MODES. Any other key, a repeated key, or
 * any other mode value refuses the whole link, target included, as an unknown
 * key always has.
 */
export function resolveScanPrefillNavigation(href: string): ScanPrefillNavigation | null {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  const hadLegacyQueryPrefill = parsed.searchParams.has("url");
  if (hadLegacyQueryPrefill) parsed.searchParams.delete("url");

  const hadFragmentPrefill = parsed.hash.startsWith("#scan?");
  const scrollToScan = hadFragmentPrefill || parsed.hash === "#scan";
  let targetUrl: string | null = null;
  let mode: ComparisonRunMode | null = null;

  if (hadFragmentPrefill) {
    const fragmentParams = new URLSearchParams(parsed.hash.slice("#scan?".length));
    const keys = [...fragmentParams.keys()];
    const targets = fragmentParams.getAll("url");
    const modes = fragmentParams.getAll("mode");
    const requestedMode = modes.length === 1 ? scanPrefillMode(modes[0]) : null;
    const onlyKnownKeys = keys.every((key) => key === "url" || key === "mode");
    if (onlyKnownKeys && targets.length === 1 && (modes.length === 0 || requestedMode !== null)) {
      targetUrl = normalizeScanUrl(targets[0]);
      mode = targetUrl ? requestedMode : null;
    }
    // Scrub valid and malformed prefill fragments alike. The stable #scan
    // anchor keeps the intentional landing position without retaining input.
    parsed.hash = "#scan";
  }

  if (!hadLegacyQueryPrefill && !hadFragmentPrefill) return null;
  return {
    targetUrl,
    mode,
    cleanHref: parsed.toString(),
    scrollToScan
  };
}

/**
 * What the form does with a mode a scan link asked for. While the scanner's
 * health has not answered, no comparison is offered or refused (journey audit
 * gap 18), so the request is held. Once it answers, the form selects the mode
 * if the scanner offers it, and otherwise keeps Single selected, beside the
 * unavailable note the run control already shows. Nothing is ever submitted.
 */
export function heldRunModeOutcome(input: {
  requested: ComparisonRunMode;
  awaitingScannerHealth: boolean;
  offered: Readonly<Record<ComparisonRunMode, boolean>>;
}): "hold" | "select" | "single" {
  if (input.awaitingScannerHealth) return "hold";
  return input.offered[input.requested] ? "select" : "single";
}

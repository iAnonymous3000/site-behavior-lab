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
 * Build a deep link whose scan target exists only in the client-side fragment.
 * Normalize first so even copied browser history does not retain target query
 * secrets. Fragments are not included in the HTTP request for the page.
 */
export function scanPrefillHref(value: string): string | null {
  const normalized = normalizeScanUrl(value);
  return normalized ? `/#scan?url=${encodeURIComponent(normalized)}` : null;
}

export type ScanPrefillNavigation = {
  targetUrl: string | null;
  cleanHref: string;
  scrollToScan: boolean;
};

/**
 * Resolve and scrub a scan deep link before React writes the target into UI
 * state. Legacy `?url=` links are cleaned but deliberately not trusted for
 * prefill because their target already crossed an HTTP request boundary.
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

  if (hadFragmentPrefill) {
    const fragmentParams = new URLSearchParams(parsed.hash.slice("#scan?".length));
    const keys = [...fragmentParams.keys()];
    const targets = fragmentParams.getAll("url");
    if (keys.length === 1 && keys[0] === "url" && targets.length === 1) {
      targetUrl = normalizeScanUrl(targets[0]);
    }
    // Scrub valid and malformed prefill fragments alike. The stable #scan
    // anchor keeps the intentional landing position without retaining input.
    parsed.hash = "#scan";
  }

  if (!hadLegacyQueryPrefill && !hadFragmentPrefill) return null;
  return {
    targetUrl,
    cleanHref: parsed.toString(),
    scrollToScan
  };
}

/** Pure client-form decisions kept outside React so privacy and readiness are regression-tested. */

export function normalizeScanUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept bare domains (e.g. "fidelity.com") by assuming https://. If the user
  // already typed any scheme, keep it and let the scanner validate it.
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  // Drop the query string and fragment before the URL ever leaves the browser.
  // Those carry the most PII (tracking ids, tokens, emails); the scan reports a
  // page by origin + path anyway. The path is kept so specific pages still scan.
  try {
    const parsed = new URL(withScheme);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Never send an unparsable value: its query/fragment could contain the
    // private data this boundary promises to remove.
    return null;
  }
}

export function scannerHealthPending(input: {
  liveScanEnabled: boolean;
  reportPage: boolean;
  healthResolved: boolean;
  healthError: string | null;
}): boolean {
  return input.liveScanEnabled && !input.reportPage && !input.healthResolved && input.healthError === null;
}

export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// A query-parameter *name* is normally low-cardinality configuration (utm_source,
// tid, ud[em]), so preserving it while blanking the value is safe and useful. But
// the scanned page controls its own request URLs and could place sensitive data
// (an email, a token) in the name itself, which `preserveQueryKeys` would then
// store verbatim in the public report. Keep only short, conventional names;
// replace anything else with a fixed marker so the report still shows a parameter
// existed without retaining its content.
const MAX_PRESERVED_QUERY_KEY_LENGTH = 40;
const SAFE_QUERY_KEY_PATTERN = /^[A-Za-z0-9_.\-[\]]+$/;
const REDACTED_QUERY_KEY = "[redacted]";

export function preservedQueryKey(key: string): string {
  return key.length <= MAX_PRESERVED_QUERY_KEY_LENGTH && SAFE_QUERY_KEY_PATTERN.test(key) ? key : REDACTED_QUERY_KEY;
}

export function redactUrlForReport(url: string, options: { preserveQueryKeys?: boolean } = {}): string {
  const parsed = safeParseUrl(url);
  if (!parsed) return url;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  if (options.preserveQueryKeys) {
    const redactedParams = new URLSearchParams();
    parsed.searchParams.forEach((_value, key) => {
      redactedParams.append(preservedQueryKey(key), "");
    });
    parsed.search = redactedParams.toString();
  } else {
    parsed.search = "";
  }
  return parsed.toString();
}

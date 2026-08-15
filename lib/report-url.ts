export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const PUBLIC_REDACTION_MARKER =
  /(?:\{(?:seg|n|label|invalid-url|invalid-host)\}|\[redacted(?::(?:uuid-like|numeric|hex-like|long-token))?\])/i;

/**
 * Return a link target only when the public value still identifies a real
 * HTTP(S) location. Redaction-v2 route shapes deliberately look URL-like, but
 * their markers are evidence placeholders and must never become outbound
 * links. Check both the wire spelling and one decoded layer because query-key
 * markers are percent-encoded by URLSearchParams.
 */
export function safeNavigableHttpUrl(value: string): string | null {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // The URL parser below owns malformed-input rejection.
  }
  if (PUBLIC_REDACTION_MARKER.test(value) || PUBLIC_REDACTION_MARKER.test(decoded)) return null;

  const parsed = safeParseUrl(value);
  return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.toString() : null;
}

// A query-parameter *name* is normally low-cardinality configuration (utm_source,
// tid, ud[em]), so preserving it while blanking the value is safe and useful. But
// the scanned page controls its own request URLs and could place sensitive data
// (an email, a token) in the name itself, which `preserveQueryKeys` would then
// store verbatim in the public report. Keep only short, conventional names;
// replace anything else with a fixed marker so the report still shows a parameter
// existed without retaining its content.

export function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
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
      redactedParams.append(key, "");
    });
    parsed.search = redactedParams.toString();
  } else {
    parsed.search = "";
  }
  return parsed.toString();
}

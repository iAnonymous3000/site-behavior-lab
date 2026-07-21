import { siteProfileKey } from "./site-profile";

/**
 * Turn pasted web URLs and common www host forms into the canonical-looking
 * hostname used by the directory. Ordinary text is returned unchanged so the
 * existing domain substring search keeps working.
 */
export function normalizeDirectorySearchQuery(value: string): string {
  const query = value.trim().toLowerCase();
  if (!query) return "";

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(query);
  const isWwwHost = /^www\.[^/?#\s]+(?:[/?#]|$)/i.test(query);
  if (!hasScheme && !isWwwHost) return query;

  try {
    const url = new URL(hasScheme ? query : `https://${query}`);
    const hostname = url.hostname.replace(/\.$/, "");
    const displayHostname = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
    return siteProfileKey(displayHostname) ?? displayHostname;
  } catch {
    return query;
  }
}

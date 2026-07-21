/** Stable, privacy-safe grouping and paths for public site history pages. */

import { parse } from "tldts";

const GENERALIZED_LABEL = "{label}";

export function siteProfileKey(domain: string): string | null {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (
    !normalized ||
    normalized.length > 253 ||
    normalized === "unknown" ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    return null;
  }
  // Validate as a hostname before consulting the suffix table; otherwise
  // path-shaped input could silently collapse to an unrelated profile.
  if (
    normalized.split(".").some(
      (label) =>
        label === "" ||
        (label !== GENERALIZED_LABEL && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
  ) {
    return null;
  }

  // Substitute publication markers only while consulting the suffix table.
  // A marker must never survive into a route key.
  const originalLabels = normalized.split(".");
  const markerSafeHostname = originalLabels
    .map((label) => label === GENERALIZED_LABEL ? "redacted-label" : label)
    .join(".");
  const parsed = parse(markerSafeHostname, { allowPrivateDomains: true });
  if (!parsed.isIcann && !parsed.isPrivate) return null;

  if (parsed.domain) {
    const domainLabels = parsed.domain.split(".").length;
    const registrable = originalLabels.slice(-domainLabels).join(".");
    return registrable.includes("{") ? null : registrable;
  }

  // A few real public websites live at a public-suffix apex (for example
  // gov.uk and govt.nz). They have no registrable child according to the PSL,
  // but are still valid, public hostname identities in the corpus.
  return parsed.publicSuffix === markerSafeHostname && !normalized.includes("{")
    ? normalized
    : null;
}

export function siteProfilePath(domain: string): string | null {
  const key = siteProfileKey(domain);
  return key ? `/sites/${encodeURIComponent(key)}` : null;
}

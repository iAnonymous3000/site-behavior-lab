/** Stable, privacy-safe grouping and paths for public site history pages. */

import { publicRegistrableDomain } from "./redaction-v2";

export function siteProfileKey(domain: string): string | null {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized || normalized === "unknown" || normalized.includes("/") || normalized.includes("\\")) return null;
  // Validate as a hostname before handing it to the URL-backed registrable
  // domain helper; otherwise input such as "example.com/private" could be
  // parsed as a URL path and silently collapse to an unrelated profile.
  if (
    normalized.split(".").some(
      (label) =>
        label === "" ||
        (label !== "{label}" && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
  ) {
    return null;
  }

  // The shared public-boundary helper substitutes every `{label}` marker for
  // suffix parsing, so approved subdomains and any number of generalized
  // labels converge on the same registrable site without putting a marker in
  // the public route.
  const registrable = publicRegistrableDomain(normalized);
  return registrable && !registrable.includes("{") ? registrable : null;
}

export function siteProfilePath(domain: string): string | null {
  const key = siteProfileKey(domain);
  return key ? `/sites/${encodeURIComponent(key)}` : null;
}

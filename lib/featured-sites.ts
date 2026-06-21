/**
 * Types and pure helpers for the curated "Start here" gallery.
 *
 * The data lives in `public/featured-sites.json` (a single source of truth the
 * static UI fetches and `scripts/run-featured-scans.mjs` reads from disk). This
 * module intentionally does not import that JSON so the helpers stay pure and
 * unit-testable, and so the client bundle does not inline the catalog.
 */

import { isRecord } from "./guards";

export type FeaturedCategory = {
  id: string;
  label: string;
};

export type FeaturedSite = {
  domain: string;
  label: string;
  category: string;
  url: string;
};

export type FeaturedSiteConfig = {
  version: number;
  categories: FeaturedCategory[];
  sites: FeaturedSite[];
};

export function isFeaturedSiteConfig(value: unknown): value is FeaturedSiteConfig {
  if (!isRecord(value) || typeof value.version !== "number") return false;
  if (!Array.isArray(value.categories) || !value.categories.every(isFeaturedCategory)) return false;
  if (!Array.isArray(value.sites) || !value.sites.every(isFeaturedSite)) return false;
  return true;
}

/**
 * Lowercase a hostname and drop a leading `www.` and any trailing dot so a
 * curated `amazon.com` matches a scanned `www.amazon.com`.
 */
export function normalizeMatchDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * True when a scanned report's first-party domain belongs to a featured site,
 * allowing for `www.` and deeper subdomains (e.g. `m.facebook.com`).
 */
export function domainsMatch(reportDomain: string, featuredDomain: string): boolean {
  const report = normalizeMatchDomain(reportDomain);
  const featured = normalizeMatchDomain(featuredDomain);
  if (!report || !featured) return false;
  return report === featured || report.endsWith(`.${featured}`);
}

function isFeaturedCategory(value: unknown): value is FeaturedCategory {
  return isRecord(value) && typeof value.id === "string" && typeof value.label === "string";
}

function isFeaturedSite(value: unknown): value is FeaturedSite {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    typeof value.label === "string" &&
    typeof value.category === "string" &&
    typeof value.url === "string"
  );
}

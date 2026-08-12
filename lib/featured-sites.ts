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

/**
 * Why a featured site is not currently scannable, carried in the committed
 * catalog so the gallery and the featured-scan lane agree about which entries
 * are deferred and until when.
 *
 * Typed and validated HERE because the type guard the homepage runs used to
 * ignore it: 13 of 81 committed sites carry this block, the rules for it lived
 * only in scripts/, and a malformed or hand-edited entry passed
 * isFeaturedSiteConfig unnoticed and failed later, inside a workflow.
 */
export type FeaturedScanAvailability = {
  status: "temporarily-unavailable";
  reason: string;
  observedAt: string;
  reviewAfter: string;
  /**
   * Decimal STRINGS, not numbers: the producer writes `runIds.map(String)`
   * (scripts/featured-readjudication-lib.mjs:484) and every committed entry is
   * quoted. Typing these as numbers made this guard reject the shipped
   * catalog, which is how the mistake was caught.
   */
  workflowRunIds?: string[];
};

export type FeaturedSite = {
  domain: string;
  label: string;
  category: string;
  url: string;
  scanAvailability?: FeaturedScanAvailability;
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
    typeof value.url === "string" &&
    // Optional, but validated when present rather than ignored as an unknown
    // extra key. The catalog is hand-edited between automated re-adjudications,
    // and this guard is the only one the homepage runs.
    (value.scanAvailability === undefined || isFeaturedScanAvailability(value.scanAvailability))
  );
}

function isFeaturedScanAvailability(value: unknown): value is FeaturedScanAvailability {
  if (!isRecord(value)) return false;
  const allowed = new Set(["status", "reason", "observedAt", "reviewAfter", "workflowRunIds"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  return (
    value.status === "temporarily-unavailable" &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    isIsoTimestamp(value.observedAt) &&
    isIsoTimestamp(value.reviewAfter) &&
    (value.workflowRunIds === undefined ||
      (Array.isArray(value.workflowRunIds) &&
        value.workflowRunIds.every((id) => typeof id === "string" && /^[1-9][0-9]*$/.test(id))))
  );
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

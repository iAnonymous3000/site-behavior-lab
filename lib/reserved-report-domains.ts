import reservedReportDomains from "./reserved-report-domains.json";

const RESERVED_REPORT_DOMAINS = new Set(reservedReportDomains.map((domain) => domain.toLowerCase()));

/**
 * Reserved/test domains (the example.* family, localhost) are kept out of every
 * public discovery surface — the gallery manifest, `/directory/`, and
 * `sitemap.xml` — so a test fixture can never read as real evidence. Permalink
 * pages are not generated for them either, simply because no reserved-domain
 * report is committed under `public/reports/`.
 *
 * The canonical list lives in `reserved-report-domains.json`, shared with
 * `scripts/build-static-report-manifest.mjs` so the manifest builder and the app
 * cannot drift.
 */
export function isReservedReportDomain(domain: string): boolean {
  return RESERVED_REPORT_DOMAINS.has(domain.trim().toLowerCase().replace(/^www\./, ""));
}

import { buildReportHeadline } from "./report-headline";
import type { ScanReport } from "./types";

/**
 * Builds schema.org `Dataset` JSON-LD for a saved report page. A scan report is
 * a dataset of observed site behavior, so this exposes the lead finding, the
 * scanned site, the headline metrics, and a machine-readable download link to
 * search engines. Reuses {@link buildReportHeadline} so the structured-data
 * name/description match the page title, social card, and on-page headline.
 */
export function buildReportDataset(report: ScanReport, options: { url: string; jsonUrl?: string }): Record<string, unknown> {
  const result = report.reportType === "comparison" ? report.variant : report;
  const headline = buildReportHeadline(report);
  const summary = result.summary;
  const requestedUrl = report.reportType === "comparison" ? report.requestedUrl : result.conditions.requestedUrl;
  const scannedAt = report.reportType === "comparison" ? report.scannedAt : result.conditions.scannedAt;

  const dataset: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Site Behavior Lab scan of ${headline.domain}`,
    description: headline.subhead,
    url: options.url,
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "Site Behavior Lab" },
    dateCreated: scannedAt,
    datePublished: scannedAt,
    measurementTechnique: "Automated Chromium visit",
    keywords: ["web tracking", "third-party trackers", "cookies", "browser fingerprinting", headline.domain],
    about: { "@type": "WebSite", name: headline.domain, url: requestedUrl },
    variableMeasured: [
      propertyValue("Third-party requests", summary.thirdPartyRequests),
      propertyValue("Known tracker requests", summary.knownTrackerRequests),
      propertyValue("Third-party domains", summary.thirdPartyDomains),
      propertyValue("Third-party cookies", summary.thirdPartyCookies),
      propertyValue("Fingerprint-like API calls", summary.fingerprintEvents)
    ]
  };

  if (options.jsonUrl) {
    dataset.distribution = {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: options.jsonUrl
    };
  }

  return dataset;
}

function propertyValue(name: string, value: number): Record<string, unknown> {
  return { "@type": "PropertyValue", name, value };
}

import { buildReportHeadline, displayScanResult } from "./report-headline";
import type { ScanReport, ScanResult } from "./types";

/**
 * Builds schema.org `Dataset` JSON-LD for a saved report page. A scan report is
 * a dataset of observed site behavior, so this exposes the lead finding, the
 * scanned site, the headline metrics, and a machine-readable download link to
 * search engines. Reuses {@link buildReportHeadline} so the structured-data
 * name/description match the page title, social card, and on-page headline.
 */
export function buildReportDataset(report: ScanReport, options: { url: string; jsonUrl?: string }): Record<string, unknown> {
  // A comparison report's headline can describe either arm (the GPC alarm
  // quotes the GPC-on variant), so unlabeled numbers from one run would
  // silently disagree with the description. Comparisons therefore measure BOTH
  // runs with the run label in each variable name; single reports keep the
  // plain names.
  const result = displayScanResult(report);
  const headline = buildReportHeadline(report);
  const requestedUrl = report.reportType === "comparison" ? report.requestedUrl : result.conditions.requestedUrl;
  const scannedAt = report.reportType === "comparison" ? report.scannedAt : result.conditions.scannedAt;
  const variableMeasured =
    report.reportType === "comparison"
      ? [
          ...runMeasurements(report.baseline.summary, report.runLabels?.baseline ?? "baseline"),
          ...runMeasurements(report.variant.summary, report.runLabels?.variant ?? "variant")
        ]
      : runMeasurements(result.summary);

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
    variableMeasured
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

function runMeasurements(summary: ScanResult["summary"], runLabel?: string): Record<string, unknown>[] {
  const suffix = runLabel ? ` (${runLabel})` : "";
  return [
    propertyValue(`Third-party requests${suffix}`, summary.thirdPartyRequests),
    propertyValue(`Catalogued service requests${suffix}`, summary.knownTrackerRequests),
    propertyValue(`Third-party domains${suffix}`, summary.thirdPartyDomains),
    propertyValue(`Third-party cookies${suffix}`, summary.thirdPartyCookies),
    propertyValue(`Fingerprint-like API calls${suffix}`, summary.fingerprintEvents)
  ];
}

function propertyValue(name: string, value: number): Record<string, unknown> {
  return { "@type": "PropertyValue", name, value };
}

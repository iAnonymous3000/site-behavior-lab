import { buildReportHeadline } from "./report-headline";
import { comparisonArmViews, displayRunView, type ReportView, type RunView } from "./scan-report-views";

/**
 * Builds schema.org `Dataset` JSON-LD for a saved report page. A scan report is
 * a dataset of observed site behavior, so this exposes the lead finding, the
 * scanned site, the headline metrics, and a machine-readable download link to
 * search engines. Reuses {@link buildReportHeadline} so the structured-data
 * name/description match the page title, social card, and on-page headline,
 * and consumes the version-independent view so both wire generations serialize
 * identically.
 */
export function buildReportDataset(view: ReportView, options: { url: string; jsonUrl?: string }): Record<string, unknown> {
  // A comparison report's headline can describe either arm (the GPC alarm
  // quotes the GPC-on variant), so unlabeled numbers from one run would
  // silently disagree with the description. Comparisons therefore measure BOTH
  // runs with the run label in each variable name; single reports keep the
  // plain names.
  const run = displayRunView(view);
  const headline = buildReportHeadline(view);
  const arms = comparisonArmViews(view);
  // A v1 comparison's top-level requestedUrl/scannedAt were the variant run's
  // (see createComparisonReport); the view preserves both.
  const subjectRun = arms ? arms.variant : run;
  const requestedUrl = subjectRun.conditions.requestedUrl;
  const scannedAt = view.scannedAt;
  const labels = view.comparison?.runLabels;
  const variableMeasured = arms
    ? [
        ...runMeasurements(arms.baseline.counts, labels?.baseline ?? "baseline"),
        ...runMeasurements(arms.variant.counts, labels?.variant ?? "variant")
      ]
    : runMeasurements(run.counts);

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
    // v2 route shapes deliberately contain privacy placeholders such as
    // `{seg}`. They describe the measured subject but are not navigable URLs,
    // so do not publish them as schema.org WebSite.url values.
    about: {
      "@type": "WebSite",
      name: headline.domain,
      ...(!subjectRun.conditions.urlsAreRouteShapes ? { url: requestedUrl } : {})
    },
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

function runMeasurements(counts: RunView["counts"], runLabel?: string): Record<string, unknown>[] {
  const suffix = runLabel ? ` (${runLabel})` : "";
  return [
    propertyValue(`Third-party requests${suffix}`, counts.thirdPartyRequests),
    propertyValue(`Catalogued service requests${suffix}`, counts.knownTrackerRequests),
    propertyValue(`Third-party domains${suffix}`, counts.thirdPartyDomains),
    propertyValue(`Third-party cookies${suffix}`, counts.thirdPartyCookies),
    propertyValue(`Fingerprint-like API calls${suffix}`, counts.fingerprintEvents)
  ];
}

function propertyValue(name: string, value: number): Record<string, unknown> {
  return { "@type": "PropertyValue", name, value };
}

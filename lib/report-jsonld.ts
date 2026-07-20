import { buildReportHeadline } from "./report-headline";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  familyUnsupportedOnRun,
  runHitRequestRecordingCap,
  type ReportView,
  type RunView
} from "./scan-report-views";

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
        ...runMeasurements(arms.baseline, labels?.baseline ?? "baseline"),
        ...runMeasurements(arms.variant, labels?.variant ?? "variant")
      ]
    : runMeasurements(run);

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

type CountMeasurement = {
  name: string;
  value: number;
  family: "requests" | "cookies" | "fingerprinting";
};

function runMeasurements(run: RunView, runLabel?: string): Record<string, unknown>[] {
  const suffix = runLabel ? ` (${runLabel})` : "";
  const measurements: CountMeasurement[] = [
    { name: `Third-party requests${suffix}`, value: run.counts.thirdPartyRequests, family: "requests" },
    { name: `Catalogued service requests${suffix}`, value: run.counts.knownTrackerRequests, family: "requests" },
    { name: `Third-party domains${suffix}`, value: run.counts.thirdPartyDomains, family: "requests" },
    { name: `Third-party cookies${suffix}`, value: run.counts.thirdPartyCookies, family: "cookies" },
    { name: `Fingerprint-like API calls${suffix}`, value: run.counts.fingerprintEvents, family: "fingerprinting" }
  ];

  const unsupported = measurements.filter((measurement) => familyUnsupportedOnRun(run, measurement.family));
  // Cookie counts describe an end-state snapshot, not a monotonic event
  // counter. On an interrupted/failed visit that snapshot can move in either
  // direction as cookies are added or deleted, so it is not a valid minValue.
  const censoredSnapshots = measurements.filter(
    (measurement) =>
      measurement.family === "cookies" &&
      !familyUnsupportedOnRun(run, measurement.family) &&
      (run.quality.outcome === "failed" || familyCensoredOnRun(run, measurement.family))
  );
  const retained = measurements
    .filter(
      (measurement) =>
        !familyUnsupportedOnRun(run, measurement.family) && !censoredSnapshots.includes(measurement)
    )
    .map((measurement) => {
      const lowerBound = run.quality.outcome === "failed" || familyCensoredOnRun(run, measurement.family);
      return lowerBound
        ? lowerBoundProperty(measurement.name, measurement.value, lowerBoundDescription(run, measurement.family))
        : propertyValue(measurement.name, measurement.value);
    });
  const quality = qualityProperty(
    run,
    suffix,
    retained.some((entry) => "minValue" in entry),
    unsupported,
    censoredSnapshots
  );
  return quality ? [...retained, quality] : retained;
}

function propertyValue(name: string, value: number): Record<string, unknown> {
  return { "@type": "PropertyValue", name, value };
}

function lowerBoundProperty(name: string, minValue: number, description: string): Record<string, unknown> {
  return { "@type": "PropertyValue", name, minValue, description };
}

function lowerBoundDescription(run: RunView, family: CountMeasurement["family"]): string {
  if (run.quality.outcome === "failed") {
    return "Observed lower bound from a failed visit; this is not an exact total or proof of absence.";
  }
  if (runHitRequestRecordingCap(run)) {
    return "Observed lower bound before the recording cap; this is not an exact total or proof of absence.";
  }
  return `Observed lower bound because ${family} evidence was incomplete; this is not an exact total or proof of absence.`;
}

function qualityProperty(
  run: RunView,
  suffix: string,
  hasLowerBounds: boolean,
  unsupported: CountMeasurement[],
  censoredSnapshots: CountMeasurement[]
): Record<string, unknown> | null {
  if (!hasLowerBounds && unsupported.length === 0 && censoredSnapshots.length === 0) return null;

  const state =
    run.quality.outcome === "failed"
      ? "failed"
      : runHitRequestRecordingCap(run)
        ? "capped"
        : hasLowerBounds || censoredSnapshots.length > 0
          ? "incomplete"
          : "limited coverage";
  const notes: string[] = [];
  if (hasLowerBounds) notes.push("Censored counts are published as observed lower bounds, not exact totals.");
  if (unsupported.length > 0) {
    notes.push(
      `Unsupported measurements omitted: ${unsupported.map((entry) => entry.name.replace(suffix, "")).join(", ")}.`
    );
  }
  if (censoredSnapshots.length > 0) {
    notes.push(
      `Interrupted end-state snapshots omitted: ${censoredSnapshots
        .map((entry) => entry.name.replace(suffix, ""))
        .join(", ")}.`
    );
  }
  return {
    "@type": "PropertyValue",
    name: `Measurement quality${suffix}`,
    value: state,
    description: notes.join(" ")
  };
}

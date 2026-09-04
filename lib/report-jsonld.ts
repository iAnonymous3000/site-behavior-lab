import { buildReportHeadline } from "./report-headline";
import {
  buildReportFacts,
  type ReportClaimId,
  type RunFacts
} from "./report-facts";
import { safeNavigableHttpUrl } from "./report-url";
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
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  const arms = comparisonArmViews(view);
  // A v1 comparison's top-level requestedUrl/scannedAt were the variant run's
  // (see createComparisonReport); the view preserves both.
  const subjectRun = arms ? arms.variant : run;
  const reportSubjectEstablished = arms
    ? facts.sameSubject === true &&
      facts.arms?.baseline.subject.describesSubject === true &&
      facts.arms.variant.subject.describesSubject === true
    : facts.display.subject.describesSubject;
  const requestedUrl = subjectRun.conditions.requestedUrl;
  // Route shapes are flagged only on v2 wires, but the v1 redactor writes the
  // same `{seg}` / `{label}` markers into conditions.requestedUrl, so the flag
  // alone let four committed v1 reports publish a placeholder as the site's
  // URL. Apply the rule every link surface already applies: a value carrying
  // any redaction marker is not a navigable URL.
  const aboutUrlEligible =
    !subjectRun.conditions.urlsAreRouteShapes &&
    safeNavigableHttpUrl(requestedUrl) !== null &&
    urlMatchesSubjectDomain(requestedUrl, subjectRun.domain);
  const scannedAt = view.scannedAt;
  const labels = view.comparison?.runLabels;
  const variableMeasured = arms
    ? [
        ...runMeasurements(arms.baseline, facts.arms?.baseline ?? facts.runs[0], labels?.baseline ?? "baseline"),
        ...runMeasurements(arms.variant, facts.arms?.variant ?? facts.runs[1], labels?.variant ?? "variant")
      ]
    : runMeasurements(run, facts.display);

  const dataset: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: reportSubjectEstablished
      ? `Site Behavior Lab scan of ${headline.domain}`
      : `Site Behavior Lab returned-document scan while requesting ${headline.domain}`,
    description: headline.subhead,
    url: options.url,
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "Site Behavior Lab" },
    dateCreated: scannedAt,
    // Derived, never assumed. This was hard-coded to the Chromium string, so a
    // Brave PageGraph import published machine-readable structured data
    // describing an instrument that did not take the measurement. Structured
    // data is consumed by aggregators that never read the page, which makes a
    // wrong value here harder to notice and more durable than wrong prose.
    measurementTechnique: measurementTechniqueFor(run.conditions.automation),
    keywords: ["web tracking", "third-party trackers", "cookies", "browser fingerprinting", headline.domain],
    // Redacted URLs (v2 route shapes and v1 requested URLs alike) deliberately
    // contain privacy placeholders such as `{seg}`. They describe the measured
    // subject but are not navigable URLs, so do not publish them as schema.org
    // WebSite.url values.
    ...(reportSubjectEstablished
      ? {
          about: {
            "@type": "WebSite",
            name: headline.domain,
            ...(aboutUrlEligible ? { url: requestedUrl } : {})
          }
        }
      : {}),
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

/**
 * The instrument that actually produced the run, for schema.org consumers.
 *
 * A PageGraph import is a self-reported headful Brave Nightly capture adapted
 * from outside this service, which is a different instrument with different
 * evidence families, and the methodology page already says so in prose. The
 * structured data said "Automated Chromium visit" regardless.
 */
function measurementTechniqueFor(automation: string): string {
  if (automation === "brave-pagegraph") {
    return "Imported Brave PageGraph capture, self-reported";
  }
  if (automation === "external") return "Imported external capture, self-reported";
  return "Automated Chromium visit";
}

function urlMatchesSubjectDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const subject = domain.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (host === "" || subject === "" || host === "unknown" || subject === "unknown") return false;
    return host === subject || host.endsWith(`.${subject}`) || subject.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

type CountMeasurement = {
  name: string;
  value: number;
  family: "requests" | "cookies" | "fingerprinting";
  claim: ReportClaimId;
};

function runMeasurements(run: RunView, facts: RunFacts, runLabel?: string): Record<string, unknown>[] {
  const suffix = runLabel ? ` (${runLabel})` : "";
  const measurements: CountMeasurement[] = [
    {
      name: `Third-party requests${suffix}`,
      value: run.counts.thirdPartyRequests,
      family: "requests",
      claim: "third-party-services"
    },
    {
      name: `Catalogued service requests${suffix}`,
      value: run.counts.knownTrackerRequests,
      family: "requests",
      claim: "third-party-services"
    },
    {
      name: `Third-party domains${suffix}`,
      value: run.counts.thirdPartyDomains,
      family: "requests",
      claim: "third-party-services"
    },
    {
      name: `Third-party cookies${suffix}`,
      value: run.counts.thirdPartyCookies,
      family: "cookies",
      claim: "third-party-cookies"
    },
    {
      name: `Fingerprint-like API calls${suffix}`,
      value: run.counts.fingerprintEvents,
      family: "fingerprinting",
      claim: "fingerprint-apis"
    }
  ];

  const unsupported = measurements.filter((measurement) => familyUnsupportedOnRun(run, measurement.family));
  const unavailableDetectorMeasurements = measurements.filter(
    (measurement) =>
      !unsupported.includes(measurement) &&
      facts.claims[measurement.claim].blockers.includes("detector-incomplete") &&
      (!facts.claims[measurement.claim].lowerBound || measurement.value === 0)
  );
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
        !familyUnsupportedOnRun(run, measurement.family) &&
        !censoredSnapshots.includes(measurement) &&
        !unavailableDetectorMeasurements.includes(measurement)
    )
    .map((measurement) => {
      const eligibility = facts.claims[measurement.claim];
      const lowerBound =
        run.quality.outcome === "failed" ||
        familyCensoredOnRun(run, measurement.family) ||
        (!eligibility.exactCountAllowed && eligibility.lowerBound);
      return lowerBound
        ? lowerBoundProperty(
            measurement.name,
            measurement.value,
            lowerBoundDescription(run, measurement.family, measurement.claim, facts)
          )
        : propertyValue(
            measurement.name,
            measurement.value,
            facts.subject.describesSubject
              ? undefined
              : "Observed on the returned document; the requested page was not established."
          );
    });
  const quality = qualityProperty(
    run,
    suffix,
    retained.some((entry) => "minValue" in entry),
    unsupported,
    censoredSnapshots,
    unavailableDetectorMeasurements
  );
  return quality ? [...retained, quality] : retained;
}

function propertyValue(name: string, value: number, description?: string): Record<string, unknown> {
  return { "@type": "PropertyValue", name, value, ...(description ? { description } : {}) };
}

function lowerBoundProperty(name: string, minValue: number, description: string): Record<string, unknown> {
  return { "@type": "PropertyValue", name, minValue, description };
}

function lowerBoundDescription(
  run: RunView,
  family: CountMeasurement["family"],
  claim: ReportClaimId,
  facts: RunFacts
): string {
  const subjectScope = facts.subject.describesSubject
    ? ""
    : " The observations describe the returned document; the requested page was not established.";
  if (run.quality.outcome === "failed") {
    return `Observed lower bound from a failed visit; this is not an exact total or proof of absence.${subjectScope}`;
  }
  if (runHitRequestRecordingCap(run)) {
    return `Observed lower bound before the recording cap; this is not an exact total or proof of absence.${subjectScope}`;
  }
  if (facts.claims[claim].blockers.includes("detector-incomplete")) {
    return `Observed lower bound from a detector that completed only part of its measurement; this is not an exact total or proof of absence.${subjectScope}`;
  }
  return `Observed lower bound because ${family} evidence was incomplete; this is not an exact total or proof of absence.${subjectScope}`;
}

function qualityProperty(
  run: RunView,
  suffix: string,
  hasLowerBounds: boolean,
  unsupported: CountMeasurement[],
  censoredSnapshots: CountMeasurement[],
  unavailableDetectorMeasurements: CountMeasurement[]
): Record<string, unknown> | null {
  if (
    !hasLowerBounds &&
    unsupported.length === 0 &&
    censoredSnapshots.length === 0 &&
    unavailableDetectorMeasurements.length === 0
  ) {
    return null;
  }

  const state =
    run.quality.outcome === "failed"
      ? "failed"
      : runHitRequestRecordingCap(run)
        ? "capped"
        : hasLowerBounds ||
            censoredSnapshots.length > 0 ||
            unavailableDetectorMeasurements.length > 0
          ? "incomplete"
          : "limited coverage";
  const notes: string[] = [];
  if (hasLowerBounds) {
    notes.push("Incomplete monotonic counts are published as observed lower bounds, not exact totals.");
  }
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
  if (unavailableDetectorMeasurements.length > 0) {
    notes.push(
      `Unavailable detector measurements omitted: ${unavailableDetectorMeasurements
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

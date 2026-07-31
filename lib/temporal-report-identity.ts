import {
  legacyComparisonHistoryCohortFingerprint,
  legacyTemporalCohortFingerprint
} from "./comparison-decision";
import { runRequestEvidenceCapped } from "./comparison-eligibility";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { safeNavigableHttpUrl, safeParseUrl } from "./report-url";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import type { StoredScanReport } from "./scan-report-reader";
import { comparisonArmViews, displayRunView, type ReportView } from "./scan-report-view";
import { sha256Hex } from "./sha256";

const METRIC_CONTRACT_HISTORY_IDENTITY =
  `metrics-${encodeURIComponent(METRIC_CONTRACT_VERSION)}-${METRIC_CONTRACT_DIGEST}`;

/** Consent interaction state that must remain fixed across automatic history. */
export type ConsentClicks = "accept-and-reject" | "accept-only" | "reject-only" | "none";

/**
 * Derives the dispatched consent-click state from recorded interactions.
 * Classification comes from what the scanner actually clicked, never merely
 * from the requested mode.
 */
export function consentClicksForView(view: ReportView): ConsentClicks | null {
  const arms = comparisonArmViews(view);
  if (arms) {
    if (view.comparison?.axis !== "consent") return null;
    const accepted = arms.baseline.consent?.controlActivated === true;
    const rejected = arms.variant.consent?.controlActivated === true;
    if (accepted && rejected) return "accept-and-reject";
    if (accepted) return "accept-only";
    if (rejected) return "reject-only";
    return "none";
  }

  const interaction = view.runs[0]?.consent;
  if (!interaction) return null;
  if (!interaction.controlActivated) return "none";
  return interaction.mode === "accept-all" ? "accept-only" : "reject-only";
}

/**
 * Complete, versioned measurement + condition identity for automatic
 * history and retention. Null is deliberately unmatchable: two unknown
 * setups never become a cohort merely because both are unknown.
 */
export function temporalCohortForStoredReport(stored: StoredScanReport, view: ReportView): string | null {
  const run = displayRunView(view);
  if (stored.schemaVersion === 1) {
    // Redaction-v2 generalized many legacy paths. Those markers no longer
    // prove that two v1 scans visited the same page, even when the displayed
    // strings happen to match.
    if (!safeNavigableHttpUrl(run.conditions.requestedUrl) || !safeNavigableHttpUrl(run.conditions.finalUrl)) {
      return null;
    }
    const sourceRun = legacyDisplayRun(stored, view);
    const cohort = legacyTemporalCohortFingerprint(sourceRun);
    return cohort ? `v1:${cohort}:${METRIC_CONTRACT_HISTORY_IDENTITY}` : null;
  }

  const fingerprints = run.fingerprints;
  if (!fingerprints) return null;
  return (
    `v2-r${stored.schemaRevision}:${fingerprints.measurementEnvironment}:${fingerprints.condition}` +
    `:${METRIC_CONTRACT_HISTORY_IDENTITY}`
  );
}

/**
 * Relaxed, versioned cohort for descriptive passive history comparisons.
 *
 * Only visits that can support at least the tracker-classification family
 * enter this cohort. V1 keeps its reviewed compatibility fingerprint. R2
 * uses a family-specific identity matching the r2 evaluator's requirements:
 * condition vector, execution environment, methodology/observer,
 * normalization, and tracker-catalog digest. Build commits and unrelated
 * detector/adblock versions may drift because the tracker-classification
 * evaluator does not read them; every loaded pair is still re-evaluated.
 */
export function comparisonHistoryCohortForStoredReport(
  stored: StoredScanReport,
  view: ReportView
): string | null {
  const run = displayRunView(view);
  if (stored.schemaVersion === 2) {
    if (stored.schemaRevision !== 2) return null;
    if (
      !knownPublicHistorySubject(run.conditions.requestedUrl) ||
      !knownPublicHistorySubject(run.conditions.finalUrl)
    ) {
      return null;
    }
    const sourceRun = r2DisplayRun(stored);
    if (!r2TrackerHistoryEligible(sourceRun)) return null;
    return `v2-r2-comparison-history:tracker-classification:${sha256Hex(
      canonicalJson({
        condition: sourceRun.fingerprints.condition,
        methodologyVersion: sourceRun.provenance.methodologyVersion,
        observer: sourceRun.provenance.observer,
        normalizationVersion: sourceRun.toolchain.normalizationVersion,
        trackerCatalogDigest: sourceRun.toolchain.trackerCatalog.digest
      })
    )}:${METRIC_CONTRACT_HISTORY_IDENTITY}`;
  }

  if (!safeNavigableHttpUrl(run.conditions.requestedUrl) || !knownPublicHistorySubject(run.conditions.finalUrl)) {
    return null;
  }

  const sourceRun = legacyDisplayRun(stored, view);
  const status = sourceRun.summary.status;
  if (typeof status !== "number" || status < 200 || status >= 400 || runRequestEvidenceCapped(sourceRun)) {
    return null;
  }
  const cohort = legacyComparisonHistoryCohortFingerprint(sourceRun);
  return cohort
    ? `v1-comparison-history:${cohort}:${METRIC_CONTRACT_HISTORY_IDENTITY}`
    : null;
}

function r2DisplayRun(stored: Extract<StoredScanReport, { schemaVersion: 2; schemaRevision: 2 }>): ScanRunV2R2 {
  const report = stored.report;
  if (report.reportType === "single") return report.run;
  return report.experiment.kind === "temporal" ? report.variant : report.baseline;
}

function r2TrackerHistoryEligible(run: ScanRunV2R2): boolean {
  if (run.quality.run.outcome !== "complete" || run.quality.byFamily.requests.outcome !== "complete") {
    return false;
  }
  const requiredDimensions = [
    run.conditions.browser.name,
    run.conditions.browser.version,
    run.conditions.locale,
    run.conditions.language,
    run.conditions.timezone,
    run.conditions.egress.label,
    run.conditions.egress.region,
    run.conditions.automation,
    run.provenance.methodologyVersion,
    run.provenance.observer,
    run.toolchain.normalizationVersion,
    run.toolchain.trackerCatalog.digest
  ];
  return requiredDimensions.every(knownR2HistoryDimension);
}

function knownR2HistoryDimension(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.toLowerCase() !== "unknown";
}

/**
 * A final URL generalized by the managed public sanitizer is still a stable
 * observed route SHAPE for grouping (and is never made clickable). This is
 * narrower than accepting an arbitrary URL-like string: the requested URL
 * above must remain exact/navigable, and the only non-navigable form admitted
 * here is an HTTP(S) URL containing a fixed `{seg}` path or `{label}` host
 * marker.
 */
function knownPublicHistorySubject(value: string): boolean {
  if (safeNavigableHttpUrl(value)) return true;
  const parsed = safeParseUrl(value);
  return Boolean(
    parsed &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      /\{(?:seg|label)\}/.test(value) &&
      !/\{(?:invalid-url|invalid-host)\}|\[redacted/i.test(value)
  );
}

function legacyDisplayRun(stored: Extract<StoredScanReport, { schemaVersion: 1 }>, view: ReportView) {
  const report = stored.report;
  return report.reportType === "comparison"
    ? view.comparison?.temporalPair
      ? report.variant
      : report.baseline
    : report;
}

import {
  legacyComparisonHistoryCohortFingerprint,
  legacyTemporalCohortFingerprint
} from "./comparison-decision";
import { runRequestEvidenceCapped } from "./comparison-eligibility";
import { safeNavigableHttpUrl, safeParseUrl } from "./report-url";
import type { StoredScanReport } from "./scan-report-reader";
import { comparisonArmViews, displayRunView, type ReportView } from "./scan-report-view";

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
    return cohort ? `v1:${cohort}` : null;
  }

  const fingerprints = run.fingerprints;
  if (!fingerprints) return null;
  return `v2-r${stored.schemaRevision}:${fingerprints.measurementEnvironment}:${fingerprints.condition}`;
}

/**
 * Relaxed, versioned cohort for descriptive passive history comparisons.
 *
 * Only successful, uncapped v1 visits with complete classification-engine
 * provenance can enter this cohort. The underlying fingerprint holds every
 * strict temporal dimension constant except the Brave-list snapshot date.
 * v2 stays absent until its recorded fingerprints expose an equally narrow
 * family-specific history identity.
 */
export function comparisonHistoryCohortForStoredReport(
  stored: StoredScanReport,
  view: ReportView
): string | null {
  if (stored.schemaVersion !== 1) return null;
  const run = displayRunView(view);
  if (!safeNavigableHttpUrl(run.conditions.requestedUrl) || !knownPublicHistorySubject(run.conditions.finalUrl)) {
    return null;
  }

  const sourceRun = legacyDisplayRun(stored, view);
  const status = sourceRun.summary.status;
  if (typeof status !== "number" || status < 200 || status >= 400 || runRequestEvidenceCapped(sourceRun)) {
    return null;
  }
  const cohort = legacyComparisonHistoryCohortFingerprint(sourceRun);
  return cohort ? `v1-comparison-history:${cohort}` : null;
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

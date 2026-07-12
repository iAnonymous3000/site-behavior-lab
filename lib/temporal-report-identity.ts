import { legacyTemporalCohortFingerprint } from "./comparison-decision";
import { safeNavigableHttpUrl } from "./report-url";
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
    const report = stored.report;
    const sourceRun =
      report.reportType === "comparison"
        ? view.comparison?.temporalPair
          ? report.variant
          : report.baseline
        : report;
    const cohort = legacyTemporalCohortFingerprint(sourceRun);
    return cohort ? `v1:${cohort}` : null;
  }

  const fingerprints = run.fingerprints;
  if (!fingerprints) return null;
  return `v2-r${stored.schemaRevision}:${fingerprints.measurementEnvironment}:${fingerprints.condition}`;
}

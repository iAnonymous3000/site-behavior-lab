import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildStaticReportShare } from "./report-locator";
import { SeamVisitRefusal } from "./seam-visit-mark";
import type { ScanReport } from "./types";

export type PlannedPrivacyReplacement = {
  /** The current sanitizer's output for the original, share unchanged. */
  redacted: ScanReport;
  /** The redacted report with its share pointed at the replacement ID. */
  replacement: ScanReport;
  /** The exact committed bytes of the replacement report. */
  wire: string;
};

/**
 * The plan, or the one declared reason there is none: the sanitizer refused
 * the original as the result of a visit a private capture was connected to
 * (lib/seam-visit-mark.ts). A reader declines such a report first wherever
 * its own check looks; the sanitizer makes that check again on each arm of a
 * comparison, so it can refuse one a reader passed. The answer is the
 * readers': not a report. The caller holds the report's ID and names it.
 */
export type PrivacyReplacementPlan =
  | ({ ok: true } & PlannedPrivacyReplacement)
  | { ok: false; issue: "invalid-report"; detail: "invalid" };

/**
 * What a privacy replacement (docs/corrections-ledger.md) publishes for one
 * committed v1 original: the current sanitizer's output, with only the share
 * moved to the new report ID.
 *
 * `reports:remediate -- --privacy-replace` writes these bytes, and the
 * corrections history gate re-derives them from the original at its Git base,
 * so the two cannot disagree about what a redacted copy is. The gate reads the
 * sanitizer of the tree it runs in. CI runs it against the previous tip of main
 * and against the last promoted revision, and the second run re-derives every
 * privacy replacement production does not hold yet. So a replacement is correct
 * for the sanitizer of the change that removes its original, and that sanitizer
 * must not move, nor the original be newer than production, until the
 * replacement is promoted: either makes the promoted comparison fail for a
 * correct replacement, and with promotion paused it stays failed.
 */
export function planPrivacyReplacement(original: ScanReport, replacementReportId: string): PrivacyReplacementPlan {
  let redacted: ScanReport;
  try {
    redacted = redactScanReportV1(original).report;
  } catch (error) {
    if (error instanceof SeamVisitRefusal) return { ok: false, issue: "invalid-report", detail: "invalid" };
    throw error;
  }
  const replacement: ScanReport = { ...redacted, share: buildStaticReportShare(replacementReportId) };
  return { ok: true, redacted, replacement, wire: `${JSON.stringify(replacement, null, 2)}\n` };
}

import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildStaticReportShare } from "./report-locator";
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
 * What a privacy replacement (docs/corrections-ledger.md) publishes for one
 * committed v1 original: the current sanitizer's output, with only the share
 * moved to the new report ID.
 *
 * `reports:remediate -- --privacy-replace` writes these bytes, and the
 * corrections history gate re-derives them from the original at its Git base,
 * so the two cannot disagree about what a redacted copy is. The gate reads the
 * sanitizer of the tree it runs in, so it checks a replacement in the change
 * that removes its original, as CI does, not against an older base after the
 * sanitizer has moved.
 */
export function planPrivacyReplacement(original: ScanReport, replacementReportId: string): PlannedPrivacyReplacement {
  const redacted = redactScanReportV1(original).report;
  const replacement: ScanReport = { ...redacted, share: buildStaticReportShare(replacementReportId) };
  return { redacted, replacement, wire: `${JSON.stringify(replacement, null, 2)}\n` };
}

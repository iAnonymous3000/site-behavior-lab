import { plural } from "./text-format";
import type { StaticReportManifestEntry } from "./types";

/**
 * Request-derived manifest counts remain useful when collection was
 * incomplete, but they are retained lower bounds rather than exact totals.
 */
export function staticReportRequestCountLabel(
  report: StaticReportManifestEntry,
  count: number,
  singular: string,
  pluralForm = `${singular}s`
): string {
  const label = plural(count, singular, pluralForm);
  return report.requestEvidenceComplete ? label : `at least ${label}`;
}

export function staticReportRequestEvidenceStatus(
  report: StaticReportManifestEntry
): string | null {
  if (report.requestEvidenceComplete) return null;
  const reason = report.requestCapped ? "request recording capped" : "request evidence incomplete";
  return `${reason}; retained request counts are lower bounds`;
}

export function staticReportCardLabel(report: StaticReportManifestEntry): string {
  const parts = [
    staticReportRequestCountLabel(report, report.metrics.thirdPartyRequests, "third-party request"),
    staticReportRequestCountLabel(report, report.metrics.knownTrackerRequests, "catalogued service request"),
    staticReportRequestCountLabel(report, report.metrics.thirdPartyDomains, "third-party domain")
  ];
  const requestEvidenceStatus = staticReportRequestEvidenceStatus(report);
  if (requestEvidenceStatus) parts.push(requestEvidenceStatus);
  if (report.comparisonType === "shields" && (report.metrics.shieldsBlockedRequests ?? 0) > 0) {
    parts.push(
      `${staticReportRequestCountLabel(
        report,
        report.metrics.shieldsBlockedRequests ?? 0,
        "request"
      )} matched Brave Shields filter lists`
    );
  }
  return parts.join(", ");
}

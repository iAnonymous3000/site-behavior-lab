import { publishedReportCorrections } from "./published-report-corrections";
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
  const correction = publishedReportCorrections(report.id).currentSubjectEvent;
  const notices: string[] = [];
  if (correction) notices.push(`Public ${correction.state === "active" ? "clarification" : "correction"} ${correction.eventId} applies; read it with this report`);
  if (!report.requestEvidenceComplete) {
    const reason = report.requestCapped ? "request recording capped" : "request evidence incomplete";
    notices.push(`${reason}; retained request counts are lower bounds`);
  }
  return notices.length ? notices.join(". ") : null;
}

/**
 * The counts a report card carries but does not render visibly.
 *
 * Deliberately NOT staticReportCardLabel: that one restates the third-party request
 * count, the evidence status, and the Shields count, all of which the card already
 * shows. Announcing it alongside the visible text would read every one of those twice.
 * This is the additional evidence only, so the link's accessible name stays the visible
 * text plus what is genuinely missing from it.
 */
export function staticReportCardExtraEvidenceLabel(report: StaticReportManifestEntry): string {
  return [
    staticReportRequestCountLabel(report, report.metrics.knownTrackerRequests, "catalogued service request"),
    staticReportRequestCountLabel(report, report.metrics.thirdPartyDomains, "third-party domain")
  ].join(", ");
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

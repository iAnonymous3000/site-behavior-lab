import { safeNavigableHttpUrl } from "./report-url";
import { displayRunView, type ReportView } from "./scan-report-views";
import { siteProfilePath } from "./site-profile";

const EVIDENCE_ISSUE_URL = "https://github.com/iAnonymous3000/site-behavior-lab/issues/new";

export type ReportActivation = {
  profilePath: string | null;
  exactRescanHref: string | null;
  evidenceIssueUrl: string;
};

/**
 * Build the permanent-report navigation actions from the normalized public
 * view. Exact-route rescans are deliberately limited to legacy reports whose
 * already-redacted URL still identifies a real HTTP(S) page. V2 route shapes
 * contain privacy markers and must never become navigation targets.
 */
export function reportActivation(input: {
  id: string;
  reportUrl: string;
  siteHistoryAvailable: boolean;
  view: ReportView;
}): ReportActivation {
  const run = displayRunView(input.view);
  const exactTarget = run.conditions.urlsAreRouteShapes
    ? null
    : safeNavigableHttpUrl(run.conditions.requestedUrl);

  return {
    profilePath: input.siteHistoryAvailable ? siteProfilePath(input.view.domain) : null,
    exactRescanHref: exactTarget ? `/?url=${encodeURIComponent(exactTarget)}#scan` : null,
    evidenceIssueUrl: evidenceProblemUrl({
      id: input.id,
      domain: input.view.domain,
      reportUrl: input.reportUrl,
      scannedAt: input.view.latestRunAt ?? input.view.scannedAt
    })
  };
}

/**
 * A prefilled, report-specific correction path. URLSearchParams owns all
 * escaping so stored report text can never splice extra issue parameters.
 */
export function evidenceProblemUrl(input: {
  id: string;
  domain: string;
  reportUrl: string;
  scannedAt: string | null;
}): string {
  const reportId = oneLine(input.id) || "not recorded";
  const domain = oneLine(input.domain) || "report";
  const reportUrl = oneLine(input.reportUrl);
  const params = new URLSearchParams({
    template: "evidence-problem.yml",
    title: `Evidence review: ${domain} (${reportId})`,
    // GitHub issue-form fields are prefilled by their YAML ids. Keep the
    // report identity useful even when a caller has only the id, while adding
    // the public URL when one was supplied.
    report: reportUrl ? `${reportId} — ${reportUrl}` : reportId,
    scan_date: formatIssueDate(input.scannedAt)
  });
  return `${EVIDENCE_ISSUE_URL}?${params.toString()}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t`]/g, " ").replace(/\s+/g, " ").trim();
}

function formatIssueDate(value: string | null): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "not recorded" : parsed.toISOString();
}

import { reportRescanTargets } from "./report-rescan-targets";
import { scanPrefillHref } from "./scan-prefill";
import { displayRunView, type ReportView } from "./scan-report-views";
import { corpusSiteKeyForRun } from "./corpus-site-domain";
import { siteProfilePath } from "./site-profile";

const EVIDENCE_ISSUE_URL = "https://github.com/iAnonymous3000/site-behavior-lab/issues/new";

export type ReportActivation = {
  profilePath: string | null;
  exactRescanHref: string | null;
  /**
   * Site-root rescan for reports whose exact route cannot be replayed. Without
   * it a v2 permalink renders no rescan control at all, while its own copy tells
   * the reader to repeat the visit.
   */
  siteRescanHref: string | null;
  evidenceIssueUrl: string;
};

/**
 * Build the permanent-report navigation actions from the normalized public
 * view. Exact-route rescans are deliberately limited to legacy reports whose
 * already-redacted URL still identifies a real HTTP(S) page. V2 route shapes
 * contain privacy markers and must never become navigation targets; the
 * targets come from lib/report-rescan-targets.ts, which a findings card's new
 * visit reads too.
 */
export function reportActivation(input: {
  id: string;
  reportUrl: string;
  siteHistoryAvailable: boolean;
  view: ReportView;
}): ReportActivation {
  const { exactTarget, siteTarget } = reportRescanTargets(input.view);

  return {
    profilePath: reportSiteProfilePath(input.view, input.siteHistoryAvailable),
    exactRescanHref: exactTarget ? scanPrefillHref(exactTarget) : null,
    siteRescanHref: siteTarget ? scanPrefillHref(siteTarget) : null,
    evidenceIssueUrl: evidenceProblemUrl({
      id: input.id,
      domain: input.view.domain,
      reportUrl: input.reportUrl,
      scannedAt: input.view.latestRunAt ?? input.view.scannedAt
    })
  };
}

/**
 * The site history page a report is listed under, or null when it has none:
 * the report is not in the public corpus, or its visit was asked for a
 * generalized host. The history page lists a report only under the site the
 * corpus keys it to, and keys a visit asked for a generalized host to none.
 */
export function reportSiteProfilePath(view: ReportView, siteHistoryAvailable: boolean): string | null {
  const siteKey = corpusSiteKeyForRun(displayRunView(view));
  return siteHistoryAvailable && siteKey ? siteProfilePath(siteKey) : null;
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
    report: reportUrl ? `${reportId} (${reportUrl})` : reportId,
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

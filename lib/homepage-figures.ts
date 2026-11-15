import { comparisonVisitOrderLine } from "./comparison-visit-order";
import type { CorpusStats } from "./corpus-stats";
import { publishedReportCorrections } from "./published-report-corrections";
import { renderedEvidenceArm } from "./report-evidence-navigation";
import { buildReportFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
import { buildReportHeadline, publishedClarificationNotice } from "./report-headline";
import { formatReportTimestamp } from "./report-visit-summary";
import { notMeasuredLeads } from "./visit-limits";
import { buildRequestFigure, type RequestFigure } from "./request-figure";
import { degradedRunNotice } from "./scan-report-censorship";
import type { StoredScanReport } from "./scan-report-reader";
import { displayRunView, runLoadedSuccessfully, runVisitLabel, toReportView, type ReportView } from "./scan-report-views";
import { displayHost } from "./text-format";

/**
 * What the homepage draws from a committed report: the front-page record of
 * the latest report, and the marks beside each site on record.
 *
 * Both show one report among others, so both are about ONE visit: the visit
 * the report's headline describes. The record's date, its finding sentence
 * and its figure all belong to that visit, and a comparison's other visit is
 * not drawn here (the report's own page draws it where its claim policy
 * allows). Every count comes from the report figure's builder, so the
 * homepage cannot draw more or fewer marks than the report page does for the
 * same visit.
 *
 * Which report is the record is not decided here: the caller passes the
 * report the homepage's "Open latest report" link already opens
 * (lib/homepage-discovery.ts).
 */

/**
 * The phrases of a figure's "Not measured" row: the visit summary's limit
 * leads, without their full stop. Built by lib/visit-limits.ts, the module
 * the visit summary builds its limits from, so a result elsewhere states the
 * same row from the same source.
 */
export const notMeasuredPhrases = notMeasuredLeads;

function describedVisit(view: ReportView) {
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  const evidenceArm = renderedEvidenceArm(view, headline);
  const figure = buildRequestFigure(view, facts, evidenceArm, { describedVisitOnly: true });
  return { facts, headline, evidenceArm, figure };
}

export type FrontPageRecord = {
  reportId: string;
  /** The report's view, for facts the page states from it (its format note). */
  view: ReportView;
  site: string;
  /** The label of the visit the date belongs to, as the report page's record names it. */
  visitLabel: string;
  startedAt: string | null;
  startedText: string;
  /** The report's finding sentence, as worded on its page. */
  headline: string;
  /** The headline's own limit. */
  caveat: string;
  /**
   * The compact notice of a published clarification that applies, or null.
   * The share card's compact subhead, from the same function.
   */
  clarification: string | null;
  /** The incomplete-visit notice the report page prints, or null on a complete report. */
  incompleteNotice: string | null;
  /** The comparison's visit-order line, or null. */
  visitOrder: { text: string; seeMethodology: boolean } | null;
  /** The described visit's figure: exactly one visit. */
  figure: RequestFigure;
  notMeasured: string[];
};

/**
 * The front-page record for a report, or null when the page must not show
 * one. There is no placeholder: with null the homepage is the same page
 * without the record.
 *
 * Null when the report is withheld by a published correction (its findings
 * summary is withheld on its own page too), when the described visit did not
 * load (runLoadedSuccessfully, the rule the library's coverage counts use), or
 * when that visit has no figure to
 * draw (its producer captured no request evidence).
 */
export function buildFrontPageRecord(
  reportId: string,
  stored: StoredScanReport,
  corpusStats: CorpusStats | null
): FrontPageRecord | null {
  return buildFrontPageRecordFromView(reportId, toReportView(stored), corpusStats);
}

/** The same decision from a view, the seam the tests use to state each refusal. */
export function buildFrontPageRecordFromView(
  reportId: string,
  view: ReportView,
  corpusStats: CorpusStats | null
): FrontPageRecord | null {
  if (publishedReportCorrections(reportId).suppressIndexing) return null;
  const run = displayRunView(view);
  if (!runLoadedSuccessfully(run)) return null;
  const { facts, headline, evidenceArm, figure } = describedVisit(view);
  if (figure.visits.length !== 1 || figure.visits[0].rows.length === 0) return null;
  const findings = buildFindings(view, corpusStats, facts, evidenceArm);
  const started = run.startedAt ?? view.scannedAt;
  return {
    reportId,
    view,
    site: displayHost(run.domain),
    visitLabel: runVisitLabel(run),
    startedAt: started ?? null,
    startedText: formatReportTimestamp(started),
    headline: headline.headline,
    caveat: headline.caveat,
    clarification: publishedClarificationNotice(reportId),
    incompleteNotice: degradedRunNotice(view),
    visitOrder: view.comparison
      ? comparisonVisitOrderLine(view.comparison.visitOrder, view.comparison.runLabels)
      : null,
    figure,
    notMeasured: notMeasuredPhrases({ view, facts, findings, evidenceArm })
  };
}

export type SiteRowMarks = {
  /** Retained request rows that stayed on the site. */
  site: number;
  /** Retained request rows that went to another site, catalogued or not. */
  crossSite: number;
  /** True when the retained rows are a lower bound on what the visit requested. */
  lowerBound: boolean;
};

/**
 * The marks beside a site on record: the described visit's retained request
 * rows, same-site and cross-site, from the report figure's own rows. Null
 * when that visit has no figure to draw, so the row draws no marks.
 */
export function buildSiteRowMarks(stored: StoredScanReport): SiteRowMarks | null {
  const { figure } = describedVisit(toReportView(stored));
  const visit = figure.visits[0];
  if (figure.visits.length !== 1 || visit.rows.length === 0) return null;
  const count = (kind: string) => visit.rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.count, 0);
  return { site: count("site"), crossSite: count("catalogued") + count("unnamed"), lowerBound: visit.lowerBound };
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import corrections from "@/public/corrections.json";
import { comparisonVisitOrderLine } from "@/lib/comparison-visit-order";
import { buildReportHeadline, reportPageTitle } from "@/lib/report-headline";
import { buildReportFacts } from "@/lib/report-facts";
import { bottomLineBenchmarkScope, buildFindings } from "@/lib/report-findings";
import { renderedEvidenceArm } from "@/lib/report-evidence-navigation";
import { loadCommittedCorpusStats } from "@/lib/current-scan-cohort";
import { parseCorrectionsLedger, reportCorrections } from "@/lib/corrections-ledger";
import { serializeJsonLd } from "@/lib/jsonld-script";
import { buildReportDataset } from "@/lib/report-jsonld";
import { reportPdfExportQuery } from "@/lib/report-pdf-export-query";
import { reportNewVisitFrom, reportNewVisitTarget } from "@/lib/report-rescan-targets";
import { siteHistoryLookCloserHref } from "@/lib/report-site-history";
import { readStoredReportForId } from "@/lib/report-source";
import { buildReportVisitSummary } from "@/lib/report-visit-summary";
import { scrollCheckEntry } from "@/lib/scroll-check-entry";
import { requireFreshRuntimeReportRequest } from "@/lib/report-route-freshness";
import { degradedRunNotice } from "@/lib/scan-report-censorship";
import { correctionMetadataDescription, reportMetadataDescription, reportMetadataTitle } from "@/lib/seo-metadata";
import { toReportView } from "@/lib/scan-report-views";
import { siteBaseUrl, siteOrigin, sitePagesBasePath } from "@/lib/site-url";
import { buildDomainEvidenceTable } from "@/lib/domain-evidence-table";
import { notMeasuredPhrases } from "@/lib/homepage-figures";
import { buildRequestFigure } from "@/lib/request-figure";
import { EvidenceTable } from "@/app/_design/evidence-table";
import {
  RecordDateline,
  ReportRecord,
  ReportRecordLinks,
  schemaNotePlacement
} from "@/app/_design/record-block";
import { RequestFigure } from "@/app/_design/request-figure";
import { ReportPageSummary } from "@/app/_design/report-summary";
import { PrintEvidenceFooter } from "@/app/_components/print-evidence-footer";
import {
  ReportEvidenceReceipt,
  ReportPageContext
} from "@/app/_components/report-page-context";
import { ReportVisitSummaryBlock } from "@/app/_components/report-visit-summary-block";
import { SavedReportClient } from "./saved-report-client";
// Direction A: tokens, base, components, then this page's layout. Scoped to
// the .da shell this route renders, so no other route is restyled.
import "@/app/_design/fonts.css";
import "@/app/_design/tokens.css";
import "@/app/_design/base.css";
import "@/app/_design/components.css";
import "@/app/_design/report.css";
import "@/app/_design/explorer.css";

const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";
const correctionsLedger = parseCorrectionsLedger(corrections);
// React cache is scoped to this server render: metadata and the page share one
// store read, while requireFreshRuntimeReportRequest still starts a fresh
// render/store expiry check for every HTTP request.
const readStoredReportForRequest = cache((id: string) => readStoredReportForId(id));

// The isolated Pages build replaces this declaration and injects static params
// in its copied worktree. Runtime source intentionally has no
// generateStaticParams export: every request must re-read the store so its
// immutable expiry cannot be bypassed by Next's Full Route Cache.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await requireFreshRuntimeReportRequest();
  const { id } = await params;
  const result = await readStoredReportForRequest(id);

  if (result.outcome !== "found") {
    return {
      title: { absolute: "Report not found · Site Behavior Lab" },
      description: "This Site Behavior Lab report is unavailable.",
      alternates: { canonical: null },
      robots: { index: false, follow: false }
    };
  }

  // The headline builds from the version-independent view, so the metadata
  // works for any readable schema generation, matching the view-based client
  // renderer below.
  const view = toReportView(result.stored);
  const headline = buildReportHeadline(view);
  const correction = reportCorrections(correctionsLedger, id);
  const title = reportMetadataTitle({
    domain: headline.domain,
    reportId: id,
    scannedAt: view.scannedAt,
    reportType: view.reportType,
    comparisonAxis: view.comparison?.axis
  });
  const description = correction.currentSubjectEvent
    ? correctionMetadataDescription(correction.currentSubjectEvent.state)
    : reportMetadataDescription(headline);
  const reportUrl = publicReportUrl(id);

  return {
    title,
    description,
    alternates: { canonical: STATIC_EXPORT ? reportUrl : null },
    robots: STATIC_EXPORT && !correction.suppressIndexing
      ? { index: true, follow: true }
      : { index: false, follow: true, noarchive: true },
    openGraph: {
      title,
      description,
      type: "article",
      // Runtime shares are noindex and have no canonical, but their social
      // unfurl still needs the exact report URL rather than the scanner root.
      url: reportUrl
    },
    twitter: {
      card: "summary_large_image",
      title,
      description
    }
  };
}

export default async function SavedReportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireFreshRuntimeReportRequest();
  const { id } = await params;
  const result = await readStoredReportForRequest(id);
  // A nonexistent report must answer HTTP 404, not a 200 shell whose client
  // then renders a soft "not found": crawlers and uptime checks read the
  // status code. (Static-export builds only prerender committed ids, which
  // always resolve, so this fires on the dynamic server.)
  if (result.outcome === "not-found") notFound();
  // A report the server HOLDS but cannot read must answer 500, not 404:
  // corrupt bytes are a data fault and a newer schema is a capability gap,
  // and both deserve a visible error over a false "does not exist".
  if (result.outcome === "unreadable") {
    throw new Error(
      result.error === "unsupported-version" || result.error === "unsupported-revision"
        ? `Report ${id} was written by a newer scanner version; this deployment cannot render it yet.`
        : `Report ${id} exists but its stored data is unreadable (${result.error}).`
    );
  }
  // Every readable generation renders through the view-based client below
  // (RFC 14.8 atomic consumer migration); unreadable and newer-revision
  // reports were already answered above.
  const view = toReportView(result.stored);
  // The same facts, headline, arm and cards the explorer builds once it has
  // fetched the wire, built here from the view the server already holds and
  // the committed corpus statistics, so the reader who never presses
  // "Explore full evidence" still gets the board. Both surfaces go through
  // one buildFindings call, so they cannot disagree about a card.
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  const evidenceArm = renderedEvidenceArm(view, headline);
  const findings = buildFindings(view, await loadCommittedCorpusStats(), facts, evidenceArm);
  // A runtime share is a live scan's fresh result, the only report whose
  // cards may offer a new visit; a committed report's site already holds the
  // corpus evidence. The summary board and the explorer read the same value,
  // so both boards offer the same follow-ups, each naming this share.
  const freshResult = result.origin === "share-store";
  const newVisitTarget = reportNewVisitTarget(view, freshResult);
  const newVisitFrom = reportNewVisitFrom(view, freshResult);
  // What was checked and what the visit could not see, for the board to render
  // directly after its bottom line. Built once, from the cards the board shows,
  // and handed to both the summary and the explorer, so it stays in place when
  // the explorer replaces the summary. A fresh result's also offers "Check
  // after scrolling" on its after-interaction limit, for the same page and
  // share as the board's other follow-ups.
  const visitSummary = (
    <ReportVisitSummaryBlock
      summary={buildReportVisitSummary({
        view,
        facts,
        findings,
        evidenceArm,
        scrollCheckEntry: scrollCheckEntry({ view, facts, newVisitTarget, newVisitFrom, basePath: sitePagesBasePath() })
      })}
    />
  );
  // The cookie card's Look closer view opens this site's history, offered only
  // where that page lists another report for the site. Counting them reads the
  // whole committed corpus (measured at 12.6 s and 450 MB cold, October 2026):
  // a build-time cost in the static export, where every committed permalink is
  // generated, but a request-time one on a runtime server, so a runtime-served
  // report offers no history view. The same value reaches the explorer's
  // board, so both boards offer the same views.
  const siteHistoryHref = STATIC_EXPORT
    ? await siteHistoryLookCloserHref({ id, view, committed: result.origin === "committed" })
    : null;
  // The figure draws the visit the headline describes, and both visits only
  // where the claim policy allows the pair to be compared. Its "not measured"
  // row repeats the leads of the visit summary's limits, and the domain table
  // excerpts the same visit, so the three cannot describe different visits.
  const figure = buildRequestFigure(view, facts, evidenceArm);
  const notMeasured = notMeasuredPhrases({ view, facts, findings, evidenceArm });
  const tableFacts = evidenceArm && facts.arms ? facts.arms[evidenceArm] : facts.display;
  const domainTable = buildDomainEvidenceTable(
    tableFacts,
    evidenceArm && view.comparison ? view.comparison.runLabels[evidenceArm] : null
  );
  const correction = reportCorrections(correctionsLedger, id);
  const reportUrl = publicReportUrl(id);
  const jsonUrl = STATIC_EXPORT ? `${siteBaseUrl()}/reports/${id}.json` : `${siteOrigin()}/api/reports/${id}`;
  const evidenceHref = STATIC_EXPORT ? `${sitePagesBasePath()}/reports/${id}.json` : `/api/reports/${id}`;
  const dataset = correction.suppressIndexing
    ? null
    : buildReportDataset(view, {
        url: reportUrl,
        jsonUrl
      });

  // The record's three links, after the numbers.
  const recordLinks = (
    <ReportRecordLinks id={id} permanent={result.origin === "committed"} reportUrl={reportUrl} view={view} />
  );

  return (
    <>
      {dataset && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(dataset) }} />
      )}
      <SavedReportClient
        id={id}
        evidenceHref={evidenceHref}
        expectedEvidenceSha256={result.wireSha256}
        pdfExportQuery={reportPdfExportQuery(id, result.wireSha256)}
        siteHistoryHref={siteHistoryHref}
        freshResult={freshResult}
        summaryBenchmarkScope={bottomLineBenchmarkScope(findings) ?? null}
        title={reportPageTitle(headline)}
        context={
          <ReportPageContext
            id={id}
            corrections={correction}
            permanent={result.origin === "committed"}
            identity={<ReportRecord evidenceSha256={result.wireSha256} id={id} view={view} />}
            omitIncompleteNotice
            reportUrl={reportUrl}
            view={view}
          />
        }
        receipt={
          <ReportEvidenceReceipt
            benchmarkScope={bottomLineBenchmarkScope(findings)}
            evidenceSha256={result.wireSha256}
            id={id}
            jsonHref={jsonUrl}
            permanent={result.origin === "committed"}
            provenanceHref={
              result.origin === "committed" ? `${siteBaseUrl()}/reports/${id}.provenance.json` : null
            }
            view={view}
          />
        }
        summary={
          <ReportPageSummary
            basePath={sitePagesBasePath()}
            headline={headline}
            dateline={<RecordDateline view={view} />}
            incompleteNotice={degradedRunNotice(view)}
            schemaLimit={schemaNotePlacement(view).limit}
            recordLinks={recordLinks}
            findings={findings}
            evidenceArm={evidenceArm}
            automation={facts.display.run.conditions.automation}
            visitOrder={
              view.comparison
                ? comparisonVisitOrderLine(view.comparison.visitOrder, view.comparison.runLabels)
                : null
            }
            siteHistoryHref={siteHistoryHref}
            newVisitTarget={newVisitTarget}
            newVisitFrom={newVisitFrom}
            visitSummary={visitSummary}
            figure={<RequestFigure figure={figure} notMeasured={notMeasured} />}
            domainTable={<EvidenceTable table={domainTable} />}
          />
        }
        visitSummary={visitSummary}
      />
      <PrintEvidenceFooter
        committed={result.origin === "committed"}
        id={id}
        reportUrl={reportUrl}
        wireSha256={result.wireSha256}
      />
    </>
  );
}

function publicReportUrl(id: string): string {
  return `${siteBaseUrl()}/reports/${id}${STATIC_EXPORT ? "/" : ""}`;
}

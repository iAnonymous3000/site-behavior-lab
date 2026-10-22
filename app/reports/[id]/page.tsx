import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";
import corrections from "@/public/corrections.json";
import { comparisonVisitOrderLine } from "@/lib/comparison-visit-order";
import { buildReportHeadline, reportPageTitle, type ReportHeadline } from "@/lib/report-headline";
import { buildReportFacts } from "@/lib/report-facts";
import { buildFindings, type Finding } from "@/lib/report-findings";
import { renderedEvidenceArm, type EvidenceArm } from "@/lib/report-evidence-navigation";
import { loadCommittedCorpusStats } from "@/lib/current-scan-cohort";
import { parseCorrectionsLedger, reportCorrections } from "@/lib/corrections-ledger";
import { serializeJsonLd } from "@/lib/jsonld-script";
import { buildReportDataset } from "@/lib/report-jsonld";
import { reportPdfExportQuery } from "@/lib/report-pdf-export-query";
import { reportNewVisitFrom, reportNewVisitTarget } from "@/lib/report-rescan-targets";
import { siteHistoryLookCloserHref } from "@/lib/report-site-history";
import { readStoredReportForId } from "@/lib/report-source";
import { buildReportVisitSummary } from "@/lib/report-visit-summary";
import { requireFreshRuntimeReportRequest } from "@/lib/report-route-freshness";
import { correctionMetadataDescription, reportMetadataDescription, reportMetadataTitle } from "@/lib/seo-metadata";
import { toReportView } from "@/lib/scan-report-views";
import { siteBaseUrl, siteOrigin, sitePagesBasePath } from "@/lib/site-url";
import { FindingsList } from "@/app/_components/findings-list";
import { PrintEvidenceFooter } from "@/app/_components/print-evidence-footer";
import { ReportEvidenceReceipt, ReportPageContext } from "@/app/_components/report-page-context";
import { ReportVisitSummaryBlock } from "@/app/_components/report-visit-summary-block";
import { SavedReportClient } from "./saved-report-client";

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
  // What was checked and what the visit could not see, for the board to render
  // directly after its bottom line. Built once, from the cards the board shows,
  // and handed to both the summary and the explorer, so it stays in place when
  // the explorer replaces the summary.
  const visitSummary = (
    <ReportVisitSummaryBlock summary={buildReportVisitSummary({ view, facts, findings, evidenceArm })} />
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
  // A runtime share is a live scan's fresh result, the only report whose
  // cards may offer a new visit; a committed report's site already holds the
  // corpus evidence. The summary board and the explorer read the same value,
  // so both boards offer the same follow-ups, each naming this share.
  const freshResult = result.origin === "share-store";
  const newVisitTarget = reportNewVisitTarget(view, freshResult);
  const newVisitFrom = reportNewVisitFrom(view, freshResult);
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
        title={reportPageTitle(headline)}
        context={
          <ReportPageContext
            id={id}
            corrections={correction}
            permanent={result.origin === "committed"}
            reportUrl={reportUrl}
            view={view}
          />
        }
        receipt={
          <ReportEvidenceReceipt
            benchmarkScope={findings.find((finding) => finding.id === "bottom-line")?.benchmarkScope}
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
            headline={headline}
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

/**
 * Compact, crawlable report content. Raw evidence arrays stay server-side.
 *
 * The site, the requested URL, the run quality and the timestamp used to be
 * restated here as a second header. The site, the address and the timestamp
 * now live once, in the always-rendered `ReportPageContext` identity block,
 * and the run quality in the receipt, so opening the evidence explorer no
 * longer swaps one copy of those facts for another. The visit summary the
 * board renders after its bottom line is handed to the explorer too, for the
 * same reason.
 *
 * A comparison's visit-order line is the exception, on purpose. The comparison
 * panel states it in the explorer, the printable route and the PDF, and the
 * identity block and the receipt stay beside that panel once the explorer
 * opens and on the printable route, so either of them would state the line
 * twice. This summary is the one block the explorer replaces, so the line is
 * stated once in every state.
 */
function ReportPageSummary({
  headline,
  findings,
  evidenceArm,
  automation,
  visitOrder,
  visitSummary,
  siteHistoryHref,
  newVisitTarget,
  newVisitFrom
}: {
  headline: ReportHeadline;
  findings: readonly Finding[];
  evidenceArm: EvidenceArm | undefined;
  automation: string;
  /** The comparison's visit-order line; null for a single scan or a before/after pair. */
  visitOrder: ReturnType<typeof comparisonVisitOrderLine>;
  /** What was checked and what the visit could not see, after the bottom line. */
  visitSummary: ReactNode;
  /** The cookie card's history view target, the same value the explorer receives. */
  siteHistoryHref: string | null;
  /** The page a card's new visit would visit again, a runtime share's only. */
  newVisitTarget: string | null;
  /** The share report id a new visit's link names, a runtime share's own. */
  newVisitFrom: string | null;
}) {
  return (
    <div className="report-page-summary">
      <section className={`headline-banner tone-${headline.tone}`} aria-label="Plain-language summary">
        <p className="headline-kicker">{headline.kicker}</p>
        <h2 className="headline-title">{headline.headline}</h2>
        <p className="headline-subhead">{headline.subhead}</p>
        {headline.stats.length > 0 && (
          <div className="headline-stats">
            {headline.stats.map((stat) => (
              <div className={`headline-stat${stat.emphasis ? " is-emphasis" : ""}`} key={stat.label}>
                <span className="headline-stat-value">{stat.value}</span>
                <span className="headline-stat-label">{stat.label}</span>
              </div>
            ))}
          </div>
        )}
        <div className="headline-footer">
          <span className="headline-caveat">{headline.caveat}</span>
          {/* Same text and link as the comparison panel's line, which
              replaces this one when the explorer opens. */}
          {visitOrder && (
            <span className="headline-visit-order">
              {visitOrder.text}
              {visitOrder.seeMethodology && (
                <>
                  {" "}(see <a href={`${sitePagesBasePath()}/methodology/#comparisons`}>Methodology</a>)
                </>
              )}
            </span>
          )}
        </div>
      </section>
      <FindingsList
        findings={findings}
        evidenceArm={evidenceArm}
        automation={automation}
        glossaryHref={`${sitePagesBasePath()}/glossary/`}
        afterBottomLine={visitSummary}
        lookCloser={{ siteHistoryHref, newVisitTarget, newVisitFrom, basePath: sitePagesBasePath() }}
      />
    </div>
  );
}

function publicReportUrl(id: string): string {
  return `${siteBaseUrl()}/reports/${id}${STATIC_EXPORT ? "/" : ""}`;
}

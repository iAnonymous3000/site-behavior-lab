import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import corrections from "@/public/corrections.json";
import { buildReportHeadline, reportPageTitle } from "@/lib/report-headline";
import { parseCorrectionsLedger, reportCorrections } from "@/lib/corrections-ledger";
import { readStoredReportForId } from "@/lib/report-source";
import { requireFreshRuntimeReportRequest } from "@/lib/report-route-freshness";
import { loadedReportFromStored } from "@/lib/scan-report-view";
import { toReportView } from "@/lib/scan-report-views";
import { siteBaseUrl, siteOrigin } from "@/lib/site-url";
import { PrintEvidenceFooter } from "@/app/_components/print-evidence-footer";
import { ReportEvidenceReceipt, ReportPageContext } from "@/app/_components/report-page-context";
import { ReportRenderer } from "@/app/_components/report-renderer";

/**
 * The complete printable rendering of one report.
 *
 * The interactive route cannot be this page. It mounts its evidence explorer
 * lazily so a report permalink stays inside its initial-JS budget, which means
 * a browser print of it carries the summary and the receipt and none of the
 * request rows. CSS cannot fix that: a print rule cannot un-hide a node React
 * never rendered.
 *
 * So this route renders the whole thing eagerly and server-side, with
 * `printComplete` set, and the reader prints THIS. It is deliberately not
 * linked from a crawlable surface, carries `noindex`, and canonicalises to the
 * interactive report.
 *
 * Container-only by construction: `scripts/build-github-pages.mjs` lists this
 * directory in `serverOnlyAppDirs`, so the static export never contains it.
 * Prerendering it would render full evidence eagerly for every committed
 * report and inline each report's payload into the RSC flight stream on top of
 * the markup. Nobody has measured what that costs, and an estimate is worthless
 * here because a printComplete page is not comparable to the summary page the
 * current export measures.
 *
 * The overrun would now be CAUGHT rather than silently published:
 * `scripts/smoke-static-site.mjs` bounds the whole export (318 MB against a
 * 700 MB ceiling at the time of writing). So the remaining blocker is one
 * measured `npm run build:pages && npm run test:smoke:static` with the
 * `serverOnlyAppDirs` entry removed and this route added to
 * `runtimeReportRouteFiles`, not the absence of a gate.
 * `lib/print-route-contract.test.ts` holds the container-only arrangement in
 * place and must be updated in the same change.
 */

const correctionsLedger = parseCorrectionsLedger(corrections);
const readStoredReportForRequest = cache((id: string) => readStoredReportForId(id));

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: { absolute: `Printable report ${id} · Site Behavior Lab` },
    // States no visit count. This runs before the report is read, so it cannot
    // tell a single scan from a two-visit comparison, and it used to assert
    // "one recorded visit" over both.
    description: "A complete printable rendering of the recorded evidence.",
    // The interactive report is the citable URL; this rendering must never
    // compete with it in an index or a share card.
    alternates: { canonical: `${siteBaseUrl()}/reports/${id}/` },
    robots: { index: false, follow: false }
  };
}

export default async function PrintableReportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireFreshRuntimeReportRequest();
  const { id } = await params;
  const result = await readStoredReportForRequest(id);

  if (result.outcome === "not-found") notFound();
  if (result.outcome === "unreadable") {
    throw new Error(
      result.error === "unsupported-version" || result.error === "unsupported-revision"
        ? `Report ${id} was written by a newer scanner version; this deployment cannot render it yet.`
        : `Report ${id} exists but its stored data is unreadable (${result.error}).`
    );
  }

  const view = toReportView(result.stored);
  const headline = buildReportHeadline(view);
  const correction = reportCorrections(correctionsLedger, id);
  const committed = result.origin === "committed";
  const reportUrl = `${siteBaseUrl()}/reports/${id}/`;
  const jsonUrl = `${siteOrigin()}/api/reports/${id}`;

  return (
    <div className="app-shell report-page-shell">
      <main aria-label={reportPageTitle(headline)}>
        {/* The context block carries this page's one <h1> (the site), matching
            the interactive route. It used to render a second heading here with
            the headline sentence, which the banner then repeated verbatim. */}
        <ReportPageContext
          id={id}
          corrections={correction}
          permanent={committed}
          reportUrl={reportUrl}
          view={view}
        />
        {/* Statically imported, unlike the interactive route's lazy boundary:
            being complete is the entire point of this page. */}
        <ReportRenderer
          loaded={loadedReportFromStored(result.stored)}
          liveApiServesReportPages={false}
          printComplete
        />
        {/* Provenance follows the evidence it certifies, as on the interactive
            route, so a printed report reads in the same order as the screen. */}
        <ReportEvidenceReceipt
          id={id}
          jsonHref={jsonUrl}
          permanent={committed}
          provenanceHref={committed ? `${siteBaseUrl()}/reports/${id}.provenance.json` : null}
          reportUrl={reportUrl}
          view={view}
        />
        {/* This route renders no .app-footer, so the standing scope caveat the
            print stylesheet rescues there has to be stated here directly. */}
        <p className="app-footer-caveat">
          Reports record one automated visit per condition; visits may be incomplete. Results describe these visits,
          not everything a site can do.
        </p>
      </main>
      <PrintEvidenceFooter
        committed={committed}
        id={id}
        reportUrl={reportUrl}
        wireSha256={result.wireSha256}
      />
    </div>
  );
}

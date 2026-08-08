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
import { ReportPageContext } from "@/app/_components/report-page-context";
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
 * Serving 574 committed reports as eagerly-rendered evidence pages would add an
 * unmeasured multiple of the export's current size, and there is no total-size
 * gate to catch the overrun yet. `lib/print-route-contract.test.ts` holds that
 * arrangement in place; moving it onto Pages is one line plus a measured build.
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
    description: "A complete printable rendering of one recorded visit.",
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
      <main>
        <h1>{reportPageTitle(headline)}</h1>
        <ReportPageContext
          id={id}
          corrections={correction}
          jsonHref={jsonUrl}
          permanent={committed}
          provenanceHref={committed ? `${siteBaseUrl()}/reports/${id}.provenance.json` : null}
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
        {/* This route renders no .app-footer, so the standing scope caveat the
            print stylesheet rescues there has to be stated here directly. */}
        <p className="app-footer-caveat">
          Reports use one completed automated visit per condition. Reproducible for this configuration, not a
          universal claim.
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

import type { ReactNode } from "react";
import type { comparisonVisitOrderLine } from "@/lib/comparison-visit-order";
import { INCOMPLETE_VISIT_NOTICE } from "@/lib/incomplete-visit-notice";
import type { EvidenceArm } from "@/lib/report-evidence-navigation";
import type { Finding } from "@/lib/report-findings";
import type { ReportHeadline } from "@/lib/report-headline";
import { SCHEMA_LABEL } from "@/lib/schema-note";
import { FindingsList } from "@/app/_components/findings-list";
import { LimitLine } from "./limit-line";

/**
 * Compact, crawlable report content. Raw evidence arrays stay server-side.
 *
 * One component for both places a report's summary is read: the report page
 * renders it on the server, and the evidence renderer renders it in the
 * browser for a result that has no page of its own (a scan's result on the
 * homepage, a report opened from a file). It reads nothing from the server's
 * environment: the caller passes the base path.
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
export function ReportPageSummary({
  basePath,
  printed = false,
  correctionLabel = null,
  headline,
  dateline,
  incompleteNotice,
  schemaLimit,
  recordLinks,
  findings,
  evidenceArm,
  automation,
  visitOrder,
  visitSummary,
  figure,
  domainTable,
  siteHistoryHref = null,
  newVisitTarget = null,
  newVisitFrom = null
}: {
  /** The site's base path, for the links this block builds (the methodology, the glossary, a card's views). */
  basePath: string;
  /** Paper: the board offers no Look closer view (a view is navigation, not evidence). */
  printed?: boolean;
  /**
   * The headline's label when a published correction applies to the report.
   * A report page states the correction in its own notice and passes none; a
   * result elsewhere has no such notice, so the label leads its limits.
   */
  correctionLabel?: string | null;
  headline: ReportHeadline;
  /** The site and visit date on one line, printed above the finding sentence on paper only. */
  dateline: ReactNode;
  /** The incomplete-visit notice the context would print, or null on a complete report. */
  incompleteNotice: string | null;
  /** The older-format note, a limit on the whole report, or null (record-block.tsx). */
  schemaLimit: string | null;
  /** The record's actions, after the finding sentence and its limits, before the figure. */
  recordLinks: ReactNode;
  findings: readonly Finding[];
  evidenceArm: EvidenceArm | undefined;
  automation: string;
  /** The comparison's visit-order line; null for a single scan or a before/after pair. */
  visitOrder: ReturnType<typeof comparisonVisitOrderLine>;
  /** What was checked and what the visit could not see, after the bottom line. */
  visitSummary: ReactNode;
  /** Where the described visit's requests went, directly after the finding sentence. */
  figure: ReactNode;
  /** The described visit's busiest domains, after the findings. */
  domainTable: ReactNode;
  /** The cookie card's history view target, the same value the explorer receives. */
  siteHistoryHref?: string | null;
  /** The page a card's new visit would visit again, a runtime share's only. */
  newVisitTarget?: string | null;
  /** The share report id a new visit's link names, a runtime share's own. */
  newVisitFrom?: string | null;
}) {
  return (
    <div className="report-page-summary">
      {dateline}
      {/* The finding sentence, a standfirst under the site, and the limits on
          the whole report, which stand beside both at wide widths. Nothing
          else, so the figure starts on the first screen. No kicker here. */}
      <section className={`headline-banner tone-${headline.tone}`} aria-label="Plain-language summary">
        <h2 className="headline-title">{headline.headline}</h2>
        <div className="headline-footer">
          {correctionLabel && <LimitLine><strong>{correctionLabel}</strong></LimitLine>}
          {/* The notice's own label and title are the line, and the line is
              the control: it opens the notice, and print prints it open. */}
          {/* The wrapper is the status region, as the shared notice's section
              is; the summary inside it stays a plain disclosure control. */}
          {incompleteNotice && (
            <div role="status" aria-labelledby="report-incomplete-title">
              <LimitLine details={[incompleteNotice]}>
                {INCOMPLETE_VISIT_NOTICE.label}:{" "}
                <strong id="report-incomplete-title">{INCOMPLETE_VISIT_NOTICE.title}</strong>
              </LimitLine>
            </div>
          )}
          {/* The headline's own limit, as a limit line: always printed. */}
          <LimitLine className="headline-caveat">{headline.caveat}</LimitLine>
          {/* The record's label and the note, in the form of the notice above. */}
          {schemaLimit && (
            <LimitLine>
              {SCHEMA_LABEL}: <strong>{schemaLimit}</strong>
            </LimitLine>
          )}
          {/* Same text and link as the comparison panel's line, which
              replaces this one when the explorer opens. */}
          {visitOrder && (
            <p className="headline-visit-order">
              {visitOrder.text}
              {visitOrder.seeMethodology && (
                <>
                  {" "}(see <a href={`${basePath}/methodology/#comparisons`}>Methodology</a>)
                </>
              )}
            </p>
          )}
        </div>
      </section>
      {/* The record's actions: under the sentence on a wide screen, after
          its limits on a narrow one, and above the figure at every width. */}
      {recordLinks}
      {figure}
      {/* After the figure, at every width: the opening paragraph, with the
          numbers at its right on a wide screen (app/_design/report.css). */}
      <p className="headline-subhead">{headline.subhead}</p>
      {headline.stats.length > 0 && (
        <div className="headline-stats">
          {headline.stats.map((stat, index) => (
            <div
              className={`headline-stat${stat.emphasis ? " is-emphasis" : ""}${/\d/.test(String(stat.value)) ? "" : " is-words"}`}
              key={index}
            >
              <span className="headline-stat-value">{stat.value}</span>
              <span className="headline-stat-label">{stat.label}</span>
            </div>
          ))}
        </div>
      )}
      <FindingsList
        findings={findings}
        evidenceArm={evidenceArm}
        automation={automation}
        glossaryHref={`${basePath}/glossary/`}
        afterBottomLine={visitSummary}
        plainHeading
        shortLimits
        omitIcons
        index
        lookCloser={printed ? undefined : { siteHistoryHref, newVisitTarget, newVisitFrom, basePath }}
      />
      {domainTable}
    </div>
  );
}

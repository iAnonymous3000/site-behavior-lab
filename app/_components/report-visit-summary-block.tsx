import { Fragment } from "react";
import type { ReportVisitSummary } from "@/lib/report-visit-summary";

/**
 * What was checked and what the visit could not see, as two plain lists, for
 * the findings board to render directly after its bottom line.
 *
 * It follows the verdict rather than leading the page: the banner and the
 * bottom line keep the place they hold above it, and these lists come before
 * every count and table, so a reader meets the scope of the visit before its
 * evidence. The two server pages build it (lib/report-visit-summary.ts) and
 * hand it to the board as markup, through the explorer for the printable page
 * and the PDF, so neither module enters a client bundle.
 *
 * No disclosure widget: a collapsed caveat reaches nobody who was not already
 * looking, and none reaches paper. Headings, not labelled sections, so the
 * page gains no landmarks, and h3 under the board's h2 so the cards after the
 * lists do not nest under "could not see".
 */
export function ReportVisitSummaryBlock({ summary }: { summary: ReportVisitSummary }) {
  return (
    <div className="report-visit-summary">
      <div className="report-visit-checked">
        <h3 className="report-visit-heading">{summary.checkedTitle}</h3>
        <dl>
          {summary.checked.map((fact) => (
            <div key={fact.term}>
              <dt>{fact.term}</dt>
              <dd>{fact.text}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="report-visit-limits">
        <h3 className="report-visit-heading">{summary.limitsTitle}</h3>
        <ul>
          {summary.limits.map((limit) => (
            <li key={limit.id}>
              <strong>{limit.lead}</strong>{" "}
              {limit.body.map((segment, index) =>
                segment.cardId ? (
                  <a href={`#${segment.cardId}`} key={index}>{segment.text}</a>
                ) : (
                  <Fragment key={index}>{segment.text}</Fragment>
                )
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

import { OPEN_LATEST_REPORT_LABEL } from "@/lib/homepage-labels";
import { INCOMPLETE_VISIT_NOTICE } from "@/lib/incomplete-visit-notice";
import type { FrontPageRecord, SiteRowMarks } from "@/lib/homepage-figures";
import { REQUEST_FIGURE_COPY, figureMarks } from "@/lib/request-figure";
import { sitePagesBasePath } from "@/lib/site-url";
import { LimitLine } from "./limit-line";
import { SCHEMA_LABEL, schemaNotePlacement } from "@/lib/schema-note";
import { siteNameStep } from "@/lib/site-name-size";
import { SiteNameText } from "./site-name";
import { RequestFigure } from "./request-figure";

/**
 * The homepage's record: the latest report, as one visit of one site.
 *
 * The text comes first in the source: the link that opens the report (the
 * words "Open latest report" are its label), the site, the described visit's
 * date, the report's finding sentence, then the report's own limits with its
 * visit-order line. The figure of that visit follows. On a wide screen the
 * figure stands at the left and the text at the right; the limits stay with
 * the sentence at every width.
 *
 * A server component: the homepage's server page renders it and hands the
 * element to the client page, so it costs HTML and no homepage script. It
 * adds no sentence. Every string is the report's own, the report page's, or
 * the figure's. When lib/homepage-figures.ts builds no record this is not
 * rendered, and nothing stands in its place.
 */
export function FrontPageRecordBlock({ record, href }: { record: FrontPageRecord; href: string }) {
  const nameStep = siteNameStep(record.site);
  return (
    <section className="a-fpr" aria-labelledby="front-record-site">
      <div className="a-fpr-text">
        <a className="a-fpr-open" href={href}>{OPEN_LATEST_REPORT_LABEL}</a>
        <h2 id="front-record-site" className={nameStep === "full" ? undefined : `a-site-${nameStep}`}>
          <SiteNameText name={record.site} />
        </h2>
        <dl>
          <dt>{record.visitLabel}</dt>
          <dd><time dateTime={record.startedAt ?? undefined}>{record.startedText}</time></dd>
        </dl>
        <p className="a-fpr-find">{record.headline}</p>
        <RecordLimits record={record} />
      </div>
      <RequestFigure figure={record.figure} notMeasured={record.notMeasured} />
    </section>
  );
}

/**
 * A record's limits: the report's own, in the report page's order and words.
 * The incomplete-visit notice with its detail behind it, the headline's
 * limit, the older-format note under its "Schema" label, and the comparison's
 * visit-order line. Shared by the homepage's record and a site page's.
 */
export function RecordLimits({ record }: { record: FrontPageRecord }) {
  const schemaLimit = schemaNotePlacement(record.view).limit;
  return (
    <div className="a-fpr-limits">
      {record.clarification && <LimitLine>{record.clarification}</LimitLine>}
      {record.incompleteNotice && (
        <LimitLine details={[record.incompleteNotice]}>
          {INCOMPLETE_VISIT_NOTICE.label}: <strong>{INCOMPLETE_VISIT_NOTICE.title}</strong>
        </LimitLine>
      )}
      <LimitLine>{record.caveat}</LimitLine>
      {schemaLimit && (
        <LimitLine>
          {SCHEMA_LABEL}: <strong>{schemaLimit}</strong>
        </LimitLine>
      )}
      {record.visitOrder && (
        <p className="a-fpr-order">
          {record.visitOrder.text}
          {record.visitOrder.seeMethodology && (
            <>
              {" "}(see <a href={`${sitePagesBasePath()}/methodology/#comparisons`}>Methodology</a>)
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The marks beside a site on record: one per retained request row of the
 * visit its report describes, same-site first, then cross-site, then the
 * open-ended box when the count is a lower bound. Drawn as runs of text, as
 * the report figure's marks are, never as an element per mark. Decoration to
 * a screen reader: the two count sentences under them are the text.
 */
export function SiteRowMarksRun({ marks }: { marks: SiteRowMarks }) {
  // The box follows the last mark drawn, whichever group that is.
  const boxOnCross = marks.lowerBound && marks.crossSite > 0;
  const site = figureMarks(marks.site, marks.lowerBound && !boxOnCross);
  const cross = figureMarks(marks.crossSite, boxOnCross);
  const tail = boxOnCross ? cross : site;
  return (
    <span className="a-marks a-rowmarks" aria-hidden="true">
      {site.run !== "" && <span className="a-run is-site">{site.run}</span>}
      {cross.run !== "" && <span className="a-run">{cross.run}</span>}
      {tail.held !== null && (
        <span className="a-tail">
          {tail.held !== "" && <span className={boxOnCross ? "a-run" : "a-run is-site"}>{tail.held}</span>}
          <b className={boxOnCross ? "a-open" : "a-open is-site"} />
        </span>
      )}
    </span>
  );
}

/** The key under the rows: the figure's own three strings. */
export function SiteRowKey({ lowerBound }: { lowerBound: boolean }) {
  return (
    <ul className="a-key a-rowkey" aria-label="Key">
      <li><span className="a-marks is-site" aria-hidden="true"><i /></span>{REQUEST_FIGURE_COPY.legendSite}</li>
      <li><span className="a-marks" aria-hidden="true"><i /></span>{REQUEST_FIGURE_COPY.legendCrossSite}</li>
      {lowerBound && (
        <li><span className="a-marks" aria-hidden="true"><span className="a-tail"><b className="a-open" /></span></span>{REQUEST_FIGURE_COPY.legendLowerBound}</li>
      )}
    </ul>
  );
}

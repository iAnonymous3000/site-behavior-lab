import Link from "next/link";
import { Fragment } from "react";
import { reportActivation } from "@/lib/report-trust";
import { crossSiteLandingLines } from "@/lib/report-subject-landing";
import { readableVisitStart, unshownVisitStart } from "@/lib/visit-timestamp";
import { displayRunView, runVisitLabel, type ReportView } from "@/lib/scan-report-views";
import { SCHEMA_LABEL, schemaNotePlacement } from "@/lib/schema-note";
import { siteNameStep } from "@/lib/site-name-size";
import { sitePagesBasePath } from "@/lib/site-url";
import { displayHost, displayPublicUrl } from "@/lib/text-format";
import { SiteNameText } from "./site-name";

// The format note's placement and label live in lib/schema-note.ts; the
// report page reads them from here, beside the record that prints the row.
export { SCHEMA_LABEL, schemaNotePlacement };

/**
 * The record: what this report is of, as labelled rows. On screen it opens
 * the page: the site is the largest type, with the visit and the requested
 * address under it. The report id, the digest and the scanner are in the
 * markup for paper, which prints the whole record; on screen the evidence
 * receipt shows them, so the stylesheet leaves them out of the top
 * (app/_design/report.css).
 *
 * It is the permalink's identity header, the element the page's one <h1>
 * (the site) lives in, and it renders the facts the shared header in
 * app/_components/report-page-context.tsx renders, from the same functions:
 * the display visit and its timestamp, the requested address, any landing on
 * another site and the format note. It adds what a reader
 * needs to cite or check the report: its id, the digest of the exact evidence
 * bytes, and the scanner that made the visit.
 *
 * Every label is one an earlier surface already printed (the shared header
 * and the evidence receipt). lib/request-figure.test.ts holds the action
 * labels equal to the shared header's.
 *
 * The id and the digest break by markup, never where the column happens to
 * end: the id after its date, the digest in two halves of 32.
 *
 * A result with no page of its own (a scan's result on the homepage, a report
 * opened from a file) has no report id and no digest of published bytes: it
 * passes neither, and those two rows are not rendered. It sits on a page that
 * has its own <h1>, so it sets the site as an <h2> (`siteHeading`).
 */
export function ReportRecord({
  evidenceSha256,
  id,
  view,
  siteHeading: SiteHeading = "h1"
}: {
  evidenceSha256?: string;
  id?: string;
  view: ReportView;
  siteHeading?: "h1" | "h2";
}) {
  const run = displayRunView(view);
  const formatChip = schemaNotePlacement(view).record;
  const started = run.startedAt ?? view.scannedAt;
  const dash = id ? id.indexOf("-") + 1 : 0;
  const half = evidenceSha256 ? Math.ceil(evidenceSha256.length / 2) : 0;
  const siteName = displayHost(run.domain);
  const nameStep = siteNameStep(siteName);

  return (
    <header className="report-identity">
      <dl className="a-rec">
        <dt>Site</dt>
        {/* A long name is set a step smaller, by its length
            (lib/site-name-size.ts). A break opportunity after each dot, so a
            name that still does not fit breaks between labels before it
            breaks inside one. */}
        <dd>
          {/* As an h2 it is the heading a result's focus moves to when the
              result arrives (report-renderer.tsx), so it takes focus without
              joining the tab order. */}
          <SiteHeading
            className={nameStep === "full" ? undefined : `a-site-${nameStep}`}
            tabIndex={SiteHeading === "h2" ? -1 : undefined}
          >
            <SiteNameText name={siteName} />
          </SiteHeading>
        </dd>
        {/* The row is named for the visit the timestamp belongs to, never the pair. */}
        <dt>{runVisitLabel(run)}</dt>
        {/* An opened file can hold any string here; only an instant is formatted, as the header does. */}
        <dd><time dateTime={started ?? undefined}>{readableVisitStart(started) ?? unshownVisitStart(started)}</time></dd>
        <dt>Requested address</dt>
        <dd>
          {/* A break opportunity after each "/" and ".", so an address too
              long for its line breaks between its parts, not inside a word. */}
          <span className="a-mono">
            {displayPublicUrl(run.conditions.requestedUrl).split(/(?<=[/.])/).map((part, index) => (
              <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>
            ))}
          </span>
          {crossSiteLandingLines(view).map((line, index) => <p key={index}>{line}</p>)}
        </dd>
        {id && (
          <>
            <dt>Report ID</dt>
            <dd className="a-mono">
              {dash > 0 ? <><span>{id.slice(0, dash)}</span><wbr /><span>{id.slice(dash)}</span></> : <span>{id}</span>}
            </dd>
          </>
        )}
        {evidenceSha256 && (
          <>
            <dt>Evidence SHA-256</dt>
            <dd className="a-mono a-digest">
              <span>{evidenceSha256.slice(0, half)}</span>
              <span>{evidenceSha256.slice(half)}</span>
            </dd>
          </>
        )}
        {formatChip && (
          <>
            <dt>Schema</dt>
            <dd>{formatChip}</dd>
          </>
        )}
        <dt>Scanner</dt>
        <dd>{run.conditions.automation}</dd>
      </dl>
    </header>
  );
}

/**
 * The record's actions: the site's history, a new visit of the same route or
 * site, the way down to the findings, and the evidence-problem form.
 *
 * They follow the finding sentence and its limits in the source, and on a
 * wide screen they sit directly under the sentence, above the figure
 * (app/_design/report.css), so focus reaches them where they are seen. The
 * history is the one filled button, a new visit the open one; the rest are
 * links. The same labels, from the same function, as the shared header's.
 *
 * The findings link names the board by its own heading and lands it 16px
 * below the top of the window (the board's scroll margin), as a #history link
 * lands a site page's history.
 */
export function ReportRecordLinks({
  id,
  permanent,
  reportUrl,
  view
}: {
  id: string;
  permanent: boolean;
  reportUrl: string;
  view: ReportView;
}) {
  const activation = reportActivation({ id, reportUrl, siteHistoryAvailable: permanent, view });
  const profileHref = activation.profilePath ? `${sitePagesBasePath()}${activation.profilePath}/` : null;
  return (
    <div className="report-identity-actions">
      {profileHref && <a className="primary-button" href={profileHref}>View site history</a>}
      {activation.exactRescanHref ? (
        <Link className="secondary-button" href={activation.exactRescanHref}>Scan this exact route again</Link>
      ) : (
        activation.siteRescanHref && <Link className="secondary-button" href={activation.siteRescanHref}>Scan this site again</Link>
      )}
      {/* The two links, one over the other beside the buttons, so the row
          is one button high on a wide screen. */}
      <span className="a-actions-links">
        <a className="a-findings-link" href="#findings">What this visit means</a>
        <a className="topbar-link" href={activation.evidenceIssueUrl} target="_blank" rel="noreferrer">
          Report an evidence problem
          <span className="a-vh"> (opens in a new tab)</span>
        </a>
      </span>
    </div>
  );
}

/**
 * The site and the visit date on one line, for paper only.
 *
 * On screen the record sits beside the finding sentence. In print it follows
 * the figure, which can put it on page two, and a printed first page with no
 * site and no date cannot be filed. So print carries this line directly above
 * the finding sentence, where the breadcrumb is on screen.
 *
 * It states nothing of its own: the record's "Site" label and value, and the
 * record's visit label with its timestamp, from the same functions. It is
 * display:none on screen, so it is neither shown nor announced there, and the
 * full record still prints after the figure.
 */
export function RecordDateline({ view }: { view: ReportView }) {
  const run = displayRunView(view);
  const started = run.startedAt ?? view.scannedAt;
  return (
    <p className="a-dateline">
      <span className="a-dateline-l">Site</span> <span className="a-mono">{displayHost(run.domain)}</span>
      <span className="a-dateline-l">{runVisitLabel(run)}</span>{" "}
      <time dateTime={started ?? undefined}>{readableVisitStart(started) ?? unshownVisitStart(started)}</time>
    </p>
  );
}

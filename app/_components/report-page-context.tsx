import { sha256Hex } from "@/lib/sha256";
import { publishedReportCorrections, publishedReportCorrectionWire } from "@/lib/published-report-corrections";
import Link from "next/link";
import type { ReactNode } from "react";
import { CLAIM_BOUNDARY, claimBoundaryParagraph } from "@/lib/claim-boundary";
import type { ReportCorrections } from "@/lib/corrections-ledger";
import {
  detectorCalibrationReaderSentence,
  withRunApplicability
} from "@/lib/detector-calibration-reader";
import { committedDetectorCalibrationReaderClaims } from "@/lib/detector-calibration-source";
import { COVERAGE_BOUNDARY_PATH, coverageBoundarySentence } from "@/lib/detector-coverage-boundary";
import { reportActivation } from "@/lib/report-trust";
import { degradedRunNotice, runQualitySummary } from "@/lib/scan-report-censorship";
import {
  completedVisitsPhrase,
  displayRunView,
  reportDetectorScope,
  runVisitLabel,
  schemaProvenanceLabel,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import { printableReportHref, reportPdfHref, sitePagesBasePath } from "@/lib/site-url";
import { displayHost, displayPublicUrl } from "@/lib/text-format";

const SOURCE_REPOSITORY = "https://github.com/iAnonymous3000/site-behavior-lab";

/**
 * Server-rendered identity, activation and verification surface for a saved
 * report. Keeping these outside the client report renderer makes history,
 * rescanning, source provenance, JSON evidence, and corrections useful before
 * hydration and visible to non-JavaScript crawlers.
 *
 * Split from the receipt on purpose. A report page used to open with four
 * consecutive blocks of machinery -- evidence quality, retention status, the
 * integrity receipt, then the recorded-visit facts -- and only reached the
 * plain-language finding fifth. A reader following a shared link wants the
 * subject and the finding first and the provenance when they decide to check
 * it, so `ReportEvidenceReceipt` renders after the evidence instead.
 *
 * The `<h1>` is the SITE, not the headline sentence. The headline is the lead
 * finding and it already leads the banner below; making it the heading too
 * printed the same sentence three times on one page. It also gives the report
 * page the same subject-first heading as `/sites/<domain>/`.
 */
export function ReportPageContext({
  corrections,
  id,
  permanent,
  reportUrl,
  view
}: {
  corrections: ReportCorrections;
  id: string;
  permanent: boolean;
  reportUrl: string;
  view: ReportView;
}) {
  const activation = reportActivation({ id, reportUrl, siteHistoryAvailable: permanent, view });
  const degradedNotice = degradedRunNotice(view);
  const run = displayRunView(view);
  const profileHref = activation.profilePath
    ? `${sitePagesBasePath()}${activation.profilePath}/`
    : null;

  return (
    <div className="report-page-context">
      <nav className="report-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          <li><Link href="/">Home</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link href="/directory/">Scanned sites</Link></li>
          {profileHref && (
            <>
              <li aria-hidden="true">/</li>
              <li><a href={profileHref}>{displayHost(view.domain)}</a></li>
            </>
          )}
          <li aria-hidden="true">/</li>
          <li aria-current="page">Report</li>
        </ol>
      </nav>

      <header className="report-identity">
        <div className="report-identity-title">
          {/* Names the arm below it, not the report. The domain, URL,
              timestamp and run quality that follow all come from the display
              run, so a pair count here would caption one visit with two. */}
          <p className="eyebrow">
            {runVisitLabel(run)} <span className="report-provenance">{schemaProvenanceLabel(view)}</span>
          </p>
          <h1>{displayHost(run.domain)}</h1>
          <p className="report-url">{displayPublicUrl(run.conditions.requestedUrl)}</p>
        </div>
        <p className="report-identity-when">{formatTimestamp(run.startedAt ?? view.scannedAt)}</p>
        <p className="report-identity-quality">{runQualitySummary(run)}</p>
        {/* Actions, not prose. The retention sentence these used to sit beside
            is a statement about provenance, so it moved down to the receipt and
            left the three things a reader can DO with this report right under
            its title. */}
        <div className="report-identity-actions">
          {profileHref && (
            <a className="primary-button" href={profileHref}>
              View site history
            </a>
          )}
          {activation.exactRescanHref ? (
            <Link className="secondary-button" href={activation.exactRescanHref}>
              Scan this exact route again
            </Link>
          ) : (
            activation.siteRescanHref && (
              <Link className="secondary-button" href={activation.siteRescanHref}>
                Scan this site again
              </Link>
            )
          )}
          <a className="topbar-link" href={activation.evidenceIssueUrl} target="_blank" rel="noreferrer">
            Report an evidence problem
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </div>
      </header>

      {(corrections.currentSubjectEvent || corrections.replacementEvents.length > 0) && (
        <ReportCorrectionNotice corrections={corrections} />
      )}

      {/* Above the fold and above the numbers it qualifies. The evidence
          receipt already carries per-visit run quality, but it sits several
          facts down inside a section a reader scrolling to the tables never
          reads, and on paper the tables look complete for pages. */}
      {degradedNotice && (
        <section className="report-incomplete-notice" role="status" aria-labelledby="report-incomplete-title">
          <p className="eyebrow">Evidence quality</p>
          <h2 id="report-incomplete-title">This report is built on an incomplete visit</h2>
          <p>{degradedNotice}</p>
        </section>
      )}
    </div>
  );
}

/**
 * Integrity and provenance for one report, rendered AFTER the evidence.
 *
 * Deliberately in this file rather than a new one: `lib/print-contract.test.ts`
 * and `lib/print-route-contract.test.ts` read this module as the single home of
 * the receipt's pinned copy ("Evidence receipt", "Printable version", "Open
 * PDF"), and splitting it across two files is exactly the drift those tests
 * exist to catch.
 */
export function ReportEvidenceReceipt({
  id,
  jsonHref,
  evidenceSha256,
  permanent,
  provenanceHref,
  view
}: {
  id: string;
  jsonHref: string;
  evidenceSha256?: string;
  permanent: boolean;
  provenanceHref: string | null;
  view: ReportView;
}) {
  const detectorScope = reportDetectorScope(view);
  const pdfHref = reportPdfHref(id);
  const exportQuery = new URLSearchParams({ correctionsSha256: sha256Hex(publishedReportCorrectionWire(id)) });
  if (evidenceSha256) exportQuery.set("sha256", evidenceSha256);
  const boundPdfHref = pdfHref && `${pdfHref}?${exportQuery}`;
  return (
    <section className="evidence-receipt" id="receipt" aria-labelledby="evidence-receipt-title">
        <p className="evidence-receipt-retention">
          {permanent
            ? "This versioned report is currently retained in the public corpus. Follow the currently retained site history, repeat the same public route when it is available, or request a transparent evidence correction."
            : `This saved report records ${completedVisitsPhrase(view, "controlled")}. Repeat the same public route when it is available, or report an evidence problem before the share expires.`}
        </p>
        <div className="evidence-receipt-heading">
          <div>
            <p className="eyebrow">Integrity and provenance</p>
            <h2 id="evidence-receipt-title">Evidence receipt</h2>
          </div>
          <div className="evidence-receipt-links">
            <a className="secondary-button" href={jsonHref}>Open report JSON</a>
            {publishedReportCorrections(view.reportId).currentSubjectEvent && (
              <a className="secondary-button" href={sitePagesBasePath() + "/corrections.json"}>Download corrections with this JSON</a>
            )}
            {provenanceHref && <a className="secondary-button" href={provenanceHref}>Open provenance sidecar</a>}
            {pdfHref && (
              <a className="secondary-button" href={printableReportHref(`${new URL(pdfHref).origin}/reports/${id}/`)}>Printable version</a>
            )}
            {boundPdfHref && <>
              <a className="secondary-button" href={`${boundPdfHref}&download=bundle`}
                target="_blank" rel="noopener">Download PDF + evidence<span className="visually-hidden"> (opens in a new tab)</span></a>
              <a className="secondary-button" href={boundPdfHref}
                target="_blank" rel="noopener">Open PDF<span className="visually-hidden"> (opens in a new tab)</span></a>
            </>}

          </div>
        </div>

        <dl className="evidence-receipt-summary">
          <ReceiptFact term="Report ID"><code>{id}</code></ReceiptFact>
          <ReceiptFact term="Site"><span>{displayHost(view.domain)}</span></ReceiptFact>
          <ReceiptFact term={view.reportType === "comparison" ? "Latest visit" : "Scan date"}>
            <time dateTime={(view.latestRunAt ?? view.scannedAt) ?? undefined}>
              {formatTimestamp(view.latestRunAt ?? view.scannedAt)}
            </time>
          </ReceiptFact>
          <ReceiptFact term="Schema"><span>{schemaProvenanceLabel(view)}</span></ReceiptFact>
        </dl>

        <details className="evidence-receipt-details">
          <summary>Verify recorded provenance</summary>
          <div className="evidence-receipt-runs">
            {view.runs.map((run, index) => (
              <RunReceipt key={`${run.label ?? "visit"}-${run.startedAt ?? index}`} run={run} />
            ))}
          </div>
          <p className="evidence-receipt-note">
            Recorded provenance is self-reported measurement metadata, not a cryptographic attestation. The public
            versioned report JSON contains the retained public evidence; see the <Link href="/methodology/">methodology</Link> for
            interpretation and retention limits.
          </p>
        </details>

        {/* Deliberately OUTSIDE the details above. These two sentences qualify
            every number on the page, and a reader who forwards this report is
            the one most likely to need them. Behind a collapsed summary they
            reached nobody who had not already gone looking. */}
        <div className="evidence-receipt-boundaries">
          <p className="evidence-receipt-note">
            {coverageBoundarySentence()}{" "}
            <Link href={COVERAGE_BOUNDARY_PATH}>Read the published coverage boundary</Link>.
          </p>
          {/* Derived here, at render, from the committed studies re-analyzed
              against the CURRENT release identity -- never read from the report.
              A study stops supporting its rate when any bound identity moves,
              and one of those identities is the Brave list's `fetchedAt`, which
              the weekly refresh changes. A stored sentence would go on
              asserting a number the analyzer had already withdrawn. */}
          <p className="evidence-receipt-note">
            {detectorCalibrationReaderSentence(
              withRunApplicability(
                committedDetectorCalibrationReaderClaims(detectorScope.qualified),
                new Set(detectorScope.rateApplicable)
              )
            )}{" "}
            <Link href="/methodology/#detector-calibration">How detector accuracy is measured</Link>.
          </p>
          {CLAIM_BOUNDARY && (
            <p className="evidence-receipt-note">
              Approved use boundary: {claimBoundaryParagraph(CLAIM_BOUNDARY)}{" "}
              Recorded in this project&apos;s release manifest on{" "}
              <time dateTime={CLAIM_BOUNDARY.decidedAt}>{CLAIM_BOUNDARY.decidedAt.slice(0, 10)}</time>.
            </p>
          )}
        </div>
    </section>
  );
}

function ReportCorrectionNotice({ corrections }: { corrections: ReportCorrections }) {
  const event = corrections.currentSubjectEvent ?? corrections.replacementEvents.at(-1)!;
  const isReplacement = corrections.currentSubjectEvent === null;
  return (
    <section
      className={`report-correction-notice state-${event.state}`}
      aria-labelledby="report-correction-title"
      role={corrections.suppressIndexing ? "alert" : "status"}
    >
      <p className="eyebrow">Public corrections ledger · {event.eventId}</p>
      <h2 id="report-correction-title">
        {isReplacement
          ? "This report is replacement evidence"
          : event.state === "active"
            ? "This report has a reviewed clarification"
            : `This report was ${event.state}`}
      </h2>
      {(isReplacement ? [event] : corrections.subjectEvents).map(item => <p key={item.eventId}><strong>{item.eventId}:</strong> {item.summary}</p>)}
      {(event.replacementReportIds?.length ?? 0) > 0 && !isReplacement && (
        <p className="report-correction-replacements">
          Replacement evidence:{" "}
          {event.replacementReportIds?.map((id) => (
            <Link href={`/reports/${id}/`} key={id}><code>{id}</code></Link>
          ))}
        </p>
      )}
      <p><a href={event.detailsUrl}>Read the public review record</a></p>
    </section>
  );
}

function RunReceipt({ run }: { run: RunView }) {
  const provenance = run.provenance;
  const toolchain = run.toolchainIdentity;
  const label = runVisitLabel(run);

  return (
    <section className="evidence-receipt-run" aria-label={label}>
      <h3>{label}</h3>
      <dl>
        <ReceiptFact term="Started"><time dateTime={run.startedAt ?? undefined}>{formatTimestamp(run.startedAt)}</time></ReceiptFact>
        <ReceiptFact term="Run quality"><span>{runQualitySummary(run)}</span></ReceiptFact>
        <ReceiptFact term="Scanner"><span>{run.conditions.automation}</span></ReceiptFact>
        <ReceiptFact term="Browser"><span>{run.conditions.browserVersion ?? "not recorded"}</span></ReceiptFact>
        <ReceiptFact term="Redaction"><span>{run.redactionVersion === null ? "not recorded by this schema" : `version ${run.redactionVersion}`}</span></ReceiptFact>
        {provenance ? (
          <>
            <ReceiptFact term="Methodology"><code>{provenance.methodologyVersion}</code></ReceiptFact>
            <ReceiptFact term="Source commit"><CommitValue value={provenance.buildCommit} /></ReceiptFact>
            <ReceiptFact term="Detector registry">
              <span>{provenance.detectorRegistry.version}</span>
              <code>{provenance.detectorRegistry.digest}</code>
            </ReceiptFact>
            {provenance.sourceArtifactDigest && (
              <ReceiptFact term="Source artifact digest"><code>{provenance.sourceArtifactDigest}</code></ReceiptFact>
            )}
          </>
        ) : (
          <ReceiptFact term="Provenance"><span>Exact build and instrument digests were not recorded by this legacy schema.</span></ReceiptFact>
        )}
        {toolchain && (
          <>
            <ReceiptFact term="Tracker catalog digest"><code>{toolchain.trackerCatalogDigest}</code></ReceiptFact>
            {toolchain.adblock && (
              <ReceiptFact term="Brave-list instrument">
                <span>engine {toolchain.adblock.engineVersion}</span>
                <code>{toolchain.adblock.manifestDigest}</code>
              </ReceiptFact>
            )}
            <ReceiptFact term="Normalization"><code>{toolchain.normalizationVersion}</code></ReceiptFact>
          </>
        )}
      </dl>
    </section>
  );
}

function ReceiptFact({ term, children }: { term: string; children: ReactNode }) {
  return <div><dt>{term}</dt><dd>{children}</dd></div>;
}

function CommitValue({ value }: { value: string }) {
  return /^[0-9a-f]{40}$/i.test(value) ? (
    <a href={`${SOURCE_REPOSITORY}/commit/${value}`} target="_blank" rel="noreferrer">
      <code>{value}</code>
      <span className="visually-hidden"> commit, opens in a new tab</span>
    </a>
  ) : <code>{value}</code>;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "not recorded"
    : date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short"
      });
}

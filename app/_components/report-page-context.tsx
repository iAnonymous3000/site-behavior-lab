import Link from "next/link";
import type { ReactNode } from "react";
import { CLAIM_BOUNDARY, claimBoundaryParagraph } from "@/lib/claim-boundary";
import type { ReportCorrections } from "@/lib/corrections-ledger";
import { reportActivation } from "@/lib/report-trust";
import {
  runQualitySummary,
  schemaProvenanceLabel,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import { printableReportHref, reportPdfHref, sitePagesBasePath } from "@/lib/site-url";

const SOURCE_REPOSITORY = "https://github.com/iAnonymous3000/site-behavior-lab";
const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

/**
 * Server-rendered activation and verification surface for a saved report.
 * Keeping these links outside the client report renderer makes history,
 * rescanning, source provenance, JSON evidence, and corrections useful before
 * hydration and visible to non-JavaScript crawlers.
 */
export function ReportPageContext({
  corrections,
  id,
  jsonHref,
  permanent,
  provenanceHref,
  reportUrl,
  view
}: {
  corrections: ReportCorrections;
  id: string;
  jsonHref: string;
  permanent: boolean;
  provenanceHref: string | null;
  reportUrl: string;
  view: ReportView;
}) {
  const activation = reportActivation({ id, reportUrl, siteHistoryAvailable: permanent, view });
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
              <li><a href={profileHref}>{view.domain}</a></li>
            </>
          )}
          <li aria-hidden="true">/</li>
          <li aria-current="page">Report</li>
        </ol>
      </nav>

      {(corrections.currentSubjectEvent || corrections.replacementEvents.length > 0) && (
        <ReportCorrectionNotice corrections={corrections} />
      )}

      <div className="report-activation">
        <div>
          <p className="eyebrow">{permanent ? "Currently retained public corpus evidence" : "Saved share evidence"}</p>
          <p>
            {permanent
              ? "This versioned report is currently retained in the public corpus. Follow the currently retained site history, repeat the same public route when it is available, or request a transparent evidence correction."
              : "This saved report records one controlled visit. Repeat the same public route when it is available, or report an evidence problem before the share expires."}
          </p>
        </div>
        <div className="report-activation-actions">
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
      </div>

      <section className="evidence-receipt" aria-labelledby="evidence-receipt-title">
        <div className="evidence-receipt-heading">
          <div>
            <p className="eyebrow">Integrity and provenance</p>
            <h2 id="evidence-receipt-title">Evidence receipt</h2>
          </div>
          <div className="evidence-receipt-links">
            <a className="secondary-button" href={jsonHref}>Open report JSON</a>
            {provenanceHref && <a className="secondary-button" href={provenanceHref}>Open provenance sidecar</a>}
            {/* Container-only. The printable rendering is excluded from the
                static export by serverOnlyAppDirs, so linking it on Pages would
                ship a dead link on every committed report. Same signal the
                build uses, so the two cannot disagree. */}
            {!STATIC_EXPORT && (
              <>
                <a className="secondary-button" href={printableReportHref(reportUrl)}>
                  Printable version
                </a>
                {/* Renders that same printable page server-side. The PDF is a
                    rendering of the evidence, not the evidence: the JSON wire
                    stays canonical, and the footer inside the document says so. */}
                <a className="secondary-button" href={reportPdfHref(id)} download>
                  Download PDF
                </a>
              </>
            )}
          </div>
        </div>

        <dl className="evidence-receipt-summary">
          <ReceiptFact term="Report ID"><code>{id}</code></ReceiptFact>
          <ReceiptFact term="Site"><span>{view.domain}</span></ReceiptFact>
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
          {CLAIM_BOUNDARY && (
            <p className="evidence-receipt-note">
              Approved use boundary: {claimBoundaryParagraph(CLAIM_BOUNDARY)} Recorded in this
              project&apos;s release manifest on{" "}
              <time dateTime={CLAIM_BOUNDARY.decidedAt}>{CLAIM_BOUNDARY.decidedAt.slice(0, 10)}</time>.
            </p>
          )}
        </details>
      </section>
    </div>
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
      <p>{event.summary}</p>
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
  const label = run.label === "baseline" ? "Baseline visit" : run.label === "variant" ? "Variant visit" : "Recorded visit";

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

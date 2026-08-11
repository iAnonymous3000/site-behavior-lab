"use client";

import { AlertCircle, CheckCircle2, Copy, Download, ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { absoluteShareUrl, reportPdfHref, reportSharePath } from "./report-overview";
import type { RunFacts } from "@/lib/report-facts";
import { safeNavigableHttpUrl } from "@/lib/report-url";
import {
  schemaProvenanceLabel,
  type ReportView
} from "@/lib/scan-report-views";
import type { ReportShare } from "@/lib/types";

export function ReportHeader({
  share,
  view,
  runFacts,
  evidenceFacts,
  csvArmLabel,
  onDownload,
  onDownloadCsv,
  liveApiServesReportPages
}: {
  /** The wire report's share pointer, needed only to resolve the permalink. */
  share: ReportShare | null;
  view: ReportView;
  /** The arm selected by the evidence switcher; quality chips follow it. */
  evidenceFacts: RunFacts;
  runFacts: RunFacts;
  /** Names the visit the CSV exports on comparisons; null on single reports. */
  csvArmLabel: string | null;
  onDownload: () => void;
  onDownloadCsv: () => void;
  liveApiServesReportPages: boolean;
}) {
  const run = runFacts.run;
  const sharePath = reportSharePath(share, liveApiServesReportPages);
  const pdfHref = reportPdfHref(share, liveApiServesReportPages);
  // Keep the rendered anchor origin-relative for static prerendering, but make
  // clipboard/native-share values absolute once the browser origin exists.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  useEffect(() => {
    setShareUrl(sharePath ? absoluteShareUrl(sharePath) : null);
  }, [sharePath]);

  // v2 subject URLs are privacy-generalized route shapes; they parse as URLs
  // but point nowhere real, so they render as text, never as a link.
  const finalUrl = run.conditions.urlsAreRouteShapes
    ? null
    : safeNavigableHttpUrl(run.conditions.finalUrl);
  // A v1 comparison title names the experiment ("GPC off/on comparison"),
  // not the page that answered, so keep that useful pair identity even when a
  // run needs returned-document framing. Singles and untitled v2 comparisons
  // still derive their title from the subject-safe run facts.
  const title =
    view.title ??
    (runFacts.subject.describesSubject
      ? run.pageTitle
      : runFacts.subject.kind === "http-error"
        ? `HTTP ${runFacts.subject.status} returned while scanning ${run.domain}`
        : `Unverified document returned while scanning ${run.domain}`);
  const selectedRequestEvidence = evidenceFacts.requestEvidenceState;
  const requestEvidenceExplanation =
    selectedRequestEvidence === "capped"
      ? "The selected visit hit the request-recording cap. Request and domain counts are lower bounds; cookie and storage availability is reported separately."
      : selectedRequestEvidence === "incomplete"
        ? "The selected visit did not finish collecting request evidence. Request counts are lower bounds; Run quality records the reason."
        : null;
  const [shareCopied, setShareCopied] = useState(false);

  async function handleShare(event: MouseEvent<HTMLAnchorElement>) {
    const url = shareUrl ?? sharePath;
    if (!url) return;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      event.preventDefault();
      try {
        await navigator.share({ title: title || run.domain, url });
      } catch {
        /* the user dismissed the share sheet */
      }
      return;
    }
    // When this permalink is already open, an ordinary navigation does
    // nothing. Copy it instead so the Share control always performs an action.
    if (typeof window !== "undefined" && url === window.location.href) {
      event.preventDefault();
      try {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 1500);
      } catch {
        /* clipboard unavailable */
      }
    }
  }

  return (
    <section className="report-header">
      <div>
        <p className="eyebrow">
          {view.reportType === "comparison" ? "Comparison Report" : "Scan Report"}
          <span className="report-provenance">{schemaProvenanceLabel(view)}</span>
          {selectedRequestEvidence !== "complete" && (
            <span
              aria-describedby="request-evidence-explanation"
              className="capped-chip"
            >
              {selectedRequestEvidence === "capped" ? "recording capped" : "request evidence incomplete"}
            </span>
          )}
        </p>
        <h2>{title || run.domain}</h2>
        {finalUrl ? (
          <a href={finalUrl} target="_blank" rel="noreferrer">
            {run.conditions.finalUrl}
            <ExternalLink size={14} aria-hidden="true" />
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : (
          <span className="report-url">{run.conditions.finalUrl}</span>
        )}
        {requestEvidenceExplanation && (
          <p className="request-evidence-explanation" id="request-evidence-explanation">
            {requestEvidenceExplanation}
          </p>
        )}
      </div>
      <div className="report-actions">
        {sharePath && (
          <>
            <a className="secondary-button" href={sharePath} onClick={handleShare}>
              <ExternalLink size={17} aria-hidden="true" />
              {shareCopied ? "Link copied" : "Share"}
            </a>
            <CopyButton value={shareUrl ?? sharePath} label="share link" />
          </>
        )}
        <button
          aria-describedby="csv-export-description"
          className="secondary-button"
          type="button"
          onClick={onDownloadCsv}
        >
          <Download size={17} aria-hidden="true" />
          {csvArmLabel ? `CSV · ${csvArmLabel}` : "CSV"}
        </button>
        <span className="visually-hidden" id="csv-export-description">
          {csvArmLabel
            ? `Downloads the ${csvArmLabel} visit's request log and follows the evidence switcher below.`
            : "Downloads the request log as CSV."}
        </span>
        <button className="secondary-button" type="button" onClick={onDownload}>
          <Download size={17} aria-hidden="true" />
          JSON
        </button>
        {/* Rendered by the scanner, not in the browser, so it only appears when
            an origin that can render one is reachable. CSV and JSON are built
            from the wire already in memory and are always available; a PDF is
            not, and offering a control that cannot answer would be worse than
            offering none. A plain anchor rather than a fetch: the response
            carries Content-Disposition, so the browser downloads it without
            this component having to hold a multi-megabyte body in memory. */}
        {pdfHref && (
          <>
            <a
              aria-describedby="pdf-export-description"
              className="secondary-button"
              href={pdfHref}
              // Opens beside the report, never over it. This control also
              // renders on the live scan result, where the report exists only
              // in React state and has no permalink to come back to: a refusal
              // (renderer busy, report too large) navigating the tab away would
              // replace the reader's scan with an error document and lose it.
              // Deliberately still no `download` attribute; see the rationale
              // on the permalink control in report-page-context.tsx.
              target="_blank"
              rel="noopener"
            >
              <Download size={17} aria-hidden="true" />
              PDF
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
            {/* Inside the conditional with its button: a description left
                behind when the button is absent is an orphan node that nothing
                references. */}
            <span className="visually-hidden" id="pdf-export-description">
              Downloads the complete report as a PDF, in a new tab. The scanner renders it on request, which
              takes a few seconds.
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    // No aria-label: a fixed one overrode the subtree, so the name stayed "Copy share
    // link" while the button visibly read "Copied". That hid the confirmation from
    // screen readers and left the visible label outside the accessible name, which
    // also breaks voice control ("click Copied" had nothing to match).
    <button
      type="button"
      className="ghost-button"
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
          window.setTimeout(() => setState("idle"), 1600);
        } catch {
          setState("failed");
          window.setTimeout(() => setState("idle"), 2500);
        }
      }}
    >
      {state === "copied" ? (
        <CheckCircle2 size={14} aria-hidden="true" />
      ) : state === "failed" ? (
        <AlertCircle size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy link"}
      <span className="visually-hidden">{` (${label})`}</span>
    </button>
  );
}

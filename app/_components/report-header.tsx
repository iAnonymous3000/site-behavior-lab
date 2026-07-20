"use client";

import { CheckCircle2, Copy, Download, ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { absoluteShareUrl, reportSharePath } from "./report-overview";
import { safeNavigableHttpUrl } from "@/lib/report-url";
import {
  requestEvidenceState,
  schemaProvenanceLabel,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import type { ReportShare } from "@/lib/types";

export function ReportHeader({
  share,
  view,
  run,
  evidenceRun,
  csvArmLabel,
  onDownload,
  onDownloadCsv,
  liveApiServesReportPages
}: {
  /** The wire report's share pointer, needed only to resolve the permalink. */
  share: ReportShare | null;
  view: ReportView;
  /** The arm selected by the evidence switcher; quality chips follow it. */
  evidenceRun: RunView;
  run: RunView;
  /** Names the visit the CSV exports on comparisons; null on single reports. */
  csvArmLabel: string | null;
  onDownload: () => void;
  onDownloadCsv: () => void;
  liveApiServesReportPages: boolean;
}) {
  const sharePath = reportSharePath(share, liveApiServesReportPages);
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
  const title = view.title || run.pageTitle;
  const selectedRequestEvidence = requestEvidenceState(evidenceRun);
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
              className="capped-chip"
              title={
                selectedRequestEvidence === "capped"
                  ? "The selected visit hit the request-recording cap: its activity counts are floors cut off mid-collection, and cookie and storage figures are end-state snapshots of an interrupted visit."
                  : "The selected visit did not finish collecting request evidence. Its request counts are lower bounds; see Run quality for the recorded reason."
              }
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
          </a>
        ) : (
          <span className="report-url">{run.conditions.finalUrl}</span>
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
          className="secondary-button"
          type="button"
          onClick={onDownloadCsv}
          title={
            csvArmLabel
              ? `Download the "${csvArmLabel}" visit's request log as CSV (follows the evidence switcher below)`
              : "Download the request log as CSV"
          }
        >
          <Download size={17} aria-hidden="true" />
          {csvArmLabel ? `CSV · ${csvArmLabel}` : "CSV"}
        </button>
        <button className="secondary-button" type="button" onClick={onDownload}>
          <Download size={17} aria-hidden="true" />
          JSON
        </button>
      </div>
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? <CheckCircle2 size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

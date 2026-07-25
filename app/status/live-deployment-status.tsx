"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { STATIC_EXPORT, scannerApiUrl, staticAssetPath } from "../client-runtime";
import {
  evaluateLiveDeployment,
  freshnessExpiryDelayMs,
  PUBLIC_STATUS_MAX_HEALTH_AGE_MS,
  PUBLIC_STATUS_UI_REFRESH_MS,
  type LiveDeploymentEvaluation
} from "@/lib/public-status";
import { LatestClientOperation } from "@/lib/client-fetch-policy";
import { runLiveDeploymentStatusCheck } from "@/lib/live-deployment-status-client";
import { publicLibraryUrl } from "@/lib/site-url";

const INITIAL: LiveDeploymentEvaluation = {
  state: "unknown",
  summary: "Live deployment evidence has not been checked yet.",
  pagesDeployment: null,
  scannerDeployment: null,
  checkedAt: null
};

// Static exports can read the receipt from their own base-path-aware artifact.
// The runtime scanner has no deployment.json, so it must check the canonical
// public Pages library instead of falling back to scan.sitebehavior.org.
const PAGES_RECEIPT_URL = STATIC_EXPORT
  ? staticAssetPath("/deployment.json")
  : publicLibraryUrl("/deployment.json");

export function LiveDeploymentStatus() {
  const [evaluation, setEvaluation] = useState<LiveDeploymentEvaluation>(INITIAL);
  const [checking, setChecking] = useState(true);
  const latestEvidence = useRef<{ pages: unknown; scanner: unknown } | null>(null);
  const statusOperationRef = useRef<LatestClientOperation | null>(null);
  if (!statusOperationRef.current) statusOperationRef.current = new LatestClientOperation();
  const statusOperation = statusOperationRef.current;

  const reevaluateLatest = useCallback(() => {
    const latest = latestEvidence.current;
    if (latest) setEvaluation(evaluateLiveDeployment(latest.pages, latest.scanner));
  }, []);

  const check = useCallback(async () => {
    await runLiveDeploymentStatusCheck(
      statusOperation,
      {
        pagesReceiptUrl: PAGES_RECEIPT_URL,
        scannerHealthUrl: scannerApiUrl("/api/health")
      },
      {
        onStart: () => setChecking(true),
        onSuccess: ({ evidence, evaluation: nextEvaluation }) => {
          latestEvidence.current = evidence;
          setEvaluation(nextEvaluation);
        },
        onError: () => {
          latestEvidence.current = null;
          setEvaluation({
            ...INITIAL,
            summary: "Current deployment status could not be verified from this browser. Unknown is not treated as healthy."
          });
        },
        onSettled: () => setChecking(false)
      }
    );
  }, [statusOperation]);

  useEffect(() => {
    void check();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, PUBLIC_STATUS_UI_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      reevaluateLatest();
      void check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      statusOperation.cancel();
    };
  }, [check, reevaluateLatest, statusOperation]);

  useEffect(() => {
    const expiryDelay = freshnessExpiryDelayMs(
      evaluation.checkedAt,
      PUBLIC_STATUS_MAX_HEALTH_AGE_MS
    );
    if (expiryDelay === null) return;
    const expiry = window.setTimeout(reevaluateLatest, expiryDelay);
    return () => window.clearTimeout(expiry);
  }, [evaluation.checkedAt, reevaluateLatest]);

  const badgeLabel = checking
    ? "Checking"
    : evaluation.state === "aligned"
      ? "Endpoints aligned"
      : evaluation.state === "rolling-out"
        ? "Rolling out"
        : evaluation.state === "degraded"
          ? "Degraded"
          : evaluation.state === "stale"
            ? "Stale"
            : "Unknown";

  return (
    // The live region is the summary sentence alone. Marking the whole section
    // live made every 60-second re-check re-announce the heading, badge, all
    // three revision facts, and the buttons, which is a minute-by-minute
    // interruption for a screen-reader user reading anything else on the page.
    <section className="legal-section status-live" aria-labelledby="live-status-heading">
      <div className="status-heading-row">
        <div>
          <p className="eyebrow">Live deployment</p>
          <h2 id="live-status-heading">Public site and scanner</h2>
        </div>
        <span className={`status-badge state-${checking ? "checking" : evaluation.state}`}>{badgeLabel}</span>
      </div>
      <p aria-live="polite">
        {checking ? "Checking the public deployment and scanner health endpoints…" : evaluation.summary}
      </p>
      <dl className="status-fact-grid">
        <div>
          <dt>Site revision</dt>
          <dd><Commit value={evaluation.pagesDeployment} /></dd>
        </div>
        <div>
          <dt>Scanner revision</dt>
          <dd><Commit value={evaluation.scannerDeployment} /></dd>
        </div>
        <div>
          <dt>Health observed</dt>
          <dd>{evaluation.checkedAt ? formatUtc(evaluation.checkedAt) : "Unknown"}</dd>
        </div>
      </dl>
      <p className="status-actions">
        <button className="secondary-button" type="button" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>
        <a href={PAGES_RECEIPT_URL}>Site receipt</a>
        <a href={scannerApiUrl("/api/health")}>Scanner health JSON</a>
      </p>
    </section>
  );
}

function Commit({ value }: { value: string | null }) {
  return value ? <code title={value}>{value.slice(0, 12)}</code> : <>Unknown</>;
}

function formatUtc(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Date(timestamp).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }) + " UTC";
}

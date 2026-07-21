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

  const reevaluateLatest = useCallback(() => {
    const latest = latestEvidence.current;
    if (latest) setEvaluation(evaluateLiveDeployment(latest.pages, latest.scanner));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const [pagesResponse, scannerResponse] = await Promise.all([
        fetch(PAGES_RECEIPT_URL, { cache: "no-store", signal: controller.signal }),
        fetch(scannerApiUrl("/api/health"), { cache: "no-store", signal: controller.signal })
      ]);
      if (!pagesResponse.ok || !scannerResponse.ok) throw new Error("status endpoint unavailable");
      const pages = await pagesResponse.json() as unknown;
      const scanner = await scannerResponse.json() as unknown;
      latestEvidence.current = { pages, scanner };
      const nextEvaluation = evaluateLiveDeployment(pages, scanner);
      setEvaluation(nextEvaluation);
    } catch {
      latestEvidence.current = null;
      setEvaluation({
        ...INITIAL,
        summary: "Current deployment status could not be verified from this browser. Unknown is not treated as healthy."
      });
    } finally {
      window.clearTimeout(timeout);
      setChecking(false);
    }
  }, []);

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
    };
  }, [check, reevaluateLatest]);

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
      : evaluation.state === "degraded"
        ? "Degraded"
        : evaluation.state === "stale"
          ? "Stale"
          : "Unknown";

  return (
    <section className="legal-section status-live" aria-labelledby="live-status-heading" aria-live="polite">
      <div className="status-heading-row">
        <div>
          <p className="eyebrow">Live deployment</p>
          <h2 id="live-status-heading">Public site and scanner</h2>
        </div>
        <span className={`status-badge state-${checking ? "checking" : evaluation.state}`}>{badgeLabel}</span>
      </div>
      <p>{checking ? "Checking the public deployment and scanner health endpoints…" : evaluation.summary}</p>
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

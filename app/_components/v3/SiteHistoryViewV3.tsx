"use client";

import { useEffect, useState } from "react";
import { LIVE_SCAN_API_BASE, STATIC_BASE_PATH, STATIC_EXPORT } from "@/app/client-runtime";
import styles from "@/app/v3/v3.module.css";
import { resolveV3ApiUrl, resolveV3DynamicPageUrl } from "@/lib/v3/client-urls";
import type { IndexedReportRowV3, TemporalReportDiffV3 } from "@/lib/v3/schema";

const V3_LOCATION = {
  staticExport: STATIC_EXPORT,
  scanApiBase: LIVE_SCAN_API_BASE,
  basePath: STATIC_BASE_PATH
};

export function SiteHistoryViewV3({
  domain,
  history
}: {
  domain: string;
  history: IndexedReportRowV3[];
}) {
  const [currentId, setCurrentId] = useState(history[0]?.reportId ?? "");
  const [previousId, setPreviousId] = useState(history[1]?.reportId ?? "");
  const [diff, setDiff] = useState<TemporalReportDiffV3 | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (!previousId || !currentId || previousId === currentId) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    async function loadDiff() {
      setDiffLoading(true);
      setDiffError(null);
      try {
        const resp = await fetch(
          resolveV3ApiUrl(
            `/api/v3/watches/diff?previous=${encodeURIComponent(previousId)}&current=${encodeURIComponent(currentId)}`,
            LIVE_SCAN_API_BASE
          )
        );
        const data = (await resp.json()) as { ok?: boolean; diff?: TemporalReportDiffV3; error?: string };
        if (cancelled) return;
        if (!resp.ok || !data.ok || !data.diff) {
          setDiffError(data.error ?? "Could not compute temporal diff.");
          return;
        }
        setDiff(data.diff);
      } catch (err) {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : "Network error");
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    }
    void loadDiff();
    return () => {
      cancelled = true;
    };
  }, [previousId, currentId]);

  return (
    <>
      <section className={styles.panel}>
        <h1 className={styles.title}>{domain} — Scan History &amp; Temporal Diff</h1>
        <p className={styles.subtitle}>
          {history.length} archived v3 snapshot{history.length === 1 ? "" : "s"}. Select any two scans below to
          inspect metric deltas, added/removed trackers, and automated privacy regression alerts.
        </p>

        {history.length >= 2 && (
          <div className={styles.formGrid} style={{ marginTop: 14 }}>
            <label className={styles.fieldLabel}>
              Baseline (Previous Scan)
              <select className={styles.select} value={previousId} onChange={(e) => setPreviousId(e.target.value)}>
                {history.map((h) => (
                  <option key={h.reportId} value={h.reportId}>
                    {formatUtcTimestamp(h.scannedAt)} ({h.egressRegion}) — {h.reportId.slice(0, 17)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              Target (Current Scan)
              <select className={styles.select} value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
                {history.map((h) => (
                  <option key={h.reportId} value={h.reportId}>
                    {formatUtcTimestamp(h.scannedAt)} ({h.egressRegion}) — {h.reportId.slice(0, 17)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </section>

      {diffLoading && (
        <section className={styles.panel}>
          <div className={styles.emptyState}>Computing side-by-side privacy regression diff...</div>
        </section>
      )}

      {diffError && (
        <section className={styles.panel}>
          <div className={`${styles.highlightItem} ${styles.hlCritical}`}>{diffError}</div>
        </section>
      )}

      {diff && (
        <section className={styles.panel}>
          <h2 className={styles.sectionTitle}>Temporal Regression Diff</h2>
          <div className={styles.kpiGrid}>
            <div className={styles.kpiCard}>
              <div className={styles.kpiValue}>{signed(diff.metrics.thirdPartyDomainsDelta)}</div>
              <div className={styles.kpiLabel}>3P Domains Δ</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiValue}>{signed(diff.metrics.thirdPartyRequestsDelta)}</div>
              <div className={styles.kpiLabel}>3P Requests Δ</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiValue}>{signed(diff.metrics.cookiesDelta)}</div>
              <div className={styles.kpiLabel}>Cookies Δ</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiValue}>{signed(diff.metrics.darkPatternScoreDelta)}</div>
              <div className={styles.kpiLabel}>Dark Pattern Score Δ</div>
            </div>
          </div>

          {diff.regressions.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Regression Alerts ({diff.regressions.length})</h3>
              <ul className={styles.highlightsList}>
                {diff.regressions.map((r, i) => (
                  <li
                    key={`${r.kind}-${i}`}
                    className={`${styles.highlightItem} ${
                      r.severity === "critical"
                        ? styles.hlCritical
                        : r.severity === "high"
                          ? styles.hlHigh
                          : styles.hlMedium
                    }`}
                  >
                    <div className={styles.highlightTitle}>{r.title}</div>
                    <div className={styles.highlightDetail}>{r.detail}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {diff.improvements.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Observed Improvements</h3>
              <ul className={styles.highlightsList}>
                {diff.improvements.map((imp, i) => (
                  <li key={i} className={`${styles.highlightItem}`}>
                    {imp}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.chipsRow} style={{ marginTop: 14 }}>
            {diff.entitiesAdded.map((e) => (
              <span key={`add-${e}`} className={`${styles.chip} ${styles.chipLoud}`}>
                + Entity: {e}
              </span>
            ))}
            {diff.entitiesRemoved.map((e) => (
              <span key={`rem-${e}`} className={`${styles.chip} ${styles.chipOk}`}>
                − Entity: {e}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>All Snapshots</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Scanned At</th>
                <th>Region / Device</th>
                <th className={styles.num}>3P Domains</th>
                <th className={styles.num}>Tracking Req</th>
                <th className={styles.num}>Cookies</th>
                <th className={styles.num}>Dark Pattern</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.reportId}>
                  <td>{formatUtcTimestamp(row.scannedAt)}</td>
                  <td className={styles.mono}>
                    {row.egressRegion} / {row.device}
                  </td>
                  <td className={styles.num}>{row.thirdPartyDomains}</td>
                  <td className={styles.num}>{row.trackingRequests}</td>
                  <td className={styles.num}>{row.cookiesTotal}</td>
                  <td className={styles.num}>{row.darkPatternScore}/100</td>
                  <td>
                    <a href={resolveV3DynamicPageUrl(`/v3/reports/${row.reportId}`, V3_LOCATION)} className={styles.btn}>
                      Open Report
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function formatUtcTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

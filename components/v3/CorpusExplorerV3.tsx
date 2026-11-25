"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import styles from "@/app/v3/v3.module.css";
import type { ComparisonAxisV3, ScanDeviceV3, ScanReportV3 } from "@/lib/v3/schema";
import type { CorpusOverviewStatsV3, IndexedReportRowV3 } from "@/lib/v3/storage/report-index";
import type { ScanRegionIdV3 } from "@/lib/v3/runtime/worker-dispatch";
import { ReportViewV3 } from "./ReportViewV3";

export function CorpusExplorerV3() {
  // Live scanner form state
  const [scanUrl, setScanUrl] = useState("");
  const [device, setDevice] = useState<ScanDeviceV3>("desktop");
  const [region, setRegion] = useState<ScanRegionIdV3>("auto");
  const [comparisons, setComparisons] = useState<ComparisonAxisV3[]>(["shields-standard", "gpc"]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<{ report: ScanReportV3; sharePath: string } | null>(null);

  // Faceted corpus search state
  const [stats, setStats] = useState<CorpusOverviewStatsV3 | null>(null);
  const [items, setItems] = useState<IndexedReportRowV3[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingCorpus, setLoadingCorpus] = useState(true);
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState("");
  const [parentOrg, setParentOrg] = useState("");
  const [sort, setSort] = useState("newest");
  const [hasKeystrokes, setHasKeystrokes] = useState(false);
  const [hasCname, setHasCname] = useState(false);
  const [hasSgtm, setHasSgtm] = useState(false);
  const [hasFp, setHasFp] = useState(false);
  const [highDarkPattern, setHighDarkPattern] = useState(false);

  const loadCorpus = useCallback(async () => {
    setLoadingCorpus(true);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (entity.trim()) qs.set("entity", entity.trim());
      if (parentOrg.trim()) qs.set("parentOrg", parentOrg.trim());
      if (sort) qs.set("sort", sort);
      if (hasKeystrokes) qs.set("keystrokes", "1");
      if (hasCname) qs.set("cname", "1");
      if (hasSgtm) qs.set("sgtm", "1");
      if (hasFp) qs.set("fingerprinting", "1");
      if (highDarkPattern) qs.set("minDarkPatternScore", "35");

      const [statsResp, listResp] = await Promise.all([
        fetch("/api/v3/corpus?view=stats"),
        fetch(`/api/v3/corpus?${qs.toString()}`)
      ]);
      if (statsResp.ok) {
        const d = (await statsResp.json()) as { stats?: CorpusOverviewStatsV3 };
        if (d.stats) setStats(d.stats);
      }
      if (listResp.ok) {
        const d = (await listResp.json()) as { items?: IndexedReportRowV3[]; total?: number };
        setItems(d.items ?? []);
        setTotal(d.total ?? 0);
      }
    } catch {
      // Static Pages builds without an active API will show empty state gracefully.
    } finally {
      setLoadingCorpus(false);
    }
  }, [q, entity, parentOrg, sort, hasKeystrokes, hasCname, hasSgtm, hasFp, highDarkPattern]);

  useEffect(() => {
    void loadCorpus();
  }, [loadCorpus]);

  function toggleComparison(axis: ComparisonAxisV3) {
    setComparisons((prev) =>
      prev.includes(axis) ? prev.filter((a) => a !== axis) : [...prev, axis]
    );
  }

  async function handleRunScan(e: React.FormEvent) {
    e.preventDefault();
    if (!scanUrl.trim()) return;
    setScanning(true);
    setScanError(null);
    try {
      const resp = await fetch("/api/v3/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: scanUrl.trim(),
          device,
          region,
          comparisons
        })
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        report?: ScanReportV3;
        sharePath?: string;
      };
      if (!resp.ok || !data.ok || !data.report) {
        setScanError(data.error ?? `Scan failed (HTTP ${resp.status})`);
        return;
      }
      setLiveResult({ report: data.report, sharePath: data.sharePath ?? `/v3/reports/${data.report.reportId}` });
      void loadCorpus();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Network error submitting v3 scan");
    } finally {
      setScanning(false);
    }
  }

  return (
    <>
      {/* Live v3 Scanner */}
      <section className={styles.panel}>
        <h1 className={styles.title}>Live v3 Privacy &amp; Behavior Scanner</h1>
        <p className={styles.subtitle}>
          Runs isolated concurrent CDP browser arms with full Brave Shields rule attribution, CNAME uncloaking,
          18-protocol beacon &amp; sGTM decoding, Shadow DOM keystroke auditing, and 2-layer CMP dark-pattern scoring.
        </p>

        <form onSubmit={handleRunScan} style={{ marginTop: 16 }}>
          <div className={styles.formGrid}>
            <label className={styles.fieldLabel} style={{ gridColumn: "span 2" }}>
              Website URL
              <input
                className={styles.input}
                type="url"
                required
                placeholder="https://example.com"
                value={scanUrl}
                onChange={(e) => setScanUrl(e.target.value)}
              />
            </label>
            <label className={styles.fieldLabel}>
              Egress Region
              <select
                className={styles.select}
                value={region}
                onChange={(e) => setRegion(e.target.value as ScanRegionIdV3)}
              >
                <option value="auto">Auto (Default)</option>
                <option value="us-east">US East (CCPA / GPC)</option>
                <option value="eu-central">EU Frankfurt (GDPR)</option>
                <option value="ap-northeast">APAC Tokyo (APPI)</option>
              </select>
            </label>
            <label className={styles.fieldLabel}>
              Device
              <select
                className={styles.select}
                value={device}
                onChange={(e) => setDevice(e.target.value as ScanDeviceV3)}
              >
                <option value="desktop">Desktop</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
            <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={scanning}>
              {scanning ? "Scanning concurrently..." : "Run v3 Scan"}
            </button>
          </div>

          <div className={styles.checkboxRow}>
            <span>Concurrent intervention arms:</span>
            {(
              [
                ["shields-standard", "Brave Shields (Standard)"],
                ["shields-aggressive", "Brave Shields (Aggressive)"],
                ["gpc", "Global Privacy Control (GPC)"],
                ["consent-reject", "Consent: Reject All"]
              ] as [ComparisonAxisV3, string][]
            ).map(([axis, label]) => (
              <label key={axis} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={comparisons.includes(axis)}
                  onChange={() => toggleComparison(axis)}
                />
                {label}
              </label>
            ))}
          </div>
        </form>

        {scanError && (
          <div className={`${styles.highlightItem} ${styles.hlCritical}`} style={{ marginTop: 12 }}>
            {scanError}
          </div>
        )}
      </section>

      {liveResult && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className={styles.panel} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Live Scan Complete — Report {liveResult.report.reportId}</strong>
            <Link href={liveResult.sharePath} className={`${styles.btn} ${styles.btnPrimary}`}>
              Open Permalink
            </Link>
          </div>
          <ReportViewV3 report={liveResult.report} />
        </div>
      )}

      {/* O(1) SQL Corpus Overview KPIs */}
      {stats && (
        <section className={styles.kpiGrid} aria-label="Corpus overview statistics">
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.distinctSites}</div>
            <div className={styles.kpiLabel}>Indexed Sites</div>
            <div className={styles.kpiSub}>{stats.totalReports} total v3 snapshots</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.medianThirdPartyDomains}</div>
            <div className={styles.kpiLabel}>Median 3P Domains</div>
            <div className={styles.kpiSub}>Latest scan per site</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.sitesWithKeystrokeLeaks}</div>
            <div className={styles.kpiLabel}>Keystroke Exfiltration</div>
            <div className={styles.kpiSub}>Sites leaking pre-submit input</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.sitesWithServerSideTagging}</div>
            <div className={styles.kpiLabel}>1st-Party sGTM / CAPI</div>
            <div className={styles.kpiSub}>{stats.sitesWithCnameCloaks} CNAME-cloaked</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.sitesWithDarkPatterns}</div>
            <div className={styles.kpiLabel}>CMP Dark Patterns ≥35</div>
            <div className={styles.kpiSub}>{stats.sitesWithFingerprinting} with fingerprinting</div>
          </div>
        </section>
      )}

      {/* Faceted Searchable Corpus Explorer */}
      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Searchable Evidence Corpus ({total} matching sites)</h2>
        <div className={styles.formGrid}>
          <label className={styles.fieldLabel}>
            Search domain or highlight
            <input
              className={styles.input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. cnn.com, sGTM, keystroke..."
            />
          </label>
          <label className={styles.fieldLabel}>
            Filter by Entity
            <input
              className={styles.input}
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="e.g. Google Analytics, Meta Pixel"
            />
          </label>
          <label className={styles.fieldLabel}>
            Parent Org
            <input
              className={styles.input}
              value={parentOrg}
              onChange={(e) => setParentOrg(e.target.value)}
              placeholder="e.g. Alphabet, Meta, ByteDance"
            />
          </label>
          <label className={styles.fieldLabel}>
            Sort by
            <select className={styles.select} value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="newest">Most recent</option>
              <option value="third-parties">Most 3P domains</option>
              <option value="dark-patterns">Highest CMP dark-pattern score</option>
              <option value="tracking-requests">Most tracking requests</option>
              <option value="cookies">Most cookies</option>
            </select>
          </label>
        </div>

        <div className={styles.checkboxRow}>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={hasKeystrokes} onChange={(e) => setHasKeystrokes(e.target.checked)} />
            Keystroke leaks
          </label>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={hasCname} onChange={(e) => setHasCname(e.target.checked)} />
            CNAME cloaking
          </label>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={hasSgtm} onChange={(e) => setHasSgtm(e.target.checked)} />
            Server-side tagging (sGTM/CAPI)
          </label>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={hasFp} onChange={(e) => setHasFp(e.target.checked)} />
            Fingerprinting / DOM replay
          </label>
          <label className={styles.checkboxLabel}>
            <input type="checkbox" checked={highDarkPattern} onChange={(e) => setHighDarkPattern(e.target.checked)} />
            CMP Dark Patterns ≥35
          </label>
        </div>

        <div className={styles.tableWrap} style={{ marginTop: 14 }}>
          {loadingCorpus ? (
            <div className={styles.emptyState}>Querying D1/SQLite corpus index...</div>
          ) : items.length === 0 ? (
            <div className={styles.emptyState}>
              No v3 reports match these filters yet. Run a live scan above or populate the corpus with{" "}
              <code>node scripts/seed-v3-corpus.mjs</code>.
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Region</th>
                  <th className={styles.num}>3P Domains</th>
                  <th className={styles.num}>Tracking Req</th>
                  <th className={styles.num}>Cookies</th>
                  <th className={styles.num}>Dark Pattern</th>
                  <th>Signals</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.reportId}>
                    <td>
                      <Link href={`/v3/reports/${row.reportId}`} style={{ fontWeight: 600, color: "var(--accent-strong)" }}>
                        {row.canonicalDomain}
                      </Link>
                      {row.topHighlight && (
                        <div style={{ color: "var(--text-muted)", maxWidth: 320 }}>{row.topHighlight}</div>
                      )}
                    </td>
                    <td className={styles.mono}>{row.egressRegion}</td>
                    <td className={styles.num}>{row.thirdPartyDomains}</td>
                    <td className={styles.num}>{row.trackingRequests}</td>
                    <td className={styles.num}>{row.cookiesTotal}</td>
                    <td className={styles.num}>{row.darkPatternScore}/100</td>
                    <td>
                      <div className={styles.chipsRow} style={{ marginTop: 0 }}>
                        {row.keystrokeLeaksCount > 0 && (
                          <span className={`${styles.chip} ${styles.chipLoud}`}>
                            {row.keystrokeLeaksCount} keystroke
                          </span>
                        )}
                        {row.cnameCloaksCount > 0 && (
                          <span className={`${styles.chip} ${styles.chipWarn}`}>{row.cnameCloaksCount} CNAME</span>
                        )}
                        {row.serverSideTaggingEndpoints > 0 && (
                          <span className={`${styles.chip} ${styles.chipWarn}`}>sGTM</span>
                        )}
                        {row.fingerprintKindsCount > 0 && (
                          <span className={`${styles.chip} ${styles.chipInfo}`}>{row.fingerprintKindsCount} FP</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className={styles.actionsRow}>
                        <Link href={`/v3/reports/${row.reportId}`} className={styles.btn}>
                          Report
                        </Link>
                        <Link href={`/v3/sites/${encodeURIComponent(row.canonicalDomain)}`} className={styles.btn}>
                          History
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

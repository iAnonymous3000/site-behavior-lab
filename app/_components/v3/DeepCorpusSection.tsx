"use client";

import { useCallback, useEffect, useState } from "react";
import { LIVE_SCAN_API_BASE, STATIC_BASE_PATH, STATIC_EXPORT } from "@/app/client-runtime";
import styles from "@/app/v3/v3.module.css";
import { resolveV3ApiUrl, resolveV3DynamicPageUrl } from "@/lib/v3/client-urls";
import type { CorpusOverviewStatsV3, IndexedReportRowV3 } from "@/lib/v3/schema";

const V3_LOCATION = {
  staticExport: STATIC_EXPORT,
  scanApiBase: LIVE_SCAN_API_BASE,
  basePath: STATIC_BASE_PATH
};

type StaticCorpusSnapshotV3 = {
  schemaVersion: 1;
  generatedAt: string;
  stats: CorpusOverviewStatsV3;
  items: IndexedReportRowV3[];
  entityDomains?: Record<string, string[]>;
  parentOrgDomains?: Record<string, string[]>;
};

let cachedSnapshotPromise: Promise<StaticCorpusSnapshotV3 | null> | null = null;

function loadStaticSnapshot(): Promise<StaticCorpusSnapshotV3 | null> {
  if (!cachedSnapshotPromise) {
    cachedSnapshotPromise = fetch(`${STATIC_BASE_PATH}/v3/corpus-snapshot.json`)
      .then(async (resp) => {
        if (!resp.ok) return null;
        const parsed = (await resp.json()) as Partial<StaticCorpusSnapshotV3>;
        if (parsed?.schemaVersion !== 1 || !parsed.stats || !Array.isArray(parsed.items)) return null;
        return parsed as StaticCorpusSnapshotV3;
      })
      .catch(() => null);
  }
  return cachedSnapshotPromise;
}

function filterSnapshot(
  snapshot: StaticCorpusSnapshotV3,
  filters: {
    q: string;
    entity: string;
    parentOrg: string;
    sort: string;
    hasKeystrokes: boolean;
    hasCname: boolean;
    hasSgtm: boolean;
    hasFp: boolean;
    highDarkPattern: boolean;
  }
): IndexedReportRowV3[] {
  const qNorm = filters.q.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const entityKey = filters.entity.trim().toLowerCase();
  const parentKey = filters.parentOrg.trim().toLowerCase();
  const entitySet = entityKey
    ? new Set(
        Object.entries(snapshot.entityDomains ?? {})
          .filter(([name]) => name.toLowerCase() === entityKey)
          .flatMap(([, domains]) => domains)
      )
    : null;
  const parentSet = parentKey
    ? new Set(
        Object.entries(snapshot.parentOrgDomains ?? {})
          .filter(([name]) => name.toLowerCase() === parentKey)
          .flatMap(([, domains]) => domains)
      )
    : null;

  const matched = snapshot.items.filter((row) => {
    if (qNorm) {
      const hay = `${row.canonicalDomain} ${row.finalUrl} ${row.topHighlight ?? ""}`.toLowerCase();
      if (!hay.includes(qNorm)) return false;
    }
    if (entitySet && !entitySet.has(row.canonicalDomain)) return false;
    if (parentSet && !parentSet.has(row.canonicalDomain)) return false;
    if (filters.hasKeystrokes && row.keystrokeLeaksCount <= 0) return false;
    if (filters.hasCname && row.cnameCloaksCount <= 0) return false;
    if (filters.hasSgtm && row.serverSideTaggingEndpoints <= 0) return false;
    if (filters.hasFp && row.fingerprintKindsCount <= 0) return false;
    if (filters.highDarkPattern && row.darkPatternScore < 35) return false;
    return true;
  });

  return matched.sort((a, b) => {
    if (filters.sort === "third-parties") return b.thirdPartyDomains - a.thirdPartyDomains;
    if (filters.sort === "dark-patterns") return b.darkPatternScore - a.darkPatternScore;
    if (filters.sort === "tracking-requests") return b.trackingRequests - a.trackingRequests;
    if (filters.sort === "cookies") return b.cookiesTotal - a.cookiesTotal;
    return b.scannedAt.localeCompare(a.scannedAt);
  });
}

/**
 * Editorial Direction A deep-signal corpus filter embedded inside /directory/.
 * Uses semantic list rows rather than a <table> so it fits narrow screens cleanly
 * without conflicting with the main site-profile evidence table above.
 */
export function DeepCorpusSection() {
  const [stats, setStats] = useState<CorpusOverviewStatsV3 | null>(null);
  const [items, setItems] = useState<IndexedReportRowV3[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState("");
  const [parentOrg, setParentOrg] = useState("");
  const [sort, setSort] = useState("third-parties");
  const [hasKeystrokes, setHasKeystrokes] = useState(false);
  const [hasCname, setHasCname] = useState(false);
  const [hasSgtm, setHasSgtm] = useState(false);
  const [hasFp, setHasFp] = useState(false);
  const [highDarkPattern, setHighDarkPattern] = useState(false);

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const resp = await fetch(resolveV3ApiUrl("/api/v3/corpus?view=stats", LIVE_SCAN_API_BASE), { signal });
      if (resp.ok) {
        const d = (await resp.json()) as { stats?: CorpusOverviewStatsV3 };
        if (d.stats) {
          setStats(d.stats);
          return;
        }
      }
    } catch {}
    if (signal?.aborted) return;
    const fallback = await loadStaticSnapshot();
    if (fallback && !signal?.aborted) setStats(fallback.stats);
  }, []);

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
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

        const resp = await fetch(resolveV3ApiUrl(`/api/v3/corpus?${qs.toString()}`, LIVE_SCAN_API_BASE), { signal });
        if (resp.ok) {
          const d = (await resp.json()) as { items?: IndexedReportRowV3[]; total?: number };
          if (!signal?.aborted) {
            setItems(d.items ?? []);
            setTotal(d.total ?? 0);
          }
          return;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        if (!signal?.aborted) setLoading(false);
      }

      if (signal?.aborted) return;
      const fallback = await loadStaticSnapshot();
      if (fallback && !signal?.aborted) {
        const filtered = filterSnapshot(fallback, {
          q,
          entity,
          parentOrg,
          sort,
          hasKeystrokes,
          hasCname,
          hasSgtm,
          hasFp,
          highDarkPattern
        });
        setItems(filtered);
        setTotal(filtered.length);
        setStats((prev) => prev ?? fallback.stats);
      }
    },
    [q, entity, parentOrg, sort, hasKeystrokes, hasCname, hasSgtm, hasFp, highDarkPattern]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStats(controller.signal);
    return () => controller.abort();
  }, [loadStats]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadList(controller.signal);
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loadList]);

  return (
    <section id="deep-signals" aria-labelledby="deep-signals-title">
      <div className="page-section-heading">
        <div>
          <p className="eyebrow">Multi-arm signal index</p>
          <h2 id="deep-signals-title">Filter by privacy signals ({total} matching sites)</h2>
        </div>
        <p>
          Search concurrent multi-arm visits by corporate parent, tracking vendor, first-party server-side tagging
          (sGTM/CAPI), CNAME cloaking, pre-submit keystroke transmission, fingerprinting, and CMP dark-pattern scores.
        </p>
      </div>

      {stats && (
        <div className={styles.kpiGrid} aria-label="Multi-arm index summary">
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.distinctSites}</div>
            <div className={styles.kpiLabel}>Indexed sites</div>
            <div className={styles.kpiSub}>{stats.totalReports} multi-arm snapshots</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.medianThirdPartyDomains}</div>
            <div className={styles.kpiLabel}>Median 3P domains</div>
            <div className={styles.kpiSub}>Latest visit per site</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.sitesWithKeystrokeLeaks}</div>
            <div className={styles.kpiLabel}>Keystroke leaks</div>
            <div className={styles.kpiSub}>Pre-submit input transmitted</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.sitesWithServerSideTagging}</div>
            <div className={styles.kpiLabel}>1st-party sGTM / CAPI</div>
            <div className={styles.kpiSub}>{stats.sitesWithCnameCloaks} CNAME-cloaked</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiValue}>{stats.sitesWithDarkPatterns}</div>
            <div className={styles.kpiLabel}>CMP dark patterns ≥35</div>
            <div className={styles.kpiSub}>{stats.sitesWithFingerprinting} with fingerprinting</div>
          </div>
        </div>
      )}

      <div className={styles.formGrid}>
        <label className={styles.fieldLabel}>
          Filter domain or finding
          <input
            className={styles.input}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. webmd.com, sGTM, keystroke…"
          />
        </label>
        <label className={styles.fieldLabel}>
          Vendor / entity
          <input
            className={styles.input}
            type="text"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            placeholder="e.g. Google Analytics, Criteo"
          />
        </label>
        <label className={styles.fieldLabel}>
          Parent organization
          <input
            className={styles.input}
            type="text"
            value={parentOrg}
            onChange={(e) => setParentOrg(e.target.value)}
            placeholder="e.g. Alphabet, Adobe, Amazon"
          />
        </label>
        <label className={styles.fieldLabel}>
          Order by
          <select className={styles.select} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="third-parties">Most 3P domains</option>
            <option value="newest">Most recent</option>
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
          CMP dark patterns ≥35
        </label>
      </div>

      {loading && items.length === 0 ? (
        <div className={styles.emptyState}>Loading indexed multi-arm visits…</div>
      ) : items.length === 0 ? (
        <div className={styles.emptyState}>No indexed multi-arm visits match the current signal filters.</div>
      ) : (
        <ol className={styles.corpusList}>
          {items.map((row) => (
            <li key={row.reportId} className={styles.corpusRow}>
              <div>
                <a
                  href={resolveV3DynamicPageUrl(`/v3/reports/${row.reportId}`, V3_LOCATION)}
                  className={styles.corpusDomain}
                >
                  {row.canonicalDomain}
                </a>
                {row.topHighlight && <p className={styles.corpusHighlight}>{row.topHighlight}</p>}
              </div>

              <div>
                <div className={styles.corpusMetrics}>
                  <span>
                    <strong>{row.thirdPartyDomains}</strong>{" "}
                    <span className={styles.corpusMetricLabel}>3P domains</span>
                  </span>
                  <span>
                    <strong>{row.trackingRequests}</strong>{" "}
                    <span className={styles.corpusMetricLabel}>tracking req</span>
                  </span>
                  <span>
                    <strong>{row.cookiesTotal}</strong> <span className={styles.corpusMetricLabel}>cookies</span>
                  </span>
                  <span>
                    <strong>{row.darkPatternScore}/100</strong>{" "}
                    <span className={styles.corpusMetricLabel}>CMP score</span>
                  </span>
                </div>
                {(row.keystrokeLeaksCount > 0 ||
                  row.cnameCloaksCount > 0 ||
                  row.serverSideTaggingEndpoints > 0 ||
                  row.fingerprintKindsCount > 0) && (
                  <div className={styles.chipsRow} style={{ marginTop: 8 }}>
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
                )}
              </div>

              <div className={styles.corpusRowActions}>
                <a
                  href={resolveV3DynamicPageUrl(`/v3/reports/${row.reportId}`, V3_LOCATION)}
                  className={styles.link}
                >
                  Inspect report
                </a>
                <a
                  href={resolveV3DynamicPageUrl(
                    `/v3/sites/${encodeURIComponent(row.canonicalDomain)}`,
                    V3_LOCATION
                  )}
                  className={styles.link}
                >
                  History &amp; diff
                </a>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

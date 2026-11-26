"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LIVE_SCAN_API_BASE, STATIC_BASE_PATH, STATIC_EXPORT } from "@/app/client-runtime";
import styles from "@/app/v3/v3.module.css";
import { resolveV3ApiUrl, resolveV3DynamicPageUrl } from "@/lib/v3/client-urls";
import {
  buildVendorFootprintFromSnapshotV3,
  loadStaticCorpusSnapshotV3
} from "@/lib/v3/corpus-snapshot-client";
import type { CatalogVendorEntryV3 } from "@/lib/v3/dev-mode";
import type {
  EntityFootprintResultV3,
  EntityRegionV3,
  ServiceCategoryV3
} from "@/lib/v3/schema";

const V3_LOCATION = {
  staticExport: STATIC_EXPORT,
  scanApiBase: LIVE_SCAN_API_BASE,
  basePath: STATIC_BASE_PATH
};

export function CatalogExplorerV3({
  entries,
  parentOrgs,
  totalDomains,
  initialEntity,
  embedded = false
}: {
  entries: CatalogVendorEntryV3[];
  parentOrgs: { parentOrg: string; entityCount: number; regions: EntityRegionV3[] }[];
  totalDomains: number;
  initialEntity?: string;
  embedded?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState<EntityRegionV3 | "ALL">("ALL");
  const [category, setCategory] = useState<ServiceCategoryV3 | "ALL">("ALL");

  // Reverse vendor lookup + multi-vendor block impact simulator
  const [selectedVendors, setSelectedVendors] = useState<string[]>(initialEntity ? [initialEntity] : []);
  const [footprints, setFootprints] = useState<Record<string, EntityFootprintResultV3>>({});
  const [loadingVendor, setLoadingVendor] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const attemptedVendorsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const entityParam = new URLSearchParams(window.location.search).get("entity")?.trim();
    if (entityParam) {
      setSelectedVendors((prev) => (prev.includes(entityParam) ? prev : [...prev, entityParam]));
    }
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (region !== "ALL" && e.region !== region) return false;
      if (category !== "ALL" && e.category !== category) return false;
      if (!q) return true;
      return (
        e.entity.toLowerCase().includes(q) ||
        e.parentOrg.toLowerCase().includes(q) ||
        e.domains.some((d) => d.includes(q))
      );
    });
  }, [entries, search, region, category]);

  useEffect(() => {
    const missing = selectedVendors.filter((v) => !attemptedVendorsRef.current.has(v));
    if (missing.length === 0) return;
    for (const v of missing) attemptedVendorsRef.current.add(v);

    const controller = new AbortController();
    let cancelled = false;
    let settled = false;
    async function fetchMissing() {
      setLoadingVendor(true);
      setLookupError(null);
      try {
        const fetched = await Promise.all(
          missing.map(async (name) => {
            try {
              const resp = await fetch(
                resolveV3ApiUrl(`/api/v3/corpus?footprint=${encodeURIComponent(name)}`, LIVE_SCAN_API_BASE),
                { signal: controller.signal }
              );
              if (resp.ok) {
                const data = (await resp.json()) as { footprint?: EntityFootprintResultV3 };
                if (data.footprint) return [name, data.footprint] as const;
              }
            } catch (err) {
              if (err instanceof DOMException && err.name === "AbortError") throw err;
            }
            const fallback = await loadStaticCorpusSnapshotV3(STATIC_BASE_PATH);
            return fallback ? ([name, buildVendorFootprintFromSnapshotV3(fallback, name)] as const) : null;
          })
        );
        if (cancelled) return;
        settled = true;
        const additions = fetched.filter((pair): pair is readonly [string, EntityFootprintResultV3] => pair !== null);
        if (additions.length > 0) {
          setFootprints((prev) => {
            const next = { ...prev };
            for (const [k, v] of additions) next[k] = v;
            return next;
          });
        } else {
          for (const v of missing) attemptedVendorsRef.current.delete(v);
          setLookupError("Live corpus lookup is currently unavailable.");
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          for (const v of missing) attemptedVendorsRef.current.delete(v);
          setLookupError(err instanceof Error ? err.message : "Live corpus lookup is unavailable.");
        }
      } finally {
        if (!cancelled) setLoadingVendor(false);
      }
    }
    void fetchMissing();
    return () => {
      cancelled = true;
      if (!settled) {
        for (const v of missing) attemptedVendorsRef.current.delete(v);
      }
      controller.abort();
    };
  }, [selectedVendors]);

  const hasPendingVendor = selectedVendors.some((v) => !(v in footprints));
  const isResolvingVendor = loadingVendor || (hasPendingVendor && !lookupError);

  function toggleVendor(name: string) {
    setSelectedVendors((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  }

  // Union of sites impacted if every selected vendor/parent org were blocked
  const simulation = useMemo(() => {
    const siteMap = new Map<string, { reportId: string; requests: number; vendors: string[] }>();
    let corpusSites = 0;
    for (const v of selectedVendors) {
      const fp = footprints[v];
      if (!fp) continue;
      corpusSites = Math.max(corpusSites, fp.corpusSites);
      for (const s of fp.sites) {
        const cur = siteMap.get(s.canonicalDomain) ?? { reportId: s.reportId, requests: 0, vendors: [] };
        cur.requests += s.requestCount;
        if (!cur.vendors.includes(v)) cur.vendors.push(v);
        siteMap.set(s.canonicalDomain, cur);
      }
    }
    const impactedSites = [...siteMap.entries()]
      .map(([domain, info]) => ({ domain, ...info }))
      .sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain));
    const pct = corpusSites > 0 ? Math.round((impactedSites.length / corpusSites) * 1000) / 10 : 0;
    const totalRequestsPrevented = impactedSites.reduce((sum, s) => sum + s.requests, 0);
    return { corpusSites, impactedSites, pct, totalRequestsPrevented };
  }, [selectedVendors, footprints]);

  return (
    <section
      className={embedded ? styles.section : styles.panel}
      id="vendor-simulator"
      aria-labelledby="vendor-simulator-heading"
    >
      <p className={styles.eyebrow}>Global corporate ownership &amp; footprint simulator</p>
      {embedded ? (
        <h2 id="vendor-simulator-heading" className={styles.sectionTitle}>
          Corporate ownership &amp; block-impact simulator
        </h2>
      ) : (
        <h1 id="vendor-simulator-heading" className={styles.title}>
          Corporate ownership &amp; block-impact simulator
        </h1>
      )}
      <p className={styles.subtitle}>
        {entries.length} global entities · {parentOrgs.length} parent organizations · {totalDomains} tracking domains
        across US, EU, UK, APAC, CN, RU, and LATAM. Select any corporate parent or vendor below to run a reverse
        lookup across the indexed corpus and simulate blocking its footprint.
      </p>

      <div className={styles.chipsRow} role="group" aria-label="Filter by major parent organization">
        {parentOrgs.slice(0, 12).map((p) => (
          <button
            key={p.parentOrg}
            type="button"
            className={`${styles.btn} ${selectedVendors.includes(p.parentOrg) ? styles.btnActive : ""}`}
            aria-pressed={selectedVendors.includes(p.parentOrg)}
            onClick={() => toggleVendor(p.parentOrg)}
          >
            {p.parentOrg} ({p.entityCount})
          </button>
        ))}
      </div>

      {/* Reverse Vendor Lookup & Impact Simulator */}
      {selectedVendors.length > 0 && (
        <div className={styles.calloutBand}>
          <div className={styles.heroHeader}>
            <div>
              <h3 className={styles.subHeading} style={{ marginTop: 0 }}>
                Block impact simulation: {selectedVendors.join(" + ")}
              </h3>
              <p className={styles.subtitle} style={{ marginTop: 4 }}>
                {isResolvingVendor
                  ? "Querying corpus footprint…"
                  : lookupError
                    ? lookupError
                    : `Observed on ${simulation.impactedSites.length} of ${simulation.corpusSites} indexed sites (${simulation.pct}%)${simulation.totalRequestsPrevented > 0 ? `, accounting for ${simulation.totalRequestsPrevented.toLocaleString()} baseline requests across the indexed corpus` : ""}.`}
              </p>
            </div>
            <button type="button" className={styles.btn} onClick={() => setSelectedVendors([])}>
              Clear selection
            </button>
          </div>

          {simulation.impactedSites.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Matched vendors / parents</th>
                    <th className={styles.num}>Observed requests</th>
                    <th>Report</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.impactedSites.map((s) => (
                    <tr key={s.domain}>
                      <td className={styles.mono}>{s.domain}</td>
                      <td>{s.vendors.join(", ")}</td>
                      <td className={styles.num}>{s.requests > 0 ? s.requests.toLocaleString() : "—"}</td>
                      <td>
                        <a
                          href={resolveV3DynamicPageUrl(`/v3/reports/${s.reportId}`, V3_LOCATION)}
                          className={styles.link}
                        >
                          Inspect report
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !isResolvingVendor && (
              <div className={styles.emptyState}>
                No indexed sites currently contact {selectedVendors.join(", ")}.
              </div>
            )
          )}
        </div>
      )}

      {/* Searchable 180+ Entity Directory */}
      <div className={styles.calloutBand}>
        <h3 className={styles.subHeading} style={{ marginTop: 0 }}>
          Global entity &amp; parent-company register ({filtered.length} matching entities)
        </h3>
        <div className={styles.formGrid}>
          <label className={styles.fieldLabel}>
            Search entity, parent org, or domain
            <input
              className={styles.input}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. Criteo, Yandex, Baidu, doubleclick…"
            />
          </label>
          <label className={styles.fieldLabel}>
            Region
            <select
              className={styles.select}
              value={region}
              onChange={(e) => setRegion(e.target.value as EntityRegionV3 | "ALL")}
            >
              <option value="ALL">All regions</option>
              <option value="US">US</option>
              <option value="EU">EU</option>
              <option value="UK">UK</option>
              <option value="APAC">APAC</option>
              <option value="CN">CN</option>
              <option value="RU">RU</option>
              <option value="LATAM">LATAM</option>
              <option value="GLOBAL">GLOBAL</option>
            </select>
          </label>
          <label className={styles.fieldLabel}>
            Category
            <select
              className={styles.select}
              value={category}
              onChange={(e) => setCategory(e.target.value as ServiceCategoryV3 | "ALL")}
            >
              <option value="ALL">All categories</option>
              <option value="advertising">Advertising</option>
              <option value="analytics">Analytics</option>
              <option value="session-replay">Session Replay</option>
              <option value="cdp">CDP</option>
              <option value="consent-platform">Consent Platform</option>
              <option value="tag-manager">Tag Manager</option>
              <option value="identity-broker">Identity Broker</option>
              <option value="server-side-tagging">Server-Side Tagging</option>
              <option value="marketing-automation">Marketing Automation</option>
              <option value="social-widget">Social Widget</option>
              <option value="anti-bot">Anti-Bot</option>
              <option value="error-monitoring">Error Monitoring</option>
              <option value="cdn-infra">CDN / Infra</option>
            </select>
          </label>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Entity</th>
                <th>Parent org</th>
                <th>Category</th>
                <th>Region</th>
                <th>Known domains</th>
                <th>Footprint</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 60).map((item) => {
                const active = selectedVendors.includes(item.entity);
                return (
                  <tr key={item.entity}>
                    <td>
                      <strong>{item.entity}</strong>
                    </td>
                    <td>{item.parentOrg}</td>
                    <td className={styles.mono}>{item.category}</td>
                    <td className={styles.mono}>{item.region}</td>
                    <td className={styles.mono}>{item.domains.slice(0, 5).join(", ")}</td>
                    <td>
                      <button
                        type="button"
                        className={`${styles.btn} ${active ? styles.btnActive : ""}`}
                        aria-pressed={active}
                        onClick={() => toggleVendor(item.entity)}
                      >
                        {active ? "Selected" : "Simulate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 60 && (
            <p className={styles.subtitle}>
              Showing the first 60 of {filtered.length} matching entities. Narrow the search, region, or category above
              to inspect others.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

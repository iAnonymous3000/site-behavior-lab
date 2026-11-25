"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "@/app/v3/v3.module.css";
import type { CatalogVendorEntryV3 } from "@/lib/v3/dev-mode";
import type { EntityRegionV3, ServiceCategoryV3 } from "@/lib/v3/schema";
import type { EntityFootprintResultV3 } from "@/lib/v3/storage/report-index";

export function CatalogExplorerV3({
  entries,
  parentOrgs,
  totalDomains,
  initialEntity
}: {
  entries: CatalogVendorEntryV3[];
  parentOrgs: { parentOrg: string; entityCount: number; regions: EntityRegionV3[] }[];
  totalDomains: number;
  initialEntity?: string;
}) {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState<EntityRegionV3 | "ALL">("ALL");
  const [category, setCategory] = useState<ServiceCategoryV3 | "ALL">("ALL");

  // Reverse vendor lookup + multi-vendor block impact simulator
  const [selectedVendors, setSelectedVendors] = useState<string[]>(initialEntity ? [initialEntity] : []);
  const [footprints, setFootprints] = useState<Record<string, EntityFootprintResultV3>>({});
  const [loadingVendor, setLoadingVendor] = useState(false);

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
    let cancelled = false;
    async function fetchMissing() {
      const missing = selectedVendors.filter((v) => !footprints[v]);
      if (missing.length === 0) return;
      setLoadingVendor(true);
      try {
        const fetched = await Promise.all(
          missing.map(async (name) => {
            const resp = await fetch(`/api/v3/corpus?footprint=${encodeURIComponent(name)}`);
            if (!resp.ok) return null;
            const data = (await resp.json()) as { footprint?: EntityFootprintResultV3 };
            return data.footprint ? ([name, data.footprint] as const) : null;
          })
        );
        if (cancelled) return;
        setFootprints((prev) => {
          const next = { ...prev };
          for (const pair of fetched) {
            if (pair) next[pair[0]] = pair[1];
          }
          return next;
        });
      } catch {
        // Offline / static export fallback
      } finally {
        if (!cancelled) setLoadingVendor(false);
      }
    }
    void fetchMissing();
    return () => {
      cancelled = true;
    };
  }, [selectedVendors, footprints]);

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
    <>
      <section className={styles.panel}>
        <h1 className={styles.title}>Global Entity Catalog &amp; Reverse Vendor Simulator</h1>
        <p className={styles.subtitle}>
          {entries.length} curated entities · {parentOrgs.length} parent organizations · {totalDomains} tracking
          domains across US, EU, UK, APAC, CN, RU, and LATAM. Select any vendor or corporate parent to run a live
          reverse corpus lookup and simulate blocking its footprint.
        </p>

        <div className={styles.chipsRow}>
          {parentOrgs.slice(0, 12).map((p) => (
            <button
              key={p.parentOrg}
              type="button"
              className={`${styles.btn} ${selectedVendors.includes(p.parentOrg) ? styles.btnActive : ""}`}
              onClick={() => toggleVendor(p.parentOrg)}
            >
              {p.parentOrg} ({p.entityCount})
            </button>
          ))}
        </div>
      </section>

      {/* Reverse Vendor Lookup & Impact Simulator */}
      {selectedVendors.length > 0 && (
        <section className={styles.panel}>
          <div className={styles.heroHeader}>
            <div>
              <h2 className={styles.sectionTitle}>
                Block Impact Simulation: {selectedVendors.join(" + ")}
              </h2>
              <p className={styles.subtitle}>
                {loadingVendor
                  ? "Querying corpus footprint..."
                  : `Present on ${simulation.impactedSites.length} of ${simulation.corpusSites} indexed sites (${simulation.pct}%), representing ${simulation.totalRequestsPrevented} baseline requests across the corpus.`}
              </p>
            </div>
            <button type="button" className={styles.btn} onClick={() => setSelectedVendors([])}>
              Clear Selection
            </button>
          </div>

          {simulation.impactedSites.length > 0 ? (
            <div className={styles.tableWrap} style={{ marginTop: 12 }}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Matched Vendors / Parents</th>
                    <th className={styles.num}>Observed Requests</th>
                    <th>Report</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.impactedSites.map((s) => (
                    <tr key={s.domain}>
                      <td className={styles.mono}>{s.domain}</td>
                      <td>{s.vendors.join(", ")}</td>
                      <td className={styles.num}>{s.requests}</td>
                      <td>
                        <Link href={`/v3/reports/${s.reportId}`} className={styles.btn}>
                          Inspect
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !loadingVendor && (
              <div className={styles.emptyState}>
                No indexed v3 corpus sites currently contact {selectedVendors.join(", ")}.
              </div>
            )
          )}
        </section>
      )}

      {/* Searchable 150+ Entity Directory */}
      <section className={styles.panel}>
        <div className={styles.formGrid} style={{ marginBottom: 14 }}>
          <label className={styles.fieldLabel}>
            Search entity, parent org, or domain
            <input
              className={styles.input}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="e.g. Criteo, Yandex, Baidu, doubleclick..."
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
                <th>Parent Org</th>
                <th>Category</th>
                <th>Region</th>
                <th>Known Domains</th>
                <th>Simulate Block</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
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
                        onClick={() => toggleVendor(item.entity)}
                      >
                        {active ? "Selected" : "Lookup"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/**
 * Shared client-side loader, filter, and vendor-footprint helpers for the
 * committed static `public/v3/corpus-snapshot.json` fallback.
 *
 * Used by `CorpusExplorerV3`, `DeepCorpusSection`, and `CatalogExplorerV3` so
 * all v3 static surfaces share one fetch cache and one deterministic filter/sort
 * implementation.
 */

import type {
  CorpusOverviewStatsV3,
  EntityFootprintResultV3,
  IndexedReportRowV3
} from "./schema";

export type StaticVendorSiteStatV3 = {
  domain: string;
  requests: number;
  domains: number;
  category?: string;
};

export type StaticCorpusSnapshotV3 = {
  schemaVersion: 1;
  generatedAt: string;
  stats: CorpusOverviewStatsV3;
  items: IndexedReportRowV3[];
  entityDomains?: Record<string, string[]>;
  parentOrgDomains?: Record<string, string[]>;
  entitySiteStats?: Record<string, StaticVendorSiteStatV3[]>;
  parentOrgSiteStats?: Record<string, StaticVendorSiteStatV3[]>;
};

export type CorpusSnapshotFilterStateV3 = {
  q: string;
  entity: string;
  parentOrg: string;
  sort: string;
  hasKeystrokes: boolean;
  hasCname: boolean;
  hasSgtm: boolean;
  hasFp: boolean;
  highDarkPattern: boolean;
};

const snapshotCacheByUrl = new Map<string, Promise<StaticCorpusSnapshotV3 | null>>();

export function loadStaticCorpusSnapshotV3(basePath = ""): Promise<StaticCorpusSnapshotV3 | null> {
  const url = `${basePath}/v3/corpus-snapshot.json`;
  let cached = snapshotCacheByUrl.get(url);
  if (!cached) {
    cached = fetch(url)
      .then(async (resp) => {
        if (!resp.ok) return null;
        const parsed = (await resp.json()) as Partial<StaticCorpusSnapshotV3>;
        if (parsed?.schemaVersion !== 1 || !parsed.stats || !Array.isArray(parsed.items)) return null;
        return parsed as StaticCorpusSnapshotV3;
      })
      .catch(() => null);
    snapshotCacheByUrl.set(url, cached);
  }
  return cached;
}

export function filterStaticCorpusSnapshotV3(
  snapshot: StaticCorpusSnapshotV3,
  filters: CorpusSnapshotFilterStateV3
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

export function buildVendorFootprintFromSnapshotV3(
  snapshot: StaticCorpusSnapshotV3,
  vendorName: string
): EntityFootprintResultV3 {
  const target = vendorName.trim().toLowerCase();
  const byDomain = new Map(snapshot.items.map((row) => [row.canonicalDomain, row]));
  const statByDomain = new Map<string, { requests: number; domains: number; category: string }>();

  for (const source of [snapshot.entitySiteStats, snapshot.parentOrgSiteStats]) {
    if (!source) continue;
    for (const [k, entries] of Object.entries(source)) {
      if (k.toLowerCase() !== target) continue;
      for (const entry of entries) {
        const cur = statByDomain.get(entry.domain);
        if (!cur || entry.requests > cur.requests) {
          statByDomain.set(entry.domain, {
            requests: Math.max(0, entry.requests),
            domains: Math.max(1, entry.domains),
            category: entry.category ?? "tracked"
          });
        }
      }
    }
  }

  if (statByDomain.size === 0) {
    const domainSet = new Set<string>();
    for (const [k, domains] of Object.entries(snapshot.entityDomains ?? {})) {
      if (k.toLowerCase() === target) {
        for (const d of domains) domainSet.add(d);
      }
    }
    for (const [k, domains] of Object.entries(snapshot.parentOrgDomains ?? {})) {
      if (k.toLowerCase() === target) {
        for (const d of domains) domainSet.add(d);
      }
    }
    for (const domain of domainSet) {
      statByDomain.set(domain, { requests: 0, domains: 1, category: "tracked" });
    }
  }

  const sites = [...statByDomain.entries()]
    .map(([domain, stat]) => {
      const row = byDomain.get(domain);
      if (!row) return null;
      return {
        canonicalDomain: row.canonicalDomain,
        reportId: row.reportId,
        scannedAt: row.scannedAt,
        category: stat.category,
        requestCount: stat.requests,
        domainCount: stat.domains
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.requestCount - a.requestCount || a.canonicalDomain.localeCompare(b.canonicalDomain));

  const corpusSites = snapshot.items.length;
  return {
    name: vendorName.trim(),
    totalSites: sites.length,
    corpusSites,
    prevalencePct: corpusSites > 0 ? Math.min(100, Math.round((sites.length / corpusSites) * 1000) / 10) : 0,
    sites
  };
}

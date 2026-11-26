/**
 * Runtime-neutral Cloudflare D1 / Node SQLite metadata & corpus index for
 * Site Behavior Lab v3.
 *
 * Eliminates both:
 *  - R2 `ListObjectsV2` + 1,000-HEAD pruning & the 936-share hard cap
 *  - Cold 12.6s / 450 MB filesystem `loadCorpusOverview()` scans
 *
 * Provides millisecond faceted corpus search, site history timelines,
 * reverse vendor/entity lookups, and O(1) aggregate corpus stats.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { reportV3Digest } from "../redaction";
import { extractAllArmEntitiesV3 } from "../scanner/summary";
import type {
  CorpusOverviewStatsV3,
  EntityFootprintResultV3,
  IndexedReportRowV3,
  IndexedReportVisibilityV3,
  ScanReportV3,
  ServiceCategoryV3
} from "../schema";

export type {
  CorpusOverviewStatsV3,
  EntityFootprintResultV3,
  IndexedReportRowV3,
  IndexedReportVisibilityV3
};

/** Minimal subset shared by Cloudflare D1 bindings and our Node `node:sqlite` adapter. */
export type SqlExecutorV3 = {
  exec(sql: string): Promise<void> | void;
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }> | { changes: number };
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> | T[];
  first<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null> | T | null;
};

export type CorpusQueryFiltersV3 = {
  query?: string;
  entity?: string;
  parentOrg?: string;
  category?: ServiceCategoryV3;
  region?: string;
  visibility?: IndexedReportVisibilityV3 | "all-public";
  latestPerSite?: boolean;
  minThirdPartyDomains?: number;
  hasKeystrokeLeaks?: boolean;
  hasCnameCloaks?: boolean;
  hasServerSideTagging?: boolean;
  hasFingerprinting?: boolean;
  minDarkPatternScore?: number;
  sort?: "newest" | "third-parties" | "dark-patterns" | "tracking-requests" | "cookies";
  limit?: number;
  offset?: number;
};

export type CorpusQueryResultV3 = {
  total: number;
  items: IndexedReportRowV3[];
};

export const V3_INDEX_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS reports (
    report_id TEXT PRIMARY KEY,
    canonical_domain TEXT NOT NULL,
    final_url TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    egress_region TEXT NOT NULL DEFAULT 'local',
    device TEXT NOT NULL DEFAULT 'desktop',
    load_outcome TEXT NOT NULL DEFAULT 'ok',
    http_status INTEGER,
    total_requests INTEGER NOT NULL DEFAULT 0,
    third_party_requests INTEGER NOT NULL DEFAULT 0,
    third_party_domains INTEGER NOT NULL DEFAULT 0,
    tracking_requests INTEGER NOT NULL DEFAULT 0,
    shields_blocked_standard INTEGER NOT NULL DEFAULT 0,
    shields_blocked_aggressive INTEGER NOT NULL DEFAULT 0,
    distinct_entities INTEGER NOT NULL DEFAULT 0,
    distinct_parent_orgs INTEGER NOT NULL DEFAULT 0,
    cookies_total INTEGER NOT NULL DEFAULT 0,
    third_party_cookies INTEGER NOT NULL DEFAULT 0,
    long_lived_cookies INTEGER NOT NULL DEFAULT 0,
    partitioned_cookies INTEGER NOT NULL DEFAULT 0,
    storage_keys_total INTEGER NOT NULL DEFAULT 0,
    websockets_total INTEGER NOT NULL DEFAULT 0,
    service_workers_total INTEGER NOT NULL DEFAULT 0,
    beacon_platforms INTEGER NOT NULL DEFAULT 0,
    server_side_tagging_endpoints INTEGER NOT NULL DEFAULT 0,
    cname_cloaks_count INTEGER NOT NULL DEFAULT 0,
    fingerprint_kinds_count INTEGER NOT NULL DEFAULT 0,
    keystroke_leaks_count INTEGER NOT NULL DEFAULT 0,
    dark_pattern_score INTEGER NOT NULL DEFAULT 0,
    top_highlight TEXT,
    r2_key TEXT NOT NULL,
    report_digest TEXT NOT NULL,
    expires_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_domain_time ON reports(canonical_domain, scanned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_visibility_time ON reports(visibility, scanned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_third_party ON reports(visibility, third_party_domains DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_dark_pattern ON reports(visibility, dark_pattern_score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_expires_at ON reports(expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS report_entities (
    report_id TEXT NOT NULL,
    canonical_domain TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    entity TEXT NOT NULL,
    parent_org TEXT NOT NULL,
    category TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    domain_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (report_id, entity)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_report_entities_entity ON report_entities(entity, scanned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_report_entities_parent ON report_entities(parent_org, scanned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_report_entities_category ON report_entities(category, scanned_at DESC)`,
  `CREATE TABLE IF NOT EXISTS report_beacons (
    report_id TEXT NOT NULL,
    canonical_domain TEXT NOT NULL,
    platform TEXT NOT NULL,
    format TEXT NOT NULL,
    endpoint_host TEXT NOT NULL,
    server_side_tagging INTEGER NOT NULL DEFAULT 0,
    has_identifiers INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (report_id, platform, endpoint_host)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_report_beacons_platform ON report_beacons(platform)`
];

export class D1ReportIndexStoreV3 {
  private readonly db: SqlExecutorV3;

  constructor(db: SqlExecutorV3) {
    this.db = db;
  }

  async init(): Promise<void> {
    for (const stmt of V3_INDEX_SCHEMA_STATEMENTS) {
      await this.db.exec(stmt);
    }
  }

  async indexReport(
    report: ScanReportV3,
    meta: { r2Key: string; visibility?: IndexedReportVisibilityV3; expiresAt?: string | null }
  ): Promise<void> {
    const s = report.leadArm.summary;
    const visibility = meta.visibility ?? "public";
    const digest = reportV3Digest(report);
    const topHighlight = report.highlights[0]?.title ?? null;
    const entitiesToIndex =
      report.leadArm.network.length > 0 ? extractAllArmEntitiesV3(report.leadArm) : s.topEntities;

    let inTxn = false;
    try {
      await this.db.exec("BEGIN IMMEDIATE");
      inTxn = true;
    } catch {
      // Cloudflare D1 disallows explicit SQL BEGIN; proceed statement-by-statement.
    }

    try {
      await this.db.run(
        `INSERT OR REPLACE INTO reports (
          report_id, canonical_domain, final_url, scanned_at, visibility, egress_region, device,
          load_outcome, http_status, total_requests, third_party_requests, third_party_domains,
          tracking_requests, shields_blocked_standard, shields_blocked_aggressive, distinct_entities,
          distinct_parent_orgs, cookies_total, third_party_cookies, long_lived_cookies,
          partitioned_cookies, storage_keys_total, websockets_total, service_workers_total,
          beacon_platforms, server_side_tagging_endpoints, cname_cloaks_count,
          fingerprint_kinds_count, keystroke_leaks_count, dark_pattern_score, top_highlight,
          r2_key, report_digest, expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          report.reportId,
          report.canonicalDomain.toLowerCase(),
          report.finalUrl,
          report.scannedAt,
          visibility,
          report.provenance.egressRegion,
          report.leadArm.conditions.device,
          report.leadArm.loadOutcome,
          report.leadArm.httpStatus,
          s.totalRequests,
          s.thirdPartyRequests,
          s.thirdPartyDomains,
          s.trackingRequests,
          s.shieldsBlockedStandard,
          s.shieldsBlockedAggressive,
          s.distinctEntities,
          s.distinctParentOrgs,
          s.cookiesTotal,
          s.thirdPartyCookies,
          s.longLivedCookies,
          s.partitionedCookies,
          s.storageKeysTotal,
          s.websocketsTotal,
          s.serviceWorkersTotal,
          s.beaconPlatforms,
          s.serverSideTaggingEndpoints,
          s.cnameCloaksCount,
          s.fingerprintKindsCount,
          s.keystrokeLeaksCount,
          s.darkPatternScore,
          topHighlight,
          meta.r2Key,
          digest,
          meta.expiresAt ?? null
        ]
      );

      await this.db.run(`DELETE FROM report_entities WHERE report_id = ?`, [report.reportId]);
      for (const ent of entitiesToIndex) {
        await this.db.run(
          `INSERT OR REPLACE INTO report_entities (
            report_id, canonical_domain, scanned_at, entity, parent_org, category, request_count, domain_count
          ) VALUES (?,?,?,?,?,?,?,?)`,
          [
            report.reportId,
            report.canonicalDomain.toLowerCase(),
            report.scannedAt,
            ent.entity,
            ent.parentOrg,
            ent.category,
            ent.requests,
            ent.domains
          ]
        );
      }

      await this.db.run(`DELETE FROM report_beacons WHERE report_id = ?`, [report.reportId]);
      for (const beacon of report.leadArm.beacons) {
        await this.db.run(
          `INSERT OR REPLACE INTO report_beacons (
            report_id, canonical_domain, platform, format, endpoint_host,
            server_side_tagging, has_identifiers, request_count
          ) VALUES (?,?,?,?,?,?,?,?)`,
          [
            report.reportId,
            report.canonicalDomain.toLowerCase(),
            beacon.platform,
            beacon.format,
            beacon.endpointHost,
            beacon.serverSideTagging ? 1 : 0,
            beacon.identifierCategories.length > 0 ? 1 : 0,
            beacon.requests
          ]
        );
      }
      if (inTxn) await this.db.exec("COMMIT");
    } catch (err) {
      if (inTxn) {
        try {
          await this.db.exec("ROLLBACK");
        } catch {}
      }
      throw err;
    }
  }

  async getReportMeta(reportId: string): Promise<IndexedReportRowV3 | null> {
    const row = await this.db.first<Record<string, unknown>>(
      `SELECT * FROM reports WHERE report_id = ?`,
      [reportId]
    );
    return row ? mapRow(row) : null;
  }

  async queryCorpus(filters: CorpusQueryFiltersV3 = {}): Promise<CorpusQueryResultV3> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const vis = filters.visibility ?? "all-public";
    if (vis === "all-public") {
      clauses.push(`r.visibility IN ('public', 'corpus')`);
    } else {
      clauses.push(`r.visibility = ?`);
      params.push(vis);
    }

    if (filters.latestPerSite !== false) {
      if (vis === "all-public") {
        clauses.push(
          `r.report_id = (SELECT r2.report_id FROM reports r2 WHERE r2.canonical_domain = r.canonical_domain AND r2.visibility IN ('public', 'corpus') ORDER BY r2.scanned_at DESC, r2.report_id DESC LIMIT 1)`
        );
      } else {
        clauses.push(
          `r.report_id = (SELECT r2.report_id FROM reports r2 WHERE r2.canonical_domain = r.canonical_domain AND r2.visibility = ? ORDER BY r2.scanned_at DESC, r2.report_id DESC LIMIT 1)`
        );
        params.push(vis);
      }
    }

    if (filters.query && filters.query.trim()) {
      const normalized = escapeLikePattern(normalizeSearchDomain(filters.query.slice(0, 128)));
      clauses.push(
        `(r.canonical_domain LIKE ? ESCAPE '\\' OR r.final_url LIKE ? ESCAPE '\\' OR r.top_highlight LIKE ? ESCAPE '\\')`
      );
      const pat = `%${normalized}%`;
      params.push(pat, pat, pat);
    }
    if (filters.entity) {
      clauses.push(`EXISTS (SELECT 1 FROM report_entities e WHERE e.report_id = r.report_id AND lower(e.entity) = lower(?))`);
      params.push(filters.entity);
    }
    if (filters.parentOrg) {
      clauses.push(`EXISTS (SELECT 1 FROM report_entities e WHERE e.report_id = r.report_id AND lower(e.parent_org) = lower(?))`);
      params.push(filters.parentOrg);
    }
    if (filters.category) {
      clauses.push(`EXISTS (SELECT 1 FROM report_entities e WHERE e.report_id = r.report_id AND e.category = ?)`);
      params.push(filters.category);
    }
    if (filters.region) {
      clauses.push(`r.egress_region = ?`);
      params.push(filters.region);
    }
    if (typeof filters.minThirdPartyDomains === "number") {
      clauses.push(`r.third_party_domains >= ?`);
      params.push(filters.minThirdPartyDomains);
    }
    if (filters.hasKeystrokeLeaks) clauses.push(`r.keystroke_leaks_count > 0`);
    if (filters.hasCnameCloaks) clauses.push(`r.cname_cloaks_count > 0`);
    if (filters.hasServerSideTagging) clauses.push(`r.server_side_tagging_endpoints > 0`);
    if (filters.hasFingerprinting) clauses.push(`r.fingerprint_kinds_count > 0`);
    if (typeof filters.minDarkPatternScore === "number") {
      clauses.push(`r.dark_pattern_score >= ?`);
      params.push(filters.minDarkPatternScore);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderBy =
      filters.sort === "third-parties"
        ? `ORDER BY r.third_party_domains DESC, r.scanned_at DESC`
        : filters.sort === "dark-patterns"
          ? `ORDER BY r.dark_pattern_score DESC, r.scanned_at DESC`
          : filters.sort === "tracking-requests"
            ? `ORDER BY r.tracking_requests DESC, r.scanned_at DESC`
            : filters.sort === "cookies"
              ? `ORDER BY r.cookies_total DESC, r.scanned_at DESC`
              : `ORDER BY r.scanned_at DESC, r.report_id DESC`;

    const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 50)));
    const offset = Math.max(0, Math.floor(filters.offset ?? 0));

    const countRow = await this.db.first<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM reports r ${where}`, params);
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT r.* FROM reports r ${where} ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      total: Number(countRow?.cnt ?? 0),
      items: rows.map(mapRow)
    };
  }

  async getSiteHistory(canonicalDomain: string, limit = 25): Promise<IndexedReportRowV3[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM reports
       WHERE canonical_domain = ? AND visibility IN ('public', 'corpus')
       ORDER BY scanned_at DESC, report_id DESC
       LIMIT ?`,
      [canonicalDomain.toLowerCase(), Math.max(1, Math.min(100, limit))]
    );
    return rows.map(mapRow);
  }

  /** Reverse vendor lookup: find every site contacting an entity or parent organization. */
  async getEntityFootprint(name: string, limit = 100): Promise<EntityFootprintResultV3> {
    const trimmed = name.trim().slice(0, 128);
    const totalSitesRow = await this.db.first<{ cnt: number }>(
      `SELECT COUNT(DISTINCT canonical_domain) AS cnt FROM reports WHERE visibility IN ('public', 'corpus')`
    );
    const corpusSites = Number(totalSitesRow?.cnt ?? 0);

    const matchedCountRow = await this.db.first<{ cnt: number }>(
      `SELECT COUNT(DISTINCT e.canonical_domain) AS cnt
       FROM report_entities e
       JOIN reports r ON r.report_id = e.report_id
       WHERE r.visibility IN ('public', 'corpus')
         AND r.report_id = (
           SELECT r2.report_id FROM reports r2
           WHERE r2.canonical_domain = r.canonical_domain AND r2.visibility IN ('public', 'corpus')
           ORDER BY r2.scanned_at DESC, r2.report_id DESC LIMIT 1
         )
         AND (lower(e.entity) = lower(?) OR lower(e.parent_org) = lower(?))`,
      [trimmed, trimmed]
    );
    const totalSites = Number(matchedCountRow?.cnt ?? 0);

    // Deduplicate per canonical_domain so corporate parent queries (e.g. "Alphabet")
    // aggregate all child entities on a site into one row and never exceed 100% prevalence.
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT
         e.canonical_domain,
         e.report_id,
         e.scanned_at,
         MIN(e.category) AS category,
         SUM(e.request_count) AS request_count,
         SUM(e.domain_count) AS domain_count
       FROM report_entities e
       JOIN reports r ON r.report_id = e.report_id
       WHERE r.visibility IN ('public', 'corpus')
         AND r.report_id = (
           SELECT r2.report_id FROM reports r2
           WHERE r2.canonical_domain = r.canonical_domain AND r2.visibility IN ('public', 'corpus')
           ORDER BY r2.scanned_at DESC, r2.report_id DESC LIMIT 1
         )
         AND (lower(e.entity) = lower(?) OR lower(e.parent_org) = lower(?))
       GROUP BY e.canonical_domain, e.report_id, e.scanned_at
       ORDER BY request_count DESC, e.canonical_domain ASC
       LIMIT ?`,
      [trimmed, trimmed, Math.max(1, Math.min(500, limit))]
    );

    const sites = rows.map((r) => ({
      canonicalDomain: String(r.canonical_domain),
      reportId: String(r.report_id),
      scannedAt: String(r.scanned_at),
      category: String(r.category),
      requestCount: Number(r.request_count),
      domainCount: Number(r.domain_count)
    }));

    return {
      name: trimmed,
      totalSites,
      corpusSites,
      prevalencePct: corpusSites > 0 ? Math.min(100, Math.round((totalSites / corpusSites) * 1000) / 10) : 0,
      sites
    };
  }

  /** O(1) SQL aggregate statistics over latest-per-site public/corpus reports. */
  async getCorpusOverviewStats(): Promise<CorpusOverviewStatsV3> {
    const latestCte = `
      WITH latest AS (
        SELECT r.*
        FROM reports r
        WHERE r.visibility IN ('public', 'corpus')
          AND r.report_id = (
            SELECT r2.report_id FROM reports r2
            WHERE r2.canonical_domain = r.canonical_domain AND r2.visibility IN ('public', 'corpus')
            ORDER BY r2.scanned_at DESC, r2.report_id DESC LIMIT 1
          )
      )`;

    const totals = await this.db.first<Record<string, unknown>>(
      `${latestCte}
       SELECT
         (SELECT COUNT(*) FROM reports WHERE visibility IN ('public', 'corpus')) AS total_reports,
         COUNT(*) AS distinct_sites,
         SUM(CASE WHEN keystroke_leaks_count > 0 THEN 1 ELSE 0 END) AS ks,
         SUM(CASE WHEN cname_cloaks_count > 0 THEN 1 ELSE 0 END) AS cname,
         SUM(CASE WHEN server_side_tagging_endpoints > 0 THEN 1 ELSE 0 END) AS sgtm,
         SUM(CASE WHEN fingerprint_kinds_count > 0 THEN 1 ELSE 0 END) AS fp,
         SUM(CASE WHEN dark_pattern_score >= 35 THEN 1 ELSE 0 END) AS dp
       FROM latest`
    );

    const distinctSites = Number(totals?.distinct_sites ?? 0);
    const medianRow =
      distinctSites > 0
        ? await this.db.first<{ third_party_domains: number }>(
            `${latestCte} SELECT third_party_domains FROM latest ORDER BY third_party_domains ASC LIMIT 1 OFFSET ?`,
            [Math.floor(distinctSites / 2)]
          )
        : null;
    const medianThirdPartyDomains = Number(medianRow?.third_party_domains ?? 0);

    const topEntitiesRows = await this.db.all<Record<string, unknown>>(
      `${latestCte}
       SELECT e.entity, e.parent_org, e.category, COUNT(DISTINCT e.canonical_domain) AS site_count
       FROM report_entities e
       JOIN latest l ON l.report_id = e.report_id
       GROUP BY e.entity, e.parent_org, e.category
       ORDER BY site_count DESC, e.entity ASC
       LIMIT 15`
    );

    const topParentRows = await this.db.all<Record<string, unknown>>(
      `${latestCte}
       SELECT e.parent_org, COUNT(DISTINCT e.canonical_domain) AS site_count
       FROM report_entities e
       JOIN latest l ON l.report_id = e.report_id
       GROUP BY e.parent_org
       ORDER BY site_count DESC, e.parent_org ASC
       LIMIT 12`
    );

    return {
      totalReports: Number(totals?.total_reports ?? 0),
      distinctSites: Number(totals?.distinct_sites ?? 0),
      medianThirdPartyDomains,
      sitesWithKeystrokeLeaks: Number(totals?.ks ?? 0),
      sitesWithCnameCloaks: Number(totals?.cname ?? 0),
      sitesWithServerSideTagging: Number(totals?.sgtm ?? 0),
      sitesWithFingerprinting: Number(totals?.fp ?? 0),
      sitesWithDarkPatterns: Number(totals?.dp ?? 0),
      topEntities: topEntitiesRows.map((r) => ({
        entity: String(r.entity),
        parentOrg: String(r.parent_org),
        category: String(r.category),
        siteCount: Number(r.site_count)
      })),
      topParentOrgs: topParentRows.map((r) => ({
        parentOrg: String(r.parent_org),
        siteCount: Number(r.site_count)
      }))
    };
  }

  /** Clean up expired report metadata rows (blobs expire natively via R2 object lifecycle). */
  async deleteExpiredRows(nowIso = new Date().toISOString()): Promise<number> {
    await this.db.run(
      `DELETE FROM report_entities WHERE report_id IN (SELECT report_id FROM reports WHERE expires_at IS NOT NULL AND expires_at <= ?)`,
      [nowIso]
    );
    await this.db.run(
      `DELETE FROM report_beacons WHERE report_id IN (SELECT report_id FROM reports WHERE expires_at IS NOT NULL AND expires_at <= ?)`,
      [nowIso]
    );
    const res = await this.db.run(
      `DELETE FROM reports WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      [nowIso]
    );
    return res.changes;
  }
}

/** Adapter wrapping Cloudflare Workers D1Database into SqlExecutorV3. */
export function wrapCloudflareD1(d1: {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}): SqlExecutorV3 {
  return {
    async exec(sql: string) {
      await d1.exec(sql);
    },
    async run(sql: string, params: readonly unknown[] = []) {
      const res = await d1.prepare(sql).bind(...params).run();
      return { changes: Number(res.meta?.changes ?? 0) };
    },
    async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const res = await d1.prepare(sql).bind(...params).all<T>();
      return res.results ?? [];
    },
    async first<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      return await d1.prepare(sql).bind(...params).first<T>();
    }
  };
}

/** Local Node `node:sqlite` executor for standalone, CLI, dev, and unit tests. */
export async function openNodeSqliteReportIndex(dbFilePath: string): Promise<{
  store: D1ReportIndexStoreV3;
  close: () => void;
}> {
  if (dbFilePath !== ":memory:") {
    mkdirSync(path.dirname(dbFilePath), { recursive: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(dbFilePath);
  const executor: SqlExecutorV3 = {
    exec(sql: string) {
      sqlite.exec(sql);
    },
    run(sql: string, params: readonly unknown[] = []) {
      const stmt = sqlite.prepare(sql);
      const res = stmt.run(...(params as (string | number | null | Uint8Array)[]));
      return { changes: Number(res.changes ?? 0) };
    },
    all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const stmt = sqlite.prepare(sql);
      return stmt.all(...(params as (string | number | null | Uint8Array)[])) as T[];
    },
    first<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const stmt = sqlite.prepare(sql);
      const row = stmt.get(...(params as (string | number | null | Uint8Array)[])) as T | undefined;
      return row ?? null;
    }
  };
  const store = new D1ReportIndexStoreV3(executor);
  await store.init();
  return { store, close: () => sqlite.close() };
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function normalizeSearchDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).hostname.replace(/^www\./, "");
  } catch {}
  return trimmed.replace(/^www\./, "");
}

function mapRow(r: Record<string, unknown>): IndexedReportRowV3 {
  return {
    reportId: String(r.report_id),
    canonicalDomain: String(r.canonical_domain),
    finalUrl: String(r.final_url),
    scannedAt: String(r.scanned_at),
    visibility: String(r.visibility) as IndexedReportVisibilityV3,
    egressRegion: String(r.egress_region),
    device: String(r.device),
    loadOutcome: String(r.load_outcome),
    httpStatus: r.http_status === null || r.http_status === undefined ? null : Number(r.http_status),
    totalRequests: Number(r.total_requests ?? 0),
    thirdPartyRequests: Number(r.third_party_requests ?? 0),
    thirdPartyDomains: Number(r.third_party_domains ?? 0),
    trackingRequests: Number(r.tracking_requests ?? 0),
    shieldsBlockedStandard: Number(r.shields_blocked_standard ?? 0),
    shieldsBlockedAggressive: Number(r.shields_blocked_aggressive ?? 0),
    distinctEntities: Number(r.distinct_entities ?? 0),
    distinctParentOrgs: Number(r.distinct_parent_orgs ?? 0),
    cookiesTotal: Number(r.cookies_total ?? 0),
    thirdPartyCookies: Number(r.third_party_cookies ?? 0),
    longLivedCookies: Number(r.long_lived_cookies ?? 0),
    partitionedCookies: Number(r.partitioned_cookies ?? 0),
    storageKeysTotal: Number(r.storage_keys_total ?? 0),
    websocketsTotal: Number(r.websockets_total ?? 0),
    serviceWorkersTotal: Number(r.service_workers_total ?? 0),
    beaconPlatforms: Number(r.beacon_platforms ?? 0),
    serverSideTaggingEndpoints: Number(r.server_side_tagging_endpoints ?? 0),
    cnameCloaksCount: Number(r.cname_cloaks_count ?? 0),
    fingerprintKindsCount: Number(r.fingerprint_kinds_count ?? 0),
    keystrokeLeaksCount: Number(r.keystroke_leaks_count ?? 0),
    darkPatternScore: Number(r.dark_pattern_score ?? 0),
    topHighlight: r.top_highlight === null || r.top_highlight === undefined ? null : String(r.top_highlight),
    r2Key: String(r.r2_key),
    reportDigest: String(r.report_digest),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : String(r.expires_at)
  };
}

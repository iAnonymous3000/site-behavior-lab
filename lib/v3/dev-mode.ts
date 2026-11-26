/**
 * Pure analytics powering Site Behavior Lab v3's interactive Causality Graph,
 * Phase Waterfall Timeline, Developer Mode root-cause attribution, and
 * Vendor Catalog / Impact Simulator.
 */

import { GLOBAL_ENTITY_CATALOG_V3, GLOBAL_ENTITY_CATALOG_V3_STATS } from "./entity-catalog";
import type {
  EntityRegionV3,
  NetworkRequestV3,
  ScanArmV3,
  ScanPhaseName,
  ServiceCategoryV3
} from "./schema";

export type CausalityEntityNodeV3 = {
  entity: string;
  parentOrg: string;
  category: ServiceCategoryV3;
  requests: number;
  trackingRequests: number;
  shieldsBlocked: number;
  domains: string[];
};

export type InitiatorAttributionKindV3 = "source" | "parser" | "unknown";

export const PARSER_INITIATOR_KEY_V3 = "document-parser";
export const UNKNOWN_INITIATOR_KEY_V3 = "unknown-initiator";

export type CausalityRootNodeV3 = {
  rootId: string;
  label: string;
  scriptDomain: string;
  scriptUrl: string | null;
  line: number | null;
  initiatorType: string;
  attribution: InitiatorAttributionKindV3;
  isFirstPartyScript: boolean;
  totalRequests: number;
  trackingRequests: number;
  shieldsMatchedRequests: number;
  distinctEntities: number;
  entities: CausalityEntityNodeV3[];
};

export type PhaseWaterfallRowV3 = {
  phase: ScanPhaseName;
  label: string;
  status: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  totalRequests: number;
  thirdPartyRequests: number;
  trackingRequests: number;
  shieldsBlocked: number;
  beacons: number;
  websockets: number;
};

export type DeveloperShieldsRuleRowV3 = {
  rule: string;
  list: string;
  exception: string | null;
  redirect: string | null;
  hasUrlRewrite: boolean;
  important: boolean;
  shouldBlockStandard: boolean;
  shouldBlockAggressive: boolean;
  matchedRequests: number;
  sampleDomains: string[];
  initiatorScripts: string[];
};

const PHASE_LABELS: Record<ScanPhaseName, string> = {
  "passive-load": "1. Passive Load",
  "consent-choice": "2. Consent Choice",
  "scroll-interaction": "3. Scroll (75%)",
  "active-input": "4. Active Input Probe",
  "policy-check": "5. Privacy Policy"
};

/**
 * Resolve the root originating initiator key for a network request, preferring
 * the outermost frame of its initiator call stack so both the Causality Graph
 * and request log filtering stay 100% consistent.
 *
 * Parser attribution (`"document-parser"`) is reserved strictly for explicit
 * `initiator.type === "parser"` evidence when no script/document domain is
 * recorded; requests with `type === "other"` (or other non-parser types) and
 * no source domain or stack are preserved as `"unknown-initiator"`.
 */
export function rootInitiatorDomainV3(req: NetworkRequestV3): string {
  const init = req.initiator;
  const stack = init?.callStack ?? [];
  const rootFrame = stack.length > 0 ? stack[stack.length - 1] : null;
  const sourceDomain = rootFrame?.domain?.trim() || init?.scriptDomain?.trim();
  if (sourceDomain) return sourceDomain.toLowerCase();
  if (init?.type === "parser") return PARSER_INITIATOR_KEY_V3;
  return UNKNOWN_INITIATOR_KEY_V3;
}

/**
 * Group third-party requests under their root originating script / tag manager /
 * parser initiator (or explicit unknown-initiator bucket when Chromium reported
 * no source domain or stack) so the Causality Graph and request filters agree.
 */
export function buildInitiatorCausalityTreeV3(arm: ScanArmV3): CausalityRootNodeV3[] {
  const byRoot = new Map<
    string,
    {
      label: string;
      scriptDomain: string;
      scriptUrl: string | null;
      line: number | null;
      initiatorType: string;
      attribution: InitiatorAttributionKindV3;
      isFirstPartyScript: boolean;
      totalRequests: number;
      trackingRequests: number;
      shieldsMatchedRequests: number;
      entityMap: Map<
        string,
        {
          entity: string;
          parentOrg: string;
          category: ServiceCategoryV3;
          requests: number;
          trackingRequests: number;
          shieldsBlocked: number;
          domains: Set<string>;
        }
      >;
    }
  >();

  let firstPartyDomain = "";
  try {
    firstPartyDomain = new URL(arm.finalUrl).hostname.toLowerCase();
  } catch {}

  for (const req of arm.network) {
    if (!req.thirdParty) continue;

    // Pick the outermost/first-party frame if present in the call stack, else top scriptUrl
    const init = req.initiator;
    const stack = init?.callStack ?? [];
    const rootFrame = stack.length > 0 ? stack[stack.length - 1] : null;
    const scriptUrl = rootFrame?.url || init?.scriptUrl || null;
    const scriptDomain = rootInitiatorDomainV3(req);
    const initType = init?.type ?? "other";
    const line = typeof rootFrame?.line === "number" ? rootFrame.line : null;
    const attribution: InitiatorAttributionKindV3 =
      scriptDomain === UNKNOWN_INITIATOR_KEY_V3
        ? "unknown"
        : scriptDomain === PARSER_INITIATOR_KEY_V3
          ? "parser"
          : "source";
    const isFirstPartyScript =
      attribution === "parser" ||
      (attribution === "source" &&
        firstPartyDomain.length > 0 &&
        (scriptDomain === firstPartyDomain ||
          firstPartyDomain.endsWith(`.${scriptDomain}`) ||
          scriptDomain.endsWith(`.${firstPartyDomain}`)));

    const rootKey =
      attribution === "unknown"
        ? UNKNOWN_INITIATOR_KEY_V3
        : attribution === "parser"
          ? PARSER_INITIATOR_KEY_V3
          : scriptUrl
            ? `${scriptDomain}|${truncatePath(scriptUrl)}`
            : `${initType}|${scriptDomain}`;
    let root = byRoot.get(rootKey);
    if (!root) {
      const label =
        attribution === "parser"
          ? "HTML Document Parser"
          : attribution === "unknown"
            ? "Unknown initiator (no source recorded)"
            : scriptUrl
              ? `${scriptDomain}${truncatePath(scriptUrl)}`
              : `${scriptDomain} (${initType})`;
      root = {
        label,
        scriptDomain,
        scriptUrl: attribution === "unknown" ? null : scriptUrl,
        line,
        initiatorType: initType,
        attribution,
        isFirstPartyScript,
        totalRequests: 0,
        trackingRequests: 0,
        shieldsMatchedRequests: 0,
        entityMap: new Map()
      };
      byRoot.set(rootKey, root);
    }

    root.totalRequests += 1;
    const isTracking = isTrackingRequest(req);
    if (isTracking) root.trackingRequests += 1;
    if (req.shields.matched) root.shieldsMatchedRequests += 1;

    const entityName = req.entity?.entity ?? req.registrableDomain;
    const parentOrg = req.entity?.parentOrg ?? "Independent / Unattributed";
    const category: ServiceCategoryV3 = req.entity?.category ?? "other";

    let ent = root.entityMap.get(entityName);
    if (!ent) {
      ent = {
        entity: entityName,
        parentOrg,
        category,
        requests: 0,
        trackingRequests: 0,
        shieldsBlocked: 0,
        domains: new Set()
      };
      root.entityMap.set(entityName, ent);
    }
    ent.requests += 1;
    if (isTracking) ent.trackingRequests += 1;
    if (req.shields.shouldBlockStandard || req.shields.blocked) ent.shieldsBlocked += 1;
    ent.domains.add(req.domain);
  }

  return [...byRoot.entries()]
    .map(([rootId, node]) => {
      const entities: CausalityEntityNodeV3[] = [...node.entityMap.values()]
        .map((e) => ({
          entity: e.entity,
          parentOrg: e.parentOrg,
          category: e.category,
          requests: e.requests,
          trackingRequests: e.trackingRequests,
          shieldsBlocked: e.shieldsBlocked,
          domains: [...e.domains].sort()
        }))
        .sort((a, b) => b.requests - a.requests || a.entity.localeCompare(b.entity));

      return {
        rootId,
        label: node.label,
        scriptDomain: node.scriptDomain,
        scriptUrl: node.scriptUrl,
        line: node.line,
        initiatorType: node.initiatorType,
        attribution: node.attribution,
        isFirstPartyScript: node.isFirstPartyScript,
        totalRequests: node.totalRequests,
        trackingRequests: node.trackingRequests,
        shieldsMatchedRequests: node.shieldsMatchedRequests,
        distinctEntities: entities.length,
        entities
      };
    })
    .sort((a, b) => b.trackingRequests - a.trackingRequests || b.totalRequests - a.totalRequests);
}

/** Build phase-by-phase waterfall counts for the on-screen Phase Timeline visual. */
export function buildPhaseTimelineV3(arm: ScanArmV3): PhaseWaterfallRowV3[] {
  const reqByPhase = new Map<ScanPhaseName, NetworkRequestV3[]>();
  for (const req of arm.network) {
    const arr = reqByPhase.get(req.phase) ?? [];
    arr.push(req);
    reqByPhase.set(req.phase, arr);
  }

  const wsByPhase = new Map<ScanPhaseName, number>();
  for (const ws of arm.websockets) {
    wsByPhase.set(ws.phase, (wsByPhase.get(ws.phase) ?? 0) + 1);
  }

  const beaconsByPhase = new Map<ScanPhaseName, number>();
  for (const b of arm.beacons) {
    for (const p of b.phases) {
      beaconsByPhase.set(p, (beaconsByPhase.get(p) ?? 0) + 1);
    }
  }

  return arm.phases.map((p) => {
    const reqs = reqByPhase.get(p.name) ?? [];
    let thirdPartyRequests = 0;
    let trackingRequests = 0;
    let shieldsBlocked = 0;
    for (const r of reqs) {
      if (r.thirdParty) thirdPartyRequests += 1;
      if (isTrackingRequest(r)) trackingRequests += 1;
      if (r.shields.shouldBlockStandard || r.shields.blocked) shieldsBlocked += 1;
    }

    return {
      phase: p.name,
      label: PHASE_LABELS[p.name] ?? p.name,
      status: p.status,
      startedAtMs: p.startedAtMs,
      endedAtMs: p.endedAtMs,
      durationMs: Math.max(0, p.endedAtMs - p.startedAtMs),
      totalRequests: reqs.length,
      thirdPartyRequests,
      trackingRequests,
      shieldsBlocked,
      beacons: beaconsByPhase.get(p.name) ?? 0,
      websockets: wsByPhase.get(p.name) ?? 0
    };
  });
}

/** Aggregate exact Brave Shields filter rules, filter lists, `$redirect`, and `$removeparam` hits. */
export function buildDeveloperRuleBreakdownV3(arm: ScanArmV3): DeveloperShieldsRuleRowV3[] {
  const byRule = new Map<
    string,
    {
      rule: string;
      list: string;
      exception: string | null;
      redirect: string | null;
      hasUrlRewrite: boolean;
      important: boolean;
      shouldBlockStandard: boolean;
      shouldBlockAggressive: boolean;
      matchedRequests: number;
      domains: Set<string>;
      initiators: Set<string>;
    }
  >();

  for (const req of arm.network) {
    if (!req.shields.matched && !req.shields.rewrittenUrl) continue;
    const rule = req.shields.rule ?? "(matched filter rule)";
    const list = req.shields.list ?? "Brave Filter Lists";
    const key = `${list}|${rule}|${req.shields.exception ?? ""}`;

    let row = byRule.get(key);
    if (!row) {
      row = {
        rule,
        list,
        exception: req.shields.exception,
        redirect: req.shields.redirect,
        hasUrlRewrite: Boolean(req.shields.rewrittenUrl),
        important: req.shields.important,
        shouldBlockStandard: req.shields.shouldBlockStandard,
        shouldBlockAggressive: req.shields.shouldBlockAggressive,
        matchedRequests: 0,
        domains: new Set(),
        initiators: new Set()
      };
      byRule.set(key, row);
    }

    row.matchedRequests += 1;
    if (req.shields.rewrittenUrl) row.hasUrlRewrite = true;
    row.domains.add(req.domain);
    const initiator =
      req.initiator?.scriptUrl ||
      req.initiator?.scriptDomain ||
      (req.initiator?.type === "parser" ? "HTML Document Parser" : "unknown initiator");
    row.initiators.add(initiator);
  }

  return [...byRule.values()]
    .map((r) => ({
      rule: r.rule,
      list: r.list,
      exception: r.exception,
      redirect: r.redirect,
      hasUrlRewrite: r.hasUrlRewrite,
      important: r.important,
      shouldBlockStandard: r.shouldBlockStandard,
      shouldBlockAggressive: r.shouldBlockAggressive,
      matchedRequests: r.matchedRequests,
      sampleDomains: [...r.domains].sort().slice(0, 6),
      initiatorScripts: [...r.initiators].sort().slice(0, 4)
    }))
    .sort((a, b) => b.matchedRequests - a.matchedRequests || a.rule.localeCompare(b.rule));
}

export type CatalogVendorEntryV3 = {
  entity: string;
  parentOrg: string;
  category: ServiceCategoryV3;
  region: EntityRegionV3;
  domains: string[];
  aliases: string[];
};

export function getCatalogDirectoryV3(): {
  stats: typeof GLOBAL_ENTITY_CATALOG_V3_STATS;
  entries: CatalogVendorEntryV3[];
  parentOrgs: { parentOrg: string; entityCount: number; regions: EntityRegionV3[] }[];
} {
  const entries: CatalogVendorEntryV3[] = GLOBAL_ENTITY_CATALOG_V3.map((e) => ({
    entity: e.entity,
    parentOrg: e.parentOrg,
    category: e.category,
    region: e.region,
    domains: [...e.suffixes],
    aliases: [...(e.aliases ?? [])]
  })).sort((a, b) => a.entity.localeCompare(b.entity));

  const parentMap = new Map<string, { count: number; regions: Set<EntityRegionV3> }>();
  for (const e of entries) {
    const cur = parentMap.get(e.parentOrg) ?? { count: 0, regions: new Set<EntityRegionV3>() };
    cur.count += 1;
    cur.regions.add(e.region);
    parentMap.set(e.parentOrg, cur);
  }

  const parentOrgs = [...parentMap.entries()]
    .map(([parentOrg, data]) => ({
      parentOrg,
      entityCount: data.count,
      regions: [...data.regions].sort()
    }))
    .sort((a, b) => b.entityCount - a.entityCount || a.parentOrg.localeCompare(b.parentOrg));

  return {
    stats: GLOBAL_ENTITY_CATALOG_V3_STATS,
    entries,
    parentOrgs
  };
}

function isTrackingRequest(req: NetworkRequestV3): boolean {
  if (req.shields.shouldBlockStandard || req.shields.shouldBlockAggressive) return true;
  const cat = req.entity?.category;
  return (
    cat === "advertising" ||
    cat === "analytics" ||
    cat === "session-replay" ||
    cat === "cdp" ||
    cat === "identity-broker" ||
    cat === "marketing-automation" ||
    cat === "server-side-tagging"
  );
}

function truncatePath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname || "/";
    return p.length > 42 ? `${p.slice(0, 39)}...` : p;
  } catch {
    return rawUrl.slice(0, 42);
  }
}

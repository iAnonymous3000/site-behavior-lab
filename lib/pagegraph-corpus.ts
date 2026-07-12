import { csvCell } from "./csv-export";
import {
  REDACTION_ALLOWLISTS_VERSION,
  REDACTION_VERSION,
  emptyRedactionCounters,
  redactCookieName,
  redactHostnameV2,
  redactStorageKey,
  redactUrlV2,
  type RedactionCounters
} from "./redaction-v2";
import { sha256Hex } from "./sha256";
import {
  extractPageGraphRootUrl,
  normalizePageGraphResourceType,
  parseGraphmlRecords,
  type GraphRecord
} from "./pagegraph-parser";

/**
 * PageGraph corpus Phase 0: normalize PageGraph GraphML into the proposal's
 * fact tables and answer the two flagship queries (see
 * docs/pagegraph-corpus-db-proposal.md).
 *
 * 1. Rule impact (downstream reachability): a filter rule reduces to node
 *    removal plus a transitive closure over the causal edges: everything
 *    REACHABLE from a blocked node. This is an upper-bound estimate, not a
 *    proven counterfactual: a reachable descendant may have another surviving
 *    parent that would still create it, and only alternate-parent analysis or
 *    an intervention recrawl can prove it would actually disappear.
 * 2. Cross-site persistent-value lookup: which scripts set which storage keys,
 *    corpus-wide (value-blind: key presence and byte counts, never values).
 *
 * Node-removal closure semantics: blocking a resource removes the script that
 * the resource delivered (the derived `script_of` relation pairs a script node
 * with the resource node sharing its URL, because PageGraph attributes
 * execution to the injector rather than the resource), and everything those
 * nodes caused structurally (execute / create node / insert node / request
 * start). Storage writes and JS calls are per-operation facts: they are
 * removed when their acting script is removed, but their target nodes (the
 * storage area, the web API) are never treated as removed themselves.
 *
 * Pure: callers inject `registrableDomain` (tldts `getDomain` in the CLI).
 * The estimate is structural, not behavioral: it bounds what could stop
 * loading, and says nothing about JS error cascades (proposal section 12).
 */

export type CorpusPageRow = {
  pageId: string;
  url: string;
  etld1: string | null;
};

export type CorpusNodeRow = {
  nodeId: string;
  pageId: string;
  nodeType: string;
  url: string | null;
  domain: string | null;
  etld1: string | null;
  thirdParty: boolean | null;
};

export type CorpusEdgeRow = {
  edgeId: string;
  pageId: string;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  edgeType: string;
  requestId: string | null;
  timestampMs: number | null;
};

export type CorpusRequestRow = {
  pageId: string;
  nodeId: string;
  requestId: string | null;
  url: string;
  domain: string | null;
  etld1: string | null;
  resourceType: string;
  status: number | null;
  thirdParty: boolean | null;
  initiatorNodeId: string | null;
};

export type CorpusProvenanceRelation = "initiated_by" | "script_of";

export type CorpusProvenanceEdgeRow = {
  pageId: string;
  childNodeId: string;
  parentNodeId: string;
  relation: CorpusProvenanceRelation;
};

export type CorpusStorageOpRow = {
  pageId: string;
  opId: string;
  scriptNodeId: string | null;
  scriptUrl: string | null;
  scriptEtld1: string | null;
  storageType: "cookie" | "localStorage" | "sessionStorage";
  key: string;
  valueBytes: number;
  thirdParty: boolean | null;
};

export type CorpusJsCallRow = {
  pageId: string;
  callId: string;
  scriptNodeId: string | null;
  api: string;
  timestampMs: number | null;
};

export type CorpusFacts = {
  page: CorpusPageRow;
  nodes: CorpusNodeRow[];
  edges: CorpusEdgeRow[];
  requests: CorpusRequestRow[];
  provenanceEdges: CorpusProvenanceEdgeRow[];
  storageOps: CorpusStorageOpRow[];
  jsCalls: CorpusJsCallRow[];
  warnings: string[];
};

export type CorpusFactsOptions = {
  pageId: string;
  /** Overrides the root URL extracted from the GraphML when provided. */
  pageUrl?: string;
  /** eTLD+1 resolver (tldts `getDomain` in the CLI); null when unresolvable. */
  registrableDomain: (host: string) => string | null;
};

export const PAGEGRAPH_EXPORT_MANIFEST_VERSION = 1;

export type PageGraphExportManifest = {
  manifestVersion: typeof PAGEGRAPH_EXPORT_MANIFEST_VERSION;
  redactionVersion: number;
  redactionAllowlistsVersion: string;
  digestAlgorithm: "sha256";
  generatedAt: string;
  pages: number;
  files: { name: string; bytes: number; sha256: string }[];
};

/** Structural causality: following these edges removes the TARGET node. */
const CAUSAL_NODE_EDGE_TYPES = new Set([
  "execute",
  "execute from attribute",
  "create node",
  "insert node",
  "node insert",
  "request start"
]);

const STORAGE_NODE_TYPES: Record<string, CorpusStorageOpRow["storageType"]> = {
  "local storage": "localStorage",
  "session storage": "sessionStorage",
  storage: "localStorage",
  "cookie jar": "cookie"
};

export function buildCorpusFacts(graphml: string, options: CorpusFactsOptions): CorpusFacts {
  const records = parseGraphmlRecords(graphml);
  const warnings: string[] = [];
  const pageUrl = options.pageUrl ?? extractPageGraphRootUrl(graphml) ?? "";
  if (!pageUrl) {
    warnings.push("No root document URL was found in the GraphML; first-party attribution is unavailable.");
  }
  const pageEtld1 = etld1OfUrl(pageUrl, options.registrableDomain);
  const page: CorpusPageRow = { pageId: options.pageId, url: pageUrl, etld1: pageEtld1 };

  const nodeRecords = records.filter((record) => record.kind === "node");
  const edgeRecords = records.filter((record) => record.kind === "edge");
  const recordsById = new Map(records.map((record) => [record.id, record]));

  const nodes: CorpusNodeRow[] = nodeRecords.map((record) => {
    const url = field(record, "url");
    const domain = url ? hostnameOf(url) : null;
    const etld1 = domain ? options.registrableDomain(domain) : null;
    return {
      nodeId: record.id,
      pageId: options.pageId,
      nodeType: field(record, "node type") ?? "unknown",
      url: url ?? null,
      domain,
      etld1,
      thirdParty: etld1 && pageEtld1 ? etld1 !== pageEtld1 : null
    };
  });

  const edges: CorpusEdgeRow[] = edgeRecords.map((record) => ({
    edgeId: record.id,
    pageId: options.pageId,
    sourceNodeId: record.source ?? null,
    targetNodeId: record.target ?? null,
    edgeType: field(record, "edge type") ?? "unknown",
    requestId: field(record, "request id") ?? null,
    timestampMs: numberField(record, "timestamp")
  }));

  // "request error" edges are completions too: dropping them loses the
  // request's recorded status. A "request complete" still wins when both
  // exist for one request id.
  const completionsByRequestId = new Map<string, GraphRecord>();
  for (const record of edgeRecords) {
    const requestId = field(record, "request id");
    if (!requestId) continue;
    const type = field(record, "edge type");
    if (type !== "request complete" && type !== "request error") continue;
    const existing = completionsByRequestId.get(requestId);
    if (!existing || type === "request complete") {
      completionsByRequestId.set(requestId, record);
    }
  }

  const requests: CorpusRequestRow[] = [];
  const seenRequests = new Set<string>();
  for (const record of edgeRecords) {
    if (field(record, "edge type") !== "request start") continue;
    const resource = record.target ? recordsById.get(record.target) : undefined;
    if (!resource || field(resource, "node type") !== "resource") continue;
    const url = field(resource, "url");
    if (!url) continue;

    const requestId = field(record, "request id") ?? null;
    const dedupeKey = `${requestId ?? record.id}|${url}`;
    if (seenRequests.has(dedupeKey)) continue;
    seenRequests.add(dedupeKey);

    const completion = requestId ? completionsByRequestId.get(requestId) : undefined;
    const domain = hostnameOf(url);
    const etld1 = domain ? options.registrableDomain(domain) : null;
    // Current captures write the type on the "request start" edge as
    // "resource type"; older captures used "request type" there or carried it
    // on the completion edge (which stays first: the completion reflects the
    // final type after redirects). Values are Blink's human-readable names,
    // folded into the Playwright vocabulary so filter-rule request types match.
    const rawResourceType =
      (completion ? field(completion, "resource type") : undefined) ??
      field(record, "resource type") ??
      field(record, "request type");
    requests.push({
      pageId: options.pageId,
      nodeId: resource.id,
      requestId,
      url,
      domain,
      etld1,
      resourceType: rawResourceType ? normalizePageGraphResourceType(rawResourceType) : "other",
      status: completion ? numberField(completion, "status") : null,
      thirdParty: etld1 && pageEtld1 ? etld1 !== pageEtld1 : null,
      initiatorNodeId: record.source ?? null
    });
  }
  if (requests.length === 0) {
    warnings.push("No network requests were extracted; rule impact over this page will always be empty.");
  }

  const provenanceEdges: CorpusProvenanceEdgeRow[] = [];
  for (const request of requests) {
    if (request.initiatorNodeId) {
      provenanceEdges.push({
        pageId: options.pageId,
        childNodeId: request.nodeId,
        parentNodeId: request.initiatorNodeId,
        relation: "initiated_by"
      });
    }
  }
  // script_of: PageGraph attributes execution to the injector, so the script
  // node delivered by a blocked resource is linked to it by URL identity.
  const resourcesByUrl = new Map<string, string>();
  for (const node of nodes) {
    if (node.nodeType === "resource" && node.url) resourcesByUrl.set(node.url, node.nodeId);
  }
  for (const node of nodes) {
    if (node.nodeType !== "script" || !node.url) continue;
    const resourceNodeId = resourcesByUrl.get(node.url);
    if (resourceNodeId && resourceNodeId !== node.nodeId) {
      provenanceEdges.push({
        pageId: options.pageId,
        childNodeId: node.nodeId,
        parentNodeId: resourceNodeId,
        relation: "script_of"
      });
    }
  }

  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const storageOps: CorpusStorageOpRow[] = [];
  for (const record of edgeRecords) {
    if (field(record, "edge type") !== "storage set") continue;
    const target = record.target ? recordsById.get(record.target) : undefined;
    const storageType = target ? STORAGE_NODE_TYPES[field(target, "node type") ?? ""] : undefined;
    const key = field(record, "key");
    if (!storageType || !key) continue;
    const script = record.source ? nodesById.get(record.source) : undefined;
    storageOps.push({
      pageId: options.pageId,
      opId: record.id,
      scriptNodeId: script?.nodeId ?? null,
      scriptUrl: script?.url ?? null,
      scriptEtld1: script?.etld1 ?? null,
      storageType,
      key,
      // Value-blind by design: byte count only, the value itself is discarded.
      valueBytes: new TextEncoder().encode(field(record, "value") ?? "").length,
      thirdParty: script?.etld1 && pageEtld1 ? script.etld1 !== pageEtld1 : null
    });
  }

  const jsCalls: CorpusJsCallRow[] = [];
  for (const record of edgeRecords) {
    if (field(record, "edge type") !== "js call") continue;
    const target = record.target ? recordsById.get(record.target) : undefined;
    const targetType = target ? field(target, "node type") : undefined;
    if (targetType !== "web API" && targetType !== "JS builtin") continue;
    const api = target ? field(target, "method") : undefined;
    if (!api) continue;
    jsCalls.push({
      pageId: options.pageId,
      callId: record.id,
      scriptNodeId: record.source ?? null,
      api,
      timestampMs: numberField(record, "timestamp")
    });
  }

  return { page, nodes, edges, requests, provenanceEdges, storageOps, jsCalls, warnings };
}

export type CorpusRuleMatcher = (request: CorpusRequestRow, page: CorpusPageRow) => boolean;

export type PageRuleImpact = {
  pageId: string;
  url: string;
  directlyBlocked: { nodeId: string; url: string }[];
  downstreamRequests: { nodeId: string; url: string }[];
  removedNodeCount: number;
  removedStorageOps: number;
  removedJsCalls: number;
  /** URLs of removed first-party nodes: the structural breakage signal. */
  firstPartyRemovedUrls: string[];
  breakageRisk: boolean;
};

export type RuleImpactReport = {
  pages: PageRuleImpact[];
  summary: {
    pagesAnalyzed: number;
    pagesAffected: number;
    directlyBlocked: number;
    downstreamRequests: number;
    removedStorageOps: number;
    removedJsCalls: number;
    breakageRiskPages: number;
    topRemovedEtld1s: { etld1: string; pages: number }[];
  };
};

/**
 * The flagship reachability estimate: mark rule-matched request nodes as
 * blocked, close over the causal edges, and report the reachable subgraph per
 * page and corpus-wide. Reachability is an upper bound on removal: a
 * descendant with another surviving parent may still load, so "downstream"
 * here means "could depend on the blocked node", never "proven to disappear".
 */
export function simulateRuleImpact(corpus: CorpusFacts[], matches: CorpusRuleMatcher): RuleImpactReport {
  const pages: PageRuleImpact[] = [];
  const removedEtld1Pages = new Map<string, number>();

  for (const facts of corpus) {
    const seeds = facts.requests.filter((request) => matches(request, facts.page));
    const seedNodeIds = new Set(seeds.map((request) => request.nodeId));
    const removed = closeOverCausalEdges(facts, seedNodeIds);

    const downstreamRequests = facts.requests.filter(
      (request) => removed.has(request.nodeId) && !seedNodeIds.has(request.nodeId)
    );
    const removedStorageOps = facts.storageOps.filter(
      (op) => op.scriptNodeId !== null && removed.has(op.scriptNodeId)
    );
    const removedJsCalls = facts.jsCalls.filter(
      (call) => call.scriptNodeId !== null && removed.has(call.scriptNodeId)
    );
    const firstPartyRemovedUrls = [
      ...new Set(
        facts.nodes
          .filter(
            (node) =>
              removed.has(node.nodeId) && node.url !== null && node.etld1 !== null && node.etld1 === facts.page.etld1
          )
          .map((node) => node.url as string)
      )
    ];

    const pageEtld1s = new Set(
      facts.nodes
        .filter((node) => removed.has(node.nodeId) && node.etld1 !== null)
        .map((node) => node.etld1 as string)
    );
    for (const etld1 of pageEtld1s) {
      removedEtld1Pages.set(etld1, (removedEtld1Pages.get(etld1) ?? 0) + 1);
    }

    pages.push({
      pageId: facts.page.pageId,
      url: facts.page.url,
      directlyBlocked: seeds.map((request) => ({ nodeId: request.nodeId, url: request.url })),
      downstreamRequests: downstreamRequests.map((request) => ({ nodeId: request.nodeId, url: request.url })),
      removedNodeCount: removed.size,
      removedStorageOps: removedStorageOps.length,
      removedJsCalls: removedJsCalls.length,
      firstPartyRemovedUrls,
      breakageRisk: firstPartyRemovedUrls.length > 0
    });
  }

  const affected = pages.filter((page) => page.directlyBlocked.length > 0 || page.downstreamRequests.length > 0);
  return {
    pages,
    summary: {
      pagesAnalyzed: pages.length,
      pagesAffected: affected.length,
      directlyBlocked: sum(pages, (page) => page.directlyBlocked.length),
      downstreamRequests: sum(pages, (page) => page.downstreamRequests.length),
      removedStorageOps: sum(pages, (page) => page.removedStorageOps),
      removedJsCalls: sum(pages, (page) => page.removedJsCalls),
      breakageRiskPages: pages.filter((page) => page.breakageRisk).length,
      topRemovedEtld1s: [...removedEtld1Pages.entries()]
        .map(([etld1, pageCount]) => ({ etld1, pages: pageCount }))
        .sort((a, b) => b.pages - a.pages || a.etld1.localeCompare(b.etld1))
        .slice(0, 20)
    }
  };
}

function closeOverCausalEdges(facts: CorpusFacts, seeds: Set<string>): Set<string> {
  const children = new Map<string, string[]>();
  const link = (parent: string, child: string) => {
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  };
  for (const edge of facts.edges) {
    if (edge.sourceNodeId && edge.targetNodeId && CAUSAL_NODE_EDGE_TYPES.has(edge.edgeType)) {
      link(edge.sourceNodeId, edge.targetNodeId);
    }
  }
  for (const provenance of facts.provenanceEdges) {
    if (provenance.relation === "script_of") {
      link(provenance.parentNodeId, provenance.childNodeId);
    }
  }

  const removed = new Set(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const child of children.get(current) ?? []) {
      if (!removed.has(child)) {
        removed.add(child);
        pending.push(child);
      }
    }
  }
  return removed;
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function field(record: GraphRecord, name: string): string | undefined {
  const value = record.fields[name];
  return value === undefined || value === "" ? undefined : value;
}

function numberField(record: GraphRecord, name: string): number | null {
  const raw = field(record, name);
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function etld1OfUrl(url: string, registrableDomain: (host: string) => string | null): string | null {
  const host = url ? hostnameOf(url) : null;
  return host ? registrableDomain(host) : null;
}

const INVALID_OPAQUE_ID = "{invalid-id}";

class CorpusExportRedactionPass {
  readonly counters = emptyRedactionCounters();

  constructor(private readonly opaqueAliases: ReadonlyMap<string, string>) {}

  url(value: string, preserveQueryKeys: boolean): string {
    const redacted = redactUrlV2(value, { preserveQueryKeys });
    this.add(redacted.counters);
    return redacted.value;
  }

  hostname(value: string | null): string | null {
    if (value === null) return null;
    const redacted = redactHostnameV2(value);
    this.add(redacted.counters);
    return redacted.value;
  }

  storageKey(value: string, storageType: CorpusStorageOpRow["storageType"]): string {
    return storageType === "cookie"
      ? redactCookieName(value, this.counters).value
      : redactStorageKey(value, this.counters).value;
  }

  opaqueId(value: string | null): string | null {
    if (value === null) return null;
    return this.opaqueAliases.get(value) ?? INVALID_OPAQUE_ID;
  }

  private add(source: RedactionCounters): void {
    for (const key of Object.keys(this.counters) as (keyof RedactionCounters)[]) {
      this.counters[key] += source[key];
    }
  }
}

/**
 * Public PageGraph fact projection. Matching and causal closure always consume
 * the raw `CorpusFacts`; only this terminal export copy is minimized. Page ids
 * are ordinal capabilities rather than source filenames, and every URL/domain
 * and storage key follows the same redaction-v2 policy as ScanReport.
 */
export function redactCorpusFactsForExport(corpus: CorpusFacts[]): CorpusFacts[] {
  return corpus.map((facts, pageIndex) => {
    const pass = new CorpusExportRedactionPass(buildOpaqueIdAliases(facts));
    const pageId = opaquePageId(pageIndex);
    return {
      page: {
        pageId,
        url: pass.url(facts.page.url, false),
        etld1: pass.hostname(facts.page.etld1)
      },
      nodes: facts.nodes.map((node) => ({
        nodeId: pass.opaqueId(node.nodeId) as string,
        pageId,
        nodeType: node.nodeType,
        url: node.url === null ? null : pass.url(node.url, true),
        domain: pass.hostname(node.domain),
        etld1: pass.hostname(node.etld1),
        thirdParty: node.thirdParty
      })),
      edges: facts.edges.map((edge) => ({
        edgeId: pass.opaqueId(edge.edgeId) as string,
        pageId,
        sourceNodeId: pass.opaqueId(edge.sourceNodeId),
        targetNodeId: pass.opaqueId(edge.targetNodeId),
        edgeType: edge.edgeType,
        requestId: pass.opaqueId(edge.requestId),
        timestampMs: edge.timestampMs
      })),
      requests: facts.requests.map((request) => ({
        pageId,
        nodeId: pass.opaqueId(request.nodeId) as string,
        requestId: pass.opaqueId(request.requestId),
        url: pass.url(request.url, true),
        domain: pass.hostname(request.domain),
        etld1: pass.hostname(request.etld1),
        resourceType: request.resourceType,
        status: request.status,
        thirdParty: request.thirdParty,
        initiatorNodeId: pass.opaqueId(request.initiatorNodeId)
      })),
      provenanceEdges: facts.provenanceEdges.map((edge) => ({
        pageId,
        childNodeId: pass.opaqueId(edge.childNodeId) as string,
        parentNodeId: pass.opaqueId(edge.parentNodeId) as string,
        relation: edge.relation
      })),
      storageOps: facts.storageOps.map((op) => ({
        pageId,
        opId: pass.opaqueId(op.opId) as string,
        scriptNodeId: pass.opaqueId(op.scriptNodeId),
        scriptUrl: op.scriptUrl === null ? null : pass.url(op.scriptUrl, true),
        scriptEtld1: pass.hostname(op.scriptEtld1),
        storageType: op.storageType,
        key: pass.storageKey(op.key, op.storageType),
        valueBytes: op.valueBytes,
        thirdParty: op.thirdParty
      })),
      jsCalls: facts.jsCalls.map((call) => ({
        pageId,
        callId: pass.opaqueId(call.callId) as string,
        scriptNodeId: pass.opaqueId(call.scriptNodeId),
        api: call.api,
        timestampMs: call.timestampMs
      })),
      warnings: [...facts.warnings]
    };
  });
}

/** Sanitize the raw-match rule-impact report immediately before JSON output. */
export function redactRuleImpactReportForExport(
  report: RuleImpactReport,
  rawCorpus: CorpusFacts[]
): RuleImpactReport {
  const pages = report.pages.map((page, pageIndex) => {
    const facts = rawCorpus.find((candidate) => candidate.page.pageId === page.pageId) ?? rawCorpus[pageIndex];
    const pass = new CorpusExportRedactionPass(facts ? buildOpaqueIdAliases(facts) : new Map());
    return {
      pageId: opaquePageId(pageIndex),
      url: pass.url(page.url, false),
      directlyBlocked: page.directlyBlocked.map((entry) => ({
        nodeId: pass.opaqueId(entry.nodeId) as string,
        url: pass.url(entry.url, true)
      })),
      downstreamRequests: page.downstreamRequests.map((entry) => ({
        nodeId: pass.opaqueId(entry.nodeId) as string,
        url: pass.url(entry.url, true)
      })),
      removedNodeCount: page.removedNodeCount,
      removedStorageOps: page.removedStorageOps,
      removedJsCalls: page.removedJsCalls,
      firstPartyRemovedUrls: page.firstPartyRemovedUrls.map((url) => pass.url(url, true)),
      breakageRisk: page.breakageRisk
    };
  });
  return {
    pages,
    summary: {
      ...report.summary,
      topRemovedEtld1s: report.summary.topRemovedEtld1s.map((entry) => ({
        etld1: redactHostnameV2(entry.etld1).value,
        pages: entry.pages
      }))
    }
  };
}

/** Digest manifest for the exact bytes written by the PageGraph exporter. */
export function buildPageGraphExportManifest(input: {
  files: Record<string, string>;
  generatedAt: string;
  pages: number;
}): PageGraphExportManifest {
  const parsed = Date.parse(input.generatedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input.generatedAt) {
    throw new Error("PageGraph export generatedAt must be a canonical timestamp.");
  }
  return {
    manifestVersion: PAGEGRAPH_EXPORT_MANIFEST_VERSION,
    redactionVersion: REDACTION_VERSION,
    redactionAllowlistsVersion: REDACTION_ALLOWLISTS_VERSION,
    digestAlgorithm: "sha256",
    generatedAt: input.generatedAt,
    pages: input.pages,
    files: Object.entries(input.files)
      .map(([name, contents]) => ({
        name,
        bytes: new TextEncoder().encode(contents).length,
        sha256: sha256Hex(contents)
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

function opaquePageId(index: number): string {
  return `page-${String(index + 1).padStart(6, "0")}`;
}

/**
 * Alias every producer id, including innocuous-looking short strings: lexical
 * shape cannot prove an id is not a name. Sorting the complete per-page id
 * universe makes aliases deterministic and lets independently projected CSV
 * and impact artifacts preserve their joins exactly.
 */
function buildOpaqueIdAliases(facts: CorpusFacts): Map<string, string> {
  const ids = new Set<string>();
  const add = (value: string | null): void => {
    if (value !== null) ids.add(value);
  };
  for (const node of facts.nodes) add(node.nodeId);
  for (const edge of facts.edges) {
    add(edge.edgeId);
    add(edge.sourceNodeId);
    add(edge.targetNodeId);
    add(edge.requestId);
  }
  for (const request of facts.requests) {
    add(request.nodeId);
    add(request.requestId);
    add(request.initiatorNodeId);
  }
  for (const edge of facts.provenanceEdges) {
    add(edge.childNodeId);
    add(edge.parentNodeId);
  }
  for (const op of facts.storageOps) {
    add(op.opId);
    add(op.scriptNodeId);
  }
  for (const call of facts.jsCalls) {
    add(call.callId);
    add(call.scriptNodeId);
  }
  return new Map(
    Array.from(ids)
      // Code-unit order is locale-independent, so aliases do not drift with
      // runner ICU/default-locale configuration.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((id, index) => [id, `id-${String(index + 1).padStart(6, "0")}`])
  );
}

/** CSV fact tables, one file per table (DuckDB `COPY ... FROM` targets). */
export function corpusFactsToCsvTables(corpus: CorpusFacts[]): Record<string, string> {
  const publicCorpus = redactCorpusFactsForExport(corpus);
  return {
    "page.csv": toCsv(
      ["page_id", "url", "etld1"],
      publicCorpus.map((facts) => [facts.page.pageId, facts.page.url, facts.page.etld1 ?? ""])
    ),
    "node.csv": toCsv(
      ["node_id", "page_id", "node_type", "url", "domain", "etld1", "third_party"],
      publicCorpus.flatMap((facts) =>
        facts.nodes.map((node) => [
          node.nodeId,
          node.pageId,
          node.nodeType,
          node.url ?? "",
          node.domain ?? "",
          node.etld1 ?? "",
          triState(node.thirdParty)
        ])
      )
    ),
    "edge.csv": toCsv(
      ["edge_id", "page_id", "source_node_id", "target_node_id", "edge_type", "request_id", "timestamp_ms"],
      publicCorpus.flatMap((facts) =>
        facts.edges.map((edge) => [
          edge.edgeId,
          edge.pageId,
          edge.sourceNodeId ?? "",
          edge.targetNodeId ?? "",
          edge.edgeType,
          edge.requestId ?? "",
          edge.timestampMs ?? ""
        ])
      )
    ),
    "request.csv": toCsv(
      [
        "page_id",
        "node_id",
        "request_id",
        "url",
        "domain",
        "etld1",
        "resource_type",
        "status",
        "third_party",
        "initiator_node_id"
      ],
      publicCorpus.flatMap((facts) =>
        facts.requests.map((request) => [
          request.pageId,
          request.nodeId,
          request.requestId ?? "",
          request.url,
          request.domain ?? "",
          request.etld1 ?? "",
          request.resourceType,
          request.status ?? "",
          triState(request.thirdParty),
          request.initiatorNodeId ?? ""
        ])
      )
    ),
    "provenance_edge.csv": toCsv(
      ["page_id", "child_node_id", "parent_node_id", "relation"],
      publicCorpus.flatMap((facts) =>
        facts.provenanceEdges.map((edge) => [edge.pageId, edge.childNodeId, edge.parentNodeId, edge.relation])
      )
    ),
    "storage_op.csv": toCsv(
      [
        "page_id",
        "op_id",
        "script_node_id",
        "script_url",
        "script_etld1",
        "storage_type",
        "key",
        "value_bytes",
        "third_party"
      ],
      publicCorpus.flatMap((facts) =>
        facts.storageOps.map((op) => [
          op.pageId,
          op.opId,
          op.scriptNodeId ?? "",
          op.scriptUrl ?? "",
          op.scriptEtld1 ?? "",
          op.storageType,
          op.key,
          op.valueBytes,
          triState(op.thirdParty)
        ])
      )
    ),
    "js_call.csv": toCsv(
      ["page_id", "call_id", "script_node_id", "api", "timestamp_ms"],
      publicCorpus.flatMap((facts) =>
        facts.jsCalls.map((call) => [call.pageId, call.callId, call.scriptNodeId ?? "", call.api, call.timestampMs ?? ""])
      )
    )
  };
}

function triState(value: boolean | null): string {
  return value === null ? "" : value ? "true" : "false";
}

function toCsv(header: readonly string[], rows: (string | number)[][]): string {
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")
    .concat("\r\n");
}

/**
 * DuckDB bootstrap: schema + COPY from the CSV tables (run from the output
 * directory) + the closure view the rule-impact query walks.
 */
export const DUCKDB_BOOTSTRAP_SQL = `-- PageGraph corpus Phase 0 bootstrap. Run from the export directory:
--   duckdb corpus.duckdb < bootstrap.sql
CREATE OR REPLACE TABLE page (page_id TEXT, url TEXT, etld1 TEXT);
CREATE OR REPLACE TABLE node (node_id TEXT, page_id TEXT, node_type TEXT, url TEXT, domain TEXT, etld1 TEXT, third_party BOOLEAN);
CREATE OR REPLACE TABLE edge (edge_id TEXT, page_id TEXT, source_node_id TEXT, target_node_id TEXT, edge_type TEXT, request_id TEXT, timestamp_ms DOUBLE);
CREATE OR REPLACE TABLE request (page_id TEXT, node_id TEXT, request_id TEXT, url TEXT, domain TEXT, etld1 TEXT, resource_type TEXT, status INTEGER, third_party BOOLEAN, initiator_node_id TEXT);
CREATE OR REPLACE TABLE provenance_edge (page_id TEXT, child_node_id TEXT, parent_node_id TEXT, relation TEXT);
CREATE OR REPLACE TABLE storage_op (page_id TEXT, op_id TEXT, script_node_id TEXT, script_url TEXT, script_etld1 TEXT, storage_type TEXT, key TEXT, value_bytes INTEGER, third_party BOOLEAN);
CREATE OR REPLACE TABLE js_call (page_id TEXT, call_id TEXT, script_node_id TEXT, api TEXT, timestamp_ms DOUBLE);
CREATE OR REPLACE TABLE directly_blocked (page_id TEXT, node_id TEXT);

COPY page FROM 'page.csv' (FORMAT csv, HEADER);
COPY node FROM 'node.csv' (FORMAT csv, HEADER);
COPY edge FROM 'edge.csv' (FORMAT csv, HEADER);
COPY request FROM 'request.csv' (FORMAT csv, HEADER);
COPY provenance_edge FROM 'provenance_edge.csv' (FORMAT csv, HEADER);
COPY storage_op FROM 'storage_op.csv' (FORMAT csv, HEADER);
COPY js_call FROM 'js_call.csv' (FORMAT csv, HEADER);
COPY directly_blocked FROM 'directly_blocked.csv' (FORMAT csv, HEADER);

-- One edge list for the removal closure: structural causal edges (following
-- them removes the target) plus the derived script_of relation (a blocked
-- resource removes the script it delivered).
CREATE OR REPLACE VIEW closure_edge AS
SELECT page_id, source_node_id AS parent_node_id, target_node_id AS child_node_id
FROM edge
WHERE edge_type IN ('execute', 'execute from attribute', 'create node', 'insert node', 'node insert', 'request start')
UNION ALL
SELECT page_id, parent_node_id, child_node_id
FROM provenance_edge
WHERE relation = 'script_of';
`;

/** Flagship query 1: rule impact as a recursive closure over `closure_edge`. */
export const RULE_IMPACT_SQL = `-- Rule impact: seed with directly_blocked, close over causal edges, report
-- the removed subgraph per page (proposal section 8.1).
WITH RECURSIVE removed (page_id, node_id) AS (
  SELECT page_id, node_id FROM directly_blocked
  UNION
  SELECT ce.page_id, ce.child_node_id
  FROM closure_edge ce
  JOIN removed r ON ce.page_id = r.page_id AND ce.parent_node_id = r.node_id
)
SELECT
  p.page_id,
  p.url AS page_url,
  count(DISTINCT db.node_id) AS directly_blocked,
  count(DISTINCT CASE WHEN db2.node_id IS NULL THEN req.node_id END) AS downstream_requests,
  count(DISTINCT so.op_id) AS removed_storage_ops,
  count(DISTINCT jc.call_id) AS removed_js_calls,
  count(DISTINCT CASE WHEN n.etld1 = p.etld1 AND n.url IS NOT NULL THEN n.node_id END) AS first_party_removed,
  count(DISTINCT CASE WHEN n.etld1 = p.etld1 AND n.url IS NOT NULL THEN n.node_id END) > 0 AS breakage_risk
FROM page p
LEFT JOIN removed r ON r.page_id = p.page_id
LEFT JOIN directly_blocked db ON db.page_id = p.page_id AND db.node_id = r.node_id
LEFT JOIN request req ON req.page_id = p.page_id AND req.node_id = r.node_id
LEFT JOIN directly_blocked db2 ON db2.page_id = req.page_id AND db2.node_id = req.node_id
LEFT JOIN storage_op so ON so.page_id = p.page_id AND so.script_node_id = r.node_id
LEFT JOIN js_call jc ON jc.page_id = p.page_id AND jc.script_node_id = r.node_id
LEFT JOIN node n ON n.page_id = p.page_id AND n.node_id = r.node_id
GROUP BY p.page_id, p.url
ORDER BY directly_blocked DESC, downstream_requests DESC, p.page_id;
`;

/** Flagship query 2: cross-site persistent values, value-blind (section 8.2). */
export const CROSS_SITE_STORAGE_SQL = `-- Which persistent values does each script origin set, corpus-wide?
-- Filter with e.g. WHERE script_etld1 = 'example.net' for one vendor.
SELECT
  s.script_etld1,
  s.storage_type,
  s.key,
  count(DISTINCT s.page_id) AS pages_setting,
  count(*) AS writes,
  avg(s.value_bytes) AS avg_value_bytes
FROM storage_op s
GROUP BY 1, 2, 3
ORDER BY pages_setting DESC, writes DESC, s.key;
`;

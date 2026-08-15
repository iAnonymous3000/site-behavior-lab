import {
  claimCountValue,
  retainedCountLabel,
  type EvidenceState
} from "./report-facts";
import { displayHost } from "./text-format";
import type { RunView } from "./scan-report-views";
import type { NetworkRequestRecord } from "./types";

/** Which recorded provenance field named the actor, so no surface has to guess. */
export type AttributionActorRole = "script" | "initiator" | "injector" | "mixed";

export type AttributionMapEdge = {
  source: string;
  dest: string;
  requests: number;
  tracker: boolean;
  role: AttributionActorRole;
};

export type AttributionMapSource = {
  domain: string;
  role: AttributionActorRole;
  destinations: number;
};

export type AttributionMapDestination = {
  label: string;
  requests: number;
  tracker: boolean;
};

export type AttributionCoverage = {
  evidenceState: Exclude<EvidenceState, "unsupported">;
  attributedRequests: number;
  thirdPartyRequests: number;
  /** Uses claimCountValue so censored zeroes are never dressed up as useful floors. */
  attributedValue: number | string;
  /** Uses the canonical retained-count formatter; the renderer never spells its own floor. */
  thirdPartyValue: string;
  /** A censored numerator and denominator cannot support a visit-level ratio. */
  percentage: number | null;
  lowerBound: boolean;
  summary: string;
};

export type RequestAttributionMapModel = {
  instrumented: boolean;
  coverage: AttributionCoverage;
  edges: AttributionMapEdge[];
  totalEdges: number;
  sources: AttributionMapSource[];
  destinations: AttributionMapDestination[];
};

export type RequestAttributionMapInput = {
  requests: readonly NetworkRequestRecord[];
  totalRequests: number;
  thirdPartyRequests: number;
  automation: RunView["conditions"]["automation"];
  evidenceState: EvidenceState;
};

/** Drawing every edge of a busy capture makes the map unreadable; the tail is disclosed. */
export const MAX_DRAWN_ATTRIBUTION_EDGES = 12;

/**
 * The domain a capture attributes a request to, plus the field that named it.
 * The order matches requestProvenanceSummary in report-findings.ts, so the map
 * and request log resolve the same actor from the same record.
 */
export function requestAttributionActor(
  request: NetworkRequestRecord
): { domain: string; role: Exclude<AttributionActorRole, "mixed"> } | null {
  const provenance = request.provenance;
  if (!provenance) return null;
  if (provenance.scriptDomain) return { domain: provenance.scriptDomain, role: "script" };
  if (provenance.initiatorDomain) return { domain: provenance.initiatorDomain, role: "initiator" };
  if (provenance.injectedByDomain) return { domain: provenance.injectedByDomain, role: "injector" };
  return null;
}

function assertReconciledCounts(input: RequestAttributionMapInput): void {
  if (!Number.isSafeInteger(input.totalRequests) || input.totalRequests < 0) {
    throw new Error("request attribution map totalRequests must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.thirdPartyRequests) || input.thirdPartyRequests < 0) {
    throw new Error("request attribution map thirdPartyRequests must be a non-negative safe integer");
  }
  if (input.requests.length !== input.totalRequests) {
    throw new Error(
      `request attribution map request rows do not reconcile: ${input.requests.length} rows != ${input.totalRequests} total requests`
    );
  }
  const thirdPartyRows = input.requests.filter((request) => request.thirdParty).length;
  if (thirdPartyRows !== input.thirdPartyRequests) {
    throw new Error(
      `request attribution map third-party rows do not reconcile: ${thirdPartyRows} rows != ${input.thirdPartyRequests} third-party requests`
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported request evidence state: ${String(value)}`);
}

function coverageFor(
  state: Exclude<EvidenceState, "unsupported">,
  attributedRequests: number,
  thirdPartyRequests: number
): AttributionCoverage {
  switch (state) {
    case "complete": {
      const attributedValue = claimCountValue(attributedRequests, {
        exactCountAllowed: true,
        lowerBound: false
      });
      const thirdPartyValue = retainedCountLabel(thirdPartyRequests, state);
      const percentage =
        thirdPartyRequests === 0
          ? null
          : Math.round((attributedRequests / thirdPartyRequests) * 100);
      const summary =
        thirdPartyRequests === 0
          ? "No third-party requests were recorded, so attribution coverage is not applicable."
          : `${String(attributedValue)} of ${thirdPartyValue} third-party requests had a single recorded actor${
              percentage === null ? "." : ` (${percentage}%).`
            }`;
      return {
        evidenceState: state,
        attributedRequests,
        thirdPartyRequests,
        attributedValue,
        thirdPartyValue,
        percentage,
        lowerBound: false,
        summary
      };
    }
    case "censored": {
      const attributedValue = claimCountValue(attributedRequests, {
        exactCountAllowed: false,
        lowerBound: true
      });
      const thirdPartyValue = retainedCountLabel(thirdPartyRequests, state);
      const attributedClause =
        attributedValue === "Incomplete"
          ? "The retained rows establish no useful floor for requests with one recorded actor."
          : `${String(attributedValue)} of ${thirdPartyValue} retained third-party requests had a single recorded actor.`;
      return {
        evidenceState: state,
        attributedRequests,
        thirdPartyRequests,
        attributedValue,
        thirdPartyValue,
        percentage: null,
        lowerBound: true,
        summary: `${attributedClause} Request evidence was cut short, so counts are lower bounds and no coverage percentage is claimed.`
      };
    }
    default:
      return assertNever(state);
  }
}

/**
 * Pure request-attribution model used by the renderer and corpus gate.
 *
 * `evidenceState` must come from ReportFacts. This function deliberately does
 * not infer completeness from warnings, counts, or provenance density. An
 * unsupported request family yields no model at all: an empty graph would look
 * like an observed absence even though the producer recorded no request family.
 */
export function buildRequestAttributionMap(
  input: RequestAttributionMapInput
): RequestAttributionMapModel | null {
  switch (input.evidenceState) {
    case "unsupported":
      return null;
    case "complete":
    case "censored":
      break;
    default:
      return assertNever(input.evidenceState);
  }

  assertReconciledCounts(input);

  const byPair = new Map<string, AttributionMapEdge>();
  let attributedRequests = 0;
  for (const request of input.requests) {
    if (!request.thirdParty) continue;
    const actor = requestAttributionActor(request);
    if (!actor) continue;
    attributedRequests += 1;

    const source = displayHost(actor.domain);
    const dest = request.tracker?.entity || displayHost(request.domain);
    const key = `${source}\u001f${dest}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.requests += 1;
      existing.tracker ||= Boolean(request.tracker);
      if (existing.role !== actor.role) existing.role = "mixed";
      continue;
    }
    byPair.set(key, {
      source,
      dest,
      requests: 1,
      tracker: Boolean(request.tracker),
      role: actor.role
    });
  }

  const allEdges = Array.from(byPair.values()).sort(
    (a, b) =>
      b.requests - a.requests ||
      a.source.localeCompare(b.source) ||
      a.dest.localeCompare(b.dest)
  );
  const edges = allEdges.slice(0, MAX_DRAWN_ATTRIBUTION_EDGES);

  // Node detail counts describe only the drawn subgraph. The omitted tail is
  // carried separately so the UI cannot present these as full-map totals.
  const sourceOrder: string[] = [];
  const sourceReach = new Map<string, number>();
  const sourceRole = new Map<string, AttributionActorRole>();
  const destinationOrder: string[] = [];
  const destinationTotals = new Map<string, number>();
  const destinationTracker = new Map<string, boolean>();
  for (const edge of edges) {
    if (!sourceReach.has(edge.source)) sourceOrder.push(edge.source);
    sourceReach.set(edge.source, (sourceReach.get(edge.source) ?? 0) + 1);
    const role = sourceRole.get(edge.source);
    sourceRole.set(edge.source, role === undefined || role === edge.role ? edge.role : "mixed");

    if (!destinationTotals.has(edge.dest)) destinationOrder.push(edge.dest);
    destinationTotals.set(edge.dest, (destinationTotals.get(edge.dest) ?? 0) + edge.requests);
    destinationTracker.set(
      edge.dest,
      (destinationTracker.get(edge.dest) ?? false) || edge.tracker
    );
  }

  const sources = sourceOrder.map((domain) => ({
    domain,
    role: sourceRole.get(domain) ?? "mixed",
    destinations: sourceReach.get(domain) ?? 0
  }));
  const destinations = destinationOrder.map((label) => ({
    label,
    requests: destinationTotals.get(label) ?? 0,
    tracker: destinationTracker.get(label) ?? false
  }));

  return {
    instrumented: input.automation === "brave-pagegraph",
    coverage: coverageFor(
      input.evidenceState,
      attributedRequests,
      input.thirdPartyRequests
    ),
    edges,
    totalEdges: allEdges.length,
    sources,
    destinations
  };
}

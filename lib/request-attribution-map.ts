import {
  claimCountValue,
  retainedCountLabel,
  retainedCountPhrase,
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
  /**
   * Compact retained count ("22", or ">=22" on a censored capture).
   *
   * Formatted HERE rather than at the renderer, for the reason the coverage
   * fields above already give: a surface that spells its own count states an
   * exact quantity from a capture that only supports a floor. The map drew
   * these edges with raw counts while the coverage block three elements above
   * printed floors from the same run.
   */
  requestsLabel: string;
  /** Prose form of the same quantity, so a spoken or printed surface and the
   * drawn one cannot disagree. */
  requestsPhrase: string;
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
  /** Sums the DRAWN edges only; see the note where these are built. */
  requests: number;
  /** Compact retained count, formatted in the model. */
  requestsLabel: string;
  /** Prose form of the same quantity. */
  requestsPhrase: string;
  tracker: boolean;
};

export type AttributionCoverage = {
  evidenceState: Exclude<EvidenceState, "unsupported">;
  attributedRequests: number;
  /**
   * Third-party rows this capture could not assign to ONE actor. Two causes
   * produce it and the wire cannot tell them apart: Chromium reported no
   * usable initiator, and the same URL was seen with conflicting initiators so
   * the join could not say which row belonged to which.
   * `RequestInitiatorStats` counts those separately during collection but is
   * not persisted, so no breakdown may be published from a report.
   */
  notAttributableRequests: number;
  thirdPartyRequests: number;
  /** Uses claimCountValue so censored zeroes are never dressed up as useful floors. */
  attributedValue: number | string;
  /** Uses the canonical retained-count formatter; the renderer never spells its own floor. */
  thirdPartyValue: string;
  /** Uses claimCountValue so a censored zero does not become the meaningless floor “≥0”. */
  notAttributableValue: number | string;
  lowerBound: boolean;
  summary: string;
};

/**
 * The map declined to draw because the run's retained rows and its own recorded
 * totals disagree. Kept as a value so the reader is told the section was
 * withheld and why, rather than being shown a silently absent section.
 */
export type UnreconciledAttributionMap = {
  kind: "unreconciled";
  reason: string;
};

export type RequestAttributionMapModel = {
  kind: "map";
  instrumented: boolean;
  coverage: AttributionCoverage;
  edges: AttributionMapEdge[];
  totalEdges: number;
  sources: AttributionMapSource[];
  destinations: AttributionMapDestination[];
  /**
   * Raw retained host to the destination NODE it was drawn under.
   *
   * Published so a second surface can decide membership by calling
   * `requestMatchesAttributionPair` instead of re-deriving the rule. The
   * mapping is one-to-many by design: several hosts of one company share a
   * node, and a committed run draws `apps.smartadserver.com` and
   * `{label}.smartadserver.com` as one "Equativ". Matching a node by its label
   * alone would miss the second host, and matching by `tracker.entity` alone
   * would miss the rows that carried no catalog match.
   */
  destinationByHost: ReadonlyMap<string, string>;
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

/**
 * Why this returns a reason instead of throwing.
 *
 * `counts.totalRequests` and `evidence.requests` are two independently recorded
 * wire fields. One producer writes both today, and the corpus gate below proves
 * every committed run reconciles -- but a legacy v1 report, a remediated
 * report, or a producer yet to exist could disagree, and this model runs inside
 * a client component with no error boundary anywhere in the report render path.
 * Throwing would replace a whole readable report with a blank page over one
 * section it could not draw. 162373c settled the same question the same way:
 * a dropped row must not fail the run around it.
 *
 * Refusing to draw is the honest outcome either way. A map built from rows that
 * do not match the report's own totals would publish a denominator the rest of
 * the page contradicts.
 */
function reconciliationFailure(input: RequestAttributionMapInput): string | null {
  if (!Number.isSafeInteger(input.totalRequests) || input.totalRequests < 0) {
    return "the recorded total request count is not a whole number";
  }
  if (!Number.isSafeInteger(input.thirdPartyRequests) || input.thirdPartyRequests < 0) {
    return "the recorded third-party request count is not a whole number";
  }
  if (input.requests.length !== input.totalRequests) {
    return `${input.requests.length} retained request rows do not match the recorded total of ${input.totalRequests}`;
  }
  const thirdPartyRows = input.requests.filter((request) => request.thirdParty).length;
  if (thirdPartyRows !== input.thirdPartyRequests) {
    return `${thirdPartyRows} retained third-party rows do not match the recorded total of ${input.thirdPartyRequests}`;
  }
  return null;
}

function assertNever(value: never): never {
  throw new Error(`unsupported request evidence state: ${String(value)}`);
}

function coverageFor(
  state: Exclude<EvidenceState, "unsupported">,
  attributedRequests: number,
  notAttributableRequests: number,
  thirdPartyRequests: number
): AttributionCoverage {
  switch (state) {
    case "complete": {
      const attributedValue = claimCountValue(attributedRequests, {
        exactCountAllowed: true,
        lowerBound: false
      });
      const thirdPartyValue = retainedCountLabel(thirdPartyRequests, state);
      const notAttributableValue = claimCountValue(notAttributableRequests, {
        exactCountAllowed: true,
        lowerBound: false
      });
      const summary =
        thirdPartyRequests === 0
          ? "No third-party requests were recorded, so attribution coverage is not applicable."
          : `${thirdPartyValue} third-party requests: ${String(attributedValue)} attributed to a single recorded actor, ${notAttributableValue} not attributable.`;
      return {
        evidenceState: state,
        attributedRequests,
        notAttributableRequests,
        thirdPartyRequests,
        attributedValue,
        thirdPartyValue,
        notAttributableValue,
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
      const notAttributableValue = claimCountValue(notAttributableRequests, {
        exactCountAllowed: false,
        lowerBound: true
      });
      const attributedClause =
        attributedValue === "Incomplete"
          ? "The retained rows establish no useful floor for requests with one recorded actor."
          : `${thirdPartyValue} retained third-party requests: ${String(attributedValue)} attributed to a single recorded actor, ${notAttributableValue} not attributable.`;
      return {
        evidenceState: state,
        attributedRequests,
        notAttributableRequests,
        thirdPartyRequests,
        attributedValue,
        thirdPartyValue,
        notAttributableValue,
        lowerBound: true,
        summary: `${attributedClause} Request capture was incomplete, so every count is a lower bound and no coverage percentage is reported.`
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
): RequestAttributionMapModel | UnreconciledAttributionMap | null {
  switch (input.evidenceState) {
    case "unsupported":
      return null;
    case "complete":
    case "censored":
      break;
    default:
      return assertNever(input.evidenceState);
  }

  const unreconciled = reconciliationFailure(input);
  if (unreconciled) return { kind: "unreconciled", reason: unreconciled };

  /**
   * Resolve each host's catalog identity ONCE for the whole run, before any
   * edge is keyed.
   *
   * A catalog match is recorded per REQUEST, so one host can carry matched and
   * unmatched rows in the same visit. Keying each row on `entity || host`
   * therefore split that host across two nodes: one committed report draws
   * `{label}.google.com` as "Google" (1 request) beside "*.google.com" (8).
   * Across the committed corpus that changed the drawn destination count in 56
   * of 126 runs.
   *
   * Resolving per host keeps company grouping (several Meta hosts stay one
   * "Meta" node, which is what the map is for) while making the destination
   * namespace consistent within a run. A row that carried no match is not
   * evidence that its host is uncatalogued.
   *
   * Totals reconcile either way, so the corpus gate cannot catch this: only the
   * destination count and the drawn picture are affected.
   */
  const entitiesByHost = new Map<string, Set<string>>();
  for (const request of input.requests) {
    if (!request.thirdParty) continue;
    const entity = request.tracker?.entity;
    if (!entity) continue;
    const entities = entitiesByHost.get(request.domain) ?? new Set<string>();
    entities.add(entity);
    entitiesByHost.set(request.domain, entities);
  }
  const destinationByHost = new Map<string, string>();
  for (const request of input.requests) {
    if (!request.thirdParty || destinationByHost.has(request.domain)) continue;
    const entities = entitiesByHost.get(request.domain);
    // A public redaction can collapse raw subdomains. If that ever leaves two
    // entity names on one public host, choosing the first or last would make
    // the map depend on request order. The host is the only honest common
    // identity in that case.
    destinationByHost.set(
      request.domain,
      entities?.size === 1 ? [...entities][0] : displayHost(request.domain)
    );
  }

  // Accumulated without the formatted counts: the label and phrase are derived
  // once, after aggregation and capping, so a partially summed edge can never
  // carry a count string that its final `requests` contradicts.
  type AccumulatedEdge = Omit<AttributionMapEdge, "requestsLabel" | "requestsPhrase">;
  const byPair = new Map<string, AccumulatedEdge>();
  let attributedRequests = 0;
  let notAttributableRequests = 0;
  for (const request of input.requests) {
    if (!request.thirdParty) continue;
    const actor = requestAttributionActor(request);
    if (!actor) {
      // Counted, never dropped. These rows are the difference between "no
      // third party did this" and "we could not say which one did", and a map
      // that silently omits them reads as the first.
      notAttributableRequests += 1;
      continue;
    }
    attributedRequests += 1;

    const source = displayHost(actor.domain);
    const dest = destinationByHost.get(request.domain) ?? displayHost(request.domain);
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

  const countLabel = (value: number) =>
    retainedCountLabel(value, input.evidenceState);
  const countPhrase = (value: number) =>
    retainedCountPhrase(value, "request", "requests", input.evidenceState);

  const allEdges = Array.from(byPair.values()).sort(
    (a, b) =>
      b.requests - a.requests ||
      a.source.localeCompare(b.source) ||
      a.dest.localeCompare(b.dest)
  );
  const edges = allEdges.slice(0, MAX_DRAWN_ATTRIBUTION_EDGES).map((edge) => ({
    ...edge,
    requestsLabel: countLabel(edge.requests),
    requestsPhrase: countPhrase(edge.requests)
  }));

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
  const destinations = destinationOrder.map((label) => {
    const requests = destinationTotals.get(label) ?? 0;
    return {
      label,
      requests,
      requestsLabel: countLabel(requests),
      requestsPhrase: countPhrase(requests),
      tracker: destinationTracker.get(label) ?? false
    };
  });

  return {
    kind: "map",
    instrumented: input.automation === "brave-pagegraph",
    coverage: coverageFor(
      input.evidenceState,
      attributedRequests,
      notAttributableRequests,
      input.thirdPartyRequests
    ),
    edges,
    totalEdges: allEdges.length,
    sources,
    destinations,
    destinationByHost
  };
}

/**
 * Is this retained row one of the rows an edge was drawn from?
 *
 * THE ONE MEMBERSHIP RULE. A drill-down from a drawn edge to the request log
 * has to select exactly the rows that edge was summed from, or the map states a
 * quantity the log then contradicts. The log's existing text search cannot do
 * it: that filter ORs one needle across eight fields including the provenance
 * text, so a needle naming a destination also matches every row INITIATED by
 * that host. On a committed AP News report the edge `apnews.com` to
 * `*.primis.tech` sums 22 rows, while a destination text search returns 41 and
 * an actor text search returns 257.
 *
 * Nor can an edge be named by one endpoint. The same report draws
 * `www.dianomi.com` as both a source node and a destination node, including a
 * self-loop, so "rows involving www.dianomi.com" is undecidable between three
 * drawn edges. Membership is the ordered pair or it is nothing.
 *
 * Mirrors the accumulation loop above skip for skip: not third-party, or no
 * single recorded actor, and the row was never summed into any edge.
 */
export function requestMatchesAttributionPair(
  request: NetworkRequestRecord,
  pair: { actor: string; destination: string },
  destinationByHost: ReadonlyMap<string, string>
): boolean {
  if (!request.thirdParty) return false;
  const actor = requestAttributionActor(request);
  if (!actor) return false;
  if (displayHost(actor.domain) !== pair.actor) return false;
  const destination =
    destinationByHost.get(request.domain) ?? displayHost(request.domain);
  return destination === pair.destination;
}

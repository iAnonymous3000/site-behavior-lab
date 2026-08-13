"use client";

import { useId, useMemo } from "react";
import { plural } from "@/lib/text-format";
import type { NetworkRequestRecord } from "@/lib/types";

/** Which recorded provenance field named the actor, so no surface has to guess. */
type ProvenanceActorRole = "script" | "initiator" | "injector" | "mixed";
type CausalEdge = {
  source: string;
  dest: string;
  requests: number;
  tracker: boolean;
  role: ProvenanceActorRole;
};
type CausalEdgeSet = { edges: CausalEdge[]; totalEdges: number };

/** Drawing every edge of a busy capture makes the map unreadable; the tail is disclosed. */
const MAX_DRAWN_EDGES = 12;

/**
 * The domain a capture attributes a request to, plus the field that named it. The
 * order matches requestProvenanceSummary in lib/report-findings.ts, so the map and
 * the request log resolve the same actor from the same record.
 */
function provenanceActor(
  request: NetworkRequestRecord
): { domain: string; role: Exclude<ProvenanceActorRole, "mixed"> } | null {
  const provenance = request.provenance;
  if (!provenance) return null;
  if (provenance.scriptDomain) return { domain: provenance.scriptDomain, role: "script" };
  if (provenance.initiatorDomain) return { domain: provenance.initiatorDomain, role: "initiator" };
  if (provenance.injectedByDomain) return { domain: provenance.injectedByDomain, role: "injector" };
  return null;
}

/** The phrase the request log already prints for that field, so both surfaces read alike. */
function actorPhrase(role: ProvenanceActorRole): string {
  if (role === "script") return "script";
  if (role === "initiator") return "initiated by";
  if (role === "injector") return "injected by";
  return "attributed to";
}

/** The same fields in the label form the node detail line needs. */
function actorRoleLabel(role: ProvenanceActorRole): string {
  if (role === "script") return "recorded script";
  if (role === "initiator") return "recorded initiator";
  if (role === "injector") return "recorded injector";
  return "recorded actor";
}

function buildCausalEdges(requests: NetworkRequestRecord[]): CausalEdgeSet {
  const map = new Map<string, CausalEdge>();

  for (const request of requests) {
    if (!request.thirdParty) continue;
    const actor = provenanceActor(request);
    if (!actor) continue;
    const source = actor.domain;

    const dest = request.tracker?.entity || request.domain;
    // The role stays out of the edge key on purpose: one domain can be the recorded
    // script of one request and only the injector of another, and two nodes with the
    // same label would collide in the layout and in the React keys. A role that is not
    // constant across the merged requests degrades to "mixed" rather than claiming a
    // role the record does not support for all of them.
    const key = `${source}\u001f${dest}`;
    const existing = map.get(key);
    if (existing) {
      existing.requests += 1;
      if (existing.role !== actor.role) existing.role = "mixed";
      continue;
    }
    map.set(key, { source, dest, requests: 1, tracker: Boolean(request.tracker), role: actor.role });
  }

  const all = Array.from(map.values()).sort(
    (a, b) => b.requests - a.requests || a.source.localeCompare(b.source)
  );
  // The node labels count only what is drawn, so the total has to travel with the
  // slice: without it a busy capture rendered per-node counts that looked like
  // totals while edges past the twelfth were dropped with no note anywhere.
  return { edges: all.slice(0, MAX_DRAWN_EDGES), totalEdges: all.length };
}

function orderedUnique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function truncateMiddle(value: string, max = 30): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

function CausalityGraph({ requests }: { requests: NetworkRequestRecord[] }) {
  const { edges, totalEdges } = useMemo(() => buildCausalEdges(requests), [requests]);
  const headingId = useId();
  const scrollDescriptionId = useId();
  if (edges.length === 0) return null;

  const sources = orderedUnique(edges.map((edge) => edge.source));
  const dests = orderedUnique(edges.map((edge) => edge.dest));
  const sourceReach = new Map<string, number>();
  const sourceRole = new Map<string, ProvenanceActorRole>();
  const destTotals = new Map<string, number>();
  for (const edge of edges) {
    sourceReach.set(edge.source, (sourceReach.get(edge.source) ?? 0) + 1);
    const seenRole = sourceRole.get(edge.source);
    sourceRole.set(edge.source, seenRole === undefined || seenRole === edge.role ? edge.role : "mixed");
    destTotals.set(edge.dest, (destTotals.get(edge.dest) ?? 0) + edge.requests);
  }

  const colW = 250;
  const gap = 150;
  const nodeH = 44;
  const rowH = 58;
  const padY = 18;
  const width = colW * 2 + gap;
  const rows = Math.max(sources.length, dests.length);
  const height = padY * 2 + rows * rowH - (rowH - nodeH);
  const rightX = colW + gap;
  const maxReq = Math.max(...edges.map((edge) => edge.requests));

  const columnY = (count: number, index: number) => {
    const columnHeight = count * rowH - (rowH - nodeH);
    const offset = (height - columnHeight) / 2;
    return offset + index * rowH + nodeH / 2;
  };
  const sourceIndex = new Map(sources.map((source, index) => [source, index]));
  const destIndex = new Map(dests.map((dest, index) => [dest, index]));

  return (
    <section className="data-section causal-graph-card" id="causal-map">
      <div className="section-heading">
        <h2 id={headingId}>Causal map</h2>
        <span className="muted">
          Which recorded actor each third-party request is attributed to, from PageGraph provenance.
        </span>
      </div>
      <p className="visually-hidden" id={scrollDescriptionId}>
        Horizontally scrollable visual map. A text list of every relationship drawn in it follows.
      </p>
      <div
        className="causal-graph-scroll"
        role="region"
        aria-labelledby={headingId}
        aria-describedby={scrollDescriptionId}
        tabIndex={0}
      >
        <svg
          className="causal-graph"
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
          {edges.map((edge) => {
            const y1 = columnY(sources.length, sourceIndex.get(edge.source) ?? 0);
            const y2 = columnY(dests.length, destIndex.get(edge.dest) ?? 0);
            const x1 = colW;
            const x2 = rightX;
            const mx = (x1 + x2) / 2;
            const strokeWidth = 1.5 + (edge.requests / maxReq) * 5;
            return (
              <path
                key={`${edge.source}->${edge.dest}`}
                className={`causal-edge${edge.tracker ? " causal-edge-tracker" : ""}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                strokeWidth={strokeWidth}
                fill="none"
              >
                <title>{`${edge.source} to ${edge.dest}: ${plural(edge.requests, "request")}`}</title>
              </path>
            );
          })}
          {sources.map((source, index) => {
            const y = columnY(sources.length, index) - nodeH / 2;
            const reach = sourceReach.get(source) ?? 0;
            return (
              <g key={`s-${source}`} className="causal-node causal-node-source">
                <title>{source}</title>
                <rect x={0} y={y} width={colW} height={nodeH} rx={8} />
                <text x={12} y={y + 18} className="causal-node-label">
                  {truncateMiddle(source)}
                </text>
                <text x={12} y={y + 34} className="causal-node-detail">
                  {actorRoleLabel(sourceRole.get(source) ?? "mixed")} · {plural(reach, "destination")}
                </text>
              </g>
            );
          })}
          {dests.map((dest, index) => {
            const y = columnY(dests.length, index) - nodeH / 2;
            const total = destTotals.get(dest) ?? 0;
            const isTracker = edges.some((edge) => edge.dest === dest && edge.tracker);
            return (
              <g key={`d-${dest}`} className={`causal-node causal-node-dest${isTracker ? " causal-node-tracker" : ""}`}>
                <title>{dest}</title>
                <rect x={rightX} y={y} width={colW} height={nodeH} rx={8} />
                <text x={rightX + 12} y={y + 18} className="causal-node-label">
                  {truncateMiddle(dest)}
                </text>
                <text x={rightX + 12} y={y + 34} className="causal-node-detail">
                  {plural(total, "request")}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {totalEdges > edges.length && (
        <p className="muted row-more">
          Showing the {edges.length} highest-volume causal paths of {plural(totalEdges, "recorded path")}.
          The per-domain counts above cover only the paths drawn here; open the report JSON for the full set.
        </p>
      )}
      <h3 className="visually-hidden print-text-equivalent">Relationships shown in the causal map</h3>
      <ol className="visually-hidden print-text-equivalent">
        {edges.map((edge) => (
          <li key={`${edge.source}->${edge.dest}-text`}>
            {plural(edge.requests, "request")} to {edge.dest}
            {edge.tracker ? ", a catalogued service" : ""}, recorded as {actorPhrase(edge.role)} {edge.source}.
          </li>
        ))}
      </ol>
    </section>
  );
}

export { CausalityGraph };

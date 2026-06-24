"use client";

import { useMemo } from "react";
import { plural } from "@/lib/text-format";
import type { NetworkRequestRecord, ScanResult } from "@/lib/types";

type CausalEdge = { source: string; dest: string; requests: number; tracker: boolean };

function buildCausalEdges(requests: NetworkRequestRecord[]): CausalEdge[] {
  const map = new Map<string, CausalEdge>();

  for (const request of requests) {
    if (!request.thirdParty || !request.provenance) continue;
    const provenance = request.provenance;
    const source = provenance.scriptDomain || provenance.initiatorDomain || provenance.injectedByDomain;
    if (!source) continue;

    const dest = request.tracker?.entity || request.domain;
    const key = `${source}\u001f${dest}`;
    const existing = map.get(key);
    if (existing) {
      existing.requests += 1;
      continue;
    }
    map.set(key, { source, dest, requests: 1, tracker: Boolean(request.tracker) });
  }

  return Array.from(map.values())
    .sort((a, b) => b.requests - a.requests || a.source.localeCompare(b.source))
    .slice(0, 12);
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

function CausalityGraph({ result }: { result: ScanResult }) {
  const edges = useMemo(() => buildCausalEdges(result.requests), [result.requests]);
  if (edges.length === 0) return null;

  const sources = orderedUnique(edges.map((edge) => edge.source));
  const dests = orderedUnique(edges.map((edge) => edge.dest));
  const sourceReach = new Map<string, number>();
  const destTotals = new Map<string, number>();
  for (const edge of edges) {
    sourceReach.set(edge.source, (sourceReach.get(edge.source) ?? 0) + 1);
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
    <section className="data-section causal-graph-card">
      <div className="section-heading">
        <h2>Causal map</h2>
        <span className="muted">Which script caused which third-party request, from PageGraph provenance.</span>
      </div>
      <div className="causal-graph-scroll">
        <svg
          className="causal-graph"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Causal map of ${sources.length} scripts contacting ${dests.length} third-party destinations.`}
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
              />
            );
          })}
          {sources.map((source, index) => {
            const y = columnY(sources.length, index) - nodeH / 2;
            const reach = sourceReach.get(source) ?? 0;
            return (
              <g key={`s-${source}`} className="causal-node causal-node-source">
                <rect x={0} y={y} width={colW} height={nodeH} rx={8} />
                <text x={12} y={y + 18} className="causal-node-label">
                  {truncateMiddle(source)}
                </text>
                <text x={12} y={y + 34} className="causal-node-detail">
                  script → {plural(reach, "destination")}
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
    </section>
  );
}

export { CausalityGraph };

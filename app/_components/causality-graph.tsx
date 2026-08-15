"use client";

import { useId, useMemo } from "react";
import {
  buildRequestAttributionMap,
  type AttributionActorRole
} from "@/lib/request-attribution-map";
import type { EvidenceState } from "@/lib/report-facts";
import type { RunView } from "@/lib/scan-report-views";
import { plural } from "@/lib/text-format";

/** The phrase the request log already prints for that field, so both surfaces read alike. */
function actorPhrase(role: AttributionActorRole): string {
  if (role === "script") return "script";
  if (role === "initiator") return "initiated by";
  if (role === "injector") return "injected by";
  return "attributed to";
}

/** The same fields in the label form the node detail line needs. */
function actorRoleLabel(role: AttributionActorRole): string {
  if (role === "script") return "recorded script";
  if (role === "initiator") return "recorded initiator";
  if (role === "injector") return "recorded injector";
  return "recorded actor";
}

function truncateMiddle(value: string, max = 30): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
}

function CausalityGraph({
  run,
  requestEvidenceState
}: {
  run: RunView;
  /** Canonical family state from buildRunFacts; never inferred in this component. */
  requestEvidenceState: EvidenceState;
}) {
  const model = useMemo(
    () =>
      buildRequestAttributionMap({
        requests: run.evidence.requests,
        totalRequests: run.counts.totalRequests,
        thirdPartyRequests: run.counts.thirdPartyRequests,
        automation: run.conditions.automation,
        evidenceState: requestEvidenceState
      }),
    [requestEvidenceState, run]
  );
  const headingId = useId();
  const scrollDescriptionId = useId();
  if (!model) return null;

  const { coverage, destinations, edges, instrumented, sources, totalEdges } = model;

  const colW = 250;
  const gap = 150;
  const nodeH = 44;
  const rowH = 58;
  const padY = 18;
  const width = colW * 2 + gap;
  const rows = Math.max(sources.length, destinations.length);
  const height = padY * 2 + rows * rowH - (rowH - nodeH);
  const rightX = colW + gap;
  const maxReq = Math.max(1, ...edges.map((edge) => edge.requests));

  const columnY = (count: number, index: number) => {
    const columnHeight = count * rowH - (rowH - nodeH);
    const offset = (height - columnHeight) / 2;
    return offset + index * rowH + nodeH / 2;
  };
  const sourceIndex = new Map(sources.map((source, index) => [source.domain, index]));
  const destIndex = new Map(destinations.map((dest, index) => [dest.label, index]));

  return (
    <section className="data-section causal-graph-card" id="causal-map">
      <div className="section-heading">
        <h2 id={headingId}>Request attribution map</h2>
        <span className="muted">
          {instrumented
            ? "Which recorded actor each third-party request is attributed to, from the supplied PageGraph provenance. Asterisks mark subdomain labels hidden for privacy."
            : "Which actor each third-party request is attributed to, from the initiator the browser reported. Attribution, not causation: an initiator may itself have been told what to fetch, and requests with no reported initiator are not distinguished from ones fetched from several. Asterisks mark subdomain labels hidden for privacy."}
        </span>
      </div>
      <dl className="attribution-coverage" aria-label="Request attribution coverage">
        <div>
          <dt>Attributed requests</dt>
          <dd>{coverage.attributedValue}</dd>
        </div>
        <div>
          <dt>Third-party requests</dt>
          <dd>{coverage.thirdPartyValue}</dd>
        </div>
        {coverage.percentage !== null && (
          <div>
            <dt>Coverage</dt>
            <dd>{coverage.percentage}%</dd>
          </div>
        )}
      </dl>
      <p className={`attribution-coverage-note${coverage.lowerBound ? " is-lower-bound" : ""}`}>
        {coverage.summary}
      </p>
      {edges.length > 0 ? (
        <>
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
                const y2 = columnY(destinations.length, destIndex.get(edge.dest) ?? 0);
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
                return (
                  <g key={`s-${source.domain}`} className="causal-node causal-node-source">
                    <title>{source.domain}</title>
                    <rect x={0} y={y} width={colW} height={nodeH} rx={8} />
                    <text x={12} y={y + 18} className="causal-node-label">
                      {truncateMiddle(source.domain)}
                    </text>
                    <text x={12} y={y + 34} className="causal-node-detail">
                      {actorRoleLabel(source.role)} · {plural(source.destinations, "destination")}
                    </text>
                  </g>
                );
              })}
              {destinations.map((dest, index) => {
                const y = columnY(destinations.length, index) - nodeH / 2;
                return (
                  <g key={`d-${dest.label}`} className={`causal-node causal-node-dest${dest.tracker ? " causal-node-tracker" : ""}`}>
                    <title>{dest.label}</title>
                    <rect x={rightX} y={y} width={colW} height={nodeH} rx={8} />
                    <text x={rightX + 12} y={y + 18} className="causal-node-label">
                      {truncateMiddle(dest.label)}
                    </text>
                    <text x={rightX + 12} y={y + 34} className="causal-node-detail">
                      {plural(dest.requests, "request")}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </>
      ) : (
        <p className="attribution-map-empty">
          No retained third-party request has one recorded actor to draw. This is not evidence that no actor was involved: the visit may have reported no actor or several actors for the same request.
        </p>
      )}
      {totalEdges > edges.length && (
        <p className="muted row-more">
          Showing the {edges.length} highest-volume attribution paths of {plural(totalEdges, "recorded path")}.
          The per-domain counts above cover only the paths drawn here; open the report JSON for the full set.
        </p>
      )}
      {edges.length > 0 && (
        <>
          <h3 className="visually-hidden print-text-equivalent">Relationships shown in the request attribution map</h3>
          <ol className="visually-hidden print-text-equivalent">
            {edges.map((edge) => (
              <li key={`${edge.source}->${edge.dest}-text`}>
                {plural(edge.requests, "request")} to {edge.dest}
                {edge.tracker ? ", a catalogued service" : ""}, recorded as {actorPhrase(edge.role)} {edge.source}.
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export { CausalityGraph };

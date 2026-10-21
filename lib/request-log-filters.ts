/**
 * The request log's row predicates, React-free, so the table that filters with
 * them and anything that promises a filtered view of the log read ONE contract.
 *
 * A findings card's "Look closer" view (lib/finding-look-closer.ts) opens the
 * request log at a signal chip or a free-text filter, and it is offered only
 * when that filter leaves at least one retained row on the visit it opens. The
 * card decides that on the server and in the explorer alike, so it has to ask
 * the same question the table answers (app/_components/report-tables.tsx). A
 * second copy of either predicate would let a card promise rows the table then
 * does not show.
 */

import type { EvidenceRequestSignal } from "./report-evidence-navigation";
import { displayHost, displayPublicUrl, hostMatchesQuery } from "./text-format";
import type { NetworkRequestRecord } from "./types";

/** The causal chain a request row can show: its script, initiator or injecting actor. */
export function requestProvenanceSummary(request: NetworkRequestRecord): { primary: string; secondary?: string } | null {
  const provenance = request.provenance;
  if (!provenance) return null;

  const script = provenanceActorDisplay(provenance.scriptDomain, provenance.scriptUrl, "script");
  const initiator = provenanceActorDisplay(provenance.initiatorDomain, provenance.initiatorUrl, provenance.initiatorType);
  const injectedBy = provenanceActorDisplay(provenance.injectedByDomain, provenance.injectedByUrl);

  if (script) {
    return {
      primary: `script ${script}`,
      secondary: injectedBy ? `injected by ${injectedBy}` : initiator && initiator !== script ? `initiated by ${initiator}` : undefined
    };
  }
  if (initiator) return { primary: `initiated by ${initiator}`, secondary: injectedBy ? `injected by ${injectedBy}` : undefined };
  if (injectedBy) return { primary: `injected by ${injectedBy}` };
  return null;
}

export function requestProvenanceSearchText(request: NetworkRequestRecord): string {
  const summary = requestProvenanceSummary(request);
  return summary ? `${summary.primary} ${summary.secondary ?? ""}` : "";
}

function provenanceActorDisplay(domain: string | undefined, url: string | undefined, type?: string): string | null {
  const actor = domain ? displayHost(domain) : url ? displayPublicUrl(url) : undefined;
  if (!actor) return null;
  const normalizedType = type?.trim().toLowerCase();
  if (!normalizedType || normalizedType === "script" || normalizedType === "unknown") return actor;
  return `${normalizedType} ${actor}`;
}

/** Whether a row passes one of the request log's signal chips. */
export function requestMatchesSignalFilter(request: NetworkRequestRecord, filter: EvidenceRequestSignal): boolean {
  if (filter === "third-party") return request.thirdParty;
  if (filter === "known-service") return Boolean(request.tracker);
  if (filter === "shields-blocked") return request.blockedByShields === true;
  if (filter === "fingerprinting") return (request.tracker?.fingerprinting ?? 0) > 0;
  // Match what the row can actually show, not merely that a provenance object
  // exists. The adapter deliberately retains id-only provenance (graph join
  // keys with no url or domain), so Boolean(request.provenance) matched rows
  // the table then rendered with no causal chain at all, while the report was
  // simultaneously warning that no provenance was supplied. The summary is the
  // same predicate the row itself uses.
  if (filter === "provenance") return requestProvenanceSummary(request) !== null;
  return true;
}

/**
 * Whether a row passes the request log's free-text filter: one needle ORed
 * across eight row fields, so it over-matches by design. An empty needle
 * passes every row.
 */
export function requestMatchesQuery(request: NetworkRequestRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    hostMatchesQuery(request.domain, q) ||
    request.url.toLowerCase().includes(q) ||
    displayPublicUrl(request.url).toLowerCase().includes(q) ||
    request.method.toLowerCase().includes(q) ||
    request.resourceType.toLowerCase().includes(q) ||
    requestProvenanceSearchText(request).toLowerCase().includes(q) ||
    request.tracker?.entity.toLowerCase().includes(q) === true ||
    request.tracker?.category.toLowerCase().includes(q) === true
  );
}

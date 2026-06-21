import { getDomain } from "tldts";
import type { DomainSummary, NetworkRequestRecord } from "./types";

const TLD_OPTIONS = { allowPrivateDomains: true };

export function partyKey(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  return getDomain(normalized, TLD_OPTIONS) ?? normalized;
}

export function isThirdParty(firstPartyHostname: string, candidateHostname: string): boolean {
  return partyKey(firstPartyHostname) !== partyKey(candidateHostname);
}

export function summarizeDomains(requests: NetworkRequestRecord[]): DomainSummary[] {
  const summaries = new Map<string, DomainSummary>();

  for (const request of requests) {
    const existing = summaries.get(request.domain);
    if (!existing) {
      summaries.set(request.domain, {
        domain: request.domain,
        requests: 1,
        thirdParty: request.thirdParty,
        tracker: request.tracker,
        blockedByShields: request.blockedByShields ?? false,
        statuses: request.status ? [request.status] : [],
        resourceTypes: [request.resourceType]
      });
      continue;
    }

    existing.requests += 1;
    existing.thirdParty = existing.thirdParty || request.thirdParty;
    existing.tracker = existing.tracker ?? request.tracker;
    existing.blockedByShields = (existing.blockedByShields ?? false) || (request.blockedByShields ?? false);

    if (request.status && !existing.statuses.includes(request.status)) {
      existing.statuses.push(request.status);
    }
    if (!existing.resourceTypes.includes(request.resourceType)) {
      existing.resourceTypes.push(request.resourceType);
    }
  }

  return Array.from(summaries.values()).sort((a, b) => {
    if (a.thirdParty !== b.thirdParty) return Number(b.thirdParty) - Number(a.thirdParty);
    if (Boolean(a.tracker) !== Boolean(b.tracker)) return Number(Boolean(b.tracker)) - Number(Boolean(a.tracker));
    return b.requests - a.requests;
  });
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

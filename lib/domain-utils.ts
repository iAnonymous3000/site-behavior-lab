import { getDomain } from "tldts";

export { summarizeDomains } from "./domain-summaries";

const TLD_OPTIONS = { allowPrivateDomains: true };

export function partyKey(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  return getDomain(normalized, TLD_OPTIONS) ?? normalized;
}

export function isThirdParty(firstPartyHostname: string, candidateHostname: string): boolean {
  return partyKey(firstPartyHostname) !== partyKey(candidateHostname);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

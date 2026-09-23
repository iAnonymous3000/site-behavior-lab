import { getDomain } from "tldts";

export { summarizeDomains } from "./domain-summaries";

const TLD_OPTIONS = { allowPrivateDomains: true };

/**
 * The registrable domain `partyKey` keys on (PSL private section included), or
 * null when the host has none: IP literals, single-label hosts such as
 * localhost, and hosts that are themselves a public suffix. Unlike
 * `publicRegistrableDomain` in lib/redaction-v2.ts, an unknown suffix still
 * resolves here.
 */
export function partyRegistrableDomain(hostname: string): string | null {
  return getDomain(normalizeHostname(hostname), TLD_OPTIONS);
}

export function partyKey(hostname: string): string {
  return partyRegistrableDomain(hostname) ?? normalizeHostname(hostname);
}

export function isThirdParty(firstPartyHostname: string, candidateHostname: string): boolean {
  return partyKey(firstPartyHostname) !== partyKey(candidateHostname);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

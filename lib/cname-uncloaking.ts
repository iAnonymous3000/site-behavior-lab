import type { NetworkRequestRecord, TrackerMatch } from "./types";

/**
 * CNAME-cloaking un-hiding.
 *
 * A growing tracker-evasion trick: the page contacts a *first-party-looking*
 * subdomain (`metrics.example.com`) that is a DNS CNAME alias for a third-party
 * tracker (`example.eulerian.net`). Request-URL matching alone (this scanner's
 * default, and Blacklight's) sees only the first-party name and misses it.
 *
 * This module is the pure decision layer: given the first-party subdomains the
 * page contacted and their resolved CNAME chains, it decides which ones are
 * actually cloaked trackers — reusing the existing tracker catalog / Brave
 * ad-block engine as the "is this a tracking service" oracle, so it needs no new
 * curated list and does not flag plain CDN/infra CNAMEs (those aren't trackers).
 *
 * The scanner injects DNS resolution + the registrable-domain and tracker
 * matchers; this file stays free of Node/DNS APIs so it is unit-testable and
 * neutral across runtimes (see `runtime-boundaries.test.ts`).
 */

export type CnameCloak = {
  /** The first-party-looking hostname the page contacted. */
  host: string;
  /** The off-organization hostname it actually resolves to (the cloaking vendor). */
  cname: string;
  /** The tracking service the cloaked target matched. */
  tracker: TrackerMatch;
};

export type CnameCloakDeps = {
  /** Registrable (eTLD+1) domain for a hostname, e.g. tldts `getDomain`. */
  registrableDomain: (host: string) => string;
  /** Tracker lookup for a resolved CNAME target (catalog and/or ad-block engine). */
  matchTracker: (host: string) => TrackerMatch | null;
};

/**
 * First-party-looking hostnames worth a CNAME lookup: same registrable domain as
 * the scanned site but a distinct subdomain. The apex itself cannot be cloaked
 * to a tracker without breaking the site, so it is skipped. Deduplicated and
 * lower-cased; the caller bounds how many it actually resolves.
 */
export function cnameCloakCandidates(
  requests: NetworkRequestRecord[],
  firstPartyDomain: string,
  deps: Pick<CnameCloakDeps, "registrableDomain">
): string[] {
  const firstPartyRegistrable = deps.registrableDomain(firstPartyDomain);
  const seen = new Set<string>();

  for (const request of requests) {
    if (request.thirdParty) continue;
    const host = normalizeHost(request.domain);
    if (!host || host === firstPartyRegistrable) continue;
    if (deps.registrableDomain(host) !== firstPartyRegistrable) continue;
    seen.add(host);
  }

  return [...seen];
}

/**
 * Classify a first-party subdomain's resolved CNAME chain as a cloaked tracker,
 * or `null`. Walks the chain from the host outward and flags the first link that
 * (a) lands on a different organization than the first party and (b) the matcher
 * recognizes as a tracking service. A CNAME to a non-tracker CDN returns `null`.
 */
export function classifyCnameCloak(
  host: string,
  cnameChain: string[],
  firstPartyDomain: string,
  deps: CnameCloakDeps
): CnameCloak | null {
  const firstPartyRegistrable = deps.registrableDomain(firstPartyDomain);

  for (const link of cnameChain) {
    const target = normalizeHost(link);
    if (!target || deps.registrableDomain(target) === firstPartyRegistrable) continue;
    const tracker = deps.matchTracker(target);
    if (tracker) return { host: normalizeHost(host), cname: target, tracker };
  }

  return null;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Parallelized DNS CNAME-cloaking uncloaker for Site Behavior Lab v3.
 *
 * Resolves up to 24 distinct first-party subdomains concurrently (bounded pool)
 * instead of serially, follows CNAME chains up to 8 hops with loop protection,
 * and attributes cloaked targets using BOTH the expanded global entity catalog
 * and Brave Shields filter rules.
 */

import dns from "node:dns/promises";
import { attributeDomainV3 } from "../entity-catalog";
import type { CnameCloakV3, NetworkRequestV3 } from "../schema";

export type CnameChainResultV3 = {
  chain: string[];
  terminated: boolean;
};

export type CnameResolverFnV3 = (hostname: string) => Promise<CnameChainResultV3>;

export type CnameProbeOptionsV3 = {
  maxHosts?: number;
  concurrency?: number;
  maxHops?: number;
  timeoutMs?: number;
  registrableDomain: (hostname: string) => string;
  shieldsMatchHost?: (targetHost: string, requestedHost: string) => boolean;
  resolveCnameChain?: CnameResolverFnV3;
};

export type CnameProbeOutcomeV3 = {
  cloaks: CnameCloakV3[];
  /** Map from first-party cloaked subdomain -> resolved third-party target domain. */
  cloakTargetByHost: Map<string, string>;
  omittedCandidateCount: number;
  failedLookups: number;
};

const DEFAULT_MAX_HOSTS = 24;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MAX_HOPS = 8;
const DEFAULT_TIMEOUT_MS = 2_500;

/** Default `node:dns/promises` CNAME chain follower with hop & timeout bounds. */
export async function defaultResolveCnameChainV3(
  hostname: string,
  options?: { maxHops?: number; timeoutMs?: number }
): Promise<CnameChainResultV3> {
  const maxHops = options?.maxHops ?? DEFAULT_MAX_HOPS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chain: string[] = [];
  const visited = new Set<string>([normalizeHost(hostname)]);
  let current = normalizeHost(hostname);

  for (let hop = 0; hop < maxHops; hop++) {
    let records: string[];
    try {
      records = await withTimeout(dns.resolveCname(current), timeoutMs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") {
        return { chain, terminated: true };
      }
      throw error;
    }
    const next = records[0] ? normalizeHost(records[0]) : "";
    if (!next) return { chain, terminated: true };
    if (visited.has(next)) return { chain, terminated: false };
    visited.add(next);
    chain.push(next);
    current = next;
  }

  return { chain, terminated: false };
}

/**
 * Identify and concurrently resolve first-party subdomains contacted during a
 * visit to uncover CNAME-cloaked third-party trackers.
 */
export async function runCnameProbeV3(
  requests: readonly NetworkRequestV3[],
  firstPartyHost: string,
  options: CnameProbeOptionsV3
): Promise<CnameProbeOutcomeV3> {
  const firstPartyReg = options.registrableDomain(firstPartyHost).toLowerCase();
  const requestCounts = new Map<string, number>();

  for (const req of requests) {
    if (req.thirdParty) continue;
    const host = normalizeHost(req.domain);
    if (!host || host === firstPartyReg) continue;
    if (options.registrableDomain(host).toLowerCase() !== firstPartyReg) continue;
    requestCounts.set(host, (requestCounts.get(host) ?? 0) + 1);
  }

  // Prioritize subdomains by request count descending so the busiest endpoints are always checked.
  const allCandidates = [...requestCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([host]) => host);

  const maxHosts = Math.max(0, options.maxHosts ?? DEFAULT_MAX_HOSTS);
  const candidates = allCandidates.slice(0, maxHosts);
  const omittedCandidateCount = Math.max(0, allCandidates.length - candidates.length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, candidates.length || 1));
  const resolver =
    options.resolveCnameChain ??
    ((host: string) =>
      defaultResolveCnameChainV3(host, {
        maxHops: options.maxHops ?? DEFAULT_MAX_HOPS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      }));

  const cloaks: CnameCloakV3[] = [];
  const cloakTargetByHost = new Map<string, string>();
  let failedLookups = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < candidates.length) {
      const host = candidates[cursor++];
      let resolution: CnameChainResultV3;
      try {
        resolution = await resolver(host);
      } catch {
        failedLookups += 1;
        continue;
      }

      let matchedCloak: CnameCloakV3 | null = null;
      for (const hop of resolution.chain) {
        const target = normalizeHost(hop);
        if (!target) continue;
        const targetReg = options.registrableDomain(target).toLowerCase();
        if (targetReg === firstPartyReg) continue;

        const shieldsMatched = options.shieldsMatchHost ? options.shieldsMatchHost(target, host) : false;
        const attribution = attributeDomainV3(target, {
          shieldsMatched,
          registrableDomain: targetReg
        });
        // Skip plain CDN/infra CNAMEs unless Shields explicitly flags them.
        if (!attribution || (attribution.category === "cdn-infra" && !shieldsMatched)) {
          continue;
        }
        matchedCloak = {
          host,
          cnameChain: resolution.chain,
          targetDomain: target,
          entity: { ...attribution, confidence: "cname-uncloaked" },
          shieldsMatched,
          requestCount: requestCounts.get(host) ?? 0
        };
        break;
      }

      if (matchedCloak) {
        cloaks.push(matchedCloak);
        cloakTargetByHost.set(host, matchedCloak.targetDomain);
      } else if (!resolution.terminated) {
        failedLookups += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  cloaks.sort((a, b) => b.requestCount - a.requestCount || a.host.localeCompare(b.host));

  return {
    cloaks,
    cloakTargetByHost,
    omittedCandidateCount,
    failedLookups
  };
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CNAME lookup timed out")), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

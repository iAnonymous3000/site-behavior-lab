export type TurnstileProbeResult = "verified" | "misconfigured" | "unavailable";

/** How long a verified or misconfigured answer stands. */
export const TURNSTILE_PROBE_SETTLED_TTL_MS = 60_000;
/** How long an unavailable answer stands: a transient Siteverify failure, retried soon. */
export const TURNSTILE_PROBE_UNAVAILABLE_TTL_MS = 5_000;
/** The most probes one isolate runs at once for the unauthenticated ingress preflight. */
export const TURNSTILE_PROBE_MAX_IN_FLIGHT = 2;

/**
 * The public-ingress preflight's Turnstile configuration probe, shared across
 * requests only as a SETTLED answer.
 *
 * The probe's fetch belongs to the request that started it. Caching the
 * pending promise handed one request's I/O to every other request in the next
 * minute, so a cancelled first request could hang or fail the ones waiting on
 * it. Here each request awaits only a probe it started itself, and only the
 * answer is kept.
 *
 * The route is unauthenticated, so the cache must still bound what it costs
 * Siteverify: a settled answer is reused for its window, and at most
 * TURNSTILE_PROBE_MAX_IN_FLIGHT probes run at once. A request that finds that
 * many in flight reads the last settled answer for its secret, however old,
 * or "unavailable" when there is none, and starts no probe.
 */
export function createTurnstileProbeCache(options: {
  probe: (secret: string) => Promise<TurnstileProbeResult>;
  now?: () => number;
}): { get(secret: string): Promise<TurnstileProbeResult> } {
  const now = options.now ?? Date.now;
  let settled: { expiresAt: number; result: TurnstileProbeResult; secret: string } | undefined;
  let inFlight = 0;
  return {
    async get(secret) {
      const known = settled?.secret === secret ? settled : undefined;
      if (known && known.expiresAt > now()) return known.result;
      if (inFlight >= TURNSTILE_PROBE_MAX_IN_FLIGHT) return known?.result ?? "unavailable";
      inFlight += 1;
      let result: TurnstileProbeResult;
      try {
        result = await options.probe(secret);
      } catch {
        result = "unavailable";
      } finally {
        inFlight -= 1;
      }
      settled = {
        expiresAt: now() + (result === "unavailable" ? TURNSTILE_PROBE_UNAVAILABLE_TTL_MS : TURNSTILE_PROBE_SETTLED_TTL_MS),
        result,
        secret
      };
      return result;
    }
  };
}

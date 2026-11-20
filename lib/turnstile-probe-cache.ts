import { TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS } from "./edge-scan-gate";

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
 * What a request gets:
 *   - a fresh settled answer for its secret (within its hold time): that
 *     answer, with no probe;
 *   - otherwise its own probe, under the probe's own deadline;
 *   - except that while TURNSTILE_PROBE_MAX_IN_FLIGHT probes are already
 *     running AND a settled answer for the secret exists no older than its
 *     hold time plus one probe deadline, it reads that answer and starts no
 *     probe.
 * So no answer is invented: with nothing settled, every caller probes, and a
 * cold isolate's burst never reads an "unavailable" that no probe returned. And
 * no answer is unboundedly old: past the bound the caller probes. The route's
 * request volume is bounded per client at the edge
 * (chargePublicIngressPreflightRateLimit); this cap bounds the concurrent
 * Siteverify calls an isolate makes once it has an answer to fall back on.
 */
export function createTurnstileProbeCache(options: {
  probe: (secret: string) => Promise<TurnstileProbeResult>;
  now?: () => number;
}): { get(secret: string): Promise<TurnstileProbeResult> } {
  const now = options.now ?? Date.now;
  let settled: { settledAt: number; holdMs: number; result: TurnstileProbeResult; secret: string } | undefined;
  let inFlight = 0;
  return {
    async get(secret) {
      const known = settled?.secret === secret ? settled : undefined;
      const age = known ? now() - known.settledAt : Infinity;
      if (known && age < known.holdMs) return known.result;
      if (
        known &&
        inFlight >= TURNSTILE_PROBE_MAX_IN_FLIGHT &&
        age <= known.holdMs + TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS
      ) {
        return known.result;
      }
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
        settledAt: now(),
        holdMs: result === "unavailable" ? TURNSTILE_PROBE_UNAVAILABLE_TTL_MS : TURNSTILE_PROBE_SETTLED_TTL_MS,
        result,
        secret
      };
      return result;
    }
  };
}

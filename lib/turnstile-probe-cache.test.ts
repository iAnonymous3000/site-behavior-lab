import assert from "node:assert/strict";
import { test } from "node:test";
import { TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS } from "./edge-scan-gate";
import {
  TURNSTILE_PROBE_SETTLED_TTL_MS,
  createTurnstileProbeCache,
  type TurnstileProbeResult
} from "./turnstile-probe-cache";

/** A probe whose answers the test settles by hand, counting every call. */
function manualProbe() {
  const pending: Array<(value: TurnstileProbeResult) => void> = [];
  const probe = (_secret: string) =>
    new Promise<TurnstileProbeResult>((resolve) => {
      pending.push(resolve);
    });
  return { probe, pending, calls: () => pending.length };
}

test("a request never receives another request's probe while it is still in flight", async () => {
  // The probe's fetch belongs to the request that started it. Handing that
  // pending promise to a second request tied the second to the first's I/O:
  // if the first was cancelled, the second could hang or fail with it.
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => 0 });
  const first = cache.get("secret");
  const second = cache.get("secret");
  assert.equal(calls(), 2, "the second request runs its own probe instead of awaiting the first's");
  pending.forEach((resolve, index) => resolve(index === 0 ? "unavailable" : "verified"));
  assert.equal(await second, "verified", "the second request settles on its own probe, whatever the first does");
  assert.equal(await first, "unavailable");
});

test("a settled result is reused for a minute and then probed again", async () => {
  let clock = 0;
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => clock });
  const first = cache.get("secret");
  pending[0]("verified");
  assert.equal(await first, "verified");
  clock = 59_000;
  assert.equal(await cache.get("secret"), "verified");
  assert.equal(calls(), 1, "a settled result inside its window is not probed again");
  clock = 60_001;
  const later = cache.get("secret");
  assert.equal(calls(), 2, "past its window the result is probed again");
  pending[1]("misconfigured");
  assert.equal(await later, "misconfigured");
});

test("an unavailable result is retried after seconds, not held for a minute", async () => {
  // A transient Siteverify failure is cached as "unavailable". Held for the
  // full minute it made every monitor read in that minute degraded.
  let clock = 0;
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => clock });
  const first = cache.get("secret");
  pending[0]("unavailable");
  assert.equal(await first, "unavailable");
  clock = 4_000;
  assert.equal(await cache.get("secret"), "unavailable");
  assert.equal(calls(), 1, "inside its short window the unavailable result stands");
  clock = 6_000;
  const retry = cache.get("secret");
  assert.equal(calls(), 2, "an unavailable result is probed again after a few seconds");
  pending[1]("verified");
  assert.equal(await retry, "verified");
});

test("a cold isolate with three or more concurrent callers gives every caller a real probe answer", async () => {
  // With nothing settled for the secret there is no answer to fall back on,
  // so the cap does not apply: a caller turned away here would read
  // "unavailable" though no probe failed, and Production Health would file
  // that as an incident.
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => 0 });
  const callers = [cache.get("secret"), cache.get("secret"), cache.get("secret"), cache.get("secret")];
  assert.equal(calls(), 4, "every caller on a cold isolate runs its own probe");
  pending.forEach((resolve) => resolve("verified"));
  assert.deepEqual(await Promise.all(callers), ["verified", "verified", "verified", "verified"], "no caller reads an unavailable that no probe returned");
});

test("with a settled answer, no more than two probes run at once and an overflow caller reads it", async () => {
  let clock = 0;
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => clock });
  const first = cache.get("secret");
  pending[0]("verified");
  assert.equal(await first, "verified");

  // Past the hold, two probes in flight: a third caller starts no probe and
  // reads the settled answer, still inside the overflow bound.
  clock = TURNSTILE_PROBE_SETTLED_TTL_MS + 1_000;
  const two = cache.get("secret");
  const three = cache.get("secret");
  const overflow = cache.get("secret");
  assert.equal(calls(), 3, "the third request starts no probe");
  pending.slice(1).forEach((resolve) => resolve("misconfigured"));
  assert.equal(await overflow, "verified", "the overflow caller reads the settled answer");
  await Promise.all([two, three]);
});

test("an overflow caller never receives an answer older than the hold time plus one probe deadline", async () => {
  // An old "verified" handed to an overflow caller could hide a broken
  // configuration for as long as probes stay busy. Past the bound the caller
  // runs its own probe instead.
  let clock = 0;
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => clock });
  const first = cache.get("secret");
  pending[0]("verified");
  await first;
  clock = TURNSTILE_PROBE_SETTLED_TTL_MS + TURNSTILE_CONFIGURATION_PROBE_TIMEOUT_MS + 1;
  const two = cache.get("secret");
  const three = cache.get("secret");
  const late = cache.get("secret");
  assert.equal(calls(), 4, "past the bound the overflow caller runs its own probe");
  pending.slice(1).forEach((resolve) => resolve("misconfigured"));
  assert.equal(await late, "misconfigured", "it reads its own probe's answer, not the old one");
  await Promise.all([two, three]);
});

test("a result for one secret is never reused for another", async () => {
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => 0 });
  const first = cache.get("old-secret");
  pending[0]("verified");
  await first;
  const other = cache.get("new-secret");
  assert.equal(calls(), 2);
  pending[1]("misconfigured");
  assert.equal(await other, "misconfigured");
});

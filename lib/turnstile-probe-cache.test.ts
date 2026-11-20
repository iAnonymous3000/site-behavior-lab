import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("no more than two probes run at once, so the unauthenticated route still bounds Siteverify calls", async () => {
  let clock = 0;
  const { probe, pending, calls } = manualProbe();
  const cache = createTurnstileProbeCache({ probe, now: () => clock });
  // Every probe is settled before any result is awaited, so a wrong cache
  // fails these assertions instead of leaving the test waiting.
  const one = cache.get("secret");
  const two = cache.get("secret");
  const overflow = cache.get("secret");
  assert.equal(calls(), 2, "the third request starts no probe");
  pending.forEach((resolve) => resolve("verified"));
  assert.equal(await overflow, "unavailable", "with two probes in flight and nothing settled, a third reads unavailable");
  await Promise.all([one, two]);

  // With a settled result past its window and two probes in flight, a third
  // request reads that last result instead of starting another probe.
  clock = 61_000;
  const three = cache.get("secret");
  const four = cache.get("secret");
  const stale = cache.get("secret");
  assert.equal(calls(), 4, "the third request starts no probe");
  pending.slice(2).forEach((resolve) => resolve("misconfigured"));
  assert.equal(await stale, "verified", "the third request reads the last settled result");
  await Promise.all([three, four]);
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

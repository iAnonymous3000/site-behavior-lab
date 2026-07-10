import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSinceLastScan, formatDelta, type TemporalDeltaInput } from "./temporal-deltas";

function entry(overrides: Partial<TemporalDeltaInput> & { id: string }): TemporalDeltaInput {
  return {
    domain: "shop.example",
    scannedAt: "2026-07-01T00:00:00.000Z",
    reportType: "comparison",
    comparisonType: "shields",
    thirdPartyRequests: 0,
    trackerRequests: 0,
    ...overrides
  };
}

test("pairs the newest report with its predecessor of the same kind", () => {
  const deltas = computeSinceLastScan([
    entry({ id: "old", scannedAt: "2026-06-20T00:00:00.000Z", thirdPartyRequests: 100, trackerRequests: 40 }),
    entry({ id: "new", scannedAt: "2026-07-02T00:00:00.000Z", thirdPartyRequests: 112, trackerRequests: 37 }),
    entry({ id: "oldest", scannedAt: "2026-06-01T00:00:00.000Z", thirdPartyRequests: 60, trackerRequests: 10 })
  ]);

  assert.equal(deltas.size, 1);
  const delta = deltas.get("new");
  assert.deepEqual(delta, {
    previousId: "old",
    previousScannedAt: "2026-06-20T00:00:00.000Z",
    thirdPartyRequests: 12,
    trackerRequests: -3
  });
});

test("never pairs across report kinds: a consent baseline is not a shields baseline", () => {
  const deltas = computeSinceLastScan([
    entry({ id: "shields-run", scannedAt: "2026-06-20T00:00:00.000Z", comparisonType: "shields", thirdPartyRequests: 50 }),
    entry({ id: "consent-run", scannedAt: "2026-07-02T00:00:00.000Z", comparisonType: "consent", thirdPartyRequests: 90 })
  ]);

  // Different kinds, one report each: no delta may be claimed.
  assert.equal(deltas.size, 0);
});

test("never pairs a clicked consent run with an unclicked one: the interaction difference is not a site change", () => {
  const deltas = computeSinceLastScan([
    entry({ id: "unclicked", scannedAt: "2026-06-20T00:00:00.000Z", comparisonType: "consent", consentClicks: "none", thirdPartyRequests: 90 }),
    entry({ id: "clicked", scannedAt: "2026-07-02T00:00:00.000Z", comparisonType: "consent", consentClicks: "accept-and-reject", thirdPartyRequests: 40 })
  ]);
  assert.equal(deltas.size, 0);

  // Two runs with the SAME dispatched click state still pair.
  const sameState = computeSinceLastScan([
    entry({ id: "old", scannedAt: "2026-06-20T00:00:00.000Z", comparisonType: "consent", consentClicks: "none", thirdPartyRequests: 90 }),
    entry({ id: "new", scannedAt: "2026-07-02T00:00:00.000Z", comparisonType: "consent", consentClicks: "none", thirdPartyRequests: 100 })
  ]);
  assert.equal(sameState.get("new")?.thirdPartyRequests, 10);
});

test("separates sites, requires two reports, and skips invalid timestamps", () => {
  const deltas = computeSinceLastScan([
    entry({ id: "a-new", domain: "a.example", scannedAt: "2026-07-02T00:00:00.000Z", thirdPartyRequests: 5 }),
    entry({ id: "a-old", domain: "a.example", scannedAt: "2026-06-25T00:00:00.000Z", thirdPartyRequests: 5 }),
    entry({ id: "b-only", domain: "b.example" }),
    entry({ id: "c-bad", domain: "c.example", scannedAt: "not a date" })
  ]);

  assert.equal(deltas.size, 1);
  assert.equal(deltas.get("a-new")?.thirdPartyRequests, 0);
});

test("formatDelta prints signed values and a plain no-change label", () => {
  assert.equal(formatDelta(12), "+12");
  assert.equal(formatDelta(-3), "-3");
  assert.equal(formatDelta(0), "no change");
  assert.equal(formatDelta(1200), "+1,200");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_STATUS_MAX_HEALTH_AGE_MS,
  evaluateLiveDeployment,
  freshnessExpiryDelayMs,
  freshnessState
} from "./public-status";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const SHA = "a".repeat(40);

function pages(deployment = SHA): unknown {
  return { schemaVersion: 1, deployment };
}

function scanner(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    status: "ok",
    timestamp: new Date(NOW - 30_000).toISOString(),
    deployment: SHA,
    scansAvailable: true,
    warnings: [],
    ...overrides
  };
}

test("freshness state fails closed for absent, malformed, and future dates", () => {
  assert.equal(freshnessState(null, 1_000, NOW), "unknown");
  assert.equal(freshnessState("not-a-date", 1_000, NOW), "unknown");
  assert.equal(freshnessState(new Date(NOW + 60_001).toISOString(), 1_000, NOW), "unknown");
  assert.equal(freshnessState(new Date(NOW - 1_000).toISOString(), 1_000, NOW), "current");
  assert.equal(freshnessState(new Date(NOW - 1_001).toISOString(), 1_000, NOW), "stale");
});

test("freshness exposes the exact bounded delay before a current badge must expire", () => {
  const observedAt = new Date(NOW - 1_000).toISOString();
  assert.equal(freshnessExpiryDelayMs(observedAt, 5_000, NOW), 4_001);
  assert.equal(freshnessExpiryDelayMs(observedAt, 5_000, NOW + 4_001), null);
  assert.equal(freshnessExpiryDelayMs("not-a-date", 5_000, NOW), null);
});

test("live status claims endpoint alignment only for fresh, matching, healthy deployments", () => {
  const evaluation = evaluateLiveDeployment(pages(), scanner(), NOW);
  assert.equal(evaluation.state, "aligned");
  assert.match(evaluation.summary, /does not submit a scan or verify report persistence/i);
  assert.equal(evaluation.pagesDeployment, SHA);
  assert.equal(evaluation.scannerDeployment, SHA);
  assert.equal(
    evaluateLiveDeployment(pages(), scanner(), NOW + PUBLIC_STATUS_MAX_HEALTH_AGE_MS + 30_001).state,
    "stale"
  );
});

test("live status distinguishes degraded, stale, and unknown evidence", () => {
  assert.equal(evaluateLiveDeployment(pages(), scanner({ deployment: "b".repeat(40) }), NOW).state, "degraded");
  assert.equal(evaluateLiveDeployment(pages(), scanner({ warnings: ["problem"] }), NOW).state, "degraded");
  assert.equal(evaluateLiveDeployment(pages(), scanner({ scansAvailable: false }), NOW).state, "degraded");
  assert.equal(
    evaluateLiveDeployment(
      pages(),
      scanner({ timestamp: new Date(NOW - PUBLIC_STATUS_MAX_HEALTH_AGE_MS - 1).toISOString() }),
      NOW
    ).state,
    "stale"
  );
  assert.equal(evaluateLiveDeployment({}, scanner(), NOW).state, "unknown");
  assert.equal(evaluateLiveDeployment(pages(), { ok: true }, NOW).state, "unknown");
});

test("a fresh revision mid-rollout is not reported as degraded", () => {
  // Pages publishes in about a minute while the scanner rebuilds its container,
  // so every promotion produces a revision mismatch for several minutes. Badging
  // that "degraded" trains readers to ignore the badge.
  const evaluation = evaluateLiveDeployment(
    { schemaVersion: 1, deployment: SHA, revisionCommittedAt: new Date(NOW - 6 * 60_000).toISOString() },
    scanner({ deployment: "b".repeat(40) }),
    NOW
  );

  assert.equal(evaluation.state, "rolling-out");
  assert.match(evaluation.summary, /rolling out/i);
  assert.doesNotMatch(evaluation.summary, /degraded/i);
});

test("a mismatch past the rollout window, or beside an unhealthy scanner, stays degraded", () => {
  // Same mismatch, but the revision is far older than any rollout takes.
  const stuck = evaluateLiveDeployment(
    { schemaVersion: 1, deployment: SHA, revisionCommittedAt: new Date(NOW - 3 * 60 * 60_000).toISOString() },
    scanner({ deployment: "b".repeat(40) }),
    NOW
  );
  assert.equal(stuck.state, "degraded");
  assert.match(stuck.summary, /past its expected rollout window/);

  // Inside the window, but the scanner is not healthy: the rollout excuse must
  // not launder a real fault.
  const faulty = evaluateLiveDeployment(
    { schemaVersion: 1, deployment: SHA, revisionCommittedAt: new Date(NOW - 6 * 60_000).toISOString() },
    scanner({ deployment: "b".repeat(40), warnings: ["R2 credentials are missing"] }),
    NOW
  );
  assert.equal(faulty.state, "degraded");

  // A receipt published before the field existed carries no rollout evidence,
  // so it must not be softened by its absence.
  const legacy = evaluateLiveDeployment(pages(), scanner({ deployment: "b".repeat(40) }), NOW);
  assert.equal(legacy.state, "degraded");

  // A future-dated commit stamp is not evidence either.
  const future = evaluateLiveDeployment(
    { schemaVersion: 1, deployment: SHA, revisionCommittedAt: new Date(NOW + 10 * 60_000).toISOString() },
    scanner({ deployment: "b".repeat(40) }),
    NOW
  );
  assert.equal(future.state, "degraded");
});

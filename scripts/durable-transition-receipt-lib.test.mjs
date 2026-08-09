import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DURABLE_CONFIG_PATH,
  TRANSITION_RECEIPT_PATH,
  actionsRunAttemptEndpoint,
  buildDurableEnableTransitionReceipt,
  canonicalTransitionReceiptText,
  transitionReceiptSha256
} from "./durable-transition-receipt-lib.mjs";

const FROM = "1".repeat(40);
const TO = "2".repeat(40);
const REPO = "iAnonymous3000/site-behavior-lab";

function run(kind, overrides = {}) {
  const paths = {
    ci: ".github/workflows/ci.yml",
    promotion: ".github/workflows/promote-production.yml",
    productionHealth: ".github/workflows/production-health.yml"
  };
  return {
    id: 4242,
    path: paths[kind],
    head_branch: "main",
    head_sha: TO,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    updated_at: "2026-08-10T00:00:00.000Z",
    repository: { full_name: REPO },
    ...overrides
  };
}

const HEALTH_PAYLOAD = {
  status: "ok",
  warnings: [],
  checks: { durableJobs: { requested: true, enabled: true, readiness: "ready" } }
};

function input(overrides = {}) {
  return {
    fromCommit: FROM,
    toCommit: TO,
    replay: {
      deploymentCommit: FROM,
      receiptSetDigest: "a".repeat(64),
      evidenceStartedAt: "2026-08-09T00:00:00.000Z",
      evidenceCapturedAt: "2026-08-09T01:00:00.000Z"
    },
    stagingTeardownRecordedAt: "2026-08-09T01:30:00.000Z",
    secrets: {
      checkedAt: "2026-08-09T02:00:00.000Z",
      durableJobsKeyPresent: true,
      durableJobsInternalTokenPresent: true
    },
    changeControl: {
      pullRequestUrl: `https://github.com/${REPO}/pull/101`,
      mergeCommit: TO,
      mergedAt: "2026-08-09T03:00:00.000Z"
    },
    ciRun: run("ci", { updated_at: "2026-08-09T04:00:00.000Z" }),
    promotionRun: {
      ...run("promotion", { updated_at: "2026-08-09T05:00:00.000Z" }),
      deploymentDigest: "b".repeat(64)
    },
    productionHealthRun: run("productionHealth", { updated_at: "2026-08-09T06:00:00.000Z" }),
    productionHealthPayload: HEALTH_PAYLOAD,
    recordedAt: "2026-08-09T07:00:00.000Z",
    ...overrides
  };
}

test("a fully evidenced transition builds, in the exact key order the binding compares", () => {
  const receipt = buildDurableEnableTransitionReceipt(input());
  assert.deepEqual(Object.keys(receipt), [
    "schemaVersion",
    "artifactKind",
    "transition",
    "replay",
    "secrets",
    "changeControl",
    "ci",
    "promotion",
    "productionHealth",
    "recordedAt"
  ]);
  assert.deepEqual(Object.keys(receipt.transition), ["configPath", "fromCommit", "toCommit"]);
  assert.deepEqual(Object.keys(receipt.ci), [
    "workflow",
    "runId",
    "runAttempt",
    "headCommit",
    "conclusion",
    "completedAt"
  ]);
  assert.deepEqual(Object.keys(receipt.promotion), [
    "workflow",
    "runId",
    "runAttempt",
    "productionCommit",
    "deploymentDigest",
    "convergedAt"
  ]);
  assert.deepEqual(Object.keys(receipt.productionHealth), [
    "workflow",
    "runId",
    "runAttempt",
    "headCommit",
    "status",
    "warningCount",
    "durableJobs",
    "observedAt"
  ]);
  assert.deepEqual(Object.keys(receipt.productionHealth.durableJobs), [
    "requested",
    "enabled",
    "readiness"
  ]);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.artifactKind, "site-behavior-durable-enable-transition");
  assert.equal(receipt.transition.configPath, DURABLE_CONFIG_PATH);
});

test("a caller cannot assert a conclusion the API did not report", () => {
  // The point of the whole module. Every one of these is a field an operator
  // would otherwise hand-type into a receipt nobody could check.
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ ciRun: run("ci", { conclusion: "failure" }) })),
    /concluded failure, not success/
  );
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ ciRun: run("ci", { status: "in_progress" }) })),
    /has not completed/
  );
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ productionHealthPayload: { ...HEALTH_PAYLOAD, status: "degraded" } })
      ),
    /production health status is degraded/
  );
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({
          productionHealthPayload: {
            ...HEALTH_PAYLOAD,
            checks: { durableJobs: { requested: true, enabled: false, readiness: "ready" } }
          }
        })
      ),
    /positively prove durable readiness/
  );
});

test("warningCount is counted from the payload, never accepted as a number", () => {
  const receipt = buildDurableEnableTransitionReceipt(input());
  assert.equal(receipt.productionHealth.warningCount, 0);
  // Not a field: supplying one changes nothing, because the count is derived.
  const withClaim = buildDurableEnableTransitionReceipt(
    input({ productionHealthPayload: { ...HEALTH_PAYLOAD, warningCount: 99 } })
  );
  assert.equal(withClaim.productionHealth.warningCount, 0);
});

test("every run must be the governed workflow, on main, in this repository, at the transition commit", () => {
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ ciRun: run("ci", { path: ".github/workflows/other.yml" }) })),
    /not \.github\/workflows\/ci\.yml/
  );
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ ciRun: run("ci", { head_branch: "topic" }) })),
    /not main/
  );
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ ciRun: run("ci", { repository: { full_name: "someone/else" } }) })
      ),
    /not iAnonymous3000\/site-behavior-lab/
  );
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ ciRun: run("ci", { head_sha: "9".repeat(40) }) })),
    /not the transition commit/
  );
});

test("the replay evidence must name the transition's own parent", () => {
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ replay: { ...input().replay, deploymentCommit: "9".repeat(40) } })
      ),
    /must be the direct first child of the replay deployment commit/
  );
});

test("the staging teardown is part of the chain, not skipped", () => {
  // The binding's chain runs replay -> staging teardown -> secrets. Omitting
  // the teardown step let this module bless a receipt the binding refuses,
  // which is the one thing it exists to prevent.
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ stagingTeardownRecordedAt: undefined })),
    /stagingTeardown\.recordedAt must be a canonical UTC instant/
  );
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ stagingTeardownRecordedAt: "2026-08-09T06:30:00.000Z" })
      ),
    /chronology is out of order/
  );
});

test("a warning run is refused rather than written as a receipt nobody can use", () => {
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({
          productionHealthPayload: { ...HEALTH_PAYLOAD, warnings: ["egress region is placement-derived"] }
        })
      ),
    /reported 1 warning\(s\)/
  );
});

test("an out-of-order chronology is refused here rather than at binding time", () => {
  // Discovering this in the binding means the receipt was already committed.
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ recordedAt: "2026-08-08T00:00:00.000Z" })),
    /chronology is out of order/
  );
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ secrets: { ...input().secrets, checkedAt: "2026-08-01T00:00:00.000Z" } })
      ),
    /chronology is out of order/
  );
});

test("secret values are never recordable, and absence is refused", () => {
  const receipt = buildDurableEnableTransitionReceipt(input());
  assert.equal(receipt.secrets.valuesRecorded, false);
  assert.equal(Object.keys(receipt.secrets).length, 4);
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ secrets: { ...input().secrets, durableJobsKeyPresent: false } })
      ),
    /both durable secrets must be observed present/
  );
});

test("change control must be a governed pull request that produced the transition commit", () => {
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ changeControl: { ...input().changeControl, pullRequestUrl: "https://example.test/pull/1" } })
      ),
    /governed pull request/
  );
  assert.throws(
    () =>
      buildDurableEnableTransitionReceipt(
        input({ changeControl: { ...input().changeControl, mergeCommit: "9".repeat(40) } })
      ),
    /must be the transition commit/
  );
});

test("timestamps must be canonical, so the receipt round-trips byte-identically", () => {
  assert.throws(
    () => buildDurableEnableTransitionReceipt(input({ recordedAt: "2026-08-09T07:00:00Z" })),
    /canonical UTC instant/
  );
});

test("the replay digest and window are delegated, never invented here", async () => {
  // An earlier version of this module hashed the two receipt FILES' raw bytes,
  // a fourth incompatible definition of a digest the repository already defines
  // exactly once. Every receipt it produced would have been refused. Assert the
  // delegation itself, so a reimplementation cannot come back.
  const source = readFileSync(
    path.join(process.cwd(), "scripts", "durable-transition-receipt-lib.mjs"),
    "utf8"
  );
  assert.match(source, /verifyDurableReplayReceiptSet/, "must delegate to the canonical verifier");
  // Precisely what went wrong, not "any hashing": this module legitimately
  // hashes its OWN canonical receipt text in transitionReceiptSha256.
  assert.doesNotMatch(
    source,
    /export function replayReceiptSetDigest/,
    "must not export a second replay receipt-set digest"
  );
  assert.doesNotMatch(
    source,
    /readFileSync/,
    "must not read the replay receipts itself; the verifier owns their semantics"
  );

  // And the delegation must be to the one definition the binding uses.
  const canonical = readFileSync(
    path.join(process.cwd(), "scripts", "durable-replay-receipt-lib.mjs"),
    "utf8"
  );
  assert.match(canonical, /export function durableReplayReceiptSetDigest/);
  assert.match(canonical, /export function verifyDurableReplayReceiptSet/);
});

test("the canonical text is exactly what the binding compares against", () => {
  const receipt = buildDurableEnableTransitionReceipt(input());
  const text = canonicalTransitionReceiptText(receipt);
  assert.equal(text, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.ok(text.endsWith("}\n"));
  assert.equal(
    transitionReceiptSha256(receipt),
    createHash("sha256").update(text).digest("hex")
  );
});

test("the endpoint builder refuses inputs outside the binding's own ranges", () => {
  assert.equal(actionsRunAttemptEndpoint(7, 1), `/repos/${REPO}/actions/runs/7/attempts/1`);
  assert.throws(() => actionsRunAttemptEndpoint(0, 1), /positive integer/);
  assert.throws(() => actionsRunAttemptEndpoint(7, 0), /between 1 and 100/);
  assert.throws(() => actionsRunAttemptEndpoint(7, 101), /between 1 and 100/);
});

test("the receipt path and workflow refs match the binding, not a copy of it", () => {
  const binding = readFileSync(
    path.join(process.cwd(), "lib", "measurement-candidate-binding.ts"),
    "utf8"
  );
  assert.ok(binding.includes(`"${TRANSITION_RECEIPT_PATH}"`), "receipt path drifted from the binding");
  const receipt = buildDurableEnableTransitionReceipt(input());
  for (const workflowRef of [
    receipt.ci.workflow,
    receipt.promotion.workflow,
    receipt.productionHealth.workflow
  ]) {
    assert.ok(binding.includes(workflowRef), `workflow ref drifted from the binding: ${workflowRef}`);
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<any>;
const receiptLib = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "durable-replay-receipt-lib.mjs")).href
);
const VALIDATOR = path.join(process.cwd(), "scripts", "validate-durable-replay-receipts.mjs");
const SHA = "a".repeat(40);
const ORIGIN = "https://scan-staging.sitebehavior.org";
const BASE_TIME = Date.parse("2026-08-01T12:00:00.000Z");

function timestamp(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function health(deploymentSha = SHA, origin = ORIGIN): Record<string, unknown> {
  return {
    ok: true,
    status: "ok",
    warnings: [],
    scansAvailable: true,
    authenticated: true,
    openAccess: false,
    deployment: deploymentSha,
    checks: {
      chromiumSandbox: "enabled",
      publicR2Reports: { status: "enabled" },
      reportStore: { kind: "r2" },
      durableJobs: {
        requested: true,
        enabled: true,
        readiness: "ready",
        coordinatorOrigin: origin,
        faultInjection: {
          environment: "staging",
          enabled: true,
          modes: ["lost-resolve", "lease-expiry"],
          modeHeaderName: "x-staging-fault-mode",
          tokenHeaderName: "x-staging-fault-token",
          minimumNoPollMs: 240_000,
          attemptEvidence: true,
          completionBeforeStatusRequestEvidence: true,
          wholeOriginAccessGate: true
        }
      }
    }
  };
}

async function makeReceipt({
  mode,
  startOffset,
  deploymentSha = SHA,
  origin = ORIGIN,
  originLabel = "durable-replay-staging",
  jobId,
  reportId
}: {
  mode: "lease-expiry" | "lost-resolve";
  startOffset: number;
  deploymentSha?: string;
  origin?: string;
  originLabel?: string;
  jobId?: string;
  reportId?: string;
}): Promise<any> {
  const { buildDurableReplayReceipt } = await receiptLib;
  const idDigit = mode === "lease-expiry" ? "1" : "3";
  const reportDigit = mode === "lease-expiry" ? "2" : "4";
  const canaryHealth = health(deploymentSha, origin);
  return buildDurableReplayReceipt({
    mode,
    expectedDeploymentSha: deploymentSha,
    origin,
    originLabel,
    recordedAt: timestamp(startOffset + 246_000),
    timing: {
      startedAt: timestamp(startOffset),
      submittedAt: timestamp(startOffset + 1_000),
      noPollMs: 240_000,
      blindWindowEndedAt: timestamp(startOffset + 241_000),
      statusObservedAt: timestamp(startOffset + 242_000),
      reportReadbackAt: timestamp(startOffset + 243_000),
      completedAt: timestamp(startOffset + 245_000)
    },
    preHealth: {
      observedAt: timestamp(startOffset + 500),
      health: canaryHealth
    },
    postHealth: {
      observedAt: timestamp(startOffset + 244_000),
      health: canaryHealth
    },
    execution: {
      terminalStatus: "succeeded",
      jobId: jobId ?? `20260801-${idDigit.repeat(32)}`,
      reportId: reportId ?? `20260801-${reportDigit.repeat(32)}`,
      attempts: mode === "lease-expiry" ? 2 : 1,
      faultTriggered: true,
      triggeredGeneration: 1,
      finishedBeforeStatusRequest: true,
      reportReadback: true
    }
  });
}

test("durable replay receipts bind exact evidence without secrets, origins, or target URLs", async () => {
  const { durableReplayReceiptIssues, durableReplayReceiptDigest } = await receiptLib;
  const receipt = await makeReceipt({ mode: "lease-expiry", startOffset: 0 });

  assert.deepEqual(durableReplayReceiptIssues(receipt), []);
  assert.equal(receipt.receiptDigest, durableReplayReceiptDigest(receipt));
  assert.equal(receipt.preHealth.identitySha256, receipt.postHealth.identitySha256);
  assert.equal(receipt.execution.finishedBeforeStatusRequest, true);
  assert.deepEqual(receipt.preHealth.identity.durableJobs.faultInjection.modes, [
    "lease-expiry",
    "lost-resolve"
  ]);

  const wire = JSON.stringify(receipt);
  assert.doesNotMatch(wire, /scan-staging\.sitebehavior\.org|example\.com/);
  assert.doesNotMatch(wire, /test-access-token|test-fault-token|super-secret|targetUrl|targetURL/);
});

test("durable replay receipt validation refuses extra fields, doctored facts, and stale digests", async () => {
  const { buildDurableReplayReceipt, durableReplayReceiptIssues } = await receiptLib;
  const receipt = await makeReceipt({ mode: "lease-expiry", startOffset: 0 });

  const extra = structuredClone(receipt);
  extra.targetUrl = "https://example.com/";
  assert.match(durableReplayReceiptIssues(extra).join(" "), /receipt must contain exactly/);

  const doctored = structuredClone(receipt);
  doctored.execution.attempts = 1;
  assert.match(durableReplayReceiptIssues(doctored).join(" "), /attempts must be 2/);
  assert.match(durableReplayReceiptIssues(doctored).join(" "), /receiptDigest does not match/);

  const healthDrift = structuredClone(receipt);
  healthDrift.postHealth.identity.warningCount = 1;
  assert.match(durableReplayReceiptIssues(healthDrift).join(" "), /warningCount must be zero/);
  assert.match(durableReplayReceiptIssues(healthDrift).join(" "), /identities must match exactly/);

  const shortWindow = structuredClone(receipt);
  shortWindow.timing.blindWindowEndedAt = shortWindow.timing.submittedAt;
  assert.match(
    durableReplayReceiptIssues(shortWindow).join(" "),
    /timestamps do not prove the declared no-poll duration/
  );

  const mismatchedHealth = health();
  (mismatchedHealth.checks as Record<string, any>).durableJobs.coordinatorOrigin =
    "https://other-staging.sitebehavior.org";
  assert.throws(
    () =>
      buildDurableReplayReceipt({
        mode: "lease-expiry",
        expectedDeploymentSha: SHA,
        origin: ORIGIN,
        originLabel: "durable-replay-staging",
        recordedAt: timestamp(246_000),
        timing: {
          startedAt: timestamp(0),
          submittedAt: timestamp(1_000),
          noPollMs: 240_000,
          blindWindowEndedAt: timestamp(241_000),
          statusObservedAt: timestamp(242_000),
          reportReadbackAt: timestamp(243_000),
          completedAt: timestamp(245_000)
        },
        preHealth: { observedAt: timestamp(500), health: mismatchedHealth },
        postHealth: { observedAt: timestamp(244_000), health: mismatchedHealth },
        execution: {
          terminalStatus: "succeeded",
          jobId: `20260801-${"1".repeat(32)}`,
          reportId: `20260801-${"2".repeat(32)}`,
          attempts: 2,
          faultTriggered: true,
          triggeredGeneration: 1,
          finishedBeforeStatusRequest: true,
          reportReadback: true
        }
      }),
    /bind the exact receipt origin/
  );
});

test("the activation validator requires both ordered modes on one exact SHA and origin", async () => {
  const {
    durableReplayReceiptSetIssues,
    durableReplayReceiptSetDigest,
    verifyDurableReplayReceiptSet
  } = await receiptLib;
  const lease = await makeReceipt({ mode: "lease-expiry", startOffset: 0 });
  const lost = await makeReceipt({ mode: "lost-resolve", startOffset: 600_000 });

  assert.deepEqual(durableReplayReceiptSetIssues([lease, lost], SHA), []);
  assert.match(durableReplayReceiptSetDigest([lease, lost], SHA), /^[0-9a-f]{64}$/);
  const verified = verifyDurableReplayReceiptSet([lease, lost], SHA);
  assert.equal(verified.ok, true);
  assert.match(verified.receiptSetDigest, /^[0-9a-f]{64}$/);
  assert.equal(verified.deploymentSha, SHA);
  assert.equal(verified.originLabel, "durable-replay-staging");
  assert.match(verified.originSha256, /^[0-9a-f]{64}$/);
  assert.equal(verified.evidenceStartedAt, lease.timing.startedAt);
  assert.equal(verified.evidenceCapturedAt, lost.recordedAt);
  assert.match(
    durableReplayReceiptSetIssues([lost, lease], SHA).join(" "),
    /order must be lease-expiry followed by lost-resolve/
  );
  assert.match(
    durableReplayReceiptSetIssues([lease, lease], SHA).join(" "),
    /one lease-expiry and one lost-resolve/
  );

  const anotherSha = await makeReceipt({
    mode: "lost-resolve",
    startOffset: 600_000,
    deploymentSha: "b".repeat(40)
  });
  assert.match(
    durableReplayReceiptSetIssues([lease, anotherSha], SHA).join(" "),
    /operator-selected deployment SHA|same deployment SHA/
  );

  const anotherOrigin = await makeReceipt({
    mode: "lost-resolve",
    startOffset: 600_000,
    origin: "https://other-staging.sitebehavior.org"
  });
  assert.match(
    durableReplayReceiptSetIssues([lease, anotherOrigin], SHA).join(" "),
    /same labeled staging origin/
  );

  const overlapping = await makeReceipt({ mode: "lost-resolve", startOffset: 100_000 });
  assert.match(
    durableReplayReceiptSetIssues([lease, overlapping], SHA).join(" "),
    /lost-resolve must start only after the lease-expiry receipt is recorded/
  );

  const sameInstant = await makeReceipt({ mode: "lost-resolve", startOffset: 246_000 });
  assert.match(
    durableReplayReceiptSetIssues([lease, sameInstant], SHA).join(" "),
    /lost-resolve must start only after the lease-expiry receipt is recorded/
  );

  const crossDuplicate = await makeReceipt({
    mode: "lost-resolve",
    startOffset: 600_000,
    jobId: lease.execution.reportId
  });
  assert.match(
    durableReplayReceiptSetIssues([lease, crossDuplicate], SHA).join(" "),
    /four distinct job and report ids/
  );
});

test("the operator CLI verifies the two receipt files and prints a set digest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-durable-receipts-"));
  try {
    const leasePath = path.join(directory, "lease-expiry.json");
    const lostPath = path.join(directory, "lost-resolve.json");
    await writeFile(
      leasePath,
      `${JSON.stringify(await makeReceipt({ mode: "lease-expiry", startOffset: 0 }), null, 2)}\n`
    );
    await writeFile(
      lostPath,
      `${JSON.stringify(await makeReceipt({ mode: "lost-resolve", startOffset: 600_000 }), null, 2)}\n`
    );

    const result = spawnSync(process.execPath, [VALIDATOR, SHA, leasePath, lostPath], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS lease-expiry and lost-resolve receipts bind the same exact staging deployment/);
    assert.match(result.stdout, /receipt-set sha256:[0-9a-f]{64}/);

    const swapped = spawnSync(process.execPath, [VALIDATOR, SHA, lostPath, leasePath], {
      encoding: "utf8"
    });
    assert.equal(swapped.status, 1);
    assert.match(swapped.stderr, /order must be lease-expiry followed by lost-resolve/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

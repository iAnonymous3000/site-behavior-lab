import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

/**
 * These tests assert on the SHAPE of worker source, so every one of them is a
 * marker lookup away from becoming vacuous: `indexOf` answers a missing marker
 * with -1, `slice(start, -1)` silently widens to almost the whole file, and
 * `-1 < anything` is trivially true. A rename then leaves the assertion green
 * while it no longer constrains the region it names. That is exactly how two
 * bounded-fetch guards here survived `gateDurableScanJobControlRequest`
 * becoming `refuseUnauthorizedDurableScanJobControl`: both widened to ~48 kB
 * and were satisfied by an unrelated copy of the pattern elsewhere in the file.
 *
 * Every marker lookup goes through these, so the next rename fails loudly and
 * names the marker it could not find.
 */
function requireIndex(source: string, marker: string, label = "source"): number {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `${label} no longer contains ${JSON.stringify(marker)}; the assertion below constrains nothing until this marker is updated`);
  return index;
}

function sliceBetween(source: string, startMarker: string, endMarker: string, label = "source"): string {
  const start = requireIndex(source, startMarker, label);
  const end = requireIndex(source, endMarker, label);
  assert.ok(
    end > start,
    `${label}: ${JSON.stringify(endMarker)} precedes ${JSON.stringify(startMarker)}, so the intended region is empty`
  );
  return source.slice(start, end);
}
import type { DurableScanJobPreparation } from "./durable-scan-job-contract";
import {
  awaitDurableScanJobAdmissionStep,
  chooseDurableScanJobPumpWakeAt,
  DurableScanJobAdmissionTimeoutError,
  durableScanJobsFlagState,
  durableScanJobNodeHealthState,
  durableScanJobSecretsAreDistinct,
  durableScanJobKeyIsIsolated,
  durableReconciliationTimeoutMs,
  durablePumpReuseNeedsAlarmKick,
  durableScanJobAdmissionProofMatches,
  finalizeDurableScanJobAdmission,
  throwIfDurableScanJobAdmissionAborted,
  withDurableScanJobAdmissionDeadline
} from "./durable-scan-job-edge-wiring";

const JOB_ID = `20260718-${"c".repeat(32)}`;
const REPORT_ID = `20260718-${"d".repeat(32)}`;
const PREPARATION: DurableScanJobPreparation = {
  submission: {
    ok: true,
    jobId: JOB_ID,
    status: "queued",
    statusPath: `/api/scans/${JOB_ID}`,
    reportId: REPORT_ID
  },
  payload: {
    version: 1,
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: false,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1,
    admittedAt: 1_752_880_000_000,
    reportMode: "r2",
    alreadyCharged: true
  }
};

test("durable store or scheduling failure can never produce a public 202", async () => {
  const seen: unknown[] = [];
  const outcome = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      throw new Error("sqlite details must stay private");
    },
    (error) => seen.push(error)
  );
  assert.deepEqual(outcome, { accepted: false, status: 503 });
  assert.equal("submission" in outcome, false);
  assert.equal(seen.length, 1);
});

test("a definitive durable quota refusal is terminal and never retried as admission", async () => {
  class QuotaRefusal extends Error {}
  let commits = 0;
  let readbacks = 0;
  const seen: unknown[] = [];

  const outcome = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      commits += 1;
      throw new QuotaRefusal("quota exhausted");
    },
    (error) => seen.push(error),
    async () => {
      readbacks += 1;
      return false;
    },
    (error) => error instanceof QuotaRefusal
  );

  assert.deepEqual(outcome, { accepted: false, status: 503 });
  assert.equal(commits, 1);
  assert.equal(readbacks, 0);
  assert.equal(seen.length, 1);
});

test("a plain first-attempt DO refusal is terminal without speculative readback or retry", async () => {
  class AdmissionRefusal extends Error {}
  let commits = 0;
  let readbacks = 0;

  const outcome = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      commits += 1;
      throw new AdmissionRefusal("capacity refused");
    },
    undefined,
    async () => {
      readbacks += 1;
      return false;
    },
    (error, attempt) => error instanceof AdmissionRefusal && attempt === 1
  );

  assert.deepEqual(outcome, { accepted: false, status: 503 });
  assert.equal(commits, 1);
  assert.equal(readbacks, 0);
});

test("durable acceptance awaits the commit before exposing the submission", async () => {
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const pending = finalizeDurableScanJobAdmission(PREPARATION, () => blocked).then((outcome) => {
    settled = true;
    return outcome;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.deepEqual(await pending, { accepted: true, status: 202, submission: PREPARATION.submission });
});

test("a preparation released after the whole-operation deadline can never reach admission", async () => {
  let releasePreparation: () => void = () => undefined;
  const stalledPreparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let admissions = 0;

  const operation = withDurableScanJobAdmissionDeadline(
    async (signal) => {
      await awaitDurableScanJobAdmissionStep(() => stalledPreparation, signal);
      throwIfDurableScanJobAdmissionAborted(signal);
      admissions += 1;
      return PREPARATION.submission;
    },
    { timeoutMs: 10 }
  );

  await assert.rejects(operation, DurableScanJobAdmissionTimeoutError);
  releasePreparation();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admissions, 0, "late preparation settlement must have no commit continuation");
});

test("signal-aware finalization never retries or reads back after abort", async () => {
  const controller = new AbortController();
  let commits = 0;
  let readbacks = 0;
  let markCommitStarted: () => void = () => undefined;
  const commitStarted = new Promise<void>((resolve) => {
    markCommitStarted = resolve;
  });
  const pending = finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      commits += 1;
      markCommitStarted();
      await new Promise<void>(() => undefined);
    },
    undefined,
    async () => {
      readbacks += 1;
      return false;
    },
    undefined,
    undefined,
    { signal: controller.signal }
  );
  await commitStarted;
  controller.abort(new DOMException("admission cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
  assert.equal(commits, 1);
  assert.equal(readbacks, 0);
});

test("an outcome-unknown admission recovers only from an exact authoritative readback", async () => {
  const exact = {
    jobId: PREPARATION.submission.jobId,
    reportId: PREPARATION.submission.reportId,
    createdAt: PREPARATION.payload.admittedAt,
    totalRuns: 1 as const
  };
  assert.equal(durableScanJobAdmissionProofMatches(exact, PREPARATION), true);
  assert.equal(durableScanJobAdmissionProofMatches({ ...exact, reportId: JOB_ID }, PREPARATION), false);

  const recovered = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      throw new Error("RPC response was lost after commit");
    },
    undefined,
    async (preparation) => durableScanJobAdmissionProofMatches(exact, preparation)
  );
  assert.deepEqual(recovered, { accepted: true, status: 202, submission: PREPARATION.submission });

  const refused = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      throw new Error("schedule failed before commit");
    },
    undefined,
    async () => false
  );
  assert.deepEqual(refused, { accepted: false, status: 503 });
});

test("admission retries once when both the commit response and first exact readback are lost", async () => {
  class DuplicateRefusal extends Error {}
  let commits = 0;
  let readbacks = 0;
  let quotaCharges = 0;
  let committed = false;
  const recovered = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      commits += 1;
      if (!committed) {
        committed = true;
        quotaCharges += 1;
      }
      if (commits === 1) throw new Error("commit response lost");
      throw new DuplicateRefusal("duplicate refused");
    },
    undefined,
    async () => {
      readbacks += 1;
      if (readbacks === 1) throw new Error("transient readback reset");
      return true;
    },
    (error, attempt) => error instanceof DuplicateRefusal && attempt === 1
  );
  assert.deepEqual(recovered, { accepted: true, status: 202, submission: PREPARATION.submission });
  assert.equal(commits, 2);
  assert.equal(readbacks, 2);
  assert.equal(quotaCharges, 1, "an idempotent duplicate admission must not consume quota again");
});

test("publishing backoff never delays an independent due lease, deadline, or purge", () => {
  assert.equal(
    chooseDurableScanJobPumpWakeAt({
      storeWakeAt: 9_000,
      publishingWakeAt: 15_000
    }),
    9_000
  );
  assert.equal(
    chooseDurableScanJobPumpWakeAt({
      storeWakeAt: 9_000,
      publishingWakeAt: 15_000
    }),
    9_000
  );
});

test("the pump wake selector retains the earliest future maintenance event", () => {
  assert.equal(
    chooseDurableScanJobPumpWakeAt({
      storeWakeAt: 18_000,
      publishingWakeAt: 15_000,
      minimumWakeAt: 14_000
    }),
    14_000
  );
  assert.equal(
    chooseDurableScanJobPumpWakeAt({
      storeWakeAt: null,
      publishingWakeAt: null,
      minimumWakeAt: 14_000
    }),
    14_000
  );
  assert.equal(
    chooseDurableScanJobPumpWakeAt({ storeWakeAt: 60_000, publishingWakeAt: 15_000 }),
    15_000,
    "a future matching-generation publishing backoff is honored without the stale settlement wake"
  );
});

test("reconciliation timeouts are capped by the immutable purge horizon", () => {
  assert.equal(durableReconciliationTimeoutMs(10_000, 10_000), 0);
  assert.equal(durableReconciliationTimeoutMs(10_000, 10_001), 1);
  assert.equal(durableReconciliationTimeoutMs(10_000, 39_999), 29_999);
  assert.equal(durableReconciliationTimeoutMs(10_000, 40_001), 30_000);
});

test("the Worker-only encryption key cannot alias the Node internal token", () => {
  assert.equal(durableScanJobSecretsAreDistinct("worker-key", "node-token"), true);
  assert.equal(durableScanJobSecretsAreDistinct("same-secret", "same-secret"), false);
  assert.equal(durableScanJobSecretsAreDistinct(" same-secret ", "same-secret"), false);
  assert.equal(
    durableScanJobKeyIsIsolated("worker-key", ["node-token", "scan-access", "turnstile", "r2-id", "r2-secret"]),
    true
  );
  for (let index = 0; index < 5; index += 1) {
    const forwarded = ["internal", "scan-access", "turnstile", "r2-id", "r2-secret"];
    forwarded[index] = "worker-key";
    assert.equal(durableScanJobKeyIsIsolated("worker-key", forwarded), false);
  }
  assert.equal(durableScanJobKeyIsIsolated("internal-token", ["internal-token", "r2-secret"]), false);
});

test("a synthetic-monitor credential cannot be reused as a durable key", () => {
  const monitor = "synthetic-monitor-credential";
  assert.equal(durableScanJobKeyIsIsolated(monitor, ["other", monitor]), false);
  assert.equal(durableScanJobKeyIsIsolated(` ${monitor} `, [monitor]), false);
});

test("durable mode accepts only exact feature-flag wires", () => {
  assert.equal(durableScanJobsFlagState(undefined), "disabled");
  assert.equal(durableScanJobsFlagState(""), "disabled");
  assert.equal(durableScanJobsFlagState("0"), "disabled");
  assert.equal(durableScanJobsFlagState("1"), "enabled");
  assert.equal(durableScanJobsFlagState(" 1 "), "misconfigured");
  assert.equal(durableScanJobsFlagState("true"), "misconfigured");
});

test("edge health detects durable rollout skew from the Node health wire", () => {
  assert.deepEqual(durableScanJobNodeHealthState(undefined), { requested: false, ready: false });
  assert.deepEqual(
    durableScanJobNodeHealthState({ durableJobs: { requested: false, enabled: false, readiness: "disabled" } }),
    { requested: false, ready: false }
  );
  assert.deepEqual(
    durableScanJobNodeHealthState({ durableJobs: { requested: true, enabled: true, readiness: "node-ready" } }),
    { requested: true, ready: true }
  );
  assert.deepEqual(
    durableScanJobNodeHealthState({ durableJobs: { requested: true, enabled: false, readiness: "misconfigured" } }),
    { requested: true, ready: false }
  );
});

test("due driver reuse kicks the existing alarm instead of postponing it", () => {
  const scheduledSecond = 10;
  let baseScheduleCalls = 0;
  let immediateKicks = 0;
  for (const now of [10_050, 10_300, 10_550, 10_800, 11_050]) {
    if (durablePumpReuseNeedsAlarmKick(scheduledSecond, now)) immediateKicks += 1;
    else baseScheduleCalls += 1;
  }
  assert.equal(baseScheduleCalls, 0);
  assert.equal(immediateKicks, 5);
});

test("Worker wiring preserves Phase 1 while closing durable private boundaries", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  assert.match(source, /ctx\.waitUntil\(\s*recordAcceptedScanJob\(/);
  assert.match(
    source,
    /submitDurableScanJob\(\s*forwarded,\s*env,\s*replayFaultMode,\s*deferredRateLimit,\s*scanAdmissionKey,\s*signal,\s*commitNotAfter\s*\)/
  );
  assert.match(source, /isScan &&\s*\(\s*durableScanJobsFlagMisconfigured\(env\)/);
  assert.match(source, /await finalizeDurableScanJobAdmission\(/);
  assert.match(source, /awaitDurableScanJobAdmissionStep/);
  assert.match(
    source,
    /new Request\(prepareUrl,[\s\S]*body: request\.body,[\s\S]*signal[\s\S]*readDurableScanJobInternalResponseBytes\(preparedResponse, signal\)/
  );
  assert.match(source, /admitDurablePreparation\([\s\S]*scanAdmissionKey,[\s\S]*commitNotAfter/);
  assert.match(source, /assertDurableAdmissionCommitActive\(commitNotAfter, now\)/);
  assert.match(source, /isDurableScanJobNodePrivatePath\(url\.pathname\)/);
  assert.match(source, /stripDurableScanJobInternalHeaders\(request\.headers\)/);
  assert.match(
    source,
    /function scanForwardHeaders[\s\S]*headers\.delete\(DURABLE_REPLAY_FAULT_MODE_HEADER\)[\s\S]*headers\.delete\(DURABLE_REPLAY_FAULT_TOKEN_HEADER\)/
  );
  assert.match(source, /timeoutMs = 60_000/);
  assert.match(source, /durablePumpRequestSignal\(signal, timeoutMs\)/);
  assert.match(source, /DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS/);
  assert.match(source, /earliestDurableScanJobPurgeAt\(this\.ctx\.storage\.sql\)/);
  assert.match(source, /durableReconciliationTimeoutMs\([\s\S]*Math\.min\(snapshot\.purgeAt, storePurgeAt/);
  assert.match(source, /if \(reconciliationTimeoutMs <= 0\)[\s\S]*purgeDurableScanJobState/);
  assert.match(source, /schedule\(1, DURABLE_SCAN_JOB_PUMP_CALLBACK\)/);
  assert.match(source, /preflightDurableScanJobAdmission\(this\.ctx\.storage\.sql, admission\)/);
  assert.match(source, /ensureImmediateDurablePumpWake/);
  assert.match(source, /prepareUrl\.pathname = `\$\{DURABLE_SCAN_JOB_NODE_PATH_PREFIX\}\/prepare`/);
  assert.match(source, /Object\.entries\(\s*scanCorsHeaders\(request\.headers\.get\("origin"\)/);
  assert.match(source, /attempt === 1 \? 5_000 : attempt === 2 \? 15_000 : 60_000/);
  assert.match(source, /Math\.min\(now \+ delay, snapshot\.deadlineAt\)/);
  assert.match(source, /finally \{[\s\S]*await this\.rearmDurablePumpAfterCallback\(\)/);
  assert.match(source, /Could not re-arm the durable scan-job pump; retrying once/);
  assert.match(
    source,
    /rearmDurablePumpAfterCallback[\s\S]*await this\.ensureDurablePumpFallbackSchedule\(\)/
  );
  assert.match(source, /parkDisabledDurablePumpWithRetry/);
  assert.match(source, /Could not park the durable scan-job pump; retrying once/);
  assert.match(source, /ensureDurablePumpFallbackSchedule/);
  assert.match(source, /INSERT INTO container_schedules \(id, callback, payload, type, time\)/);
  const pump = sliceBetween(source, "async pumpDurableScanJobs", "private async activateDurableClaim", "source");
  assert.match(pump, /runDurableScanJobPumpTurn/);
  assert.match(pump, /persistImmediateSuccessor: \(\) => this\.ensureDurablePumpFallbackSchedule\(\)/);
  assert.ok(
    requireIndex(pump, "processExpiredCoreItem", "pump") < requireIndex(pump, "dispatchCore: (context)", "pump"),
    "bounded lease/publication recovery must precede ordinary dispatch"
  );
  assert.ok(
    requireIndex(pump, "dispatchCore: (context)", "pump") < requireIndex(pump, "listOptionalItems: (context)", "pump"),
    "optional watch work must never head-of-line block ordinary dispatch"
  );
  assert.match(source, /callback-entry prearm is already a durable immediate recovery driver/);
  assert.match(source, /context\.remainingTimeMs/);
  assert.match(source, /durablePumpRequestSignal\(signal, timeoutMs\)/);
  assert.match(source, /if \(signal\?\.aborted\) throw durablePumpAbortReason\(signal\)/);
  assert.match(source, /readDurableScanJobInternalResponseBytes\(response, signal\)/);
  assert.match(source, /readDurableScanJobInternalResponseJson\(response, signal\)/);
  assert.doesNotMatch(source, /preparedResponse\.arrayBuffer\(\)|response\.json\(\)/);
  assert.match(source, /rearmDurablePumpAfterCommittedMutation\("publication fence"\)/);
  assert.match(source, /Promise\.resolve\(\)[\s\S]*privateContainerRequest/);
  assert.match(source, /scheduledTaskId/);
  assert.match(source, /SELECT id FROM container_schedules WHERE id = \? AND callback = \?/);
  assert.match(source, /DELETE FROM container_schedules WHERE callback = \? AND payload IS NOT NULL AND id <> \?/);
  assert.match(source, /if \(reusable\) \{/);
  assert.match(source, /await this\.prearmDurablePumpSuccessor\(schedule\?\.taskId\)/);
  assert.match(source, /The durable pump successor alarm write failed; adopting its persisted row/);
  assert.match(source, /Could not create the epoch-owned durable pump successor; using raw fallback/);
  assert.match(source, /persistImmediateDurablePumpFallbackSchedule\(\)/);
  assert.match(source, /Track the payload-free fallback like the normal temporary epoch row/);
  assert.match(source, /schedules\.id <> \?/);
  assert.match(source, /persistParkedDurablePumpSchedule/);
  assert.match(source, /DELETE FROM container_schedules WHERE callback = \? AND id <> \?/);
  assert.match(
    source,
    /private purgeDurableScanJobState[\s\S]*settleSynchronizeAndPurgeDurableScanJobs[\s\S]*pruneDurableReconciliationBackoff/
  );
  assert.match(source, /completedAt >= snapshot\.purgeAt/);
  assert.ok(
    requireIndex(pump, "await this.prearmDurablePumpSuccessor(schedule?.taskId)", "pump") < requireIndex(pump, "await this.durableEncryptionKey()", "pump"),
    "the invoking row must remain covered by a successor before key import yields"
  );
  assert.doesNotMatch(source, /\n\s*(?:async\s+)?alarm\s*\(/);
  // A poll runs every few seconds for the life of a job, so the charge and the
  // read share ONE RPC. The ordering they were split for is unchanged: nothing
  // reaches the Durable Object unauthenticated, the budget is committed before
  // the lookup, and a refused caller is never told whether the id exists.
  assert.ok(
    requireIndex(source, "refuseUnauthorizedDurableScanJobControl(request, env)", "source") < requireIndex(source, "chargeAndFindDurableJob({", "source"),
    "authorization must precede any Durable Object RPC"
  );
  const polledJob = sliceBetween(source, "chargeAndFindDurableJob(input: {", "findStagingDurableReplayFault(jobId: string)", "source");
  assert.ok(polledJob.length > 0, "the combined poll RPC could not be located");
  assert.ok(
    requireIndex(polledJob, "chargeDurableJobReadRateLimit", "polledJob") < requireIndex(polledJob, "findDurableJob(input.jobId)", "polledJob"),
    "the read budget must be charged before the lookup"
  );
  assert.match(polledJob, /if \(!charge\.allowed\) return \{ charge, snapshot: null \}/);
  const jobRouting = sliceBetween(source, "if (scanJobId)", "const reportRead = parsePublicReportReadPath(", "source");
  assert.match(jobRouting, /handleDurableScanJobRequest\(request, env, scanJobId\)/);
  assert.doesNotMatch(jobRouting, /if \(durableScanJobsEnabled\(env\)\)/);
  assert.match(source, /before\?\.state === "queued" && before\.leaseGeneration > 0/);
  assert.match(
    source,
    /triggerStagingLeaseExpiryFault\(\{[\s\S]*jobId: claim\.jobId,[\s\S]*generation: claim\.leaseGeneration,[\s\S]*leaseToken: claim\.leaseToken/
  );
  assert.match(source, /dropStagingLostResolveFault\(owner\)/);
  assert.match(source, /dropLostResolveDurableReplayFault\(this\.ctx\.storage\.sql/);
  assert.match(source, /armDurableReplayFault\(this\.ctx\.storage\.sql/);
  assert.match(source, /findStagingDurableReplayFault\(jobId\)/);
});

test("durable quota is deferred into admission while Phase 1 keeps immediate edge charging", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const fetchHandler = sliceBetween(source, "export default", "type DurableScanJobConfig", "source");
  const gate = sliceBetween(source, "async function gateScanRequest", "function parseScanGatePayload", "source");
  const submit = sliceBetween(source, "async function submitDurableScanJob", "async function handleDurableScanJobRequest", "source");

  assert.match(
    fetchHandler,
    /if \(durableAdmission\)[\s\S]*withDurableScanJobAdmissionDeadline[\s\S]*readRequestBodyWithinLimit\(request, MAX_BODY_BYTES,[\s\S]*gateScanRequest\(request, body, env, "authorize", undefined, signal\)[\s\S]*"defer",[\s\S]*signal[\s\S]*submitDurableScanJob/
  );
  assert.match(
    fetchHandler,
    /await gateScanRequest\(request, body, env, "charge", undefined, request\.signal\)/
  );
  assert.match(fetchHandler, /if \(durableAdmission\)[\s\S]*submitDurableScanJob\([\s\S]*deferredRateLimit/);
  assert.match(fetchHandler, /const response = await forwardToContainer\(forwarded, env\)/);
  assert.match(gate, /if \(chargeMode === "charge"\) return null/);
  assert.match(
    gate,
    /scope: "authenticated",[\s\S]*cost,[\s\S]*perMinute: AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE,[\s\S]*perDay: null/
  );
  assert.match(
    gate,
    /scope: "public"[\s\S]*if \(chargeMode === "defer"\) \{[\s\S]*await assertDeferredScanRateLimitAvailable\(rateLimit, env\);[\s\S]*return rateLimit/
  );
  assert.ok(
    requireIndex(gate, "await assertDeferredScanRateLimitAvailable(rateLimit, env)", "gate") < requireIndex(gate, "chargePublicScanRateLimit(rateLimit)", "gate"),
    "durable mode must preflight quota without consuming it before the Phase-1 charge"
  );
  assert.match(
    gate,
    /scope: "authenticated"[\s\S]*await assertDeferredScanRateLimitAvailable\(rateLimit, env\);[\s\S]*return rateLimit/
  );
  assert.ok(
    requireIndex(fetchHandler, "deferredRateLimit = await gateScanRequest", "fetchHandler") < requireIndex(fetchHandler, "submitDurableScanJob(", "fetchHandler"),
    "the non-consuming DO quota check must finish before Node preparation starts"
  );
  assert.match(
    gate,
    /async function assertDeferredScanRateLimitAvailable[\s\S]*try \{[\s\S]*peekPublicScanRateLimit\(rateLimit\)[\s\S]*catch \(error\)[\s\S]*Could not preflight durable scan-job quota[\s\S]*Durable scan jobs are temporarily unavailable\.[\s\S]*503/
  );
  assert.doesNotMatch(
    gate,
    /catch \(error\)[\s\S]*throw error/,
    "DO quota preflight failures must never expose raw storage or RPC errors"
  );
  assert.match(submit, /result\.status === "rate-limited"/);
  assert.match(submit, /error instanceof DurableScanJobRateLimitError/);
  assert.match(submit, /return gateErrorResponse\(admissionError, request, env\)/);
});

test("public scan-admission recovery charges its dedicated limiter before capability lookup", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const containerMethod = sliceBetween(source, "recoverCommittedScanAdmission(input:", "async admitEncryptedWatchPreparation(", "source");
  const publicRecovery = sliceBetween(source, "async function recoverCommittedScanAdmission(request:", "async function authorizeScanAdmissionRecovery(", "source");
  assert.match(containerMethod, /transactionSync\([\s\S]*findScanAdmissionRateLimited\(/);
  assert.match(publicRecovery, /recoverCommittedScanAdmission\(\{[\s\S]*clientHash: await publicClientHash/);
  assert.match(publicRecovery, /result\.status === "rate-limited"[\s\S]*429/);
  assert.doesNotMatch(publicRecovery, /\.findCommittedScanAdmission\(/);
});

test("active scan, watch, and private coordinator body reads are finite and caller-cancellable", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const fetchHandler = sliceBetween(source, "export default", "type DurableScanJobConfig", "source");
  const watchCreation = sliceBetween(source, "async function handleEncryptedWatchCreationWithinDeadline(", "function encryptedWatchAdmissionProofMatches(", "source");
  const coordinator = sliceBetween(source, "async function handleDurableScanJobCoordinatorRequest(", "function durableCoordinatorOwner(", "source");

  for (const section of [fetchHandler, watchCreation, coordinator]) {
    assert.match(
      section,
      /readRequestBodyWithinLimit\([\s\S]*signal(?:: request\.signal)?,[\s\S]*timeoutMs: REQUEST_BODY_OPERATION_TIMEOUT_MS/
    );
  }
  assert.match(coordinator, /status === 408 \|\| status === 499/);
});

test("authoritative and Phase-1 report recovery thread the bounded fetch signal to the container", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const authoritative = sliceBetween(source, "return recoverDurableScanJobSnapshotResponse(", "async function refuseUnauthorizedDurableScanJobControl(", "source");
  const phaseOne = sliceBetween(source, "async function recoverRegisteredScanJob(", "function scanForwardHeaders(", "source");
  for (const section of [authoritative, phaseOne]) {
    assert.match(section, /fetchReport: \(reportId, signal\)/);
    assert.match(section, /new Request\(reportUrl, \{ method: "GET", headers, signal \}\)/);
    assert.match(section, /signal: request\.signal/);
  }
  assert.match(phaseOne, /findRegistration = \(id: string, signal\?: AbortSignal\)/);
  assert.match(phaseOne, /signal\?\.throwIfAborted\(\)/);
});

test("Durable Object RPC mutations own time and return plain conflict envelopes", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const container = sliceBetween(source, "export class ScannerContainer", "export default", "source");
  const coordinator = sliceBetween(source, "async function handleDurableScanJobCoordinatorRequest", "function durableCoordinatorOwner", "source");
  const publicControl = sliceBetween(source, "async function handleDurableScanJobRequest", "async function refuseUnauthorizedDurableScanJobControl(", "source");

  assert.match(source, /type DurableScanJobMutationResult\s*=\s*\| \{ status: "success" \}\s*\| \{ status: "conflict" \}/);
  assert.match(
    source,
    /type DurableScanJobAdmissionResult\s*=\s*\| \{[\s\S]*?status: "success";[\s\S]*?admission: ScanAdmissionSnapshot;[\s\S]*?snapshot: DurableScanJobSnapshot \| null;[\s\S]*?recovered: boolean;[\s\S]*?\}\s*\| \{ status: "rate-limited"; retryAfterSeconds: number \}\s*\| \{ status: "conflict" \}\s*\| \{ status: "expired" \}\s*\| \{ status: "refused" \}/
  );
  assert.match(
    source,
    /type DurableScanJobCancellationResult\s*=\s*\| \{[\s\S]*status: "success";[\s\S]*snapshot: DurableScanJobSnapshot;[\s\S]*\| \{ status: "conflict"; publishing: boolean \}/
  );
  assert.match(container, /async cancelDurableJob\(jobId: string\): Promise<DurableScanJobCancellationResult>/);
  assert.match(
    container,
    /async heartbeatDurableJob\(\s*owner: DurableScanJobExecutionOwner,\s*completedRuns: number\s*\): Promise<DurableScanJobMutationResult>/
  );
  // The renewal's run count is untrusted wire input from the lease holder, so
  // the edge must bound it before the Durable Object records it. The clock stays
  // the DO's own, which the Date.now() refusal below still enforces.
  assert.match(
    source,
    /const completedRuns = durableHeartbeatCompletedRuns\(body\);\s*\n\s*if \(completedRuns === null\) return privateControlResponse\(400\);/
  );
  assert.match(container, /findDurableJob\(jobId: string\): DurableScanJobSnapshot \| null/);
  assert.match(container, /findRegisteredScanJob\(jobId: string\): DurableScanJobRegistration \| null/);
  assert.match(container, /chargeDurableJobReadRateLimit\(input: \{ clientHash: string \}\)/);
  assert.match(container, /peekPublicScanRateLimit\(input: PublicScanRateLimitCharge\)/);

  for (const method of ["heartbeatDurableJob", "beginPublishingDurableJob", "resolveDurableJob"] as const) {
    const start = container.indexOf(`async ${method}`);
    assert.ok(start >= 0, `the container no longer declares async ${method}`);
    const next = container.indexOf("\n  async ", start + 1);
    const body = container.slice(start, next === -1 ? undefined : next);
    assert.ok(start >= 0, `${method} must remain a Durable Object RPC`);
    assert.match(body, /const tokenHash = await hashDurableScanJobLeaseToken/);
    assert.ok(
      requireIndex(body, "const tokenHash = await hashDurableScanJobLeaseToken", "body") < requireIndex(body, "const now = Date.now()", "body"),
      `${method} must sample authoritative time after hashing`
    );
    assert.ok(
      requireIndex(body, "const now = Date.now()", "body") < requireIndex(body, "this.ctx.storage.transactionSync", "body"),
      `${method} must sample authoritative time immediately before its transaction`
    );
    assert.match(body, /instanceof DurableScanJobStateError\) return \{ status: "conflict" \}/);
    assert.match(body, /return \{ status: "success" \}/);
  }

  const cancellation = sliceBetween(container, "async cancelDurableJob", "async heartbeatDurableJob", "container");
  assert.ok(requireIndex(cancellation, "const now = Date.now()", "cancellation") < requireIndex(cancellation, "this.ctx.storage.transactionSync", "cancellation"));
  assert.match(
    cancellation,
    /return \{ status: "conflict", publishing: error\.currentState === "publishing" \}/
  );
  assert.match(cancellation, /status: "success" as const/);

  assert.doesNotMatch(
    source,
    /\.(?:heartbeatDurableJob|beginPublishingDurableJob|resolveDurableJob|cancelDurableJob|findDurableJob|findRegisteredScanJob)\([^;\n]*Date\.now\(\)/
  );
  assert.doesNotMatch(source, /charge(?:PublicScanRateLimit|DurableJobReadRateLimit)\(\{[\s\S]{0,500}?now: Date\.now\(\)/);
  assert.match(container, /createdAt: preparation\.payload\.admittedAt/);
  const admission = container.slice(
    requireIndex(container, "async admitDurablePreparation", "container"),
    container.indexOf("findDurableJob", requireIndex(container, "async admitDurablePreparation", "container"))
  );
  assert.ok(
    requireIndex(admission, "publicScanRateLimitChargeMatchesCost", "admission") < requireIndex(admission, "createDurableScanJobAdmission", "admission"),
    "cost drift must fail before encryption, scheduling, quota, or row mutation"
  );
  assert.match(admission, /instanceof DurableScanJobCapacityError \|\| error instanceof DurableScanJobStateError/);
  assert.match(admission, /return \{ status: "refused" \}/);
  assert.match(admission, /peekPublicScanRateLimitInStore\(this\.ctx\.storage\.sql, rateLimit, now\)/);
  assert.match(admission, /commitIdempotentScanAdmission\(/);
  assert.ok(
    requireIndex(admission, "await this.ensureImmediateDurablePumpWake()", "admission") < requireIndex(admission, "commitIdempotentScanAdmission", "admission"),
    "durable quota must not be consumed before the admission wake is durable"
  );
  assert.ok(
    requireIndex(admission, "commitIdempotentScanAdmission", "admission") < requireIndex(admission, "admitDurableScanJob(this.ctx.storage.sql, admission)", "admission"),
    "idempotency, quota, and row admission must execute in one final transaction"
  );
  const finalAdmissionTransaction = admission.slice(
    admission.lastIndexOf("this.ctx.storage.transactionSync"),
    admission.indexOf("} catch (error)", admission.lastIndexOf("this.ctx.storage.transactionSync"))
  );
  assert.match(finalAdmissionTransaction, /commitIdempotentScanAdmission/);
  assert.match(finalAdmissionTransaction, /admitDurableScanJob/);
  assert.match(finalAdmissionTransaction, /armDurableReplayFault/);
  assert.match(
    finalAdmissionTransaction,
    /commitIdempotentScanAdmission\([\s\S]*armDurableReplayFault[\s\S]*\(\) => assertDurableAdmissionCommitActive\(commitNotAfter\)/
  );
  assert.match(source, /result\.status === "refused"[\s\S]*throw new DurableScanJobRefusedError/);
  assert.match(source, /!durableScanJobAdmissionProofMatches\(result\.snapshot, value\)/);
  assert.match(
    source,
    /\(error, attempt\) =>[\s\S]*error instanceof DurableScanJobRateLimitError[\s\S]*attempt === 1 && error instanceof DurableScanJobRefusedError/
  );

  assert.match(coordinator, /result\.status === "conflict"\) return privateControlResponse\(409\)/);
  assert.doesNotMatch(coordinator, /instanceof DurableScanJobStateError/);
  assert.match(publicControl, /cancelled\.status === "conflict"\) return publicJobConflictResponse/);
  assert.doesNotMatch(publicControl, /instanceof DurableScanJobStateError/);
});

test("a publishing durable job is refused as still saving, not as finished", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const container = sliceBetween(source, "export class ScannerContainer", "export default", "source");

  // The store distinguishes "already publishing" from the terminal states, so
  // the RPC envelope has to carry that state instead of collapsing both into a
  // reasonless conflict.
  const cancellation = sliceBetween(container, "async cancelDurableJob", "async heartbeatDurableJob", "container");
  assert.match(
    cancellation,
    /return \{ status: "conflict", publishing: error\.currentState === "publishing" \}/
  );

  // The publishing flag must come from the transition that just failed, never
  // from the status snapshot read before it.
  const publicControl = sliceBetween(source, "async function handleDurableScanJobRequest", "async function refuseUnauthorizedDurableScanJobControl(", "source");
  assert.match(publicControl, /publicJobConflictResponse\(request, env, cancelled\.publishing\)/);

  const conflict = sliceBetween(source, "function publicJobConflictResponse(", "async function recoverRegisteredScanJob(", "source");
  assert.match(conflict, /publicJobConflictResponse\(request: Request, env: Env, publishing: boolean\)/);
  assert.match(
    conflict,
    /publishing\s*\n?\s*\?\s*"This scan report is already being saved and can no longer be cancelled\."\s*\n?\s*:\s*"This scan job has already finished and cannot be cancelled\."/
  );
});

test("durable preparation is isolated from the public Phase-1 scan route", async () => {
  const publicRoute = await readFile(path.join(process.cwd(), "app/api/scan/route.ts"), "utf8");
  const privateRoute = await readFile(
    path.join(process.cwd(), "app/api/internal/durable-scans/prepare/route.ts"),
    "utf8"
  );
  assert.doesNotMatch(publicRoute, /prepareDurableScanJobRequest|DURABLE_SCAN_JOB_PREPARED_HEADER/);
  assert.match(publicRoute, /if \(durableScanJobsEnabled\(\)\)/);
  assert.ok(
    requireIndex(publicRoute, "if (durableScanJobsEnabled())", "publicRoute") < requireIndex(publicRoute, "submitScanJobRequest(request)", "publicRoute"),
    "public durable mode must refuse before Phase-1 enqueue"
  );
  assert.match(privateRoute, /assertDurableScanJobInternalRequest\(request\)/);
  assert.match(privateRoute, /prepareDurableScanJobRequest\(request\)/);
  assert.match(privateRoute, /DURABLE_SCAN_JOB_PREPARED_HEADER/);
  assert.doesNotMatch(privateRoute, /submitScanJobRequest|runScanRequest|enqueuePreparedScanJob/);
});

test("Worker health performs the edge key upgrade and fail-closed downgrade", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  assert.match(source, /await durableJobsEdgeHealthCheck\(health\.checks, env\)/);
  assert.match(source, /await importDurableScanJobEncryptionKey\(config\.encryptionKey\)/);
  assert.match(source, /durableScanJobSecretsAreDistinct\(encryptionKey, internalToken\)/);
  const durableConfig = sliceBetween(source, "function requireDurableScanJobConfig", "function requireDurableContainerShardingPlan", "source");
  assert.equal(
    (durableConfig.match(/SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/g) ?? []).length,
    2,
    "both the durable encryption key and coordinator token must reject synthetic-monitor reuse"
  );
  assert.match(source, /health\.scansAvailable = false/);
  assert.match(source, /readiness: "misconfigured"/);
  assert.match(source, /enabled in the Node scanner but disabled at the edge/);
  assert.doesNotMatch(
    source,
    /SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY:\s*this\.env\.SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY/
  );
  assert.match(source, /coordinator\.hostname === "\[::1\]"/);
  assert.match(source, /coordinatorOrigin: coordinatorOrigin!/);
  assert.match(source, /faultInjection:/);
  assert.match(source, /attemptEvidence: true as const/);
  assert.match(source, /completionBeforeStatusRequestEvidence: true as const/);
  assert.match(source, /wholeOriginAccessGate: true as const/);
  assert.match(source, /durableReplayFaultConfig\(env as Env\)/);
  const fetchHandler = sliceBetween(source, "export default", "type DurableScanJobConfig", "source");
  assert.ok(
    requireIndex(fetchHandler, "durableReplayFaultIngressIntent(env)", "fetchHandler") <
      requireIndex(fetchHandler, 'url.pathname === "/api/health"', "fetchHandler"),
    "the staging whole-origin token gate must run before health can touch the container"
  );
  assert.match(
    fetchHandler,
    /durableReplayFaultIngressIntent\(env\)[\s\S]*durableReplayFaultConfig\(env\)\.status !== "ready"[\s\S]*scanAccessTokenMatches\(request\.headers, expectedToken\)/
  );
  const healthCheck = sliceBetween(source, "export async function durableJobsEdgeHealthCheck", "async function gateScanRequest", "source");
  assert.ok(
    requireIndex(healthCheck, "const replayFault = durableReplayFaultConfig", "healthCheck") <
      requireIndex(healthCheck, 'if (flag === "disabled")', "healthCheck"),
    "health must evaluate replay-fault misconfiguration before the disabled early return"
  );
  assert.match(healthCheck, /if \(replayFault\.status === "misconfigured"\) reasons\.push/);

  const forwarder = sliceBetween(source, "function forwardToContainer", "function frontDoorOrigin", "source");
  assert.match(forwarder, /headers\.delete\(DURABLE_REPLAY_FAULT_MODE_HEADER\)/);
  assert.match(forwarder, /headers\.delete\(DURABLE_REPLAY_FAULT_TOKEN_HEADER\)/);

  // `private durableEncryptionKey` also appears before the purge method, so
  // this end marker must be the first one AFTER the start, not the first in
  // the file.
  const purgeStart = requireIndex(source, "private purgeDurableScanJobState");
  const purgeEnd = source.indexOf("private durableEncryptionKey", purgeStart);
  assert.ok(purgeEnd > purgeStart, "no method declaration follows purgeDurableScanJobState; update the end marker");
  const purge = source.slice(purgeStart, purgeEnd);
  assert.match(purge, /purgeDurableReplayFaults\(this\.ctx\.storage\.sql, now\)/);
});

test("every consumer resolves the durable encryption key the same way", async () => {
  // The edge validator trimmed the key while the Durable Object imported the
  // raw env var. A key with a trailing newline -- the ordinary result of
  // pasting into a `wrangler secret put` prompt -- therefore passed
  // requireDurableScanJobConfig, passed the pre-admission import, and passed
  // the edge health probe, so checks.durableJobs.readiness reported "ready"
  // and production-health asserted that same field green, while every
  // admission failed inside the DO with a generic 503 and one log line.
  //
  // Pin the single resolution rather than the trimming: any second reader of
  // the raw env var can reintroduce the split.
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");

  assert.match(
    source,
    /function durableScanJobEncryptionKeyValue\(env: Env\): string \{\s*return env\[DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV\]\?\.trim\(\) \?\? "";\s*\}/,
    "the key must be resolved by one named helper"
  );

  // The real invariant: nothing may be IMPORTED as a key except the resolved
  // value. A raw env read still appears in the restart route's
  // secretCollisionCandidates list, and belongs there -- that check compares
  // stored secrets for reuse, so it wants the bytes as configured, not a
  // normalized copy.
  const imports = [...source.matchAll(/importDurableScanJobEncryptionKey\(\s*([A-Za-z0-9_.]+(?:\([^)]*\))?)\s*\)/g)];
  assert.ok(imports.length >= 2, "expected the key import to have consumers to check");
  for (const [, argument] of imports) {
    assert.match(
      argument,
      /^(?:config\.encryptionKey|durableScanJobEncryptionKeyValue\(this\.env\))$/,
      `importDurableScanJobEncryptionKey received ${JSON.stringify(argument)}; it must receive the resolved key`
    );
  }

  // And both known consumers go through it.
  for (const consumer of [
    /const encryptionKey = durableScanJobEncryptionKeyValue\(env\);/,
    /importDurableScanJobEncryptionKey\(\s*durableScanJobEncryptionKeyValue\(this\.env\)\s*\)/
  ]) {
    assert.match(source, consumer);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { DurableScanJobPreparation } from "./durable-scan-job-contract";
import {
  chooseDurableScanJobPumpWakeAt,
  durableScanJobsFlagState,
  durableScanJobNodeHealthState,
  durableScanJobSecretsAreDistinct,
  durableScanJobKeyIsIsolated,
  durableReconciliationTimeoutMs,
  durablePumpReuseNeedsAlarmKick,
  durableScanJobAdmissionProofMatches,
  finalizeDurableScanJobAdmission
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
  let commits = 0;
  let readbacks = 0;
  const recovered = await finalizeDurableScanJobAdmission(
    PREPARATION,
    async () => {
      commits += 1;
      throw new Error(commits === 1 ? "commit response lost" : "duplicate refused");
    },
    undefined,
    async () => {
      readbacks += 1;
      if (readbacks === 1) throw new Error("transient readback reset");
      return true;
    }
  );
  assert.deepEqual(recovered, { accepted: true, status: 202, submission: PREPARATION.submission });
  assert.equal(commits, 2);
  assert.equal(readbacks, 2);
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
  assert.match(source, /return submitDurableScanJob\(forwarded, env, replayFaultMode\)/);
  assert.match(source, /isScan &&\s*\(\s*durableScanJobsFlagMisconfigured\(env\)/);
  assert.match(source, /await finalizeDurableScanJobAdmission\(/);
  assert.match(source, /isDurableScanJobNodePrivatePath\(url\.pathname\)/);
  assert.match(source, /stripDurableScanJobInternalHeaders\(request\.headers\)/);
  assert.match(source, /forwardedHeaders\.delete\(DURABLE_REPLAY_FAULT_MODE_HEADER\)/);
  assert.match(source, /forwardedHeaders\.delete\(DURABLE_REPLAY_FAULT_TOKEN_HEADER\)/);
  assert.match(source, /timeoutMs = 60_000/);
  assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
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
  const pump = source.slice(
    source.indexOf("async pumpDurableScanJobs"),
    source.indexOf("private async activateDurableClaim")
  );
  assert.ok(
    pump.indexOf("await this.scheduleNextDurablePump();") <
      pump.indexOf("claimDurableScanJobs(this.ctx.storage.sql"),
    "a durable recovery driver must be armed before claim consumes an attempt"
  );
  assert.match(
    pump,
    /Persist a fresh idempotent driver before claim consumes an attempt[\s\S]*await this\.scheduleNextDurablePump\(\);\s*const credentials/
  );
  assert.match(pump, /Could not recompute the post-claim durable pump schedule/);
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
  assert.match(source, /private purgeDurableScanJobState[\s\S]*purgeDurableScanJobs[\s\S]*pruneDurableReconciliationBackoff/);
  assert.match(source, /completedAt >= snapshot\.purgeAt/);
  assert.ok(
    pump.indexOf("await this.prearmDurablePumpSuccessor(schedule?.taskId)") <
      pump.indexOf("await this.durableEncryptionKey()"),
    "the invoking row must remain covered by a successor before key import yields"
  );
  assert.doesNotMatch(source, /\n\s*(?:async\s+)?alarm\s*\(/);
  assert.ok(
    source.indexOf("gateDurableScanJobControlRequest(request, env)") <
      source.indexOf("findDurableJob(jobId)"),
    "authorization and read-rate charging must precede the DO lookup"
  );
  const jobRouting = source.slice(
    source.indexOf("if (scanJobId)"),
    source.indexOf("// Report reads and CORS preflight")
  );
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

test("Durable Object RPC mutations own time and return plain conflict envelopes", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const container = source.slice(
    source.indexOf("export class ScannerContainer"),
    source.indexOf("function atomicRateLimitWindow")
  );
  const coordinator = source.slice(
    source.indexOf("async function handleDurableScanJobCoordinatorRequest"),
    source.indexOf("function durableCoordinatorOwner")
  );
  const publicControl = source.slice(
    source.indexOf("async function handleDurableScanJobRequest"),
    source.indexOf("async function gateDurableScanJobControlRequest")
  );

  assert.match(source, /type DurableScanJobMutationResult\s*=\s*\| \{ status: "success" \}\s*\| \{ status: "conflict" \}/);
  assert.match(
    source,
    /type DurableScanJobAdmissionResult\s*=\s*\| \{ status: "success"; snapshot: DurableScanJobSnapshot \}\s*\| \{ status: "refused" \}/
  );
  assert.match(
    source,
    /type DurableScanJobCancellationResult\s*=\s*\| \{[\s\S]*status: "success";[\s\S]*snapshot: DurableScanJobSnapshot;[\s\S]*\| \{ status: "conflict" \}/
  );
  assert.match(container, /async cancelDurableJob\(jobId: string\): Promise<DurableScanJobCancellationResult>/);
  assert.match(
    container,
    /async heartbeatDurableJob\(owner: DurableScanJobExecutionOwner\): Promise<DurableScanJobMutationResult>/
  );
  assert.match(container, /findDurableJob\(jobId: string\): DurableScanJobSnapshot \| null/);
  assert.match(container, /findRegisteredScanJob\(jobId: string\): DurableScanJobRegistration \| null/);
  assert.match(container, /chargeDurableJobReadRateLimit\(input: \{ clientHash: string \}\)/);

  for (const method of ["heartbeatDurableJob", "beginPublishingDurableJob", "resolveDurableJob"] as const) {
    const start = container.indexOf(`async ${method}`);
    const next = container.indexOf("\n  async ", start + 1);
    const body = container.slice(start, next === -1 ? undefined : next);
    assert.ok(start >= 0, `${method} must remain a Durable Object RPC`);
    assert.match(body, /const tokenHash = await hashDurableScanJobLeaseToken/);
    assert.ok(
      body.indexOf("const tokenHash = await hashDurableScanJobLeaseToken") < body.indexOf("const now = Date.now()"),
      `${method} must sample authoritative time after hashing`
    );
    assert.ok(
      body.indexOf("const now = Date.now()") < body.indexOf("this.ctx.storage.transactionSync"),
      `${method} must sample authoritative time immediately before its transaction`
    );
    assert.match(body, /instanceof DurableScanJobStateError\) return \{ status: "conflict" \}/);
    assert.match(body, /return \{ status: "success" \}/);
  }

  const cancellation = container.slice(
    container.indexOf("async cancelDurableJob"),
    container.indexOf("async heartbeatDurableJob")
  );
  assert.ok(cancellation.indexOf("const now = Date.now()") < cancellation.indexOf("this.ctx.storage.transactionSync"));
  assert.match(cancellation, /instanceof DurableScanJobStateError\) return \{ status: "conflict" \}/);
  assert.match(cancellation, /status: "success" as const/);

  assert.doesNotMatch(
    source,
    /\.(?:heartbeatDurableJob|beginPublishingDurableJob|resolveDurableJob|cancelDurableJob|findDurableJob|findRegisteredScanJob)\([^;\n]*Date\.now\(\)/
  );
  assert.doesNotMatch(source, /charge(?:PublicScanRateLimit|DurableJobReadRateLimit)\(\{[\s\S]{0,500}?now: Date\.now\(\)/);
  assert.match(container, /createdAt: preparation\.payload\.admittedAt/);
  const admission = container.slice(
    container.indexOf("async admitDurablePreparation"),
    container.indexOf("findDurableJob", container.indexOf("async admitDurablePreparation"))
  );
  assert.match(admission, /instanceof DurableScanJobCapacityError \|\| error instanceof DurableScanJobStateError/);
  assert.match(admission, /return \{ status: "refused" \}/);
  assert.match(source, /result\.status !== "success" \|\|[\s\S]*durableScanJobAdmissionProofMatches\(result\.snapshot, value\)/);

  assert.match(coordinator, /result\.status === "conflict"\) return privateControlResponse\(409\)/);
  assert.doesNotMatch(coordinator, /instanceof DurableScanJobStateError/);
  assert.match(publicControl, /cancelled\.status === "conflict"\) return publicJobConflictResponse/);
  assert.doesNotMatch(publicControl, /instanceof DurableScanJobStateError/);
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
    publicRoute.indexOf("if (durableScanJobsEnabled())") < publicRoute.indexOf("submitScanJobRequest(request)"),
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
  const fetchHandler = source.slice(
    source.indexOf("export default"),
    source.indexOf("type DurableScanJobConfig")
  );
  assert.ok(
    fetchHandler.indexOf("durableReplayFaultIngressIntent(env)") <
      fetchHandler.indexOf('url.pathname === "/api/health"'),
    "the staging whole-origin token gate must run before health can touch the container"
  );
  assert.match(
    fetchHandler,
    /durableReplayFaultIngressIntent\(env\)[\s\S]*durableReplayFaultConfig\(env\)\.status !== "ready"[\s\S]*scanAccessTokenMatches\(request\.headers, expectedToken\)/
  );
  const healthCheck = source.slice(
    source.indexOf("export async function durableJobsEdgeHealthCheck"),
    source.indexOf("async function gateScanRequest")
  );
  assert.ok(
    healthCheck.indexOf("const replayFault = durableReplayFaultConfig") <
      healthCheck.indexOf('if (flag === "disabled")'),
    "health must evaluate replay-fault misconfiguration before the disabled early return"
  );
  assert.match(healthCheck, /if \(replayFault\.status === "misconfigured"\) reasons\.push/);

  const forwarder = source.slice(
    source.indexOf("function forwardToContainer"),
    source.indexOf("function frontDoorOrigin")
  );
  assert.match(forwarder, /headers\.delete\(DURABLE_REPLAY_FAULT_MODE_HEADER\)/);
  assert.match(forwarder, /headers\.delete\(DURABLE_REPLAY_FAULT_TOKEN_HEADER\)/);

  const purgeStart = source.indexOf("private purgeDurableScanJobState");
  const purge = source.slice(purgeStart, source.indexOf("private durableEncryptionKey", purgeStart));
  assert.match(purge, /purgeDurableReplayFaults\(this\.ctx\.storage\.sql, now\)/);
});

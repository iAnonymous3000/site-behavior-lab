import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { SCAN_ADMISSION_TTL_MS } from "./scan-admission-capability";

const ROOT = process.cwd();
const WORKER_NAME = "durable-runtime-integration";
const CLASS_NAME = "DurableScanJobRuntimeHarness";
const OBJECT_NAME = "critical-software-runtime-proof";
const KEY_WIRE = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url");

type Snapshot = {
  jobId: string;
  reportId: string;
  state: "queued" | "leased" | "publishing" | "succeeded" | "failed" | "expired" | "cancelled";
  attemptCount: number;
  leaseGeneration: number;
  leaseExpiresAt: number | null;
};

type Lease = {
  jobId: string;
  generation: number;
  leaseToken: string;
  leaseExpiresAt: number;
};

type IdempotentAdmission = {
  status: "committed" | "recovered";
  jobId: string;
  reportId: string;
  totalRuns: 1 | 2;
  createdAt: number;
  expiresAt: number;
};

type AdmissionError = {
  error: string;
};

test(
  "workerd atomically recovers idempotent admissions and executes durable jobs through SQLite and alarms",
  { timeout: 30_000 },
  async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "sbl-durable-runtime-"));
    let miniflare: Miniflare | undefined;
    try {
      const bundlePath = bundleRuntimeWorker(temporaryDirectory);
      miniflare = new Miniflare({
        name: WORKER_NAME,
        modules: true,
        scriptPath: bundlePath,
        modulesRoot: temporaryDirectory,
        compatibilityDate: "2026-06-19",
        bindings: { DURABLE_RUNTIME_KEY: KEY_WIRE },
        durableObjects: {
          DURABLE_RUNTIME: { className: CLASS_NAME, useSQLite: true }
        },
        durableObjectsPersist: false,
        unsafeInspectDurableObjects: true,
        log: new Log(LogLevel.ERROR)
      });

      assert.equal((await miniflare.dispatchFetch("https://runtime.invalid/watches")).status, 404);

      const createdAt = Date.now();
      const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, CLASS_NAME, {
        name: OBJECT_NAME
      });

      const capabilityHash = capabilityHashFor(1);
      const requestCommitment = commitmentFor(1);
      const originalJob = idFor(20);
      const originalReport = idFor(20_001);
      const responseLost = await requestJson<AdmissionError>(miniflare, "/admissions", {
        method: "POST",
        body: jsonBody({
          capabilityHash,
          requestCommitment,
          jobId: originalJob,
          reportId: originalReport,
          now: createdAt,
          simulateResponseLoss: true
        })
      });
      assert.equal(responseLost.response.status, 504);
      assert.equal(responseLost.body.error, "committed-response-lost");

      const recoveredAfterLoss = await requestJson<IdempotentAdmission>(miniflare, "/admissions", {
        method: "POST",
        body: jsonBody({
          capabilityHash,
          requestCommitment,
          jobId: idFor(21),
          reportId: idFor(20_002),
          now: createdAt + 1,
          simulateResponseLoss: false
        })
      });
      assert.equal(recoveredAfterLoss.response.status, 202);
      assert.deepEqual(
        {
          status: recoveredAfterLoss.body.status,
          jobId: recoveredAfterLoss.body.jobId,
          reportId: recoveredAfterLoss.body.reportId
        },
        { status: "recovered", jobId: originalJob, reportId: originalReport }
      );
      assert.equal(recoveredAfterLoss.body.createdAt, createdAt);
      assert.equal(recoveredAfterLoss.body.expiresAt, createdAt + SCAN_ADMISSION_TTL_MS);

      assert.equal(
        (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_scan_jobs"))[0].count,
        1,
        "the lost response and exact retry create one durable job"
      );
      assert.equal(
        (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM scan_admissions"))[0].count,
        1
      );
      let quotaRows = await storage.exec<{ bucket: string; used: number }>(
        "SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket"
      );
      assert.equal(
        quotaRows.length,
        4,
        "the per-client and global minute and day windows are all authoritative"
      );
      assert.deepEqual(
        quotaRows.map((row) => row.bucket.split("/")[0]).sort(),
        ["day", "minute", "public-scan-global", "public-scan-global"],
        "one per-client and one global bucket exist per window size"
      );
      assert.ok(quotaRows.every((row) => row.used === 1), "an exact retry charges each quota window once");

      const contradictory = await requestJson<AdmissionError>(miniflare, "/admissions", {
        method: "POST",
        body: jsonBody({
          capabilityHash,
          requestCommitment: commitmentFor(2),
          jobId: idFor(22),
          reportId: idFor(20_003),
          now: createdAt + 2,
          simulateResponseLoss: false
        })
      });
      assert.equal(contradictory.response.status, 409);
      assert.equal(contradictory.body.error, "scan-admission-conflict");
      quotaRows = await storage.exec<{ bucket: string; used: number }>(
        "SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket"
      );
      assert.ok(quotaRows.every((row) => row.used === 1), "a contradictory replay consumes no quota");
      assert.equal(
        (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_scan_jobs"))[0].count,
        1,
        "a contradictory replay creates no work"
      );

      await miniflare.unsafeEvictDurableObject(WORKER_NAME, CLASS_NAME, { name: OBJECT_NAME });
      const recoveredAfterEviction = await requestJson<IdempotentAdmission>(miniflare, "/admissions/recover", {
        method: "POST",
        body: jsonBody({ capabilityHash, requestCommitment, now: createdAt + 3 })
      });
      assert.equal(recoveredAfterEviction.response.status, 200);
      assert.deepEqual(
        [recoveredAfterEviction.body.jobId, recoveredAfterEviction.body.reportId],
        [originalJob, originalReport],
        "the recovery mapping survives Durable Object eviction"
      );

      const concurrentHash = capabilityHashFor(3);
      const concurrentCommitment = commitmentFor(3);
      const concurrentCandidates = [
        { jobId: idFor(23), reportId: idFor(20_004) },
        { jobId: idFor(24), reportId: idFor(20_005) }
      ] as const;
      const concurrent = await Promise.all(
        concurrentCandidates.map((candidate) =>
          requestJson<IdempotentAdmission>(miniflare!, "/admissions", {
            method: "POST",
            body: jsonBody({
              capabilityHash: concurrentHash,
              requestCommitment: concurrentCommitment,
              ...candidate,
              now: createdAt + 4,
              simulateResponseLoss: false
            })
          })
        )
      );
      assert.deepEqual(
        concurrent.map((result) => result.response.status),
        [202, 202]
      );
      assert.deepEqual(
        concurrent.map((result) => result.body.status).sort(),
        ["committed", "recovered"]
      );
      assert.deepEqual(
        [concurrent[0].body.jobId, concurrent[0].body.reportId],
        [concurrent[1].body.jobId, concurrent[1].body.reportId],
        "concurrent exact duplicates converge on one opaque job/report pair"
      );
      assert.ok(
        concurrentCandidates.some(
          (candidate) =>
            candidate.jobId === concurrent[0].body.jobId && candidate.reportId === concurrent[0].body.reportId
        )
      );
      assert.equal(
        (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_scan_jobs"))[0].count,
        2,
        "the original and concurrent capabilities create exactly one job each"
      );
      quotaRows = await storage.exec<{ bucket: string; used: number }>(
        "SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket"
      );
      assert.ok(quotaRows.every((row) => row.used === 2), "the concurrent duplicate is charged once");

      const expired = await requestJson<AdmissionError>(miniflare, "/admissions/recover", {
        method: "POST",
        body: jsonBody({
          capabilityHash,
          requestCommitment,
          now: createdAt + SCAN_ADMISSION_TTL_MS
        })
      });
      assert.equal(expired.response.status, 404);
      assert.equal(expired.body.error, "scan-admission-not-found");
      assert.equal(
        (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM scan_admissions"))[0].count,
        1,
        "expiry removes the old mapping without touching a still-live capability"
      );

      const originalCancelled = await requestJson<Snapshot>(miniflare, `/jobs/${originalJob}`, {
        method: "DELETE"
      });
      const concurrentCancelled = await requestJson<Snapshot>(miniflare, `/jobs/${concurrent[0].body.jobId}`, {
        method: "DELETE"
      });
      assert.equal(originalCancelled.body.state, "cancelled");
      assert.equal(concurrentCancelled.body.state, "cancelled");

      const cancelledJob = idFor(1);
      const cancelledReport = idFor(10_001);
      const admitted = await requestJson<Snapshot>(miniflare, "/jobs", {
        method: "POST",
        body: jsonBody({ jobId: cancelledJob, reportId: cancelledReport, now: createdAt })
      });
      assert.equal(admitted.response.status, 202);
      assert.equal(admitted.body.state, "queued");

      const rows = await storage.exec<{
        job_id: string;
        report_id: string;
        state: string;
        payload_ciphertext: ArrayBuffer;
      }>("SELECT job_id, report_id, state, payload_ciphertext FROM durable_scan_jobs");
      assert.equal(rows.length, 3);
      const cancelledRow = rows.find((row) => row.job_id === cancelledJob);
      assert.ok(cancelledRow);
      assert.deepEqual(
        { jobId: cancelledRow.job_id, reportId: cancelledRow.report_id, state: cancelledRow.state },
        { jobId: cancelledJob, reportId: cancelledReport, state: "queued" }
      );
      assert.ok(cancelledRow.payload_ciphertext.byteLength > 16, "workerd SQLite stores only authenticated ciphertext");

      // The activation gate that stood in front of SITE_BEHAVIOR_LAB_DURABLE_JOBS=1:
      // one solved Turnstile token replayed concurrently must buy exactly one
      // uncommitted preparation, not one per replay. Proven here against real
      // workerd SQLite rather than a source regex, because it is the DO's
      // transaction that makes the check-and-insert atomic.
      const replayCapability = "d".repeat(64);
      const replayWindow = { now: createdAt, expiresAt: createdAt + 30_000 };
      const concurrentReplays = await Promise.all(
        Array.from({ length: 8 }, () =>
          requestJson<{ status: string }>(miniflare as Miniflare, "/preparations", {
            method: "POST",
            body: jsonBody({ capabilityHash: replayCapability, ...replayWindow })
          })
        )
      );
      assert.equal(
        concurrentReplays.filter((replay) => replay.body.status === "reserved").length,
        1,
        "exactly one concurrent replay may hold the capability's preparation slot"
      );
      assert.equal(
        concurrentReplays.filter((replay) => replay.body.status === "in-flight").length,
        7,
        "every other concurrent replay is refused before it can buy preparation"
      );

      // A distinct capability is never blocked by another's reservation.
      assert.equal(
        (
          await requestJson<{ status: string }>(miniflare, "/preparations", {
            method: "POST",
            body: jsonBody({ capabilityHash: "e".repeat(64), ...replayWindow })
          })
        ).body.status,
        "reserved"
      );

      // Releasing frees the slot immediately, so the honest sequential retry
      // that follows a failed attempt is never locked out.
      await requestJson(miniflare, "/preparations/release", {
        method: "POST",
        body: jsonBody({ capabilityHash: replayCapability })
      });
      assert.equal(
        (
          await requestJson<{ status: string }>(miniflare, "/preparations", {
            method: "POST",
            body: jsonBody({ capabilityHash: replayCapability, ...replayWindow })
          })
        ).body.status,
        "reserved",
        "a released capability may prepare again at once"
      );

      await miniflare.unsafeEvictDurableObject(WORKER_NAME, CLASS_NAME, { name: OBJECT_NAME });
      assert.equal((await getSnapshot(miniflare, cancelledJob)).state, "queued", "SQLite survives DO eviction");

      const cancelled = await requestJson<Snapshot>(miniflare, `/jobs/${cancelledJob}`, { method: "DELETE" });
      assert.equal(cancelled.response.status, 200);
      assert.equal(cancelled.body.state, "cancelled");
      assert.equal((await getSnapshot(miniflare, cancelledJob)).state, "cancelled");
      assert.equal(
        (await requestJson<Snapshot>(miniflare, `/jobs/${cancelledJob}`, { method: "DELETE" })).body.state,
        "cancelled",
        "cancellation is idempotent"
      );
      assert.equal(
        (
          await requestJson(miniflare, "/jobs", {
            method: "POST",
            body: jsonBody({ jobId: cancelledJob, reportId: cancelledReport, now: createdAt })
          })
        ).response.status,
        409,
        "duplicate admission remains refused after cancellation"
      );

      const recoveredJob = idFor(2);
      await admit(miniflare, recoveredJob, idFor(10_002), createdAt + 1);
      const firstLease = await claim(miniflare, recoveredJob, createdAt + 2);
      await armRecovery(miniflare, recoveredJob);
      const requeued = await waitForState(miniflare, recoveredJob, "queued");
      assert.equal(requeued.attemptCount, 1);
      assert.equal(requeued.leaseGeneration, 1);

      const secondLease = await claim(miniflare, recoveredJob, firstLease.leaseExpiresAt + 1);
      assert.equal(secondLease.generation, 2);
      await armRecovery(miniflare, recoveredJob);
      const restartLimited = await waitForState(miniflare, recoveredJob, "failed");
      assert.equal(restartLimited.attemptCount, 2);
      const runtime = await requestJson<{ alarmRuns: number }>(miniflare, "/runtime");
      assert.equal(runtime.body.alarmRuns, 2, "two real Durable Object alarm callbacks executed");

      const succeededJob = idFor(3);
      await admit(miniflare, succeededJob, idFor(10_003), createdAt + 3);
      const owner = await claim(miniflare, succeededJob, createdAt + 4);
      const publishing = await ownerMutation(miniflare, succeededJob, "begin-publishing", owner, createdAt + 5);
      assert.equal(publishing.state, "publishing");
      const succeeded = await ownerMutation(miniflare, succeededJob, "resolve", owner, createdAt + 6);
      assert.equal(succeeded.state, "succeeded");
      assert.equal((await getSnapshot(miniflare, succeededJob)).state, "succeeded");
    } finally {
      await miniflare?.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
);

function bundleRuntimeWorker(outputDirectory: string): string {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
      "deploy",
      path.join(ROOT, "test-fixtures", "durable-scan-job-runtime.test.ts"),
      "--dry-run",
      "--outdir",
      outputDirectory,
      "--name",
      WORKER_NAME,
      "--compatibility-date",
      "2026-06-19"
    ],
    { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: "pipe" }
  );
  return path.join(outputDirectory, "durable-scan-job-runtime.test.js");
}

async function admit(miniflare: Miniflare, jobId: string, reportId: string, now: number): Promise<Snapshot> {
  const result = await requestJson<Snapshot>(miniflare, "/jobs", {
    method: "POST",
    body: jsonBody({ jobId, reportId, now })
  });
  assert.equal(result.response.status, 202);
  return result.body;
}

async function claim(miniflare: Miniflare, jobId: string, now: number): Promise<Lease> {
  const result = await requestJson<Lease>(miniflare, `/jobs/${jobId}/claim`, {
    method: "POST",
    body: jsonBody({ now })
  });
  assert.equal(result.response.status, 200);
  return result.body;
}

async function armRecovery(miniflare: Miniflare, jobId: string): Promise<void> {
  const response = await miniflare.dispatchFetch(`https://runtime.invalid/jobs/${jobId}/arm-recovery`, {
    method: "POST"
  });
  assert.equal(response.status, 202);
}

async function ownerMutation(
  miniflare: Miniflare,
  jobId: string,
  action: "begin-publishing" | "resolve",
  owner: Lease,
  now: number
): Promise<Snapshot> {
  const result = await requestJson<Snapshot>(miniflare, `/jobs/${jobId}/${action}`, {
    method: "POST",
    body: jsonBody({ generation: owner.generation, leaseToken: owner.leaseToken, now })
  });
  assert.equal(result.response.status, 200);
  return result.body;
}

async function getSnapshot(miniflare: Miniflare, jobId: string): Promise<Snapshot> {
  const result = await requestJson<Snapshot>(miniflare, `/jobs/${jobId}`);
  assert.equal(result.response.status, 200);
  return result.body;
}

async function waitForState(
  miniflare: Miniflare,
  jobId: string,
  expected: Snapshot["state"]
): Promise<Snapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await getSnapshot(miniflare, jobId);
    if (snapshot.state === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Durable Object alarm did not transition ${jobId} to ${expected}.`);
}

async function requestJson<T = unknown>(
  miniflare: Miniflare,
  pathname: string,
  init?: RequestInit
): Promise<{ response: { status: number }; body: T }> {
  // Miniflare's undici-compatible RequestInit intentionally differs from the
  // DOM RequestInit only in stream typing. This harness sends string bodies.
  const response = await miniflare.dispatchFetch(`https://runtime.invalid${pathname}`, init as never);
  const body = (await response.json()) as T;
  return { response, body };
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function idFor(index: number): string {
  return `20260721-${index.toString(16).padStart(32, "0")}`;
}

function capabilityHashFor(fill: number): string {
  return Buffer.alloc(32, fill).toString("hex");
}

function commitmentFor(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64url");
}

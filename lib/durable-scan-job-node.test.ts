import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import {
  DURABLE_SCAN_JOB_INTERNAL_HEADER,
  DurableScanJobCoordinatorError,
  assertDurableScanJobInternalRequest,
  createDurableScanJobCoordinatorClient,
  type DurableScanJobCoordinator,
  type DurableScanJobExecutionOwner,
  type DurableScanJobPreparation
} from "./durable-scan-job-node";
import {
  DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS,
  REPORT_MAX_AGE_DAYS_ENV,
  REPORT_MIN_SURVIVAL_MS_ENV,
  prepareScanReportBundle
} from "./report-store";
import {
  activateDurableScanJob,
  cancelDurableScanJobGeneration,
  durableScanJobFenceForTests,
  durableScanJobsEnabled,
  getScanJobStatus,
  prepareDurableScanJobRequest,
  reconcileDurableScanJobPublication,
  resetScanJobStateForTests,
  scanJobStateForTests,
  waitForScanJobForTests
} from "./scan-jobs";
import { resetScanLimitStateForTests, scanLimitStateForTests } from "./scan-limits";
import type { PreparedScanRequest, ScanRunner } from "./scan-api";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV, type RuntimeScanReport } from "./runtime-scan-report";

const JOB_ID = `20260718-${"a".repeat(32)}`;
const REPORT_ID = `20260718-${"b".repeat(32)}`;
const JOB_ID_TWO = `20260718-${"c".repeat(32)}`;
const REPORT_ID_TWO = `20260718-${"d".repeat(32)}`;
const JOB_ID_THREE = `20260718-${"e".repeat(32)}`;
const REPORT_ID_THREE = `20260718-${"f".repeat(32)}`;
const LEASE_ONE = "A".repeat(43);
const LEASE_TWO = "E".repeat(43);
const LEASE_THREE = "I".repeat(43);
const INTERNAL_TOKEN = "internal-".padEnd(32, "x");

const R2_ENV = {
  SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND: "r2",
  SITE_BEHAVIOR_LAB_R2_BUCKET: "test-reports",
  SITE_BEHAVIOR_LAB_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: "test-access",
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: "test-secret"
} as const;

beforeEach(() => {
  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = String(DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS);
  for (const [name, value] of Object.entries(R2_ENV)) process.env[name] = value;
});

afterEach(() => {
  delete process.env[PUBLIC_R2_REPORTS_ENV];
  delete process.env[BUILD_COMMIT_ENV];
  delete process.env[CONSENT_VERIFICATION_ENV];
  delete process.env[REPORT_MAX_AGE_DAYS_ENV];
  delete process.env[REPORT_MIN_SURVIVAL_MS_ENV];
  for (const name of Object.keys(R2_ENV)) delete process.env[name];
  resetScanJobStateForTests();
  resetScanLimitStateForTests();
});

test("durable preparation defers charging, strips query data, and starts no work", async () => {
  const preparation = await prepareDurableScanJobRequest(new Request("https://scanner.invalid/api/scan"), {
    prepare: async () =>
      preparedRequest({
        clientKey: "203.0.113.42",
        url: "https://example.com/private/path?access_token=secret#account"
      }),
    requireReady: () => undefined,
    now: () => 1_721_260_800_000,
    createId: sequentialIds(JOB_ID, REPORT_ID)
  });

  assert.equal(scanLimitStateForTests().trackedClients, 0);
  assert.deepEqual(scanJobStateForTests(), { queuedJobs: 0, activeJobWorkers: 0, retainedJobs: 0 });
  assert.deepEqual(preparation.submission, {
    ok: true,
    jobId: JOB_ID,
    status: "queued",
    statusPath: `/api/scans/${JOB_ID}`,
    reportId: REPORT_ID
  });
  assert.equal(preparation.payload.url, "https://example.com/private/path");
  assert.deepEqual(Object.keys(preparation.payload).sort(), [
    "admittedAt",
    "alreadyCharged",
    "compareConsent",
    "compareGpc",
    "compareShields",
    "device",
    "gpcEnabled",
    "rateLimitCost",
    "reportMode",
    "url",
    "version"
  ]);
  const wire = JSON.stringify(preparation.payload);
  assert.equal(wire.includes("203.0.113.42"), false);
  assert.equal(wire.includes("access_token"), false);
  assert.equal(wire.includes("secret"), false);
});

test("durable preparation refuses report retention shorter than the 75-minute recovery window", async () => {
  const prepare = () =>
    prepareDurableScanJobRequest(new Request("https://scanner.invalid/api/scan"), {
      prepare: async () => preparedRequest(),
      now: () => 1_721_260_800_000,
      createId: sequentialIds(JOB_ID, REPORT_ID)
    });

  delete process.env[REPORT_MIN_SURVIVAL_MS_ENV];
  await assert.rejects(prepare, /recoverable for at least 75 minutes/);

  process.env[REPORT_MIN_SURVIVAL_MS_ENV] = String(DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS);
  process.env[REPORT_MAX_AGE_DAYS_ENV] = "0.01";
  await assert.rejects(prepare, /recoverable for at least 75 minutes/);

  process.env[REPORT_MAX_AGE_DAYS_ENV] = "7";
  assert.equal((await prepare()).submission.reportId, REPORT_ID);
});

test("durable preparation requires the shared r2 report store before minting capabilities", async () => {
  delete process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND;
  let mintedCapabilities = 0;

  await assert.rejects(
    () =>
      prepareDurableScanJobRequest(new Request("https://scanner.invalid/api/scan"), {
        prepare: async () => preparedRequest(),
        createId: () => {
          mintedCapabilities += 1;
          return mintedCapabilities === 1 ? JOB_ID : REPORT_ID;
        }
      }),
    /require public r2 report persistence/i
  );
  assert.equal(mintedCapabilities, 0);
  assert.equal(scanLimitStateForTests().trackedClients, 0);
  assert.deepEqual(scanJobStateForTests(), { queuedJobs: 0, activeJobWorkers: 0, retainedJobs: 0 });
});

test("an invalid durable mode flag fails closed instead of falling back to local execution", () => {
  assert.throws(
    () => durableScanJobsEnabled({ SITE_BEHAVIOR_LAB_DURABLE_JOBS: "yes" } as NodeJS.ProcessEnv),
    /must be 0, 1, or unset/i
  );
});

test("activation awaits an immediate lease heartbeat before starting target work", async () => {
  const preparation = await durablePreparation();
  const heartbeatReached = deferred<void>();
  const releaseHeartbeat = deferred<void>();
  let scans = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => {
      heartbeatReached.resolve();
      await releaseHeartbeat.promise;
    },
    beginPublishing: async () => undefined,
    resolve: async () => undefined
  };

  const activating = activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => {
      scans += 1;
      return r2ScanResult();
    },
    publication: inMemoryPublication()
  });
  await heartbeatReached.promise;
  assert.equal(scans, 0);
  assert.deepEqual(scanJobStateForTests(), { queuedJobs: 0, activeJobWorkers: 0, retainedJobs: 0 });

  releaseHeartbeat.resolve();
  assert.equal((await activating).status, "activated");
  await waitForScanJobForTests(JOB_ID);
  assert.equal(scans, 1);
});

test("a stale activation is refused before creating a record or visiting the target", async () => {
  const preparation = await durablePreparation();
  let scans = 0;
  await assert.rejects(
    () =>
      activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
        coordinator: {
          heartbeat: async () => {
            throw new DurableScanJobCoordinatorError("stale", 409);
          },
          beginPublishing: async () => undefined,
          resolve: async () => undefined
        },
        scan: async () => {
          scans += 1;
          return r2ScanResult();
        },
        publication: inMemoryPublication()
      }),
    /stale/i
  );
  assert.equal(scans, 0);
  assert.deepEqual(scanJobStateForTests(), { queuedJobs: 0, activeJobWorkers: 0, retainedJobs: 0 });
});

test("activation reserves at most the two local execution slots", async () => {
  const first = await durablePreparation();
  const second = preparationWithCapabilities(first, JOB_ID_TWO, REPORT_ID_TWO);
  const third = preparationWithCapabilities(first, JOB_ID_THREE, REPORT_ID_THREE);
  const twoHeartbeatsReached = deferred<void>();
  const releaseHeartbeats = deferred<void>();
  let heartbeatCalls = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 2) twoHeartbeatsReached.resolve();
      await releaseHeartbeats.promise;
    },
    beginPublishing: async () => undefined,
    resolve: async () => undefined
  };
  const waitingScan: ScanRunner = (_payload, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });

  const activatingFirst = activateDurableScanJob(activation(first, 1, LEASE_ONE), {
    coordinator,
    scan: waitingScan,
    publication: inMemoryPublication()
  });
  const activatingSecond = activateDurableScanJob(activation(second, 1, LEASE_TWO), {
    coordinator,
    scan: waitingScan,
    publication: inMemoryPublication()
  });
  await twoHeartbeatsReached.promise;
  await assert.rejects(
    () =>
      activateDurableScanJob(activation(third, 1, LEASE_THREE), {
        coordinator,
        scan: waitingScan,
        publication: inMemoryPublication()
      }),
    /execution capacity is full/i
  );
  assert.equal(heartbeatCalls, 2, "a refused activation must not renew a lease it cannot execute");

  releaseHeartbeats.resolve();
  await Promise.all([activatingFirst, activatingSecond]);
  cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 1 });
  cancelDurableScanJobGeneration({ jobId: JOB_ID_TWO, generation: 1 });
  await Promise.all([waitForScanJobForTests(JOB_ID), waitForScanJobForTests(JOB_ID_TWO)]);
});

test("a newer generation renews while waiting for its superseded full-capacity slot", async () => {
  const first = await durablePreparation();
  const second = preparationWithCapabilities(first, JOB_ID_TWO, REPORT_ID_TWO);
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const replayRenewed = deferred<void>();
  let replayHeartbeats = 0;
  let replayScans = 0;

  await activateDurableScanJob(activation(first, 1, LEASE_ONE), {
    coordinator: recordingCoordinator([]),
    scan: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return r2ScanResult();
    },
    publication: inMemoryPublication()
  });
  await activateDurableScanJob(activation(second, 1, LEASE_TWO), {
    coordinator: recordingCoordinator([]),
    scan: (_payload, options) =>
      new Promise((_resolve, reject) => {
        secondStarted.resolve();
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    publication: inMemoryPublication()
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);

  await activateDurableScanJob(activation(first, 2, LEASE_THREE), {
    coordinator: {
      heartbeat: async () => {
        replayHeartbeats += 1;
        if (replayHeartbeats === 2) replayRenewed.resolve();
      },
      beginPublishing: async () => undefined,
      resolve: async () => undefined
    },
    scan: async () => {
      replayScans += 1;
      return r2ScanResult();
    },
    publication: inMemoryPublication(),
    heartbeatIntervalMs: 1
  });

  await replayRenewed.promise;
  assert.equal(replayScans, 0, "the replacement must not exceed local execution capacity");
  releaseFirst.resolve();
  await waitForScanJobForTests(JOB_ID);
  assert.equal(replayScans, 1);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "succeeded");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, { jobId: JOB_ID, generation: 2, leaseToken: LEASE_THREE });

  cancelDurableScanJobGeneration({ jobId: JOB_ID_TWO, generation: 1 });
  await waitForScanJobForTests(JOB_ID_TWO);
});

test("a superseded generation cleanup deadline cannot delete its replacement", async () => {
  const preparation = await durablePreparation();
  const firstStarted = deferred<void>();
  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator([]),
    scan: (_payload, options) =>
      new Promise((_resolve, reject) => {
        firstStarted.resolve();
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    publication: inMemoryPublication(),
    localCleanupDelayMs: 20
  });
  await firstStarted.promise;

  await activateDurableScanJob(activation(preparation, 2, LEASE_TWO), {
    coordinator: recordingCoordinator([]),
    scan: async () => r2ScanResult(),
    publication: inMemoryPublication(),
    localCleanupDelayMs: 200
  });
  await waitForScanJobForTests(JOB_ID);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(scanJobStateForTests().retainedJobs, 1);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "succeeded");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(2, LEASE_TWO));
});

test("activation is idempotent and never charges the Node limiter", async () => {
  let scans = 0;
  const preparation = await durablePreparation();
  const events: string[] = [];
  const coordinator = recordingCoordinator(events);

  const first = await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => {
      scans += 1;
      return r2ScanResult();
    },
    publication: inMemoryPublication()
  });
  const duplicate = await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => {
      scans += 1;
      return r2ScanResult();
    },
    publication: inMemoryPublication()
  });

  assert.equal(first.status, "activated");
  assert.equal(duplicate.status, "already-active");
  await waitForScanJobForTests(JOB_ID);
  assert.equal(scanLimitStateForTests().trackedClients, 0);
  assert.equal(scans, 1);
  assert.deepEqual(events, ["heartbeat:1", "begin:1", "resolve:succeeded:1"]);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "succeeded");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
});

test("a newer generation aborts and replaces a stale nonpublishing activation", async () => {
  const preparation = await durablePreparation();
  const firstStarted = deferred<void>();
  let firstAborted = false;
  let secondScans = 0;
  const firstScan: ScanRunner = (_payload, options) =>
    new Promise((_resolve, reject) => {
      firstStarted.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => {
          firstAborted = true;
          reject(options.signal?.reason);
        },
        { once: true }
      );
    });

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator([]),
    scan: firstScan,
    publication: inMemoryPublication()
  });
  await firstStarted.promise;
  await activateDurableScanJob(activation(preparation, 2, LEASE_TWO), {
    coordinator: recordingCoordinator([]),
    scan: async () => {
      secondScans += 1;
      return r2ScanResult();
    },
    publication: inMemoryPublication()
  });

  await waitForScanJobForTests(JOB_ID);
  assert.equal(firstAborted, true);
  assert.equal(secondScans, 1);
  // The current owner being generation 2 is what proves generation 1's lease
  // no longer matches; the old null-read of a stale owner said less.
  assert.equal(getScanJobStatus(JOB_ID)?.status, "succeeded");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(2, LEASE_TWO));
  await assert.rejects(
    () => activateDurableScanJob(activation(preparation, 1, LEASE_ONE), { coordinator: recordingCoordinator([]) }),
    /stale/i
  );
});

test("a definitive heartbeat conflict aborts stale execution without resolving it", async () => {
  const preparation = await durablePreparation();
  let resolveCalls = 0;
  let heartbeatCalls = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls > 1) throw new DurableScanJobCoordinatorError("stale", 409);
    },
    beginPublishing: async () => undefined,
    resolve: async () => {
      resolveCalls += 1;
    }
  };
  const scan: ScanRunner = (_payload, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan,
    publication: inMemoryPublication(),
    heartbeatIntervalMs: 1
  });
  await waitForScanJobForTests(JOB_ID);

  assert.equal(getScanJobStatus(JOB_ID)?.status, "cancelled");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
  assert.equal(resolveCalls, 0);
});

test("a missing post-commit reconciliation detaches without inventing a terminal result", async () => {
  const preparation = await durablePreparation();
  const firstEvents: string[] = [];
  let scans = 0;
  const missingPublication = {
    ...inMemoryPublication(),
    commit: async () => {
      throw new Error("outcome unknown");
    },
    reconcile: async () => ({ outcome: "missing" as const })
  };

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator(firstEvents),
    scan: async () => {
      scans += 1;
      return r2ScanResult();
    },
    publication: missingPublication
  });
  await waitForScanJobForTests(JOB_ID);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "running");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
  assert.deepEqual(firstEvents, ["heartbeat:1", "begin:1"]);

  assert.equal(scans, 1);
});

test("durable publication timeout settles even when commit ignores its bounded signal", async () => {
  const preparation = await durablePreparation();
  const events: string[] = [];
  const lateCommit = deferred<RuntimeScanReport>();
  let commitSignal: AbortSignal | undefined;
  let reconciliationCalls = 0;

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator(events),
    scan: async () => r2ScanResult(),
    publication: {
      ...inMemoryPublication(),
      commit: async (_bundle, signal) => {
        commitSignal = signal;
        return lateCommit.promise;
      },
      reconcile: async () => {
        reconciliationCalls += 1;
        return { outcome: "missing" as const };
      }
    },
    publicationTimeoutMs: 5
  });
  await waitForScanJobForTests(JOB_ID);

  assert.ok(commitSignal);
  assert.equal(commitSignal.aborted, true);
  assert.equal(commitSignal.reason instanceof DOMException && commitSignal.reason.name, "TimeoutError");
  assert.equal(reconciliationCalls, 0, "an expired publication must not invoke reconciliation");
  assert.deepEqual(events, ["heartbeat:1", "begin:1"]);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "running");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));

  lateCommit.resolve(r2ScanResult().result);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["heartbeat:1", "begin:1"]);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "running");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
});

test("private publication reconciliation settles and observes a late adapter rejection", async () => {
  const manifest = prepareScanReportBundle(r2ScanResult().result, { shareId: REPORT_ID }).manifest;
  const lateReconciliation = deferred<{ outcome: "missing" }>();
  let observedSignal: AbortSignal | undefined;
  const result = await reconcileDurableScanJobPublication(
    { jobId: JOB_ID, reportId: REPORT_ID, generation: 1, manifest },
    async (_manifest, signal) => {
      observedSignal = signal;
      return lateReconciliation.promise;
    },
    { timeoutMs: 5 }
  );

  assert.equal(result.outcome, "retryable");
  assert.equal(observedSignal?.aborted, true);
  assert.equal(
    observedSignal?.reason instanceof DOMException && observedSignal.reason.name,
    "TimeoutError"
  );

  lateReconciliation.reject(new Error("late storage failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.outcome, "retryable");
});

test("a reconciliation transport failure never resolves publishing as failed", async () => {
  const preparation = await durablePreparation();
  const events: string[] = [];
  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator(events),
    scan: async () => r2ScanResult(),
    publication: {
      ...inMemoryPublication(),
      commit: async () => {
        throw new Error("outcome unknown");
      },
      reconcile: async () => {
        throw new Error("r2 unavailable");
      }
    }
  });
  await waitForScanJobForTests(JOB_ID);

  assert.equal(getScanJobStatus(JOB_ID)?.status, "running");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
  assert.deepEqual(events, ["heartbeat:1", "begin:1"]);
});

test("an in-flight heartbeat cannot rearm after publication becomes outcome-unknown", async () => {
  const preparation = await durablePreparation();
  const secondHeartbeatReached = deferred<void>();
  const releaseSecondHeartbeat = deferred<void>();
  let heartbeatCalls = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 2) {
        secondHeartbeatReached.resolve();
        await releaseSecondHeartbeat.promise;
      }
    },
    beginPublishing: async () => undefined,
    resolve: async () => {
      throw new Error("outcome-unknown publication must not resolve");
    }
  };

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => r2ScanResult(),
    publication: {
      ...inMemoryPublication(),
      commit: async () => {
        await secondHeartbeatReached.promise;
        throw new Error("outcome unknown");
      },
      reconcile: async () => ({ outcome: "missing" as const })
    },
    heartbeatIntervalMs: 1
  });
  await waitForScanJobForTests(JOB_ID);
  assert.equal(heartbeatCalls, 2);

  releaseSecondHeartbeat.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(heartbeatCalls, 2, "detached publishing must stop renewing so the DO can reconcile");
});

test("an outcome-unknown begin-publishing call never starts R2 or resolves failed", async () => {
  const preparation = await durablePreparation();
  let commits = 0;
  let resolves = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => undefined,
    beginPublishing: async () => {
      throw new DurableScanJobCoordinatorError("timed out", null);
    },
    resolve: async () => {
      resolves += 1;
    }
  };

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => r2ScanResult(),
    publication: inMemoryPublication(() => {
      commits += 1;
    })
  });
  await waitForScanJobForTests(JOB_ID);

  assert.equal(commits, 0);
  assert.equal(resolves, 0);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "running");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));

  const replayEvents: string[] = [];
  await activateDurableScanJob(activation(preparation, 2, LEASE_TWO), {
    coordinator: recordingCoordinator(replayEvents),
    scan: async () => r2ScanResult(),
    publication: inMemoryPublication(() => {
      commits += 1;
    })
  });
  await waitForScanJobForTests(JOB_ID);
  assert.equal(commits, 1, "a DO-authorized replay must not be blocked by the pre-CAS local fence");
  assert.deepEqual(replayEvents, ["heartbeat:2", "begin:2", "resolve:succeeded:2"]);
});

test("trusted generation-only cancellation refuses an older control and cancels the current generation", async () => {
  const preparation = await durablePreparation();
  const scanStarted = deferred<void>();
  const events: string[] = [];
  const scan: ScanRunner = (_payload, options) =>
    new Promise((_resolve, reject) => {
      scanStarted.resolve();
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });

  await activateDurableScanJob(activation(preparation, 2, LEASE_TWO), {
    coordinator: recordingCoordinator(events),
    scan,
    publication: inMemoryPublication()
  });
  await scanStarted.promise;

  assert.equal(cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 1 }), null);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "running");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(2, LEASE_TWO));
  const cancelled = cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 2 });
  assert.deepEqual(cancelled, {
    ok: true,
    status: "cancelled",
    jobId: JOB_ID,
    generation: 2
  });
  assert.equal(JSON.stringify(cancelled).includes(LEASE_TWO), false);
  await waitForScanJobForTests(JOB_ID);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "cancelled");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(2, LEASE_TWO));
  assert.deepEqual(events, ["heartbeat:2", "resolve:cancelled:2"]);
  assert.throws(
    () =>
      cancelDurableScanJobGeneration({
        jobId: JOB_ID,
        generation: 2,
        extra: true
      } as never),
    /invalid durable scan-job generation control/i
  );
});

test("authoritative generation-two cancellation aborts a still-running generation one", async () => {
  const preparation = await durablePreparation();
  const scanStarted = deferred<void>();
  let commits = 0;
  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator([]),
    scan: (_payload, options) =>
      new Promise((_resolve, reject) => {
        scanStarted.resolve();
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    publication: inMemoryPublication(() => {
      commits += 1;
    })
  });
  await scanStarted.promise;

  assert.deepEqual(cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 2 }), {
    ok: true,
    status: "cancelled",
    jobId: JOB_ID,
    generation: 2
  });
  await waitForScanJobForTests(JOB_ID);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "cancelled");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
  assert.equal(commits, 0);
});

test("authoritative cancellation without a local record blocks a later activation", async () => {
  const preparation = await durablePreparation();
  let heartbeatCalls = 0;
  let scans = 0;

  assert.equal(cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 1 }), null);
  await assert.rejects(
    () =>
      activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
        coordinator: {
          heartbeat: async () => {
            heartbeatCalls += 1;
          },
          beginPublishing: async () => undefined,
          resolve: async () => undefined
        },
        scan: async () => {
          scans += 1;
          return r2ScanResult();
        },
        publication: inMemoryPublication()
      }),
    /activation was cancelled/i
  );

  assert.equal(heartbeatCalls, 0);
  assert.equal(scans, 0);
  assert.deepEqual(scanJobStateForTests(), { queuedJobs: 0, activeJobWorkers: 0, retainedJobs: 0 });
});

test("authoritative cancellation wins after heartbeat success but before activation resumes", async () => {
  const preparation = await durablePreparation();
  const firstStarted = deferred<void>();
  const heartbeatSucceeded = deferred<void>();
  const releaseHeartbeatResponse = deferred<void>();
  let secondScans = 0;

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator([]),
    scan: (_payload, options) =>
      new Promise((_resolve, reject) => {
        firstStarted.resolve();
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      }),
    publication: inMemoryPublication()
  });
  await firstStarted.promise;

  const activatingSecond = activateDurableScanJob(activation(preparation, 2, LEASE_TWO), {
    coordinator: {
      heartbeat: async () => {
        // The coordinator has accepted the heartbeat, but its response has not
        // yet resumed this activation request.
        heartbeatSucceeded.resolve();
        await releaseHeartbeatResponse.promise;
      },
      beginPublishing: async () => undefined,
      resolve: async () => undefined
    },
    scan: async () => {
      secondScans += 1;
      return r2ScanResult();
    },
    publication: inMemoryPublication()
  });
  const activationRejected = assert.rejects(activatingSecond, /activation was cancelled/i);
  await heartbeatSucceeded.promise;

  assert.deepEqual(cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 2 }), {
    ok: true,
    status: "cancelled",
    jobId: JOB_ID,
    generation: 2
  });
  releaseHeartbeatResponse.resolve();

  await activationRejected;
  await waitForScanJobForTests(JOB_ID);
  assert.equal(secondScans, 0);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "cancelled");
  // Generation 2 never installed: the record's owner is still generation 1,
  // which the deepEqual above pins exactly.
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
});

test("authoritative cancellation aborts a pending local publication CAS despite the local fence", async () => {
  const preparation = await durablePreparation();
  const beginReached = deferred<void>();
  let beginPublishingReached = false;
  let commits = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => undefined,
    beginPublishing: async (_owner, _manifest, signal) =>
      new Promise<void>((_resolve, reject) => {
        beginPublishingReached = true;
        beginReached.resolve();
        const abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    resolve: async () => undefined
  };
  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => r2ScanResult(),
    publication: inMemoryPublication(() => {
      commits += 1;
    })
  });
  await milestoneOrSettledJob(JOB_ID, beginReached.promise, () => beginPublishingReached, "coordinator.beginPublishing");

  assert.equal(cancelDurableScanJobGeneration({ jobId: JOB_ID, generation: 1 })?.status, "cancelled");
  await waitForScanJobForTests(JOB_ID);
  assert.equal(commits, 0);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "cancelled");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
});

test("durable publication sets the local fence synchronously and awaits coordinator approval", async () => {
  const preparation = await durablePreparation();
  const beginReached = deferred<void>();
  const releaseBegin = deferred<void>();
  let beginPublishingReached = false;
  let commits = 0;
  const coordinator: DurableScanJobCoordinator = {
    heartbeat: async () => undefined,
    beginPublishing: async () => {
      beginPublishingReached = true;
      beginReached.resolve();
      await releaseBegin.promise;
    },
    resolve: async () => undefined
  };
  const publication = inMemoryPublication(() => {
    commits += 1;
  });

  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator,
    scan: async () => r2ScanResult(),
    publication
  });
  await milestoneOrSettledJob(JOB_ID, beginReached.promise, () => beginPublishingReached, "coordinator.beginPublishing");
  assert.equal(commits, 0, "commit must wait for begin-publishing");
  assert.equal(
    durableScanJobFenceForTests(JOB_ID)?.publicationStarted,
    true,
    "the local fence must be set before coordinator approval resolves"
  );

  releaseBegin.resolve();
  await waitForScanJobForTests(JOB_ID);
  assert.equal(commits, 1);
  assert.equal(getScanJobStatus(JOB_ID)?.status, "succeeded");
  assert.deepEqual(durableScanJobFenceForTests(JOB_ID)?.owner, owner(1, LEASE_ONE));
});

test("terminal durable records are dropped from local memory without rewriting DO state", async () => {
  const preparation = await durablePreparation();
  await activateDurableScanJob(activation(preparation, 1, LEASE_ONE), {
    coordinator: recordingCoordinator([]),
    scan: async () => r2ScanResult(),
    publication: inMemoryPublication(),
    localCleanupDelayMs: 100
  });
  await waitForScanJobForTests(JOB_ID);
  assert.equal(scanJobStateForTests().retainedJobs, 1);

  // The record must leave local memory on the cleanup timer alone: no status,
  // admission, or pruning call happens while this process is idle, and the
  // introspection polled here is test-only observation, not a stimulus. A
  // fixed 125 ms sleep raced the 100 ms timer with 25 ms of margin, which is
  // exactly the failure shape that broke a container deploy on a contended
  // runner. Wait on the observable state instead, bounded so a cleanup timer
  // that never fires still fails this test loudly rather than hanging it.
  const cleanupDeadline = Date.now() + 5_000;
  while (scanJobStateForTests().retainedJobs > 0 && Date.now() < cleanupDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(scanJobStateForTests().retainedJobs, 0);
  assert.equal(getScanJobStatus(JOB_ID), null);
  assert.equal(durableScanJobFenceForTests(JOB_ID), null);
});

test("the coordinator client authenticates fixed-origin control posts without following redirects", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = createDurableScanJobCoordinatorClient({
    coordinatorUrl: "https://scanner.example",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(null, { status: 204 });
    }
  });

  await client.heartbeat(owner(1, LEASE_ONE), { completedRuns: 1 });
  assert.equal(capturedUrl, `https://scanner.example/__site-behavior-lab/durable-scans/${JOB_ID}/heartbeat`);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal(new Headers(capturedInit?.headers).get(DURABLE_SCAN_JOB_INTERNAL_HEADER), INTERNAL_TOKEN);
  // The renewal carries the run count, so a reader recovering this job from the
  // Durable Object is not told the worker is still on its first visit.
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    ...owner(1, LEASE_ONE),
    completedRuns: 1
  });
  assert.throws(
    () =>
      createDurableScanJobCoordinatorClient({
        coordinatorUrl: "http://scanner.example",
        internalToken: INTERNAL_TOKEN
      }),
    /https origin/i
  );
  assert.throws(
    () =>
      createDurableScanJobCoordinatorClient({
        coordinatorUrl: "https://scanner.example/private",
        internalToken: INTERNAL_TOKEN
      }),
    /https origin/i
  );
  assert.doesNotThrow(() =>
    createDurableScanJobCoordinatorClient({
      coordinatorUrl: "http://[::1]:8787",
      internalToken: INTERNAL_TOKEN
    })
  );
});

test("the coordinator client bounds a stalled control request", async () => {
  const client = createDurableScanJobCoordinatorClient({
    coordinatorUrl: "https://scanner.example",
    internalToken: INTERNAL_TOKEN,
    requestTimeoutMs: 5,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  });

  await assert.rejects(
    () => client.heartbeat(owner(1, LEASE_ONE), { completedRuns: 0 }),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === null
  );
});

test("private Node control authentication rejects missing and short secrets", () => {
  const authorized = new Request("https://scanner.example/private", {
    headers: { [DURABLE_SCAN_JOB_INTERNAL_HEADER]: INTERNAL_TOKEN }
  });
  assert.doesNotThrow(() => assertDurableScanJobInternalRequest(authorized, INTERNAL_TOKEN));
  assert.throws(
    () => assertDurableScanJobInternalRequest(new Request("https://scanner.example/private"), INTERNAL_TOKEN),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === 401
  );
  assert.throws(
    () =>
      assertDurableScanJobInternalRequest(
        new Request("https://scanner.example/private", {
          headers: { [DURABLE_SCAN_JOB_INTERNAL_HEADER]: "short" }
        }),
        "short"
      ),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === 401
  );
  assert.throws(
    () =>
      createDurableScanJobCoordinatorClient({
        coordinatorUrl: "https://scanner.example",
        internalToken: "short"
      }),
    /invalid durable scan-job internal token/i
  );
});

function preparedRequest(overrides: Partial<PreparedScanRequest> = {}): PreparedScanRequest {
  return {
    clientKey: "test-client",
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1,
    ...overrides
  };
}

async function durablePreparation(): Promise<DurableScanJobPreparation> {
  return prepareDurableScanJobRequest(new Request("https://scanner.invalid/api/scan"), {
    prepare: async () => preparedRequest(),
    requireReady: () => undefined,
    now: () => 1_721_260_800_000,
    createId: sequentialIds(JOB_ID, REPORT_ID)
  });
}

function preparationWithCapabilities(
  preparation: DurableScanJobPreparation,
  jobId: string,
  reportId: string
): DurableScanJobPreparation {
  return {
    payload: preparation.payload,
    submission: {
      ...preparation.submission,
      jobId,
      reportId,
      statusPath: `/api/scans/${jobId}`
    }
  };
}

function activation(
  preparation: DurableScanJobPreparation,
  generation: number,
  leaseToken: string
) {
  return {
    jobId: preparation.submission.jobId,
    generation,
    leaseToken,
    reportId: preparation.submission.reportId,
    payload: preparation.payload,
    coordinatorUrl: "https://scanner.example",
    internalToken: INTERNAL_TOKEN
  };
}

function owner(generation: number, leaseToken: string): DurableScanJobExecutionOwner {
  return { jobId: JOB_ID, generation, leaseToken };
}

function sequentialIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? ids.at(-1)!;
}

function r2ScanResult() {
  return scanMeasurementEnvelopeWithR2Run(makePublicSingleReportV2R2().run);
}

function recordingCoordinator(events: string[]): DurableScanJobCoordinator {
  return {
    heartbeat: async (lease) => {
      events.push(`heartbeat:${lease.generation}`);
    },
    beginPublishing: async (lease) => {
      events.push(`begin:${lease.generation}`);
    },
    resolve: async (lease, resolution) => {
      events.push(`resolve:${resolution.outcome}:${lease.generation}`);
    }
  };
}

function inMemoryPublication(onCommit: () => void = () => undefined) {
  return {
    prepare: (report: RuntimeScanReport, reportId: string) => prepareScanReportBundle(report, { shareId: reportId }),
    commit: async (bundle: ReturnType<typeof prepareScanReportBundle>) => {
      onCommit();
      return bundle.report;
    },
    reconcile: async () => ({ outcome: "missing" as const })
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void };
function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Await a milestone that only the durable publication path can reach. If the
 * job settles first (for example because report preparation threw before the
 * coordinator's beginPublishing ran, which is exactly what an unregistered
 * refreshed adblock identity causes), fail immediately with a diagnostic
 * instead of awaiting a deferred that can no longer resolve. Without this
 * guard such a regression deadlocks the file under node --test's default
 * zero test timeout and eats the whole CI job budget.
 */
async function milestoneOrSettledJob(
  jobId: string,
  milestone: Promise<void>,
  reached: () => boolean,
  label: string
): Promise<void> {
  await Promise.race([
    milestone,
    waitForScanJobForTests(jobId).then(() => {
      if (!reached()) {
        throw new Error(`scan job ${jobId} settled before ${label} was reached; durable publication never began`);
      }
    })
  ]);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  durableScanJobCancellationResponse,
  DurableScanJobRecoveryTimeoutError,
  DURABLE_SCAN_JOB_RECOVERY_ERROR_MAX_BYTES,
  DURABLE_SCAN_JOB_RECOVERY_REPORT_MAX_BYTES,
  publicDurableScanJobStatus,
  recoverDurableScanJobCancellationResponse,
  recoverDurableScanJobResponse,
  recoverDurableScanJobSnapshotResponse,
  type DurableScanJobInternalState
} from "./durable-scan-job-recovery";
import type { DurableScanJobRegistration } from "./durable-scan-job-registry";
import { readScanJobProgress, scanJobProgressCopy } from "./scan-job-progress";
import { makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

const JOB_ID = `20260713-${"a".repeat(32)}`;
const REPORT_ID = `20260713-${"b".repeat(32)}`;
const REGISTRATION: DurableScanJobRegistration = {
  jobId: JOB_ID,
  reportId: REPORT_ID,
  totalRuns: 2,
  createdAt: 1_000
};

test("known persisted jobs recover as succeeded with the saved report", async () => {
  const report = makeScanReportV1();
  const response = await recover({ reportResponse: Response.json(report) });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    jobId: JOB_ID,
    status: "succeeded",
    progress: { phase: "saving", completedRuns: 2, totalRuns: 2 },
    report
  });
});

test("known r2 jobs recover as succeeded without a root ok and preserve the exact report", async () => {
  const report = makeShieldsInterventionReportV2R2();
  const response = await recover({ reportResponse: Response.json(report) });

  assert.equal(response.status, 200);
  const recovered = await response.json();
  assert.deepEqual(recovered, {
    ok: true,
    jobId: JOB_ID,
    status: "succeeded",
    progress: { phase: "saving", completedRuns: 2, totalRuns: 2 },
    report
  });
  assert.deepEqual(recovered.report, report);
  assert.equal("ok" in recovered.report, false);
});

test("known jobs with no saved report recover as explicit restart expiry", async () => {
  const response = await recover({ reportResponse: Response.json({ ok: false }, { status: 404 }) });
  assert.deepEqual(await response.json(), {
    ok: true,
    jobId: JOB_ID,
    status: "expired",
    error:
      "The scanner lost this job's in-memory status, and no saved report is available, so the job can no longer be recovered."
  });
});

test("unknown jobs retain the container's original 404 without probing reports", async () => {
  const original = missingResponse();
  let probes = 0;
  const response = await recoverDurableScanJobResponse(JOB_ID, original, {
    findRegistration: async () => null,
    fetchReport: async () => {
      probes += 1;
      return Response.json({ ok: false }, { status: 404 });
    }
  });

  assert.equal(response, original);
  assert.equal(probes, 0);
});

test("report rate limits and storage faults are bounded and sanitized without false expiry", async () => {
  for (const status of [429, 500]) {
    const probe = Response.json(
      { ok: false, error: `private internal probe ${status}` },
      {
        status,
        headers: {
          "x-internal-storage-detail": "secret",
          "retry-after": status === 429 ? "17" : "not-safe"
        }
      }
    );
    const response = await recover({ reportResponse: probe });
    assert.notEqual(response, probe);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-internal-storage-detail"), null);
    assert.equal(response.headers.get("retry-after"), status === 429 ? "17" : null);
    const wire = await response.text();
    assert.doesNotMatch(wire, /private internal probe|storage-detail|secret/i);
    assert.deepEqual(JSON.parse(wire), {
      ok: false,
      error: "The saved scan report is temporarily unavailable during restart recovery."
    });
  }
});

test("non-success report bodies remain bounded and cannot leak internal responses", async () => {
  let cancelled = false;
  const response = await recover({
    reportResponse: new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        }
      }),
      {
        status: 500,
        headers: {
          "content-length": String(DURABLE_SCAN_JOB_RECOVERY_ERROR_MAX_BYTES + 1),
          "x-internal-error": "database credentials"
        }
      }
    )
  });

  assert.equal(cancelled, true);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-internal-error"), null);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "The saved scan report could not be read during restart recovery."
  });
});

test("authoritative status also sanitizes bounded non-success report responses", async () => {
  const response = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "succeeded", totalRuns: 1 },
    missingResponse(),
    {
      fetchReport: async () =>
        new Response("private backend overload detail", {
          status: 503,
          headers: {
            "retry-after": "9",
            "x-internal-backend": "secret"
          }
        })
    }
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "9");
  assert.equal(response.headers.get("x-internal-backend"), null);
  const wire = await response.text();
  assert.doesNotMatch(wire, /private backend|internal-backend|secret/i);
  assert.deepEqual(JSON.parse(wire), {
    ok: false,
    error: "The saved scan report is temporarily unavailable during durable recovery."
  });
});

test("registry and report transport failures preserve the original retryable 404", async () => {
  for (const failure of ["registry", "report"] as const) {
    const original = missingResponse();
    const seen: unknown[] = [];
    const response = await recoverDurableScanJobResponse(JOB_ID, original, {
      findRegistration: async () => {
        if (failure === "registry") throw new Error("registry unavailable");
        return REGISTRATION;
      },
      fetchReport: async () => {
        throw new Error("report unavailable");
      },
      onRegistryError: (error) => seen.push(error),
      onReportError: (error) => seen.push(error)
    });

    assert.equal(response, original);
    assert.equal(seen.length, 1);
  }
});

test("malformed successful report responses become named gateway errors", async () => {
  const response = await recover({ reportResponse: Response.json({ ok: false }) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "The saved scan report was invalid during restart recovery."
  });
});

test("durable recovery rejects oversized successful report bodies before buffering", async () => {
  let restartCancelled = false;
  const restart = await recover({
    reportResponse: declaredOversizedReportResponse(() => { restartCancelled = true; })
  });
  assert.equal(restart.status, 502);
  assert.equal(restartCancelled, true);
  assert.deepEqual(await restart.json(), {
    ok: false,
    error: "The saved scan report could not be read during restart recovery."
  });

  let snapshotCancelled = false;
  const snapshot = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "succeeded", totalRuns: 2 },
    missingResponse(),
    {
      fetchReport: async () => declaredOversizedReportResponse(() => { snapshotCancelled = true; })
    }
  );
  assert.equal(snapshot.status, 502);
  assert.equal(snapshotCancelled, true);
  assert.deepEqual(await snapshot.json(), {
    ok: false,
    error: "The saved scan report could not be read during durable recovery."
  });
});

test("authoritative recovery bounds report time-to-headers and aborts the fetch signal", async () => {
  let fetchSignalAborted = false;
  const seen: unknown[] = [];
  const response = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "succeeded", totalRuns: 2 },
    missingResponse(),
    {
      fetchReport: async (_reportId, signal) => {
        signal.addEventListener("abort", () => {
          fetchSignalAborted = true;
        }, { once: true });
        await new Promise<void>(() => undefined);
        return Response.json({});
      },
      operationTimeoutMs: 10,
      onReportError: (error) => seen.push(error)
    }
  );

  assert.equal(response.status, 503);
  assert.equal(fetchSignalAborted, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "The saved scan report could not be read during durable recovery."
  });
});

test("authoritative recovery's same deadline covers a stalled successful body", async () => {
  let cancelled = false;
  const response = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "succeeded", totalRuns: 1 },
    missingResponse(),
    {
      fetchReport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([123]));
            },
            cancel() {
              cancelled = true;
            }
          }),
          { status: 200 }
        ),
      operationTimeoutMs: 10
    }
  );
  assert.equal(response.status, 503);
  assert.equal(cancelled, true);
});

test("Phase-1 report recovery also bounds headers while preserving its retryable original response", async () => {
  const original = missingResponse();
  let signalAborted = false;
  const response = await recoverDurableScanJobResponse(JOB_ID, original, {
    findRegistration: async () => REGISTRATION,
    fetchReport: async (_reportId, signal) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
      }, { once: true });
      await new Promise<void>(() => undefined);
      return Response.json({});
    },
    operationTimeoutMs: 10
  });
  assert.equal(response, original);
  assert.equal(signalAborted, true);
});

test("Phase-1 recovery's whole deadline includes the Durable Object registry lookup", async () => {
  const original = missingResponse();
  let lookupSignalAborted = false;
  let reportProbes = 0;
  const seen: unknown[] = [];
  const response = await recoverDurableScanJobResponse(JOB_ID, original, {
    findRegistration: async (_jobId, signal) => {
      signal.addEventListener("abort", () => {
        lookupSignalAborted = true;
      }, { once: true });
      await new Promise<void>(() => undefined);
      return REGISTRATION;
    },
    fetchReport: async () => {
      reportProbes += 1;
      return Response.json({});
    },
    operationTimeoutMs: 10,
    onRegistryError: (error) => seen.push(error)
  });

  assert.equal(response, original);
  assert.equal(lookupSignalAborted, true);
  assert.equal(reportProbes, 0);
  assert.equal(seen.length, 1);
});

test("a stalled saved-report 404 remains retryable instead of fabricating expiry", async () => {
  const original = missingResponse();
  let cancelled = false;
  const response = await recoverDurableScanJobResponse(JOB_ID, original, {
    findRegistration: async () => REGISTRATION,
    fetchReport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          }
        }),
        { status: 404 }
      ),
    operationTimeoutMs: 10
  });

  assert.equal(response, original);
  assert.equal(cancelled, true);
});

test("DELETE recovery is control-only and never returns a saved report", async () => {
  const response = await recoverDurableScanJobCancellationResponse(JOB_ID, missingResponse(), {
    findRegistration: async () => REGISTRATION
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "This scan job can no longer be cancelled because its in-memory status was lost."
  });
});

test("DELETE for an unknown job preserves the original 404", async () => {
  const original = missingResponse();
  const response = await recoverDurableScanJobCancellationResponse(JOB_ID, original, {
    findRegistration: async () => null
  });
  assert.equal(response, original);
});

test("DELETE recovery's whole deadline includes the Durable Object registry lookup", async () => {
  const original = missingResponse();
  let lookupSignalAborted = false;
  const seen: unknown[] = [];
  const response = await recoverDurableScanJobCancellationResponse(JOB_ID, original, {
    findRegistration: async (_jobId, signal) => {
      signal.addEventListener("abort", () => {
        lookupSignalAborted = true;
      }, { once: true });
      await new Promise<void>(() => undefined);
      return REGISTRATION;
    },
    operationTimeoutMs: 10,
    onRegistryError: (error) => seen.push(error)
  });

  assert.equal(response, original);
  assert.equal(lookupSignalAborted, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof DurableScanJobRecoveryTimeoutError);
});

test("internal durable states collapse to the existing public status vocabulary", () => {
  const expected: Record<DurableScanJobInternalState, string> = {
    queued: "queued",
    leased: "running",
    publishing: "running",
    succeeded: "succeeded",
    failed: "failed",
    expired: "expired",
    cancelled: "cancelled"
  };
  for (const [state, status] of Object.entries(expected) as Array<[DurableScanJobInternalState, string]>) {
    assert.equal(publicDurableScanJobStatus(state), status);
  }
});

test("authoritative durable status never leaks internal state or storage metadata", async () => {
  for (const state of ["queued", "leased", "publishing", "failed", "expired", "cancelled"] as const) {
    const response = await recoverDurableScanJobSnapshotResponse(
      {
        jobId: JOB_ID,
        reportId: REPORT_ID,
        state,
        totalRuns: 2,
        leaseToken: "secret",
        ciphertext: "secret",
        publicationManifest: "secret"
      } as any,
      missingResponse(),
      { fetchReport: async () => assert.fail("non-succeeded states must not probe the report store") }
    );
    const wire = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(wire, /leased|publishing|leaseToken|ciphertext|publicationManifest|reportId|secret/);
    const parsed = JSON.parse(wire);
    assert.equal(parsed.status, publicDurableScanJobStatus(state));
    if (state === "expired") {
      assert.match(parsed.error, /completion could not be confirmed/i);
      assert.doesNotMatch(parsed.error, /no report|never landed/i);
    }
  }
});

test("authoritative durable success embeds the exact saved report", async () => {
  for (const report of [makeScanReportV1(), makeShieldsInterventionReportV2R2()]) {
    const response = await recoverDurableScanJobSnapshotResponse(
      { jobId: JOB_ID, reportId: REPORT_ID, state: "succeeded", totalRuns: 2 },
      missingResponse(),
      {
        fetchReport: async (reportId) => {
          assert.equal(reportId, REPORT_ID);
          return Response.json(report);
        }
      }
    );
    assert.deepEqual(await response.json(), {
      ok: true,
      jobId: JOB_ID,
      status: "succeeded",
      progress: { phase: "saving", completedRuns: 2, totalRuns: 2 },
      report
    });
  }
});

test("authoritative status emits attempt evidence only when the staging hook supplies it", async () => {
  const response = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "queued", totalRuns: 1 },
    missingResponse(),
    {
      fetchReport: async () => assert.fail("queued states must not probe the report store"),
      stagingFaultEvidence: {
        faultMode: "lease-expiry",
        attempts: 2,
        triggered: true,
        triggeredGeneration: 1,
        finishedBeforeStatusRequest: false
      }
    }
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    jobId: JOB_ID,
    status: "queued",
    progress: { phase: "queued", completedRuns: 0, totalRuns: 1 },
    durable: {
      faultMode: "lease-expiry",
      attempts: 2,
      triggered: true,
      triggeredGeneration: 1,
      finishedBeforeStatusRequest: false
    }
  });

  const production = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "queued", totalRuns: 1 },
    missingResponse(),
    { fetchReport: async () => assert.fail("queued states must not probe the report store") }
  );
  assert.equal("durable" in (await production.json()), false);
});

test("authoritative durable cancellation is control-only and idempotent", async () => {
  const response = durableScanJobCancellationResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "cancelled", totalRuns: 1 },
    missingResponse()
  );
  const wire = await response.text();
  assert.doesNotMatch(wire, new RegExp(REPORT_ID));
  assert.deepEqual(JSON.parse(wire), {
    ok: true,
    jobId: JOB_ID,
    status: "cancelled",
    progress: { phase: "waiting", completedRuns: 0, totalRuns: 1 },
    error: "This scan job was cancelled."
  });
});

test("a leased durable job reports running with progress the client validator accepts", async () => {
  const response = await recoverDurableScanJobSnapshotResponse(
    { jobId: JOB_ID, reportId: REPORT_ID, state: "leased", totalRuns: 1 },
    missingResponse(),
    { fetchReport: async () => assert.fail("a leased job must not probe the report store") }
  );
  const parsed = await response.json();
  assert.equal(parsed.status, "running");

  // The polling client drops progress it cannot validate and then never calls
  // onProgress, so a phase outside the closed wire vocabulary would freeze an
  // already deployed page on stale copy for the whole measurement.
  const progress = readScanJobProgress(parsed.progress);
  if (!progress) assert.fail("the leased wire progress must survive the client validator");
  assert.equal(progress.totalRuns, 1);

  // The reader must not describe a lease a runner already holds as a wait for a
  // slot. The slot wait belongs to the queued phase and only there.
  const running = scanJobProgressCopy(progress);
  const queued = scanJobProgressCopy({ phase: "queued", completedRuns: 0, totalRuns: 1 });
  assert.match(`${queued.title} ${queued.detail}`, /queued|waiting to start/i);
  assert.doesNotMatch(`${running.title} ${running.detail}`, /waiting|slot|queued/i);
  assert.match(`${running.title} ${running.detail}`, /in progress|has started/i);
});

function missingResponse(): Response {
  return Response.json(
    { ok: false, error: "Scan job not found." },
    { status: 404, headers: { "access-control-allow-origin": "https://sitebehavior.org" } }
  );
}

function declaredOversizedReportResponse(onCancel: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ cancel: onCancel }),
    {
      status: 200,
      headers: { "content-length": String(DURABLE_SCAN_JOB_RECOVERY_REPORT_MAX_BYTES + 1) }
    }
  );
}

function recover({ reportResponse }: { reportResponse: Response }): Promise<Response> {
  return recoverDurableScanJobResponse(JOB_ID, missingResponse(), {
    findRegistration: async () => REGISTRATION,
    fetchReport: async (reportId) => {
      assert.equal(reportId, REPORT_ID);
      return reportResponse;
    }
  });
}

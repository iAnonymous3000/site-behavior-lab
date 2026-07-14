import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recoverDurableScanJobCancellationResponse,
  recoverDurableScanJobResponse
} from "./durable-scan-job-recovery";
import type { DurableScanJobRegistration } from "./durable-scan-job-registry";
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

test("report rate limits and storage faults never become false expiry", async () => {
  for (const status of [429, 500]) {
    const probe = Response.json({ ok: false, error: `probe ${status}` }, { status });
    const response = await recover({ reportResponse: probe });
    assert.equal(response, probe);
    assert.equal(response.status, status);
  }
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

function missingResponse(): Response {
  return Response.json(
    { ok: false, error: "Scan job not found." },
    { status: 404, headers: { "access-control-allow-origin": "https://sitebehavior.org" } }
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

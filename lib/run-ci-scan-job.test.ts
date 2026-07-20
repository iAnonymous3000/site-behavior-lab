import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type JobPollingHelpers = {
  awaitSubmittedScanJob(options: {
    submission: { jobId: string; statusPath: string };
    baseUrl: string;
    headers?: Record<string, string>;
    isPublishableScanReport: (value: unknown) => boolean;
    fetcher?: (input: string, init: RequestInit) => Promise<Response>;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
  }): Promise<unknown>;
};

const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<JobPollingHelpers>;
const helpers = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts", "run-ci-scan-job.mjs")).href
);

const SUBMISSION = {
  jobId: `20260719-${"a".repeat(32)}`,
  statusPath: `/api/scans/20260719-${"a".repeat(32)}`
};
const REPORT = Object.freeze({ schemaVersion: 1, reportType: "single" });
const isReport = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).schemaVersion === 1 &&
      (value as Record<string, unknown>).reportType === "single"
  );

test("CI publisher follows server state past the old 180-second timeout", async () => {
  const { awaitSubmittedScanJob } = await helpers;
  let calls = 0;
  let clock = 0;
  const waits: number[] = [];

  const report = await awaitSubmittedScanJob({
    submission: SUBMISSION,
    baseUrl: "https://scanner.example",
    isPublishableScanReport: isReport,
    fetcher: async (input) => {
      calls += 1;
      assert.equal(input, `https://scanner.example${SUBMISSION.statusPath}`);
      return calls <= 181
        ? jobResponse("queued")
        : jobResponse("succeeded", { report: REPORT });
    },
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock
  });

  assert.deepEqual(report, REPORT);
  assert.equal(calls, 182);
  assert.ok(clock > 180_000);
  assert.equal(waits.at(-1), 5_000);
});

test("CI publisher retries bounded transient status responses", async () => {
  const { awaitSubmittedScanJob } = await helpers;
  let calls = 0;
  const waits: number[] = [];

  const report = await awaitSubmittedScanJob({
    submission: SUBMISSION,
    baseUrl: "https://scanner.example",
    headers: { authorization: "Bearer smoke" },
    isPublishableScanReport: isReport,
    fetcher: async (_input, init) => {
      calls += 1;
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer smoke");
      if (calls === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "7" } });
      if (calls === 2) return new Response("busy", { status: 503 });
      return jobResponse("succeeded", { report: REPORT });
    },
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  assert.deepEqual(report, REPORT);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [7_000, 2_000]);
});

test("CI publisher fails a sustained transient cycle instead of retrying forever", async () => {
  const { awaitSubmittedScanJob } = await helpers;
  let calls = 0;
  const waits: number[] = [];

  await assert.rejects(
    awaitSubmittedScanJob({
      submission: SUBMISSION,
      baseUrl: "https://scanner.example",
      isPublishableScanReport: () => false,
      fetcher: async () => {
        calls += 1;
        return new Response("busy", { status: 502 });
      },
      wait: async (ms) => {
        waits.push(ms);
      }
    }),
    /temporarily unavailable \(HTTP 502\)/
  );

  assert.equal(calls, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("CI publisher rejects cross-origin and non-status job paths", async () => {
  const { awaitSubmittedScanJob } = await helpers;
  for (const statusPath of ["https://other.example/api/scans/job", "/api/reports/job", "/api/scans/job?raw=1"]) {
    await assert.rejects(
      awaitSubmittedScanJob({
        submission: { ...SUBMISSION, statusPath },
        baseUrl: "https://scanner.example",
        isPublishableScanReport: () => true
      }),
      /invalid status path/
    );
  }
});

function jobResponse(
  status: "queued" | "running" | "succeeded",
  extra: Record<string, unknown> = {}
): Response {
  return Response.json({ ok: true, jobId: SUBMISSION.jobId, status, ...extra });
}

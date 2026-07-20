import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pollAcceptedScanJob,
  retryAfterMs,
  scanJobPollIntervalMs,
  ScanJobEndedError,
  type ScanJobPollFetcher
} from "./scan-job-polling";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

const JOB_ID = `20260718-${"a".repeat(32)}`;
const REPORT_ID = `20260718-${"b".repeat(32)}`;
const STATUS_PATH = `/api/scans/${JOB_ID}`;

test("an accepted job keeps polling past the old 180-second client limit", async () => {
  let calls = 0;
  let clock = 0;
  const waits: number[] = [];
  const fetcher: ScanJobPollFetcher = async () => {
    calls += 1;
    if (calls <= 181) return jobResponse("queued");
    return jobResponse("succeeded", { report: makeScanReportV1() });
  };

  const loaded = await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    fetcher,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    }
  });

  assert.equal(loaded.source, "v1");
  assert.equal(calls, 182);
  assert.ok(clock > 180_000);
  assert.equal(waits.at(-1), 5_000, "long-lived jobs should back off after three minutes");
});

test("status polling retries 429/502/503 and honors bounded Retry-After", async () => {
  let calls = 0;
  const waits: number[] = [];
  let transientBodyCancelled = false;
  const fetcher: ScanJobPollFetcher = async (_url, init) => {
    calls += 1;
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer scanner-key");
    if (calls === 1) {
      const stream = new ReadableStream({
        cancel() {
          transientBodyCancelled = true;
        }
      });
      return new Response(stream, { status: 429, headers: { "Retry-After": "7" } });
    }
    if (calls === 2) return new Response("bad gateway", { status: 503 });
    return jobResponse("succeeded", { report: makeScanReportV1() });
  };

  await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    accessKey: "scanner-key",
    fetcher,
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [7_000, 2_000]);
  assert.equal(transientBodyCancelled, true);
});

test("sustained transient status failures return a resumable ordinary error", async () => {
  let calls = 0;
  let cancelledBodies = 0;
  const waits: number[] = [];
  const fetcher: ScanJobPollFetcher = async () => {
    calls += 1;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelledBodies += 1;
        }
      }),
      { status: 503 }
    );
  };

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      fetcher,
      wait: async (ms) => {
        waits.push(ms);
      }
    }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ScanJobEndedError) &&
      /temporarily unavailable \(HTTP 503\)/.test(error.message)
  );

  assert.equal(calls, 4, "one request plus three bounded retries");
  assert.equal(cancelledBodies, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
});

test("saved-report recovery retries transient faults and honors HTTP-date Retry-After", async () => {
  const now = Date.UTC(2026, 6, 18, 12, 0, 0);
  const calls: string[] = [];
  const waits: number[] = [];
  const fetcher: ScanJobPollFetcher = async (url) => {
    calls.push(url);
    if (url === STATUS_PATH) {
      return Response.json({ ok: false, error: "Scan job not found." }, { status: 404 });
    }
    if (calls.filter((entry) => entry === `/api/reports/${REPORT_ID}`).length === 1) {
      return new Response("temporarily unavailable", {
        status: 502,
        headers: { "Retry-After": new Date(now + 5_000).toUTCString() }
      });
    }
    return Response.json(makeScanReportV1());
  };

  const loaded = await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    fetcher,
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  assert.equal(loaded.source, "v1");
  assert.deepEqual(calls, [STATUS_PATH, `/api/reports/${REPORT_ID}`, `/api/reports/${REPORT_ID}`]);
  assert.deepEqual(waits, [5_000]);
});

test("non-transient polling faults remain resumable errors, while real job endings are classified", async () => {
  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      fetcher: async () => Response.json({ ok: false, error: "status backend broke" }, { status: 500 })
    }),
    (error: unknown) => error instanceof Error && !(error instanceof ScanJobEndedError) && /backend broke/.test(error.message)
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      fetcher: async () => jobResponse("expired", { error: "The durable deadline elapsed." })
    }),
    (error: unknown) =>
      error instanceof ScanJobEndedError && error.status === "expired" && /deadline elapsed/.test(error.message)
  );
});

test("poll and Retry-After delays are bounded and progressively backed off", () => {
  assert.equal(scanJobPollIntervalMs(0), 1_000);
  assert.equal(scanJobPollIntervalMs(3 * 60_000), 5_000);
  assert.equal(scanJobPollIntervalMs(10 * 60_000), 10_000);
  assert.equal(retryAfterMs("2", 0), 2_000);
  assert.equal(retryAfterMs("999999999999999999999", 0), 30_000);
  assert.equal(retryAfterMs(new Date(60_000).toUTCString(), 0), 30_000);
  assert.equal(retryAfterMs("not a delay", 0), null);
});

function jobResponse(
  status: "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled",
  extra: Record<string, unknown> = {}
): Response {
  return Response.json({ ok: true, jobId: JOB_ID, status, ...extra });
}

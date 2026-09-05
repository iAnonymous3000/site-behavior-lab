import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pollAcceptedScanJob,
  retryAfterMs,
  scanJobPollIntervalMs,
  ScanJobEndedError,
  type ScanJobPollFetcher
} from "./scan-job-polling";
import {
  ClientFetchTimeoutError,
  ClientResponseTooLargeError
} from "./client-fetch-policy";
import { buildReportShare } from "./report-locator";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

const JOB_ID = `20260718-${"a".repeat(32)}`;
const REPORT_ID = `20260718-${"b".repeat(32)}`;
const OTHER_JOB_ID = `20260718-${"c".repeat(32)}`;
const OTHER_REPORT_ID = `20260718-${"d".repeat(32)}`;
const STATUS_PATH = `/api/scans/${JOB_ID}`;

test("a missing job and missing saved report end recovery with an actionable outcome", async () => {
  await assert.rejects(pollAcceptedScanJob({
    statusPath: STATUS_PATH, reportId: REPORT_ID,
    fetcher: async () => new Response(JSON.stringify({ok: false, error: "Scan job not found"}), {status: 404, headers: {"content-type": "application/json"}}),
    wait: async () => undefined
  }), (error: unknown) => error instanceof ScanJobEndedError && error.status === "expired" && /Start a new scan/.test(error.message));
});

test("an accepted job keeps polling past the old 180-second client limit", async () => {
  let calls = 0;
  let clock = 0;
  const waits: number[] = [];
  const fetcher: ScanJobPollFetcher = async () => {
    calls += 1;
    if (calls <= 181) return jobResponse("queued");
    return jobResponse("succeeded", { report: savedReport() });
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

test("polling forwards only validated server progress in observed order", async () => {
  const seen: unknown[] = [];
  let calls = 0;
  const loaded = await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        return jobResponse("queued", {
          progress: { phase: "queued", completedRuns: 0, totalRuns: 2 }
        });
      }
      if (calls === 2) {
        return jobResponse("running", {
          progress: { phase: "navigating", completedRuns: 1, totalRuns: 2 }
        });
      }
      return jobResponse("succeeded", {
        progress: { phase: "saving", completedRuns: 2, totalRuns: 2 },
        report: savedReport()
      });
    },
    wait: async () => undefined,
    onProgress: (progress) => seen.push(progress)
  });

  assert.equal(loaded.source, "v1");
  assert.deepEqual(seen, [
    { phase: "queued", completedRuns: 0, totalRuns: 2 },
    { phase: "navigating", completedRuns: 1, totalRuns: 2 },
    { phase: "saving", completedRuns: 2, totalRuns: 2 }
  ]);
});

test("polling ignores malformed progress instead of exposing untrusted fields", async () => {
  let calls = 0;
  const seen: unknown[] = [];
  await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? jobResponse("running", {
            progress: { phase: "collecting", completedRuns: 0, totalRuns: 1, leaked: "secret" }
          })
        : jobResponse("succeeded", { report: savedReport() });
    },
    wait: async () => undefined,
    onProgress: (progress) => seen.push(progress)
  });
  assert.deepEqual(seen, []);
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
    return jobResponse("succeeded", { report: savedReport() });
  };

  await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
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
      reportId: REPORT_ID,
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

test("each polling attempt bounds a connection that never returns headers", async () => {
  let requestSignal: AbortSignal | null = null;
  const fetcher: ScanJobPollFetcher = async (_url, init) => {
    requestSignal = init.signal ?? null;
    return new Promise<Response>(() => undefined);
  };

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher,
      attemptTimeoutMs: 5
    }),
    (error: unknown) =>
      error instanceof ClientFetchTimeoutError && error.phase === "connect" && error.timeoutMs === 5
  );
  assert.equal((requestSignal as AbortSignal | null)?.aborted, true);
});

test("the per-attempt deadline remains armed while a status body is stalled", async () => {
  const partial = new TextEncoder().encode('{"ok":true');
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partial);
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => response,
      attemptTimeoutMs: 5
    }),
    (error: unknown) =>
      error instanceof ClientFetchTimeoutError && error.phase === "operation" && error.timeoutMs === 5
  );
});

test("caller cancellation wins over the polling attempt deadline", async () => {
  const controller = new AbortController();
  const reason = new DOMException("The visitor cancelled the accepted scan.", "AbortError");
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const polling = pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    signal: controller.signal,
    attemptTimeoutMs: 1_000,
    fetcher: async () => {
      markStarted();
      return new Promise<Response>(() => undefined);
    }
  });
  await started;
  controller.abort(reason);
  await assert.rejects(polling, (error: unknown) => error === reason);
});

test("status payloads cannot exceed the decompressed browser response cap", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>(),
    { headers: { "content-length": String(BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES + 1) } }
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => response
    }),
    (error: unknown) =>
      error instanceof ClientResponseTooLargeError && error.maxBytes === BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES
  );
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
    return Response.json(savedReport());
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
      reportId: REPORT_ID,
      fetcher: async () => Response.json({ ok: false, error: "status backend broke" }, { status: 500 })
    }),
    (error: unknown) => error instanceof Error && !(error instanceof ScanJobEndedError) && /backend broke/.test(error.message)
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => jobResponse("expired", { error: "The durable deadline elapsed." })
    }),
    (error: unknown) =>
      error instanceof ScanJobEndedError && error.status === "expired" && /deadline elapsed/.test(error.message)
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => jobResponse("succeeded", { report: { secret: "not a report" } })
    }),
    (error: unknown) => error instanceof Error && !(error instanceof ScanJobEndedError)
  );
});

test("successful status payloads require a 2xx response and the exact accepted job id", async () => {
  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => Response.json(
        { ok: true, jobId: JOB_ID, status: "succeeded", report: savedReport() },
        { status: 500 }
      )
    }),
    /could not be read \(HTTP 500\)/
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => Response.json({
        ok: true,
        jobId: OTHER_JOB_ID,
        status: "succeeded",
        report: savedReport()
      })
    }),
    /could not be read \(HTTP 200\)/
  );
});

test("completed and recovered reports require the exact reserved report identity", async () => {
  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async () => jobResponse("succeeded", { report: savedReport(OTHER_REPORT_ID) })
    }),
    /did not match its reserved report identity/
  );

  await assert.rejects(
    pollAcceptedScanJob({
      statusPath: STATUS_PATH,
      reportId: REPORT_ID,
      fetcher: async (url) => url === STATUS_PATH
        ? Response.json({ ok: false, error: "Scan job not found." }, { status: 404 })
        : Response.json(savedReport(OTHER_REPORT_ID))
    }),
    /did not match its reserved report identity/
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

function savedReport(reportId = REPORT_ID) {
  const report = makeScanReportV1();
  report.share = buildReportShare(reportId);
  return report;
}

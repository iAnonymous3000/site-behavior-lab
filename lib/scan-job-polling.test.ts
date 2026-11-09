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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { attachScrollCheckEvidence, createNodeScanMeasurementEnvelope, type NodeScanMeasurement } from "./node-scan-measurement";
import { buildReportShare } from "./report-locator";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import type { ReportSaver, ScanRunner } from "./scan-api";
import { unshownScrollCheckNotice } from "./scan-client-orchestration";
import { enqueuePreparedScanJob, getScanJobStatus, resetScanJobStateForTests, waitForScanJobForTests } from "./scan-jobs";
import { resetScanLimitStateForTests } from "./scan-limits";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";
import type { ScrollCheckEvidence } from "./scroll-check-evidence";

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

test("a finished after-scrolling check's job status is its result, though no report was saved under the reserved id", async () => {
  const { submission, status, evidence } = await finishedScrollCheckJob();
  // The status exactly as the scanner serves it: a check's report carries its evidence and no share.
  assert.equal(status.status, "succeeded");
  assert.equal(isPlainRecord(status.report) && "share" in status.report, false);
  const serve = (body: unknown): ScanJobPollFetcher => async (url) =>
    url === submission.statusPath
      ? Response.json(body)
      : Response.json({ ok: false, error: "Report not found." }, { status: 404 });

  const loaded = await pollAcceptedScanJob({
    statusPath: submission.statusPath,
    reportId: submission.reportId,
    fetcher: serve(status),
    wait: async () => undefined
  });
  if (loaded.source !== "v2-r2-ephemeral" || loaded.wire.reportType !== "single") throw new Error("expected the check's own r2 shell");
  assert.deepEqual(loaded.wire.ephemeral.scrollCheck, evidence);

  // Having no share excuses only a check. The same shell without its check is
  // an ordinary result that should have been saved under the reserved id.
  const withoutCheck = structuredClone(status) as { report: { ephemeral: { scrollCheck?: unknown } } };
  delete withoutCheck.report.ephemeral.scrollCheck;
  await assert.rejects(
    pollAcceptedScanJob({ statusPath: submission.statusPath, reportId: submission.reportId, fetcher: serve(withoutCheck), wait: async () => undefined }),
    /did not match its reserved report identity/
  );
  // And a share that names another report is refused whatever the result carries.
  const otherShare = structuredClone(status) as { report: { share?: unknown } };
  otherShare.report.share = buildReportShare(OTHER_REPORT_ID);
  await assert.rejects(
    pollAcceptedScanJob({ statusPath: submission.statusPath, reportId: submission.reportId, fetcher: serve(otherShare), wait: async () => undefined }),
    /did not match its reserved report identity/
  );
});

test("a finished check that no submit is waiting for is named in a sentence, and every result the page shows is not", async () => {
  const { submission, status } = await finishedScrollCheckJob();
  const check = await pollAcceptedScanJob({
    statusPath: submission.statusPath,
    reportId: submission.reportId,
    fetcher: async () => Response.json(status),
    wait: async () => undefined
  });
  // A resumed or restored tab asked for nothing: it shows no result, so it has to say what happened.
  const notice = unshownScrollCheckNotice(check, null);
  assert.equal(
    notice,
    "The check after scrolling finished, but nothing from it is saved and its result can no longer be shown here, so run the check again to see it."
  );
  // The submit that asked for the check shows its result.
  assert.equal(unshownScrollCheckNotice(check, { from: null }), null);
  // An ordinary result is shown on every path.
  const ordinary = await pollAcceptedScanJob({
    statusPath: STATUS_PATH,
    reportId: REPORT_ID,
    fetcher: async () => jobResponse("succeeded", { report: savedReport() })
  });
  assert.equal(unshownScrollCheckNotice(ordinary, null), null);
});

test("a status read that gets no answer, or a failure with no readable reason, keeps the job and says which", async () => {
  const poll = (fetcher: ScanJobPollFetcher) =>
    pollAcceptedScanJob({ statusPath: STATUS_PATH, reportId: REPORT_ID, fetcher, wait: async () => undefined });

  await assert.rejects(
    poll(async () => {
      throw new TypeError("Failed to fetch");
    }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ScanJobEndedError) &&
      error.message === "No usable answer came back from the scanner, which may mean it could not be reached."
  );
  // An edge's error page on a status the poller does not retry.
  await assert.rejects(
    poll(async () => new Response("<html>error</html>", { status: 500, headers: { "content-type": "text/html" } })),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ScanJobEndedError) &&
      error.message === "The scanner answered HTTP 500 without a readable reason."
  );
  // A 2xx that is not JSON is still called that.
  await assert.rejects(poll(async () => new Response("not json", { status: 200 })), /returned invalid JSON/);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 1x1 PNG, so the status holds a screenshot the browser reader accepts, as a real visit's does. */
const SCREENSHOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * The job status an async scanner serves for a finished after-scrolling
 * check, produced by the scanner's own job queue and builder rather than
 * written by hand: the poller has to accept what the server really sends.
 * Returned after a JSON round trip, as the browser receives it.
 */
async function finishedScrollCheckJob() {
  const evidence: ScrollCheckEvidence = {
    outcome: "reached-end",
    screens: 3,
    control: { hosts: [{ site: "timer.org", hosts: ["pixel.timer.org"] }], hostCount: 1, siteCount: 1, requests: 2 },
    scroll: {
      hosts: [
        { site: "lazy.net", hosts: ["cdn.lazy.net", "{label}.lazy.net"] },
        { site: "beacon.org", hosts: ["beacon.org"] }
      ],
      hostCount: 3,
      siteCount: 2,
      requests: 8,
      knownHostRequests: 5
    },
    incomplete: [],
    addressChanged: false
  };
  const names = [PUBLIC_R2_REPORTS_ENV, BUILD_COMMIT_ENV, CONSENT_VERIFICATION_ENV, "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR"];
  const before = names.map((name) => process.env[name]);
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-poll-check-"));
  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_DIR = storeDir;
  try {
    const scan: ScanRunner = async () => {
      const base = scanMeasurementEnvelopeWithR2Run(makePublicSingleReportV2R2().run, SCREENSHOT);
      const envelope = createNodeScanMeasurementEnvelope(base.result, structuredClone(base.measurement) as NodeScanMeasurement);
      attachScrollCheckEvidence(envelope, evidence);
      return envelope;
    };
    let saves = 0;
    const saveReport: ReportSaver = async (report) => {
      saves += 1;
      return report;
    };
    const submission = enqueuePreparedScanJob(
      {
        clientKey: "poll-check",
        url: "https://www.example.com/",
        device: "desktop",
        gpcEnabled: true,
        compareGpc: false,
        compareShields: false,
        compareConsent: false,
        rateLimitCost: 2,
        check: "scroll"
      },
      { scan, saveReport }
    );
    await waitForScanJobForTests(submission.jobId);
    const status = JSON.parse(JSON.stringify(getScanJobStatus(submission.jobId))) as { status: string; report: unknown };
    assert.equal(saves, 0, "a check job saved its report");
    return { submission, status, evidence };
  } finally {
    resetScanJobStateForTests();
    resetScanLimitStateForTests();
    names.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name];
      else process.env[name] = before[index];
    });
    await rm(storeDir, { recursive: true, force: true });
  }
}

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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { PublicScanError } from "./public-errors";
import { MAX_QUEUED_JOBS, RATE_LIMIT_MAX, resetScanLimitStateForTests } from "./scan-limits";
import { readScanReport } from "./report-store";
import {
  advanceScanJobClockForTests,
  asyncScanModeEnabled,
  enqueuePreparedScanJob,
  getScanJobStatus,
  resetScanJobStateForTests,
  scanJobStateForTests,
  setScanJobCreatedAtForTests,
  waitForScanJobForTests
} from "./scan-jobs";
import type { PreparedScanRequest, ScanRunner } from "./scan-api";
import { SCAN_REPORT_SCHEMA_VERSION, type ScanRequestPayload, type ScanResult } from "./types";

const ASYNC_SCANS_ENV = "SITE_BEHAVIOR_LAB_ASYNC_SCANS";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";

// Route report writes to a per-test temp dir; never touch (or delete) the
// repo's real `.site-behavior-lab` default store, which may hold a developer's
// actual saved reports.
let reportDir = "";

beforeEach(async () => {
  reportDir = await mkdtemp(path.join(tmpdir(), "sbl-scan-jobs-"));
  process.env[REPORT_STORE_DIR_ENV] = reportDir;
});

afterEach(async () => {
  delete process.env[ASYNC_SCANS_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
  resetScanJobStateForTests();
  resetScanLimitStateForTests();
  await rm(reportDir, { recursive: true, force: true });
});

test("asyncScanModeEnabled is controlled by SITE_BEHAVIOR_LAB_ASYNC_SCANS", () => {
  assert.equal(asyncScanModeEnabled(), false);
  process.env[ASYNC_SCANS_ENV] = "1";
  assert.equal(asyncScanModeEnabled(), true);
});

test("enqueuePreparedScanJob returns a submission and stores the completed report", async () => {
  const scannedPayloads: ScanRequestPayload[] = [];
  const scan: ScanRunner = async (payload, options) => {
    scannedPayloads.push(payload);
    assert.equal(options?.publicUrlAlreadyVerified, true);
    return makeScanResult(payload);
  };

  const submission = enqueuePreparedScanJob(makePreparedScanRequest(), { scan, saveReport: async (report) => report });

  assert.equal(submission.ok, true);
  assert.equal(submission.status, "queued");
  assert.match(submission.jobId, /^[0-9]{8}-[0-9a-f]{32}$/);
  assert.equal(submission.statusPath, `/api/scans/${submission.jobId}`);
  // The share ID is a separate capability: a shared report link must never let
  // its holder derive the screenshot-bearing status URL.
  assert.match(submission.reportId, /^[0-9]{8}-[0-9a-f]{32}$/);
  assert.notEqual(submission.reportId, submission.jobId);

  await waitForScanJobForTests(submission.jobId);

  const status = getScanJobStatus(submission.jobId);
  assert.equal(status?.status, "succeeded");
  assert.equal(status?.progress?.completedRuns, 1);
  assert.equal(status?.progress?.totalRuns, 1);
  assert.equal(status?.report?.ok, true);
  assert.deepEqual(scannedPayloads, [
    {
      url: "https://1.1.1.1/",
      device: "desktop",
      gpcEnabled: true,
      consentMode: "observe"
    }
  ]);
  assert.deepEqual(scanJobStateForTests(), {
    queuedJobs: 0,
    activeJobWorkers: 0,
    retainedJobs: 1
  });
});

test("enqueuePreparedScanJob reports Shields comparison progress as two runs", async () => {
  const scan: ScanRunner = async (payload) => makeScanResult(payload);
  const submission = enqueuePreparedScanJob(makePreparedScanRequest({ compareShields: true, rateLimitCost: 2 }), {
    scan,
    saveReport: async (report) => report
  });

  await waitForScanJobForTests(submission.jobId);

  const status = getScanJobStatus(submission.jobId);
  assert.equal(status?.status, "succeeded");
  assert.equal(status?.progress?.completedRuns, 2);
  assert.equal(status?.progress?.totalRuns, 2);
});

test("enqueuePreparedScanJob persists default saved reports under the submission's report ID, not the job ID", async () => {
  const scan: ScanRunner = async (payload) => makeScanResult(payload);
  const submission = enqueuePreparedScanJob(makePreparedScanRequest(), { scan });

  await waitForScanJobForTests(submission.jobId);

  const status = getScanJobStatus(submission.jobId);
  assert.equal(status?.status, "succeeded");
  assert.equal(status?.report?.share?.id, submission.reportId);
  assert.deepEqual(await readScanReport(submission.reportId), status?.report);
  // Nothing may be stored under the job ID: the report store is public by ID,
  // and the job ID must stay a submitter-only capability.
  assert.equal(await readScanReport(submission.jobId), null);
});

test("enqueuePreparedScanJob reports sanitized job failures", async () => {
  const scan: ScanRunner = async () => {
    throw new PublicScanError("The scanner refused this URL.", 400);
  };

  const submission = enqueuePreparedScanJob(makePreparedScanRequest(), { scan });

  await waitForScanJobForTests(submission.jobId);

  const status = getScanJobStatus(submission.jobId);
  assert.equal(status?.status, "failed");
  assert.equal(status?.error, "The scanner refused this URL.");
  assert.equal(status?.report, undefined);
});

test("getScanJobStatus ignores malformed job ids", () => {
  assert.equal(getScanJobStatus("../not-a-job"), null);
});

test("stale queued scan jobs return expired status", () => {
  const hang: ScanRunner = () => new Promise(() => {});
  void enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "worker-a" }), { scan: hang });
  void enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "worker-b" }), { scan: hang });
  const submission = enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "worker-c" }), { scan: hang });

  setScanJobCreatedAtForTests(submission.jobId, Date.now() - 61 * 60 * 1000);
  advanceScanJobClockForTests(Date.now());

  const status = getScanJobStatus(submission.jobId);
  assert.equal(status?.status, "expired");
  assert.equal(status?.error, "This scan job expired before it finished.");
});

test("retention pressure never evicts accepted queued jobs", async () => {
  const instant: ScanRunner = async (payload) => makeScanResult(payload);
  const hang: ScanRunner = () => new Promise(() => {});
  const keep: ReturnType<typeof enqueuePreparedScanJob>[] = [];

  // Push the retained-job count past the retention cap with finished jobs,
  // awaiting each so the burst never trips the aggregate admission cap.
  for (let index = 0; index < 501; index += 1) {
    const submission = enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: `bulk-${index}` }), {
      scan: instant,
      saveReport: async (report) => report
    });
    await waitForScanJobForTests(submission.jobId);
  }

  // Two hanging jobs occupy the workers; three more are accepted and queued.
  enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "occupy-a" }), { scan: hang });
  enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "occupy-b" }), { scan: hang });
  for (const client of ["queued-a", "queued-b", "queued-c"]) {
    keep.push(enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: client }), { scan: hang }));
  }

  advanceScanJobClockForTests(Date.now());

  // The finished overflow was evicted, but every ACCEPTED queued job survived:
  // an accepted job is a promise of work and must never silently disappear.
  assert.equal(scanJobStateForTests().retainedJobs <= 500, true);
  assert.equal(scanJobStateForTests().queuedJobs, 3);
  for (const submission of keep) {
    assert.equal(getScanJobStatus(submission.jobId)?.status, "queued");
  }
});

test("the async queue refuses admission beyond the aggregate cap without charging the client", () => {
  const hang: ScanRunner = () => new Promise(() => {});

  // Occupy both workers, then fill the admission queue across many distinct
  // clients (each stays inside its own per-client rate limit).
  enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "occupy-a" }), { scan: hang });
  enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "occupy-b" }), { scan: hang });
  for (let index = 0; index < MAX_QUEUED_JOBS; index += 1) {
    enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: `filler-${index % 8}` }), { scan: hang });
  }
  assert.equal(scanJobStateForTests().queuedJobs, MAX_QUEUED_JOBS);

  assert.throws(
    () => enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "late-client" }), { scan: hang }),
    (error) => error instanceof PublicScanError && error.status === 503 && /queue is full/i.test(error.message)
  );
});

test("expired queued jobs leave the admission queue", () => {
  const hang: ScanRunner = () => new Promise(() => {});
  enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "worker-a" }), { scan: hang });
  enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "worker-b" }), { scan: hang });
  const submission = enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "worker-c" }), { scan: hang });
  assert.equal(scanJobStateForTests().queuedJobs, 1);

  setScanJobCreatedAtForTests(submission.jobId, Date.now() - 61 * 60 * 1000);
  advanceScanJobClockForTests(Date.now());

  // Expired means it will never run; its slot must return to the admission cap.
  assert.equal(getScanJobStatus(submission.jobId)?.status, "expired");
  assert.equal(scanJobStateForTests().queuedJobs, 0);
});

test("enqueuePreparedScanJob charges the rate limit at submit time so bursts cannot flood the queue", () => {
  const hang: ScanRunner = () => new Promise(() => {});

  for (let index = 0; index < RATE_LIMIT_MAX; index += 1) {
    enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "flooder" }), { scan: hang });
  }

  assert.throws(
    () => enqueuePreparedScanJob(makePreparedScanRequest({ clientKey: "flooder" }), { scan: hang }),
    (error) => error instanceof PublicScanError && error.status === 429
  );
});

function makePreparedScanRequest(overrides: Partial<PreparedScanRequest> = {}): PreparedScanRequest {
  return {
    clientKey: "local",
    url: "https://1.1.1.1/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1,
    ...overrides
  };
}

function makeScanResult(payload: ScanRequestPayload): ScanResult {
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: new URL(payload.url).hostname,
      totalRequests: 0,
      thirdPartyRequests: 0,
      knownTrackerRequests: 0,
      thirdPartyDomains: 0,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: payload.url,
      finalUrl: payload.url,
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: {
        width: 1440,
        height: 980,
        isMobile: payload.device === "mobile"
      },
      gpcEnabled: payload.gpcEnabled,
      consentMode: payload.consentMode,
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: {
        source: "test",
        version: "test",
        region: "test",
        entries: 0,
        curatedOverrides: 0,
        license: "test"
      },
      scannerDisclosure: "test"
    },
    requests: [],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: []
  };
}

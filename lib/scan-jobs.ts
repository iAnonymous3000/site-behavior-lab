import { randomBytes } from "node:crypto";
import {
  executePreparedScan,
  prepareScanRequest,
  type PreparedScanRequest,
  type ReportSaver,
  type ScanRunner
} from "./scan-api";
import { saveScanReport } from "./report-store";
import { assertRateLimit, MAX_CONCURRENT_SCANS, QUEUE_TIMEOUT_MS } from "./scan-limits";
import { toPublicError } from "./public-errors";
import type { ScanJobProgress, ScanJobStatus, ScanJobStatusResponse, ScanJobSubmissionResponse, ScanReport } from "./types";

const ASYNC_SCANS_ENV = "SITE_BEHAVIOR_LAB_ASYNC_SCANS";
const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const JOB_MAX_AGE_MS = 60 * 60 * 1000;
const JOB_EXPIRED_RETENTION_MS = 15 * 60 * 1000;
const MAX_RETAINED_JOBS = 500;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type InternalScanJobRecord = {
  id: string;
  status: ScanJobStatus;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  prepared: PreparedScanRequest;
  progress: ScanJobProgress;
  report?: ScanReport;
  error?: string;
  scan?: ScanRunner;
  saveReport?: ReportSaver;
  done: Deferred;
};

const jobs = new Map<string, InternalScanJobRecord>();
const queuedJobIds: string[] = [];
let activeJobWorkers = 0;

export function asyncScanModeEnabled(): boolean {
  return process.env[ASYNC_SCANS_ENV] === "1";
}

export async function submitScanJobRequest(request: Request): Promise<ScanJobSubmissionResponse> {
  const prepared = await prepareScanRequest(request);
  return enqueuePreparedScanJob(prepared);
}

export function enqueuePreparedScanJob(
  prepared: PreparedScanRequest,
  dependencies: { scan?: ScanRunner; saveReport?: ReportSaver } = {}
): ScanJobSubmissionResponse {
  pruneScanJobs();
  // Charge the per-client rate limit when the job is accepted into the queue.
  // The submit gate only peeks, so without this a burst of submissions could
  // all pass and flood the shared job queue before any charge landed at run
  // time. Jobs opt out of the execution-time charge to avoid double counting.
  assertRateLimit(prepared.clientKey, Date.now(), prepared.rateLimitCost);

  const now = new Date();
  const id = createJobId(now);
  const record: InternalScanJobRecord = {
    id,
    status: "queued",
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
    updatedAt: now.toISOString(),
    prepared,
    progress: createProgress("queued", prepared, 0),
    scan: dependencies.scan,
    saveReport: dependencies.saveReport,
    done: createDeferred()
  };

  jobs.set(id, record);
  queuedJobIds.push(id);
  kickScanJobWorkers();

  return {
    ok: true,
    jobId: id,
    status: "queued",
    statusPath: `/api/scans/${id}`
  };
}

export function getScanJobStatus(id: string): ScanJobStatusResponse | null {
  pruneScanJobs();
  if (!JOB_ID_PATTERN.test(id)) return null;

  const record = jobs.get(id);
  if (!record) return null;

  const response: ScanJobStatusResponse = {
    ok: true,
    jobId: record.id,
    status: record.status,
    progress: record.progress
  };

  if (record.status === "succeeded" && record.report) {
    // Intentional: the in-memory report keeps its screenshot here. `/api/scans/:id`
    // is the transient immediate-result channel for the caller who submitted the
    // scan (the client renders this screenshot directly), gated behind a 128-bit
    // bearer job id that expires with the in-process record. The shareable
    // permalink path (`/api/reports/:id`) is the one that strips screenshots; keep
    // status paths out of share/permalink flows so the two policies stay distinct.
    response.report = record.report;
  }
  if ((record.status === "failed" || record.status === "expired" || record.status === "cancelled") && record.error) {
    response.error = record.error;
  }

  return response;
}

export async function waitForScanJobForTests(id: string): Promise<void> {
  const record = jobs.get(id);
  if (!record) throw new Error(`Unknown scan job ${id}`);
  await record.done.promise;
}

export function resetScanJobStateForTests(): void {
  jobs.clear();
  queuedJobIds.splice(0, queuedJobIds.length);
  activeJobWorkers = 0;
}

export function scanJobStateForTests(): { queuedJobs: number; activeJobWorkers: number; retainedJobs: number } {
  return {
    queuedJobs: queuedJobIds.length,
    activeJobWorkers,
    retainedJobs: jobs.size
  };
}

export function setScanJobCreatedAtForTests(id: string, createdAtMs: number): void {
  const record = jobs.get(id);
  if (!record) throw new Error(`Unknown scan job ${id}`);
  record.createdAtMs = createdAtMs;
}

export function advanceScanJobClockForTests(nowMs: number): void {
  pruneScanJobs(nowMs);
}

function kickScanJobWorkers(): void {
  while (activeJobWorkers < MAX_CONCURRENT_SCANS && queuedJobIds.length > 0) {
    const id = queuedJobIds.shift();
    if (!id) return;

    const record = jobs.get(id);
    if (!record || record.status !== "queued") continue;

    activeJobWorkers += 1;
    void runScanJob(record).finally(() => {
      activeJobWorkers = Math.max(activeJobWorkers - 1, 0);
      record.done.resolve();
      kickScanJobWorkers();
    });
  }
}

async function runScanJob(record: InternalScanJobRecord): Promise<void> {
  markRunning(record);

  try {
    const saveReport: ReportSaver = record.saveReport ?? ((report) => saveScanReport(report, { shareId: record.id }));
    const report = await executePreparedScan(record.prepared, record.scan, saveReport, QUEUE_TIMEOUT_MS, false);
    markSucceeded(record, report);
  } catch (error) {
    markFailed(record, toPublicError(error).message);
  }
}

function markRunning(record: InternalScanJobRecord): void {
  const now = new Date().toISOString();
  record.status = "running";
  record.startedAt = now;
  record.updatedAt = now;
  record.progress = createProgress("waiting", record.prepared, 0);
}

function markSucceeded(record: InternalScanJobRecord, report: ScanReport): void {
  const now = new Date().toISOString();
  const totalRuns = totalRunsForPreparedRequest(record.prepared);
  record.status = "succeeded";
  record.report = report;
  record.finishedAt = now;
  record.updatedAt = now;
  record.progress = {
    phase: "saving",
    completedRuns: totalRuns,
    totalRuns
  };
}

function markFailed(record: InternalScanJobRecord, error: string): void {
  const now = new Date().toISOString();
  record.status = "failed";
  record.error = error;
  record.finishedAt = now;
  record.updatedAt = now;
}

function markExpired(record: InternalScanJobRecord): void {
  if (record.status === "expired") return;

  const now = new Date().toISOString();
  record.status = "expired";
  record.error = "This scan job expired before it finished.";
  record.finishedAt = now;
  record.updatedAt = now;
}

function createProgress(phase: ScanJobProgress["phase"], prepared: PreparedScanRequest, completedRuns: number): ScanJobProgress {
  return {
    phase,
    completedRuns,
    totalRuns: totalRunsForPreparedRequest(prepared)
  };
}

function totalRunsForPreparedRequest(prepared: PreparedScanRequest): number {
  return prepared.compareGpc || prepared.compareShields ? 2 : 1;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createJobId(now: Date): string {
  return `${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(16).toString("hex")}`;
}

function pruneScanJobs(nowMs = Date.now()): void {
  for (const [id, record] of jobs) {
    if (record.status === "running") continue;

    if (record.status === "expired") {
      if (nowMs - record.createdAtMs > JOB_MAX_AGE_MS + JOB_EXPIRED_RETENTION_MS) {
        removeQueuedJobId(id);
        jobs.delete(id);
      }
      continue;
    }

    if (nowMs - record.createdAtMs > JOB_MAX_AGE_MS) {
      markExpired(record);
    }
  }

  if (jobs.size <= MAX_RETAINED_JOBS) return;

  const removable = Array.from(jobs.values())
    .filter((record) => record.status !== "running" && record.status !== "expired")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  for (const record of removable.slice(0, jobs.size - MAX_RETAINED_JOBS)) {
    removeQueuedJobId(record.id);
    jobs.delete(record.id);
  }
}

function removeQueuedJobId(id: string): void {
  const index = queuedJobIds.indexOf(id);
  if (index >= 0) queuedJobIds.splice(index, 1);
}

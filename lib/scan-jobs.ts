import { randomBytes } from "node:crypto";
import {
  executePreparedScan,
  prepareScanRequest,
  requireRuntimeScanReportModeForSaver,
  type PreparedScanRequest,
  type ReportSaver,
  type ScanRunner
} from "./scan-api";
import { saveScanReport } from "./report-store";
import { assertRateLimit, MAX_CONCURRENT_SCANS, MAX_QUEUED_JOBS, QUEUE_TIMEOUT_MS } from "./scan-limits";
import { PublicScanError, toPublicError } from "./public-errors";
import {
  type RuntimeScanJobStatusResponse,
  type RuntimeScanReport
} from "./runtime-scan-report";
import type { ScanJobProgress, ScanJobStatus, ScanJobSubmissionResponse } from "./types";

const ASYNC_SCANS_ENV = "SITE_BEHAVIOR_LAB_ASYNC_SCANS";
const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const JOB_MAX_AGE_MS = 60 * 60 * 1000;
const JOB_EXPIRED_RETENTION_MS = 15 * 60 * 1000;
const MAX_RETAINED_JOBS = 500;
const JOB_CANCELLED_MESSAGE = "This scan job was cancelled.";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type InternalScanJobRecord = {
  id: string;
  /** The saved report's share ID; minted separately from the job ID (see enqueue). */
  reportId: string;
  status: ScanJobStatus;
  createdAt: string;
  createdAtMs: number;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  prepared: PreparedScanRequest;
  progress: ScanJobProgress;
  report?: RuntimeScanReport;
  error?: string;
  scan?: ScanRunner;
  saveReport?: ReportSaver;
  usesDefaultPersistence: boolean;
  abortController: AbortController;
  publicationStarted: boolean;
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
  // Reject an explicitly requested but unready r2 producer before this job is
  // accepted or its client is charged. The worker checks again at execution
  // time in case deployment configuration changes while a job is queued.
  const admissionSaver = dependencies.saveReport ?? saveScanReport;
  requireRuntimeScanReportModeForSaver(admissionSaver);
  // Explicit aggregate admission: once accepted, a job is a promise of work
  // that must never be silently dropped, so admission is refused up front
  // (before the client is charged) when the queue is full.
  if (queuedJobIds.length >= MAX_QUEUED_JOBS) {
    throw new PublicScanError("Scanner queue is full. Try again shortly.", 503);
  }
  // Charge the per-client rate limit when the job is accepted into the queue.
  // The submit gate only peeks, so without this a burst of submissions could
  // all pass and flood the shared job queue before any charge landed at run
  // time. Jobs opt out of the execution-time charge to avoid double counting.
  assertRateLimit(prepared.clientKey, Date.now(), prepared.rateLimitCost);

  const now = new Date();
  const id = createJobId(now);
  // The report is saved and shared under its own ID so a share link never
  // reveals the status URL: `/api/scans/:jobId` can carry the screenshot and is
  // a capability held only by the submitter. Minting the report ID up front
  // (instead of at save time) lets the submission response hand it to the
  // submitter, who can still recover the saved report if this in-memory job
  // record disappears mid-poll (e.g. a container restart).
  const reportId = createJobId(now);
  const record: InternalScanJobRecord = {
    id,
    reportId,
    status: "queued",
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
    updatedAt: now.toISOString(),
    prepared,
    progress: createProgress("queued", prepared, 0),
    scan: dependencies.scan,
    saveReport: dependencies.saveReport,
    usesDefaultPersistence: admissionSaver === saveScanReport,
    abortController: new AbortController(),
    publicationStarted: false,
    done: createDeferred()
  };

  jobs.set(id, record);
  queuedJobIds.push(id);
  kickScanJobWorkers();

  return {
    ok: true,
    jobId: id,
    status: "queued",
    statusPath: `/api/scans/${id}`,
    reportId
  };
}

export function getScanJobStatus(id: string): RuntimeScanJobStatusResponse | null {
  pruneScanJobs();
  if (!JOB_ID_PATTERN.test(id)) return null;

  const record = jobs.get(id);
  if (!record) return null;

  const response: RuntimeScanJobStatusResponse = {
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
    // permalink path (`/api/reports/:id`) strips screenshots and uses a SEPARATE
    // ID (record.reportId), so holding a share link never derives this status URL.
    response.report = record.report;
  }
  if ((record.status === "failed" || record.status === "expired" || record.status === "cancelled") && record.error) {
    response.error = record.error;
  }

  return response;
}

/**
 * Cancel by submitter-held job capability. The response deliberately excludes
 * both reportId and report data: DELETE is a control operation, not a second
 * path to either public share identity or screenshot-bearing evidence.
 */
export function cancelScanJob(id: string): RuntimeScanJobStatusResponse | null {
  pruneScanJobs();
  if (!JOB_ID_PATTERN.test(id)) return null;

  const record = jobs.get(id);
  if (!record) return null;

  if (record.status === "cancelled") {
    return cancellationResponse(record);
  }
  if (record.status !== "queued" && record.status !== "running") {
    throw new PublicScanError("This scan job has already finished and cannot be cancelled.", 409);
  }
  // Once the saver is invoked, claiming cancellation would be dishonest: an
  // object-store write may already be externally visible and cannot be rolled
  // back atomically. The synchronous beforeSave hook closes this boundary.
  if (record.publicationStarted) {
    throw new PublicScanError("This scan report is already being saved and can no longer be cancelled.", 409);
  }

  const wasQueued = record.status === "queued";
  markCancelled(record);
  removeQueuedJobId(record.id);
  record.abortController.abort(new DOMException(JOB_CANCELLED_MESSAGE, "AbortError"));
  if (wasQueued) {
    // No worker owns a queued record, so cancellation itself completes it.
    record.done.resolve();
  }
  return cancellationResponse(record);
}

export async function waitForScanJobForTests(id: string): Promise<void> {
  const record = jobs.get(id);
  if (!record) throw new Error(`Unknown scan job ${id}`);
  await record.done.promise;
}

export function resetScanJobStateForTests(): void {
  for (const record of jobs.values()) {
    if (!record.abortController.signal.aborted) {
      record.abortController.abort(new DOMException(JOB_CANCELLED_MESSAGE, "AbortError"));
    }
  }
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
  if (!markRunning(record)) return;

  try {
    if (record.usesDefaultPersistence) {
      requireRuntimeScanReportModeForSaver(saveScanReport);
    }
    const saveReport: ReportSaver = record.saveReport ?? ((report) => saveScanReport(report, { shareId: record.reportId }));
    const report = await executePreparedScan(record.prepared, record.scan, saveReport, QUEUE_TIMEOUT_MS, false, {
      signal: record.abortController.signal,
      beforeSave: () => markPublicationStarted(record)
    });
    if (record.status === "cancelled") return;
    markSucceeded(record, report);
  } catch (error) {
    if (record.status === "cancelled" || record.abortController.signal.aborted) {
      if (record.status !== "cancelled") markCancelled(record);
      return;
    }
    markFailed(record, toPublicError(error).message);
  }
}

function markRunning(record: InternalScanJobRecord): boolean {
  if (record.status !== "queued") return false;
  const now = new Date().toISOString();
  record.status = "running";
  record.startedAt = now;
  record.updatedAt = now;
  record.progress = createProgress("waiting", record.prepared, 0);
  return true;
}

function markSucceeded(record: InternalScanJobRecord, report: RuntimeScanReport): void {
  if (record.status !== "running") return;
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
  if (record.status !== "running") return;
  const now = new Date().toISOString();
  record.status = "failed";
  record.error = error;
  record.finishedAt = now;
  record.updatedAt = now;
}

function markCancelled(record: InternalScanJobRecord): void {
  if (record.status === "cancelled") return;
  const now = new Date().toISOString();
  record.status = "cancelled";
  record.error = JOB_CANCELLED_MESSAGE;
  record.finishedAt = now;
  record.updatedAt = now;
}

function markPublicationStarted(record: InternalScanJobRecord): void {
  if (record.status !== "running" || record.abortController.signal.aborted) {
    throw record.abortController.signal.reason instanceof Error
      ? record.abortController.signal.reason
      : new DOMException(JOB_CANCELLED_MESSAGE, "AbortError");
  }
  record.publicationStarted = true;
  record.progress = createProgress("saving", record.prepared, totalRunsForPreparedRequest(record.prepared));
  record.updatedAt = new Date().toISOString();
}

function cancellationResponse(record: InternalScanJobRecord): RuntimeScanJobStatusResponse {
  return {
    ok: true,
    jobId: record.id,
    status: "cancelled",
    progress: record.progress,
    error: record.error ?? JOB_CANCELLED_MESSAGE
  };
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
  return prepared.compareGpc || prepared.compareShields || prepared.compareConsent ? 2 : 1;
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
      // An expired queued job must also leave the admission queue: workers
      // already skip it, but its id would otherwise keep counting against the
      // aggregate admission cap until the record itself is deleted.
      removeQueuedJobId(id);
    }
  }

  if (jobs.size <= MAX_RETAINED_JOBS) return;

  // Retention pressure may only evict jobs whose story is over. A "queued" job
  // is an ACCEPTED promise of work (the submitter holds its status URL) and
  // must never silently disappear; the aggregate admission cap bounds how many
  // can exist. "running" and freshly "expired" records are likewise kept.
  const removable = Array.from(jobs.values())
    .filter((record) => record.status !== "running" && record.status !== "expired" && record.status !== "queued")
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

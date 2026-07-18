import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  executePreparedScan,
  prepareScanRequest,
  requireRuntimeScanReportModeForSaver,
  type PreparedScanRequest,
  type ReportSaver,
  type ScanRunner
} from "./scan-api";
import {
  DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS,
  commitPreparedScanReportBundle,
  isScanReportPublicationManifest,
  prepareScanReportBundle,
  reconcilePreparedScanReportBundle,
  reportStoreStatus,
  saveScanReport,
  type PreparedScanReportBundle,
  type ScanReportBundleReconciliation,
  type ScanReportPublicationManifest
} from "./report-store";
import { assertRateLimit, MAX_CONCURRENT_SCANS, MAX_QUEUED_JOBS, QUEUE_TIMEOUT_MS } from "./scan-limits";
import { PublicScanError, toPublicError } from "./public-errors";
import {
  type RuntimeScanJobStatusResponse,
  type RuntimeScanReport
} from "./runtime-scan-report";
import type { ScanJobProgress, ScanJobStatus, ScanJobSubmissionResponse } from "./types";
import {
  DURABLE_SCAN_JOB_HEARTBEAT_INTERVAL_MS,
  DurableScanJobCoordinatorError,
  assertDurableScanJobExecutionOwner,
  createDurableScanJobCoordinatorClient,
  isDurableScanJobActivation,
  isScanJobId,
  type DurableScanJobActivation,
  type DurableScanJobCoordinator,
  type DurableScanJobExecutionOwner,
  type DurableScanJobPayload,
  type DurableScanJobPreparation
} from "./durable-scan-job-node";
import {
  DURABLE_SCAN_JOBS_ENV,
  DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS,
  DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS
} from "./durable-scan-job-contract";

const ASYNC_SCANS_ENV = "SITE_BEHAVIOR_LAB_ASYNC_SCANS";
const JOB_ID_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/;
const JOB_MAX_AGE_MS = 60 * 60 * 1000;
const JOB_EXPIRED_RETENTION_MS = 15 * 60 * 1000;
const MAX_RETAINED_JOBS = 500;
const JOB_CANCELLED_MESSAGE = "This scan job was cancelled.";
// Keep an idempotence tombstone beyond the 180-second DO lease, then release
// reports, prepared bundles, coordinator secrets, and closures promptly.
const DURABLE_LOCAL_RECORD_RETENTION_MS = 5 * 60 * 1000;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type DurablePublicationAdapter = {
  prepare: (report: RuntimeScanReport, reportId: string) => PreparedScanReportBundle;
  commit: (bundle: PreparedScanReportBundle, signal: AbortSignal) => Promise<RuntimeScanReport>;
  reconcile: (
    manifest: ScanReportPublicationManifest,
    signal: AbortSignal
  ) => Promise<ScanReportBundleReconciliation>;
};

type DurableExecution = {
  owner: DurableScanJobExecutionOwner;
  coordinator: DurableScanJobCoordinator;
  publication: DurablePublicationAdapter;
  publicationTimeoutMs: number;
  heartbeatIntervalMs: number;
  localRetentionMs: number;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  preparedBundle?: PreparedScanReportBundle;
  detachedAtMs?: number;
  stale: boolean;
};

type DurableCancellationWatermark = {
  generation: number;
  expiresAtMs: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

class DurablePublicationOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurablePublicationOutcomeUnknownError";
  }
}

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
  durable?: DurableExecution;
};

export type DurableScanJobActivationResponse = {
  ok: true;
  jobId: string;
  generation: number;
  status: "activated" | "already-active";
};

export type DurableScanJobCancellationControl = DurableScanJobExecutionOwner & {
  ok: true;
  status: "cancelled";
};

export type DurableScanJobGenerationControl = {
  jobId: string;
  generation: number;
};

export type DurableScanJobGenerationCancellationControl = DurableScanJobGenerationControl & {
  ok: true;
  status: "cancelled";
};

export type DurableScanJobPublicationReconciliationRequest = {
  jobId: string;
  reportId: string;
  generation: number;
  manifest: ScanReportPublicationManifest;
};

export type DurableScanJobPublicationReconciliationResponse = {
  jobId: string;
  reportId: string;
  generation: number;
} & (
  | { ok: true; outcome: "succeeded" | "missing" }
  | { ok: false; outcome: "integrity-error" | "retryable"; error: string }
);

export type DurableScanJobAdmissionDependencies = {
  prepare?: (request: Request) => Promise<PreparedScanRequest>;
  requireReady?: () => void;
  charge?: (clientKey: string, now: number, cost: 1 | 2) => void;
  now?: () => number;
  createId?: (now: Date) => string;
};

export type DurableScanJobActivationDependencies = {
  coordinator?: DurableScanJobCoordinator;
  scan?: ScanRunner;
  publication?: DurablePublicationAdapter;
  heartbeatIntervalMs?: number;
  /** Test-only override; production always uses the bounded default. */
  publicationTimeoutMs?: number;
  /** Test-only override; production retains local idempotence state for five minutes. */
  localCleanupDelayMs?: number;
};

export function isDurableScanJobPublicationReconciliationRequest(
  value: unknown
): value is DurableScanJobPublicationReconciliationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["generation", "jobId", "manifest", "reportId"].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    isScanJobId(record.jobId) &&
    isScanJobId(record.reportId) &&
    record.jobId !== record.reportId &&
    Number.isSafeInteger(record.generation) &&
    (record.generation as number) >= 1 &&
    isScanReportPublicationManifest(record.manifest) &&
    record.manifest.reportId === record.reportId
  );
}

const jobs = new Map<string, InternalScanJobRecord>();
const durableCancellationWatermarks = new Map<string, DurableCancellationWatermark>();
const queuedJobIds: string[] = [];
let activeJobWorkers = 0;
let pendingDurableActivations = 0;

const DEFAULT_DURABLE_PUBLICATION: DurablePublicationAdapter = {
  prepare: (report, reportId) => prepareScanReportBundle(report, { shareId: reportId }),
  commit: (bundle, signal) => commitPreparedScanReportBundle(bundle, { signal }),
  reconcile: (manifest, signal) => reconcilePreparedScanReportBundle(manifest, { signal })
};

export function asyncScanModeEnabled(): boolean {
  return process.env[ASYNC_SCANS_ENV] === "1";
}

export function durableScanJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DURABLE_SCAN_JOBS_ENV];
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new PublicScanError(`${DURABLE_SCAN_JOBS_ENV} must be 0, 1, or unset.`, 503);
}

/**
 * Run the ordinary authenticated/DNS-safe prepare gate, then freeze only the
 * privacy-minimized payload that the edge may encrypt. Admission charges the
 * Node limiter exactly once but deliberately creates no local job or worker.
 */
export async function prepareDurableScanJobRequest(
  request: Request,
  dependencies: DurableScanJobAdmissionDependencies = {}
): Promise<DurableScanJobPreparation> {
  const prepared = await (dependencies.prepare ?? prepareScanRequest)(request);
  (dependencies.requireReady ?? requireDurableScanJobReadiness)();

  const nowMs = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid durable scan-job admission timestamp.");
  }
  (dependencies.charge ?? assertRateLimit)(prepared.clientKey, nowMs, prepared.rateLimitCost);

  const now = new Date(nowMs);
  const createId = dependencies.createId ?? createJobId;
  const jobId = createId(now);
  const reportId = createId(now);
  if (!isScanJobId(jobId) || !isScanJobId(reportId) || jobId === reportId) {
    throw new Error("Could not mint separate durable scan-job capabilities.");
  }

  const target = new URL(prepared.url);
  target.search = "";
  target.hash = "";
  const payload: DurableScanJobPayload = {
    version: 1,
    url: target.href,
    device: prepared.device,
    gpcEnabled: prepared.gpcEnabled,
    compareGpc: prepared.compareGpc,
    compareShields: prepared.compareShields,
    compareConsent: prepared.compareConsent,
    rateLimitCost: prepared.rateLimitCost,
    admittedAt: nowMs,
    reportMode: "r2",
    alreadyCharged: true
  };

  return {
    submission: {
      ok: true,
      jobId,
      status: "queued",
      statusPath: `/api/scans/${jobId}`,
      reportId
    },
    payload
  };
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

/**
 * Activate one already-admitted durable lease under its fixed capabilities.
 * This is an execution handoff only: it never charges a limiter, verifies a
 * human challenge, remints an ID, or changes the prepared target.
 */
export async function activateDurableScanJob(
  activation: DurableScanJobActivation,
  dependencies: DurableScanJobActivationDependencies = {}
): Promise<DurableScanJobActivationResponse> {
  assertDurableActivation(activation);
  pruneScanJobs();

  const owner: DurableScanJobExecutionOwner = {
    jobId: activation.jobId,
    generation: activation.generation,
    leaseToken: activation.leaseToken
  };
  assertDurableActivationNotCancelled(owner);
  const initialDisposition = durableActivationDisposition(jobs.get(owner.jobId), activation, owner);
  if (initialDisposition === "same") {
    return { ok: true, jobId: owner.jobId, generation: owner.generation, status: "already-active" };
  }
  const reservesNewSlot = initialDisposition === "new";
  if (reservesNewSlot && activeJobWorkers + pendingDurableActivations >= MAX_CONCURRENT_SCANS) {
    throw new PublicScanError("Scanner execution capacity is full. Try this durable lease again shortly.", 503);
  }
  const coordinator =
    dependencies.coordinator ??
    createDurableScanJobCoordinatorClient({
      coordinatorUrl: activation.coordinatorUrl,
      internalToken: activation.internalToken
    });
  if (reservesNewSlot) pendingDurableActivations += 1;
  try {
    // Validate and renew the exact DO-issued owner before a target visit can
    // start. A queued or expired lease can therefore never execute merely
    // because its activation request reached a still-live Node process late.
    await coordinator.heartbeat(owner);
    // The DO may commit cancellation and deliver its generation-only abort
    // while this request is waiting for the successful heartbeat response.
    // Recheck before installing a record or starting any target work.
    assertDurableActivationNotCancelled(owner);

    const disposition = durableActivationDisposition(jobs.get(owner.jobId), activation, owner);
    if (disposition === "same") {
      return { ok: true, jobId: owner.jobId, generation: owner.generation, status: "already-active" };
    }
    if (
      disposition === "new" &&
      !reservesNewSlot &&
      activeJobWorkers + pendingDurableActivations >= MAX_CONCURRENT_SCANS
    ) {
      throw new PublicScanError("Scanner execution capacity is full. Try this durable lease again shortly.", 503);
    }
    const existing = jobs.get(owner.jobId);
    if (disposition === "replace" && existing) supersedeDurableRecord(existing);

    const prepared = preparedRequestFromDurablePayload(activation.payload);
    const admittedAt = activation.payload.admittedAt;
    const admitted = new Date(admittedAt);
    const record: InternalScanJobRecord = {
      id: owner.jobId,
      reportId: activation.reportId,
      status: "queued",
      createdAt: admitted.toISOString(),
      createdAtMs: admittedAt,
      updatedAt: new Date().toISOString(),
      prepared,
      progress: createProgress("queued", prepared, 0),
      scan: dependencies.scan,
      usesDefaultPersistence: true,
      abortController: new AbortController(),
      publicationStarted: false,
      done: createDeferred(),
      durable: {
        owner,
        coordinator,
        publication: dependencies.publication ?? DEFAULT_DURABLE_PUBLICATION,
        publicationTimeoutMs: validatedPublicationTimeout(dependencies.publicationTimeoutMs),
        heartbeatIntervalMs: validatedHeartbeatInterval(dependencies.heartbeatIntervalMs),
        localRetentionMs: validatedLocalCleanupDelay(dependencies.localCleanupDelayMs),
        stale: false
      }
    };

    jobs.set(owner.jobId, record);
    queuedJobIds.push(owner.jobId);
    // The immediate heartbeat above renewed this lease. Continue renewing even
    // if a superseded local worker needs a moment to release its no-net slot.
    startDurableHeartbeat(record);
    return { ok: true, jobId: owner.jobId, generation: owner.generation, status: "activated" };
  } finally {
    if (reservesNewSlot) pendingDurableActivations = Math.max(pendingDurableActivations - 1, 0);
    kickScanJobWorkers();
  }
}

/** Trusted status read: a stale or guessed owner learns nothing. */
export function getOwnedDurableScanJobStatus(
  owner: DurableScanJobExecutionOwner
): RuntimeScanJobStatusResponse | null {
  assertDurableScanJobExecutionOwner(owner);
  pruneScanJobs();
  const record = jobs.get(owner.jobId);
  return record && durableOwnerMatches(record, owner) ? scanJobStatusResponse(record) : null;
}

/**
 * Trusted abort delivery after the Durable Object has won cancellation. The
 * response is control-only but echoes the exact fence so the private route can
 * prove which local execution it stopped.
 */
export function cancelOwnedDurableScanJob(
  owner: DurableScanJobExecutionOwner
): DurableScanJobCancellationControl | null {
  assertDurableScanJobExecutionOwner(owner);
  const record = jobs.get(owner.jobId);
  if (!record || !durableOwnerMatches(record, owner)) return null;
  if (record.publicationStarted) {
    throw new PublicScanError("This scan report is already being saved and can no longer be cancelled.", 409);
  }
  if (record.status === "cancelled") {
    return { ok: true, status: "cancelled", ...owner };
  }
  if (record.status !== "queued" && record.status !== "running") {
    throw new PublicScanError("This scan job has already finished and cannot be cancelled.", 409);
  }

  const wasQueued = record.status === "queued";
  markCancelled(record);
  removeQueuedJobId(record.id);
  stopDurableHeartbeat(record);
  record.abortController.abort(new DOMException(JOB_CANCELLED_MESSAGE, "AbortError"));
  if (wasQueued) record.done.resolve();
  return { ok: true, status: "cancelled", ...owner };
}

/**
 * Best-effort local abort after the Durable Object has already committed the
 * authoritative cancellation. The private route's internal token is the trust
 * boundary: the DO deliberately stores only a digest of the raw lease token.
 * Cancellation at generation N proves every older local generation stale too.
 */
export function cancelDurableScanJobGeneration(
  control: DurableScanJobGenerationControl
): DurableScanJobGenerationCancellationControl | null {
  assertDurableScanJobGenerationControl(control);
  // Record authoritative cancellation even when this process has no matching
  // record yet. This closes the window where a successful heartbeat response
  // resumes an activation after the DO's cancellation delivery returned 404.
  recordDurableCancellationWatermark(control);
  const record = jobs.get(control.jobId);
  if (!record?.durable || record.durable.owner.generation > control.generation) return null;
  if (record.status === "cancelled") {
    return { ok: true, status: "cancelled", ...control };
  }
  if (record.status !== "queued" && record.status !== "running") {
    throw new PublicScanError("This scan job has already finished and cannot be cancelled.", 409);
  }

  const wasQueued = record.status === "queued";
  markCancelled(record);
  removeQueuedJobId(record.id);
  stopDurableHeartbeat(record);
  if (!record.abortController.signal.aborted) {
    record.abortController.abort(new DOMException(JOB_CANCELLED_MESSAGE, "AbortError"));
  }
  if (wasQueued) record.done.resolve();
  return { ok: true, status: "cancelled", ...control };
}

/**
 * Content-free R2 reconciliation for an expired publishing lease. Private
 * route authentication is the trust boundary; no obsolete raw lease token is
 * needed or accepted here.
 */
export async function reconcileDurableScanJobPublication(
  request: DurableScanJobPublicationReconciliationRequest,
  reconcile: (
    manifest: ScanReportPublicationManifest,
    signal: AbortSignal
  ) => Promise<ScanReportBundleReconciliation> = (manifest, signal) =>
    reconcilePreparedScanReportBundle(manifest, { signal }),
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<DurableScanJobPublicationReconciliationResponse> {
  if (!isDurableScanJobPublicationReconciliationRequest(request)) {
    throw new Error("Invalid durable scan-job reconciliation request.");
  }
  const identity = {
    jobId: request.jobId,
    reportId: request.reportId,
    generation: request.generation
  };

  const operation = boundedOperationSignal(
    options.signal,
    validatedReconciliationTimeout(options.timeoutMs),
    "Durable scan-report reconciliation timed out."
  );
  let result: ScanReportBundleReconciliation;
  try {
    result = await awaitOperationOrAbort(operation.signal, () =>
      reconcile(request.manifest, operation.signal)
    );
  } catch {
    return {
      ...identity,
      ok: false,
      outcome: "retryable",
      error: "Report storage could not be read during durable reconciliation."
    };
  } finally {
    operation.dispose();
  }
  if (result.outcome === "found") {
    return { ...identity, ok: true, outcome: "succeeded" };
  }
  if (result.outcome === "missing") {
    return { ...identity, ok: true, outcome: "missing" };
  }
  return { ...identity, ok: false, outcome: "integrity-error", error: result.reason };
}

export function getScanJobStatus(id: string): RuntimeScanJobStatusResponse | null {
  pruneScanJobs();
  if (!JOB_ID_PATTERN.test(id)) return null;

  const record = jobs.get(id);
  if (!record) return null;

  return scanJobStatusResponse(record);
}

function scanJobStatusResponse(record: InternalScanJobRecord): RuntimeScanJobStatusResponse {

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
  if (record.durable) {
    throw new PublicScanError("This durable scan job must be cancelled through its coordinator.", 409);
  }

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
    stopDurableHeartbeat(record);
    stopDurableLocalCleanup(record);
    if (!record.abortController.signal.aborted) {
      record.abortController.abort(new DOMException(JOB_CANCELLED_MESSAGE, "AbortError"));
    }
  }
  jobs.clear();
  clearDurableCancellationWatermarks();
  queuedJobIds.splice(0, queuedJobIds.length);
  activeJobWorkers = 0;
  pendingDurableActivations = 0;
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
  while (
    activeJobWorkers + pendingDurableActivations < MAX_CONCURRENT_SCANS &&
    queuedJobIds.length > 0
  ) {
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
      if (record.durable) requireDurableScanJobReadiness();
      else requireRuntimeScanReportModeForSaver(saveScanReport);
    }
    const saveReport: ReportSaver = record.durable
      ? durableReportSaver(record)
      : record.saveReport ?? ((report) => saveScanReport(report, { shareId: record.reportId }));
    const report = await executePreparedScan(record.prepared, record.scan, saveReport, QUEUE_TIMEOUT_MS, false, {
      signal: record.abortController.signal,
      beforeSave: record.durable
        ? (pendingReport) => beginDurablePublication(record, pendingReport)
        : () => markPublicationStarted(record)
    });
    if (record.status === "cancelled") return;
    markSucceeded(record, report);
    await resolveDurableExecution(record, { outcome: "succeeded" });
  } catch (error) {
    if (record.status === "cancelled" || record.abortController.signal.aborted) {
      if (record.status !== "cancelled") markCancelled(record);
      await resolveDurableExecution(record, { outcome: "cancelled", error: JOB_CANCELLED_MESSAGE });
      return;
    }
    if (error instanceof DurablePublicationOutcomeUnknownError && record.durable) {
      // Do not invent a terminal result after a control-plane or R2 outcome-
      // unknown window. Leave the DO's manifest authoritative and stop local
      // ownership; lease expiry will reconcile exact persisted bytes.
      record.durable.detachedAtMs = Date.now();
      scheduleDurableLocalCleanup(record);
      return;
    }
    const message = toPublicError(error).message;
    markFailed(record, message);
    await resolveDurableExecution(record, { outcome: "failed", error: message });
  } finally {
    stopDurableHeartbeat(record);
  }
}

function beginDurablePublication(
  record: InternalScanJobRecord,
  report: RuntimeScanReport
): Promise<void> {
  const durable = record.durable;
  if (!durable) throw new Error("Durable publication requires an execution owner.");

  // This mutation must happen before this function returns its promise. DELETE
  // therefore sees 409 throughout bundle preparation and the awaited DO CAS.
  markPublicationStarted(record);
  const bundle = durable.publication.prepare(report, record.reportId);
  if (bundle.manifest.reportId !== record.reportId) {
    throw new Error("The prepared scan-report bundle used the wrong report capability.");
  }
  durable.preparedBundle = bundle;
  return durable.coordinator
    .beginPublishing(durable.owner, bundle.manifest, record.abortController.signal)
    .catch((error) => {
      if (isDefinitiveCoordinatorConflict(error)) {
        fenceStaleDurableExecution(record);
        throw error;
      }
      throw new DurablePublicationOutcomeUnknownError(
        "The durable publication transition has an unknown outcome.",
        { cause: error }
      );
    });
}

function durableReportSaver(record: InternalScanJobRecord): ReportSaver {
  return async <T extends RuntimeScanReport>(_report: T): Promise<T> => {
    const durable = record.durable;
    const bundle = durable?.preparedBundle;
    if (!durable || !bundle) {
      throw new Error("Durable publication began without a prepared report bundle.");
    }

    const publication = boundedOperationSignal(
      record.abortController.signal,
      durable.publicationTimeoutMs,
      "Durable scan-report publication timed out."
    );
    try {
      try {
        return (await awaitOperationOrAbort(publication.signal, () =>
          durable.publication.commit(bundle, publication.signal)
        )) as T;
      } catch (commitError) {
        let reconciliation: ScanReportBundleReconciliation;
        try {
          reconciliation = await awaitOperationOrAbort(publication.signal, () =>
            durable.publication.reconcile(bundle.manifest, publication.signal)
          );
        } catch (reconciliationError) {
          throw new DurablePublicationOutcomeUnknownError(
            "Durable scan-report reconciliation has an unknown outcome.",
            { cause: reconciliationError }
          );
        }
        if (reconciliation.outcome === "found") {
          // A completed first attempt may have lost its response after R2 commit.
          // The canonical stored public report is authoritative even though an
          // ephemeral screenshot is necessarily unavailable after reconciliation.
          return reconciliation.report as T;
        }
        if (reconciliation.outcome === "integrity-error") {
          throw new Error(
            `Durable scan-report publication failed integrity reconciliation (${reconciliation.reason}).`,
            { cause: commitError }
          );
        }
        throw new DurablePublicationOutcomeUnknownError(
          "Durable scan-report publication has an unknown outcome.",
          { cause: commitError }
        );
      }
    } finally {
      publication.dispose();
    }
  };
}

/**
 * Settle the caller when its signal aborts even if an injected storage adapter
 * ignores AbortSignal. Both handlers stay attached to the adapter promise, so
 * a late resolution or rejection is observed but cannot settle this wrapper a
 * second time or re-enter the scan-job state machine.
 */
function awaitOperationOrAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  let operationPromise: Promise<T>;
  try {
    // Do not invoke a fallback reconciliation after the shared publication
    // deadline has already expired.
    signal.throwIfAborted();
    operationPromise = Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() =>
        reject(
          signal.reason ??
            new DOMException("The durable scan-job storage operation was aborted.", "AbortError")
        )
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operationPromise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
    if (signal.aborted) onAbort();
  });
}

function boundedOperationSignal(
  executionSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromExecution = () => {
    controller.abort(
      executionSignal?.reason ?? new DOMException("Durable scan-job execution was aborted.", "AbortError")
    );
  };
  executionSignal?.addEventListener("abort", abortFromExecution, { once: true });
  if (executionSignal?.aborted) abortFromExecution();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      executionSignal?.removeEventListener("abort", abortFromExecution);
    }
  };
}

function startDurableHeartbeat(record: InternalScanJobRecord): void {
  if (!record.durable) return;
  scheduleNextDurableHeartbeat(record);
}

function scheduleNextDurableHeartbeat(record: InternalScanJobRecord): void {
  const durable = record.durable;
  if (
    !durable ||
    durable.stale ||
    durable.detachedAtMs !== undefined ||
    isTerminalStatus(record.status)
  ) return;
  durable.heartbeatTimer = setTimeout(() => {
    durable.heartbeatTimer = undefined;
    void durable.coordinator
      .heartbeat(durable.owner, record.abortController.signal)
      .then(() => scheduleNextDurableHeartbeat(record))
      .catch((error) => {
        if (isDefinitiveCoordinatorConflict(error)) {
          fenceStaleDurableExecution(record);
          return;
        }
        // A transient coordinator fault must not itself manufacture a terminal
        // state. The lease authority will fence this worker if it actually
        // expires, so keep attempting bounded renewals meanwhile.
        scheduleNextDurableHeartbeat(record);
      });
  }, durable.heartbeatIntervalMs);
  durable.heartbeatTimer.unref?.();
}

function stopDurableHeartbeat(record: InternalScanJobRecord): void {
  const durable = record.durable;
  if (!durable?.heartbeatTimer) return;
  clearTimeout(durable.heartbeatTimer);
  durable.heartbeatTimer = undefined;
}

function scheduleDurableLocalCleanup(record: InternalScanJobRecord): void {
  const durable = record.durable;
  if (!durable || durable.cleanupTimer) return;
  const terminalAt = isTerminalStatus(record.status)
    ? Date.parse(record.finishedAt ?? record.updatedAt)
    : Number.NaN;
  const cleanupFrom = durable.detachedAtMs ?? (Number.isFinite(terminalAt) ? terminalAt : undefined);
  if (cleanupFrom === undefined) return;
  const delay = Math.max(cleanupFrom + durable.localRetentionMs - Date.now(), 0);
  durable.cleanupTimer = setTimeout(() => {
    durable.cleanupTimer = undefined;
    // A superseded generation may have the same job ID. Its stale timer must
    // never delete the replacement record now held under that capability.
    if (jobs.get(record.id) !== record) return;
    stopDurableHeartbeat(record);
    removeQueuedJobId(record.id);
    jobs.delete(record.id);
  }, delay);
  durable.cleanupTimer.unref?.();
}

function stopDurableLocalCleanup(record: InternalScanJobRecord): void {
  const durable = record.durable;
  if (!durable?.cleanupTimer) return;
  clearTimeout(durable.cleanupTimer);
  durable.cleanupTimer = undefined;
}

function fenceStaleDurableExecution(record: InternalScanJobRecord): void {
  const durable = record.durable;
  if (!durable || durable.stale) return;
  durable.stale = true;
  durable.detachedAtMs = Date.now();
  stopDurableHeartbeat(record);
  scheduleDurableLocalCleanup(record);
  const wasQueued = record.status === "queued";
  if (wasQueued) {
    markCancelled(record);
    removeQueuedJobId(record.id);
  }
  if (!record.abortController.signal.aborted) {
    record.abortController.abort(new DOMException("This durable scan-job lease is stale.", "AbortError"));
  }
  if (wasQueued) record.done.resolve();
}

async function resolveDurableExecution(
  record: InternalScanJobRecord,
  resolution: Parameters<DurableScanJobCoordinator["resolve"]>[1]
): Promise<void> {
  const durable = record.durable;
  if (!durable || durable.stale) return;
  try {
    await durable.coordinator.resolve(durable.owner, resolution, record.abortController.signal);
  } catch (error) {
    if (isDefinitiveCoordinatorConflict(error)) {
      fenceStaleDurableExecution(record);
    }
    // Transport faults are reconciled by the DO's lease/deadline pump. Never
    // replace the scan's public outcome with a coordinator diagnostic.
  }
}

function supersedeDurableRecord(record: InternalScanJobRecord): void {
  if (!record.durable) return;
  stopDurableLocalCleanup(record);
  record.durable.stale = true;
  record.durable.detachedAtMs = Date.now();
  stopDurableHeartbeat(record);
  removeQueuedJobId(record.id);
  const wasQueued = record.status === "queued";
  markCancelled(record);
  // The map is replaced synchronously by the new generation. Its identity-
  // checked timer is unnecessary, and retaining it would keep the old closure.
  stopDurableLocalCleanup(record);
  if (!record.abortController.signal.aborted) {
    record.abortController.abort(new DOMException("This durable scan-job lease was superseded.", "AbortError"));
  }
  if (wasQueued) record.done.resolve();
}

function durableActivationDisposition(
  existing: InternalScanJobRecord | undefined,
  activation: DurableScanJobActivation,
  owner: DurableScanJobExecutionOwner
): "new" | "same" | "replace" {
  if (!existing) return "new";
  if (!existing.durable || existing.reportId !== activation.reportId) {
    throw new PublicScanError("This durable scan-job activation conflicts with an existing job.", 409);
  }
  const current = existing.durable.owner;
  if (owner.generation < current.generation) {
    throw new PublicScanError("This durable scan-job activation is stale.", 409);
  }
  if (owner.generation === current.generation) {
    if (!leaseTokensEqual(owner.leaseToken, current.leaseToken)) {
      throw new PublicScanError("This durable scan-job activation has the wrong lease token.", 409);
    }
    return "same";
  }
  // A strictly newer generation is accepted only after its immediate awaited
  // heartbeat succeeds. The authoritative DO never issues a newer generation
  // after beginPublishing wins, but may requeue when that CAS never arrived.
  return "replace";
}

function durableOwnerMatches(record: InternalScanJobRecord, owner: DurableScanJobExecutionOwner): boolean {
  const current = record.durable?.owner;
  return Boolean(
    current &&
      current.generation === owner.generation &&
      leaseTokensEqual(current.leaseToken, owner.leaseToken)
  );
}

function leaseTokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isDefinitiveCoordinatorConflict(error: unknown): boolean {
  return error instanceof DurableScanJobCoordinatorError && error.definitiveConflict;
}

function isTerminalStatus(status: ScanJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "expired" || status === "cancelled";
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
  scheduleDurableLocalCleanup(record);
}

function markFailed(record: InternalScanJobRecord, error: string): void {
  if (record.status !== "running") return;
  const now = new Date().toISOString();
  record.status = "failed";
  record.error = error;
  record.finishedAt = now;
  record.updatedAt = now;
  scheduleDurableLocalCleanup(record);
}

function markCancelled(record: InternalScanJobRecord): void {
  if (record.status === "cancelled") return;
  const now = new Date().toISOString();
  record.status = "cancelled";
  record.error = JOB_CANCELLED_MESSAGE;
  record.finishedAt = now;
  record.updatedAt = now;
  scheduleDurableLocalCleanup(record);
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

function requireDurableScanJobReadiness(): void {
  const reportMode = requireRuntimeScanReportModeForSaver(saveScanReport);
  const store = reportStoreStatus();
  if (
    reportMode !== "r2" ||
    store.kind !== "r2" ||
    store.minSurvivalMs < DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS ||
    store.maxAgeDays * 24 * 60 * 60 * 1_000 < DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS
  ) {
    throw new PublicScanError(
      "Durable scan jobs require public r2 report persistence that remains recoverable for at least 75 minutes.",
      503
    );
  }
}

function assertDurableScanJobGenerationControl(
  value: DurableScanJobGenerationControl
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "generation\0jobId" ||
    !isScanJobId(value.jobId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new Error("Invalid durable scan-job generation control.");
  }
}

function assertDurableActivationNotCancelled(owner: DurableScanJobExecutionOwner): void {
  pruneDurableCancellationWatermarks();
  const watermark = durableCancellationWatermarks.get(owner.jobId);
  if (watermark && watermark.generation >= owner.generation) {
    throw new PublicScanError("This durable scan-job activation was cancelled.", 409);
  }
}

function recordDurableCancellationWatermark(control: DurableScanJobGenerationControl): void {
  const nowMs = Date.now();
  pruneDurableCancellationWatermarks(nowMs);

  const existing = durableCancellationWatermarks.get(control.jobId);
  const generation = Math.max(existing?.generation ?? 0, control.generation);
  if (existing) {
    if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
    durableCancellationWatermarks.delete(control.jobId);
  }

  // The private route is authenticated, but keep even trusted cancellation
  // state bounded so repeated unknown IDs cannot retain process memory.
  while (durableCancellationWatermarks.size >= MAX_RETAINED_JOBS) {
    const oldestJobId = durableCancellationWatermarks.keys().next().value as string | undefined;
    if (!oldestJobId) break;
    const oldest = durableCancellationWatermarks.get(oldestJobId);
    if (oldest?.cleanupTimer) clearTimeout(oldest.cleanupTimer);
    durableCancellationWatermarks.delete(oldestJobId);
  }

  const entry: DurableCancellationWatermark = {
    generation,
    expiresAtMs: nowMs + DURABLE_LOCAL_RECORD_RETENTION_MS
  };
  entry.cleanupTimer = setTimeout(() => {
    if (durableCancellationWatermarks.get(control.jobId) === entry) {
      durableCancellationWatermarks.delete(control.jobId);
    }
  }, DURABLE_LOCAL_RECORD_RETENTION_MS);
  entry.cleanupTimer.unref?.();
  durableCancellationWatermarks.set(control.jobId, entry);
}

function pruneDurableCancellationWatermarks(nowMs = Date.now()): void {
  for (const [jobId, entry] of durableCancellationWatermarks) {
    if (entry.expiresAtMs > nowMs) continue;
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    durableCancellationWatermarks.delete(jobId);
  }
}

function clearDurableCancellationWatermarks(): void {
  for (const entry of durableCancellationWatermarks.values()) {
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  }
  durableCancellationWatermarks.clear();
}

function assertDurableActivation(activation: DurableScanJobActivation): void {
  if (!isDurableScanJobActivation(activation)) {
    throw new Error("Invalid durable scan-job activation.");
  }
}

function preparedRequestFromDurablePayload(payload: DurableScanJobPayload): PreparedScanRequest {
  return {
    // A durable payload never contains the admission client key. Execution is
    // explicitly uncharged, so this non-identifying sentinel is not observed by
    // either limiter and cannot link a replay back to its caller.
    clientKey: "durable-admitted",
    url: payload.url,
    device: payload.device,
    gpcEnabled: payload.gpcEnabled,
    compareGpc: payload.compareGpc,
    compareShields: payload.compareShields,
    compareConsent: payload.compareConsent,
    rateLimitCost: payload.rateLimitCost
  };
}

function validatedHeartbeatInterval(value: number | undefined): number {
  const interval = value ?? DURABLE_SCAN_JOB_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > DURABLE_SCAN_JOB_HEARTBEAT_INTERVAL_MS) {
    throw new Error("Invalid durable scan-job heartbeat interval.");
  }
  return interval;
}

function validatedLocalCleanupDelay(value: number | undefined): number {
  const delay = value ?? DURABLE_LOCAL_RECORD_RETENTION_MS;
  if (!Number.isSafeInteger(delay) || delay < 1 || delay > DURABLE_LOCAL_RECORD_RETENTION_MS) {
    throw new Error("Invalid durable scan-job local cleanup delay.");
  }
  return delay;
}

function validatedPublicationTimeout(value: number | undefined): number {
  const timeout = value ?? DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > DURABLE_SCAN_JOB_PUBLICATION_TIMEOUT_MS
  ) {
    throw new Error("Invalid durable scan-job publication timeout.");
  }
  return timeout;
}

function validatedReconciliationTimeout(value: number | undefined): number {
  const timeout = value ?? DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS
  ) {
    throw new Error("Invalid durable scan-job reconciliation timeout.");
  }
  return timeout;
}

function pruneScanJobs(nowMs = Date.now()): void {
  for (const [id, record] of jobs) {
    if (record.durable) {
      // The DO owns status/deadline/tombstone truth. Node only drops bounded
      // process-local copies after their worker detached or a terminal result
      // was handed off; it never rewrites the authoritative state.
      const detachedAt = record.durable.detachedAtMs;
      const terminalAt = isTerminalStatus(record.status)
        ? Date.parse(record.finishedAt ?? record.updatedAt)
        : Number.NaN;
      const cleanupFrom = detachedAt ?? (Number.isFinite(terminalAt) ? terminalAt : undefined);
      if (cleanupFrom !== undefined && nowMs - cleanupFrom >= record.durable.localRetentionMs) {
        stopDurableHeartbeat(record);
        stopDurableLocalCleanup(record);
        removeQueuedJobId(id);
        jobs.delete(id);
      }
      continue;
    }
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
    stopDurableLocalCleanup(record);
    removeQueuedJobId(record.id);
    jobs.delete(record.id);
  }
}

function removeQueuedJobId(id: string): void {
  const index = queuedJobIds.indexOf(id);
  if (index >= 0) queuedJobIds.splice(index, 1);
}

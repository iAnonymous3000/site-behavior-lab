import type { DurableScanJobRegistration } from "./durable-scan-job-registry";
import { readStoredScanReport } from "./scan-report-reader";

export type DurableScanJobInternalState =
  | "queued"
  | "leased"
  | "publishing"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export type DurableScanJobRecoverySnapshot = Readonly<{
  jobId: string;
  reportId: string;
  state: DurableScanJobInternalState;
  totalRuns: number;
}>;

type SnapshotRecoveryDependencies = {
  fetchReport: (reportId: string) => Promise<Response>;
  onReportError?: (error: unknown) => void;
  // Emitted only by the separately attested, token-gated staging fault hook.
  // Production callers never provide it, preserving the public status wire.
  stagingFaultEvidence?: {
    faultMode: "lease-expiry" | "lost-resolve";
    attempts: number;
    triggered: boolean;
    triggeredGeneration: number | null;
    finishedBeforeStatusRequest: boolean;
  };
};

type RecoveryDependencies = {
  findRegistration: (jobId: string) => Promise<DurableScanJobRegistration | null>;
  fetchReport: (reportId: string) => Promise<Response>;
  onRegistryError?: (error: unknown) => void;
  onReportError?: (error: unknown) => void;
};

type CancellationRecoveryDependencies = Pick<RecoveryDependencies, "findRegistration" | "onRegistryError">;

/** Collapse the internal lease/publication vocabulary onto the public API. */
export function publicDurableScanJobStatus(state: DurableScanJobInternalState):
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled" {
  if (state === "leased" || state === "publishing") return "running";
  return state;
}

/**
 * Render the Durable Object's authoritative Phase-2 status. Lease credentials,
 * manifests, report capabilities, and ciphertext never cross this boundary.
 * Production also omits attempts; the separately attested staging replay hook
 * may add bounded attempt/fault evidence for its two operator canaries. A
 * succeeded status is returned only with the exact saved report.
 */
export async function recoverDurableScanJobSnapshotResponse(
  snapshot: DurableScanJobRecoverySnapshot,
  source: Response,
  dependencies: SnapshotRecoveryDependencies
): Promise<Response> {
  const status = publicDurableScanJobStatus(snapshot.state);
  const totalRuns = snapshot.totalRuns === 2 ? 2 : 1;
  const progress =
    snapshot.state === "queued"
      ? { phase: "queued", completedRuns: 0, totalRuns }
      : snapshot.state === "publishing" || snapshot.state === "succeeded"
        ? { phase: "saving", completedRuns: totalRuns, totalRuns }
        : { phase: "waiting", completedRuns: 0, totalRuns };

  if (snapshot.state === "succeeded") {
    let reportResponse: Response;
    try {
      reportResponse = await dependencies.fetchReport(snapshot.reportId);
    } catch (error) {
      dependencies.onReportError?.(error);
      return recoveryJson(
        { ok: false, error: "The saved scan report could not be read during durable recovery." },
        source,
        503
      );
    }
    if (reportResponse.status === 404) {
      return recoveryJson(
        { ok: false, error: "The saved scan report is temporarily unavailable during durable recovery." },
        source,
        502
      );
    }
    if (!reportResponse.ok) return reportResponse;

    let report: unknown;
    try {
      report = await reportResponse.json();
    } catch {
      return recoveryJson(
        { ok: false, error: "The saved scan report could not be read during durable recovery." },
        source,
        502
      );
    }
    if (!readStoredScanReport(report).ok) {
      return recoveryJson(
        { ok: false, error: "The saved scan report was invalid during durable recovery." },
        source,
        502
      );
    }
    return recoveryJson(
      withStagingFaultEvidence(
        { ok: true, jobId: snapshot.jobId, status, progress, report },
        dependencies.stagingFaultEvidence
      ),
      source
    );
  }

  const payload: Record<string, unknown> = { ok: true, jobId: snapshot.jobId, status, progress };
  if (snapshot.state === "failed") payload.error = "This scan job could not be completed.";
  if (snapshot.state === "expired") {
    payload.error = "This scan job expired because durable completion could not be confirmed.";
  }
  if (snapshot.state === "cancelled") payload.error = "This scan job was cancelled.";
  return recoveryJson(withStagingFaultEvidence(payload, dependencies.stagingFaultEvidence), source);
}

function withStagingFaultEvidence(
  payload: Record<string, unknown>,
  evidence: SnapshotRecoveryDependencies["stagingFaultEvidence"]
): Record<string, unknown> {
  if (!evidence) return payload;
  return {
    ...payload,
    durable: {
      faultMode: evidence.faultMode,
      attempts: evidence.attempts,
      triggered: evidence.triggered,
      triggeredGeneration: evidence.triggeredGeneration,
      finishedBeforeStatusRequest: evidence.finishedBeforeStatusRequest
    }
  };
}

/** Idempotent, control-only response after the DO has atomically cancelled. */
export function durableScanJobCancellationResponse(
  snapshot: DurableScanJobRecoverySnapshot,
  source: Response
): Response {
  return recoveryJson(
    {
      ok: true,
      jobId: snapshot.jobId,
      status: "cancelled",
      progress: { phase: "waiting", completedRuns: 0, totalRuns: snapshot.totalRuns === 2 ? 2 : 1 },
      error: "This scan job was cancelled."
    },
    source
  );
}

/**
 * Turn an in-memory 404 into an evidence-backed terminal answer when the edge
 * registry still knows the job. Only a genuine saved-report 404 can produce
 * `expired`; every probe/storage fault stays retryable and never fabricates a
 * terminal outcome.
 */
export async function recoverDurableScanJobResponse(
  jobId: string,
  missingJobResponse: Response,
  dependencies: RecoveryDependencies
): Promise<Response> {
  let registration: DurableScanJobRegistration | null;
  try {
    registration = await dependencies.findRegistration(jobId);
  } catch (error) {
    dependencies.onRegistryError?.(error);
    return missingJobResponse;
  }
  if (!registration) return missingJobResponse;

  let reportResponse: Response;
  try {
    reportResponse = await dependencies.fetchReport(registration.reportId);
  } catch (error) {
    dependencies.onReportError?.(error);
    return missingJobResponse;
  }

  if (reportResponse.status === 404) {
    return recoveryJson(
      {
        ok: true,
        jobId,
        status: "expired",
        error:
          "The scanner lost this job's in-memory status, and no saved report is available, so the job can no longer be recovered."
      },
      missingJobResponse
    );
  }
  if (!reportResponse.ok) {
    return reportResponse;
  }

  let report: unknown;
  try {
    report = await reportResponse.json();
  } catch {
    return recoveryJson(
      { ok: false, error: "The saved scan report could not be read during restart recovery." },
      missingJobResponse,
      502
    );
  }
  // Saved-report recovery crosses the same version-aware public-wire boundary
  // as every other reader. r2 reports intentionally have no root `ok`, so a
  // transport-era truthiness check would turn valid recovered jobs into 502s.
  // Validate canonically, then return the parsed wire itself without projecting
  // or rewriting it so recovery preserves the exact persisted payload.
  if (!readStoredScanReport(report).ok) {
    return recoveryJson(
      { ok: false, error: "The saved scan report was invalid during restart recovery." },
      missingJobResponse,
      502
    );
  }

  return recoveryJson(
    {
      ok: true,
      jobId,
      status: "succeeded",
      progress: { phase: "saving", completedRuns: registration.totalRuns, totalRuns: registration.totalRuns },
      report
    },
    missingJobResponse
  );
}

/**
 * A lost in-memory job has no worker or AbortController left to cancel. Keep
 * DELETE a control-only response: never attach the report recovered for GET.
 */
export async function recoverDurableScanJobCancellationResponse(
  jobId: string,
  missingJobResponse: Response,
  dependencies: CancellationRecoveryDependencies
): Promise<Response> {
  let registration: DurableScanJobRegistration | null;
  try {
    registration = await dependencies.findRegistration(jobId);
  } catch (error) {
    dependencies.onRegistryError?.(error);
    return missingJobResponse;
  }
  if (!registration) return missingJobResponse;

  return recoveryJson(
    {
      ok: false,
      error: "This scan job can no longer be cancelled because its in-memory status was lost."
    },
    missingJobResponse,
    409
  );
}

function recoveryJson(payload: unknown, source: Response, status = 200): Response {
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}

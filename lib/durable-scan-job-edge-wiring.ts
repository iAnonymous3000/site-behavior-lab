import type {
  DurableScanJobPreparation,
  DurableScanJobSubmission
} from "./durable-scan-job-contract";

export type DurableScanJobAdmissionOutcome =
  | { accepted: true; status: 202; submission: DurableScanJobSubmission }
  | { accepted: false; status: 503 };

export type DurableScanJobAdmissionProof = Readonly<{
  jobId: string;
  reportId: string;
  createdAt: number;
  totalRuns: 1 | 2;
}>;

export type DurableScanJobPumpWakeInput = Readonly<{
  storeWakeAt: number | null;
  publishingWakeAt: number | null;
  minimumWakeAt?: number;
}>;

export type DurableScanJobsFlagState = "disabled" | "enabled" | "misconfigured";

export type DurableScanJobNodeHealthState = Readonly<{
  requested: boolean;
  ready: boolean;
}>;

/** Feature flags are an exact wire contract; whitespace is never normalized. */
export function durableScanJobsFlagState(value: string | undefined): DurableScanJobsFlagState {
  if (value === undefined || value === "" || value === "0") return "disabled";
  return value === "1" ? "enabled" : "misconfigured";
}

/** Read only the rollout fields the edge needs from the untrusted Node health wire. */
export function durableScanJobNodeHealthState(checks: unknown): DurableScanJobNodeHealthState {
  const durableJobs =
    checks && typeof checks === "object"
      ? (checks as Record<string, unknown>).durableJobs
      : undefined;
  if (!durableJobs || typeof durableJobs !== "object") return { requested: false, ready: false };
  const record = durableJobs as Record<string, unknown>;
  return {
    requested: record.requested === true,
    ready: record.requested === true && record.readiness === "node-ready"
  };
}

export function durablePumpReuseNeedsAlarmKick(scheduleTimeSeconds: number, nowMs: number): boolean {
  return (
    Number.isSafeInteger(scheduleTimeSeconds) &&
    scheduleTimeSeconds >= 0 &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= 0 &&
    scheduleTimeSeconds * 1_000 <= nowMs
  );
}

/** Never let a reconciliation request keep encrypted job state past purge. */
export function durableReconciliationTimeoutMs(
  nowMs: number,
  purgeAtMs: number,
  maximumTimeoutMs = 30_000
): number {
  return Math.max(0, Math.min(maximumTimeoutMs, purgeAtMs - nowMs));
}

/** The Worker-only AES key must never alias the token forwarded into Node. */
export function durableScanJobSecretsAreDistinct(encryptionKey: string, internalToken: string): boolean {
  const key = encryptionKey.trim();
  const token = internalToken.trim();
  return key.length > 0 && token.length > 0 && key !== token;
}

/** No value forwarded into Node may reuse the Worker-only admission key. */
export function durableScanJobKeyIsIsolated(encryptionKey: string, forwardedSecrets: readonly string[]): boolean {
  const key = encryptionKey.trim();
  return key.length > 0 && forwardedSecrets.every((value) => !value.trim() || value.trim() !== key);
}

/**
 * The sole public-acceptance boundary: a 202-shaped result is impossible until
 * the injected Durable Object commit (which also schedules the pump) resolves.
 */
export async function finalizeDurableScanJobAdmission(
  preparation: DurableScanJobPreparation,
  commit: (preparation: DurableScanJobPreparation) => Promise<unknown>,
  onFailure?: (error: unknown) => void,
  recoverCommitted?: (preparation: DurableScanJobPreparation, error: unknown) => Promise<boolean>,
  isDefinitiveRejection?: (error: unknown, attempt: 1 | 2) => boolean
): Promise<DurableScanJobAdmissionOutcome> {
  let finalError: unknown;
  // One bounded retry closes the commit-response-lost + transient-readback
  // window. The preparation carries the same random job/report capabilities;
  // the DO refuses a duplicate and the exact readback below distinguishes a
  // committed retry from capacity/collision or infrastructure failure.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await commit(preparation);
      return { accepted: true, status: 202, submission: preparation.submission };
    } catch (error) {
      finalError = error;
    }
    // A typed refusal returned by the authoritative DO proves that this
    // attempt did not commit. In particular, quota rejection must not be
    // retried as a second admission attempt. Transport/store failures remain
    // outcome-unknown and still use exact readback plus one idempotent retry.
    if (isDefinitiveRejection?.(finalError, attempt === 0 ? 1 : 2)) {
      onFailure?.(finalError);
      return { accepted: false, status: 503 };
    }
    try {
      if (recoverCommitted && (await recoverCommitted(preparation, finalError))) {
        return { accepted: true, status: 202, submission: preparation.submission };
      }
    } catch {
      // Retry the same capability once. A second failed exact readback remains
      // indistinguishable from no commit and must preserve the public 503.
    }
  }
  onFailure?.(finalError);
  return { accepted: false, status: 503 };
}

export function durableScanJobAdmissionProofMatches(
  proof: DurableScanJobAdmissionProof | null,
  preparation: DurableScanJobPreparation
): boolean {
  if (!proof) return false;
  const totalRuns =
    preparation.payload.compareGpc ||
    preparation.payload.compareShields ||
    preparation.payload.compareConsent
      ? 2
      : 1;
  return (
    proof.jobId === preparation.submission.jobId &&
    proof.reportId === preparation.submission.reportId &&
    proof.createdAt === preparation.payload.admittedAt &&
    proof.totalRuns === totalRuns
  );
}

/** Keep independently classified hard/store and publishing recovery wakes. */
export function chooseDurableScanJobPumpWakeAt(input: DurableScanJobPumpWakeInput): number | null {
  const candidates = [input.storeWakeAt, input.publishingWakeAt, input.minimumWakeAt].filter(
    (value): value is number => value !== null && value !== undefined
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

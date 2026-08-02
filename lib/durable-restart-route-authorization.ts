import { isScanAdmissionCommitment } from "./scan-admission-capability";
import type { ScanAdmissionStoreKey } from "./scan-admission-store";
import { isScanJobId } from "./durable-scan-job-contract";
import {
  isDurableRestartGithubRunId,
  verifyDurableRestartControlAuthorization
} from "./durable-restart-control-auth";
import { constantTimeEqual } from "./edge-scan-gate";
import { isProductionSyntheticMonitorToken } from "./production-synthetic";

export type DurableRestartRouteAuthorizationInput = Readonly<{
  expectedMonitorToken: unknown;
  suppliedMonitorToken: unknown;
  expectedRestartToken: unknown;
  secretCollisionCandidates: readonly unknown[];
  githubRunId: unknown;
  jobId: unknown;
  reportId: unknown;
  restartAuthorization: unknown;
  admissionKey: ScanAdmissionStoreKey | null;
}>;

export type AuthorizedDurableRestartRoute = Readonly<{
  admissionKey: ScanAdmissionStoreKey;
  githubRunId: string;
  jobId: string;
  reportId: string;
}>;

export type DurableRestartRouteDestroyResult<T> =
  | Readonly<{ status: "completed"; snapshot: T }>
  | Readonly<{ status: "pending" }>
  | null;

export type DurableRestartRouteExecution<T> =
  | Readonly<{ status: "not-found" }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; snapshot: T }>;

/**
 * Make the complete edge-only authorization decision before the destructive
 * Container RPC is resolved. The authoritative Durable Object repeats the
 * admission-to-job binding check before it consumes the one-shot marker.
 */
export async function authorizeDurableRestartRoute(
  input: DurableRestartRouteAuthorizationInput
): Promise<AuthorizedDurableRestartRoute | null> {
  const expectedMonitorToken = trimmedString(input.expectedMonitorToken);
  const suppliedMonitorToken = trimmedString(input.suppliedMonitorToken);
  const expectedRestartToken = trimmedString(input.expectedRestartToken);
  const githubRunId = trimmedString(input.githubRunId);
  const jobId = trimmedString(input.jobId);
  const reportId = trimmedString(input.reportId);
  const restartAuthorization = trimmedString(input.restartAuthorization);

  if (
    !isProductionSyntheticMonitorToken(expectedMonitorToken) ||
    !suppliedMonitorToken ||
    !isProductionSyntheticMonitorToken(expectedRestartToken) ||
    !isDurableRestartGithubRunId(githubRunId) ||
    !isScanJobId(jobId) ||
    !isScanJobId(reportId) ||
    reportId === jobId ||
    !restartAuthorization ||
    !isScanAdmissionStoreKey(input.admissionKey)
  ) {
    return null;
  }

  const collidingSecrets = [
    expectedMonitorToken,
    ...input.secretCollisionCandidates
  ]
    .map(trimmedString)
    .filter((value): value is string => Boolean(value));
  if (
    collidingSecrets.includes(expectedRestartToken) ||
    !(await constantTimeEqual(
      suppliedMonitorToken,
      expectedMonitorToken
    ))
  ) {
    return null;
  }

  try {
    if (
      !(await verifyDurableRestartControlAuthorization(
        expectedRestartToken,
        { githubRunId, jobId, reportId },
        restartAuthorization
      ))
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return Object.freeze({
    admissionKey: input.admissionKey,
    githubRunId,
    jobId,
    reportId
  });
}

/**
 * Keep the destructive RPC behind both edge authentication and a separate
 * authoritative admission-binding read. The ScannerContainer repeats the
 * binding and lease checks inside the destructive method, closing the TOCTOU
 * gap; this first read ensures malformed or cross-bound requests never invoke
 * that method at all.
 */
export async function executeDurableRestartRoute<T>(
  input: DurableRestartRouteAuthorizationInput,
  dependencies: Readonly<{
    admissionMatches: (
      authorization: AuthorizedDurableRestartRoute
    ) => Promise<boolean>;
    destroyRuntime: (
      authorization: AuthorizedDurableRestartRoute
    ) => Promise<DurableRestartRouteDestroyResult<T>>;
  }>
): Promise<DurableRestartRouteExecution<T>> {
  const authorization = await authorizeDurableRestartRoute(input);
  if (!authorization) {
    return Object.freeze({ status: "not-found" as const });
  }
  if (!(await dependencies.admissionMatches(authorization))) {
    return Object.freeze({ status: "not-found" as const });
  }
  const result = await dependencies.destroyRuntime(authorization);
  if (!result) {
    return Object.freeze({ status: "not-found" as const });
  }
  return result;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isScanAdmissionStoreKey(
  value: ScanAdmissionStoreKey | null
): value is ScanAdmissionStoreKey {
  return (
    value !== null &&
    value.capabilityHash instanceof ArrayBuffer &&
    value.capabilityHash.byteLength === 32 &&
    isScanAdmissionCommitment(value.requestCommitment)
  );
}

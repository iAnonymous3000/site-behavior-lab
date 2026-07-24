import { timingSafeEqual } from "node:crypto";
import { readDurableScanJobInternalResponseBytes } from "./durable-scan-job-internal-response";
import { readRequestBodyWithinLimit } from "./edge-scan-gate";
import { parseStrictJson } from "./strict-json";
import {
  DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX,
  DURABLE_SCAN_JOB_INTERNAL_HEADER,
  DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV,
  isDurableScanJobExecutionOwner,
  isDurableScanJobPayload,
  isScanJobId,
  type DurableScanJobExecutionOwner,
  type DurableScanJobPayload
} from "./durable-scan-job-contract";

export {
  DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX,
  DURABLE_SCAN_JOB_COORDINATOR_URL_ENV,
  DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV,
  DURABLE_SCAN_JOB_INTERNAL_HEADER,
  DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV,
  DURABLE_SCAN_JOB_NODE_PATH_PREFIX,
  DURABLE_SCAN_JOB_PREPARED_HEADER,
  DURABLE_SCAN_JOBS_ENV,
  decodeDurableScanJobPreparation,
  encodeDurableScanJobPreparation,
  isDurableScanJobExecutionOwner,
  isScanJobId,
  readDurableScanJobPreparation,
  type DurableScanJobExecutionOwner,
  type DurableScanJobPayload,
  type DurableScanJobPreparation,
  type DurableScanJobSubmission
} from "./durable-scan-job-contract";

export const DURABLE_SCAN_JOB_HEARTBEAT_INTERVAL_MS = 30_000;
export const DURABLE_SCAN_JOB_COORDINATOR_TIMEOUT_MS = 10_000;
export const DURABLE_SCAN_JOB_COORDINATOR_RESPONSE_MAX_BYTES = 8 * 1024;
export const DURABLE_SCAN_JOB_INTERNAL_REQUEST_MAX_BYTES = 64 * 1024;

export type DurableScanJobActivation = DurableScanJobExecutionOwner & {
  reportId: string;
  payload: DurableScanJobPayload;
  coordinatorUrl: string;
  internalToken: string;
};

export type DurableScanJobResolution =
  | { outcome: "succeeded" }
  | { outcome: "failed"; error: string }
  | { outcome: "cancelled"; error: string };

export interface DurableScanJobCoordinator {
  heartbeat(owner: DurableScanJobExecutionOwner, signal?: AbortSignal): Promise<void>;
  beginPublishing(owner: DurableScanJobExecutionOwner, manifest: unknown, signal?: AbortSignal): Promise<void>;
  resolve(owner: DurableScanJobExecutionOwner, resolution: DurableScanJobResolution, signal?: AbortSignal): Promise<void>;
}

export class DurableScanJobCoordinatorError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DurableScanJobCoordinatorError";
  }

  get definitiveConflict(): boolean {
    return this.status === 409;
  }
}

export function assertDurableScanJobInternalRequest(
  request: Request,
  expectedToken = process.env[DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV] ?? ""
): void {
  const expected = expectedToken.trim();
  const presented = (request.headers.get(DURABLE_SCAN_JOB_INTERNAL_HEADER) ?? "").trim();
  if (!validInternalToken(expected) || !secretTokensEqual(expected, presented)) {
    throw new DurableScanJobCoordinatorError("Unauthorized durable scan-job control request.", 401);
  }
}

/** Parse one authenticated private control request without buffering an unbounded body. */
export async function readDurableScanJobInternalRequestJson(
  request: Request,
  maxBytes = DURABLE_SCAN_JOB_INTERNAL_REQUEST_MAX_BYTES
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("The durable scan-job internal request limit must be a positive integer.");
  }
  const body = await readRequestBodyWithinLimit(request, maxBytes);
  if (body === null) {
    throw new DurableScanJobCoordinatorError("The durable scan-job control request is too large.", 413);
  }
  try {
    return parseStrictJson(body, maxBytes);
  } catch {
    throw new DurableScanJobCoordinatorError("The durable scan-job control request must be valid JSON.", 400);
  }
}

export function isDurableScanJobActivation(value: unknown): value is DurableScanJobActivation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "coordinatorUrl",
    "generation",
    "internalToken",
    "jobId",
    "leaseToken",
    "payload",
    "reportId"
  ].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return false;
  if (
    !isDurableScanJobExecutionOwner({
      jobId: record.jobId,
      generation: record.generation,
      leaseToken: record.leaseToken
    }) ||
    !isScanJobId(record.reportId) ||
    record.reportId === record.jobId ||
    !isDurableScanJobPayload(record.payload) ||
    typeof record.coordinatorUrl !== "string" ||
    typeof record.internalToken !== "string"
  ) {
    return false;
  }
  try {
    normalizeCoordinatorOrigin(record.coordinatorUrl);
    validateInternalToken(record.internalToken);
    return true;
  } catch {
    return false;
  }
}

type CoordinatorClientOptions = {
  coordinatorUrl: string;
  internalToken: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

/**
 * HTTP bridge from the Node container back to its authoritative Durable
 * Object. Response bodies are intentionally ignored: these are control-only
 * transitions and must never return a target, report, or lease secret.
 */
export function createDurableScanJobCoordinatorClient(
  options: CoordinatorClientOptions
): DurableScanJobCoordinator {
  const coordinatorOrigin = normalizeCoordinatorOrigin(options.coordinatorUrl);
  const internalToken = validateInternalToken(options.internalToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = validateCoordinatorTimeout(options.requestTimeoutMs);

  const post = async (
    owner: DurableScanJobExecutionOwner,
    action: "heartbeat" | "begin-publishing" | "resolve",
    extra: Record<string, unknown> = {},
    executionSignal?: AbortSignal
  ): Promise<void> => {
    assertDurableScanJobExecutionOwner(owner);
    const endpoint = new URL(
      `${DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX}/${owner.jobId}/${action}`,
      coordinatorOrigin
    );
    const requestController = new AbortController();
    const abortFromExecution = () => {
      requestController.abort(
        executionSignal?.reason ?? new DOMException("Durable scan-job execution was aborted.", "AbortError")
      );
    };
    if (executionSignal?.aborted) abortFromExecution();
    else executionSignal?.addEventListener("abort", abortFromExecution, { once: true });
    const timeout = setTimeout(() => {
      requestController.abort(new DOMException("Durable scan-job coordinator request timed out.", "TimeoutError"));
    }, requestTimeoutMs);
    timeout.unref?.();

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          [DURABLE_SCAN_JOB_INTERNAL_HEADER]: internalToken
        },
        body: JSON.stringify({ ...owner, ...extra }),
        cache: "no-store",
        redirect: "error",
        signal: requestController.signal
      });
      // Consume the response so the Container/Worker request lifecycle can
      // settle; the bounded signal also prevents a stalled body from pinning a
      // scan worker forever.
      await readDurableScanJobInternalResponseBytes(
        response,
        requestController.signal,
        DURABLE_SCAN_JOB_COORDINATOR_RESPONSE_MAX_BYTES
      );
    } catch (error) {
      throw new DurableScanJobCoordinatorError("The durable scan-job coordinator could not be reached.", null, {
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      executionSignal?.removeEventListener("abort", abortFromExecution);
    }

    if (response.ok) return;
    if (response.status === 409) {
      throw new DurableScanJobCoordinatorError("The durable scan-job lease is no longer current.", 409);
    }
    throw new DurableScanJobCoordinatorError(
      `The durable scan-job coordinator returned HTTP ${response.status}.`,
      response.status
    );
  };

  return {
    heartbeat: (owner, signal) => post(owner, "heartbeat", {}, signal),
    beginPublishing: (owner, manifest, signal) => post(owner, "begin-publishing", { manifest }, signal),
    resolve: (owner, resolution, signal) => post(owner, "resolve", resolution, signal)
  };
}

export function assertDurableScanJobExecutionOwner(
  owner: DurableScanJobExecutionOwner
): void {
  if (!isDurableScanJobExecutionOwner(owner)) {
    throw new Error("Invalid durable scan-job execution owner.");
  }
}

function normalizeCoordinatorOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid durable scan-job coordinator URL.");
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Durable scan-job coordinator URL must be an HTTPS origin.");
  }
  return new URL(url.origin);
}

function validateInternalToken(value: string): string {
  const token = value.trim();
  if (!validInternalToken(token)) {
    throw new Error("Invalid durable scan-job internal token.");
  }
  return token;
}

function validInternalToken(token: string): boolean {
  return token.length >= 32 && token.length <= 4_096 && !/[\r\n]/.test(token);
}

function validateCoordinatorTimeout(value: number | undefined): number {
  const timeout = value ?? DURABLE_SCAN_JOB_COORDINATOR_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DURABLE_SCAN_JOB_HEARTBEAT_INTERVAL_MS) {
    throw new Error("Invalid durable scan-job coordinator timeout.");
  }
  return timeout;
}

function secretTokensEqual(expected: string, presented: string): boolean {
  if (!expected || !presented) return false;
  const expectedBytes = Buffer.from(expected);
  const presentedBytes = Buffer.from(presented);
  return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

import {
  DurableScanJobInternalResponseInvalidUtf8Error,
  readDurableScanJobInternalResponseBytes
} from "./durable-scan-job-internal-response";
import { isScanRuntimeHealth, type ScanRuntimeHealth } from "./scan-runtime-health";
import { parseStrictJson } from "./strict-json";

export const EDGE_HEALTH_OPERATION_TIMEOUT_MS = 10_000;
export const EDGE_HEALTH_RESPONSE_MAX_BYTES = 128 * 1024;

export class EdgeHealthOperationTimeoutError extends Error {
  constructor() {
    super("The scanner health operation timed out.");
    this.name = "EdgeHealthOperationTimeoutError";
  }
}

/** Bound upstream time-to-headers and every later health-overlay operation. */
export async function withEdgeHealthDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? EDGE_HEALTH_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The edge health timeout must be a positive integer.");
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new EdgeHealthOperationTimeoutError()), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(controller.signal.reason ?? new EdgeHealthOperationTimeoutError());
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Bound the decompressed Node health body and make stalled streams abortable. */
export async function readEdgeHealthResponseText(
  response: Response,
  signal?: AbortSignal,
  maxBytes = EDGE_HEALTH_RESPONSE_MAX_BYTES
): Promise<string> {
  const bytes = await readDurableScanJobInternalResponseBytes(response, signal, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DurableScanJobInternalResponseInvalidUtf8Error();
  }
}

export type EdgeContainerHealth = ScanRuntimeHealth & Record<string, unknown> & {
  status: "ok" | "degraded" | "error";
  scansAvailable: boolean;
  checks: NonNullable<ScanRuntimeHealth["checks"]>;
  capabilities: NonNullable<ScanRuntimeHealth["capabilities"]>;
  warnings: string[];
};

/** Reject partial, contradictory, or ambiguous Node health before the edge adds trusted readiness state. */
export function parseEdgeHealthResponseText(text: string): EdgeContainerHealth {
  const value = parseStrictJson(text, EDGE_HEALTH_RESPONSE_MAX_BYTES);
  if (
    !isScanRuntimeHealth(value) ||
    typeof value.status !== "string" ||
    typeof value.scansAvailable !== "boolean" ||
    value.checks === undefined ||
    value.capabilities === undefined ||
    value.warnings === undefined
  ) {
    throw new TypeError("The scanner health response did not satisfy the shared health contract.");
  }
  if (
    (!value.ok && (value.status !== "error" || value.scansAvailable)) ||
    (value.ok && value.status === "error") ||
    (value.status === "error" && value.scansAvailable) ||
    (value.status === "ok" && !value.scansAvailable)
  ) {
    throw new TypeError("The scanner health response contained contradictory readiness fields.");
  }
  return value as EdgeContainerHealth;
}

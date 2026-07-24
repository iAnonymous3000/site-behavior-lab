import {
  ReportStoreConfigError,
  ReportStoreListBoundsError,
  ReportStoreRequestTimeoutError,
  ReportStoreResponseInvalidUtf8Error,
  ReportStoreWriteConflictError
} from "./report-store-r2";

/**
 * Closed vocabulary for a report-store failure on the PUBLIC health projection.
 *
 * `/api/health` is unauthenticated. A backend error message is not: a
 * filesystem store reports absolute container paths, and an R2 failure carries
 * the upstream response body, which can name the bucket, the account, or the
 * signed request. Publishing that text tells an operator nothing the reason
 * token does not, while telling everyone else where the evidence lives.
 *
 * The token is what reaches the wire. The full message stays on the container
 * log, which is where the runbooks already send operators for diagnostics.
 */
export type ReportStoreFailureReason =
  | "misconfigured"
  | "unauthorized"
  | "unreachable"
  | "timed-out"
  | "bounds-exceeded"
  | "malformed-response"
  | "write-conflict"
  | "unknown";

const UNAUTHORIZED_STATUS = new Set([401, 403]);

/**
 * Classify from the error VALUE, never from its rendered message: a message
 * regex would have to read the very text this exists to keep off the wire, and
 * would leak whatever it failed to match.
 */
export function classifyReportStoreFailure(error: unknown): ReportStoreFailureReason {
  if (error instanceof ReportStoreConfigError) return "misconfigured";
  if (error instanceof ReportStoreListBoundsError) return "bounds-exceeded";
  if (error instanceof ReportStoreRequestTimeoutError) return "timed-out";
  if (error instanceof ReportStoreResponseInvalidUtf8Error) return "malformed-response";
  if (error instanceof ReportStoreWriteConflictError) return "write-conflict";

  const status = httpStatusOf(error);
  if (status !== null) {
    if (UNAUTHORIZED_STATUS.has(status)) return "unauthorized";
    if (status >= 500 || status === 408 || status === 429) return "unreachable";
    return "malformed-response";
  }

  const code = errnoOf(error);
  if (code !== null) {
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return "misconfigured";
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timed-out";
    return "unreachable";
  }

  if (error instanceof SyntaxError) return "malformed-response";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timed-out";
  if (error instanceof DOMException && error.name === "AbortError") return "timed-out";
  return "unknown";
}

function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function errnoOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z]{3,20}$/.test(code) ? code : null;
}

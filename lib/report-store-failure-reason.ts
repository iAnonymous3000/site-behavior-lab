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
 * Every object-level 404 the R2 backend can legitimately meet is already
 * handled before it reaches `assertOk`: a missing report, a missing sidecar, a
 * delete of something already gone. One that escapes therefore names a bucket
 * or an endpoint that does not exist, which is a configuration fault and not a
 * malformed answer. This is the r2 analogue of the filesystem ENOENT below,
 * and the two halves of this classifier used to disagree about it.
 */
const MISCONFIGURED_STATUS = new Set([404]);
/** Bound the `cause` walk so a self-referential chain cannot spin forever. */
const MAX_CAUSE_DEPTH = 8;

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

  // Walk the chain, not only its head. Node reports a transport failure as
  // `TypeError: fetch failed` and hangs the errno off `cause`, so the value the
  // R2 backend rethrows carries neither a status nor a code at the top level
  // and every real connection refusal or DNS failure classified "unknown",
  // which is the outcome the "unreachable" token exists to prevent.
  for (const link of causeChain(error)) {
    const status = httpStatusOf(link);
    if (status !== null) {
      if (UNAUTHORIZED_STATUS.has(status)) return "unauthorized";
      if (status >= 500 || status === 408 || status === 429) return "unreachable";
      if (MISCONFIGURED_STATUS.has(status)) return "misconfigured";
      return "malformed-response";
    }

    const code = errnoOf(link);
    if (code !== null) {
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return "misconfigured";
      if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timed-out";
      return "unreachable";
    }
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
  // Underscores included: the codes undici surfaces for a stalled or failed
  // connection (UND_ERR_CONNECT_TIMEOUT) and the resolver's own EAI_AGAIN carry
  // them, and the old letters-only pattern silently dropped every one of them
  // back to "unknown".
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,31}$/.test(code) ? code : null;
}

/**
 * The error and its `cause` ancestors, head first. The depth bound is what
 * terminates the walk: an error may name itself as its own cause, and a chain
 * long enough to matter carries no evidence the first few links did not.
 */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let link = error;
  while (chain.length < MAX_CAUSE_DEPTH && typeof link === "object" && link !== null) {
    chain.push(link);
    link = (link as { cause?: unknown }).cause;
  }
  return chain;
}

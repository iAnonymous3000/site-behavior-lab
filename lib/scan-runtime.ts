import { isThirdParty } from "./domain-utils";
import { safeParseUrl } from "./report-url";
import { redactUrlV2 } from "./redaction-v2";
import type { NetworkRequestRecord, StorageRecord, TrackerMatch } from "./types";
import {
  callBoundedPageCollector,
  type BoundedCollectorEvaluateLike
} from "./bounded-page-collector";

export const MAX_RECORDED_REQUESTS = 1_000;
// This must not exceed redaction-v2's raw URL ceiling. Rejecting before URL
// parsing keeps a hostile page from turning one request slot into multi-megabyte
// parser/classifier work that can never survive the public boundary anyway.
export const MAX_RECORDED_REQUEST_URL_CHARS = 16_384;
export const MAX_RECORDED_REQUEST_METHOD_CHARS = 64;
export const MAX_RECORDED_RESOURCE_TYPE_CHARS = 64;
export const MAX_PAGE_TITLE_CHARS = 512;
export const MAX_CAPTURED_STORAGE_RECORDS = 1_000;
export const MAX_CAPTURED_STORAGE_KEY_CHARS = 1_024;
export const MAX_CAPTURED_STORAGE_TOTAL_KEY_CHARS = 256 * 1024;
export const MAX_CAPTURED_STORAGE_TOTAL_VALUE_CHARS = 1024 * 1024;
export const NON_HTTP_WARNING_EXAMPLE_LIMIT = 5;
/**
 * The scan deadline arrived while a routed request handler was still running.
 *
 * v1 has no quality block, so without this line a visit whose final request
 * evidence was cut short is indistinguishable on the wire from one that saw
 * everything. The alternative the scanner used to take was rejecting the whole
 * visit, which discarded a finished measurement over one slow route.
 */
export const UNSETTLED_ROUTED_REQUEST_WARNING =
  "The scan deadline arrived while one or more requests were still being handled, so this visit's request evidence is incomplete.";
export const INVALID_UPSTREAM_RESPONSE_WARNING =
  "The scan proxy rejected one or more invalid upstream responses; request evidence may be incomplete.";
/**
 * The in-page fingerprint observer could not read every frame it attempted.
 *
 * v2 records this as a `fingerprinting` capture loss in its quality facts, but
 * v1 has no quality block at all: its run quality is derived entirely from the
 * HTTP status and the scanner's warnings. Without this line a run whose
 * observer never executed is indistinguishable on the v1 wire from a run that
 * looked and found nothing, and the report publishes "No fingerprint-like API
 * calls observed" as an unhedged absence claim.
 */
export const FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING =
  "The in-page fingerprint observer could not read one or more frames, so fingerprint-like API calls and heuristics for this visit are incomplete.";
const SCAN_TIMEOUT_MESSAGE = "The scan exceeded the maximum scan duration.";

export class ScanWarningCollector {
  readonly list: string[];
  private readonly seen: Set<string>;
  private readonly blockedUrlGroups = new Map<string, Set<string>>();

  constructor(initialWarnings: string[] = []) {
    this.list = [...initialWarnings];
    this.seen = new Set(this.list);
  }

  // Exact-duplicate warnings carry no information but bloat stored reports and
  // break list rendering keyed by message text. Retries of the same blocked URL
  // collapse into identical strings once the query is redacted, so drop repeats.
  add(message: string): void {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.list.push(message);
  }

  addNonHttpRequest(url: string): void {
    this.addBlockedUrlExample(
      "non-http",
      url,
      (redacted) => `Blocked a non-HTTP(S) request: ${redacted}`,
      `Blocked additional non-HTTP(S) requests. Only the first ${NON_HTTP_WARNING_EXAMPLE_LIMIT} examples are shown.`
    );
  }

  addUnverifiedRequest(url: string, label = "Blocked a request that could not be verified as public"): void {
    this.addBlockedUrlExample(
      `unverified:${label}`,
      url,
      (redacted) => `${label}: ${redacted}`,
      `Blocked additional requests that could not be verified as public. Only the first ${NON_HTTP_WARNING_EXAMPLE_LIMIT} examples are shown.`
    );
  }

  // Per-group cap on blocked-URL examples: a single broken or adversarial page
  // can fail the guard for dozens of distinct hosts, and one warning line each
  // would drown the report. Show the first few distinct URLs, then one summary.
  private addBlockedUrlExample(group: string, url: string, example: (redacted: string) => string, summary: string): void {
    const redacted = redactUrlV2(url).value;
    let urls = this.blockedUrlGroups.get(group);
    if (!urls) {
      urls = new Set<string>();
      this.blockedUrlGroups.set(group, urls);
    }
    if (urls.has(redacted)) return;
    urls.add(redacted);

    if (urls.size <= NON_HTTP_WARNING_EXAMPLE_LIMIT) {
      this.add(example(redacted));
      return;
    }
    if (urls.size === NON_HTTP_WARNING_EXAMPLE_LIMIT + 1) {
      this.add(summary);
    }
  }
}

export type ScanRequestBudgetDiagnostics = {
  name: "request-capture";
  family: "requests";
  captureLoss: boolean;
  captureLossCount: number;
};

export class ScanRequestBudget {
  private routedHttpRequestCount = 0;
  private recordedRequestCount = 0;
  private captureLossCount = 0;
  private capWarningAdded = false;

  constructor(
    private readonly warnings: ScanWarningCollector,
    private readonly maxRequests = MAX_RECORDED_REQUESTS,
    private readonly deferWarning = false
  ) {}

  allowRoutedHttpRequest(): boolean {
    this.routedHttpRequestCount += 1;
    if (this.routedHttpRequestCount <= this.maxRequests) {
      return true;
    }

    this.recordCaptureLoss();
    return false;
  }

  allowRecordedRequest(): boolean {
    if (this.recordedRequestCount < this.maxRequests) {
      this.recordedRequestCount += 1;
      return true;
    }

    this.recordCaptureLoss();
    return false;
  }

  releaseRecordedRequest(): void {
    this.recordedRequestCount = Math.max(this.recordedRequestCount - 1, 0);
  }

  /**
   * Target-free aggregate state for the phase-aware measurement seam. The
   * warning is the legacy v1 disclosure; this boolean is the corresponding
   * structured fact and deliberately does not expose request URLs.
   */
  getDiagnostics(): ScanRequestBudgetDiagnostics {
    return {
      name: "request-capture",
      family: "requests",
      captureLoss: this.captureLossCount > 0,
      captureLossCount: this.captureLossCount
    };
  }

  /**
   * Emit the legacy disclosure at a caller-owned evidence boundary. Scanner
   * runs defer this until excluded reload/policy traffic has been removed from
   * the monotonic loss counters; direct users retain the historical immediate
   * warning behavior.
   */
  emitCaptureLossWarning(): void {
    if (this.capWarningAdded) return;
    this.capWarningAdded = true;
    this.warnings.add(`The scan stopped recording or loading additional requests after ${this.maxRequests} requests.`);
  }

  private recordCaptureLoss(): void {
    this.captureLossCount += 1;
    if (!this.deferWarning) this.emitCaptureLossWarning();
  }
}

/**
 * Shared aggregate byte-budget warning vocabulary. The scanner emits these
 * exact strings and the public redaction boundary admits them by shape
 * (lib/redact-scan-report-v1.ts), so both sides must build from this one
 * template; hand-written copies drift and get replaced by the redacted
 * placeholder, which silently defeats the downstream cap-censoring gates.
 */
export function aggregateByteBudgetWarning(kind: "response" | "upload", limitBytes: number): string {
  const limitMib = Math.round(limitBytes / 1024 / 1024);
  return kind === "response"
    ? `The scan stopped loading additional response bytes after reaching the ${limitMib} MiB aggregate response-byte budget.`
    : `The scan stopped forwarding additional request bytes after reaching the ${limitMib} MiB aggregate upload-byte budget.`;
}

export type ScanTimeoutErrorFactory = () => Error;

/**
 * The error an aborted scan raises, from one place.
 *
 * A caller's own reason is preserved; anything else becomes an AbortError.
 * Written out by hand this drifted: the deadline helpers turned a non-Error
 * reason into a scan-TIMEOUT, so the same cancellation surfaced as a 504 or as
 * an AbortError depending on which line noticed it first.
 */
export function scanAbortError(signal: AbortSignal, message = "The scan was cancelled."): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(message, "AbortError");
}

export function scanTimeoutMs(
  started: number,
  maxDurationMs: number,
  preferredMs = maxDurationMs,
  now = Date.now(),
  createTimeoutError: ScanTimeoutErrorFactory = defaultScanTimeoutError
): number {
  const remaining = maxDurationMs - (now - started);
  if (remaining <= 0) {
    throw createTimeoutError();
  }

  return Math.max(1, Math.min(preferredMs, remaining));
}

export async function withScanDeadline<T>(
  operation: Promise<T>,
  started: number,
  maxDurationMs: number,
  createTimeoutError: ScanTimeoutErrorFactory = defaultScanTimeoutError
): Promise<T> {
  const timeoutMs = scanTimeoutMs(started, maxDurationMs, maxDurationMs, Date.now(), createTimeoutError);
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(createTimeoutError()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound a setup step that CREATES a resource, and dispose the resource if it
 * arrives after the deadline or the caller's cancellation already ended the
 * work it belonged to.
 *
 * Racing a promise abandons the loser, it does not cancel it. A proxy server or
 * browser context that materializes a moment late would otherwise stay open for
 * the lifetime of the process, holding a port or a Chromium context that
 * nothing will ever close, while the slot it belonged to has been released.
 * Ordinary cleanup cannot help, because it runs before the value exists.
 *
 * The step is a FACTORY, not a promise: an already-expired deadline must not
 * start creating a resource at all, and a caller that passes an eagerly
 * constructed promise has already started it. Cancellation composes with the
 * deadline, so aborting stops the wait and still disposes a late arrival.
 */
export async function withDeadlineDisposing<T>(
  start: () => Promise<T>,
  started: number,
  maxDurationMs: number,
  dispose: (value: T) => Promise<unknown> | unknown,
  createTimeoutError: ScanTimeoutErrorFactory = defaultScanTimeoutError,
  signal?: AbortSignal
): Promise<T> {
  // Throws before `start()` runs when nothing remains, so an expired deadline
  // creates nothing to dispose.
  scanTimeoutMs(started, maxDurationMs, maxDurationMs, Date.now(), createTimeoutError);
  if (signal?.aborted) throw scanAbortError(signal);

  const operation = start();
  const disposeLate = (): void => {
    void operation.then(
      (value) => Promise.resolve(dispose(value)).catch(() => undefined),
      () => undefined
    );
  };

  let onAbort: (() => void) | null = null;
  try {
    return await Promise.race([
      withScanDeadline(operation, started, maxDurationMs, createTimeoutError),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(scanAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } catch (error) {
    disposeLate();
    throw error;
  } finally {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

export type RecordedRequestLike = {
  method(): string;
  resourceType(): string;
  url(): string;
};

export type TrackerMatcher = (domain: string) => TrackerMatch | null;

type InternalRequestRecord<RequestT extends RecordedRequestLike> = NetworkRequestRecord & {
  request: RequestT;
};

export type RecordedResponseLike<RequestT extends RecordedRequestLike> = {
  request(): RequestT;
  status(): number;
};

export class ScanNetworkRecorder<RequestT extends RecordedRequestLike> {
  readonly requestBudget: ScanRequestBudget;
  private requestId = 0;
  private readonly records: InternalRequestRecord<RequestT>[] = [];

  constructor(
    private readonly options: {
      firstPartyHostname: string;
      warnings: ScanWarningCollector;
      trackerMatcher?: TrackerMatcher;
      maxRequests?: number;
      deferRequestBudgetWarning?: boolean;
    }
  ) {
    this.requestBudget = new ScanRequestBudget(
      options.warnings,
      options.maxRequests,
      options.deferRequestBudgetWarning === true
    );
  }

  recordRequest(request: RequestT, startedAtMs: number): void {
    // Reserve the bounded slot before reading or parsing any page-controlled
    // strings. Invalid/overlong requests release it below so they cannot consume
    // the retained-evidence budget, while post-cap requests stay O(1).
    if (!this.requestBudget.allowRecordedRequest()) return;
    const record = buildRecordedRequestRecord({
      firstPartyHostname: this.options.firstPartyHostname,
      id: this.requestId + 1,
      request,
      startedAtMs,
      trackerMatcher: this.options.trackerMatcher
    });
    if (!record) {
      this.requestBudget.releaseRecordedRequest();
      return;
    }
    this.requestId += 1;

    this.records.push({
      ...record,
      request
    });
  }

  recordResponse(response: RecordedResponseLike<RequestT>): void {
    const record = this.records.find((item) => item.request === response.request());
    if (record) record.status = response.status();
  }

  removeRequest(request: RequestT): boolean {
    const index = this.records.findIndex((item) => item.request === request);
    if (index < 0) return false;
    this.records.splice(index, 1);
    this.requestBudget.releaseRecordedRequest();
    return true;
  }

  publicRecords(
    finalFirstPartyHostname: string,
    decorate?: (record: NetworkRequestRecord, request: RequestT) => NetworkRequestRecord
  ): NetworkRequestRecord[] {
    return this.records.map(({ request, ...record }) => {
      const thirdParty = isThirdParty(finalFirstPartyHostname, record.domain);
      const publicRecord = {
        ...record,
        thirdParty,
        tracker: thirdParty && this.options.trackerMatcher ? this.options.trackerMatcher(record.domain) : null
      };
      return decorate ? decorate(publicRecord, request) : publicRecord;
    });
  }
}

function buildRecordedRequestRecord({
  firstPartyHostname,
  id,
  request,
  startedAtMs,
  trackerMatcher
}: {
  firstPartyHostname: string;
  id: number;
  request: RecordedRequestLike;
  startedAtMs: number;
  trackerMatcher?: TrackerMatcher;
}): NetworkRequestRecord | null {
  const requestUrl = request.url();
  if (requestUrl.length > MAX_RECORDED_REQUEST_URL_CHARS) return null;
  const parsed = safeParseUrl(requestUrl);
  if (!parsed || !isHttpUrl(parsed)) return null;

  const domain = parsed.hostname;
  const thirdParty = isThirdParty(firstPartyHostname, domain);
  const rawMethod = request.method();
  const rawResourceType = request.resourceType();

  return {
    id,
    // Keep the raw URL only inside the bounded in-memory recorder. The domain
    // and tracker match above must see raw evidence; buildScanResult is the one
    // public seam that redacts the completed record and accounts for removals.
    url: requestUrl,
    domain,
    method: rawMethod.length <= MAX_RECORDED_REQUEST_METHOD_CHARS ? rawMethod : "OTHER",
    resourceType: rawResourceType.length <= MAX_RECORDED_RESOURCE_TYPE_CHARS ? rawResourceType : "other",
    status: null,
    thirdParty,
    tracker: thirdParty && trackerMatcher ? trackerMatcher(domain) : null,
    startedAtMs
  };
}

export type RoutedHttpRequestGuardResult =
  | {
      action: "abort";
    }
  | {
      action: "continue";
      url: URL;
    };

export async function verifyRoutedHttpRequest({
  requestUrl,
  warnings,
  requestBudget,
  verifyPublicUrl,
  unverifiedWarning = "Blocked a request that could not be verified as public"
}: {
  requestUrl: string;
  warnings: ScanWarningCollector;
  requestBudget: ScanRequestBudget;
  verifyPublicUrl: (url: URL) => Promise<void>;
  unverifiedWarning?: string;
}): Promise<RoutedHttpRequestGuardResult> {
  // Admission precedes URL parsing. Once the route budget is exhausted, an
  // attacker cannot keep feeding large URL strings into the URL parser.
  if (!requestBudget.allowRoutedHttpRequest()) {
    return { action: "abort" };
  }
  try {
    if (requestUrl.length > MAX_RECORDED_REQUEST_URL_CHARS) {
      warnings.addUnverifiedRequest(requestUrl, unverifiedWarning);
      return { action: "abort" };
    }
    const parsed = new URL(requestUrl);
    if (!isHttpUrl(parsed)) {
      warnings.addNonHttpRequest(requestUrl);
      return { action: "abort" };
    }

    await verifyPublicUrl(parsed);
    return { action: "continue", url: parsed };
  } catch {
    warnings.addUnverifiedRequest(requestUrl, unverifiedWarning);
    return { action: "abort" };
  }
}

export type BoundedPageEvaluateLike = BoundedCollectorEvaluateLike;

export type BoundedPageTitle = {
  value: string;
  truncated: boolean;
};

/** Read no more title text across the browser/host boundary than can be used. */
export async function collectBoundedPageTitle(
  page: BoundedPageEvaluateLike,
  collectorKey: string
): Promise<BoundedPageTitle> {
  const wire = await callBoundedPageCollector(page, collectorKey, "title", MAX_PAGE_TITLE_CHARS);
  if (typeof wire !== "string" || wire.length > MAX_PAGE_TITLE_CHARS + 128) {
    return { value: "", truncated: true };
  }
  let result: unknown;
  try {
    result = JSON.parse(wire);
  } catch {
    return { value: "", truncated: true };
  }

  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as BoundedPageTitle).value !== "string" ||
    typeof (result as BoundedPageTitle).truncated !== "boolean" ||
    (result as BoundedPageTitle).value.length > MAX_PAGE_TITLE_CHARS
  ) {
    return { value: "", truncated: true };
  }
  return result as BoundedPageTitle;
}

export type StorageEntryCollection = {
  records: StorageRecord[];
  omittedCount: number;
  truncated: boolean;
};

/**
 * Read storage inside the page under row, key, and aggregate text ceilings.
 * Only the bounded result is serialized through Playwright. `omittedCount` is
 * exact for the synchronous snapshot and lets producers record capture loss.
 */
export async function collectStorageEntriesWithCoverage(
  page: BoundedPageEvaluateLike,
  collectorKey: string
): Promise<StorageEntryCollection> {
  const wire = await callBoundedPageCollector(page, collectorKey, "storage", {
    maxKeyChars: MAX_CAPTURED_STORAGE_KEY_CHARS,
    maxRecords: MAX_CAPTURED_STORAGE_RECORDS,
    maxTotalKeyChars: MAX_CAPTURED_STORAGE_TOTAL_KEY_CHARS,
    maxTotalValueChars: MAX_CAPTURED_STORAGE_TOTAL_VALUE_CHARS
  });
  if (typeof wire !== "string" || wire.length > 2 * 1024 * 1024) {
    return { records: [], omittedCount: 1, truncated: true };
  }
  let result: unknown;
  try {
    result = JSON.parse(wire);
  } catch {
    return { records: [], omittedCount: 1, truncated: true };
  }

  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as StorageEntryCollection).records) ||
    (result as StorageEntryCollection).records.length > MAX_CAPTURED_STORAGE_RECORDS
  ) {
    return { records: [], omittedCount: 1, truncated: true };
  }

  const candidate = result as StorageEntryCollection;
  const records = candidate.records.filter(
    (record) =>
      record !== null &&
      typeof record === "object" &&
      (record.area === "localStorage" || record.area === "sessionStorage") &&
      typeof record.key === "string" &&
      record.key.length <= MAX_CAPTURED_STORAGE_KEY_CHARS &&
      Number.isSafeInteger(record.valueBytes) &&
      record.valueBytes >= 0
  ).slice(0, MAX_CAPTURED_STORAGE_RECORDS);
  const invalidCount = candidate.records.length - records.length;
  const reportedOmitted = Number.isSafeInteger(candidate.omittedCount) && candidate.omittedCount >= 0
    ? candidate.omittedCount
    : 1;
  const omittedCount = Math.min(Number.MAX_SAFE_INTEGER, reportedOmitted + invalidCount);
  return {
    records,
    omittedCount,
    truncated: candidate.truncated === true || omittedCount > 0
  };
}

function defaultScanTimeoutError(): Error {
  return new Error(SCAN_TIMEOUT_MESSAGE);
}

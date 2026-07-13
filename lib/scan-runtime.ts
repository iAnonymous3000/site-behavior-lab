import { isThirdParty } from "./domain-utils";
import { safeParseUrl } from "./report-url";
import { redactUrlV2 } from "./redaction-v2";
import type { NetworkRequestRecord, StorageRecord, TrackerMatch } from "./types";

export const MAX_RECORDED_REQUESTS = 1_000;
export const NON_HTTP_WARNING_EXAMPLE_LIMIT = 5;
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

export class ScanRequestBudget {
  private routedHttpRequestCount = 0;
  private recordedRequestCount = 0;
  private capWarningAdded = false;

  constructor(
    private readonly warnings: ScanWarningCollector,
    private readonly maxRequests = MAX_RECORDED_REQUESTS
  ) {}

  allowRoutedHttpRequest(): boolean {
    this.routedHttpRequestCount += 1;
    if (this.routedHttpRequestCount <= this.maxRequests) {
      return true;
    }

    this.addRequestCapWarning();
    return false;
  }

  allowRecordedRequest(): boolean {
    if (this.recordedRequestCount < this.maxRequests) {
      this.recordedRequestCount += 1;
      return true;
    }

    this.addRequestCapWarning();
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
  getDiagnostics(): { name: "request-capture"; family: "requests"; captureLoss: boolean } {
    return {
      name: "request-capture",
      family: "requests",
      captureLoss: this.capWarningAdded
    };
  }

  private addRequestCapWarning(): void {
    if (this.capWarningAdded) return;
    this.capWarningAdded = true;
    this.warnings.add(`The scan stopped recording or loading additional requests after ${this.maxRequests} requests.`);
  }
}

export type ScanTimeoutErrorFactory = () => Error;

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
    }
  ) {
    this.requestBudget = new ScanRequestBudget(options.warnings, options.maxRequests);
  }

  recordRequest(request: RequestT, startedAtMs: number): void {
    const record = buildRecordedRequestRecord({
      firstPartyHostname: this.options.firstPartyHostname,
      id: this.requestId + 1,
      request,
      startedAtMs,
      trackerMatcher: this.options.trackerMatcher
    });
    if (!record) return;
    if (!this.requestBudget.allowRecordedRequest()) return;
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
  const parsed = safeParseUrl(request.url());
  if (!parsed || !isHttpUrl(parsed)) return null;

  const domain = parsed.hostname;
  const thirdParty = isThirdParty(firstPartyHostname, domain);

  return {
    id,
    // Keep the raw URL only inside the bounded in-memory recorder. The domain
    // and tracker match above must see raw evidence; buildScanResult is the one
    // public seam that redacts the completed record and accounts for removals.
    url: request.url(),
    domain,
    method: request.method(),
    resourceType: request.resourceType(),
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
  try {
    const parsed = new URL(requestUrl);
    if (!isHttpUrl(parsed)) {
      warnings.addNonHttpRequest(requestUrl);
      return { action: "abort" };
    }

    if (!requestBudget.allowRoutedHttpRequest()) {
      return { action: "abort" };
    }

    await verifyPublicUrl(parsed);
    return { action: "continue", url: parsed };
  } catch {
    warnings.addUnverifiedRequest(requestUrl, unverifiedWarning);
    return { action: "abort" };
  }
}

export type StoragePageLike = {
  evaluate<T>(pageFunction: () => T): Promise<T>;
};

export async function collectStorageEntries(page: StoragePageLike): Promise<StorageRecord[]> {
  return page.evaluate(() => {
    const readArea = (area: Storage, name: "localStorage" | "sessionStorage") =>
      Array.from({ length: area.length }, (_, index) => {
        const key = area.key(index) || "";
        const value = area.getItem(key) || "";
        return {
          area: name,
          key,
          valueBytes: new Blob([value]).size
        };
      });

    return [...readArea(localStorage, "localStorage"), ...readArea(sessionStorage, "sessionStorage")];
  });
}

function defaultScanTimeoutError(): Error {
  return new Error(SCAN_TIMEOUT_MESSAGE);
}

import {
  assertRequestBodySize,
  clientKeyFromRequest,
  MAX_BODY_BYTES,
  peekRateLimit
} from "./scan-limits";
import {
  comparisonModeCount,
  MULTIPLE_COMPARISON_MODES_MESSAGE,
  readRequestBodyWithinLimit
} from "./edge-scan-gate";
import type { ScanDevice, ScanRequestPayload } from "./types";
import { PublicScanError } from "./public-errors";
import { isExactPublicSuffixHost, isGeneralizedPrivateSuffixTenantHost } from "./redaction-v2";
import { assertPublicHttpUrl, assertPublicHttpUrlShape, normalizeUrl } from "./url-safety";
import { assertScanAccess } from "./access-control";
import { INSPECTION_V1_PRODUCER_REFUSAL } from "./connection-inspection-address";
import { isInspectableAddress } from "./connection-inspection";
import { requireRuntimeScanReportMode } from "./runtime-scan-report";

export const SCAN_TARGET_VERIFICATION_TIMEOUT_MS = 5_000;

export const PUBLIC_SUFFIX_SUBJECT_MESSAGE =
  "That host is a registry boundary (a public suffix such as github.io or gov.uk), not a site that can be scanned on its own. Enter a site under it, for example example.github.io.";

export const PRIVATE_SUFFIX_TENANT_SUBJECT_MESSAGE =
  "That host's name under its hosting provider looks like a network address, timestamp, or one-time token, which published reports generalize, so a report could not name the site. Scan the site's stable address instead.";

/**
 * Refuse a target the report format cannot name as a subject.
 *
 * The r2 subject key is derived from `publicRegistrableDomain`, so a host that
 * IS a public suffix has no such result and can only fail AFTER a full
 * measurement has already been paid for, surfacing as a 500 rather than as
 * anything the requester can act on. Refuse it here, ahead of quota, queueing,
 * and Chromium.
 *
 * Supporting these as subjects needs a schema revision that can carry a
 * non-registrable subject; borrowing the nearest registrable domain instead
 * would silently mislabel whose site the report is about. Bare IP literals
 * reach the same builder limit but are deliberately left alone here: they are
 * an established target shape with their own callers, and narrowing them is a
 * separate decision from this one.
 *
 * A host under a private suffix whose tenant label is address-, timestamp- or
 * token-shaped (for example a per-client akamaihd.net or netlify.app name)
 * reaches the same end by another road: the subject key keeps the raw
 * registrable domain, redaction generalizes that tenant, and the public
 * boundary refuses a subject key redaction would change. Refuse it here too.
 */
function assertRegistrableScanSubject(url: URL): void {
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (isExactPublicSuffixHost(hostname)) {
    throw new PublicScanError(PUBLIC_SUFFIX_SUBJECT_MESSAGE, 400, "public-suffix-target");
  }
  if (isGeneralizedPrivateSuffixTenantHost(hostname)) {
    throw new PublicScanError(PRIVATE_SUFFIX_TENANT_SUBJECT_MESSAGE, 400, "generalized-tenant-target");
  }
}

/**
 * The whole target verification ran past its deadline. The resolver's own
 * deadline (PublicUrlDnsTimeoutError) runs at the same 5 s and either can win
 * the race, so both declare `host-lookup-timeout`.
 */
export class ScanTargetVerificationTimeoutError extends PublicScanError {
  constructor(readonly timeoutMs: number) {
    super("Public host verification timed out. Try again shortly.", 503, "host-lookup-timeout");
    this.name = "ScanTargetVerificationTimeoutError";
  }
}

export type PreparedScanRequest = {
  clientKey: string;
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  compareConsent: boolean;
  rateLimitCost: 1 | 2;
  /**
   * The published address an "Inspect this connection" visit asks about,
   * present only on a single scan that named one. A visit option, never a
   * recorded condition, so it is not part of any durable payload, admission
   * commitment or saved report.
   */
  inspect?: string;
};

type ScanGateDependencies = {
  assertAccess?: (request: Request) => void;
  assertBodySize?: (request: Request) => void;
  clientKeyFromRequest?: (request: Request) => string;
  peekRateLimit?: (clientKey: string, nowMs: number, cost?: 1 | 2) => void;
  verifyPublicUrl?: (url: URL) => Promise<void>;
  targetVerificationTimeoutMs?: number;
  now?: () => number;
  /** The runtime producer an inspection is checked against; production reads the deployment's. */
  reportMode?: () => "v1" | "r2";
};

/**
 * Why a request that names an inspection the scan API cannot run is refused:
 * the address must be one a report publishes, query dropped, and the scan a
 * single, non-comparison one.
 */
export const INSPECTION_REQUEST_MESSAGE =
  "An inspection must name one address exactly as a report publishes it, query dropped, on a single scan.";

/**
 * The inspected address a scan body names, or null when it names none. A
 * value that is not a published address the redaction pass would leave
 * unchanged is refused before quota, DNS or Chromium. The scan it rides on
 * is held to a single one by assertInspectionRunnable, which the gate calls
 * next, so that rule has one statement.
 */
export function scanInspectionFromPayload(payload: object): string | null {
  if (!Object.prototype.hasOwnProperty.call(payload, "inspect")) return null;
  const value = (payload as { inspect?: unknown }).inspect;
  if (!isInspectableAddress(value)) {
    throw new PublicScanError(INSPECTION_REQUEST_MESSAGE, 400, "request-rejected");
  }
  return value;
}

/**
 * Refuse an inspection the runtime cannot carry: an inspection is never a
 * comparison, only the r2 producer's immediate shell has an ephemeral
 * block, and only a single scan's shell takes an inspection. Called by the
 * gate before quota, DNS or Chromium, and again wherever a prepared request
 * is executed or queued.
 */
export function assertInspectionRunnable(
  prepared: Pick<PreparedScanRequest, "inspect" | "compareGpc" | "compareShields" | "compareConsent">,
  reportMode: "v1" | "r2"
): void {
  if (prepared.inspect === undefined) return;
  if (prepared.compareGpc || prepared.compareShields || prepared.compareConsent) {
    throw new PublicScanError(INSPECTION_REQUEST_MESSAGE, 400, "request-rejected");
  }
  // Undeclared on purpose: the visitor reads this sentence itself.
  if (reportMode === "v1") throw new PublicScanError(INSPECTION_V1_PRODUCER_REFUSAL, 503);
}

export class ScanGate {
  constructor(private readonly dependencies: ScanGateDependencies = {}) {}

  async prepare(request: Request): Promise<PreparedScanRequest> {
    const assertAccess = this.dependencies.assertAccess ?? assertScanAccess;
    const assertBodySize = this.dependencies.assertBodySize ?? assertRequestBodySize;
    const requestClientKey = this.dependencies.clientKeyFromRequest ?? clientKeyFromRequest;
    const rateLimitPeek = this.dependencies.peekRateLimit ?? peekRateLimit;
    const now = this.dependencies.now ?? Date.now;

    assertAccess(request);
    assertBodySize(request);

    const payload = await readScanPayload(request);
    const targetUrl = normalizeUrl(payload.url);
    assertPublicHttpUrlShape(targetUrl);
    assertRegistrableScanSubject(targetUrl);
    if (comparisonModeCount(payload) > 1) {
      throw new PublicScanError(MULTIPLE_COMPARISON_MODES_MESSAGE);
    }
    const inspect = scanInspectionFromPayload(payload);
    const prepared = {
      device: payload.device === "mobile" ? "mobile" : "desktop",
      gpcEnabled: payload.gpcEnabled === true,
      compareGpc: payload.compareGpc === true,
      compareShields: payload.compareShields === true,
      compareConsent: payload.compareConsent === true,
      ...(inspect === null ? {} : { inspect })
    } as const;
    if (inspect !== null) {
      assertInspectionRunnable(prepared, (this.dependencies.reportMode ?? requireRuntimeScanReportMode)());
    }
    const clientKey = requestClientKey(request);
    const cost = scanRateLimitCost(payload);
    rateLimitPeek(clientKey, now(), cost);
    await verifyScanTargetWithinDeadline(targetUrl, request, this.dependencies);

    return {
      clientKey,
      url: targetUrl.toString(),
      ...prepared,
      rateLimitCost: cost
    };
  }
}

async function verifyScanTargetWithinDeadline(
  targetUrl: URL,
  request: Request,
  dependencies: ScanGateDependencies
): Promise<void> {
  const timeoutMs = dependencies.targetVerificationTimeoutMs ?? SCAN_TARGET_VERIFICATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The scan target verification timeout must be a positive safe integer.");
  }
  const requestSignal = (request as Request & { signal?: AbortSignal }).signal;
  requestSignal?.throwIfAborted();
  const deadline = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(new ScanTargetVerificationTimeoutError(timeoutMs)),
    timeoutMs
  );
  const abort = scanTargetAbortGate(signal);
  const pending = Promise.resolve().then(() =>
    dependencies.verifyPublicUrl
      ? dependencies.verifyPublicUrl(targetUrl)
      : assertPublicHttpUrl(targetUrl, { signal, timeoutMs })
  );
  void pending.catch(() => undefined);
  try {
    await Promise.race([pending, abort.promise]);
  } finally {
    clearTimeout(timer);
    abort.dispose();
  }
}

function scanTargetAbortGate(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let listener: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    const rejectFromSignal = () => reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
    if (signal.aborted) {
      rejectFromSignal();
      return;
    }
    listener = rejectFromSignal;
    signal.addEventListener("abort", rejectFromSignal, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    }
  };
}

export async function prepareScanRequest(request: Request, gate = new ScanGate()): Promise<PreparedScanRequest> {
  return gate.prepare(request);
}

export function scanRateLimitCost(payload: { compareGpc?: boolean; compareShields?: boolean; compareConsent?: boolean }): 1 | 2 {
  return payload.compareGpc === true || payload.compareShields === true || payload.compareConsent === true ? 2 : 1;
}

async function readScanPayload(
  request: Request
): Promise<Partial<ScanRequestPayload> & { url: string; compareGpc?: boolean; compareShields?: boolean; compareConsent?: boolean }> {
  // Content-Length is only an early rejection hint: clients can omit or forge
  // it. Stream through the real byte cap so direct Node deployments have the
  // same pre-buffer allocation bound as the Cloudflare edge gates.
  const body = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES);
  if (body === null) {
    throw new PublicScanError("Request body is too large.", 413, "request-rejected");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new PublicScanError("Request body must be valid JSON.", 400, "request-rejected");
  }

  if (!payload || typeof payload !== "object" || typeof (payload as { url?: unknown }).url !== "string") {
    throw new PublicScanError("Enter a public URL to scan.", 400, "invalid-url");
  }

  return payload as Partial<ScanRequestPayload> & { url: string; compareGpc?: boolean; compareShields?: boolean; compareConsent?: boolean };
}

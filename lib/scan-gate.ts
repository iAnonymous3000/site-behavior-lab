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
import { assertPublicHttpUrl, assertPublicHttpUrlShape, normalizeUrl } from "./url-safety";
import { assertScanAccess } from "./access-control";

export const SCAN_TARGET_VERIFICATION_TIMEOUT_MS = 5_000;

export class ScanTargetVerificationTimeoutError extends PublicScanError {
  constructor(readonly timeoutMs: number) {
    super("Public host verification timed out. Try again shortly.", 503);
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
};

type ScanGateDependencies = {
  assertAccess?: (request: Request) => void;
  assertBodySize?: (request: Request) => void;
  clientKeyFromRequest?: (request: Request) => string;
  peekRateLimit?: (clientKey: string, nowMs: number, cost?: 1 | 2) => void;
  verifyPublicUrl?: (url: URL) => Promise<void>;
  targetVerificationTimeoutMs?: number;
  now?: () => number;
};

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
    if (comparisonModeCount(payload) > 1) {
      throw new PublicScanError(MULTIPLE_COMPARISON_MODES_MESSAGE);
    }
    const clientKey = requestClientKey(request);
    const cost = scanRateLimitCost(payload);
    rateLimitPeek(clientKey, now(), cost);
    await verifyScanTargetWithinDeadline(targetUrl, request, this.dependencies);

    return {
      clientKey,
      url: targetUrl.toString(),
      device: payload.device === "mobile" ? "mobile" : "desktop",
      gpcEnabled: payload.gpcEnabled === true,
      compareGpc: payload.compareGpc === true,
      compareShields: payload.compareShields === true,
      compareConsent: payload.compareConsent === true,
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
    throw new PublicScanError("Request body is too large.", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new PublicScanError("Request body must be valid JSON.");
  }

  if (!payload || typeof payload !== "object" || typeof (payload as { url?: unknown }).url !== "string") {
    throw new PublicScanError("Enter a public URL to scan.");
  }

  return payload as Partial<ScanRequestPayload> & { url: string; compareGpc?: boolean; compareShields?: boolean; compareConsent?: boolean };
}

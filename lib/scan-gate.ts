import {
  assertRequestBodySize,
  clientKeyFromRequest,
  MAX_BODY_BYTES,
  peekRateLimit
} from "./scan-limits";
import type { ScanDevice, ScanRequestPayload } from "./types";
import { PublicScanError } from "./public-errors";
import { assertPublicHttpUrl, assertPublicHttpUrlShape, normalizeUrl } from "./url-safety";
import { assertScanAccess } from "./access-control";

export type PreparedScanRequest = {
  clientKey: string;
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  rateLimitCost: 1 | 2;
};

type ScanGateDependencies = {
  assertAccess?: (request: Request) => void;
  assertBodySize?: (request: Request) => void;
  clientKeyFromRequest?: (request: Request) => string;
  peekRateLimit?: (clientKey: string, nowMs: number, cost?: 1 | 2) => void;
  verifyPublicUrl?: (url: URL) => Promise<void>;
  now?: () => number;
};

export class ScanGate {
  constructor(private readonly dependencies: ScanGateDependencies = {}) {}

  async prepare(request: Request): Promise<PreparedScanRequest> {
    const assertAccess = this.dependencies.assertAccess ?? assertScanAccess;
    const assertBodySize = this.dependencies.assertBodySize ?? assertRequestBodySize;
    const requestClientKey = this.dependencies.clientKeyFromRequest ?? clientKeyFromRequest;
    const rateLimitPeek = this.dependencies.peekRateLimit ?? peekRateLimit;
    const verifyPublicUrl = this.dependencies.verifyPublicUrl ?? assertPublicHttpUrl;
    const now = this.dependencies.now ?? Date.now;

    assertAccess(request);
    assertBodySize(request);

    const payload = await readScanPayload(request);
    const targetUrl = normalizeUrl(payload.url);
    assertPublicHttpUrlShape(targetUrl);
    if (payload.compareGpc === true && payload.compareShields === true) {
      throw new PublicScanError("Choose one comparison mode.");
    }
    const clientKey = requestClientKey(request);
    const cost = scanRateLimitCost(payload);
    rateLimitPeek(clientKey, now(), cost);
    await verifyPublicUrl(targetUrl);

    return {
      clientKey,
      url: targetUrl.toString(),
      device: payload.device === "mobile" ? "mobile" : "desktop",
      gpcEnabled: payload.gpcEnabled === true,
      compareGpc: payload.compareGpc === true,
      compareShields: payload.compareShields === true,
      rateLimitCost: cost
    };
  }
}

export async function prepareScanRequest(request: Request, gate = new ScanGate()): Promise<PreparedScanRequest> {
  return gate.prepare(request);
}

export function scanRateLimitCost(payload: { compareGpc?: boolean; compareShields?: boolean }): 1 | 2 {
  return payload.compareGpc === true || payload.compareShields === true ? 2 : 1;
}

async function readScanPayload(
  request: Request
): Promise<Partial<ScanRequestPayload> & { url: string; compareGpc?: boolean; compareShields?: boolean }> {
  const body = await request.text();
  if (new Blob([body]).size > MAX_BODY_BYTES) {
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

  return payload as Partial<ScanRequestPayload> & { url: string; compareGpc?: boolean; compareShields?: boolean };
}

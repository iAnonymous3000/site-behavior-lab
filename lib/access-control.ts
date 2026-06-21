import { createHash, timingSafeEqual } from "node:crypto";
import { PublicScanError } from "./public-errors";
import { scanTokenFromHeaders } from "./scan-token";

const SCAN_ACCESS_TOKEN_ENV = "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN";

export function assertScanAccess(request: Request): void {
  const expected = scanAccessToken();
  if (!expected) return;

  const provided = scanTokenFromHeaders(request.headers);
  if (!provided || !constantTimeEqual(provided, expected)) {
    throw new PublicScanError("Scanner access key is required for this deployment.", 401);
  }
}

export function scanAccessTokenConfigured(): boolean {
  return Boolean(scanAccessToken());
}

function scanAccessToken(): string {
  return process.env[SCAN_ACCESS_TOKEN_ENV]?.trim() || "";
}

function constantTimeEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

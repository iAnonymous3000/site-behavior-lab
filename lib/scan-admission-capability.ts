import { comparisonModeCount } from "./edge-scan-gate";
import type { ScanDevice } from "./types";

export const SCAN_ADMISSION_CAPABILITY_HEADER = "x-site-behavior-lab-scan-admission";
export const SCAN_ADMISSION_COMMITMENT_HEADER =
  "x-site-behavior-lab-scan-admission-commitment";
export const SCAN_ADMISSION_RECOVERY_PATH = "/api/scan/admission";
export const SCAN_ADMISSION_TTL_MS = 75 * 60 * 1_000;

const CAPABILITY_BYTES = 32;
const CANONICAL_BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMMITMENT_DOMAIN = "site-behavior-lab/scan-admission/commitment/v1";

export type ScanAdmissionCredential = Readonly<{
  capabilityToken: string;
  requestCommitment: string;
}>;

/**
 * The normalized scan behavior bound to one admission capability. Deployment
 * authentication and one-shot human-verification tokens are intentionally not
 * semantics: they authorize an attempt but do not describe the admitted work.
 */
export type ScanAdmissionSemantics = Readonly<{
  version: 1;
  url: string;
  device: ScanDevice;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  compareConsent: boolean;
  consentMode: "observe";
}>;

export type ScanAdmissionRandomBytes = (length: number) => Uint8Array;

/**
 * Normalize the exact public scan behavior while excluding access and
 * Turnstile credentials. Unknown body fields fail closed so a future behavior
 * knob cannot silently escape the commitment.
 */
export function scanAdmissionSemanticsFromBody(body: unknown): ScanAdmissionSemantics | null {
  if (!isPlainRecord(body)) return null;
  const allowedKeys = new Set([
    "url",
    "device",
    "gpcEnabled",
    "compareGpc",
    "compareShields",
    "compareConsent",
    "consentMode",
    "turnstileToken"
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof body.url !== "string" ||
    (body.device !== "desktop" && body.device !== "mobile") ||
    typeof body.gpcEnabled !== "boolean" ||
    typeof body.compareGpc !== "boolean" ||
    typeof body.compareShields !== "boolean" ||
    typeof body.compareConsent !== "boolean" ||
    body.consentMode !== "observe" ||
    ("turnstileToken" in body && typeof body.turnstileToken !== "string")
  ) {
    return null;
  }
  if (comparisonModeCount(body) > 1) {
    return null;
  }

  const url = normalizeAdmissionUrl(body.url);
  if (!url) return null;
  return Object.freeze({
    version: 1,
    url,
    device: body.device,
    gpcEnabled: body.gpcEnabled,
    compareGpc: body.compareGpc,
    compareShields: body.compareShields,
    compareConsent: body.compareConsent,
    consentMode: "observe"
  });
}

/** Mint a fresh 256-bit bearer and bind it to one normalized scan request. */
export async function mintScanAdmissionCredential(
  semantics: ScanAdmissionSemantics,
  randomBytes: ScanAdmissionRandomBytes = secureRandomBytes
): Promise<ScanAdmissionCredential> {
  assertScanAdmissionSemantics(semantics);
  const bytes = randomBytes(CAPABILITY_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== CAPABILITY_BYTES) {
    throw new Error("Invalid scan-admission capability source.");
  }
  const capabilityToken = encodeBase64Url(bytes);
  return Object.freeze({
    capabilityToken,
    requestCommitment: await requestCommitmentForToken(capabilityToken, semantics)
  });
}

/**
 * Parse the two private headers. When semantics are supplied, verify that the
 * keyed commitment describes exactly those normalized semantics.
 */
export async function scanAdmissionCredentialFromHeaders(
  headers: Headers,
  semantics?: ScanAdmissionSemantics
): Promise<ScanAdmissionCredential | null> {
  const capabilityToken = headers.get(SCAN_ADMISSION_CAPABILITY_HEADER) ?? "";
  const requestCommitment = headers.get(SCAN_ADMISSION_COMMITMENT_HEADER) ?? "";
  if (!isScanAdmissionCapabilityToken(capabilityToken) || !isScanAdmissionCommitment(requestCommitment)) {
    return null;
  }
  if (semantics) {
    let expected: string;
    try {
      expected = await requestCommitmentForToken(capabilityToken, semantics);
    } catch {
      return null;
    }
    if (!constantTimeEqualAscii(requestCommitment, expected)) return null;
  }
  return Object.freeze({ capabilityToken, requestCommitment });
}

/** Store only this digest server-side; the raw browser capability stays private. */
export async function hashScanAdmissionCapabilityToken(token: string): Promise<ArrayBuffer> {
  const bytes = decodeCanonicalBase64Url32(token);
  if (!bytes) throw new Error("Invalid scan-admission capability token.");
  return crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
}

export function isScanAdmissionCapabilityToken(value: unknown): value is string {
  return typeof value === "string" && decodeCanonicalBase64Url32(value) !== null;
}

export function isScanAdmissionCommitment(value: unknown): value is string {
  return typeof value === "string" && decodeCanonicalBase64Url32(value) !== null;
}

export async function scanAdmissionCredentialMatchesSemantics(
  credential: ScanAdmissionCredential,
  semantics: ScanAdmissionSemantics
): Promise<boolean> {
  if (!isScanAdmissionCredential(credential)) return false;
  try {
    const expected = await requestCommitmentForToken(credential.capabilityToken, semantics);
    return constantTimeEqualAscii(credential.requestCommitment, expected);
  } catch {
    return false;
  }
}

export function isScanAdmissionCredential(value: unknown): value is ScanAdmissionCredential {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["capabilityToken", "requestCommitment"]) &&
    isScanAdmissionCapabilityToken(value.capabilityToken) &&
    isScanAdmissionCommitment(value.requestCommitment)
  );
}

async function requestCommitmentForToken(
  capabilityToken: string,
  semantics: ScanAdmissionSemantics
): Promise<string> {
  const keyBytes = decodeCanonicalBase64Url32(capabilityToken);
  if (!keyBytes) throw new Error("Invalid scan-admission capability token.");
  assertScanAdmissionSemantics(semantics);
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const canonical = JSON.stringify({
    version: 1,
    url: semantics.url,
    device: semantics.device,
    gpcEnabled: semantics.gpcEnabled,
    compareGpc: semantics.compareGpc,
    compareShields: semantics.compareShields,
    compareConsent: semantics.compareConsent,
    consentMode: semantics.consentMode
  });
  const message = new TextEncoder().encode(`${COMMITMENT_DOMAIN}\0${canonical}`);
  const signature = await crypto.subtle.sign("HMAC", key, Uint8Array.from(message).buffer);
  return encodeBase64Url(new Uint8Array(signature));
}

function assertScanAdmissionSemantics(value: ScanAdmissionSemantics): void {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "url",
      "device",
      "gpcEnabled",
      "compareGpc",
      "compareShields",
      "compareConsent",
      "consentMode"
    ]) ||
    value.version !== 1 ||
    typeof value.url !== "string" ||
    normalizeAdmissionUrl(value.url) !== value.url ||
    (value.device !== "desktop" && value.device !== "mobile") ||
    typeof value.gpcEnabled !== "boolean" ||
    typeof value.compareGpc !== "boolean" ||
    typeof value.compareShields !== "boolean" ||
    typeof value.compareConsent !== "boolean" ||
    comparisonModeCount(value) > 1 ||
    value.consentMode !== "observe"
  ) {
    throw new Error("Invalid scan-admission semantics.");
  }
}

function normalizeAdmissionUrl(value: string): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    // Fragments never reach the server navigation. Query parameters do and
    // therefore remain HMAC-bound, while only the opaque digest is persisted.
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function secureRandomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCanonicalBase64Url32(value: string): Uint8Array | null {
  if (!CANONICAL_BASE64URL_32_PATTERN.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "="));
    if (binary.length !== CAPABILITY_BYTES) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function constantTimeEqualAscii(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

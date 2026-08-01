import type { ScanDevice } from "./types";

export const ENCRYPTED_WATCHES_ENV = "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES";
export const ENCRYPTED_WATCH_ENCRYPTION_KEY_ENV = "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY";
export const ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV =
  "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY";
export const ENCRYPTED_WATCH_ACCESS_TOKEN_ENV =
  "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN";
export const ENCRYPTED_WATCH_CAPABILITY_HEADER = "x-site-behavior-lab-watch-capability";
export const ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER =
  "x-site-behavior-lab-watch-access-token";

export const ENCRYPTED_WATCH_CADENCE_MS = 7 * 24 * 60 * 60 * 1_000;
export const ENCRYPTED_WATCH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const ENCRYPTED_WATCH_MAX_RUNS = 5;
export const ENCRYPTED_WATCH_MAX_ACTIVE = 32;
export const ENCRYPTED_WATCH_LEASE_MS = 5 * 60 * 1_000;
export const ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET = 100;

const WATCH_ID_PATTERN = /^[0-9a-f]{32}$/;
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WATCH_ID_DERIVATION_DOMAIN = "site-behavior-lab/encrypted-watch/id/v1";

export type EncryptedWatchPayloadV1 = Readonly<{
  version: 1;
  target: Readonly<{
    url: string;
  }>;
  options: Readonly<{
    device: ScanDevice;
    gpcEnabled: boolean;
    reportMode: "r2";
    comparison: "none";
  }>;
}>;

export type EncryptedWatchPayload = EncryptedWatchPayloadV1;

export type EncryptedWatchesFlagState = "disabled" | "enabled" | "misconfigured";

export type EncryptedWatchReadinessState =
  | "disabled"
  | "misconfigured"
  | "key-unavailable"
  | "key-not-isolated"
  | "durable-jobs-unavailable"
  | "ready";

export type EncryptedWatchReadinessInput = Readonly<{
  flagValue: string | undefined;
  encryptionKeyConfigured: boolean;
  encryptionKeyIsolated: boolean;
  durableJobsRequested: boolean;
  durableJobsReady: boolean;
}>;

export type EncryptedWatchOperation = "create" | "claim-due" | "read-metadata" | "read-target" | "delete";

/** Feature flags are exact wire contracts; whitespace and truthy aliases fail closed. */
export function encryptedWatchesFlagState(value: string | undefined): EncryptedWatchesFlagState {
  if (value === undefined || value === "" || value === "0") return "disabled";
  return value === "1" ? "enabled" : "misconfigured";
}

/** The long-lived watch key must not alias any job, token, or forwarded secret. */
export function encryptedWatchKeyIsIsolated(
  encryptionKey: string,
  forbiddenSecrets: readonly string[]
): boolean {
  if (!isCanonicalEncryptedWatchKeyWire(encryptionKey)) return false;
  return forbiddenSecrets.every(
    (secret) => typeof secret !== "string" || secret.length === 0 || secret.trim() !== encryptionKey
  );
}

export function isCanonicalEncryptedWatchKeyWire(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_KEY_PATTERN.test(value)) return false;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
    const binary = atob(padded);
    if (binary.length !== 32) return false;
    let canonical = "";
    for (let index = 0; index < binary.length; index += 1) canonical += binary[index];
    return btoa(canonical).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") === value;
  } catch {
    return false;
  }
}

export function isEncryptedWatchId(value: unknown): value is string {
  return typeof value === "string" && WATCH_ID_PATTERN.test(value);
}

export function isEncryptedWatchCapabilityToken(value: unknown): value is string {
  return typeof value === "string" && decodeCanonicalBase64Url32(value, CAPABILITY_TOKEN_PATTERN) !== null;
}

/** Browser/edge-safe deterministic locator for response-loss recovery. */
export async function deriveEncryptedWatchIdFromCapabilityToken(token: string): Promise<string> {
  const tokenBytes = decodeCanonicalBase64Url32(token, CAPABILITY_TOKEN_PATTERN);
  if (!tokenBytes) throw new Error("Invalid encrypted-watch capability token.");
  const domain = new TextEncoder().encode(WATCH_ID_DERIVATION_DOMAIN);
  const input = new Uint8Array(domain.byteLength + 1 + tokenBytes.byteLength);
  input.set(domain, 0);
  input[domain.byteLength] = 0;
  input.set(tokenBytes, domain.byteLength + 1);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(input).buffer));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isEncryptedWatchPayload(value: unknown): value is EncryptedWatchPayload {
  if (!isRecordWithExactKeys(value, ["version", "target", "options"]) || value.version !== 1) return false;
  if (!isRecordWithExactKeys(value.target, ["url"]) || !isWatchTargetUrl(value.target.url)) return false;
  if (!isRecordWithExactKeys(value.options, ["device", "gpcEnabled", "reportMode", "comparison"])) return false;
  return (
    (value.options.device === "desktop" || value.options.device === "mobile") &&
    typeof value.options.gpcEnabled === "boolean" &&
    value.options.reportMode === "r2" &&
    value.options.comparison === "none"
  );
}

function isWatchTargetUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("?") ||
    value.includes("#")
  ) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function isRecordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeCanonicalBase64Url32(value: string, pattern: RegExp): Uint8Array | null {
  if (!pattern.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=");
    const binary = atob(padded);
    if (binary.length !== 32) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let rebuilt = "";
    for (const byte of bytes) rebuilt += String.fromCharCode(byte);
    const canonical = btoa(rebuilt).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return canonical === value ? bytes : null;
  } catch {
    return null;
  }
}

// NOTE: readiness/permission derivation deliberately lives in
// cloudflare/container-worker.ts (its health patch and gate checks), not here.
// Two tested contract functions for it existed in this module once, born in
// the same commit as the worker's own derivation and never wired to it; a
// contract that looks authoritative while pinning nothing is this repo's known
// worst defect class, so they were removed rather than left as a trap.

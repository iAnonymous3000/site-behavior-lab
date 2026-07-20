import {
  ENCRYPTED_WATCH_CAPABILITY_HEADER,
  ENCRYPTED_WATCH_MAX_RUNS,
  ENCRYPTED_WATCH_TTL_MS,
  deriveEncryptedWatchIdFromCapabilityToken,
  isEncryptedWatchCapabilityToken,
  isEncryptedWatchId,
  isEncryptedWatchPayload,
  type EncryptedWatchPayload
} from "./encrypted-watch-contract";
import { isScanJobId } from "./durable-scan-job-contract";
import { SCAN_ACCESS_TOKEN_HEADER } from "./scan-token";

const WATCH_FRAGMENT_PREFIX = "#watch=";
const SAFE_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type EncryptedWatchCredentials = Readonly<{
  watchId: string;
  capabilityToken: string;
}>;

export type EncryptedWatchRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export type EncryptedWatchAdmittedRun = Readonly<{
  sequence: number;
  admittedAt: number;
  jobId: string;
  statusPath: string;
  reportId: string;
  status: EncryptedWatchRunStatus;
  errorCode: string | null;
}>;

export type EncryptedWatchAdmissionFailedRun = Readonly<{
  sequence: number;
  admittedAt: null;
  jobId: null;
  statusPath: null;
  reportId: null;
  status: "failed";
  errorCode: "admission-failed";
}>;

export type EncryptedWatchRun = EncryptedWatchAdmittedRun | EncryptedWatchAdmissionFailedRun;

export type EncryptedWatchStatus = Readonly<{
  watchId: string;
  statusPath: string;
  state: "active" | "leased" | "completed";
  createdAt: number;
  expiresAt: number;
  nextRunAt: number | null;
  /** Scheduled attempts used, including attempts that failed before admission. */
  attemptCount: number;
  maxAttempts: typeof ENCRYPTED_WATCH_MAX_RUNS;
  runs: readonly EncryptedWatchRun[];
}>;

export type EncryptedWatchCreation = Readonly<{
  credentials: EncryptedWatchCredentials;
  status: EncryptedWatchStatus;
}>;

export type EncryptedWatchDeletion = Readonly<{
  watchId: string;
  state: "deleted";
}>;

export type EncryptedWatchClientFetcher = (input: string, init: RequestInit) => Promise<Response>;
export type EncryptedWatchRandomBytes = (length: number) => Uint8Array;

type EncryptedWatchClientRequest = Readonly<{
  resolveApiUrl: (path: string) => string;
  fetcher?: EncryptedWatchClientFetcher;
  accessToken?: string;
}>;

/**
 * Admit one immutable, single-mode scheduled rescan. The target is carried in
 * the JSON request body, never a query string, and the access credential stays
 * in its established request header.
 */
export async function createEncryptedWatch(
  options: EncryptedWatchClientRequest &
    Readonly<{
      payload: EncryptedWatchPayload;
      turnstileToken?: string;
      /** Reuse this exact value after an uncertain POST outcome. */
      credentials?: EncryptedWatchCredentials;
      /** Called before the POST so UI state can retain a newly minted value. */
      onCredentialsReady?: (credentials: EncryptedWatchCredentials) => void;
      signal?: AbortSignal;
    }>
): Promise<EncryptedWatchCreation> {
  const message = "The scheduled rescan could not be created.";
  if (!isEncryptedWatchPayload(options.payload)) throw new Error(message);

  let credentials: EncryptedWatchCredentials;
  try {
    const candidate = options.credentials ?? (await mintEncryptedWatchCredentials());
    if (
      !isEncryptedWatchCredentials(candidate) ||
      (await deriveEncryptedWatchIdFromCapabilityToken(candidate.capabilityToken)) !== candidate.watchId
    ) {
      throw new Error("invalid credential");
    }
    credentials = Object.freeze({
      watchId: candidate.watchId,
      capabilityToken: candidate.capabilityToken
    });
    options.onCredentialsReady?.(credentials);
  } catch {
    throw new Error(message);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    [ENCRYPTED_WATCH_CAPABILITY_HEADER]: credentials.capabilityToken
  };
  const accessToken = safeOptionalHeaderValue(options.accessToken);
  if (options.accessToken !== undefined && accessToken === null) throw new Error(message);
  if (accessToken) headers[SCAN_ACCESS_TOKEN_HEADER] = accessToken;

  const turnstileToken = safeOptionalBodyToken(options.turnstileToken);
  if (options.turnstileToken !== undefined && turnstileToken === null) throw new Error(message);

  const fetcher = options.fetcher ?? defaultFetcher;
  let response: Response | null = null;
  try {
    response = await fetcher(options.resolveApiUrl("/api/watches"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: options.payload.target.url,
        device: options.payload.options.device,
        gpcEnabled: options.payload.options.gpcEnabled,
        ...(turnstileToken ? { turnstileToken } : {})
      }),
      cache: "no-store",
      redirect: "error",
      signal: options.signal
    });
  } catch {
    // The server may have committed before the transport failed. Recover once
    // by the browser-held deterministic locator; an explicit retry can then
    // reuse the same credentials without minting an inaccessible second watch.
    return recoverEncryptedWatchCreation(options, credentials, message);
  }

  let parsed: EncryptedWatchCreation | null = null;
  try {
    if (!isJsonResponse(response)) throw new Error("non-JSON response");
    const value = (await response.json()) as unknown;
    parsed = response.status === 200 || response.status === 201 ? parseEncryptedWatchCreation(value) : null;
  } catch {
    parsed = null;
  }
  if (
    parsed &&
    parsed.credentials.watchId === credentials.watchId &&
    parsed.credentials.capabilityToken === credentials.capabilityToken
  ) {
    return parsed;
  }
  return recoverEncryptedWatchCreation(options, credentials, message);
}

/** Mint once, retain in memory/fragment, and reuse for every uncertain retry. */
export async function mintEncryptedWatchCredentials(
  randomBytes: EncryptedWatchRandomBytes = secureRandomBytes
): Promise<EncryptedWatchCredentials> {
  const bytes = randomBytes(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error("Invalid scheduled rescan capability source.");
  }
  const capabilityToken = encodeBase64Url(bytes);
  const watchId = await deriveEncryptedWatchIdFromCapabilityToken(capabilityToken);
  return Object.freeze({ watchId, capabilityToken });
}

/** Read metadata only. The target is intentionally not part of the wire DTO. */
export async function readEncryptedWatch(
  options: EncryptedWatchClientRequest &
    Readonly<{ credentials: EncryptedWatchCredentials; signal?: AbortSignal }>
): Promise<EncryptedWatchStatus> {
  const message = "The scheduled rescan capability is invalid or unavailable.";
  return performCapabilityRequest(options, "GET", parseEncryptedWatchStatusResponse, message);
}

/** Delete by capability without reflecting whether the ID or token was wrong. */
export async function deleteEncryptedWatch(
  options: EncryptedWatchClientRequest &
    Readonly<{ credentials: EncryptedWatchCredentials; signal?: AbortSignal }>
): Promise<EncryptedWatchDeletion> {
  const message = "The scheduled rescan capability is invalid or unavailable.";
  return performCapabilityRequest(
    options,
    "DELETE",
    parseEncryptedWatchDeletion,
    message,
    Object.freeze({ watchId: options.credentials.watchId, state: "deleted" as const })
  );
}

export function parseEncryptedWatchCreation(value: unknown): EncryptedWatchCreation | null {
  if (!isRecordWithExactKeys(value, [...statusResponseKeys(), "capability"])) return null;
  if (!isEncryptedWatchCapabilityToken(value.capability)) return null;
  const status = parseEncryptedWatchStatusRecord(value, true);
  if (!status || status.attemptCount < 1 || status.runs.length < 1) return null;
  return Object.freeze({
    credentials: Object.freeze({ watchId: status.watchId, capabilityToken: value.capability }),
    status
  });
}

export function parseEncryptedWatchStatusResponse(value: unknown): EncryptedWatchStatus | null {
  if (!isRecordWithExactKeys(value, statusResponseKeys())) return null;
  return parseEncryptedWatchStatusRecord(value, true);
}

export function parseEncryptedWatchDeletion(value: unknown): EncryptedWatchDeletion | null {
  if (!isRecordWithExactKeys(value, ["ok", "watchId", "state"])) return null;
  if (value.ok !== true || !isEncryptedWatchId(value.watchId) || value.state !== "deleted") return null;
  return Object.freeze({ watchId: value.watchId, state: "deleted" });
}

/**
 * Browser management credentials belong only in a fragment: fragments are not
 * included in HTTP requests or Referer headers. Nothing here writes browser
 * persistence; callers retain the returned object in component memory.
 */
export function encodeEncryptedWatchCredentialsFragment(credentials: EncryptedWatchCredentials): string {
  if (!isEncryptedWatchCredentials(credentials)) {
    throw new Error("Invalid scheduled rescan capability.");
  }
  return `${WATCH_FRAGMENT_PREFIX}${credentials.watchId}.${credentials.capabilityToken}`;
}

export function parseEncryptedWatchCredentialsFragment(fragment: string): EncryptedWatchCredentials | null {
  if (typeof fragment !== "string" || !fragment.startsWith(WATCH_FRAGMENT_PREFIX)) return null;
  const value = fragment.slice(WATCH_FRAGMENT_PREFIX.length);
  const separator = value.indexOf(".");
  if (separator <= 0 || separator !== value.lastIndexOf(".")) return null;
  const credentials = {
    watchId: value.slice(0, separator),
    capabilityToken: value.slice(separator + 1)
  };
  return isEncryptedWatchCredentials(credentials) ? Object.freeze(credentials) : null;
}

export function encryptedWatchManagementUrl(baseHref: string, credentials: EncryptedWatchCredentials): string {
  if (!isEncryptedWatchCredentials(credentials)) throw new Error("Invalid scheduled rescan capability.");
  let url: URL;
  try {
    url = new URL(baseHref);
  } catch {
    throw new Error("Invalid scheduled rescan management URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    containsCredentials(url.pathname + url.search, credentials)
  ) {
    throw new Error("Invalid scheduled rescan management URL.");
  }
  // Remove arbitrary form/query state before placing the capability in the
  // fragment. A prior `?url=...` must not survive in browser history beside a
  // newly created watch.
  url.search = "";
  url.hash = encodeEncryptedWatchCredentialsFragment(credentials).slice(1);
  return url.href;
}

export function parseEncryptedWatchCredentialsFromUrl(href: string): EncryptedWatchCredentials | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const credentials = parseEncryptedWatchCredentialsFragment(url.hash);
  if (!credentials || containsCredentials(url.pathname + url.search, credentials)) return null;
  return credentials;
}

async function performCapabilityRequest<T>(
  options: EncryptedWatchClientRequest &
    Readonly<{ credentials: EncryptedWatchCredentials; signal?: AbortSignal }>,
  method: "GET" | "DELETE",
  parser: (value: unknown) => T | null,
  message: string,
  notFoundResult?: T
): Promise<T> {
  if (!isEncryptedWatchCredentials(options.credentials)) throw new Error(message);
  try {
    if (
      (await deriveEncryptedWatchIdFromCapabilityToken(options.credentials.capabilityToken)) !==
      options.credentials.watchId
    ) {
      throw new Error("mismatched capability");
    }
  } catch {
    throw new Error(message);
  }
  const statusPath = `/api/watches/${options.credentials.watchId}`;
  const accessToken = safeOptionalHeaderValue(options.accessToken);
  if (options.accessToken !== undefined && accessToken === null) throw new Error(message);
  const headers: Record<string, string> = {
    [ENCRYPTED_WATCH_CAPABILITY_HEADER]: options.credentials.capabilityToken
  };
  if (accessToken) headers[SCAN_ACCESS_TOKEN_HEADER] = accessToken;
  const fetcher = options.fetcher ?? defaultFetcher;
  let response: Response;
  try {
    response = await fetcher(options.resolveApiUrl(statusPath), {
      method,
      headers,
      cache: "no-store",
      redirect: "error",
      signal: options.signal
    });
  } catch {
    throw new Error(message);
  }
  const value = await readUnknownJson(response, message);
  // A canonical self-derived credential plus the watch route's exact 404 DTO
  // proves there is no matching watch left to delete. An HTML/generic 404 from
  // an older deployment is not authoritative and must retain the fragment.
  if (
    response.status === 404 &&
    method === "DELETE" &&
    notFoundResult !== undefined &&
    isAuthoritativeEncryptedWatchNotFound(value)
  ) {
    return notFoundResult;
  }
  const parsed = response.ok ? parser(value) : null;
  if (!parsed) throw new Error(message);
  return parsed;
}

async function recoverEncryptedWatchCreation(
  options: EncryptedWatchClientRequest & Readonly<{ signal?: AbortSignal }>,
  credentials: EncryptedWatchCredentials,
  message: string
): Promise<EncryptedWatchCreation> {
  try {
    const status = await performCapabilityRequest(
      { ...options, credentials },
      "GET",
      parseEncryptedWatchStatusResponse,
      message
    );
    return Object.freeze({ credentials, status });
  } catch {
    throw new Error(message);
  }
}

function parseEncryptedWatchStatusRecord(
  value: Record<string, unknown>,
  requireOk: boolean
): EncryptedWatchStatus | null {
  if (requireOk && value.ok !== true) return null;
  if (!isEncryptedWatchId(value.watchId)) return null;
  if (value.statusPath !== `/api/watches/${value.watchId}`) return null;
  if (value.state !== "active" && value.state !== "leased" && value.state !== "completed") return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return null;
  if (value.expiresAt !== value.createdAt + ENCRYPTED_WATCH_TTL_MS) return null;
  if (value.nextRunAt !== null && !isTimestamp(value.nextRunAt)) return null;
  if (
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 1 ||
    (value.attemptCount as number) > ENCRYPTED_WATCH_MAX_RUNS ||
    value.maxAttempts !== ENCRYPTED_WATCH_MAX_RUNS ||
    !Array.isArray(value.runs) ||
    value.runs.length > ENCRYPTED_WATCH_MAX_RUNS ||
    value.runs.length !== (value.attemptCount as number)
  ) {
    return null;
  }
  if (value.state === "completed" ? value.nextRunAt !== null : value.nextRunAt === null) return null;

  const runs: EncryptedWatchRun[] = [];
  for (const [index, candidate] of value.runs.entries()) {
    const run = parseEncryptedWatchRun(candidate, value.createdAt, value.expiresAt);
    if (!run || run.sequence !== index + 1) return null;
    runs.push(run);
  }

  return Object.freeze({
    watchId: value.watchId,
    statusPath: value.statusPath,
    state: value.state,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    nextRunAt: value.nextRunAt,
    attemptCount: value.attemptCount as number,
    maxAttempts: ENCRYPTED_WATCH_MAX_RUNS,
    runs: Object.freeze(runs)
  });
}

function parseEncryptedWatchRun(value: unknown, createdAt: number, expiresAt: number): EncryptedWatchRun | null {
  if (
    !isRecordWithExactKeys(value, [
      "sequence",
      "admittedAt",
      "jobId",
      "statusPath",
      "reportId",
      "status",
      "errorCode"
    ]) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.sequence as number) > ENCRYPTED_WATCH_MAX_RUNS
  ) {
    return null;
  }
  if (
    value.admittedAt === null &&
    value.jobId === null &&
    value.statusPath === null &&
    value.reportId === null &&
    value.status === "failed" &&
    value.errorCode === "admission-failed"
  ) {
    return Object.freeze({
      sequence: value.sequence as number,
      admittedAt: null,
      jobId: null,
      statusPath: null,
      reportId: null,
      status: "failed",
      errorCode: "admission-failed"
    });
  }
  if (
    !isTimestamp(value.admittedAt) ||
    (value.admittedAt as number) < createdAt ||
    (value.admittedAt as number) >= expiresAt ||
    !isScanJobId(value.jobId) ||
    !isScanJobId(value.reportId) ||
    value.jobId === value.reportId ||
    value.statusPath !== `/api/scans/${value.jobId}` ||
    !isEncryptedWatchRunStatus(value.status) ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== "string" || !SAFE_ERROR_CODE_PATTERN.test(value.errorCode)))
  ) {
    return null;
  }
  if ((value.status === "queued" || value.status === "running" || value.status === "succeeded") && value.errorCode) {
    return null;
  }
  return Object.freeze({
    sequence: value.sequence as number,
    admittedAt: value.admittedAt as number,
    jobId: value.jobId,
    statusPath: value.statusPath,
    reportId: value.reportId,
    status: value.status,
    errorCode: value.errorCode
  });
}

function statusResponseKeys(): string[] {
  return [
    "ok",
    "watchId",
    "statusPath",
    "state",
    "createdAt",
    "expiresAt",
    "nextRunAt",
    "attemptCount",
    "maxAttempts",
    "runs"
  ];
}

function isEncryptedWatchRunStatus(value: unknown): value is EncryptedWatchRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "expired" ||
    value === "cancelled"
  );
}

function isEncryptedWatchCredentials(value: unknown): value is EncryptedWatchCredentials {
  if (!isRecordWithExactKeys(value, ["watchId", "capabilityToken"])) return false;
  return isEncryptedWatchId(value.watchId) && isEncryptedWatchCapabilityToken(value.capabilityToken);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function containsCredentials(value: string, credentials: EncryptedWatchCredentials): boolean {
  const decoded = safeDecode(value);
  return (
    value.includes(credentials.watchId) ||
    value.includes(credentials.capabilityToken) ||
    decoded.includes(credentials.watchId) ||
    decoded.includes(credentials.capabilityToken)
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeOptionalHeaderValue(value: string | undefined): string | null {
  if (value === undefined) return "";
  const trimmed = value.trim();
  return trimmed.length <= 4_096 && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

function safeOptionalBodyToken(value: string | undefined): string | null {
  if (value === undefined) return "";
  const trimmed = value.trim();
  return trimmed.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
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

async function readUnknownJson(response: Response, message: string): Promise<unknown> {
  try {
    if (!isJsonResponse(response)) throw new Error("non-JSON response");
    return (await response.json()) as unknown;
  } catch {
    throw new Error(message);
  }
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function isAuthoritativeEncryptedWatchNotFound(value: unknown): boolean {
  return (
    isRecordWithExactKeys(value, ["ok", "error"]) &&
    value.ok === false &&
    value.error === "Scheduled rescan not found."
  );
}

function defaultFetcher(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

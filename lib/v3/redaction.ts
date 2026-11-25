/**
 * Persistence-boundary redaction and digest helpers for ScanReportV3.
 *
 * Guarantees that nothing persisted to disk, R2, D1, or shared JSON responses
 * contains query strings, fragments, URL credentials, visitor emails/tokens,
 * cookie values, storage values, or active probe sentinels.
 */

import { sha256Hex } from "../sha256";
import type {
  CallStackFrameV3,
  NetworkRequestV3,
  ScanArmV3,
  ScanReportV3,
  WebSocketRecordV3
} from "./schema";

const EMAIL_IN_PATH = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_SEGMENT = /^[0-9a-f]{24,}$/i;
const HIGH_ENTROPY_TOKEN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{28,}$/;
const MAX_URL_LENGTH = 512;
const MAX_PATH_SEGMENTS = 16;

/**
 * Redact an HTTP(S)/WS(S) URL to scheme + host + sanitized path:
 * - strips username, password, query string, and hash fragment
 * - generalizes email addresses, UUIDs, and long opaque token segments
 * - idempotent across repeated invocations
 */
export function redactUrlV3(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      return `${parsed.protocol}//[redacted]`;
    }
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : "";
    const segments = parsed.pathname.split("/").slice(0, MAX_PATH_SEGMENTS + 1);
    const cleaned = segments.map((segment) => redactPathSegment(segment));
    let pathname = cleaned.join("/");
    if (!pathname.startsWith("/")) pathname = `/${pathname}`;
    const result = `${parsed.protocol}//${host}${port}${pathname}`;
    return result.length > MAX_URL_LENGTH ? `${result.slice(0, MAX_URL_LENGTH - 12)}/[truncated]` : result;
  } catch {
    return "[invalid-url]";
  }
}

export function redactOriginV3(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return "[redacted-origin]";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
  } catch {
    return "[invalid-origin]";
  }
}

function redactPathSegment(segment: string): string {
  if (!segment) return "";
  if (segment === "[redacted-token]" || segment === "[redacted-email]" || segment === "[truncated]") {
    return segment;
  }
  if (EMAIL_IN_PATH.test(segment)) {
    EMAIL_IN_PATH.lastIndex = 0;
    return "[redacted-email]";
  }
  if (UUID_SEGMENT.test(segment) || LONG_HEX_SEGMENT.test(segment) || HIGH_ENTROPY_TOKEN.test(segment)) {
    return "[redacted-token]";
  }
  return segment.length > 96 ? `${segment.slice(0, 64)}[truncated]` : segment;
}

function redactCallStack(frames?: CallStackFrameV3[]): CallStackFrameV3[] | undefined {
  if (!frames) return undefined;
  return frames.slice(0, 12).map((frame) => ({
    url: redactUrlV3(frame.url),
    domain: frame.domain.toLowerCase(),
    ...(frame.line !== undefined ? { line: frame.line } : {}),
    ...(frame.column !== undefined ? { column: frame.column } : {}),
    ...(frame.functionName ? { functionName: frame.functionName.slice(0, 80) } : {})
  }));
}

function redactRequest(req: NetworkRequestV3): NetworkRequestV3 {
  return {
    ...req,
    url: redactUrlV3(req.url),
    domain: req.domain.toLowerCase(),
    registrableDomain: req.registrableDomain.toLowerCase(),
    redirectChain: req.redirectChain.map(redactUrlV3),
    requestHeaders: {
      ...req.requestHeaders,
      ...(req.requestHeaders.origin ? { origin: redactOriginV3(req.requestHeaders.origin) } : {}),
      ...(req.requestHeaders.refererOrigin
        ? { refererOrigin: redactOriginV3(req.requestHeaders.refererOrigin) }
        : {})
    },
    shields: {
      ...req.shields,
      rewrittenUrl: req.shields.rewrittenUrl ? redactUrlV3(req.shields.rewrittenUrl) : null
    },
    initiator: req.initiator
      ? {
          ...req.initiator,
          ...(req.initiator.scriptUrl ? { scriptUrl: redactUrlV3(req.initiator.scriptUrl) } : {}),
          ...(req.initiator.scriptDomain ? { scriptDomain: req.initiator.scriptDomain.toLowerCase() } : {}),
          ...(req.initiator.callStack ? { callStack: redactCallStack(req.initiator.callStack) } : {})
        }
      : null
  };
}

function redactWebSocket(ws: WebSocketRecordV3): WebSocketRecordV3 {
  return {
    ...ws,
    url: redactUrlV3(ws.url),
    domain: ws.domain.toLowerCase(),
    registrableDomain: ws.registrableDomain.toLowerCase()
  };
}

function redactArm(arm: ScanArmV3): ScanArmV3 {
  return {
    ...arm,
    finalUrl: redactUrlV3(arm.finalUrl),
    network: arm.network.map(redactRequest),
    websockets: arm.websockets.map(redactWebSocket),
    serviceWorkers: arm.serviceWorkers.map((sw) => ({
      ...sw,
      scope: redactUrlV3(sw.scope),
      scriptUrl: redactUrlV3(sw.scriptUrl),
      domain: sw.domain.toLowerCase()
    })),
    cookies: arm.cookies.map((cookie) => ({
      name: cookie.name.slice(0, 128),
      domain: cookie.domain.toLowerCase(),
      registrableDomain: cookie.registrableDomain.toLowerCase(),
      path: cookie.path.slice(0, 128),
      sameSite: cookie.sameSite,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.session,
      thirdParty: cookie.thirdParty,
      ttlDays: cookie.ttlDays,
      partitionKey: cookie.partitionKey ? redactOriginV3(cookie.partitionKey) : null,
      setVia: cookie.setVia,
      phase: cookie.phase,
      entity: cookie.entity
    })),
    storage: arm.storage.map((entry) => ({
      origin: redactOriginV3(entry.origin),
      domain: entry.domain.toLowerCase(),
      thirdParty: entry.thirdParty,
      area: entry.area,
      keyOrStore: redactPathSegment(entry.keyOrStore.slice(0, 128)),
      ...(entry.entryCount !== undefined ? { entryCount: entry.entryCount } : {}),
      valueBytes: Math.max(0, Math.floor(entry.valueBytes)),
      phase: entry.phase,
      entity: entry.entity
    })),
    consent: {
      ...arm.consent,
      interaction: {
        ...arm.consent.interaction,
        ...(arm.consent.interaction.frameUrl
          ? { frameUrl: redactUrlV3(arm.consent.interaction.frameUrl) }
          : {})
      }
    },
    policy: arm.policy
      ? {
          ...arm.policy,
          url: redactUrlV3(arm.policy.url)
        }
      : null
  };
}

/** Idempotently redact a ScanReportV3 before any persistence or network emission. */
export function redactScanReportV3(report: ScanReportV3): ScanReportV3 {
  return {
    ...report,
    targetUrl: redactUrlV3(report.targetUrl),
    finalUrl: redactUrlV3(report.finalUrl),
    canonicalDomain: report.canonicalDomain.toLowerCase(),
    leadArm: redactArm(report.leadArm),
    comparisonArms: report.comparisonArms.map(redactArm)
  };
}

/** Canonical deterministic JSON representation (keys sorted recursively). */
export function canonicalJsonV3(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) sorted[k] = sortKeys(v);
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest of a redacted ScanReportV3. */
export function reportV3Digest(report: ScanReportV3): string {
  return sha256Hex(canonicalJsonV3(redactScanReportV3(report)));
}

/**
 * Persistence-boundary guard: verify no raw sentinel or raw query string
 * survived into the serialized report JSON.
 */
export function assertNoUnredactedSecretsV3(report: ScanReportV3, sentinels: readonly string[] = []): void {
  const serialized = JSON.stringify(report);
  for (const sentinel of sentinels) {
    if (sentinel && serialized.includes(sentinel)) {
      throw new Error("Refusing to persist ScanReportV3: active probe sentinel leaked into report payload");
    }
  }
  if (
    report.targetUrl.includes("?") ||
    report.targetUrl.includes("#") ||
    report.finalUrl.includes("?") ||
    report.finalUrl.includes("#")
  ) {
    throw new Error("Refusing to persist ScanReportV3: unredacted query/fragment in top-level URL");
  }
  for (const arm of [report.leadArm, ...report.comparisonArms]) {
    if (arm.finalUrl.includes("?") || arm.finalUrl.includes("#")) {
      throw new Error(`Refusing to persist ScanReportV3: unredacted query/fragment in arm ${arm.armId} finalUrl`);
    }
    for (const req of arm.network) {
      if (req.url.includes("?") || req.url.includes("#")) {
        throw new Error(`Refusing to persist ScanReportV3: unredacted query/fragment in request URL ${req.id}`);
      }
    }
  }
}

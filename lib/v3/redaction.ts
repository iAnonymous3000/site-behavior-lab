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
const UUID_EMBEDDED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const JWT_EMBEDDED = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const LONG_HEX_SEGMENT = /(?:^|[^0-9a-f])[0-9a-f]{24,}(?:$|[^0-9a-f])/i;
const HIGH_ENTROPY_TOKEN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{28,}$/;
const PREFIXED_HIGH_ENTROPY_TOKEN = /(?:^|[_:-])(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{24,}(?:$|[_:-])/;
const VALID_GCS_RE = /^G1[01-][01-]$/;
const URL_IN_PROSE_RE = /https?:\/\/[^\s"'<>]+/gi;
const MAX_URL_LENGTH = 512;
const MAX_PATH_SEGMENTS = 16;

function scrubSentinels(text: string, sentinels: readonly string[]): string {
  if (!text || sentinels.length === 0) return text;
  let out = text;
  for (const s of sentinels) {
    if (s && out.includes(s)) {
      out = out.split(s).join("[redacted-sentinel]");
    }
  }
  return out;
}

/**
 * Redact an HTTP(S)/WS(S) URL to scheme + host + sanitized path:
 * - strips username, password, query string, and hash fragment
 * - generalizes email addresses, UUIDs, active sentinels, and opaque tokens
 * - idempotent across repeated invocations
 */
export function redactUrlV3(raw: string, sentinels: readonly string[] = []): string {
  if (!raw || typeof raw !== "string") return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      return `${parsed.protocol}//[redacted]`;
    }
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : "";
    const segments = parsed.pathname.split("/").slice(0, MAX_PATH_SEGMENTS + 1);
    const cleaned = segments.map((segment) => redactPathSegment(segment, sentinels));
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

function redactPathSegment(segment: string, sentinels: readonly string[] = []): string {
  if (!segment) return "";
  if (
    segment === "[redacted-token]" ||
    segment === "[redacted-email]" ||
    segment === "[redacted-sentinel]" ||
    segment === "[truncated]"
  ) {
    return segment;
  }
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  for (const s of sentinels) {
    if (s && (decoded.includes(s) || segment.includes(s))) {
      return "[redacted-sentinel]";
    }
  }
  if (EMAIL_IN_PATH.test(decoded)) {
    EMAIL_IN_PATH.lastIndex = 0;
    return "[redacted-email]";
  }
  if (
    JWT_EMBEDDED.test(decoded) ||
    UUID_EMBEDDED.test(decoded) ||
    LONG_HEX_SEGMENT.test(decoded) ||
    HIGH_ENTROPY_TOKEN.test(decoded) ||
    PREFIXED_HIGH_ENTROPY_TOKEN.test(decoded)
  ) {
    return "[redacted-token]";
  }
  return segment.length > 96 ? `${segment.slice(0, 64)}[truncated]` : segment;
}

function redactCookiePath(rawPath: string, sentinels: readonly string[] = []): string {
  const base = rawPath.split("?")[0].split("#")[0];
  const segments = base.split("/").slice(0, MAX_PATH_SEGMENTS + 1);
  const cleaned = segments.map((seg) => redactPathSegment(seg, sentinels)).join("/");
  return (cleaned.startsWith("/") ? cleaned : `/${cleaned}`).slice(0, 128);
}

function redactProseString(text: string, maxLen = 400, sentinels: readonly string[] = []): string {
  const urlsCleaned = text.replace(URL_IN_PROSE_RE, (raw) => {
    const trailingMatch = /([.,;:!?)]+)$/.exec(raw);
    const trailing = trailingMatch ? trailingMatch[1] : "";
    const core = trailing ? raw.slice(0, -trailing.length) : raw;
    return `${redactUrlV3(core, sentinels)}${trailing}`;
  });
  const emailsCleaned = urlsCleaned.replace(EMAIL_IN_PATH, "[redacted-email]");
  EMAIL_IN_PATH.lastIndex = 0;
  return scrubSentinels(emailsCleaned, sentinels).slice(0, maxLen);
}

function redactGcmSignals<T extends { gcs?: string }>(signals: readonly T[]): T[] {
  return signals.map((sig) => {
    if (sig.gcs && !VALID_GCS_RE.test(sig.gcs)) {
      const rest = { ...sig };
      delete rest.gcs;
      return rest;
    }
    return sig;
  });
}

function redactCallStack(
  frames?: CallStackFrameV3[],
  sentinels: readonly string[] = []
): CallStackFrameV3[] | undefined {
  if (!frames) return undefined;
  return frames.slice(0, 12).map((frame) => ({
    url: redactUrlV3(frame.url, sentinels),
    domain: frame.domain.toLowerCase(),
    ...(frame.line !== undefined ? { line: frame.line } : {}),
    ...(frame.column !== undefined ? { column: frame.column } : {}),
    ...(frame.functionName ? { functionName: scrubSentinels(frame.functionName, sentinels).slice(0, 80) } : {})
  }));
}

function redactRequest(req: NetworkRequestV3, sentinels: readonly string[] = []): NetworkRequestV3 {
  // Strictly project allowlisted request & response header keys so unexpected
  // headers can never leak across the persistence boundary.
  const rh = req.requestHeaders ?? {};
  const cleanReqHeaders: NetworkRequestV3["requestHeaders"] = {
    ...(rh.secGpc ? { secGpc: String(rh.secGpc).slice(0, 16) } : {}),
    ...(rh.dnt ? { dnt: String(rh.dnt).slice(0, 16) } : {}),
    ...(rh.origin ? { origin: redactOriginV3(rh.origin) } : {}),
    ...(rh.refererOrigin ? { refererOrigin: redactOriginV3(rh.refererOrigin) } : {}),
    ...(rh.secFetchSite ? { secFetchSite: String(rh.secFetchSite).slice(0, 32) } : {}),
    ...(rh.secFetchMode ? { secFetchMode: String(rh.secFetchMode).slice(0, 32) } : {})
  };
  const rsh = req.responseHeaders ?? {};
  const cleanRespHeaders: NetworkRequestV3["responseHeaders"] = {
    ...(typeof rsh.setCookieCount === "number" ? { setCookieCount: rsh.setCookieCount } : {}),
    ...(rsh.cacheControl ? { cacheControl: String(rsh.cacheControl).slice(0, 128) } : {}),
    ...(rsh.etagPresent ? { etagPresent: true } : {}),
    ...(rsh.accessControlAllowOrigin
      ? {
          accessControlAllowOrigin:
            rsh.accessControlAllowOrigin === "*" ? "*" : redactOriginV3(rsh.accessControlAllowOrigin)
        }
      : {}),
    ...(rsh.accessControlAllowCredentials ? { accessControlAllowCredentials: true } : {}),
    ...(rsh.contentSecurityPolicyPresent ? { contentSecurityPolicyPresent: true } : {}),
    ...(rsh.permissionsPolicyPresent ? { permissionsPolicyPresent: true } : {}),
    ...(rsh.strictTransportSecurityPresent ? { strictTransportSecurityPresent: true } : {}),
    ...(rsh.referrerPolicy ? { referrerPolicy: String(rsh.referrerPolicy).slice(0, 64) } : {}),
    ...(rsh.clearSiteData ? { clearSiteData: String(rsh.clearSiteData).slice(0, 128) } : {})
  };

  return {
    ...req,
    url: redactUrlV3(req.url, sentinels),
    domain: req.domain.toLowerCase(),
    registrableDomain: req.registrableDomain.toLowerCase(),
    redirectChain: req.redirectChain.map((hop) => redactUrlV3(hop, sentinels)),
    requestHeaders: cleanReqHeaders,
    responseHeaders: cleanRespHeaders,
    shields: {
      ...req.shields,
      rewrittenUrl: req.shields.rewrittenUrl ? redactUrlV3(req.shields.rewrittenUrl, sentinels) : null
    },
    initiator: req.initiator
      ? {
          ...req.initiator,
          ...(req.initiator.scriptUrl ? { scriptUrl: redactUrlV3(req.initiator.scriptUrl, sentinels) } : {}),
          ...(req.initiator.scriptDomain ? { scriptDomain: req.initiator.scriptDomain.toLowerCase() } : {}),
          ...(req.initiator.callStack ? { callStack: redactCallStack(req.initiator.callStack, sentinels) } : {})
        }
      : null
  };
}

function redactWebSocket(ws: WebSocketRecordV3, sentinels: readonly string[] = []): WebSocketRecordV3 {
  return {
    ...ws,
    url: redactUrlV3(ws.url, sentinels),
    domain: ws.domain.toLowerCase(),
    registrableDomain: ws.registrableDomain.toLowerCase()
  };
}

function redactArm(arm: ScanArmV3, sentinels: readonly string[] = []): ScanArmV3 {
  return {
    ...arm,
    finalUrl: redactUrlV3(arm.finalUrl, sentinels),
    network: arm.network.map((req) => redactRequest(req, sentinels)),
    websockets: arm.websockets.map((ws) => redactWebSocket(ws, sentinels)),
    serviceWorkers: arm.serviceWorkers.map((sw) => ({
      ...sw,
      scope: redactUrlV3(sw.scope, sentinels),
      scriptUrl: redactUrlV3(sw.scriptUrl, sentinels),
      domain: sw.domain.toLowerCase()
    })),
    cookies: arm.cookies.map((cookie) => ({
      name: redactPathSegment(cookie.name.slice(0, 128), sentinels),
      domain: cookie.domain.toLowerCase(),
      registrableDomain: cookie.registrableDomain.toLowerCase(),
      path: redactCookiePath(cookie.path, sentinels),
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
      keyOrStore: redactPathSegment(entry.keyOrStore.slice(0, 128), sentinels),
      ...(entry.entryCount !== undefined ? { entryCount: entry.entryCount } : {}),
      valueBytes: Math.max(0, Math.floor(entry.valueBytes)),
      phase: entry.phase,
      entity: entry.entity
    })),
    beacons: arm.beacons.map((b) => ({
      ...b,
      endpointHost: b.endpointHost.toLowerCase(),
      consentModeSignals: redactGcmSignals(b.consentModeSignals)
    })),
    fingerprinting: arm.fingerprinting.map((fp) => ({
      ...fp,
      evidence: Object.fromEntries(
        Object.entries(fp.evidence).map(([k, v]) => [
          k,
          typeof v === "string"
            ? redactProseString(v, 128, sentinels)
            : Array.isArray(v)
              ? v.slice(0, 20).map((item) => redactProseString(String(item), 64, sentinels))
              : v
        ])
      )
    })),
    consent: {
      ...arm.consent,
      interaction: {
        ...arm.consent.interaction,
        ...(arm.consent.interaction.selector
          ? { selector: scrubSentinels(arm.consent.interaction.selector, sentinels).slice(0, 160) }
          : {}),
        ...(arm.consent.interaction.matchedText
          ? { matchedText: redactProseString(arm.consent.interaction.matchedText, 120, sentinels) }
          : {}),
        ...(arm.consent.interaction.frameUrl
          ? { frameUrl: redactUrlV3(arm.consent.interaction.frameUrl, sentinels) }
          : {})
      },
      verification: {
        ...arm.consent.verification,
        googleConsentMode: redactGcmSignals(arm.consent.verification.googleConsentMode)
      }
    },
    policy: arm.policy
      ? {
          ...arm.policy,
          url: redactUrlV3(arm.policy.url, sentinels),
          claims: arm.policy.claims.map((c) => ({
            ...c,
            quote: redactProseString(c.quote, 220, sentinels)
          }))
        }
      : null
  };
}

/** Idempotently redact a ScanReportV3 before any persistence or network emission. */
export function redactScanReportV3(report: ScanReportV3, sentinels: readonly string[] = []): ScanReportV3 {
  return {
    ...report,
    targetUrl: redactUrlV3(report.targetUrl, sentinels),
    finalUrl: redactUrlV3(report.finalUrl, sentinels),
    canonicalDomain: report.canonicalDomain.toLowerCase(),
    leadArm: redactArm(report.leadArm, sentinels),
    comparisonArms: report.comparisonArms.map((arm) => redactArm(arm, sentinels)),
    highlights: report.highlights.map((h) => ({
      ...h,
      title: redactProseString(h.title, 200, sentinels),
      detail: redactProseString(h.detail, 400, sentinels)
    }))
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
function assertCleanUrlField(url: string | null | undefined, label: string): void {
  if (!url) return;
  if (url.includes("?") || url.includes("#")) {
    throw new Error(`Refusing to persist ScanReportV3: unredacted query/fragment in ${label}`);
  }
}

export function assertNoUnredactedSecretsV3(report: ScanReportV3, sentinels: readonly string[] = []): void {
  const serialized = JSON.stringify(report);
  for (const sentinel of sentinels) {
    if (sentinel && serialized.includes(sentinel)) {
      throw new Error("Refusing to persist ScanReportV3: active probe sentinel leaked into report payload");
    }
  }
  assertCleanUrlField(report.targetUrl, "targetUrl");
  assertCleanUrlField(report.finalUrl, "finalUrl");
  for (const h of report.highlights) {
    const urls = h.detail.match(URL_IN_PROSE_RE) ?? [];
    for (const u of urls) assertCleanUrlField(u, `highlight ${h.id}`);
  }
  for (const arm of [report.leadArm, ...report.comparisonArms]) {
    assertCleanUrlField(arm.finalUrl, `arm ${arm.armId} finalUrl`);
    assertCleanUrlField(arm.policy?.url, `arm ${arm.armId} policy.url`);
    assertCleanUrlField(arm.consent.interaction.frameUrl, `arm ${arm.armId} consent.interaction.frameUrl`);
    for (const req of arm.network) {
      assertCleanUrlField(req.url, `request URL ${req.id}`);
      for (const hop of req.redirectChain) assertCleanUrlField(hop, `request ${req.id} redirectChain`);
      assertCleanUrlField(req.shields.rewrittenUrl, `request ${req.id} shields.rewrittenUrl`);
      assertCleanUrlField(req.initiator?.scriptUrl, `request ${req.id} initiator.scriptUrl`);
      for (const frame of req.initiator?.callStack ?? []) {
        assertCleanUrlField(frame.url, `request ${req.id} callStack`);
      }
    }
    for (const ws of arm.websockets) assertCleanUrlField(ws.url, `websocket ${ws.id}`);
    for (const sw of arm.serviceWorkers) {
      assertCleanUrlField(sw.scope, "serviceWorker.scope");
      assertCleanUrlField(sw.scriptUrl, "serviceWorker.scriptUrl");
    }
    for (const beacon of arm.beacons) {
      for (const gcm of beacon.consentModeSignals) {
        if (gcm.gcs && !VALID_GCS_RE.test(gcm.gcs)) {
          throw new Error("Refusing to persist ScanReportV3: invalid raw gcs token in beacon");
        }
      }
    }
  }
}

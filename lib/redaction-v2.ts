import { getDomain } from "tldts";
import allowlists from "./redaction-allowlists.json";
import type { PrivacyStats } from "./scan-report-v2";

/**
 * Redaction v2: the default-deny sanitizer (RFC scan-report-v2 section 9).
 *
 * v1's redaction kept page-controlled URL paths verbatim and returned
 * unparseable URLs unchanged; both are forbidden here. Under v2 a public
 * string survives ONLY by appearing on a versioned, reviewed literal
 * allowlist; everything else generalizes to a marker, and malformed input
 * redacts instead of passing through. No heuristched "safe shape" rules for
 * survival: a heuristic that passes short lowercase words also passes names,
 * health topics, and identifiers. (Shape rules are used only to pick the
 * CLASS MARKER for something already being redacted, never to let it
 * survive.)
 *
 * Every call reports what it removed through the exact
 * `PrivacyStats.redaction` counter vocabulary, so a v2 producer can sum the
 * counters into the wire's privacy block and the remediation inventory can
 * quantify a rewrite before it happens.
 *
 * Node/worker-side module: the registrable-domain rule needs the public
 * suffix list (tldts), so this must stay out of client bundles the way
 * lib/domain-utils does.
 */

export const REDACTION_VERSION = 2;
export const REDACTION_ALLOWLISTS_VERSION: string = allowlists.version;

export const INVALID_URL_MARKER = "{invalid-url}";
export const INVALID_HOST_MARKER = "{invalid-host}";
const GENERALIZED_LABEL = "{label}";
const GENERALIZED_SEGMENT = "{seg}";
const GENERALIZED_NUMERIC_SEGMENT = "{n}";
const REDACTED_KEY = "[redacted]";
const TERMINAL_NAME_MARKERS = new Set([
  REDACTED_KEY,
  "[redacted:uuid-like]",
  "[redacted:numeric]",
  "[redacted:hex-like]",
  "[redacted:long-token]"
]);

/** RFC 9.1 path cap ("proposal: 6"). */
const MAX_PATH_SEGMENTS = 6;
/** A subdomain label longer than this always generalizes. */
const MAX_SUBDOMAIN_LABEL_LENGTH = 24;

export type RedactionCounters = PrivacyStats["redaction"];

export function emptyRedactionCounters(): RedactionCounters {
  return {
    pathSegmentsGeneralized: 0,
    queryKeysRedacted: 0,
    storageKeysRedacted: 0,
    cookieNamesRedacted: 0,
    matrixParamsStripped: 0,
    subdomainLabelsGeneralized: 0,
    malformedUrlsDropped: 0
  };
}

export function addRedactionCounters(target: RedactionCounters, source: RedactionCounters): void {
  for (const key of Object.keys(target) as (keyof RedactionCounters)[]) {
    target[key] += source[key];
  }
}

const routeLiterals = new Set(allowlists.routeLiterals.literals.map((literal) => literal.toLowerCase()));
const queryKeyLiterals = new Set(allowlists.queryKeys.literals.map((literal) => literal.toLowerCase()));
const queryKeyPrefixes = allowlists.queryKeys.prefixes.map((prefix) => prefix.toLowerCase());
const cookieNameLiterals = new Set(allowlists.cookieNames.literals);
const storageKeyLiterals = new Set(allowlists.storageKeys.literals);

// ---------------------------------------------------------------------------
// Shape classification: picks the marker for a value being redacted. Never a
// survival rule.
// ---------------------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SHAPE = /^[0-9a-f]{8,}$/i;
const NUMERIC_SHAPE = /^[0-9]+$/;
const BASE64ISH_SHAPE = /^[A-Za-z0-9+/_=-]{16,}$/;

export function tokenShapeMarker(value: string): string {
  // A report can cross multiple public boundaries (producer, store, export,
  // remediation). Markers are terminal public values: a later pass must not
  // collapse a classed marker back to the generic marker.
  if (TERMINAL_NAME_MARKERS.has(value)) return value;
  if (UUID_SHAPE.test(value)) return "[redacted:uuid-like]";
  // Numeric before hex: a digit-only string is valid hex too, and "numeric"
  // is the more truthful class for it.
  if (NUMERIC_SHAPE.test(value)) return "[redacted:numeric]";
  if (HEX_SHAPE.test(value)) return "[redacted:hex-like]";
  if (value.length >= 16 && BASE64ISH_SHAPE.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) {
    return "[redacted:long-token]";
  }
  return REDACTED_KEY;
}

/** Whether a subdomain label must generalize (RFC 9.1 host rule). */
function subdomainLabelIsTokenLike(label: string): boolean {
  // Punycode (xn--) is the canonical IDNA encoding of a human-readable name,
  // not an entropy token; the mixed-alphanumeric heuristic below would
  // misread nearly every one, so IDN labels are exempt from the shape rules
  // (a genuinely token-shaped IDN label still hits the length cap).
  const idn = label.toLowerCase().startsWith("xn--");
  if (label.length > MAX_SUBDOMAIN_LABEL_LENGTH) return true;
  if (idn) return false;
  if (UUID_SHAPE.test(label)) return true;
  if (HEX_SHAPE.test(label)) return true;
  if (NUMERIC_SHAPE.test(label) && label.length >= 5) return true;
  // Mixed-alphanumeric high-entropy labels (base64/base32 flavored).
  if (label.length >= 12 && /[0-9]/.test(label) && /[a-z]/i.test(label) && /^[a-z0-9_-]+$/i.test(label) && !/^[a-z]+[0-9]{1,2}$/i.test(label)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The URL policy (RFC 9.1)
// ---------------------------------------------------------------------------

export type RedactedUrl = {
  value: string;
  counters: RedactionCounters;
};

export type RedactUrlV2Options = {
  /**
   * Whether allowlisted query-parameter names are preserved (values are
   * always dropped). Mirrors v1's third-party-request behavior; when false
   * the whole query is dropped without touching the counters.
   */
  preserveQueryKeys?: boolean;
};

/**
 * Apply the full default-deny URL policy. Malformed and non-http(s) input
 * becomes the invalid-URL marker rather than passing through (the v1
 * pass-through at report-url.ts is exactly what this replaces).
 */
export function redactUrlV2(url: string, options: RedactUrlV2Options = {}): RedactedUrl {
  const counters = emptyRedactionCounters();
  if (url === INVALID_URL_MARKER) return { value: INVALID_URL_MARKER, counters };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    counters.malformedUrlsDropped += 1;
    return { value: INVALID_URL_MARKER, counters };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    counters.malformedUrlsDropped += 1;
    return { value: INVALID_URL_MARKER, counters };
  }

  // Host: WHATWG parsing already lowercases and punycodes; the registrable
  // domain always survives, labels left of it are screened.
  const hostname = redactCanonicalHostname(parsed.hostname, counters);

  const path = redactPath(parsed.pathname, counters);
  const query = options.preserveQueryKeys ? redactQuery(parsed.searchParams, counters) : "";

  const port = parsed.port ? `:${parsed.port}` : "";
  return { value: `${parsed.protocol}//${hostname}${port}${path}${query}`, counters };
}

function redactCanonicalHostname(hostname: string, counters: RedactionCounters): string {
  // IP literals have no labels to screen.
  if (/^\[.*\]$/.test(hostname) || /^[0-9.]+$/.test(hostname)) return hostname;
  const registrable = getDomain(hostname, { allowPrivateDomains: true });
  if (!registrable || registrable === hostname) return hostname;
  if (!hostname.endsWith(`.${registrable}`)) return hostname;
  const prefix = hostname.slice(0, hostname.length - registrable.length - 1);
  const labels = prefix.split(".").map((label) => {
    if (label && subdomainLabelIsTokenLike(label)) {
      counters.subdomainLabelsGeneralized += 1;
      return GENERALIZED_LABEL;
    }
    return label;
  });
  return `${labels.join(".")}.${registrable}`;
}

/**
 * Apply the URL host policy to a hostname-valued report field (request/domain
 * summaries, cookie domains, CNAMEs, provenance domains). Leading-dot cookie
 * domain notation is preserved, but malformed or non-host input never passes
 * through verbatim.
 */
export function redactHostnameV2(hostname: string): RedactedUrl {
  const counters = emptyRedactionCounters();
  if (hostname === INVALID_HOST_MARKER) return { value: INVALID_HOST_MARKER, counters };

  const trimmed = hostname.trim();
  const leadingDot = trimmed.startsWith(".");
  const raw = (leadingDot ? trimmed.slice(1) : trimmed).replace(/\.$/, "");
  if (!raw || /[\s/@?#]/.test(raw)) {
    counters.malformedUrlsDropped += 1;
    return { value: INVALID_HOST_MARKER, counters };
  }

  let canonical: string;
  try {
    canonical = new URL(`https://${raw}/`).hostname;
  } catch {
    counters.malformedUrlsDropped += 1;
    return { value: INVALID_HOST_MARKER, counters };
  }
  const value = redactCanonicalHostname(canonical, counters);
  return { value: `${leadingDot ? "." : ""}${value}`, counters };
}

function redactPath(pathname: string, counters: RedactionCounters): string {
  const rawSegments = pathname.split("/").filter((segment) => segment !== "");
  const kept: string[] = [];

  for (const [index, rawSegment] of rawSegments.entries()) {
    if (index >= MAX_PATH_SEGMENTS) {
      // Segments beyond the cap are dropped entirely; each is a
      // generalization the counters must admit to.
      counters.pathSegmentsGeneralized += 1;
      continue;
    }

    // Matrix parameters: everything from the first ";" is stripped before
    // classification (RFC 9.1); surviving names would need the query-key
    // allowlist, and the conservative v1 data file lists none, so the whole
    // matrix block drops.
    const semicolon = rawSegment.indexOf(";");
    const segment = semicolon >= 0 ? rawSegment.slice(0, semicolon) : rawSegment;
    if (semicolon >= 0) counters.matrixParamsStripped += 1;

    const decoded = safeDecode(segment);
    if (decoded === GENERALIZED_SEGMENT || decoded === GENERALIZED_NUMERIC_SEGMENT) {
      kept.push(decoded);
      continue;
    }
    if (routeLiterals.has(decoded.toLowerCase())) {
      kept.push(decoded.toLowerCase());
      continue;
    }
    counters.pathSegmentsGeneralized += 1;
    kept.push(NUMERIC_SHAPE.test(decoded) ? GENERALIZED_NUMERIC_SEGMENT : GENERALIZED_SEGMENT);
  }

  return kept.length === 0 ? "/" : `/${kept.join("/")}`;
}

/** Apply the URL path policy to a path-only field such as a cookie path. */
export function redactPathV2(pathname: string): RedactedUrl {
  const counters = emptyRedactionCounters();
  const trimmed = pathname.trim();
  if (!trimmed) return { value: "/", counters };

  // Cookie paths should be absolute. A non-absolute value is still treated as
  // page-controlled path material, never passed through; prefixing a slash
  // lets the ordinary default-deny segment policy generalize it.
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return { value: redactPath(absolute.split(/[?#]/, 1)[0], counters), counters };
}

function redactQuery(params: URLSearchParams, counters: RedactionCounters): string {
  const redacted = new URLSearchParams();
  params.forEach((_value, key) => {
    if (key === REDACTED_KEY) {
      redacted.append(REDACTED_KEY, "");
      return;
    }
    if (queryKeyAllowed(key)) {
      redacted.append(key, "");
      return;
    }
    counters.queryKeysRedacted += 1;
    redacted.append(REDACTED_KEY, "");
  });
  const serialized = redacted.toString();
  return serialized ? `?${serialized}` : "";
}

export function queryKeyAllowed(key: string): boolean {
  const lowered = key.toLowerCase();
  if (queryKeyLiterals.has(lowered)) return true;
  return queryKeyPrefixes.some((prefix) => lowered.startsWith(prefix));
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Cookie names and storage keys (RFC 9.3)
// ---------------------------------------------------------------------------

export type RedactedName = {
  value: string;
  /** Whether this pass left the value unchanged (allowlisted or already marked). */
  preserved: boolean;
};

export function redactCookieName(name: string, counters: RedactionCounters): RedactedName {
  if (TERMINAL_NAME_MARKERS.has(name)) return { value: name, preserved: true };
  if (cookieNameLiterals.has(name)) return { value: name, preserved: true };
  counters.cookieNamesRedacted += 1;
  return { value: tokenShapeMarker(name), preserved: false };
}

export function redactStorageKey(key: string, counters: RedactionCounters): RedactedName {
  if (TERMINAL_NAME_MARKERS.has(key)) return { value: key, preserved: true };
  if (storageKeyLiterals.has(key)) return { value: key, preserved: true };
  counters.storageKeysRedacted += 1;
  return { value: tokenShapeMarker(key), preserved: false };
}

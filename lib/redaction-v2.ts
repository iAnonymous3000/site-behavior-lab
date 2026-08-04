import { parse } from "tldts";
import allowlists from "./redaction-allowlists.json";
import type { PrivacyStats } from "./scan-report-v2";
import { sha256Hex } from "./sha256";
import {
  isRedactedNameMarker,
  isReviewedCookieName,
  isReviewedStorageKey
} from "./public-name-policy";

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
 * Calls report removals that fit the frozen `PrivacyStats.redaction` counter
 * vocabulary. Policy-revision transitions with no wire field (currently
 * title withholding, explicit-port removal, and IP-literal rejection) are
 * accounted separately by the versioned remediation transition audit; they
 * must never be misattributed to one of the seven legacy counters.
 *
 * Node/worker-side module: the registrable-domain rule needs the public
 * suffix list (tldts), so this must stay out of client bundles the way
 * lib/domain-utils does.
 */

// Policy revision 4 also withholds page-authored titles and IP/port literals.
// The module name remains the RFC's "redaction v2" architecture; this numeric
// identity is the executable sanitizer revision carried in provenance.
export const REDACTION_VERSION = 4;
export const REDACTION_ALLOWLISTS_VERSION: string = allowlists.version;
export const REDACTION_ALLOWLISTS_DIGEST = sha256Hex(JSON.stringify(allowlists));
export const PUBLIC_SUFFIX_ENGINE_VERSION = "tldts@7.4.10";

export const INVALID_URL_MARKER = "{invalid-url}";
export const INVALID_HOST_MARKER = "{invalid-host}";
const GENERALIZED_LABEL = "{label}";
const GENERALIZED_SEGMENT = "{seg}";
const GENERALIZED_NUMERIC_SEGMENT = "{n}";
const REDACTED_KEY = "[redacted]";

/** RFC 9.1 path cap ("proposal: 6"). */
const MAX_PATH_SEGMENTS = 6;
const MAX_RAW_URL_CHARS = 16_384;
const MAX_PUBLIC_QUERY_KEYS = 32;
const MAX_RAW_HOST_CHARS = 253;
const MAX_RAW_PATH_CHARS = 4_096;
const MAX_RAW_NAME_CHARS = 1_024;

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

/**
 * Page titles are arbitrary page-authored text. A target can reflect a path,
 * query token, tenant name, or signed-in user's name into `<title>`, so a
 * length cap cannot make the value safe for a persistent public report.
 *
 * The frozen report wires require a string. The empty string is therefore the
 * stable public marker; report views already fall back to the report's
 * privacy-reduced domain. Producer-owned comparison titles are a separate
 * field and remain governed by their closed producer vocabulary.
 */
export function redactPageTitle(_value: string): "" {
  return "";
}

const routeLiterals = new Set(allowlists.routeLiterals.literals.map((literal) => literal.toLowerCase()));
const subdomainLabelLiterals = new Set(allowlists.subdomainLabels.literals.map((literal) => literal.toLowerCase()));
const queryKeyLiterals = new Set(allowlists.queryKeys.literals.map((literal) => literal.toLowerCase()));

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
  if (isRedactedNameMarker(value)) return value;
  if (value.length > MAX_RAW_NAME_CHARS) return "[redacted:long-token]";
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
  if (url.length > MAX_RAW_URL_CHARS) {
    counters.malformedUrlsDropped += 1;
    return { value: INVALID_URL_MARKER, counters };
  }
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

  // Host: WHATWG parsing already lowercases, punycodes, and canonicalizes IP
  // spellings. Registrable domains survive while IP literals fail closed;
  // exact network addresses are not safe persistent public identifiers.
  const hostname = redactCanonicalHostname(parsed.hostname, counters);
  if (hostname === INVALID_HOST_MARKER) return { value: INVALID_URL_MARKER, counters };

  const path = redactPath(parsed.pathname, counters);
  const query = options.preserveQueryKeys ? redactQuery(parsed.searchParams, counters) : dropQuery(parsed.searchParams, counters);

  // Ports can disclose private service topology and are not needed to group
  // public evidence. Drop every explicit non-default port; WHATWG has already
  // canonicalized default ports to the empty string.
  return { value: `${parsed.protocol}//${hostname}${path}${query}`, counters };
}

function dropQuery(params: URLSearchParams, counters: RedactionCounters): "" {
  for (const _key of params.keys()) counters.queryKeysRedacted += 1;
  return "";
}

function redactCanonicalHostname(hostname: string, counters: RedactionCounters): string {
  const canonicalHostname = hostname.replace(/\.+$/, "");
  if (!canonicalHostname) {
    counters.malformedUrlsDropped += 1;
    return INVALID_HOST_MARKER;
  }
  // IP literals have no privacy-safe registrable boundary. WHATWG URL parsing
  // has already normalized alternate IPv4 spellings, so these two shapes
  // cover canonical IPv4 and bracketed IPv6 without maintaining an address
  // classification table that can drift.
  if (/^\[.*\]$/.test(canonicalHostname) || /^\d+\.\d+\.\d+\.\d+$/.test(canonicalHostname)) {
    counters.malformedUrlsDropped += 1;
    return INVALID_HOST_MARKER;
  }
  const registrable = publicRegistrableDomain(canonicalHostname);
  if (!registrable) {
    counters.malformedUrlsDropped += 1;
    return INVALID_HOST_MARKER;
  }
  if (registrable === canonicalHostname) return canonicalHostname;
  if (!canonicalHostname.endsWith(`.${registrable}`)) return INVALID_HOST_MARKER;
  const prefix = canonicalHostname.slice(0, canonicalHostname.length - registrable.length - 1);
  const labels = prefix.split(".").map((label) => {
    // Subdomains can be tenant names, clinics, usernames, or opaque ids. Keep
    // only reviewed infrastructure/service literals; everything else is a
    // marker. The marker itself is terminal for repeated publication passes.
    if (label && label !== GENERALIZED_LABEL && !subdomainLabelLiterals.has(label.toLowerCase())) {
      counters.subdomainLabelsGeneralized += 1;
      return GENERALIZED_LABEL;
    }
    return label;
  });
  return `${labels.join(".")}.${registrable}`;
}

/**
 * Return a registrable domain only when it is backed by the ICANN or reviewed
 * private suffix tables. Unknown and special-use suffixes (for example
 * `.internal`, `.localhost`, and `.example`) are not a safe public boundary:
 * tldts otherwise treats the entire human-controlled label as the domain.
 */
export function publicRegistrableDomain(hostname: string): string | null {
  let canonicalHostname: string;
  try {
    canonicalHostname = new URL(`https://${hostname.replace(/\.+$/, "")}/`).hostname.replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (!canonicalHostname) return null;
  const originalLabels = canonicalHostname.split(".");
  const markerSafeHostname = originalLabels
    .map((label) => label === GENERALIZED_LABEL ? "redacted-label" : label)
    .join(".");
  const parsed = parse(markerSafeHostname, { allowPrivateDomains: true });
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) return null;
  const domainLabels = parsed.domain.split(".").length;
  return originalLabels.slice(-domainLabels).join(".");
}

/**
 * True when the host IS a registry boundary rather than a site under one, for
 * example `github.io`, `gov.uk`, or `s3.amazonaws.com`.
 *
 * Such a host has no registrable domain, so it can identify a party but can
 * never be a scan SUBJECT: the subject key is derived from
 * `publicRegistrableDomain`. Admission uses this to refuse the target up front
 * instead of letting the r2 builder discover it after a full measurement.
 */
export function isExactPublicSuffixHost(hostname: string): boolean {
  const parsed = parse(hostname, { allowPrivateDomains: true });
  return (
    parsed.domain === null &&
    parsed.publicSuffix === hostname &&
    (parsed.isIcann === true || parsed.isPrivate === true)
  );
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
  const raw = (leadingDot ? trimmed.slice(1) : trimmed).replace(/\.+$/, "");
  if (!raw || raw.length > MAX_RAW_HOST_CHARS || /[\s/@?#]/.test(raw)) {
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
  if (trimmed.length > MAX_RAW_PATH_CHARS) {
    counters.pathSegmentsGeneralized += 1;
    return { value: `/${GENERALIZED_SEGMENT}`, counters };
  }

  // Cookie paths should be absolute. A non-absolute value is still treated as
  // page-controlled path material, never passed through; prefixing a slash
  // lets the ordinary default-deny segment policy generalize it.
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return { value: redactPath(absolute.split(/[?#]/, 1)[0], counters), counters };
}

function redactQuery(params: URLSearchParams, counters: RedactionCounters): string {
  const redacted = new URLSearchParams();
  const emitted = new Set<string>();
  for (const key of params.keys()) {
    let publicKey: string;
    if (key === REDACTED_KEY) {
      publicKey = REDACTED_KEY;
    } else if (queryKeyAllowed(key)) {
      // Canonical casing closes a covert page-controlled string channel.
      publicKey = key.toLowerCase();
    } else {
      counters.queryKeysRedacted += 1;
      publicKey = REDACTED_KEY;
    }
    if (emitted.has(publicKey)) continue;
    if (emitted.size >= MAX_PUBLIC_QUERY_KEYS) {
      counters.queryKeysRedacted += 1;
      continue;
    }
    emitted.add(publicKey);
    redacted.append(publicKey, "");
  }
  const serialized = redacted.toString();
  return serialized ? `?${serialized}` : "";
}

export function queryKeyAllowed(key: string): boolean {
  const lowered = key.toLowerCase();
  return queryKeyLiterals.has(lowered);
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
  if (isRedactedNameMarker(name) || isReviewedCookieName(name)) return { value: name, preserved: true };
  counters.cookieNamesRedacted += 1;
  return { value: tokenShapeMarker(name), preserved: false };
}

export function redactStorageKey(key: string, counters: RedactionCounters): RedactedName {
  if (isRedactedNameMarker(key) || isReviewedStorageKey(key)) return { value: key, preserved: true };
  counters.storageKeysRedacted += 1;
  return { value: tokenShapeMarker(key), preserved: false };
}

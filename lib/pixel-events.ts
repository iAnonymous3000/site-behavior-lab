/**
 * Pixel-level event decoder.
 *
 * The tracker catalogue tells you a Meta/TikTok/X pixel is *present*. This layer
 * reads what the pixel is actually *doing*: which events it fired (PageView,
 * Purchase, ...) and whether it attached personal identifiers ("advanced
 * matching", e.g. a hashed email or phone). That is the analysis Blacklight
 * performs from full request archives.
 *
 * Two deliberate privacy rules keep this compatible with the rest of the scanner
 * (which scrubs request URLs to origin+path and never retains payloads):
 *
 *   1. Event NAMES are only stored verbatim when they match the platform's
 *      standard event vocabulary (PageView, Purchase, ...). Anything else is a
 *      site-defined string, usually a benign label but potentially a name or
 *      account identifier, so it is generalized to "custom event" instead of
 *      persisted. A safe-token filter still bounds what is inspected at all.
 *   2. Advanced-matching identifiers are detected by checking that a known
 *      identifier parameter carries a NON-EMPTY value. The value is inspected
 *      only transiently in memory for that emptiness test; it is never
 *      persisted, exposed, semantically decoded, or hash-validated, only the
 *      category label (email / phone / ...) is stored. This makes "the site
 *      sends your email identifier to Meta" reportable without the scanner
 *      itself holding PII. (The frozen v2 r1/r2 schema descriptions overstate
 *      this as "never reads"; see the RFC errata.)
 *
 * Pure and dependency-light so it unit-tests without a browser. The scanner
 * feeds it the raw (pre-redaction) request URL and POST body; everywhere else
 * consumes the {@link PixelEventSummary} it returns.
 */

import { safeParseUrl } from "./report-url";
import type { PixelEventSummary, PixelMatchField } from "./types";

export type { PixelEventSummary, PixelMatchField } from "./types";

/** A single observed request, as captured before report redaction. */
export type PixelEventInput = {
  url: string;
  method?: string;
  postData?: string | null;
};

type DecodedPixel = {
  platform: string;
  product: string;
  events: string[];
  advancedMatching: PixelMatchField[];
};

// Defensive cap mirroring the scanner's capture-time truncation
// (lib/scanner.ts MAX_CAPTURED_BODY_CHARS): never JSON-parse or urldecode an
// over-large third-party body, which the scanned page controls. The URL still
// decodes normally; only the body is treated as absent past the cap.
export const MAX_DECODED_BODY_CHARS = 64_000;

// Canonical display order so two scans of the same site render identically.
const FIELD_ORDER: PixelMatchField[] = ["email", "phone", "name", "address", "date_of_birth", "gender", "external_id"];
const PLATFORM_ORDER = ["Meta", "TikTok", "X"];

/**
 * Aggregate the decoded pixel activity for a visit, one entry per platform.
 * Requests that are not a recognised pixel endpoint are ignored.
 */
export function summarizePixelEvents(inputs: PixelEventInput[]): PixelEventSummary[] {
  const byPlatform = new Map<string, PixelEventSummary>();

  for (const input of inputs) {
    const decoded = decodePixelRequest(input);
    if (!decoded) continue;

    const existing = byPlatform.get(decoded.platform);
    if (existing) {
      existing.requests += 1;
      mergeInto(existing.events, decoded.events);
      mergeInto(existing.advancedMatching, decoded.advancedMatching);
    } else {
      byPlatform.set(decoded.platform, {
        platform: decoded.platform,
        product: decoded.product,
        events: dedupe(decoded.events),
        advancedMatching: dedupe(decoded.advancedMatching),
        requests: 1
      });
    }
  }

  return Array.from(byPlatform.values())
    .map((summary) => ({
      ...summary,
      events: [...summary.events].sort((a, b) => a.localeCompare(b)),
      advancedMatching: sortFields(summary.advancedMatching)
    }))
    .sort((a, b) => platformRank(a.platform) - platformRank(b.platform) || a.platform.localeCompare(b.platform));
}

/** Decode a single request, or null when it is not a recognised pixel endpoint. */
export function decodePixelRequest(input: PixelEventInput): DecodedPixel | null {
  const parsed = safeParseUrl(input.url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (isMetaPixel(host, path)) return decodeMeta(parsed, input);
  if (isTikTokPixel(host, path)) return decodeTikTok(input);
  if (isXPixel(host, path)) return decodeX(parsed, input);
  return null;
}

// --- Meta (Facebook) Pixel: GET (or POST) to facebook.com/tr ----------------

const META_UD_FIELDS: Record<string, PixelMatchField> = {
  em: "email",
  ph: "phone",
  fn: "name",
  ln: "name",
  ge: "gender",
  db: "date_of_birth",
  ct: "address",
  st: "address",
  zp: "address",
  zip: "address",
  country: "address",
  external_id: "external_id"
};

/**
 * Standard event vocabularies, per platform. A name outside the vocabulary is
 * a site-defined string: usually a benign label, but nothing stops a site
 * putting a visitor's name or account identifier there, so custom names are
 * generalized to {@link CUSTOM_EVENT_LABEL} instead of being persisted.
 */
export const META_STANDARD_EVENTS = buildEventVocabulary([
  "PageView",
  "AddPaymentInfo",
  "AddToCart",
  "AddToWishlist",
  "CompleteRegistration",
  "Contact",
  "CustomizeProduct",
  "Donate",
  "FindLocation",
  "InitiateCheckout",
  "Lead",
  "Purchase",
  "Schedule",
  "Search",
  "StartTrial",
  "SubmitApplication",
  "Subscribe",
  "ViewContent"
]);

export const TIKTOK_STANDARD_EVENTS = buildEventVocabulary([
  "Pageview",
  "AddPaymentInfo",
  "AddToCart",
  "AddToWishlist",
  "ClickButton",
  "CompletePayment",
  "CompleteRegistration",
  "Contact",
  "Download",
  "InitiateCheckout",
  "PlaceAnOrder",
  "Search",
  "SubmitForm",
  "Subscribe",
  "ViewContent"
]);

export const CUSTOM_EVENT_LABEL = "custom event";

/**
 * X names its two outcomes inline in decodeX rather than from a vocabulary
 * map, because they are derived from parameters rather than matched against a
 * catalogued list. Stated here so the redactor's frozen snapshot can be checked
 * against the producer for all three platforms rather than two.
 */
export const X_EVENT_NAMES: readonly string[] = ["Purchase", "Conversion tracking"];

function buildEventVocabulary(names: string[]): Map<string, string> {
  return new Map(names.map((name) => [name.toLowerCase(), name]));
}

/** The catalogued form of a standard event name, or the generalized custom label. */
function catalogEventName(value: string, vocabulary: Map<string, string>): string {
  return vocabulary.get(value.trim().toLowerCase()) ?? CUSTOM_EVENT_LABEL;
}

function isMetaPixel(host: string, path: string): boolean {
  return hostMatches(host, "facebook.com") && (path === "/tr" || path.startsWith("/tr/"));
}

function decodeMeta(parsed: URL, input: PixelEventInput): DecodedPixel {
  const params = mergedParams(parsed, input);
  const events = new Set<string>();
  for (const token of params.getAll("ev")) {
    // An UNSAFE token is generalized, never dropped. isSafeEventToken decides
    // whether the raw string may be looked up at all, not whether an event
    // happened, and dropping it left a decoded pixel with zero events while the
    // report still headlined "reported specific named events, not just their
    // presence". Any non-ASCII, over-long, or digit-leading custom name (a
    // French "Lead - Formulaire contact", for instance) did exactly that.
    // CUSTOM_EVENT_LABEL is a fixed string, so no page text is persisted.
    if (!hasStringValue(token)) continue;
    events.add(isSafeEventToken(token) ? catalogEventName(token, META_STANDARD_EVENTS) : CUSTOM_EVENT_LABEL);
  }
  const advancedMatching = new Set<PixelMatchField>();

  for (const [key, value] of params) {
    if (!hasStringValue(value)) continue;
    // Advanced matching is sent as ud[em], ud[ph], ud[external_id], ...
    const match = key.match(/^ud\[([^\]]+)\]$/i);
    const field = match ? META_UD_FIELDS[match[1].toLowerCase()] : undefined;
    if (field) advancedMatching.add(field);
  }

  return { platform: "Meta", product: "Meta Pixel", events: Array.from(events), advancedMatching: Array.from(advancedMatching) };
}

// --- TikTok Pixel: POST JSON to analytics.tiktok.com/api/v2/pixel -----------

const TIKTOK_USER_FIELDS: Record<string, PixelMatchField> = {
  email: "email",
  phone: "phone",
  phone_number: "phone",
  external_id: "external_id",
  first_name: "name",
  last_name: "name",
  name: "name",
  zip_code: "address",
  zip: "address",
  city: "address",
  state: "address",
  country: "address",
  address: "address",
  date_of_birth: "date_of_birth",
  birthday: "date_of_birth",
  gender: "gender"
};

function isTikTokPixel(host: string, path: string): boolean {
  return hostMatches(host, "analytics.tiktok.com") && path.startsWith("/api/v2/pixel");
}

function decodeTikTok(input: PixelEventInput): DecodedPixel {
  const events = new Set<string>();
  const advancedMatching = new Set<PixelMatchField>();
  const body = parseJsonBody(input.postData);

  for (const event of tiktokEventObjects(body)) {
    const name = firstString(event, ["event", "event_type", "type"]);
    // Same rule as decodeMeta: generalize an unsafe name, never drop the event.
    if (name && hasStringValue(name)) {
      events.add(isSafeEventToken(name) ? catalogEventName(name, TIKTOK_STANDARD_EVENTS) : CUSTOM_EVENT_LABEL);
    }

    const user = pickUserObject(event);
    if (!user) continue;
    for (const [key, value] of Object.entries(user)) {
      if (!hasJsonValue(value)) continue;
      const field = TIKTOK_USER_FIELDS[key.toLowerCase()];
      if (field) advancedMatching.add(field);
    }
  }

  return { platform: "TikTok", product: "TikTok Pixel", events: Array.from(events), advancedMatching: Array.from(advancedMatching) };
}

// --- X (Twitter) Pixel: GET to analytics.twitter.com/i/adsct ----------------

function isXPixel(host: string, path: string): boolean {
  return (hostMatches(host, "analytics.twitter.com") || host === "t.co") && path.startsWith("/i/adsct");
}

function decodeX(parsed: URL, input: PixelEventInput): DecodedPixel {
  const params = mergedParams(parsed, input);
  // The adsct endpoint is X's conversion/audience tag. Order-value parameters
  // mark a purchase; everything else is conversion/audience tracking. X's
  // browser pixel identifies via its own cookie (p_user_id), not user-supplied
  // PII, so no advanced-matching categories are claimed here.
  const purchase = hasStringValue(params.get("tw_sale_amount") ?? "") || hasStringValue(params.get("tw_order_quantity") ?? "");
  return {
    platform: "X",
    product: "X (Twitter) Pixel",
    events: [purchase ? "Purchase" : "Conversion tracking"],
    advancedMatching: []
  };
}

// --- shared helpers ---------------------------------------------------------

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Query params plus any urlencoded POST body (pixels occasionally POST `/tr`). */
function mergedParams(parsed: URL, input: PixelEventInput): URLSearchParams {
  const params = new URLSearchParams(parsed.search);
  const body = input.postData;
  if (body && body.length <= MAX_DECODED_BODY_CHARS && !looksLikeJson(body)) {
    try {
      new URLSearchParams(body).forEach((value, key) => params.append(key, value));
    } catch {
      /* ignore an unparseable body; query params still stand */
    }
  }
  return params;
}

function parseJsonBody(body: string | null | undefined): unknown {
  if (!body || body.length > MAX_DECODED_BODY_CHARS || !looksLikeJson(body)) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** Candidate event objects from a TikTok body: a single event, a batch, or an array. */
function tiktokEventObjects(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  if (typeof body.event === "string" || typeof body.event_type === "string") return [body];
  for (const key of ["batch", "events", "data", "messages"]) {
    const value = body[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function pickUserObject(event: Record<string, unknown>): Record<string, unknown> | null {
  const context = event.context;
  if (isRecord(context) && isRecord(context.user)) return context.user;
  if (isRecord(event.user)) return event.user;
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Whether a string is a plausible event NAME rather than a payload value. Meta
 * standard and custom events are short identifier-like tokens; a hashed value
 * (64 hex chars), URL-encoded JSON, or anything with separators fails here, so a
 * mislabelled field can never leak a value into the stored report. Tokens that
 * pass are still generalized to "custom event" unless they match the platform's
 * standard vocabulary (see {@link catalogEventName}).
 */
function isSafeEventToken(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9 _.-]{0,39}$/.test(value);
}

function hasStringValue(value: string): boolean {
  return value.trim().length > 0;
}

function hasJsonValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeInto<T>(target: T[], items: T[]): void {
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function sortFields(fields: PixelMatchField[]): PixelMatchField[] {
  return [...fields].sort((a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b));
}

function platformRank(platform: string): number {
  const index = PLATFORM_ORDER.indexOf(platform);
  return index === -1 ? PLATFORM_ORDER.length : index;
}

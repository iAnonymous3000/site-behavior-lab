import {
  ADOBE_ANALYTICS_FORMAT,
  ADOBE_DOWNLOAD_LINK,
  ADOBE_EXIT_LINK,
  ADOBE_PAGE_VIEW,
  GA4_FORMAT,
  GA4_SCROLL_EVENT,
  GA4_STANDARD_EVENT_NAMES,
  SCROLL_DEPTH_EVENT,
  type AnalyticsFormat
} from "./analytics-event-vocabulary";
import { buildEventVocabulary, catalogEventName, CUSTOM_EVENT_LABEL, isSafeEventToken, MAX_DECODED_BODY_CHARS } from "./pixel-events";
import { safeParseUrl } from "./report-url";

/**
 * GA4 and Adobe Analytics events a request carried, for a check after
 * scrolling (build brief approved 2026-10-25, owner calls 1 to 5). Pure and
 * browser-free; the ordinary report never uses it, and the report's own pixel
 * decoder (lib/pixel-events.ts) is untouched: this module only reuses its
 * rules for event names.
 *
 * FORMATS, recognized by path and format parameters, never by host, so a
 * collection address on the site's own domain is decoded too:
 * - GA4: a path ending `/g/collect`, with `v=2` and a `tid` starting `G-`.
 *   The URL's `en` is one event, and each line of the body is another, as
 *   GA4 batches them.
 * - Adobe Analytics: a classic `/b/ss/` beacon, from its URL or from a
 *   urlencoded body (Adobe's library posts a long beacon). It is one event,
 *   named by its link type (`pe`); a custom link is named by its link name
 *   (`pev2`) under owner call 1. The `events` list is site-defined numbering
 *   and is never read.
 * A renamed collection endpoint and Adobe's Web SDK (`/ee/` calls carrying
 * JSON) are not recognized.
 *
 * NAMES (owner call 1, option c). A GA4 name in Google's documented
 * vocabulary is shown as catalogued; every other GA4 name, and every Adobe
 * link name, is site-defined text, generalized to the pixel decoder's custom
 * label unless it reads as a scroll depth (scrollDepthPercent), which is
 * shown in the scanner's own words, "scroll depth <N>%". A site's own string
 * is never returned.
 *
 * VALUES. None are read except two: GA4's percent_scrolled on its scroll
 * event, kept only as an integer from 0 to 100, and Adobe's link name, read
 * only for the scroll-depth test. Every other parameter, identifier and value
 * is ignored.
 *
 * BODIES are read only for a request in a decoded format, through the reader
 * the caller hands in (the scanner's own bounded helper), and never kept. A
 * truncated, unreadable or unrecognized body is reported as not read in
 * full, never guessed at.
 */

/** Google's documented GA4 event names, catalogued by the pixel decoder's own rule. */
export const GA4_STANDARD_EVENTS = buildEventVocabulary([...GA4_STANDARD_EVENT_NAMES]);

/** A request's body as the scanner's own bounded helper reads it (safeRequestPostDataWithCoverage, lib/scanner.ts). */
export type AnalyticsBeaconBody = {
  value: string | null;
  truncated: boolean;
  unreadable: boolean;
};

/**
 * One event, in the vocabulary's words or as CUSTOM_EVENT_LABEL. `percent` is
 * GA4's percent_scrolled for its scroll event, or a recognized scroll depth;
 * otherwise null.
 */
export type AnalyticsEvent = { name: string; percent: number | null };

export type DecodedAnalyticsBeacon = {
  format: AnalyticsFormat;
  /** Every event read, in the order the request carried them. */
  events: AnalyticsEvent[];
  /** Whether every event the request carried was read: false for a truncated, unreadable or unrecognized body. */
  complete: boolean;
};

const CUSTOM_EVENT: AnalyticsEvent = Object.freeze({ name: CUSTOM_EVENT_LABEL, percent: null }) as AnalyticsEvent;

/** GA4 sends percent_scrolled as a number parameter; a string one is read the same way. */
const PERCENT_SCROLLED_KEYS = ["epn.percent_scrolled", "ep.percent_scrolled"] as const;

/** The format a request's address is in, from its path and format parameters alone, or null. */
export function analyticsBeaconFormat(url: string): AnalyticsFormat | null {
  const parsed = httpUrl(url);
  return parsed === null ? null : formatOf(parsed);
}

/**
 * The events a request in a decoded format carried, or null for any other
 * request, whose body is then never read. `readBody` is called at most once,
 * and only once the address is recognized.
 */
export function decodeAnalyticsBeacon(url: string, readBody: () => AnalyticsBeaconBody): DecodedAnalyticsBeacon | null {
  const parsed = httpUrl(url);
  if (parsed === null) return null;
  const format = formatOf(parsed);
  if (format === null) return null;
  let body: AnalyticsBeaconBody;
  try {
    body = readBody();
  } catch {
    body = { value: null, truncated: false, unreadable: true };
  }
  return format === GA4_FORMAT ? decodeGa4(parsed, body) : decodeAdobe(parsed, body);
}

/**
 * Owner call 1, option (c): the percent a site's own event or link name
 * gives as a scroll depth, or null. All of these must hold:
 * - it contains "scroll", case-insensitively;
 * - it also contains "depth", "tracking" or "percent", case-insensitively, or
 *   a % sign;
 * - it contains exactly one integer (one run of the digits 0 to 9), and that
 *   integer is from 0 to 100.
 * So "scroll_depth_20%" and "On scroll_tracking of 25" are recognized, and
 * "infinite_scroll_page_2", "scroll_section_3", "scroll_to_top" and
 * "scroll 2024" are not.
 */
export function scrollDepthPercent(name: string): number | null {
  if (!/scroll/i.test(name)) return null;
  if (!/depth|tracking|percent/i.test(name) && !name.includes("%")) return null;
  const integers = name.match(/[0-9]+/g);
  if (integers === null || integers.length !== 1) return null;
  const digits = integers[0].replace(/^0+(?=[0-9])/, "");
  return digits.length <= 3 && Number(digits) <= 100 ? Number(digits) : null;
}

function httpUrl(url: string): URL | null {
  const parsed = safeParseUrl(url);
  return parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed : null;
}

function formatOf(parsed: URL): AnalyticsFormat | null {
  const params = parsed.searchParams;
  if (parsed.pathname.endsWith("/g/collect") && params.get("v") === "2" && (params.get("tid") ?? "").startsWith("G-")) {
    return GA4_FORMAT;
  }
  if (parsed.pathname.includes("/b/ss/")) return ADOBE_ANALYTICS_FORMAT;
  return null;
}

function decodeGa4(parsed: URL, body: AnalyticsBeaconBody): DecodedAnalyticsBeacon {
  const events: AnalyticsEvent[] = [];
  for (const name of parsed.searchParams.getAll("en")) addGa4Event(events, name, parsed.searchParams);
  if (body.truncated || body.unreadable) return { format: GA4_FORMAT, events, complete: false };
  const text = body.value;
  if (text === null || text.length === 0) return { format: GA4_FORMAT, events, complete: true };
  if (text.length > MAX_DECODED_BODY_CHARS) return { format: GA4_FORMAT, events, complete: false };
  let complete = true;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim().length === 0) continue;
    const params = new URLSearchParams(line);
    const names = params.getAll("en");
    // A line that names no event is not one GA4 batches, so what it carried
    // is unknown.
    if (names.length === 0) {
      complete = false;
      continue;
    }
    for (const name of names) addGa4Event(events, name, params);
  }
  return { format: GA4_FORMAT, events, complete };
}

function addGa4Event(events: AnalyticsEvent[], name: string, params: URLSearchParams): void {
  // As the pixel decoder does, an empty name is no event.
  if (name.trim().length === 0) return;
  const standard = isSafeEventToken(name) ? catalogEventName(name, GA4_STANDARD_EVENTS) : CUSTOM_EVENT_LABEL;
  if (standard !== CUSTOM_EVENT_LABEL) {
    events.push({ name: standard, percent: standard === GA4_SCROLL_EVENT ? percentScrolled(params) : null });
    return;
  }
  const depth = scrollDepthPercent(name);
  events.push(depth === null ? CUSTOM_EVENT : { name: SCROLL_DEPTH_EVENT, percent: depth });
}

/** GA4's percent_scrolled, only as an integer from 0 to 100. */
function percentScrolled(params: URLSearchParams): number | null {
  for (const key of PERCENT_SCROLLED_KEYS) {
    const value = params.get(key);
    if (value === null) continue;
    return /^[0-9]{1,3}$/.test(value) && Number(value) <= 100 ? Number(value) : null;
  }
  return null;
}

function decodeAdobe(parsed: URL, body: AnalyticsBeaconBody): DecodedAnalyticsBeacon {
  // Adobe's library posts a long beacon's whole query as the body, so a body
  // that was not read in full may hold the link type itself: no event is
  // guessed from the rest.
  if (body.truncated || body.unreadable) return { format: ADOBE_ANALYTICS_FORMAT, events: [], complete: false };
  const params = new URLSearchParams(parsed.search);
  const text = body.value;
  if (text !== null && text.length > 0) {
    if (text.length > MAX_DECODED_BODY_CHARS || !isFormBody(text)) return { format: ADOBE_ANALYTICS_FORMAT, events: [], complete: false };
    new URLSearchParams(text).forEach((value, key) => params.append(key, value));
  }
  // A beacon that carries no parameter at all carries no event.
  if (params.keys().next().done) return { format: ADOBE_ANALYTICS_FORMAT, events: [], complete: true };
  return { format: ADOBE_ANALYTICS_FORMAT, events: [adobeEvent(params)], complete: true };
}

/** A urlencoded form on one line: not JSON, not multipart, and holding at least one pair. */
function isFormBody(text: string): boolean {
  return text.includes("=") && !/[\r\n]/.test(text) && !/^\s*[[{]/.test(text);
}

function adobeEvent(params: URLSearchParams): AnalyticsEvent {
  const linkType = (params.get("pe") ?? "").trim();
  // Adobe counts a beacon with no link type as a page view.
  if (linkType === "") return { name: ADOBE_PAGE_VIEW, percent: null };
  if (linkType === "lnk_d") return { name: ADOBE_DOWNLOAD_LINK, percent: null };
  if (linkType === "lnk_e") return { name: ADOBE_EXIT_LINK, percent: null };
  if (linkType !== "lnk_o") return CUSTOM_EVENT;
  const linkName = params.get("pev2");
  const depth = linkName === null ? null : scrollDepthPercent(linkName);
  return depth === null ? CUSTOM_EVENT : { name: SCROLL_DEPTH_EVENT, percent: depth };
}

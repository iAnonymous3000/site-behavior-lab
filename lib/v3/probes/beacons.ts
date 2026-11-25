/**
 * Unified host-agnostic beacon, pixel, analytics, and server-side tagging
 * decoder for Site Behavior Lab v3.
 *
 * Unifies and dramatically expands `lib/pixel-events.ts` and
 * `lib/analytics-events.ts`, dropping the `thirdParty === true` gate so
 * first-party CNAME / sGTM / Cloudflare Zaraz / Meta CAPI / Adobe Edge
 * endpoints are decoded identically to third-party endpoints.
 *
 * Protocols covered (16+):
 *   1. GA4 (`/g/collect`, `v=2`) + Google Consent Mode (`gcs` / `gcd`)
 *   2. Google Ads conversion (`/pagead/1p-conversion/`, `/pagead/conversion/`, `tid=AW-*`)
 *   3. Meta Pixel & CAPI Gateway (`/tr`, `ev=`, `ud[*]`, JSON CAPI payloads)
 *   4. TikTok Pixel (`/api/v2/pixel`, JSON batches)
 *   5. X (Twitter) Pixel (`/i/adsct`)
 *   6. Adobe Analytics Classic (`/b/ss/`)
 *   7. Adobe Experience Platform Web SDK (`/ee/.../interact`)
 *   8. LinkedIn Insight Tag (`/collect` with `pid=` / `px.ads.linkedin.com`)
 *   9. Snap Pixel (`/p` on `tr.snapchat.com` or `sc-static` payload)
 *  10. Pinterest Tag (`/v3/` on `ct.pinterest.com` with `event=` / `ed=`)
 *  11. Microsoft / Bing UET (`/action/0` with `ti=` & `evt=`)
 *  12. Reddit Pixel (`/rp.gif` or `/api/v2/events`)
 *  13. Twilio Segment (`/v1/t`, `/v1/p`, `/v1/i`, `/v1/b`)
 *  14. Amplitude (`/2/httpapi`, `/batch`)
 *  15. Mixpanel (`/track`, `/engage`)
 *  16. PostHog (`/e/`, `/capture/`, `/batch/`)
 *  17. Microsoft Clarity (`/collect` on `clarity.ms`)
 *  18. Cloudflare Zaraz (`/cdn-cgi/zaraz/t`)
 *
 * Privacy invariant:
 * - Standard event names are stored verbatim; site-defined custom event names
 *   are generalized to `"custom event"` (or `"scroll depth <N>%"` when
 *   matching bounded scroll depth).
 * - Identifier categories (email, phone, name, address, dob, gender,
 *   external_id) are recorded ONLY by key presence with a non-empty value;
 *   values are NEVER stored or logged.
 */

import {
  CUSTOM_EVENT_LABEL,
  META_STANDARD_EVENTS,
  TIKTOK_STANDARD_EVENTS,
  buildEventVocabulary,
  catalogEventName,
  isSafeEventToken
} from "../../pixel-events";
import { GA4_STANDARD_EVENT_NAMES } from "../../analytics-event-vocabulary";
import { scrollDepthPercent } from "../../analytics-events";
import type {
  BeaconEventSummaryV3,
  GoogleConsentModeSignalV3,
  IdentifierCategoryV3,
  ScanPhaseName
} from "../schema";

export const MAX_BEACON_BODY_CHARS = 64_000;

export type BeaconInputV3 = {
  url: string;
  method?: string;
  postData?: string | null;
  contentType?: string | null;
  thirdParty: boolean;
  phase: ScanPhaseName;
};

type DecodedBeacon = {
  platform: string;
  product: string;
  format: string;
  endpointHost: string;
  firstPartyEndpoint: boolean;
  serverSideTagging: boolean;
  events: string[];
  scrollDepths: number[];
  consentModeSignals: GoogleConsentModeSignalV3[];
  identifierCategories: IdentifierCategoryV3[];
  complete: boolean;
};

const GA4_EVENTS = buildEventVocabulary([...GA4_STANDARD_EVENT_NAMES]);

const PINTEREST_EVENTS = buildEventVocabulary([
  "pagevisit",
  "viewcategory",
  "search",
  "addtocart",
  "checkout",
  "watchvideo",
  "signup",
  "lead",
  "custom"
]);

const SNAP_EVENTS = buildEventVocabulary([
  "PAGE_VIEW",
  "VIEW_CONTENT",
  "ADD_CART",
  "ADD_BILLING",
  "START_CHECKOUT",
  "PURCHASE",
  "SEARCH",
  "SIGN_UP",
  "SUBSCRIBE",
  "AD_CLICK",
  "AD_VIEW",
  "COMPLETE_TUTORIAL",
  "INVITE",
  "LOGIN",
  "SHARE",
  "RESERVE",
  "ACHIEVEMENT_UNLOCKED",
  "ADD_TO_WISHLIST",
  "SPENT_CREDITS",
  "RATE",
  "START_TRIAL",
  "LIST_VIEW"
]);

const REDDIT_EVENTS = buildEventVocabulary([
  "PageVisit",
  "ViewContent",
  "Search",
  "AddToCart",
  "AddToWishlist",
  "Purchase",
  "Lead",
  "SignUp",
  "Custom"
]);

const IDENTIFIER_KEY_MAP: Readonly<Record<string, IdentifierCategoryV3>> = {
  em: "email",
  email: "email",
  user_email: "email",
  hashed_email: "email",
  u_em: "email",
  ph: "phone",
  phone: "phone",
  phone_number: "phone",
  u_pn: "phone",
  fn: "name",
  ln: "name",
  first_name: "name",
  last_name: "name",
  name: "name",
  ct: "address",
  st: "address",
  zp: "address",
  zip: "address",
  zip_code: "address",
  city: "address",
  state: "address",
  country: "address",
  address: "address",
  db: "date_of_birth",
  dob: "date_of_birth",
  date_of_birth: "date_of_birth",
  birthday: "date_of_birth",
  ge: "gender",
  gender: "gender",
  external_id: "external_id",
  externalid: "external_id",
  user_id: "external_id",
  userid: "external_id",
  uid: "external_id"
};

const FIELD_ORDER: readonly IdentifierCategoryV3[] = [
  "email",
  "phone",
  "name",
  "address",
  "date_of_birth",
  "gender",
  "external_id"
];

/**
 * Parse Google Consent Mode `gcs` (e.g. `G111`, `G100`, `G101`, `G110`) and
 * `gcd` (v2 encoded string, e.g. `13l3l3l3l1`) from GA4 / Google Ads params.
 */
export function parseGoogleConsentMode(params: URLSearchParams): GoogleConsentModeSignalV3 | null {
  const gcs = params.get("gcs")?.trim();
  const gcd = params.get("gcd")?.trim();
  if (!gcs && !gcd) return null;

  let adStorage: GoogleConsentModeSignalV3["adStorage"] = "unknown";
  let analyticsStorage: GoogleConsentModeSignalV3["analyticsStorage"] = "unknown";
  let adUserData: GoogleConsentModeSignalV3["adUserData"];
  let adPersonalization: GoogleConsentModeSignalV3["adPersonalization"];

  if (gcs && /^G1[01-][01-]$/.test(gcs)) {
    adStorage = gcs[2] === "1" ? "granted" : gcs[2] === "0" ? "denied" : "unknown";
    analyticsStorage = gcs[3] === "1" ? "granted" : gcs[3] === "0" ? "denied" : "unknown";
  }

  // Google Consent Mode v2 `gcd` format: `11<ad_storage>1<analytics_storage>1<ad_user_data>1<ad_personalization>1...`
  // Letter codes: l/m/p/q/u -> denied; r/t/v/n/e -> granted (Google Tag v2 encoding).
  if (gcd && /^1[0-9][a-z][0-9][a-z][0-9][a-z][0-9][a-z]/i.test(gcd)) {
    const decodeGcdLetter = (ch: string): "granted" | "denied" | "unknown" => {
      const c = ch.toLowerCase();
      if ("rtvne".includes(c)) return "granted";
      if ("lmpqu".includes(c)) return "denied";
      return "unknown";
    };
    const adS = decodeGcdLetter(gcd[2]);
    const anS = decodeGcdLetter(gcd[4]);
    const aud = decodeGcdLetter(gcd[6]);
    const ap = decodeGcdLetter(gcd[8]);
    if (adStorage === "unknown") adStorage = adS;
    if (analyticsStorage === "unknown") analyticsStorage = anS;
    adUserData = aud;
    adPersonalization = ap;
  }

  return {
    ...(gcs ? { gcs } : {}),
    adStorage,
    analyticsStorage,
    ...(adUserData ? { adUserData } : {}),
    ...(adPersonalization ? { adPersonalization } : {})
  };
}

/** Decode a single HTTP request into a structured beacon observation, or null. */
export function decodeBeaconRequestV3(input: BeaconInputV3): DecodedBeacon | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const pathLower = path.toLowerCase();
  const params = parsed.searchParams;
  const firstPartyEndpoint = !input.thirdParty;

  // 1. Cloudflare Zaraz (first-party server-side tagging)
  if (pathLower.startsWith("/cdn-cgi/zaraz/t")) {
    return decodeZaraz(host, firstPartyEndpoint, input.postData);
  }

  // 2. GA4 (host-agnostic: catches google-analytics.com AND first-party sGTM!)
  if (pathLower.endsWith("/g/collect") && params.get("v") === "2") {
    const tid = params.get("tid") ?? "";
    const isGoogleHost = hostMatches(host, "google-analytics.com") || hostMatches(host, "analytics.google.com") || hostMatches(host, "doubleclick.net");
    if (tid.startsWith("G-") || tid.startsWith("GT-") || tid.startsWith("AW-") || isGoogleHost || params.has("en")) {
      return decodeGa4(host, parsed, input.postData, firstPartyEndpoint, !isGoogleHost && firstPartyEndpoint);
    }
  }

  // 3. Google Ads conversion
  if (
    (hostMatches(host, "googleadservices.com") || hostMatches(host, "doubleclick.net") || hostMatches(host, "google.com")) &&
    (pathLower.includes("/pagead/conversion") || pathLower.includes("/pagead/1p-conversion") || pathLower.includes("/pagead/viewthroughconversion"))
  ) {
    const gcm = parseGoogleConsentMode(params);
    const ids = extractIdentifiersFromParams(params);
    return {
      platform: "Google Ads",
      product: "Google Ads Conversion Tag",
      format: "google-ads",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: [params.get("label") ? "Conversion" : "Remarketing"],
      scrollDepths: [],
      consentModeSignals: gcm ? [gcm] : [],
      identifierCategories: ids,
      complete: true
    };
  }

  // 4. Meta Pixel & First-Party CAPI Gateway (host-agnostic when `/tr` + `ev=` + `id=`)
  const isMetaHost = hostMatches(host, "facebook.com");
  if ((pathLower === "/tr" || pathLower.startsWith("/tr/")) && (isMetaHost || (params.has("ev") && params.has("id")))) {
    return decodeMeta(host, parsed, input, firstPartyEndpoint, !isMetaHost && firstPartyEndpoint);
  }

  // 5. TikTok Pixel (host or `/api/v2/pixel`)
  const isTikTokHost = hostMatches(host, "analytics.tiktok.com") || hostMatches(host, "business-api.tiktok.com");
  if (pathLower.startsWith("/api/v2/pixel") && (isTikTokHost || looksLikeJson(input.postData))) {
    return decodeTikTok(host, input.postData, firstPartyEndpoint, !isTikTokHost && firstPartyEndpoint);
  }

  // 6. X (Twitter) Pixel
  if ((hostMatches(host, "analytics.twitter.com") || host === "t.co") && pathLower.startsWith("/i/adsct")) {
    const sale = Number(params.get("tw_sale_amount") ?? "0");
    const qty = Number(params.get("tw_order_quantity") ?? "0");
    return {
      platform: "X",
      product: "X (Twitter) Pixel",
      format: "x-adsct",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: [(Number.isFinite(sale) && sale > 0) || (Number.isFinite(qty) && qty > 0) ? "Purchase" : "Conversion tracking"],
      scrollDepths: [],
      consentModeSignals: [],
      identifierCategories: [],
      complete: true
    };
  }

  // 7. Adobe Analytics Classic (`/b/ss/` — host-agnostic, frequently CNAME-cloaked)
  if (pathLower.includes("/b/ss/")) {
    return decodeAdobeClassic(host, parsed, input.postData, firstPartyEndpoint);
  }

  // 8. Adobe Experience Platform Web SDK (`/ee/.../interact` — host-agnostic)
  if (/\/ee\/(?:[a-z0-9_-]+\/)?v\d+\/interact\b/i.test(pathLower)) {
    return decodeAdobeWebSdk(host, input.postData, firstPartyEndpoint);
  }

  // 9. LinkedIn Insight Tag
  if ((hostMatches(host, "ads.linkedin.com") || hostMatches(host, "linkedin.com")) && pathLower.startsWith("/collect")) {
    const conv = params.get("conversionId");
    return {
      platform: "LinkedIn",
      product: "LinkedIn Insight Tag",
      format: "linkedin-insight",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: [conv ? "Conversion" : "PageView"],
      scrollDepths: [],
      consentModeSignals: [],
      identifierCategories: extractIdentifiersFromParams(params),
      complete: true
    };
  }

  // 10. Snap Pixel
  if (hostMatches(host, "tr.snapchat.com") && (pathLower === "/p" || pathLower.startsWith("/p/") || pathLower.startsWith("/cm/"))) {
    return decodeSnap(host, parsed, input.postData, firstPartyEndpoint);
  }

  // 11. Pinterest Tag
  if (hostMatches(host, "ct.pinterest.com") && pathLower.startsWith("/v3")) {
    return decodePinterest(host, parsed, firstPartyEndpoint);
  }

  // 12. Microsoft / Bing UET
  if (hostMatches(host, "bat.bing.com") && pathLower.startsWith("/action/")) {
    const evt = params.get("evt")?.trim() || "pageLoad";
    const normalized = evt === "pageLoad" ? "PageLoad" : isSafeEventToken(evt) && evt === "custom" ? CUSTOM_EVENT_LABEL : CUSTOM_EVENT_LABEL;
    const gcm = parseGoogleConsentMode(params);
    return {
      platform: "Microsoft",
      product: "Microsoft Advertising UET",
      format: "bing-uet",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: [normalized],
      scrollDepths: [],
      consentModeSignals: gcm ? [gcm] : [],
      identifierCategories: extractIdentifiersFromParams(params),
      complete: true
    };
  }

  // 13. Reddit Pixel
  if ((hostMatches(host, "alb.reddit.com") && pathLower.startsWith("/rp.gif")) || (hostMatches(host, "events.redditmedia.com") && pathLower.includes("/events"))) {
    const rawEvent = params.get("event") ?? "";
    const event = rawEvent && isSafeEventToken(rawEvent) ? catalogEventName(rawEvent, REDDIT_EVENTS) : "PageVisit";
    return {
      platform: "Reddit",
      product: "Reddit Pixel",
      format: "reddit-pixel",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: [event],
      scrollDepths: [],
      consentModeSignals: [],
      identifierCategories: extractIdentifiersFromParams(params),
      complete: true
    };
  }

  // 14. Twilio Segment (host-agnostic for `/v1/t`, `/v1/p`, `/v1/i`, `/v1/b` JSON)
  if (
    (hostMatches(host, "segment.io") || hostMatches(host, "segment.com") || looksLikeJson(input.postData)) &&
    /^\/v1\/(?:t|p|i|b|track|page|identify|batch)$/.test(pathLower)
  ) {
    const decoded = decodeSegment(host, pathLower, input.postData, firstPartyEndpoint);
    if (decoded) return decoded;
  }

  // 15. Amplitude
  if (
    (hostMatches(host, "amplitude.com") && (pathLower.includes("/httpapi") || pathLower.endsWith("/batch") || pathLower === "/")) ||
    pathLower === "/2/httpapi"
  ) {
    const decoded = decodeAmplitude(host, input.postData, firstPartyEndpoint);
    if (decoded) return decoded;
  }

  // 16. Mixpanel
  if (hostMatches(host, "mixpanel.com") && (pathLower.startsWith("/track") || pathLower.startsWith("/engage"))) {
    return decodeMixpanel(host, pathLower, parsed, input.postData, firstPartyEndpoint);
  }

  // 17. PostHog (host-agnostic when `/e/` or `/capture/` carries PostHog JSON/query)
  if (
    hostMatches(host, "posthog.com") &&
    (pathLower.startsWith("/e") || pathLower.startsWith("/capture") || pathLower.startsWith("/batch") || pathLower.startsWith("/s/"))
  ) {
    return decodePostHog(host, pathLower, input.postData, firstPartyEndpoint);
  }

  // 18. Microsoft Clarity
  if (hostMatches(host, "clarity.ms") && pathLower.includes("/collect")) {
    return {
      platform: "Microsoft Clarity",
      product: "Microsoft Clarity Session Replay",
      format: "clarity-collect",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: ["session_replay_batch"],
      scrollDepths: [],
      consentModeSignals: [],
      identifierCategories: [],
      complete: true
    };
  }

  return null;
}

/** Aggregate decoded beacons grouped by `(platform, endpointHost)` in deterministic order. */
export function summarizeBeaconEventsV3(inputs: readonly BeaconInputV3[]): BeaconEventSummaryV3[] {
  const groups = new Map<string, BeaconEventSummaryV3>();

  for (const input of inputs) {
    const decoded = decodeBeaconRequestV3(input);
    if (!decoded) continue;
    const key = `${decoded.platform}|${decoded.endpointHost}`;
    const existing = groups.get(key);
    if (existing) {
      existing.requests += 1;
      existing.complete = existing.complete && decoded.complete;
      existing.serverSideTagging = existing.serverSideTagging || decoded.serverSideTagging;
      addUnique(existing.phases, input.phase);
      for (const ev of decoded.events) addUnique(existing.events, ev);
      for (const sd of decoded.scrollDepths) addUnique(existing.scrollDepths, sd);
      for (const id of decoded.identifierCategories) addUnique(existing.identifierCategories, id);
      for (const gcm of decoded.consentModeSignals) {
        if (!existing.consentModeSignals.some((c) => JSON.stringify(c) === JSON.stringify(gcm))) {
          existing.consentModeSignals.push(gcm);
        }
      }
    } else {
      groups.set(key, {
        platform: decoded.platform,
        product: decoded.product,
        format: decoded.format,
        endpointHost: decoded.endpointHost,
        firstPartyEndpoint: decoded.firstPartyEndpoint,
        serverSideTagging: decoded.serverSideTagging,
        phases: [input.phase],
        events: [...new Set(decoded.events)],
        scrollDepths: [...new Set(decoded.scrollDepths)],
        consentModeSignals: [...decoded.consentModeSignals],
        identifierCategories: [...new Set(decoded.identifierCategories)],
        requests: 1,
        complete: decoded.complete
      });
    }
  }

  return [...groups.values()]
    .map((entry) => ({
      ...entry,
      events: [...entry.events].sort((a, b) => a.localeCompare(b)),
      scrollDepths: [...entry.scrollDepths].sort((a, b) => a - b),
      identifierCategories: [...entry.identifierCategories].sort(
        (a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b)
      )
    }))
    .sort((a, b) => b.requests - a.requests || a.platform.localeCompare(b.platform) || a.endpointHost.localeCompare(b.endpointHost));
}

// --- Per-protocol decoders --------------------------------------------------

function decodeGa4(
  host: string,
  parsed: URL,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean,
  serverSideTagging: boolean
): DecodedBeacon {
  const events: string[] = [];
  const scrollDepths: number[] = [];
  const consentSignals: GoogleConsentModeSignalV3[] = [];
  const ids = new Set<IdentifierCategoryV3>(extractIdentifiersFromParams(parsed.searchParams));
  const gcm = parseGoogleConsentMode(parsed.searchParams);
  if (gcm) consentSignals.push(gcm);

  const collectEvent = (params: URLSearchParams) => {
    for (const rawName of params.getAll("en")) {
      if (!rawName.trim()) continue;
      const standard = isSafeEventToken(rawName) ? catalogEventName(rawName, GA4_EVENTS) : CUSTOM_EVENT_LABEL;
      if (standard !== CUSTOM_EVENT_LABEL) {
        events.push(standard);
        if (standard === "scroll") {
          const pct = params.get("epn.percent_scrolled") ?? params.get("ep.percent_scrolled");
          if (pct && /^\d{1,3}$/.test(pct) && Number(pct) <= 100) scrollDepths.push(Number(pct));
        }
      } else {
        const depth = scrollDepthPercent(rawName);
        if (depth !== null) {
          events.push("scroll_depth");
          scrollDepths.push(depth);
        } else {
          events.push(CUSTOM_EVENT_LABEL);
        }
      }
    }
    const lineGcm = parseGoogleConsentMode(params);
    if (lineGcm) consentSignals.push(lineGcm);
    for (const id of extractIdentifiersFromParams(params)) ids.add(id);
  };

  collectEvent(parsed.searchParams);
  let complete = true;
  if (postData) {
    if (postData.length > MAX_BEACON_BODY_CHARS) {
      complete = false;
    } else {
      for (const line of postData.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const lineParams = new URLSearchParams(line);
        if (!lineParams.has("en")) complete = false;
        collectEvent(lineParams);
      }
    }
  }

  return {
    platform: serverSideTagging ? "Google Analytics (sGTM)" : "Google Analytics",
    product: serverSideTagging ? "GA4 via Server-Side Tag Manager" : "Google Analytics 4",
    format: "ga4",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging,
    events,
    scrollDepths,
    consentModeSignals: consentSignals,
    identifierCategories: [...ids],
    complete
  };
}

function decodeMeta(
  host: string,
  parsed: URL,
  input: BeaconInputV3,
  firstPartyEndpoint: boolean,
  serverSideTagging: boolean
): DecodedBeacon {
  const params = new URLSearchParams(parsed.search);
  let complete = true;
  const body = input.postData;
  if (body) {
    if (body.length > MAX_BEACON_BODY_CHARS) {
      complete = false;
    } else if (!looksLikeJson(body) && body.includes("=")) {
      new URLSearchParams(body).forEach((v, k) => params.append(k, v));
    }
  }

  const events: string[] = [];
  for (const token of params.getAll("ev")) {
    if (!token.trim()) continue;
    events.push(isSafeEventToken(token) ? catalogEventName(token, META_STANDARD_EVENTS) : CUSTOM_EVENT_LABEL);
  }

  const ids = new Set<IdentifierCategoryV3>();
  for (const [key, value] of params) {
    if (!value.trim()) continue;
    const ud = /^ud\[([^\]]+)\]$/i.exec(key);
    const mapped = lookupIdentifierKey(ud ? ud[1] : key);
    if (mapped) ids.add(mapped);
  }

  return {
    platform: serverSideTagging ? "Meta (CAPI Gateway)" : "Meta",
    product: serverSideTagging ? "Meta Pixel / Conversions API Gateway" : "Meta Pixel",
    format: "meta-pixel",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete
  };
}

function decodeTikTok(
  host: string,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean,
  serverSideTagging: boolean
): DecodedBeacon {
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>();
  const parsed = safeParseJson(postData);
  let complete = parsed !== null;

  const inspectObj = (obj: unknown, depth = 0) => {
    if (depth > 4 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) inspectObj(item, depth + 1);
      return;
    }
    const rec = obj as Record<string, unknown>;
    const rawName = firstString(rec, ["event", "event_type", "type"]);
    if (rawName) {
      events.push(isSafeEventToken(rawName) ? catalogEventName(rawName, TIKTOK_STANDARD_EVENTS) : CUSTOM_EVENT_LABEL);
    }
    extractIdentifiersFromObject(rec.user, ids);
    if (rec.context && typeof rec.context === "object") {
      extractIdentifiersFromObject((rec.context as Record<string, unknown>).user, ids);
    }
    for (const batchKey of ["batch", "events", "data", "messages"]) {
      if (Array.isArray(rec[batchKey])) inspectObj(rec[batchKey], depth + 1);
    }
  };
  if (parsed !== null) inspectObj(parsed);

  return {
    platform: "TikTok",
    product: serverSideTagging ? "TikTok Events API Gateway" : "TikTok Pixel",
    format: "tiktok-pixel",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete
  };
}

function decodeAdobeClassic(
  host: string,
  parsed: URL,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon {
  const params = new URLSearchParams(parsed.search);
  let complete = true;
  if (postData) {
    if (postData.length > MAX_BEACON_BODY_CHARS) complete = false;
    else if (postData.includes("=") && !looksLikeJson(postData)) {
      new URLSearchParams(postData).forEach((v, k) => params.append(k, v));
    }
  }
  const pe = (params.get("pe") ?? "").trim();
  const events: string[] = [];
  const scrollDepths: number[] = [];
  if (pe === "") events.push("page_view");
  else if (pe === "lnk_d") events.push("download_link");
  else if (pe === "lnk_e") events.push("exit_link");
  else if (pe === "lnk_o") {
    const pev2 = params.get("pev2") ?? "";
    const depth = scrollDepthPercent(pev2);
    if (depth !== null) {
      events.push("scroll_depth");
      scrollDepths.push(depth);
    } else {
      events.push(CUSTOM_EVENT_LABEL);
    }
  } else {
    events.push(CUSTOM_EVENT_LABEL);
  }

  return {
    platform: "Adobe Analytics",
    product: firstPartyEndpoint ? "Adobe Analytics (First-Party / CNAME)" : "Adobe Analytics",
    format: "adobe-classic",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: firstPartyEndpoint,
    events,
    scrollDepths,
    consentModeSignals: [],
    identifierCategories: extractIdentifiersFromParams(params),
    complete
  };
}

function decodeAdobeWebSdk(
  host: string,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon {
  const parsed = safeParseJson(postData);
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const list = (parsed as Record<string, unknown>).events;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const xdm = (item as Record<string, unknown>).xdm;
        if (xdm && typeof xdm === "object") {
          const rec = xdm as Record<string, unknown>;
          const eventType = typeof rec.eventType === "string" ? rec.eventType : "";
          if (eventType.includes("pageViews")) events.push("page_view");
          else if (eventType.includes("linkClicks")) events.push("link_click");
          else if (eventType.includes("purchases")) events.push("purchase");
          else if (eventType) events.push(CUSTOM_EVENT_LABEL);
          extractIdentifiersFromObject(rec.identityMap, ids);
        }
      }
    }
  }
  if (events.length === 0) events.push("interact");

  return {
    platform: "Adobe Experience Platform",
    product: firstPartyEndpoint ? "Adobe Web SDK (First-Party Edge)" : "Adobe Web SDK",
    format: "adobe-web-sdk",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: firstPartyEndpoint,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: parsed !== null
  };
}

function decodeSnap(
  host: string,
  parsed: URL,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon {
  const params = new URLSearchParams(parsed.search);
  const json = safeParseJson(postData);
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>(extractIdentifiersFromParams(params));
  const rawEv =
    params.get("ev") ??
    (json && typeof json === "object" && !Array.isArray(json) ? firstString(json as Record<string, unknown>, ["ev", "event_type"]) : null);
  if (rawEv) {
    events.push(isSafeEventToken(rawEv) ? catalogEventName(rawEv, SNAP_EVENTS) : CUSTOM_EVENT_LABEL);
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    extractIdentifiersFromObject(json as Record<string, unknown>, ids);
  }
  return {
    platform: "Snap",
    product: "Snap Pixel",
    format: "snap-pixel",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: false,
    events: events.length > 0 ? events : ["PAGE_VIEW"],
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: true
  };
}

function decodePinterest(host: string, parsed: URL, firstPartyEndpoint: boolean): DecodedBeacon {
  const params = parsed.searchParams;
  const rawEv = params.get("event") ?? "";
  const event = rawEv && isSafeEventToken(rawEv) ? catalogEventName(rawEv, PINTEREST_EVENTS) : "pagevisit";
  const ids = new Set<IdentifierCategoryV3>(extractIdentifiersFromParams(params));
  if (params.get("pd[em]")) ids.add("email");
  return {
    platform: "Pinterest",
    product: "Pinterest Tag",
    format: "pinterest-tag",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: false,
    events: [event],
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: true
  };
}

function decodeSegment(
  host: string,
  pathLower: string,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon | null {
  const parsed = safeParseJson(postData);
  const isSegmentHost = hostMatches(host, "segment.io") || hostMatches(host, "segment.com");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!isSegmentHost) return null;
    return {
      platform: "Twilio Segment",
      product: "Segment CDP",
      format: "segment",
      endpointHost: host,
      firstPartyEndpoint,
      serverSideTagging: false,
      events: [pathLower.endsWith("/p") ? "page" : pathLower.endsWith("/i") ? "identify" : "track"],
      scrollDepths: [],
      consentModeSignals: [],
      identifierCategories: [],
      complete: false
    };
  }
  const rec = parsed as Record<string, unknown>;
  // Require Segment shape when on a first-party proxy host to avoid false positives.
  if (!isSegmentHost && typeof rec.writeKey !== "string" && !Array.isArray(rec.batch) && typeof rec.anonymousId !== "string") {
    return null;
  }
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>();
  const inspect = (msg: Record<string, unknown>) => {
    const type = typeof msg.type === "string" ? msg.type : pathLower.endsWith("/p") ? "page" : pathLower.endsWith("/i") ? "identify" : "track";
    events.push(["page", "identify", "track", "screen", "group", "alias"].includes(type) ? type : CUSTOM_EVENT_LABEL);
    if (typeof msg.userId === "string" && msg.userId.trim()) ids.add("external_id");
    extractIdentifiersFromObject(msg.traits, ids);
  };
  if (Array.isArray(rec.batch)) {
    for (const item of rec.batch) {
      if (item && typeof item === "object" && !Array.isArray(item)) inspect(item as Record<string, unknown>);
    }
  } else {
    inspect(rec);
  }
  return {
    platform: "Twilio Segment",
    product: firstPartyEndpoint ? "Segment (First-Party Proxy)" : "Segment CDP",
    format: "segment",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: firstPartyEndpoint,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: true
  };
}

function decodeAmplitude(
  host: string,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon | null {
  const parsed = safeParseJson(postData);
  const isAmpHost = hostMatches(host, "amplitude.com");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return isAmpHost
      ? {
          platform: "Amplitude",
          product: "Amplitude Analytics",
          format: "amplitude",
          endpointHost: host,
          firstPartyEndpoint,
          serverSideTagging: false,
          events: [CUSTOM_EVENT_LABEL],
          scrollDepths: [],
          consentModeSignals: [],
          identifierCategories: [],
          complete: false
        }
      : null;
  }
  const rec = parsed as Record<string, unknown>;
  if (!isAmpHost && !Array.isArray(rec.events)) return null;
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>();
  const list = Array.isArray(rec.events) ? rec.events : [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const ev = item as Record<string, unknown>;
    const evType = typeof ev.event_type === "string" ? ev.event_type : "";
    if (evType === "[Amplitude] Page Viewed" || evType === "page_view") events.push("page_view");
    else if (evType === "session_start" || evType === "session_end") events.push(evType);
    else if (evType) events.push(CUSTOM_EVENT_LABEL);
    if (typeof ev.user_id === "string" && ev.user_id.trim()) ids.add("external_id");
    extractIdentifiersFromObject(ev.user_properties, ids);
  }
  return {
    platform: "Amplitude",
    product: firstPartyEndpoint ? "Amplitude (First-Party Proxy)" : "Amplitude Analytics",
    format: "amplitude",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: firstPartyEndpoint,
    events: events.length > 0 ? events : [CUSTOM_EVENT_LABEL],
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: true
  };
}

function decodeMixpanel(
  host: string,
  pathLower: string,
  parsed: URL,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon {
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>();
  const rawData = parsed.searchParams.get("data") ?? postData;
  const json = safeParseJson(rawData);
  const items = Array.isArray(json) ? json : json && typeof json === "object" ? [json] : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.event === "string" ? rec.event : "";
    if (name === "$mp_web_page_view" || name === "Page View") events.push("page_view");
    else if (name) events.push(CUSTOM_EVENT_LABEL);
    extractIdentifiersFromObject(rec.properties, ids);
    extractIdentifiersFromObject(rec.$set, ids);
  }
  if (events.length === 0) events.push(pathLower.startsWith("/engage") ? "identify" : CUSTOM_EVENT_LABEL);
  return {
    platform: "Mixpanel",
    product: "Mixpanel Analytics",
    format: "mixpanel",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: false,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: json !== null
  };
}

function decodePostHog(
  host: string,
  pathLower: string,
  postData: string | null | undefined,
  firstPartyEndpoint: boolean
): DecodedBeacon {
  const events: string[] = [];
  const ids = new Set<IdentifierCategoryV3>();
  const json = safeParseJson(postData);
  const items = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).batch)
      ? ((json as Record<string, unknown>).batch as unknown[])
      : json && typeof json === "object"
        ? [json]
        : [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.event === "string" ? rec.event : "";
    if (name === "$pageview") events.push("page_view");
    else if (name === "$autocapture") events.push("autocapture");
    else if (name === "$pageleave") events.push("page_leave");
    else if (name === "$identify") events.push("identify");
    else if (name === "$snapshot") events.push("session_replay");
    else if (name) events.push(CUSTOM_EVENT_LABEL);
    extractIdentifiersFromObject(rec.properties, ids);
  }
  if (events.length === 0) events.push(pathLower.startsWith("/s/") ? "session_replay" : "capture");
  return {
    platform: "PostHog",
    product: "PostHog Product Analytics",
    format: "posthog",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: firstPartyEndpoint,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [...ids],
    complete: json !== null
  };
}

function decodeZaraz(
  host: string,
  firstPartyEndpoint: boolean,
  postData: string | null | undefined
): DecodedBeacon {
  const json = safeParseJson(postData);
  const events: string[] = [];
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const rec = json as Record<string, unknown>;
    const system = rec.system;
    if (system && typeof system === "object") events.push("page_view");
    const client = rec.client;
    if (client && typeof client === "object" && typeof (client as Record<string, unknown>).__zarazTrack === "string") {
      events.push(CUSTOM_EVENT_LABEL);
    }
  }
  if (events.length === 0) events.push("page_view");
  return {
    platform: "Cloudflare Zaraz",
    product: "Cloudflare Zaraz Server-Side Tagging",
    format: "cloudflare-zaraz",
    endpointHost: host,
    firstPartyEndpoint,
    serverSideTagging: true,
    events,
    scrollDepths: [],
    consentModeSignals: [],
    identifierCategories: [],
    complete: true
  };
}

// --- Shared helpers ---------------------------------------------------------

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function lookupIdentifierKey(key: string): IdentifierCategoryV3 | undefined {
  const lower = key.trim().toLowerCase();
  return Object.hasOwn(IDENTIFIER_KEY_MAP, lower) ? IDENTIFIER_KEY_MAP[lower] : undefined;
}

function extractIdentifiersFromParams(params: URLSearchParams): IdentifierCategoryV3[] {
  const ids = new Set<IdentifierCategoryV3>();
  for (const [key, value] of params) {
    if (!value.trim()) continue;
    const mapped = lookupIdentifierKey(key);
    if (mapped) ids.add(mapped);
  }
  return [...ids];
}

function extractIdentifiersFromObject(obj: unknown, out: Set<IdentifierCategoryV3>): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const mapped = lookupIdentifierKey(key);
    if (!mapped) continue;
    if (
      (typeof value === "string" && value.trim().length > 0) ||
      (Array.isArray(value) && value.length > 0)
    ) {
      out.add(mapped);
    }
  }
}

function looksLikeJson(body: string | null | undefined): boolean {
  if (!body) return false;
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function safeParseJson(body: string | null | undefined): unknown {
  if (!body || body.length > MAX_BEACON_BODY_CHARS || !looksLikeJson(body)) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().length > 0) return val;
  }
  return null;
}

function addUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

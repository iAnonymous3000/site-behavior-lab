/**
 * Privacy-safe product observability contract.
 *
 * This is intentionally not a generic analytics payload. Every emitted value
 * is selected from a closed vocabulary, unknown keys are rejected, and no
 * event can contain a URL, domain, report/job id, query string, evidence,
 * cookie, user/session id, timestamp, or arbitrary string.
 */

export const PRIVACY_SAFE_OBSERVABILITY_SCHEMA_VERSION = 1 as const;
export const PRIVACY_SAFE_OBSERVABILITY_PATH = "/api/metrics" as const;

export const ROUTE_CLASSES = [
  "home",
  "directory",
  "category",
  "site-profile",
  "report",
  "methodology",
  "privacy",
  "status",
  "security",
  "corrections",
  "catalog",
  "glossary",
  "other"
] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

const WEB_VITAL_NAMES = ["LCP", "INP", "CLS"] as const;
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];
const WEB_VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;
export type WebVitalRating = (typeof WEB_VITAL_RATINGS)[number];

const SCAN_SURFACES = ["home", "report", "site-profile"] as const;
export type ScanSurface = (typeof SCAN_SURFACES)[number];
const SCAN_STAGES = [
  "form-viewed",
  "existing-evidence-offered",
  "submission-started",
  "accepted",
  "completed",
  "failed",
  "cancelled"
] as const;
export type ScanStage = (typeof SCAN_STAGES)[number];
const SCAN_MODES = ["single", "gpc", "blocker", "consent"] as const;
export type ScanMode = (typeof SCAN_MODES)[number];
const DEVICE_CLASSES = ["desktop", "mobile"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

const SHARE_SURFACES = ["report", "site-profile", "category", "dataset"] as const;
export type ShareSurface = (typeof SHARE_SURFACES)[number];
const SHARE_CHANNELS = [
  "native",
  "copy-link",
  "copy-citation",
  "x",
  "bluesky",
  "linkedin",
  "mastodon",
  "reddit",
  "download-card"
] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];
const SHARE_OUTCOMES = ["attempted", "completed", "failed"] as const;
export type ShareOutcome = (typeof SHARE_OUTCOMES)[number];

const PROFILE_SOURCES = ["home", "directory", "category", "report", "search", "direct-or-other"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];
const PROFILE_ACTIONS = ["opened", "latest-evidence-opened", "history-opened", "feed-opened"] as const;
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];

const RESCAN_STAGES = ["offered", "started", "accepted", "completed", "failed"] as const;
export type RescanStage = (typeof RESCAN_STAGES)[number];

export type RouteViewEvent = {
  schemaVersion: 1;
  name: "route-view";
  route: RouteClass;
};

export type CoreWebVitalEvent = {
  schemaVersion: 1;
  name: "core-web-vital";
  route: RouteClass;
  metric: WebVitalName;
  rating: WebVitalRating;
};

export type ScanFunnelEvent = {
  schemaVersion: 1;
  name: "scan-funnel";
  surface: ScanSurface;
  stage: ScanStage;
  mode: ScanMode;
  device: DeviceClass;
};

export type ShareActionEvent = {
  schemaVersion: 1;
  name: "share-action";
  surface: ShareSurface;
  channel: ShareChannel;
  outcome: ShareOutcome;
};

export type ProfileActionEvent = {
  schemaVersion: 1;
  name: "profile-action";
  source: ProfileSource;
  action: ProfileAction;
};

export type RescanActionEvent = {
  schemaVersion: 1;
  name: "rescan-action";
  surface: "report" | "site-profile";
  stage: RescanStage;
  mode: ScanMode;
  device: DeviceClass;
};

export type PrivacySafeObservabilityEvent =
  | RouteViewEvent
  | CoreWebVitalEvent
  | ScanFunnelEvent
  | ShareActionEvent
  | ProfileActionEvent
  | RescanActionEvent;

const EVENT_NAMES = [
  "route-view",
  "core-web-vital",
  "scan-funnel",
  "share-action",
  "profile-action",
  "rescan-action"
] as const;
export type PrivacySafeEventName = (typeof EVENT_NAMES)[number];

/**
 * Parse an untrusted value without ever returning input-derived error text.
 * Returning `null` is deliberate: callers must drop invalid events silently.
 */
export function parsePrivacySafeObservabilityEvent(value: unknown): PrivacySafeObservabilityEvent | null {
  if (!isDataRecord(value) || value.schemaVersion !== PRIVACY_SAFE_OBSERVABILITY_SCHEMA_VERSION) return null;
  if (!oneOf(value.name, EVENT_NAMES)) return null;

  switch (value.name) {
    case "route-view":
      return exactKeys(value, ["schemaVersion", "name", "route"]) && oneOf(value.route, ROUTE_CLASSES)
        ? (value as RouteViewEvent)
        : null;
    case "core-web-vital":
      return exactKeys(value, ["schemaVersion", "name", "route", "metric", "rating"]) &&
        oneOf(value.route, ROUTE_CLASSES) &&
        oneOf(value.metric, WEB_VITAL_NAMES) &&
        oneOf(value.rating, WEB_VITAL_RATINGS)
        ? (value as CoreWebVitalEvent)
        : null;
    case "scan-funnel":
      return exactKeys(value, ["schemaVersion", "name", "surface", "stage", "mode", "device"]) &&
        oneOf(value.surface, SCAN_SURFACES) &&
        oneOf(value.stage, SCAN_STAGES) &&
        oneOf(value.mode, SCAN_MODES) &&
        oneOf(value.device, DEVICE_CLASSES)
        ? (value as ScanFunnelEvent)
        : null;
    case "share-action":
      return exactKeys(value, ["schemaVersion", "name", "surface", "channel", "outcome"]) &&
        oneOf(value.surface, SHARE_SURFACES) &&
        oneOf(value.channel, SHARE_CHANNELS) &&
        oneOf(value.outcome, SHARE_OUTCOMES)
        ? (value as ShareActionEvent)
        : null;
    case "profile-action":
      return exactKeys(value, ["schemaVersion", "name", "source", "action"]) &&
        oneOf(value.source, PROFILE_SOURCES) &&
        oneOf(value.action, PROFILE_ACTIONS)
        ? (value as ProfileActionEvent)
        : null;
    case "rescan-action":
      return exactKeys(value, ["schemaVersion", "name", "surface", "stage", "mode", "device"]) &&
        oneOf(value.surface, ["report", "site-profile"] as const) &&
        oneOf(value.stage, RESCAN_STAGES) &&
        oneOf(value.mode, SCAN_MODES) &&
        oneOf(value.device, DEVICE_CLASSES)
        ? (value as RescanActionEvent)
        : null;
  }
}

/** Convert any location to a bounded route class; dynamic segments disappear. */
export function routeClassFromLocation(value: string, basePath = ""): RouteClass {
  let pathname: string;
  try {
    pathname = new URL(value, "https://route.invalid").pathname;
  } catch {
    return "other";
  }

  const normalizedBase = normalizeBasePath(basePath);
  if (normalizedBase && (pathname === normalizedBase || pathname.startsWith(`${normalizedBase}/`))) {
    pathname = pathname.slice(normalizedBase.length) || "/";
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "home";
  if (segments[0] === "directory") return "directory";
  if (segments[0] === "categories" && segments.length >= 2) return "category";
  if (segments[0] === "sites" && segments.length >= 2) return "site-profile";
  if (segments[0] === "reports" && segments.length >= 2) return "report";
  if (segments[0] === "methodology") return "methodology";
  if (segments[0] === "privacy") return "privacy";
  if (segments[0] === "status") return "status";
  if (segments[0] === "security") return "security";
  if (segments[0] === "corrections") return "corrections";
  if (segments[0] === "catalog") return "catalog";
  if (segments[0] === "glossary") return "glossary";
  return "other";
}

export function routeViewEvent(route: RouteClass): RouteViewEvent {
  return { schemaVersion: 1, name: "route-view", route };
}

/**
 * Reduce a raw Web Vital to Google's three published quality bands. The raw
 * value is intentionally discarded and cannot enter the event contract.
 */
export function coreWebVitalEvent(
  route: RouteClass,
  metric: WebVitalName,
  rawValue: number
): CoreWebVitalEvent | null {
  if (!Number.isFinite(rawValue) || rawValue < 0) return null;
  const thresholds = metric === "LCP" ? [2_500, 4_000] : metric === "INP" ? [200, 500] : [0.1, 0.25];
  const rating: WebVitalRating =
    rawValue <= thresholds[0] ? "good" : rawValue <= thresholds[1] ? "needs-improvement" : "poor";
  return { schemaVersion: 1, name: "core-web-vital", route, metric, rating };
}

export function scanFunnelEvent(
  surface: ScanSurface,
  stage: ScanStage,
  mode: ScanMode,
  device: DeviceClass
): ScanFunnelEvent {
  return { schemaVersion: 1, name: "scan-funnel", surface, stage, mode, device };
}

export function shareActionEvent(
  surface: ShareSurface,
  channel: ShareChannel,
  outcome: ShareOutcome
): ShareActionEvent {
  return { schemaVersion: 1, name: "share-action", surface, channel, outcome };
}

export function profileActionEvent(source: ProfileSource, action: ProfileAction): ProfileActionEvent {
  return { schemaVersion: 1, name: "profile-action", source, action };
}

export function rescanActionEvent(
  surface: "report" | "site-profile",
  stage: RescanStage,
  mode: ScanMode,
  device: DeviceClass
): RescanActionEvent {
  return { schemaVersion: 1, name: "rescan-action", surface, stage, mode, device };
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && "value" in descriptor);
  });
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

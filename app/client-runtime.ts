import type { ReportRuntime } from "@/lib/report-locator";

/**
 * Build-time deployment flags and path helpers shared by the client components.
 *
 * The `process.env.NEXT_PUBLIC_*` reads must stay literal so Next inlines them
 * into the client bundle at build time. Kept in one module so the app shell and
 * the gallery components resolve runtime/report locations identically instead of
 * re-deriving them from scattered flags.
 */

export const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";
export const STATIC_BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH || "");
export const LIVE_SCAN_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE || "");
export const STATIC_LIVE_SCAN_ENABLED = STATIC_EXPORT && Boolean(LIVE_SCAN_API_BASE);
export const LIVE_SCAN_ENABLED = !STATIC_EXPORT || STATIC_LIVE_SCAN_ENABLED;
export const OPEN_ACCESS_SCANNER = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS === "1";
// Public Turnstile site key for the static scan UI. Required to satisfy a Worker
// that is deployed with TURNSTILE_SECRET_KEY set on a gated deployment.
export const LIVE_SCAN_TURNSTILE_SITE_KEY = (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY || "").trim();
const GITHUB_REPOSITORY = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_GITHUB_REPOSITORY || "";
export const SCAN_WORKFLOW_URL = GITHUB_REPOSITORY
  ? `https://github.com/${GITHUB_REPOSITORY}/actions/workflows/scan.yml`
  : null;

// Runtime context for resolving report locations from the browser build flags.
export function clientReportRuntime(): ReportRuntime {
  return {
    staticExport: STATIC_EXPORT,
    liveApiBacked: STATIC_LIVE_SCAN_ENABLED,
    basePath: STATIC_BASE_PATH,
    // A live-scanned report lives on the scan API's own origin, which serves a
    // working report page, so share permalinks resolve there.
    scanApiBase: LIVE_SCAN_API_BASE
  };
}

export function staticAssetPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${STATIC_BASE_PATH}${normalizedPath}`;
}

export function scannerApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return LIVE_SCAN_API_BASE ? `${LIVE_SCAN_API_BASE}${normalizedPath}` : normalizedPath;
}

function normalizeApiBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeBasePath(value: string): string {
  if (!value || value === "/") return "";
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

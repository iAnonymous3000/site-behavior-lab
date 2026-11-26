/**
 * Pure, client-safe URL and Turnstile request helpers for Site Behavior Lab v3.
 *
 * Keeps static GitHub Pages (`sitebehavior.org`) seamlessly wired to the live
 * Cloudflare Containers scanner origin (`scan.sitebehavior.org`), while keeping
 * same-origin deployments (`scan.sitebehavior.org` and local dev) relative.
 */

import type { ComparisonAxisV3, ScanDeviceV3, ScanRegionIdV3 } from "./schema";

export type V3ClientLocationConfig = {
  staticExport: boolean;
  scanApiBase: string;
  basePath?: string;
};

export type V3ScannerHealthSummary = {
  reachable: boolean;
  scansAvailable: boolean;
  authenticated: boolean;
  turnstileRequired: boolean;
};

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Resolve a v3 REST API path (`/api/...`) against an optional cross-origin scanner base. */
export function resolveV3ApiUrl(path: string, scanApiBase: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = ensureLeadingSlash(path);
  const base = normalizeBase(scanApiBase);
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

/**
 * Resolve a dynamic server-rendered v3 route (`/v3/reports/:id`, `/v3/sites/:domain`).
 * Static GitHub Pages excludes these dynamic routes, so they target the live
 * scanner origin when `staticExport` and `scanApiBase` are both active.
 */
export function resolveV3DynamicPageUrl(path: string, config: V3ClientLocationConfig): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = ensureLeadingSlash(path);
  const base = normalizeBase(config.scanApiBase);
  if (config.staticExport && base) {
    return `${base}${normalizedPath}`;
  }
  return normalizedPath;
}

/** Resolve a static v3 route (`/`, `/v3/explorer/`, `/v3/catalog/`) with optional basePath. */
export function resolveV3StaticPageUrl(path: string, basePath = ""): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = ensureLeadingSlash(path);
  const prefix = basePath && basePath !== "/" ? ensureLeadingSlash(basePath).replace(/\/+$/, "") : "";
  return `${prefix}${normalizedPath}`;
}

/** Build fetch headers for `POST /api/v3/scan`, forwarding Turnstile & access tokens when present. */
export function buildV3ScanHeaders(options: {
  turnstileToken?: string;
  accessToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  const turnstile = options.turnstileToken?.trim();
  if (turnstile) {
    headers["cf-turnstile-response"] = turnstile;
  }
  const access = options.accessToken?.trim();
  if (access) {
    headers["x-site-behavior-lab-access-token"] = access;
  }
  return headers;
}

/** Build JSON payload for `POST /api/v3/scan`. */
export function buildV3ScanBody(options: {
  url: string;
  device: ScanDeviceV3;
  region: ScanRegionIdV3;
  comparisons: readonly ComparisonAxisV3[];
  turnstileToken?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    url: options.url.trim(),
    device: options.device,
    region: options.region,
    comparisons: [...options.comparisons]
  };
  const turnstile = options.turnstileToken?.trim();
  if (turnstile) {
    body.turnstileToken = turnstile;
  }
  return body;
}

/** Parse `/api/health` into v3 client gating posture. */
export function parseV3ScannerHealth(payload: unknown): V3ScannerHealthSummary {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      reachable: false,
      scansAvailable: false,
      authenticated: false,
      turnstileRequired: false
    };
  }
  const obj = payload as Record<string, unknown>;
  return {
    reachable: obj.ok === true,
    scansAvailable: obj.scansAvailable !== false,
    authenticated: obj.authenticated === true,
    turnstileRequired: obj.turnstile === true
  };
}

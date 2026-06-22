import { REPORT_ID_PATTERN } from "./report-validation";
import type { ReportShare } from "./types";

/**
 * Single source of truth for where a saved report lives and how to reach it.
 *
 * A persisted `ReportShare` only records the report id and the canonical
 * origin-relative paths. What those paths *mean* depends on the runtime that
 * serves them, which is why every consumer previously re-derived locations from
 * scattered `STATIC_EXPORT` / live-API flags. This module centralizes both the
 * write-time path scheme (`buildReportShare`) and the read-time resolution
 * (`locateReport`) so Node, the Cloudflare Worker, and the static export cannot
 * drift apart again.
 *
 * It must stay free of Node and browser APIs so every runtime can import it (see
 * `runtime-boundaries.test.ts`).
 */

const REPORT_PAGE_PREFIX = "/reports";
const REPORT_API_PREFIX = "/api/reports";

export type ReportBackend =
  // Served by the Node app: HTML permalink plus `/api/reports/:id` JSON route.
  | "node-api"
  // Served by the static export: prerendered page plus committed `:id.json`.
  | "static-file"
  // Static export fronting a live scan API that serves its own report pages (it
  // runs the full Node app), so the permalink points at the scan API origin.
  | "live-api"
  // Static export fronting a live scan API, but no permalink can be offered:
  // either no scan API origin is known, or that API is JSON-only (e.g. the
  // Browser Run Worker) and has no `/reports/:id` page to link to.
  | "live-api-unshareable";

export type ReportRuntime = {
  /** The build targets a static export (GitHub Pages). */
  staticExport: boolean;
  /** A static export whose live scans are backed by an external scan API. */
  liveApiBacked: boolean;
  /** Optional project base path applied to static asset URLs. */
  basePath: string;
  /**
   * Absolute origin of the live scan API (scheme + host, no trailing slash),
   * when `liveApiBacked`. A freshly scanned report only exists behind this
   * origin, which serves its own report page, so its permalink lives there.
   */
  scanApiBase?: string;
  /**
   * Whether the live scan API serves human-viewable `/reports/:id` pages (the
   * full Node app / container does; the API-only Browser Run Worker does not).
   * Sourced from the scan API's health `capabilities.savedReportPages`. When
   * false, a fresh live-API report has no permalink to share.
   */
  liveApiServesReportPages?: boolean;
};

export type ReportLocator = {
  id: string;
  backend: ReportBackend;
  /** Origin-relative permalink to navigate to or share, or null when none is servable. */
  pagePath: string | null;
  /** Origin-relative URL to fetch the report JSON from. */
  dataUrl: string;
};

/** Canonical origin-relative permalink for a report id. */
export function reportPagePath(id: string): string {
  return `${REPORT_PAGE_PREFIX}/${id}`;
}

/** Canonical origin-relative JSON API path for a report id. */
function reportApiPath(id: string): string {
  return `${REPORT_API_PREFIX}/${id}`;
}

/**
 * Build the `ReportShare` persisted alongside a saved report. Shared by every
 * producer so the stored path scheme has exactly one definition.
 */
export function buildReportShare(id: string): ReportShare {
  if (!REPORT_ID_PATTERN.test(id)) {
    throw new Error("Invalid report share id.");
  }

  return {
    id,
    path: reportPagePath(id),
    jsonPath: reportApiPath(id)
  };
}

/**
 * Resolve a report that is known to exist as a committed/served artifact: the
 * static gallery and directory entries, the prerendered permalink, and Node FS
 * reports. Unlike `locateReport`, these always have a servable page, because a
 * committed report is addressable even on a static export that also fronts a
 * live scan API.
 */
export function committedReportLocation(id: string, runtime: ReportRuntime): {
  backend: ReportBackend;
  pagePath: string;
  dataUrl: string;
} {
  if (!runtime.staticExport) {
    return { backend: "node-api", pagePath: reportPagePath(id), dataUrl: reportApiPath(id) };
  }

  return {
    backend: "static-file",
    pagePath: staticPath(`${reportPagePath(id)}/`, runtime.basePath),
    dataUrl: staticPath(`${reportPagePath(id)}.json`, runtime.basePath)
  };
}

/** Resolve how to reach a freshly produced (possibly live-API-only) report from a given runtime. */
export function locateReport(id: string, runtime: ReportRuntime): ReportLocator {
  if (!runtime.staticExport) {
    return {
      id,
      backend: "node-api",
      pagePath: reportPagePath(id),
      dataUrl: reportApiPath(id)
    };
  }

  if (runtime.liveApiBacked) {
    // A freshly scanned report only lives behind the scan API. Share a permalink
    // there only when that API serves its own report pages (the full Node app /
    // container). An API-only producer like the Browser Run Worker has no
    // `/reports/:id` page, so linking there 404s — withhold the permalink.
    const apiBase = trimTrailingSlash(runtime.scanApiBase ?? "");
    if (apiBase && runtime.liveApiServesReportPages) {
      return {
        id,
        backend: "live-api",
        pagePath: `${apiBase}${reportPagePath(id)}`,
        dataUrl: `${apiBase}${reportApiPath(id)}`
      };
    }
    // No servable report page: never advertise a link the origin cannot render.
    return {
      id,
      backend: "live-api-unshareable",
      pagePath: null,
      dataUrl: apiBase ? `${apiBase}${reportApiPath(id)}` : staticPath(`${reportPagePath(id)}.json`, runtime.basePath)
    };
  }

  return {
    id,
    backend: "static-file",
    pagePath: staticPath(`${reportPagePath(id)}/`, runtime.basePath),
    dataUrl: staticPath(`${reportPagePath(id)}.json`, runtime.basePath)
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function staticPath(pathname: string, basePath: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${basePath}${normalizedPath}`;
}

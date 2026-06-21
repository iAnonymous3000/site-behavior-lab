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
  // Static export fronting a live scan API: a fresh report only lives behind the
  // API, so the static site has no permalink it can load for it.
  | "live-api-unshareable";

export type ReportRuntime = {
  /** The build targets a static export (GitHub Pages). */
  staticExport: boolean;
  /** A static export whose live scans are backed by an external scan API. */
  liveApiBacked: boolean;
  /** Optional project base path applied to static asset URLs. */
  basePath: string;
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

  // Static export: the JSON is always fetched from the committed static file.
  const dataUrl = staticPath(`${reportPagePath(id)}.json`, runtime.basePath);

  if (runtime.liveApiBacked) {
    // The report may only exist behind the live API, which the static page
    // cannot load, so there is no permalink safe to advertise for it.
    return { id, backend: "live-api-unshareable", pagePath: null, dataUrl };
  }

  return {
    id,
    backend: "static-file",
    pagePath: staticPath(`${reportPagePath(id)}/`, runtime.basePath),
    dataUrl
  };
}

function staticPath(pathname: string, basePath: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${basePath}${normalizedPath}`;
}

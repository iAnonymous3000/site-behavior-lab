import { scanCorsHeaders } from "@/lib/cors";

// Node-lane glue around the pure `scanCorsHeaders` contract: it reads the
// configured allowed origin from the environment and applies CORS to the scan
// API responses. Lives under `app/api` (not `lib/`) so the GitHub Pages build
// strips it with the rest of the server-only API and the Worker never imports a
// `process.env` reader. This is a colocated module, not a route (no `route.ts`).
const ALLOWED_ORIGIN_ENV = "SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN";

function corsForRequest(request: Request): Record<string, string> {
  return scanCorsHeaders(request.headers.get("origin"), process.env[ALLOWED_ORIGIN_ENV]);
}

/** CORS preflight (`OPTIONS`) response shared by every scan API route. */
export function corsPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsForRequest(request) });
}

/**
 * Merge the scan CORS headers onto a response so cross-origin browser callers
 * (the static GitHub Pages UI pointed at a Node container) can read it. Applied
 * once at each route's exit so success and error responses are both covered.
 */
export function withScanCors(request: Request, response: Response): Response {
  for (const [key, value] of Object.entries(corsForRequest(request))) {
    response.headers.set(key, value);
  }
  return response;
}

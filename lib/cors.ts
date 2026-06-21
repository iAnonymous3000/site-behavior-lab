import { SCAN_TOKEN_REQUEST_HEADERS } from "./scan-token";

/**
 * Single definition of the scan API CORS contract, shared by the Node API routes
 * and the Cloudflare Worker so the allowed methods/headers and the allow-origin
 * logic cannot drift apart (the same reason the token transport is centralized in
 * `scan-token.ts`).
 *
 * Pure by construction: it takes the request origin and the configured allowed
 * origin as arguments and reads no runtime globals (`process.env` / Worker `env`),
 * so it is safe to import from the Node, Worker, or browser lane. Callers supply
 * the configured origin from their own runtime.
 */
const CORS_ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "cf-turnstile-response",
  ...SCAN_TOKEN_REQUEST_HEADERS
] as const;

/**
 * Echo the caller's origin only when it is allowed. `*` (the default) allows any
 * origin; a configured origin is echoed when it matches and otherwise denied with
 * the non-matching sentinel `"null"`. The scan API uses no cookies, so `*` is a
 * safe default for a public scanner — operators tighten it via the configured
 * origin when they want to restrict which sites may call the scanner from a browser.
 */
export function resolveAllowedOrigin(requestOrigin: string | null, configuredOrigin: string | undefined): string {
  const allowed = configuredOrigin?.trim() || "*";
  const origin = requestOrigin || "*";
  return allowed === "*" || allowed === origin ? allowed : "null";
}

export function scanCorsHeaders(
  requestOrigin: string | null,
  configuredOrigin: string | undefined
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(requestOrigin, configuredOrigin),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

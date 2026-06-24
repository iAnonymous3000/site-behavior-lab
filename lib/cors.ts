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
 * origin; a configured origin is echoed when it matches and otherwise denied by
 * returning `null` so the caller omits `Access-Control-Allow-Origin` entirely.
 *
 * Denials must NOT emit the literal string `"null"`: a browser request from an
 * opaque origin (sandboxed document, `data:`/`blob:` URL, `file:` page) sends
 * `Origin: null`, and echoing `Access-Control-Allow-Origin: null` would let that
 * opaque origin read the response, bypassing the configured single-origin
 * allowlist. Omitting the header instead fails the CORS check closed.
 *
 * The scan API uses no cookies, so `*` is a safe default for a public scanner;
 * operators tighten it via the configured origin when they want to restrict which
 * sites may call the scanner from a browser.
 */
export function resolveAllowedOrigin(requestOrigin: string | null, configuredOrigin: string | undefined): string | null {
  const allowed = configuredOrigin?.trim() || "*";
  if (allowed === "*") return "*";
  return requestOrigin && allowed === requestOrigin ? allowed : null;
}

export function scanCorsHeaders(
  requestOrigin: string | null,
  configuredOrigin: string | undefined
): Record<string, string> {
  const allowOrigin = resolveAllowedOrigin(requestOrigin, configuredOrigin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
  // Omit Access-Control-Allow-Origin on a denial so opaque (`Origin: null`)
  // callers cannot match a `"null"` sentinel and read the response.
  if (allowOrigin !== null) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }
  return headers;
}

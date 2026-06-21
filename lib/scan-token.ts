/**
 * Single definition of how a scan access token is carried on a request, shared
 * by the Node API and the Cloudflare Worker so the accepted transports cannot
 * drift apart again.
 *
 * Accepted transports (in precedence order):
 *   1. `Authorization: Bearer <token>`            (documented)
 *   2. `x-site-behavior-lab-access-token: <token>` (documented)
 *   3. `x-sbl-scan-token: <token>`                 (legacy Worker clients)
 *
 * Typed against `Headers` (a Web standard available in both runtimes) so the
 * module stays free of Node/Worker-specific APIs.
 */

export const SCAN_ACCESS_TOKEN_HEADER = "x-site-behavior-lab-access-token";
export const LEGACY_WORKER_SCAN_TOKEN_HEADER = "x-sbl-scan-token";

/** All non-standard request headers that may carry a scan token, for CORS allow-lists. */
export const SCAN_TOKEN_REQUEST_HEADERS = [SCAN_ACCESS_TOKEN_HEADER, LEGACY_WORKER_SCAN_TOKEN_HEADER] as const;

export function scanTokenFromHeaders(headers: Headers): string {
  const authorization = headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const accessTokenHeader = headers.get(SCAN_ACCESS_TOKEN_HEADER)?.trim() || "";
  const legacyHeader = headers.get(LEGACY_WORKER_SCAN_TOKEN_HEADER)?.trim() || "";
  return bearer || accessTokenHeader || legacyHeader;
}

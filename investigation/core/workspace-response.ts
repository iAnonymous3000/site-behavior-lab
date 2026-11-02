// What every response the workspace makes carries, built in one place, so the gate's refusals
// and the viewer's pages cannot drift apart.
//
// No response runs script: the policy names no script source, so nothing inline or fetched can
// execute, and there is no 'unsafe-inline' or 'unsafe-eval' for anything. A form may post only
// to this origin, no page may be framed, and no base element can move a relative link. The one
// stylesheet is inline and allowed by its hash alone, so a style element anywhere else in a page,
// such as one a captured script tried to carry, applies nothing. No page has a style attribute,
// since a hash does not allow one.
//
// Referrer-Policy is same-origin, not no-referrer. Under no-referrer Chromium sends the owner's
// own form posts with `Origin: null`, by the Fetch standard's rule for a request whose referrer
// policy is no-referrer, and the gate then refuses every write. Under same-origin a request to
// another origin carries no referrer at all, and no page links or fetches off this origin:
// captured addresses are text, never links.

/** The policy every response carries. A page adds its style source to it, and nothing else. */
export const BASE_POLICY = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The viewer's one stylesheet, allowed by the hash below. investigation/test/viewer.test.ts recomputes it. */
export const VIEWER_STYLE = [
  ":root{color-scheme:light dark;--fg:#1b1d21;--bg:#fff;--muted:#575d66;--line:#cfd4dc;--panel:#f3f5f8;--flag:#8a3b00;--mark:#6f1f8f}",
  "@media (prefers-color-scheme:dark){:root{--fg:#e6e8eb;--bg:#15171a;--muted:#a7adb6;--line:#3a3f47;--panel:#1f2226;--flag:#ffb070;--mark:#e3a6ff}}",
  "body{margin:0 auto;max-width:76rem;padding:1rem;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}",
  "header,section,aside{margin:0 0 1.25rem}",
  "nav a{margin-right:1rem}",
  "h1{font-size:1.4rem;margin:.25rem 0}",
  "h2{font-size:1.15rem;margin:1.25rem 0 .5rem;border-bottom:1px solid var(--line)}",
  "h3{font-size:1rem;margin:1rem 0 .25rem}",
  "table{border-collapse:collapse;width:100%;margin:.5rem 0}",
  "th,td{border:1px solid var(--line);padding:.3rem .5rem;text-align:left;vertical-align:top}",
  "th{background:var(--panel)}",
  "code,pre,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}",
  "td code{overflow-wrap:anywhere;word-break:break-all}",
  "pre,.text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;unicode-bidi:bidi-override;direction:ltr;contain:paint}",
  "pre{background:var(--panel);border:1px solid var(--line);padding:.75rem;margin:.5rem 0}",
  ".ctl{color:var(--mark);border:1px solid var(--mark);border-radius:3px;padding:0 2px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8em}",
  ".note,.muted{color:var(--muted)}",
  ".flag{color:var(--flag);font-weight:600}",
  ".banner{border:2px solid var(--flag);padding:.75rem;margin:0 0 1rem}",
  ".limits{margin:0;padding-left:1.25rem}",
  "aside{border:1px solid var(--line);background:var(--panel);padding:.75rem}",
  "form{border:1px solid var(--line);padding:.75rem;margin:.5rem 0}",
  "label{display:block;margin:.35rem 0}",
  "input[type=text],textarea{width:100%;box-sizing:border-box;font:inherit}",
  "textarea{min-height:4rem}",
  "fieldset{border:1px solid var(--line);margin:.5rem 0}"
].join("\n");

/** The base64 SHA-256 of VIEWER_STYLE, as a CSP source. */
export const VIEWER_STYLE_HASH = "sha256-s9WWesSyZBw6seA3bzaIMksMsPV+/0QCj3zxfhXpf5Y=";

export type ResponseKind = "json" | "html";

/** The headers every response carries, for its kind. */
export function responseHeaders(kind: ResponseKind): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": kind === "html" ? `${BASE_POLICY}; style-src '${VIEWER_STYLE_HASH}'` : BASE_POLICY,
    "content-type": kind === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    // No page of another origin keeps a handle on a window of this one, and none may load a
    // response of this one into itself, as an image, a script or anything else.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff"
  };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...responseHeaders("json"), ...headers } });
}

export function htmlResponse(status: number, document: string, headers: Record<string, string> = {}): Response {
  return new Response(document, { status, headers: { ...responseHeaders("html"), ...headers } });
}

/**
 * A refused request learns nothing of why, not even that its token was genuine. An outage
 * answers differently, and so does a write from another origin, which only a browser carrying
 * the owner's credential to a page off this origin would send.
 */
export function refusalResponse(status: 401 | 403 | 503): Response {
  return jsonResponse(status, { error: status === 503 ? "unavailable" : status === 403 ? "origin-refused" : "access-refused" });
}

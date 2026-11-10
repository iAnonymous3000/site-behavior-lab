import { edgeClientIdentity } from "./client-identity";
import { scanCorsHeaders } from "./cors";
import { REPORT_ID_PATTERN } from "./report-validation";
import { sha256Hex } from "./sha256";

export const REPORT_READ_RATE_LIMIT_PER_MINUTE = 120;
export const REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE = 1_200;

// The two API routes, the report JSON (`/api/reports/:id`) and the PDF
// (`/api/reports/:id/pdf`), each have a per-client bucket of their own and
// share one world bucket.
//
// The JSON's per-client figure is the one Node already applies to the same
// route (REPORT_READ_RATE_LIMIT_MAX in lib/scan-limits.ts): a fixed minute at
// the edge refuses nothing Node's rolling minute would have admitted. The
// PDF's mirrors Node's render allowance (REPORT_PDF_RATE_LIMIT_MAX there). It
// counts requests, where Node counts renders: Node charges its allowance only
// once a render is going to start, and the edge cannot know that, so a request
// that ends in 404, 409 or 422 spends an edge token and no Node token.
export const REPORT_JSON_READ_RATE_LIMIT_PER_MINUTE = 120;
export const REPORT_PDF_EDGE_RATE_LIMIT_PER_MINUTE = 10;

// The world figure for API report reads as a whole is the page's figure, on
// this ground: a JSON read does part of a page read's work (the same stored
// report lookup, with no render after it), so a rate the container already
// takes for pages is not too high for it. Nothing in the repository measures
// how many reads the container can serve, so no larger figure has a basis.
//
// The PDF has no world bucket of its own, and each PDF request spends one unit
// of this one. The edge cannot tell which PDF requests will render. A world
// figure small enough to describe the one render slot would be spent by
// requests that never render, and a few addresses could use it up with
// well-formed requests and deny the PDF to everyone. The slot, not the edge,
// bounds renders: the container holds one (MAX_CONCURRENT_REPORT_PDF_RENDERS),
// keeps no queue, and answers a request that finds the slot taken at once. A
// PDF request that does not get the slot costs the container about what a
// JSON read costs, the report lookup and then a refusal, so the bucket that
// bounds JSON reads for the world bounds those requests too.
export const REPORT_API_READ_GLOBAL_RATE_LIMIT_PER_MINUTE = 1_200;

/**
 * The three edge quotas a report read can spend. The name is the namespace of
 * the quota's per-client bucket in the Durable Object's store, so
 * "report-read" must keep its spelling.
 *
 * They are separate because the requests are separate. Opening a report page
 * and then its evidence explorer is one page read and one JSON read; one
 * shared bucket would halve what a reader can open. A PDF can take the single
 * render slot, so one client must not be admitted to it at the rate of a byte
 * read.
 */
export type PublicReportReadQuota = "report-read" | "report-json-read" | "report-pdf";

/**
 * The world buckets, by namespace: the pages' own, which must keep its
 * spelling too, and the one the two API routes share. Each has one limit,
 * stated here and nowhere else, so two quotas that share a bucket cannot hold
 * it to two figures.
 */
export type PublicReportWorldBucket = "report-read" | "report-api-read";

export const PUBLIC_REPORT_WORLD_LIMITS: Readonly<Record<PublicReportWorldBucket, number>> = Object.freeze({
  "report-read": REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  "report-api-read": REPORT_API_READ_GLOBAL_RATE_LIMIT_PER_MINUTE
});

export const PUBLIC_REPORT_READ_QUOTAS: Readonly<
  Record<PublicReportReadQuota, Readonly<{ perClient: number; world: PublicReportWorldBucket }>>
> = Object.freeze({
  "report-read": Object.freeze({ perClient: REPORT_READ_RATE_LIMIT_PER_MINUTE, world: "report-read" }),
  "report-json-read": Object.freeze({ perClient: REPORT_JSON_READ_RATE_LIMIT_PER_MINUTE, world: "report-api-read" }),
  "report-pdf": Object.freeze({ perClient: REPORT_PDF_EDGE_RATE_LIMIT_PER_MINUTE, world: "report-api-read" })
});

/**
 * The limiter's answer for one report read. A refusal names the bucket that
 * refused: "world" when the world bucket was spent, whether or not the
 * client's own was too, and "client" when only the client's own was. The name
 * is optional because a Durable Object one release older, still answering
 * while a deployment replaces it, gives none.
 */
export type PublicReportReadDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; refusedBy?: "client" | "world" };

// The only methods that read a report. Stated once, here, because the charge
// (which methods count as a read) and the refusal below (which methods are
// turned away) must never disagree about the same request.
const PUBLIC_REPORT_READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
export const PUBLIC_REPORT_READ_ALLOW_HEADER = [...PUBLIC_REPORT_READ_METHODS].join(", ");
// The two API routes also answer a CORS preflight, so their Allow list names it.
export const PUBLIC_REPORT_API_ALLOW_HEADER = [...PUBLIC_REPORT_READ_METHODS, "OPTIONS"].join(", ");

export type PublicReportReadPath = Readonly<{
  reportId: string;
  resource: "page" | "opengraph-image" | "twitter-image" | "print" | "json" | "pdf";
  quota: PublicReportReadQuota;
}>;

type ReportRouteFamily = "page" | "api";

/**
 * Which report route family a path is under, and the segments after the
 * family's root: `/reports/...` (pages) or `/api/reports/...` (the JSON and
 * the PDF). The charge and the method rule both start here, so neither can
 * place a path in a family the other does not. Root segments are decoded the
 * way the rest are, so an encoded spelling lands in the same family as the
 * plain one.
 */
function splitReportRoute(pathname: string): { family: ReportRouteFamily; rest: string[] } | null {
  const raw = pathname.split("/");
  const first = raw[1] === undefined ? null : decodePathSegment(raw[1]);
  if (first === "reports") return { family: "page", rest: raw.slice(2) };
  if (first === "api" && raw[2] !== undefined && decodePathSegment(raw[2]) === "reports") {
    return { family: "api", rest: raw.slice(3) };
  }
  return null;
}

/**
 * Recognize every public report representation that can reach report storage
 * or server-side rendering, and name the quota it spends. This is the one
 * matcher for report reads: the pages under `/reports/:id` and the two API
 * routes under `/api/reports/:id`. The canonical report-id validator is shared
 * with every report producer/reader so the edge cannot drift from the Node
 * route. A path with any other id is not a read: Node answers it 404 without
 * touching the store, so it is forwarded uncharged.
 *
 * `print` is charged as one page read like the others. It is the heaviest of
 * them (the complete evidence rendered eagerly), but the quota's job is to
 * bound the request rate a client and the world can put on the container, and
 * nobody has measured what a print render costs relative to a page render; a
 * weight would be a number invented to look precise.
 *
 * The JSON and the PDF were once left to Node, which meters them per client
 * only. Nothing then bounded what the world could put on the container through
 * those two paths, so each now has its own per-client quota here as well, and
 * the two share a world bucket. The PDF renderer reads the print page over
 * loopback inside the container, which never crosses this edge, so a PDF is
 * not charged a page read on top.
 */
export function parsePublicReportReadPath(method: string, pathname: string): PublicReportReadPath | null {
  if (!PUBLIC_REPORT_READ_METHODS.has(method)) return null;
  const route = splitReportRoute(pathname);
  if (!route) return null;
  const rawSegments = [...route.rest];
  if (rawSegments.at(-1) === "") rawSegments.pop();
  if (rawSegments.length !== 1 && rawSegments.length !== 2) return null;
  const segments = rawSegments.map(decodePathSegment);
  if (segments.some((segment) => segment === null)) return null;
  const [reportId, routeResource] = segments as string[];
  if (!REPORT_ID_PATTERN.test(reportId)) return null;
  if (route.family === "api") {
    if (routeResource === undefined) return { reportId, resource: "json", quota: "report-json-read" };
    if (routeResource === "pdf") return { reportId, resource: "pdf", quota: "report-pdf" };
    return null;
  }
  if (
    routeResource !== undefined &&
    routeResource !== "opengraph-image" &&
    routeResource !== "twitter-image" &&
    routeResource !== "print"
  ) {
    return null;
  }
  const resource = routeResource ?? "page";
  return {
    reportId,
    resource,
    quota: "report-read"
  };
}

/**
 * True when the request is on a public report route with a method that is not
 * a read. Next renders a page for every method: a POST, PUT or PATCH that
 * carries no server-action marker falls through to the ordinary render, so
 * forwarding one would buy the full report read and render with the read quota
 * never consulted. Nothing writes to a report route, so the edge answers these
 * itself instead of forwarding them. Node's two API routes would turn such a
 * method away on their own; the edge answers for them as well, so the rule for
 * every report path is one rule, stated here. The root segments are decoded
 * the way the charge decodes them, so an encoded spelling cannot reach a
 * render the plain spelling is refused.
 */
export function refusePublicReportRouteMethod(method: string, pathname: string): boolean {
  if (PUBLIC_REPORT_READ_METHODS.has(method)) return false;
  return splitReportRoute(pathname) !== null;
}

/**
 * The edge's whole answer for a report route, or null when the request goes on
 * to the container.
 *
 * Only the Worker's public fetch path calls this. The reads the Worker makes
 * for itself (a finished job's saved report, fetched with forwardToContainer)
 * and the PDF renderer's loopback read of the print page do not pass through
 * it, so they spend no reader's quota and cannot be refused by it.
 *
 * A non-read method is answered first and spends nothing. A read is charged in
 * the quota its path names: one unit of that quota's per-client bucket and
 * one of its world bucket, or neither. A charge that cannot be made is
 * refused, not waved through: a limiter that fails open is no bound at all.
 *
 * Answers on the API routes carry the scan API's CORS headers, as Node's own
 * answers on those routes do. The static site reads a fresh report from this
 * origin, and without the headers a browser would report a refusal as a
 * failed fetch instead of the 429 it is.
 */
export async function enforcePublicReportRouteEdge(
  request: Request,
  allowedOrigin: string | undefined,
  charge: (input: { clientHash: string; quota: PublicReportReadQuota }) => Promise<PublicReportReadDecision>
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const family = splitReportRoute(pathname)?.family;
  const corsHeaders =
    family === "api" ? scanCorsHeaders(request.headers.get("origin"), allowedOrigin) : {};

  if (refusePublicReportRouteMethod(request.method, pathname)) {
    if (family === "api" && request.method === "OPTIONS") {
      // The preflight Node's routes give for these paths, from the same header
      // contract, so a cross-origin read keeps working without a container hop.
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    return reportRouteMethodNotAllowedResponse(
      family === "api" ? PUBLIC_REPORT_API_ALLOW_HEADER : PUBLIC_REPORT_READ_ALLOW_HEADER,
      corsHeaders
    );
  }

  const read = parsePublicReportReadPath(request.method, pathname);
  if (!read) return null;

  let decision: PublicReportReadDecision;
  try {
    // The shared edge identity: Cloudflare's client address only, an IPv6
    // client keyed on its /64, and never a caller-controlled header.
    const clientHash = await sha256Hex(edgeClientIdentity(request.headers));
    decision = await charge({ clientHash, quota: read.quota });
  } catch (error) {
    console.error("Could not charge the public report-read quota.", error);
    return reportReadGateResponse(503, "Report reads are temporarily unavailable.", 5, corsHeaders);
  }
  if (decision.allowed) return null;
  return reportReadGateResponse(
    429,
    // Node's own sentences for the same refusals (lib/scan-limits.ts), so a
    // reader is told the same thing whichever limiter turned them away. The
    // PDF's sentence is said only when the PDF's own per-client bucket
    // refused. The world bucket is shared with the JSON, so a refusal there
    // may have nothing to do with PDFs, and the answer for it is the sentence
    // that is true of both routes. So is the answer to a refusal that does
    // not name its bucket.
    read.quota === "report-pdf" && decision.refusedBy === "client"
      ? "Too many PDF requests. Print the page from your browser, or try again shortly."
      : "Too many report requests. Try again shortly.",
    decision.retryAfterSeconds,
    corsHeaders
  );
}

function reportReadGateResponse(
  status: 429 | 503,
  message: string,
  retryAfterSeconds: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      ...corsHeaders,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, noarchive"
    }
  });
}

function reportRouteMethodNotAllowedResponse(allow: string, corsHeaders: Record<string, string>): Response {
  // The message and the Allow header name the same list.
  const error = `Reports are read-only. Allowed methods: ${allow}.`;
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 405,
    headers: {
      ...corsHeaders,
      allow,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, noarchive"
    }
  });
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    // Next decodes route segments but does not treat an encoded slash as a
    // segment boundary. Reject it explicitly so edge and application routing
    // can never disagree about the canonical resource being charged.
    return decoded.includes("/") ? null : decoded;
  } catch {
    return null;
  }
}

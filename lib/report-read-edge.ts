import { REPORT_ID_PATTERN } from "./report-validation";

export const REPORT_READ_RATE_LIMIT_PER_MINUTE = 120;
export const REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE = 1_200;

// The only methods that read a report. Stated once, here, because the charge
// (which methods count as a read) and the refusal below (which methods are
// turned away) must never disagree about the same request.
const PUBLIC_REPORT_READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
export const PUBLIC_REPORT_READ_ALLOW_HEADER = [...PUBLIC_REPORT_READ_METHODS].join(", ");

export type PublicReportReadPath = Readonly<{
  reportId: string;
  resource: "page" | "opengraph-image" | "twitter-image" | "print";
}>;

/**
 * Recognize only public report representations that can reach report storage or
 * server-side rendering. The canonical report-id validator is shared with every
 * report producer/reader so the edge cannot drift from the Node route.
 *
 * `print` is charged as one read like the others. It is the heaviest of them
 * (the complete evidence rendered eagerly, where the page defers its evidence
 * to a client fetch of the JSON that Node meters on its own), but the quota's
 * job is to bound the request rate a client and the world can put on the
 * container, and nobody has measured what a print render costs relative to a
 * page render; a weight would be a number invented to look precise. The PDF,
 * which is the genuinely expensive rendering, has its own Node-side bucket,
 * and it reaches this route over loopback, so it is not charged here twice.
 */
export function parsePublicReportReadPath(method: string, pathname: string): PublicReportReadPath | null {
  if (!PUBLIC_REPORT_READ_METHODS.has(method)) return null;
  const rawSegments = pathname.split("/");
  if (rawSegments.at(-1) === "") rawSegments.pop();
  if (rawSegments.length !== 3 && rawSegments.length !== 4) return null;
  const segments = rawSegments.map(decodePathSegment);
  if (segments.some((segment) => segment === null)) return null;
  const [, root, reportId, routeResource] = segments as string[];
  if (root !== "reports" || !REPORT_ID_PATTERN.test(reportId)) return null;
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
    resource
  };
}

/**
 * True when the request is on a public report route with a method that is not
 * a read. Next renders a page for every method: a POST, PUT or PATCH that
 * carries no server-action marker falls through to the ordinary render, so
 * forwarding one would buy the full report read and render with the read quota
 * never consulted. Nothing writes to /reports/*, so the edge answers these
 * itself instead of forwarding them. The first segment is decoded the way the
 * charge decodes it, so an encoded spelling cannot reach a render the plain
 * spelling is refused.
 */
export function refusePublicReportRouteMethod(method: string, pathname: string): boolean {
  if (PUBLIC_REPORT_READ_METHODS.has(method)) return false;
  const [, root] = pathname.split("/");
  return root !== undefined && decodePathSegment(root) === "reports";
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

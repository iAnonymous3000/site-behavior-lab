import { REPORT_ID_PATTERN } from "./report-validation";

export const REPORT_READ_RATE_LIMIT_PER_MINUTE = 120;
export const REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE = 1_200;

export type PublicReportReadPath = Readonly<{
  reportId: string;
  resource: "page" | "opengraph-image" | "twitter-image";
}>;

/**
 * Recognize only public report representations that can reach report storage or
 * server-side image rendering. The canonical report-id validator is shared with
 * every report producer/reader so the edge cannot drift from the Node route.
 */
export function parsePublicReportReadPath(method: string, pathname: string): PublicReportReadPath | null {
  if (method !== "GET" && method !== "HEAD") return null;
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
    routeResource !== "twitter-image"
  ) {
    return null;
  }
  const resource = routeResource ?? "page";
  return {
    reportId,
    resource
  };
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

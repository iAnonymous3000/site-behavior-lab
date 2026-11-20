/**
 * One URL path segment as Next routes it: percent-decoded, with an encoded
 * slash refused because Next does not treat it as a segment boundary. Null for
 * a segment that cannot be decoded or holds an encoded slash.
 *
 * The edge's charges and refusals key on this reading so that the Worker and
 * the application can never disagree about which resource a path names: the
 * report routes (lib/report-read-edge.ts) and the scan job status path
 * (lib/durable-scan-job-registry.ts) share it.
 */
export function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") ? null : decoded;
  } catch {
    return null;
  }
}

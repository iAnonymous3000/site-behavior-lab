/**
 * The address an "Inspect this connection" visit asks about, and the request
 * contract around it. Pure and dependency-free: the scan form's prefill
 * parser and the homepage hook import it, so it must stay small and must not
 * reach the public-suffix list. The authoritative check, that the redaction
 * pass returns the address unchanged, runs on the server
 * (isInspectableAddress in lib/connection-inspection.ts).
 *
 * The address is a request row's published URL without its query (owner's
 * ruling 2, 2026-10-22): origin plus generalized path, exactly as the
 * redaction pass writes it, for example `https://cdn.example.net/{seg}` or
 * `https://{label}.example.com/api`. A request of the new visit matches when
 * redactUrlV2 of its raw URL, which drops the query, equals it.
 */

/**
 * Bound on the address, well inside the edge's 4,096-byte scan body. A
 * published host is at most 253 characters and a published path at most six
 * segments, so a real address is far shorter; the committed corpus's longest
 * third-party address is 79 characters.
 */
export const INSPECTED_ADDRESS_MAX_CHARS = 512;

// One host label as the redaction pass publishes it: the generalized-label
// marker or a lowercase label (WHATWG URL parsing lowercases and punycodes).
const HOST_LABEL = String.raw`(?:\{label\}|[a-z0-9_-]{1,63})`;
// One path segment as published: a generalized-segment marker, the numeric
// marker, or a reviewed route literal (every literal is lowercase letters,
// digits and dashes).
const PATH_SEGMENT = String.raw`(?:\{seg\}|\{n\}|[a-z0-9-]+)`;
const PUBLISHED_ADDRESS = new RegExp(
  String.raw`^https?:\/\/(${HOST_LABEL}(?:\.${HOST_LABEL})+)(?:\/|(?:\/${PATH_SEGMENT}){1,6})$`
);

// The redaction pass never publishes an IP literal; bracketed IPv6 already
// fails the label grammar.
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Whether a value has the syntactic shape of a published address with no
 * query: http or https, a host of at least two published labels and at most
 * 253 characters that is not an IP literal, no port, no credentials, and a
 * path of at most six published segments with no trailing slash, as the
 * redaction pass writes one. Syntactic only, so it runs the same in every
 * browser and in Node.
 */
export function isPublishedAddressShape(value: string): boolean {
  if (value.length > INSPECTED_ADDRESS_MAX_CHARS) return false;
  const match = PUBLISHED_ADDRESS.exec(value);
  return match !== null && match[1].length <= 253 && !IPV4_HOST.test(match[1]);
}

/**
 * A request row's published URL without its query, the address its
 * "Inspect this connection" link names, or null when that is not a
 * published address (an `{invalid-url}` row, for one).
 */
export function inspectedAddressFromRowUrl(rowUrl: string): string | null {
  const queryStart = rowUrl.indexOf("?");
  const address = queryStart === -1 ? rowUrl : rowUrl.slice(0, queryStart);
  return isPublishedAddressShape(address) ? address : null;
}

/**
 * The refusal an inspection gets while the scanner admits scans as durable
 * jobs, whose exact-keyed admission commitment has no place for it (owner's
 * ruling 3). The browser says it before minting an admission credential,
 * and the edge and the Node durable preparation say the same.
 */
export const INSPECTION_DURABLE_REFUSAL =
  "Inspecting a connection is not available while this scanner runs scans as recoverable jobs, so no visit was made.";

/**
 * The refusal an inspection gets from a scanner that writes version 1
 * reports, which have no immediate-only block to carry its details.
 */
export const INSPECTION_V1_PRODUCER_REFUSAL =
  "Inspecting a connection needs a scanner that writes revision 2 reports, and this one writes version 1 reports, so no visit was made.";

/**
 * Whether a scan request body names an inspection at all, whatever its
 * value: the durable edge refuses any such body before it looks for an
 * admission capability, which such a body could never carry.
 */
export function scanBodyNamesInspection(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "inspect");
}

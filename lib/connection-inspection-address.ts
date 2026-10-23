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

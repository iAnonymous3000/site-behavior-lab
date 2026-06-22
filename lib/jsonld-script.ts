// Code points that must not appear raw inside an inline <script> element:
// < > & (HTML parser) and U+2028 / U+2029 (JavaScript line terminators).
const SCRIPT_UNSAFE = new Set<number>([0x3c, 0x3e, 0x26, 0x2028, 0x2029]);

/**
 * Serializes a value as JSON for safe embedding inside an inline
 * `<script type="application/ld+json">` rendered via dangerouslySetInnerHTML.
 *
 * `JSON.stringify` does not escape characters that matter to the HTML parser, so
 * a string containing `</script>` would close the script element and a following
 * `<script>` would execute. Report JSON-LD includes fields derived from the
 * scanned site (for example the requested URL), so rewrite the unsafe code points
 * to their `\uXXXX` form — still valid JSON, but never able to close the tag.
 */
export function serializeJsonLd(data: unknown): string {
  const json = JSON.stringify(data);
  if (json === undefined) return "";
  let out = "";
  for (const ch of json) {
    const code = ch.codePointAt(0) ?? 0;
    out += SCRIPT_UNSAFE.has(code) ? "\\u" + code.toString(16).padStart(4, "0") : ch;
  }
  return out;
}

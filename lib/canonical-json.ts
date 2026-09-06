import { sha256Hex } from "./sha256";

/**
 * Canonical JSON and the public-report digest (RFC scan-report-v2 3.2 /
 * 15.8): sorted keys, NFC-normalized strings, no insignificant whitespace.
 * The provenance sidecars store `publicDigest` computed here, so formatting
 * differences between storage backends (the committed corpus pretty-prints,
 * R2 objects may not) can never break digest matching.
 *
 * `CANONICALIZATION_VERSION` pins these rules; a change to them is a new
 * version, never a silent redefinition, because every stored digest names the
 * version that produced it.
 *
 * Lane-free (shared sha256, no runtime globals) so the same digest computes
 * in Node scripts, the Worker, and tests.
 */

export const CANONICALIZATION_VERSION = "canon-v1";

/**
 * Canonical serialization. Objects sort keys lexicographically; string VALUES
 * are NFC-normalized, while object KEYS must already be NFC and are refused
 * otherwise (see the object branch); `undefined` object members are omitted
 * exactly as JSON.stringify omits them (an absent field and an undefined field
 * digest identically); non-finite numbers, non-NFC keys, and other non-JSON
 * values are rejected loudly rather than silently coerced, since a digest over
 * coerced data would "match" bytes that never existed.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, [], new Map());
}

/** sha256 hex over the canonical JSON of a public report. */
export function publicReportDigest(report: unknown): string {
  return sha256Hex(canonicalJson(report));
}

function serialize(value: unknown, path: string[], encodedKeys: Map<string, string>): string {
  if (value === null) return "null";
  const type = typeof value;

  if (type === "string") {
    const text = value as string;
    // ASCII is already NFC. URLs and fixed report vocabularies dominate the
    // corpus; reserve Unicode normalization for strings that can need it.
    return JSON.stringify(/[^\x00-\x7f]/.test(text) ? text.normalize("NFC") : text);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalJson: non-finite number at ${jsonPath(path)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      // JSON.stringify serializes undefined/functions in arrays as null; a
      // canonical form must not invent nulls silently.
      path.push(String(index));
      if (item === undefined) rejectValue("undefined array element", path);
      const serialized = serialize(item, path, encodedKeys);
      path.pop();
      return serialized;
    });
    return `[${items.join(",")}]`;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    // Keys must ALREADY be NFC. Normalizing them here instead was silently
    // fatal to the digest contract in two ways:
    //
    // 1. COLLISION. "caf\u00e9" and "cafe\u0301" are two distinct own
    //    properties that normalize to one member name, so the canonical form
    //    emitted that name twice. `parseStrictJson` rejects raw duplicate keys
    //    naming exactly this threat, and a canonical form nothing can reparse
    //    is not a form anything can verify a digest against.
    // 2. ORDER. Keys were sorted BEFORE normalization and emitted AFTER it, so
    //    a key whose NFC form differs sorted under one string and emitted as
    //    another. Two objects with identical logical content then digest
    //    differently depending on which normalization form the caller happened
    //    to hold, which is the single thing canonicalization exists to prevent.
    //
    // Sorting on the normalized form would fix (2) and a post-normalization
    // collision check would fix (1), but the first changes the emitted bytes
    // for such keys and CANONICALIZATION_VERSION pins these rules: a rule
    // change is canon-v2, never a silent redefinition of digests already
    // stored under canon-v1. Refusing the input changes no output canon-v1
    // ever produced correctly, and it needs only ONE check rather than two:
    // NFC is idempotent, so once every key is required to equal its own
    // normalization, two distinct keys can no longer collide under it.
    //
    // Nothing real is refused. Every object key in the published wire is a
    // schema-fixed ASCII identifier (`byFamily` over EvidenceFamily,
    // DetectorLedger over DetectorId, `perMetric` over MetricFamily), and NFC
    // is the identity on ASCII.
    for (const key of keys) {
      if (!encodedKeys.has(key)) {
        if (key.normalize("NFC") !== key) {
          path.push(key);
          rejectValue("object key is not NFC-normalized", path);
        }
        // Cache only key encodings within this serialization. Reports repeat
        // a small vocabulary thousands of times; values and mutable objects
        // are never cached, and unusual key sets cannot grow this unboundedly.
        if (encodedKeys.size < 256) encodedKeys.set(key, JSON.stringify(key));
      }
    }
    const members = keys.map((key) => {
      path.push(key);
      const serialized = serialize(record[key], path, encodedKeys);
      path.pop();
      return `${encodedKeys.get(key) ?? JSON.stringify(key)}:${serialized}`;
    });
    return `{${members.join(",")}}`;
  }
  return rejectValue(`unsupported ${type}`, path);
}

function rejectValue(reason: string, path: string[]): never {
  throw new Error(`canonicalJson: ${reason} at ${jsonPath(path)}`);
}

function jsonPath(path: string[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

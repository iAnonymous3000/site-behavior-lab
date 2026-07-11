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
 * Canonical serialization. Objects sort keys lexicographically; strings are
 * NFC-normalized; `undefined` object members are omitted exactly as
 * JSON.stringify omits them (an absent field and an undefined field digest
 * identically); non-finite numbers and other non-JSON values are rejected
 * loudly rather than silently coerced, since a digest over coerced data would
 * "match" bytes that never existed.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}

/** sha256 hex over the canonical JSON of a public report. */
export function publicReportDigest(report: unknown): string {
  return sha256Hex(canonicalJson(report));
}

function serialize(value: unknown, path: string[]): string {
  if (value === null) return "null";
  const type = typeof value;

  if (type === "string") return JSON.stringify((value as string).normalize("NFC"));
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalJson: non-finite number at ${jsonPath(path)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      // JSON.stringify serializes undefined/functions in arrays as null; a
      // canonical form must not invent nulls silently.
      item === undefined ? rejectValue("undefined array element", [...path, String(index)]) : serialize(item, [...path, String(index)])
    );
    return `[${items.join(",")}]`;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const members = keys.map((key) => `${JSON.stringify(key.normalize("NFC"))}:${serialize(record[key], [...path, key])}`);
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

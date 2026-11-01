// One spelling for one value, so a digest over the bytes identifies the value.
//
// The bytes are UTF-8 of JSON with keys sorted by UTF-16 code unit at every level,
// no whitespace, and strings written as JSON.stringify writes them. That matches
// RFC 8785 for everything accepted here, and it accepts less, because every value
// refused below is one that could otherwise share bytes with a different value:
//
// - a number other than a safe integer: -0 prints as 0, 1.0 as 1, and a large
//   integer as its neighbor, so none of them round-trips
// - a string with a lone surrogate, which has no UTF-8 form
// - undefined, a function, a symbol or a bigint, which JSON drops or cannot hold
// - an array with a hole or an extra property, and an object that is not plain or
//   holds a symbol or non-enumerable key, since none of those appear in the bytes
//
// Strings are not normalized: the two spellings of an accented letter are different
// values with different bytes. Everything here works unchanged in a Worker.

export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };

/** Deep enough for any event, and a bound on recursion, so a cycle is refused and not a stack overflow. */
export const MAX_CANONICAL_DEPTH = 32;

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalText(value: unknown, depth: number): string | null {
  if (depth > MAX_CANONICAL_DEPTH) return null;
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null;
    return String(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) return null;
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return null;

  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return null;
    const parts: string[] = [];
    for (const item of value as unknown[]) {
      const part = canonicalText(item, depth + 1);
      if (part === null) return null;
      parts.push(part);
    }
    return `[${parts.join(",")}]`;
  }

  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const parts: string[] = [];
  for (const key of keys.sort()) {
    if (!key.isWellFormed()) return null;
    const part = canonicalText((value as Record<string, unknown>)[key], depth + 1);
    if (part === null) return null;
    parts.push(`${JSON.stringify(key)}:${part}`);
  }
  return `{${parts.join(",")}}`;
}

/** The value's one spelling, or null when the value has none. */
export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  const text = canonicalText(value, 0);
  return text === null ? null : new TextEncoder().encode(text);
}

/**
 * The value these bytes are the one spelling of, or null when they are anything
 * else. The comparison is of bytes, so a byte order mark or invalid UTF-8, which a
 * decoder quietly absorbs, comes back different and is refused.
 */
export function parseCanonical(bytes: Uint8Array): CanonicalValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const again = canonicalBytes(parsed);
  return again !== null && bytesEqual(again, bytes) ? (parsed as CanonicalValue) : null;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Lowercase hex SHA-256 through WebCrypto, the same in a Worker and in the unit suite. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

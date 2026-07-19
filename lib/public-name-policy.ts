import allowlists from "./redaction-allowlists.json";

/**
 * Client-safe public-name policy shared by producers, comparisons, and report
 * presentation. Cookie names and storage keys are page-controlled:
 * exact reviewed literals may be published, while every other value must be a
 * terminal privacy marker produced by redaction-v2.
 */

const REDACTED_NAME_MARKERS = new Set([
  "[redacted]",
  "[redacted:uuid-like]",
  "[redacted:numeric]",
  "[redacted:hex-like]",
  "[redacted:long-token]"
]);

const REVIEWED_COOKIE_NAMES = new Set<string>(allowlists.cookieNames.literals);
const REVIEWED_STORAGE_KEYS = new Set<string>(allowlists.storageKeys.literals);

export function isRedactedNameMarker(value: string): boolean {
  return REDACTED_NAME_MARKERS.has(value);
}

export function isReviewedCookieName(value: string): boolean {
  return REVIEWED_COOKIE_NAMES.has(value);
}

export function isReviewedStorageKey(value: string): boolean {
  return REVIEWED_STORAGE_KEYS.has(value);
}

export function isPublicCookieName(value: string): boolean {
  return isReviewedCookieName(value) || isRedactedNameMarker(value);
}

export function isPublicStorageKey(value: string): boolean {
  return isReviewedStorageKey(value) || isRedactedNameMarker(value);
}

/**
 * Presentation-only partition for name-level comparison lists. The frozen v1
 * wire keeps terminal markers in its derived diff for byte compatibility, and
 * local imports can contain unsanitized names, so the UI defaults to reviewed
 * literals and never itemizes any other value as a public identity.
 */
export function omitUnreviewedNames<T>(
  entries: readonly T[],
  nameOf: (entry: T) => string,
  kind: "cookie" | "storage"
): { entries: T[]; omitted: number } {
  const visible: T[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const name = nameOf(entry);
    const reviewed = kind === "cookie" ? isReviewedCookieName(name) : isReviewedStorageKey(name);
    if (!reviewed) {
      omitted += 1;
    } else {
      visible.push(entry);
    }
  }
  return { entries: visible, omitted };
}

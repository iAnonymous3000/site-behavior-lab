/**
 * The one definition of a canonical wire timestamp: a string that survives the
 * Date.parse -> toISOString round trip byte-identically.
 *
 * This predicate was hand-pasted into seven modules and one copy had already
 * grown its own length bound, which is exactly this repo's known worst defect
 * class (one contract restated in N files, each passing its own tests). The
 * length pre-filter is folded in here for every caller: a canonical ISO string
 * is always 24 characters, so the bound never rejects a valid value, it only
 * refuses to hand pathological input to Date.parse.
 *
 * Deliberately dependency-free so every runtime boundary (Node, worker,
 * client) can import it.
 */
export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

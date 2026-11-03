// What an imported run is named by: each attempt's id, and the digest of the objects read. The
// adapters name attempts and runs with these, and the import (imported-case.ts) runs an adapter, so
// these sit here, where both can reach them without reaching each other.

import { canonicalBytes, sha256Hex } from "./canonical-json";

declare const IMPORTED_ATTEMPT: unique symbol;

/** An imported attempt's id: A and two to four digits, made only by importedAttemptId or admitted by isImportedAttemptId. No slot name has this shape. */
export type ImportedAttemptId = string & Readonly<{ [IMPORTED_ATTEMPT]: true }>;

const ATTEMPT_ID = /^A[0-9]{2,4}$/;

export function isImportedAttemptId(value: unknown): value is ImportedAttemptId {
  return typeof value === "string" && ATTEMPT_ID.test(value);
}

/** The id of the attempt at this zero-based position in a run: A01, A02, and so on. */
export function importedAttemptId(index: number): ImportedAttemptId {
  return `A${String(index + 1).padStart(2, "0")}` as ImportedAttemptId;
}

/** One file an adapter read, by its name inside the run folder, its digest and its size. */
export type RunObject = Readonly<{ path: string; digest: string; bytes: number }>;

/**
 * The digest of a run as an adapter read it: the sha256 of the canonical bytes of its objects, each
 * a path, a digest and a size, in path order. A survey of the same files names the same run.
 */
export async function runDigestOf(objects: readonly RunObject[]): Promise<string> {
  const ordered = [...objects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)).map(({ path, digest, bytes }) => ({ path, digest, bytes }));
  const bytes = canonicalBytes(ordered);
  if (bytes === null) throw new TypeError("objects have no canonical form");
  return sha256Hex(bytes);
}

/**
 * The mark a visit carries when a private capture was connected to it through
 * the scanner's investigation seam (lib/investigation-seam.ts), and the one
 * check every step that could publish such a visit makes first.
 *
 * This file imports nothing and uses nothing of Node, because one of those
 * steps is the v1 redactor, which also runs in the browser and in a Worker.
 * It builds its output field by field, so it must refuse a marked input
 * before it reads it: its output would not carry the mark.
 *
 * The mark is carried two ways. By identity: the objects the scanner
 * remembered here. In band: one key, SEAM_VISIT_MARKER, on the visit's result
 * and measurement, which a structured clone, a JSON copy and an object spread
 * all keep. No visit that did not use the seam has either.
 */

/** The in-band mark's key. Its value is the seam's version. */
export const SEAM_VISIT_MARKER = "investigationSeamVisit";

/** A seam visit was offered for publication, or a public visit was asked to carry the seam. */
export class SeamVisitRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamVisitRefusal";
  }
}

const seamVisitObjects = new WeakSet<object>();

/** Remember objects as a seam visit's own. Only the scanner's seam calls this. */
export function rememberSeamVisit(...objects: object[]): void {
  for (const value of objects) seamVisitObjects.add(value);
}

function carriesSeamMark(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return seamVisitObjects.has(value) || SEAM_VISIT_MARKER in value;
}

/**
 * Whether a value is a seam visit's, or holds one: the value itself or any
 * top-level member is marked, by identity or in band. One level is what the
 * publishable shapes need: an envelope holds its result and measurement, and
 * a v1 comparison holds its two results. A marked value is recognized before
 * any of its members is read.
 */
export function isSeamVisit(value: unknown): boolean {
  if (carriesSeamMark(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((member) => carriesSeamMark(member));
}

/** Refuse a value that is a seam visit's or holds one. Every publication step calls this first. */
export function refuseSeamVisit(value: unknown, step: string): void {
  if (!isSeamVisit(value)) return;
  throw new SeamVisitRefusal(`Refusing a visit made with the investigation seam at ${step}: it is never published.`);
}

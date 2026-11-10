/**
 * The mark a visit carries when a private capture was connected to it through
 * the scanner's investigation seam (lib/investigation-seam.ts), and the one
 * check every step that could publish such a visit makes first.
 *
 * This file imports nothing and uses nothing of Node, because some of those
 * steps also run in the browser and in a Worker: the v1 redactor, the v1
 * public projector and the two readers. The redactor and the projector build
 * their output field by field, so each must refuse a marked input before it
 * reads it: its output would not carry the mark. The readers decline one as
 * they decline any payload that is not a report. Every module that
 * refuses imports its helper from here and nothing from the seam's own
 * module, which would bring the scanner's runtime with it.
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

function holdsSeamMark(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.values(value).some((member) => carriesSeamMark(member));
}

/**
 * Whether a value is a seam visit's, or holds one. Marked, by identity or in
 * band, is any of: the value itself; one of its top-level members; and, for
 * a value with a `baseline` or a `variant` (a v1 comparison), one of that
 * member's own members. That is every place a result's mark can sit in the
 * shapes a report is handed over in: a result, an envelope around a result
 * and a measurement, and a comparison of two results. A value marked itself
 * is recognized before any of its members is read.
 *
 * Not covered: a mark deeper than that (on one request record, say), a
 * marked result inside any other wrapper (an array of results, an object two
 * levels up), and whatever was rebuilt from a result's fields by hand. The
 * transport reader unwraps a job envelope and applies this to what it holds.
 */
export function isSeamVisit(value: unknown): boolean {
  if (carriesSeamMark(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if (holdsSeamMark(value)) return true;
  const { baseline, variant } = value as { baseline?: unknown; variant?: unknown };
  return holdsSeamMark(baseline) || holdsSeamMark(variant);
}

/** Refuse a value that is a seam visit's or holds one. Every publication step calls this first. */
export function refuseSeamVisit(value: unknown, step: string): void {
  if (!isSeamVisit(value)) return;
  throw new SeamVisitRefusal(`Refusing a visit made with the investigation seam at ${step}: it is never published.`);
}

/** Refuse visit options that carry the seam's field, own or inherited, whatever its value. */
export function refuseSeamOption(options: object): void {
  if (!("investigationSeam" in options)) return;
  throw new SeamVisitRefusal("Refusing to start a public visit whose options carry the investigation seam.");
}

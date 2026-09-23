// Marker lookups for tests that assert on the SHAPE of source text.
//
// Every such test is one marker lookup away from becoming vacuous: `indexOf`
// answers a missing marker with -1, `slice(start, -1)` silently widens to
// almost the whole file, and `-1 < anything` is trivially true. A renamed or
// reworded marker then leaves the assertion green while it no longer
// constrains the region it names. That is exactly how two bounded-fetch guards
// in lib/durable-scan-job-edge-wiring.test.ts survived
// `gateDurableScanJobControlRequest` becoming
// `refuseUnauthorizedDurableScanJobControl`: both widened to ~48 kB and were
// satisfied by an unrelated copy of the pattern elsewhere in the file. The
// same class let a watch-creation handler that touched the Durable Object and
// charged quota before its capability check pass
// lib/encrypted-watch-worker-wiring.test.ts, once the check's argument order
// was swapped.
//
// Every marker lookup in a source-shape test goes through these, so the next
// rename fails loudly and names the marker it could not find. Test support
// only: no production module may import this.

import assert from "node:assert/strict";

/** The first position of `marker` at or after `fromIndex`, or a failure naming it. */
export function requireIndex(source: string, marker: string, label = "source", fromIndex = 0): number {
  const index = source.indexOf(marker, fromIndex);
  assert.ok(
    index >= 0,
    `${label} no longer contains ${JSON.stringify(marker)}${fromIndex > 0 ? ` after offset ${fromIndex}` : ""}; the assertion below constrains nothing until this marker is updated`
  );
  return index;
}

/** The last position of `marker`, or a failure naming it. */
export function requireLastIndex(source: string, marker: string, label = "source"): number {
  const index = source.lastIndexOf(marker);
  assert.ok(
    index >= 0,
    `${label} no longer contains ${JSON.stringify(marker)}; the assertion below constrains nothing until this marker is updated`
  );
  return index;
}

/**
 * The region from the first `startMarker` to the first `endMarker` in the
 * file. Both must exist and the end must follow the start: an end marker that
 * moved above the start is a structural change to report, never a reason to
 * widen onto a later copy.
 */
export function sliceBetween(source: string, startMarker: string, endMarker: string, label = "source"): string {
  const start = requireIndex(source, startMarker, label);
  const end = requireIndex(source, endMarker, label);
  assert.ok(
    end > start,
    `${label}: ${JSON.stringify(endMarker)} precedes ${JSON.stringify(startMarker)}, so the intended region is empty`
  );
  return source.slice(start, end);
}

/**
 * The region from the first `startMarker` to the next `endMarker` after it,
 * for an end marker that legitimately also appears earlier in the file.
 */
export function sliceToNext(source: string, startMarker: string, endMarker: string, label = "source"): string {
  const start = requireIndex(source, startMarker, label);
  const end = requireIndex(source, endMarker, label, start + startMarker.length);
  return source.slice(start, end);
}

/**
 * Every marker is present and their first occurrences appear in exactly this
 * order: the guarded form of `indexOf(a) < indexOf(b) < indexOf(c)`. Pass only
 * a real chain; two constraints that share a first marker are two calls.
 */
export function assertOrdered(source: string, markers: readonly string[], label = "source", message?: string): void {
  assert.ok(markers.length >= 2, "an ordering needs at least two markers");
  const positions = markers.map((marker) => requireIndex(source, marker, label));
  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(
      positions[index - 1] < positions[index],
      `${label}: ${JSON.stringify(markers[index - 1])} must precede ${JSON.stringify(markers[index])}${message ? `. ${message}` : ""}`
    );
  }
}

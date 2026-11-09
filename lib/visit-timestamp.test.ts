import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { clientImportTrails } from "./client-import-graph";
import { formatReportTimestamp as fromVisitSummary } from "./report-visit-summary";
import { formatReportTimestamp, readableVisitStart, unshownVisitStart } from "./visit-timestamp";

test("a visit's time is stated in UTC with its zone, and an absent or unreadable one is said to be unrecorded", () => {
  assert.equal(formatReportTimestamp("2026-10-19T15:02:41.000Z"), "Oct 19, 2026, 3:02 PM UTC");
  // The zone is the report's, never the reader's: a visit late on the 19th in UTC stays on the 19th.
  assert.equal(formatReportTimestamp("2026-10-19T23:59:59.000Z"), "Oct 19, 2026, 11:59 PM UTC");
  assert.equal(formatReportTimestamp(null), "not recorded");
  assert.equal(formatReportTimestamp(""), "not recorded");
  assert.equal(formatReportTimestamp("not a date"), "not recorded");
});

test("the report pages read the same formatter through the visit summary", () => {
  assert.equal(fromVisitSummary, formatReportTimestamp);
});

test("the result surface states a visit's start with the report pages' formatter, not one of its own", () => {
  // The header of an opened file, a live result or an archive comparison, and
  // the comparison panel's two visits, are client components. Each reaches
  // the shared module directly; the visit summary stays server only
  // (lib/report-visit-summary.test.ts holds that side).
  const trails = clientImportTrails("lib/visit-timestamp.ts");
  for (const component of ["app/_components/report-header.tsx", "app/_components/comparison-panel.tsx"]) {
    assert.ok(trails.includes(`${component} -> lib/visit-timestamp.ts`), `${component} does not import the shared formatter`);
    // Both print what an opened file holds, so neither may format a value the
    // canonical-instant rule has not passed.
    const source = readFileSync(path.join(process.cwd(), component), "utf8");
    assert.match(source, /readableVisitStart\(/, component);
    assert.doesNotMatch(source, /formatReportTimestamp/, `${component} formats a file's start time unchecked`);
  }
});

test("the result surface prints a visit's start only when the file holds one instant, the same for every reader", () => {
  assert.equal(readableVisitStart("2026-10-19T15:02:41.000Z"), "Oct 19, 2026, 3:02 PM UTC");
  // Strings a version 1 file may hold where its scan time goes. Date reads
  // "1" as a moment in 2001, and "12/25/2026" as midnight in whatever time
  // zone the reader is in; neither is a time the scanner recorded.
  for (const held of ["1", "12/25/2026", "2026-10-19", "2026-10-19T15:02:41Z", "Oct 19, 2026", "not a date", ""]) {
    assert.equal(readableVisitStart(held), null, held);
  }
  assert.equal(readableVisitStart(null), null);
  // The unchecked formatter does print the first two, which is why the
  // surface may not call it on a file's own text.
  assert.notEqual(formatReportTimestamp("1"), "not recorded");
  assert.notEqual(formatReportTimestamp("12/25/2026"), "not recorded");

  // In its place the surface says which it is: nothing recorded, or something that is not an instant.
  assert.equal(unshownVisitStart(null), "not recorded");
  assert.equal(unshownVisitStart(""), "not recorded");
  assert.equal(unshownVisitStart("1"), "not recorded in a readable form");
  assert.equal(unshownVisitStart("12/25/2026"), "not recorded in a readable form");
});

test("the Duration tile on the same surface prints a time of day only for an instant too", () => {
  // It reads the string the header reads. Unchecked, a file holding "1" got
  // a time of day here beside a header saying none was readable, and a file
  // holding plain text got "Invalid Date".
  const overview = readFileSync(path.join(process.cwd(), "app/_components/report-overview.tsx"), "utf8");
  const tile = overview.slice(overview.indexOf('label: "Duration"'), overview.indexOf("icon: Clock"));
  assert.match(tile, /detail: isCanonicalTimestamp\(run\.startedAt\)\s*\? new Date\(run\.startedAt\)\.toLocaleTimeString\(/);
  assert.match(tile, /: `start time \$\{unshownVisitStart\(run\.startedAt\)\}`/);
  assert.equal(tile.match(/new Date\(/g)?.length, 1, "the tile formats its time once, behind the check");
});

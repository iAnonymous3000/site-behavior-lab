import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReportTimestamp as fromVisitSummary } from "./report-visit-summary";
import { formatReportTimestamp } from "./visit-timestamp";

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

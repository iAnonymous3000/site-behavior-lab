import assert from "node:assert/strict";
import test from "node:test";
import { listOverflowCopy } from "./report-table-copy";

test("privacy-filtered overflow copy stays in-list while located lists name their destination", () => {
  assert.equal(listOverflowCopy(4, 4), null);
  assert.equal(listOverflowCopy(1_204, 4), "+1,200 more observations not shown in this list.");
  assert.equal(listOverflowCopy(14, 4, "the domain table"), "+10 more in the domain table.");
  assert.doesNotMatch(listOverflowCopy(14, 4) ?? "", /JSON export/);
});

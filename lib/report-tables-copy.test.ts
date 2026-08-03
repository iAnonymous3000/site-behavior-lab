import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listOverflowCopy } from "./report-table-copy";

test("privacy-filtered overflow copy stays in-list while located lists name their destination", () => {
  assert.equal(listOverflowCopy(4, 4), null);
  assert.equal(listOverflowCopy(1_204, 4), "+1,200 more observations not shown in this list.");
  assert.equal(listOverflowCopy(14, 4, "the domain table"), "+10 more in the domain table.");
  assert.doesNotMatch(listOverflowCopy(14, 4) ?? "", /JSON export/);
});

test("the domain chip never claims an identified operator for a framework-endpoint-only host", () => {
  // A shared IAB TCF endpoint names the standard a host serves, not the CMP
  // that ran it, so the "operator identified" chip may only be driven by
  // namers that actually identify an operator.
  const table = readFileSync(
    path.join(process.cwd(), "app/_components/report-tables.tsx"),
    "utf8"
  );
  assert.match(table, /namer\.kind !== "framework-endpoint"/);
  assert.match(table, /namer\.kind === "framework-endpoint"/);
  assert.match(table, /operatorNames\.join\(", "\)\} · operator identified; no tracking-service classification/);
  assert.match(
    table,
    /frameworkNames\.join\(", "\)\} · shared consent framework endpoint; operator not identified/
  );
  // The old shape fed every namer name into the "operator identified" copy.
  assert.doesNotMatch(table, /\bnames\.join\(", "\)\} · operator identified/);
});

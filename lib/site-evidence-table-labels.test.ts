import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * What the shared site table calls its visit column and its report link.
 *
 * The directory and every category page render one table component. On the
 * directory a row is the site's newest retained report. On a category page a
 * row is the site's newest eligible visit inside that page's one cohort
 * (lib/directory-view.ts; its own tests hold that such a row can be older
 * than the site's newest visit). Under one fixed "Latest visit" header and
 * "Open latest evidence" link, a category row dated in August reads as the
 * latest for a site whose newest report is from October. The labels are
 * therefore the caller's to give, and the category page gives its own.
 */
function source(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

test("the site table takes its visit column and report link labels from its caller, and says Latest only by default", () => {
  const table = source("app", "_components", "site-evidence-table.tsx");
  assert.match(table, /const LATEST_VISIT_LABELS = \{ column: "Latest visit", link: "Open latest evidence" \};/);
  assert.match(table, /visitLabels = LATEST_VISIT_LABELS/);
  // Everything a reader sees for that column comes from the labels: the
  // column header and the phone sort option (both drawn from `columns`), the
  // stacked row's cell label, and the link.
  const body = table.slice(table.indexOf("export function SiteEvidenceTable("));
  assert.match(body, /column\.key === "scannedAt" \? \{ \.\.\.column, label: visitLabels\.column \} : column/);
  assert.equal(body.match(/\bCOLUMNS\b/g)?.length, 1, "the header and the sort control draw the relabelled columns");
  assert.match(body, /<td data-label=\{visitLabels\.column\}>/);
  assert.match(body, /<a href=\{row\.reportHref\}>\{visitLabels\.link\}<\/a>/);
  // No fixed wording is left in what the component draws.
  assert.doesNotMatch(body.slice(body.indexOf("  return (")), /Latest visit|Open latest evidence/);
});

test("a category page names its rows as included visits, and the directory keeps Latest", () => {
  const category = source("app", "categories", "[category]", "page.tsx");
  assert.match(category, /visitLabels=\{\{ column: "Included visit", link: "Open this evidence" \}\}/);
  // The directory renders the table through its controls and passes no labels.
  assert.doesNotMatch(source("app", "directory", "directory-controls.tsx"), /visitLabels/);
  assert.doesNotMatch(source("app", "directory", "directory-index.tsx"), /visitLabels/);
});

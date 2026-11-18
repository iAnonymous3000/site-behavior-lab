import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPORT_SECTION_IDS, SUMMARY_SECTION_IDS, explorerSectionForHash } from "./report-section-ids";

const root = process.cwd();
const source = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");

test("a copied section link opens the explorer for every section only the explorer renders", () => {
  for (const id of REPORT_SECTION_IDS) {
    assert.equal(explorerSectionForHash(`#${id}`), SUMMARY_SECTION_IDS.has(id) ? null : id, id);
  }
  // The summary renders the findings itself, so its link already lands.
  assert.equal(explorerSectionForHash("#findings"), null);
  // Evidence fragments have their own handler; other fragments open nothing.
  for (const hash of ["#evidence=requests", "#", "", "#report", "#cookies-extra", "#Cookies"]) {
    assert.equal(explorerSectionForHash(hash), null, hash);
  }
});

test("every listed section is one the app renders under that id", () => {
  const dir = path.join(root, "app", "_components");
  const app = readdirSync(dir).filter((file) => file.endsWith(".tsx")).map((file) => readFileSync(path.join(dir, file), "utf8")).join("\n");
  for (const id of REPORT_SECTION_IDS) {
    assert.ok(app.includes(`evidenceId("${id}")`) || app.includes(`id="${id}"`), `no component renders a section with id ${id}`);
  }
});

test("the section nav and the saved report page read the one list", () => {
  const renderer = source("app", "_components", "report-renderer.tsx");
  assert.match(renderer, /const sections: ReportSection\[\] = REPORT_SECTION_IDS\.map\(/);
  assert.doesNotMatch(renderer, /\{ id: "request-evidence", label:/, "a second, hand-written section list");
  const saved = source("app", "reports", "[id]", "saved-report-client.tsx");
  assert.match(saved, /const section = explorerSectionForHash\(window\.location\.hash\);/);
  assert.match(saved, /pendingSectionRef\.current = section;/);
  assert.match(saved, /document\.getElementById\(section\)/);
});

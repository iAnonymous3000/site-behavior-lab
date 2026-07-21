import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("public corpus copy describes current retention and correction-ledger pins", () => {
  const files = [
    "README.md",
    "app/_components/report-page-context.tsx",
    "app/directory/directory-index.tsx",
    "app/categories/[category]/page.tsx",
    "app/privacy/page.tsx",
    "app/methodology/page.tsx"
  ];
  const combined = files.map(source).join("\n");
  assert.doesNotMatch(combined, /permanent public evidence|permanent site artifacts|complete published evidence timeline|complete report history|deliberately permanent evidence/i);
  assert.match(combined, /currently retained/i);
  assert.match(source("README.md"), /reports cited by the corrections ledger are retention-pinned/i);
  assert.match(source("app/privacy/page.tsx"), /reports cited by[\s\S]*the corrections ledger are pinned/i);
});

test("catalog copy scopes official references to entity identity, not suffixes or categories", () => {
  const page = source("app/catalog/page.tsx");
  const provenance = source("lib/tracker-catalog-provenance.ts");
  assert.match(page, /identifies the named entity or product only/);
  assert.match(page, /not presented as a[\s\S]*citation for every suffix/);
  assert.match(provenance, /may not list this suffix, prove the domain mapping, or support the functional category/);
});

test("catalog and project trust surfaces are linked from both primary footers", () => {
  const trustLinks = source("app/_components/trust-links.tsx");
  const home = source("app/site-behavior-app.tsx");
  const report = source("app/reports/[id]/saved-report-client.tsx");
  for (const route of ["catalog", "status", "security", "corrections"]) {
    assert.match(trustLinks, new RegExp(`href="/${route}/"`));
    assert.match(home, new RegExp(`staticAssetPath\\("/${route}/"\\)`));
    assert.match(report, new RegExp(`staticAssetPath\\("/${route}/"\\)`));
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("reader-facing report surfaces format canonical redaction tokens", () => {
  const requestTable = source("app/_components/report-tables.tsx");
  const header = source("app/_components/report-header.tsx");
  const savedContext = source("app/_components/report-page-context.tsx");
  const gallery = source("app/_components/static-gallery.tsx");
  const causalMap = source("app/_components/causality-graph.tsx");
  const attributionModel = source("lib/request-attribution-map.ts");
  const findings = source("lib/report-findings.ts");
  const insights = source("lib/report-insights.ts");
  const csv = source("lib/csv-export.ts");

  assert.match(requestTable, /displayPublicUrl\(request\.url\)/);
  assert.doesNotMatch(requestTable, />\{request\.url\}</);
  assert.match(header, /displayPublicUrl\(run\.conditions\.finalUrl\)/);
  assert.doesNotMatch(header, />\{run\.conditions\.finalUrl\}</);
  assert.match(savedContext, /displayPublicUrl\(run\.conditions\.requestedUrl\)/);
  assert.doesNotMatch(savedContext, />\{run\.conditions\.requestedUrl\}</);
  assert.match(gallery, /displayPublicUrl\(report\.requestedUrl\)/);
  assert.doesNotMatch(gallery, />\{report\.requestedUrl\}</);
  assert.match(causalMap, /buildRequestAttributionMap\(/);
  assert.match(attributionModel, /const source = displayHost\(actor\.domain\)/);
  assert.match(attributionModel, /request\.tracker\?\.entity \|\| displayHost\(request\.domain\)/);
  assert.match(findings, /thirdPartyOrigins\.map\(displayPublicUrl\)/);
  assert.match(insights, /thirdPartyOrigins\.map\(displayPublicUrl\)/);
  assert.match(csv, /displayHost\(request\.domain\)/);
  assert.match(csv, /displayPublicUrl\(request\.url\)/);
});

test("reader privacy copy explains the visual notation without exposing wire syntax", () => {
  const privacy = source("app/privacy/page.tsx");
  assert.match(privacy, /ordinary wildcards and ellipses/);
  assert.doesNotMatch(privacy, /\{(?:label|seg|n)\}/);

  // The machine-readable report remains explicit and idempotent. Presentation
  // cleanup must not weaken the canonical evidence or invalidate report hashes.
  const redactor = source("lib/redaction-v2.ts");
  assert.match(redactor, /const GENERALIZED_LABEL = "\{label\}"/);
  assert.match(redactor, /const GENERALIZED_SEGMENT = "\{seg\}"/);
});

test("directory and site-discovery surfaces use the shared host presenter", () => {
  for (const file of [
    "app/_components/site-evidence-table.tsx",
    "app/_components/scan-controls.tsx",
    "app/directory/directory-controls.tsx",
    "app/sites/[domain]/page.tsx"
  ]) {
    assert.match(source(file), /displayHost\(/, file);
  }
});

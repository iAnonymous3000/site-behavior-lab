import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("report permalinks do not import the scanner, gallery, watches, or import workbench", () => {
  const client = readFileSync(path.join(root, "app", "reports", "[id]", "saved-report-client.tsx"), "utf8");
  for (const forbidden of [
    "site-behavior-app",
    "scan-controls",
    "static-gallery",
    "scheduled-rescans",
    "file-upload-button",
    "use-scan-runtime",
    "pagegraph-client-import"
  ]) {
    assert.doesNotMatch(client, new RegExp(forbidden), `saved report client imports ${forbidden}`);
  }
  assert.match(client, /lazy\(\(\) =>[\s\S]*report-renderer/);
  assert.match(client, /fetchBytesResponseWithPolicy\(evidenceHref[\s\S]*maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES/);
  assert.match(client, /parseDigestBoundReportJson\([\s\S]*expectedEvidenceSha256/);
  assert.match(client, /fetchBytesResponseWithPolicy\(evidenceHref[\s\S]*Explore full evidence/);
});

test("homepage keeps the evidence renderer outside its initial route module", () => {
  const app = readFileSync(path.join(root, "app", "site-behavior-app.tsx"), "utf8");
  assert.match(app, /lazy\(\(\) =>[\s\S]*report-renderer/);
  assert.match(app, /<LazyReportRenderer/);
  assert.doesNotMatch(app, /from "\.\/_components\/(?:report-header|report-overview|report-tables|comparison-panel|causality-graph)"/);
});

test("report pages pass compact server output instead of serializing stored evidence into the client", () => {
  const page = readFileSync(path.join(root, "app", "reports", "[id]", "page.tsx"), "utf8");
  assert.doesNotMatch(page, /stored=\{result\.stored\}/);
  // The summary slot carries the headline and the findings board, both built
  // on the server from the view; the raw evidence still crosses the network
  // only through the explorer's digest-bound fetch.
  assert.match(page, /summary=\{\s*<ReportPageSummary/);
  assert.match(page, /const findings = buildFindings\(view, await loadCommittedCorpusStats\(\), facts, evidenceArm\)/);
  assert.match(page, /evidenceHref=\{evidenceHref\}/);
  assert.match(page, /expectedEvidenceSha256=\{result\.wireSha256\}/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PAGEGRAPH_R2_MAX_ARTIFACT_BYTES } from "./pagegraph-parser";
import {
  BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES
} from "./report-resource-limits";
import {
  MAX_PAGEGRAPH_METADATA_BYTES,
  MAX_PAGEGRAPH_UPLOAD_BYTES
} from "./pagegraph-upload-selection";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("all browser upload allocations use the bounded file policy", () => {
  const app = source("app/site-behavior-app.tsx");
  const comparison = source("app/_components/static-gallery.tsx");
  const pageGraph = source("lib/pagegraph-client-import.ts");

  for (const [file, contents] of [
    ["app/site-behavior-app.tsx", app],
    ["app/_components/static-gallery.tsx", comparison],
    ["lib/pagegraph-client-import.ts", pageGraph]
  ]) {
    assert.doesNotMatch(contents, /\.text\s*\(/, `${file} reads an upload outside the bounded policy`);
    assert.doesNotMatch(contents, /\.arrayBuffer\s*\(/, `${file} reads an upload outside the bounded policy`);
  }

  assert.match(app, /readClientFileText\(file,[\s\S]*maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,[\s\S]*signal/);
  assert.match(comparison, /readCompareUpload\(file, slot, signal\)/);
  assert.match(comparison, /readClientFileText\(file,[\s\S]*maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,[\s\S]*signal/);
  assert.match(pageGraph, /readClientFileArrayBuffer\(selection\.graphml,[\s\S]*MAX_PAGEGRAPH_UPLOAD_BYTES/);
  assert.match(pageGraph, /readClientFileText\(selection\.metadata,[\s\S]*MAX_PAGEGRAPH_METADATA_BYTES/);
});

test("report and PageGraph picker caps match their downstream parser limits", () => {
  const picker = source("app/_components/file-upload-button.tsx");
  assert.match(picker, /MAX_UPLOAD_BYTES = BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES/);
  assert.match(picker, /assertClientFileReadable\(file/);
  assert.equal(BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(SERVER_STORED_REPORT_JSON_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(MAX_PAGEGRAPH_UPLOAD_BYTES, 16 * 1024 * 1024);
  assert.equal(PAGEGRAPH_R2_MAX_ARTIFACT_BYTES, 32 * 1024 * 1024);
  assert.ok(MAX_PAGEGRAPH_UPLOAD_BYTES < PAGEGRAPH_R2_MAX_ARTIFACT_BYTES);
  assert.equal(MAX_PAGEGRAPH_METADATA_BYTES, 256 * 1024);
});

test("browser modules cannot import the historical server report ceiling", () => {
  for (const file of [
    "app/site-behavior-app.tsx",
    "app/reports/[id]/saved-report-client.tsx",
    "app/_components/static-gallery.tsx",
    "app/_components/file-upload-button.tsx",
    "lib/scan-job-polling.ts",
    "lib/scan-client-orchestration.ts"
  ]) {
    assert.doesNotMatch(source(file), /SERVER_STORED_REPORT_JSON_MAX_BYTES/, file);
  }
});

test("picker failures cancel stale report work and remain exposed through alert regions", () => {
  const app = source("app/site-behavior-app.tsx");
  const comparison = source("app/_components/static-gallery.tsx");
  const recovery = source("app/_components/scan-recovery-banner.tsx");

  assert.match(app, /onUploadError={surfaceReportOperationError}/);
  assert.match(app, /surfaceReportOperationError[\s\S]*reportOpenOperation\.cancel\(\)/);
  assert.match(comparison, /surfaceCompareUploadError[\s\S]*\.cancel\(\)/);
  assert.match(comparison, /compareError && <p[^>]*role="alert"/);
  // Failures stay assertive; progress and completed actions must not borrow that urgency.
  assert.match(recovery, /const failed = Boolean\(error \?\? cancellationError\)/);
  assert.match(recovery, /role=\{failed \? "alert" : "status"\}/);
  assert.match(recovery, /failed \? "error-banner" : "error-banner error-banner-progress"/);
});

test("a report the reader opened from a file is marked, and its result says so before anything else", () => {
  // Both ways a file becomes a result mark it as local (asLocalReport), which
  // is what withholds its share link and what the renderer reads below.
  assert.match(source("app/site-behavior-app.tsx"), /const read = await readLoadedReport\(payload, "This report JSON"\);[\s\S]*?return asLocalReport\(read\.loaded\);/);
  assert.match(source("lib/pagegraph-client-import.ts"), /return asLocalReport\(read\.loaded\);/);
  // So is a before/after comparison built from two opened files. One built
  // from two archive reports comes from digest-checked committed bytes and
  // is handed over as it is.
  const gallery = source("app/_components/static-gallery.tsx");
  assert.match(gallery, /createLoadedTemporalComparison\(uploadBefore\.loaded, uploadAfter\.loaded\);[\s\S]*?onCreateComparison\(asLocalReport\(comparison\.loaded\)\);/);
  assert.match(gallery, /if \(isCurrentComparisonIntent\(intentEpoch\)\) onCreateComparison\(comparison\);/);

  // The file's own text fills the title, the measurement limits and the
  // methodology card, drawn exactly as a published report's are. The one line
  // that says the page did not vouch for it comes first in the result, ahead
  // of the header, and is not kept off paper.
  const renderer = source("app/_components/report-renderer.tsx");
  const overview = renderer.slice(renderer.indexOf("const overview = ("), renderer.indexOf("<ReportHeader"));
  assert.match(
    overview,
    /^const overview = \(<>\s*\{\/\*[\s\S]*?\*\/\}\s*\{loaded\.localOnly && \(\s*<p className="report-incomplete-notice" role="note">\s*This report was opened from a file on this device\. It was not checked against the published corpus, and\s+text in it may not be the scanner&apos;s\.\s*<\/p>\s*\)\}/
  );
  assert.doesNotMatch(overview.slice(0, overview.indexOf("An inspection visit")), /printComplete/);
});

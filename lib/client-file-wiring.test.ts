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

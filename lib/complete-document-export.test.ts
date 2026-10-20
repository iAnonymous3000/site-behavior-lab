import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { completeDocumentExportRefusal } from "./complete-document-export";
import { readStoredScanReport } from "./scan-report-reader";
import {
  makeConsentInterventionReportV2R2,
  makeConsentSupportingPairReportV2R2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeSupportingPairInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { toReportView } from "./scan-report-views";
import { requireIndex } from "./source-markers";
import { readStaticReportBundle } from "./static-report-files";

/**
 * The printable page and the PDF print a comparison's two primary visits and
 * say they carry every recorded visit. A report with supporting pairs has more,
 * so both refuse it. The committed corpus is checked in print-row-caps.test.ts,
 * whose walk already reads every committed report through the reader the
 * printable page renders from.
 */

const root = process.cwd();

/** Through the reader and view the routes use, never a hand-built view. */
function viewOf(report: unknown, label: string) {
  const read = readStoredScanReport(JSON.parse(JSON.stringify(report)));
  if (!read.ok) assert.fail(`${label} is refused by the reader: ${read.error}`);
  return toReportView(read.stored);
}

test("a comparison with supporting pairs is refused complete-document export", () => {
  for (const [label, report] of [
    ["Shields supporting pair", makeSupportingPairInterventionReportV2R2()],
    ["consent supporting pair", makeConsentSupportingPairReportV2R2()]
  ] as const) {
    const view = viewOf(report, label);
    assert.equal(view.comparison?.supportingPairs, 1, `${label}: the view must count the embedded pair`);
    assert.equal(view.runs.length, 2, `${label}: the renderers see only the primary visits`);
    assert.equal(
      completeDocumentExportRefusal(view),
      "This report records 1 supporting visit pair that the printable version and PDF do not include, " +
        "so neither is produced. Its JSON contains every recorded visit.",
      label
    );
  }
});

test("every other report shape exports, including an empty supporting-pair list", () => {
  const shields = makeShieldsInterventionReportV2R2();
  if (shields.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const emptyPairs = { ...shields, experiment: { ...shields.experiment, supportingPairs: [] } };
  for (const [label, report] of [
    ["single", makePublicSingleReportV2R2()],
    ["Shields", shields],
    ["Shields with no supporting pairs", emptyPairs],
    ["consent", makeConsentInterventionReportV2R2()],
    ["GPC", makeGpcInterventionReportV2R2()],
    ["temporal", makeTemporalReportV2R2()]
  ] as const) {
    assert.equal(completeDocumentExportRefusal(viewOf(report, label)), null, label);
  }
});

test("every PDF export witness exports", async () => {
  // The Docker smoke renders these four and checks every printed request row,
  // so a refusal here would surface only there, in CI.
  const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const { PDF_EXPORT_WITNESSES } = (await nativeImport(
    pathToFileURL(path.join(root, "scripts", "report-export-acceptance.mjs")).href
  )) as { PDF_EXPORT_WITNESSES: readonly { id: string }[] };
  assert.equal(PDF_EXPORT_WITNESSES.length, 4);
  for (const witness of PDF_EXPORT_WITNESSES) {
    const read = await readStaticReportBundle(path.join(root, "public", "reports"), witness.id);
    if (read.outcome !== "found") assert.fail(`${witness.id} is not a readable committed report`);
    assert.equal(completeDocumentExportRefusal(toReportView(read.stored)), null, witness.id);
  }
});

test("the printable page and the PDF route refuse the shape before rendering it, and nothing links to either", () => {
  const source = (file: string) => readFileSync(path.join(root, file), "utf8");

  const route = source("app/api/reports/[id]/pdf/route.ts");
  const label = "the PDF route";
  const lastConflict = requireIndex(route, "Retry after deployment finishes.\" }, { status: 409 });", label, requireIndex(route, "correctionsSha256", label));
  const refusal = requireIndex(route, "const exportRefusal = completeDocumentExportRefusal(view);", label);
  const answer = requireIndex(route, "return NextResponse.json({ ok: false, error: exportRefusal }, { status: 422 });", label);
  const charge = requireIndex(route, "assertReportPdfRateLimit(clientKey);", label);
  const render = requireIndex(route, "await renderReportPdf(", label);
  assert.ok(lastConflict < refusal, "a stale renderer still answers 409 first");
  assert.ok(refusal < answer && answer < charge, "the refusal must not spend the reader's render budget");
  assert.ok(charge < render, "the render limit is charged before Chromium starts");
  assert.equal(route.indexOf("renderReportPdf("), render + "await ".length, "one render call, after the refusal");

  const print = source("app/reports/[id]/print/page.tsx");
  const printLabel = "the printable page";
  const printRefusal = requireIndex(print, "const exportRefusal = completeDocumentExportRefusal(view);", printLabel);
  const branch = requireIndex(print, "if (exportRefusal) {", printLabel, printRefusal);
  const branchEnd = requireIndex(print, "\n  }\n", printLabel, branch);
  const refusedPage = print.slice(branch, branchEnd);
  assert.match(refusedPage, /return \(/, "the refused shape must answer before the complete rendering");
  assert.match(refusedPage, /<p>\{exportRefusal\}<\/p>/, "the page must say why, in the same words as the PDF route");
  assert.doesNotMatch(refusedPage, /<ReportRenderer|printComplete/);
  assert.ok(branchEnd < requireIndex(print, "<ReportRenderer", printLabel), "the complete rendering follows the refusal");

  // Both controls on a saved page, and the one on a live scan result, are
  // hidden rather than left to answer 422.
  assert.match(
    source("app/_components/report-page-context.tsx"),
    /const pdfHref = completeDocumentExportRefusal\(view\) \? null : reportPdfHref\(id\);/
  );
  assert.match(
    source("app/_components/report-header.tsx"),
    /const pdfHref = completeDocumentExportRefusal\(view\) \? null : reportPdfHref\(share, liveApiServesReportPages\);/
  );
  // The header is client code; the helper must not pull a report reader into it.
  assert.doesNotMatch(source("lib/complete-document-export.ts"), /^import (?!type )/m);
});

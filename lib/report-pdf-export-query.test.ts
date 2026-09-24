import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import ledgerWire from "../public/corrections.json";
import { publishedReportCorrections, publishedReportCorrectionWire } from "./published-report-corrections";
import { reportPdfExportQuery } from "./report-pdf-export-query";

const nodeSha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const evidenceSha256 = "b".repeat(64);

test("the export query binds the correction context first, then the evidence", () => {
  const id = `20260101-${"a".repeat(32)}`;
  assert.equal(
    reportPdfExportQuery(id, evidenceSha256),
    `correctionsSha256=${nodeSha256(publishedReportCorrectionWire(id))}&sha256=${evidenceSha256}`
  );
});

test("the export query omits the evidence binding it was not given", () => {
  const id = `20260101-${"a".repeat(32)}`;
  assert.equal(reportPdfExportQuery(id), `correctionsSha256=${nodeSha256(publishedReportCorrectionWire(id))}`);
});

test("a corrected report binds its own correction context, the bytes the PDF route hashes", () => {
  // Taken from the ledger rather than hard-coded, and required to carry an
  // event: an uncorrected id would pass on the empty-context digest alone.
  const id = ledgerWire.entries[0]?.reportIds[0];
  assert.ok(id, "the committed corrections ledger names no report");
  assert.ok(publishedReportCorrections(id).subjectEvents.length > 0, `${id} has no correction context`);
  const digest = new URLSearchParams(reportPdfExportQuery(id, evidenceSha256)).get("correctionsSha256");
  assert.equal(digest, nodeSha256(publishedReportCorrectionWire(id)));
  assert.notEqual(digest, nodeSha256(publishedReportCorrectionWire(`20260101-${"a".repeat(32)}`)));
});

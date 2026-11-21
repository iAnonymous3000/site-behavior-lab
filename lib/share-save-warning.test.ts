import assert from "node:assert/strict";
import { test } from "node:test";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { SHARE_SAVE_WARNING } from "./share-save-warning";

test("the sanitizer admits the save-failure line exactly as the scanner writes it", () => {
  // lib/redact-scan-report-v1.ts restates this sentence among its fixed
  // warnings. Were the two to drift, the line would be redacted from every
  // saved report while the poller kept keying on it.
  const report = makeScanReportV1();
  report.warnings = [...report.warnings, SHARE_SAVE_WARNING];
  assert.ok(
    redactScanReportV1(report).report.warnings.includes(SHARE_SAVE_WARNING),
    "the sanitizer admits the save-failure line exactly as the scanner writes it"
  );
});

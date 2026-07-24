import assert from "node:assert/strict";
import { test } from "node:test";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import { evidenceProblemUrl, reportActivation } from "./report-trust";
import type { ScanResult } from "./types";

test("report activation links permanent evidence to history but never navigates to a v2 route shape", () => {
  const view = viewFromV2(makePublicSingleReportV2R2(), 2);
  const activation = reportActivation({
    id: "20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    reportUrl: "https://sitebehavior.org/reports/20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    siteHistoryAvailable: true,
    view
  });

  assert.equal(activation.profilePath, "/sites/example.com");
  assert.equal(activation.exactRescanHref, null);
  const issue = new URL(activation.evidenceIssueUrl);
  assert.equal(issue.origin + issue.pathname, "https://github.com/iAnonymous3000/site-behavior-lab/issues/new");
  assert.equal(issue.searchParams.get("template"), "evidence-problem.yml");
  assert.match(issue.searchParams.get("title") ?? "", /^Evidence review: example\.com/);
  assert.match(issue.searchParams.get("report") ?? "", /^20260721-a{32} \(https:\/\/sitebehavior\.org\/reports\//);
  assert.equal(issue.searchParams.get("scan_date"), "2026-07-09T10:00:00.000Z");
  assert.equal(issue.searchParams.has("body"), false);
});

test("legacy reports offer an exact-route rescan only for a safe recorded URL", () => {
  const legacy = makeScanReportV1() as ScanResult;
  legacy.conditions.requestedUrl = "https://www.example.com/account/settings";
  const view = viewFromV1Report(legacy);
  const activation = reportActivation({
    id: "legacy-id",
    reportUrl: "https://sitebehavior.org/reports/legacy-id/",
    siteHistoryAvailable: true,
    view
  });
  assert.equal(
    activation.exactRescanHref,
    "/#scan?url=https%3A%2F%2Fwww.example.com%2Faccount%2Fsettings"
  );

  legacy.conditions.requestedUrl = "https://example.com/{seg}/settings";
  const redacted = reportActivation({
    id: "legacy-id",
    reportUrl: "https://sitebehavior.org/reports/legacy-id/",
    siteHistoryAvailable: true,
    view: viewFromV1Report(legacy)
  });
  assert.equal(redacted.exactRescanHref, null);
});

test("time-limited share reports never advertise a corpus profile that may not exist", () => {
  const view = viewFromV2(makePublicSingleReportV2R2(), 2);
  const activation = reportActivation({
    id: "20260721-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    reportUrl: "https://sitebehavior.org/reports/20260721-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
    siteHistoryAvailable: false,
    view
  });
  assert.equal(activation.profilePath, null);
});

test("evidence issue fields cannot inject extra query parameters or multiline markdown", () => {
  const issue = new URL(
    evidenceProblemUrl({
      id: "id\n`spoof`&template=blank",
      domain: "example.com\n### forged",
      reportUrl: "https://sitebehavior.org/report\ncc:secret",
      scannedAt: "not-a-date"
    })
  );
  assert.equal(issue.searchParams.get("template"), "evidence-problem.yml");
  assert.doesNotMatch(issue.searchParams.get("title") ?? "", /[\r\n]/);
  assert.equal(issue.searchParams.get("scan_date"), "not recorded");
  assert.doesNotMatch(issue.searchParams.get("report") ?? "", /[\r\n`]/);
  assert.equal(issue.searchParams.has("body"), false);
});

test("evidence issue form prefills required identity fields even when optional context is blank", () => {
  const issue = new URL(
    evidenceProblemUrl({
      id: "",
      domain: "",
      reportUrl: "",
      scannedAt: null
    })
  );
  assert.equal(issue.searchParams.get("template"), "evidence-problem.yml");
  assert.equal(issue.searchParams.get("report"), "not recorded");
  assert.equal(issue.searchParams.get("scan_date"), "not recorded");
  assert.match(issue.searchParams.get("title") ?? "", /^Evidence review: report/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagedReport } from "./managed-report-reader";
import { planR2RemediationInventory, planR2ReportRemediation } from "./r2-report-remediation";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildReportShare } from "./report-locator";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";

const REPORT_ID = `20260712-${"a".repeat(32)}`;
const OTHER_ID = `20260712-${"b".repeat(32)}`;
const CLOCK = {
  createdAt: "2026-07-12T10:00:00.000Z",
  expiresAt: "2026-07-19T10:00:00.000Z"
};
const WRITTEN_AT = "2026-07-12T20:00:00.000Z";

function legacyWire() {
  const report = makeScanReportV1();
  report.share = buildReportShare(REPORT_ID);
  if (report.reportType === "comparison") throw new Error("expected single fixture");
  report.conditions.requestedUrl = "https://example.com/account/alice?token=secret";
  report.conditions.finalUrl = report.conditions.requestedUrl;
  return JSON.stringify(report);
}

test("inventory pairs managed objects and blocks dangling or unknown keys", () => {
  const reportKey = `reports/${REPORT_ID}.json`;
  const otherSidecar = `reports/${OTHER_ID}.json.provenance.json`;
  assert.deepEqual(
    planR2RemediationInventory([
      `${reportKey}.provenance.json`,
      reportKey,
      otherSidecar,
      "reports/not-a-managed-object.json"
    ]),
    {
      reports: [{ reportId: REPORT_ID, reportKey, sidecarKey: `${reportKey}.provenance.json`, sidecarExists: true }],
      issues: [
        { key: otherSidecar, issue: "dangling-sidecar" },
        { key: "reports/not-a-managed-object.json", issue: "unrecognized-object" }
      ]
    }
  );
});

test("legacy live shares plan a fixed-point v3 report and matching managed sidecar", () => {
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: legacyWire(),
    sidecarContents: null,
    retention: CLOCK,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(plan.ok, true);
  if (!plan.ok || plan.action !== "rewrite") throw new Error("expected rewrite plan");
  assert.equal(plan.reportChanged, true);
  assert.deepEqual(plan.retention, CLOCK);

  const managed = readManagedReport({
    reportId: REPORT_ID,
    reportContents: plan.reportWire,
    sidecarContents: plan.sidecarWire,
    retention: CLOCK
  });
  assert.equal(managed.ok, true);

  const fixedPoint = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: plan.reportWire,
    sidecarContents: plan.sidecarWire,
    retention: CLOCK,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(fixedPoint.ok, true);
  if (!fixedPoint.ok) throw new Error("expected fixed point");
  assert.equal(fixedPoint.action, "current");
  assert.deepEqual(fixedPoint.retention, CLOCK);

  const sidecarOnly = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: plan.reportWire,
    sidecarContents: null,
    retention: CLOCK,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(sidecarOnly.ok, true);
  if (!sidecarOnly.ok || sidecarOnly.action !== "rewrite") throw new Error("expected sidecar-only rewrite plan");
  assert.equal(sidecarOnly.reportChanged, false);
});

test("missing and malformed retention metadata block remediation", () => {
  const base = {
    reportId: REPORT_ID,
    reportContents: legacyWire(),
    sidecarContents: null,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  };
  assert.deepEqual(planR2ReportRemediation({ ...base, retention: null }), {
    ok: false,
    reportId: REPORT_ID,
    issue: "missing-retention-metadata"
  });
  assert.deepEqual(
    planR2ReportRemediation({ ...base, retention: { ...CLOCK, expiresAt: "not-a-timestamp" } }),
    { ok: false, reportId: REPORT_ID, issue: "malformed-retention-metadata" }
  );
  assert.deepEqual(
    planR2ReportRemediation({ ...base, retention: { ...CLOCK, expiresAt: CLOCK.createdAt } }),
    { ok: false, reportId: REPORT_ID, issue: "malformed-retention-metadata" }
  );
});

test("expired objects are reported without generating replacement wires or extending clocks", () => {
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: "not even parsed for an expired object",
    sidecarContents: null,
    retention: CLOCK,
    writtenAt: "2026-07-20T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z"
  });
  assert.deepEqual(plan, { ok: true, reportId: REPORT_ID, action: "expired", retention: CLOCK });
  assert.equal("reportWire" in plan, false);
  assert.equal("sidecarWire" in plan, false);
});

test("foreign embedded share identity blocks the whole-object rewrite", () => {
  const report = makeScanReportV1();
  report.share = buildReportShare(OTHER_ID);
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: JSON.stringify(report),
    sidecarContents: null,
    retention: CLOCK,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.deepEqual(plan, { ok: false, reportId: REPORT_ID, issue: "report-identity-changed" });
});

test("legacy v2 cannot be blessed as redaction v3 while current v2 can be re-attested", () => {
  const old = makePublicSingleReportV2();
  old.share = buildReportShare(REPORT_ID);
  const rejected = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: JSON.stringify(old),
    sidecarContents: null,
    retention: CLOCK,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.deepEqual(rejected, {
    ok: false,
    reportId: REPORT_ID,
    issue: "unsupported-report-schema",
    detail: "redaction-version-mismatch"
  });

  old.run.privacy.redactionVersion = REDACTION_VERSION;
  const accepted = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: JSON.stringify(old),
    sidecarContents: null,
    retention: CLOCK,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) throw new Error("expected current-v2 remediation");
  assert.equal(accepted.action, "rewrite");
});

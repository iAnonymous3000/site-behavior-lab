import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagedReport } from "./managed-report-reader";
import {
  historicalR2MaxAgeDays,
  planR2RemediationInventory,
  planR2ReportRemediation,
  r2ReportRetentionSource
} from "./r2-report-remediation";
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
const METADATA_SOURCE = { kind: "metadata" as const, retention: CLOCK };

test("historical max age defaults only when omitted and rejects explicit invalid values", () => {
  assert.equal(historicalR2MaxAgeDays(undefined), 7);
  assert.equal(historicalR2MaxAgeDays(""), 7);
  assert.equal(historicalR2MaxAgeDays("30"), 30);
  assert.throws(() => historicalR2MaxAgeDays("not-a-number"), /positive number/);
  assert.throws(() => historicalR2MaxAgeDays("0"), /positive number/);
});

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
    retentionSource: METADATA_SOURCE,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(plan.ok, true);
  if (!plan.ok || plan.action !== "rewrite") throw new Error("expected rewrite plan");
  assert.equal(plan.reportChanged, true);
  assert.equal(plan.reportWriteRequired, true);
  assert.equal(plan.retentionOrigin, "metadata");
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
    retentionSource: METADATA_SOURCE,
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
    retentionSource: METADATA_SOURCE,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(sidecarOnly.ok, true);
  if (!sidecarOnly.ok || sidecarOnly.action !== "rewrite") throw new Error("expected sidecar-only rewrite plan");
  assert.equal(sidecarOnly.reportChanged, false);
  assert.equal(sidecarOnly.reportWriteRequired, false);
});

test("missing, partial, conflicting, and malformed retention metadata remain fail-closed", () => {
  const base = {
    reportId: REPORT_ID,
    reportContents: legacyWire(),
    sidecarContents: null,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  };
  assert.deepEqual(planR2ReportRemediation({
    ...base,
    retentionSource: r2ReportRetentionSource(undefined, null, 7)
  }), {
    ok: false,
    reportId: REPORT_ID,
    issue: "missing-retention-metadata",
    detail: "missing R2 upload clock"
  });
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      retentionSource: r2ReportRetentionSource(
        { "created-at": CLOCK.createdAt, "expires-at": "not-a-timestamp" },
        CLOCK.createdAt,
        7
      )
    }),
    { ok: false, reportId: REPORT_ID, issue: "malformed-retention-metadata" }
  );
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      retentionSource: r2ReportRetentionSource({ "created-at": CLOCK.createdAt }, CLOCK.createdAt, 7)
    }),
    { ok: false, reportId: REPORT_ID, issue: "malformed-retention-metadata" }
  );
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      retentionSource: r2ReportRetentionSource(
        { "created-at": CLOCK.createdAt, createdAt: "2026-07-12T11:00:00.000Z", "expires-at": CLOCK.expiresAt },
        CLOCK.createdAt,
        7
      )
    }),
    { ok: false, reportId: REPORT_ID, issue: "malformed-retention-metadata" }
  );
});

test("metadata-free legacy shares derive the exact historical seven-day clock from R2 uploaded", () => {
  const uploadedAt = "2026-07-10T03:04:05.678Z";
  const retention = {
    createdAt: uploadedAt,
    expiresAt: "2026-07-17T03:04:05.678Z"
  };
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: legacyWire(),
    sidecarContents: null,
    retentionSource: r2ReportRetentionSource({ owner: "scanner" }, uploadedAt, 7),
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(plan.ok, true);
  if (!plan.ok || plan.action !== "rewrite") throw new Error("expected legacy rewrite plan");
  assert.equal(plan.retentionOrigin, "legacy-uploaded");
  assert.deepEqual(plan.retention, retention);
  assert.equal(plan.reportWriteRequired, true);

  assert.equal(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: plan.reportWire,
      sidecarContents: plan.sidecarWire,
      retention
    }).ok,
    true
  );

  const fixedPoint = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: plan.reportWire,
    sidecarContents: plan.sidecarWire,
    retentionSource: { kind: "metadata", retention: plan.retention },
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(fixedPoint.ok, true);
  if (!fixedPoint.ok || fixedPoint.action === "expired") throw new Error("expected migrated fixed point");
  assert.equal(fixedPoint.action, "current");
  assert.equal(fixedPoint.reportWriteRequired, false);
});

test("legacy derivation honors the configured historical lifetime instead of restarting at apply", () => {
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: legacyWire(),
    sidecarContents: null,
    retentionSource: r2ReportRetentionSource(undefined, "2026-07-10T03:04:05.678Z", 2.5),
    writtenAt: WRITTEN_AT,
    now: "2026-07-11T20:00:00.000Z"
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("expected configured legacy clock");
  assert.deepEqual(plan.retention, {
    createdAt: "2026-07-10T03:04:05.678Z",
    expiresAt: "2026-07-12T15:04:05.678Z"
  });
});

test("legacy clocks reject sidecars, future uploads, and invalid historical lifetimes as ambiguous", () => {
  const base = {
    reportId: REPORT_ID,
    reportContents: legacyWire(),
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  };
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      sidecarContents: "{}",
      retentionSource: r2ReportRetentionSource(undefined, CLOCK.createdAt, 7)
    }),
    {
      ok: false,
      reportId: REPORT_ID,
      issue: "ambiguous-legacy-retention",
      detail: "metadata-free object already has a sidecar"
    }
  );
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      sidecarContents: null,
      retentionSource: r2ReportRetentionSource(undefined, "2026-07-13T00:00:00.000Z", 7)
    }),
    {
      ok: false,
      reportId: REPORT_ID,
      issue: "ambiguous-legacy-retention",
      detail: "R2 upload clock is after the operator clock"
    }
  );
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      sidecarContents: null,
      retentionSource: r2ReportRetentionSource(undefined, "not-a-timestamp", 7)
    }),
    {
      ok: false,
      reportId: REPORT_ID,
      issue: "malformed-retention-metadata",
      detail: "invalid R2 upload clock"
    }
  );
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      sidecarContents: null,
      retentionSource: r2ReportRetentionSource(undefined, CLOCK.createdAt, 0)
    }),
    {
      ok: false,
      reportId: REPORT_ID,
      issue: "malformed-retention-metadata",
      detail: "invalid historical max age"
    }
  );
  assert.deepEqual(
    planR2ReportRemediation({
      ...base,
      sidecarContents: null,
      retentionSource: r2ReportRetentionSource(undefined, CLOCK.createdAt, Number.MAX_VALUE)
    }),
    {
      ok: false,
      reportId: REPORT_ID,
      issue: "malformed-retention-metadata",
      detail: "historical max age overflows"
    }
  );
});

test("expired objects are reported without generating replacement wires or extending clocks", () => {
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: "not even parsed for an expired object",
    sidecarContents: null,
    retentionSource: METADATA_SOURCE,
    writtenAt: "2026-07-20T00:00:00.000Z",
    now: "2026-07-20T00:00:00.000Z"
  });
  assert.deepEqual(plan, {
    ok: true,
    reportId: REPORT_ID,
    action: "expired",
    retentionOrigin: "metadata",
    retention: CLOCK
  });
  assert.equal("reportWire" in plan, false);
  assert.equal("sidecarWire" in plan, false);
});

test("expired metadata-free legacy objects are classified from uploaded without parsing or rewriting", () => {
  const uploadedAt = "2026-07-01T10:00:00.000Z";
  const plan = planR2ReportRemediation({
    reportId: REPORT_ID,
    reportContents: "invalid bytes are irrelevant after trustworthy expiry",
    sidecarContents: null,
    retentionSource: r2ReportRetentionSource(undefined, uploadedAt, 7),
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.deepEqual(plan, {
    ok: true,
    reportId: REPORT_ID,
    action: "expired",
    retentionOrigin: "legacy-uploaded",
    retention: { createdAt: uploadedAt, expiresAt: "2026-07-08T10:00:00.000Z" }
  });
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
    retentionSource: METADATA_SOURCE,
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
    retentionSource: METADATA_SOURCE,
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
    retentionSource: METADATA_SOURCE,
    writtenAt: WRITTEN_AT,
    now: WRITTEN_AT
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) throw new Error("expected current-v2 remediation");
  assert.equal(accepted.action, "rewrite");
});

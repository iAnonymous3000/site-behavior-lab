import assert from "node:assert/strict";
import { test } from "node:test";
import { readManagedReport } from "./managed-report-reader";
import { buildProvenanceEntry } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildReportShare, buildStaticReportShare } from "./report-locator";
import {
  REPORT_RESOURCE_LIMITS,
  hasSafeReportCollections
} from "./report-resource-policy";
import { currentR2NormalizationForObserver } from "./scan-report-v2-normalization";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import {
  r2ReportRuns,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import { consentInteractionWarning } from "./consent-interaction";

const REPORT_ID = "20260712-" + "a".repeat(32);
const RETENTION = {
  createdAt: "2026-07-12T10:00:00.000Z",
  expiresAt: "2026-07-19T10:00:00.000Z"
};

function managedParts() {
  const report = makePublicSingleReportV2();
  report.run.privacy.redactionVersion = REDACTION_VERSION;
  const reportContents = `${JSON.stringify(report, null, 2)}\n`;
  const sidecar = buildProvenanceEntry({
    reportId: REPORT_ID,
    publicReport: report,
    writtenAt: RETENTION.createdAt,
    createdAt: RETENTION.createdAt,
    expiresAt: RETENTION.expiresAt
  });
  return { report, reportContents, sidecar, sidecarContents: `${JSON.stringify(sidecar)}\n` };
}

test("a managed report requires a matching current sidecar and immutable retention metadata", () => {
  const parts = managedParts();
  const read = readManagedReport({
    reportId: REPORT_ID,
    reportContents: parts.reportContents,
    sidecarContents: parts.sidecarContents,
    retention: RETENTION
  });
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("expected managed report");
  assert.equal(read.wire, parts.reportContents);
  assert.equal(read.provenance.reportId, REPORT_ID);
  assert.deepEqual(read.retention, RETENTION);
});

test("the managed reader rejects an active detector outcome with no causal loss", () => {
  const report = makePublicSingleReportV2R2();
  report.run.detectors["cname-uncloaking"] = {
    ...report.run.detectors["cname-uncloaking"],
    status: "partial",
    reason: "evidence-cap-reached",
    phaseId: 0
  };
  report.run.fingerprints = buildFingerprints({
    conditions: report.run.conditions,
    provenance: report.run.provenance,
    toolchain: report.run.toolchain,
    detectors: report.run.detectors
  });
  const read = readManagedReport({
    reportId: REPORT_ID,
    reportContents: JSON.stringify(report),
    sidecarContents: null,
    retention: RETENTION
  });
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.reason, "invalid-report");
    assert.match(read.violations?.join("\n") ?? "", /cname-uncloaking lacks causal/);
  }
});

test("the managed reader supports committed-report sidecars with no expiry", () => {
  const report = makePublicSingleReportV2();
  report.run.privacy.redactionVersion = REDACTION_VERSION;
  report.share = buildStaticReportShare(REPORT_ID);
  const clock = { createdAt: RETENTION.createdAt, expiresAt: null };
  const sidecar = buildProvenanceEntry({
    reportId: REPORT_ID,
    publicReport: report,
    writtenAt: RETENTION.createdAt,
    createdAt: clock.createdAt,
    expiresAt: null
  });
  const read = readManagedReport({
    reportId: REPORT_ID,
    reportContents: JSON.stringify(report),
    sidecarContents: JSON.stringify(sidecar),
    retention: clock
  });
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("expected committed managed report");
  assert.equal(read.retention.expiresAt, null);
});

test("a current sidecar cannot bless an older embedded v2 redaction revision", () => {
  const report = makePublicSingleReportV2();
  assert.notEqual(report.run.privacy.redactionVersion, REDACTION_VERSION);
  const sidecar = buildProvenanceEntry({
    reportId: REPORT_ID,
    publicReport: report,
    writtenAt: RETENTION.createdAt,
    createdAt: RETENTION.createdAt,
    expiresAt: RETENTION.expiresAt
  });
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(report),
      sidecarContents: JSON.stringify(sidecar),
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "redaction-version-mismatch" }
  );
});

test("a current sidecar cannot bless an older redaction revision in an r2 supporting-pair arm", () => {
  let report = makeSupportingPairInterventionReportV2R2();
  for (const run of r2ReportRuns(report)) {
    run.privacy.redactionVersion = REDACTION_VERSION;
    const normalization = currentR2NormalizationForObserver(run.provenance.observer);
    if (normalization === null) throw new Error("fixture observer must have a current normalization");
    run.toolchain.normalizationVersion = normalization;
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  const sanitized = redactPublicScanReportV2R2(report);
  if (sanitized.reportType !== "comparison") throw new Error("expected comparison fixture");
  report = sanitized;
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention fixture");
  const supportingPair = report.experiment.supportingPairs?.[0];
  assert.ok(supportingPair);

  const read = () => {
    const sidecar = buildProvenanceEntry({
      reportId: REPORT_ID,
      publicReport: report,
      writtenAt: RETENTION.createdAt,
      createdAt: RETENTION.createdAt,
      expiresAt: RETENTION.expiresAt
    });
    return readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(report),
      sidecarContents: JSON.stringify(sidecar),
      retention: RETENTION
    });
  };

  assert.equal(read().ok, true);
  supportingPair.variant.privacy.redactionVersion = REDACTION_VERSION - 1;
  assert.deepEqual(read(), { ok: false, error: "invalid", reason: "redaction-version-mismatch" });
});

test("a current sidecar cannot bless r2 bytes that only relabel unsafe evidence as v4", () => {
  let report = makeSupportingPairInterventionReportV2R2();
  for (const run of r2ReportRuns(report)) {
    run.privacy.redactionVersion = REDACTION_VERSION;
    const normalization = currentR2NormalizationForObserver(run.provenance.observer);
    if (normalization === null) throw new Error("fixture observer must have a current normalization");
    run.toolchain.normalizationVersion = normalization;
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  const sanitized = redactPublicScanReportV2R2(report);
  if (sanitized.reportType !== "comparison") throw new Error("expected comparison fixture");
  report = sanitized;
  report.baseline.summary.pageTitle = "Alice's private account";
  const sidecar = buildProvenanceEntry({
    reportId: REPORT_ID,
    publicReport: report,
    writtenAt: RETENTION.createdAt,
    createdAt: RETENTION.createdAt,
    expiresAt: RETENTION.expiresAt
  });
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(report),
      sidecarContents: JSON.stringify(sidecar),
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "redaction-not-idempotent" }
  );
});

test("partial and malformed managed states fail closed", () => {
  const parts = managedParts();
  const base = { reportId: REPORT_ID, reportContents: parts.reportContents, retention: RETENTION };

  assert.equal(readManagedReport({ ...base, sidecarContents: null }).ok, false);
  assert.deepEqual(readManagedReport({ ...base, sidecarContents: "{" }), {
    ok: false,
    error: "invalid",
    reason: "invalid-sidecar-json"
  });
  assert.deepEqual(readManagedReport({ ...base, sidecarContents: "{}" }), {
    ok: false,
    error: "invalid",
    reason: "malformed-sidecar"
  });
  assert.deepEqual(
    readManagedReport({ ...base, reportContents: "{", sidecarContents: parts.sidecarContents }),
    { ok: false, error: "invalid", reason: "invalid-report-json" }
  );
});

test("managed reports reject amplified arrays, strings, and property sets before validation", () => {
  const payloads: unknown[] = [
    {
      schemaVersion: 1,
      extra: Array.from({ length: REPORT_RESOURCE_LIMITS.maxAnyArray + 1 }, () => 0)
    },
    {
      schemaVersion: 1,
      extra: "x".repeat(REPORT_RESOURCE_LIMITS.maxAnyStringChars + 1)
    },
    {
      schemaVersion: 1,
      extra: Object.fromEntries(
        Array.from(
          { length: REPORT_RESOURCE_LIMITS.maxObjectProperties + 1 },
          (_, index) => [`property${index}`, 0]
        )
      )
    }
  ];

  for (const payload of payloads) {
    assert.deepEqual(
      readManagedReport({
        reportId: REPORT_ID,
        reportContents: JSON.stringify(payload),
        sidecarContents: null,
        retention: null
      }),
      { ok: false, error: "invalid", reason: "report-resource-limit" }
    );
  }
});

test("the shared managed-report preflight rejects accessors without invoking them", () => {
  let getterCalls = 0;
  const payload = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(payload, "schemaVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    }
  });

  assert.doesNotThrow(() => hasSafeReportCollections(payload));
  assert.equal(hasSafeReportCollections(payload), false);
  assert.equal(getterCalls, 0);
});

test("managed reports reject nested duplicate keys before canonical digesting or serving", () => {
  const parts = managedParts();
  const duplicateReport = parts.reportContents.replace(
    /"pageTitle":\s*"[^"]*"/,
    '"pageTitle":"Alice private account token","pageTitle":""'
  );
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: duplicateReport,
      sidecarContents: parts.sidecarContents,
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "invalid-report-json" }
  );

  const duplicateNestedSidecar = parts.sidecarContents.replace(
    "{",
    '{"ignored":{"secret":"Alice","secret":""},'
  );
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: parts.reportContents,
      sidecarContents: duplicateNestedSidecar,
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "invalid-sidecar-json" }
  );
});

test("wrong id, version, digest, or retention metadata fails closed", () => {
  const parts = managedParts();
  const read = (sidecar: unknown, retention = RETENTION) =>
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: parts.reportContents,
      sidecarContents: JSON.stringify(sidecar),
      retention
    });

  assert.deepEqual(read({ ...parts.sidecar, reportId: "20260712-" + "b".repeat(32) }), {
    ok: false,
    error: "invalid",
    reason: "report-id-mismatch"
  });
  assert.deepEqual(read({ ...parts.sidecar, redactionVersion: REDACTION_VERSION + 1 }), {
    ok: false,
    error: "invalid",
    reason: "redaction-version-mismatch"
  });
  assert.deepEqual(read({ ...parts.sidecar, publicDigest: "0".repeat(64) }), {
    ok: false,
    error: "invalid",
    reason: "digest-mismatch"
  });
  assert.deepEqual(read(parts.sidecar, { ...RETENTION, expiresAt: "2026-07-20T10:00:00.000Z" }), {
    ok: false,
    error: "invalid",
    reason: "retention-metadata-mismatch"
  });
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: parts.reportContents,
      sidecarContents: parts.sidecarContents,
      retention: null
    }),
    { ok: false, error: "invalid", reason: "missing-retention-metadata" }
  );
  assert.deepEqual(read(parts.sidecar, { ...RETENTION, expiresAt: "not-a-timestamp" }), {
    ok: false,
    error: "invalid",
    reason: "malformed-retention-metadata"
  });
});

test("a current sidecar cannot bless unredacted v1 bytes or a foreign embedded share", () => {
  const rawV1 = makeScanReportV1();
  assert.notEqual(rawV1.reportType, "comparison");
  if (rawV1.reportType === "comparison") throw new Error("expected single report fixture");
  rawV1.conditions.requestedUrl = "https://example.com/patients/alice?token=secret";
  rawV1.conditions.finalUrl = rawV1.conditions.requestedUrl;
  const rawSidecar = buildProvenanceEntry({
    reportId: REPORT_ID,
    publicReport: rawV1,
    writtenAt: RETENTION.createdAt,
    createdAt: RETENTION.createdAt,
    expiresAt: RETENTION.expiresAt
  });
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(rawV1),
      sidecarContents: JSON.stringify(rawSidecar),
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "redaction-not-idempotent" }
  );

  const foreignId = "20260712-" + "f".repeat(32);
  const foreignShare = makePublicSingleReportV2();
  foreignShare.share = buildReportShare(foreignId);
  const foreignSidecar = buildProvenanceEntry({
    reportId: REPORT_ID,
    publicReport: foreignShare,
    writtenAt: RETENTION.createdAt,
    createdAt: RETENTION.createdAt,
    expiresAt: RETENTION.expiresAt
  });
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(foreignShare),
      sidecarContents: JSON.stringify(foreignSidecar),
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "share-id-mismatch" }
  );
});

test("managed v1 reports retain historical bare consent labels without reopening click matching", () => {
  for (const matchedText of ["agree", "consent"]) {
    const report = redactScanReportV1(makeScanReportV1()).report;
    if (report.reportType === "comparison") throw new Error("expected single report fixture");
    report.conditions.consentMode = "accept-all";
    report.consentInteraction = { mode: "accept-all", clicked: true, matchedText };
    report.warnings = [
      consentInteractionWarning({ mode: "accept-all", clicked: true, matchedText })
    ];
    const sidecar = buildProvenanceEntry({
      reportId: REPORT_ID,
      publicReport: report,
      writtenAt: RETENTION.createdAt,
      createdAt: RETENTION.createdAt,
      expiresAt: RETENTION.expiresAt
    });

    const read = readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(report),
      sidecarContents: JSON.stringify(sidecar),
      retention: RETENTION
    });
    assert.equal(read.ok, true, `legacy label ${matchedText} should remain a managed fixed point`);
  }
});


test("an unknown producer is diagnosed separately from unsafe report bytes", () => {
  const report = makePublicSingleReportV2R2();
  report.run.privacy.redactionVersion = REDACTION_VERSION;
  assert.ok(report.run.toolchain.adblock);
  report.run.toolchain.adblock.manifestDigest = "c".repeat(64);
  report.run.fingerprints = buildFingerprints(report.run);
  const sidecar = buildProvenanceEntry({ reportId: REPORT_ID, publicReport: report,
    writtenAt: RETENTION.createdAt, createdAt: RETENTION.createdAt, expiresAt: RETENTION.expiresAt });
  const read = readManagedReport({ reportId: REPORT_ID, reportContents: JSON.stringify(report),
    sidecarContents: JSON.stringify(sidecar), retention: RETENTION });
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.reason, "producer-contract-mismatch");
});

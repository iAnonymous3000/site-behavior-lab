import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createConsentComparisonReport,
  createGpcComparisonReport,
  createShieldsComparisonReport,
  createTemporalComparisonReport
} from "./compare-reports";
import { readManagedReport } from "./managed-report-reader";
import { buildProvenanceEntry } from "./redaction-provenance";
import { publicStringPolicyInputs, redactScanReportV1 } from "./redact-scan-report-v1";
import { REDACTION_VERSION } from "./redaction-v2";
import { buildReportShare, buildStaticReportShare } from "./report-locator";
import { readStoredScanReportById } from "./report-store";
import { resolveReportStoreBackend } from "./report-store-backend";
import {
  REPORT_RESOURCE_LIMITS,
  hasSafeReportCollections
} from "./report-resource-policy";
import { currentR2NormalizationForObserver } from "./scan-report-v2-normalization";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import {
  r2ReportRuns,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";
import {
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeScanReportV1
} from "./scan-report-v2-fixtures";
import { readStoredScanReport } from "./scan-report-reader";
import { PUBLIC_SCANNER_EGRESS_LABELS } from "./scanner-egress";
import { consentInteractionWarning } from "./consent-interaction";
import type { ScanReport, ScanResult } from "./types";

const REPORT_ID = "20260712-" + "a".repeat(32);
const RETENTION = {
  createdAt: "2026-07-12T10:00:00.000Z",
  expiresAt: "2026-07-19T10:00:00.000Z"
};

/**
 * A schema-r2 single report the managed reader serves: the fixture declares
 * the current redaction version and is redacted once, since the fixture
 * itself still carries a page title the sanitizer withholds.
 */
function currentManagedReport() {
  const fixture = makePublicSingleReportV2R2();
  fixture.run.privacy.redactionVersion = REDACTION_VERSION;
  const report = redactPublicScanReportV2R2(fixture);
  if (report.reportType !== "single") throw new Error("expected single report fixture");
  return report;
}

/**
 * A schema v2 revision 1 report relabelled as currently redacted, holding
 * strings the current redaction removes: a raw URL with a path token, a query
 * value and a fragment, a page title, a cookie name, and a free-text warning.
 */
function relabelledRevision1ReportWithRawStrings() {
  const report = makePublicSingleReportV2();
  report.run.privacy.redactionVersion = REDACTION_VERSION;
  report.run.evidence.requests[0].url =
    "https://shop.example.com/reset/tok_PLANTED?email=jane.doe@victim-mail.example#frag";
  report.run.summary.pageTitle = "Inbox (3) jane.doe@victim-mail.example";
  report.run.evidence.cookiesFinal.push({
    name: "sess_jane.doe",
    domain: "shop.example.com",
    path: "/u/8675309",
    sameSite: "Lax",
    secure: true,
    httpOnly: true,
    session: true,
    thirdParty: false
  });
  report.run.summary.counts.cookies = 1;
  report.run.warnings.push("Navigation failed for jane.doe@victim-mail.example");
  return report;
}

function managedParts() {
  const report = currentManagedReport();
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
  const report = currentManagedReport();
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
  const report = makePublicSingleReportV2R2();
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

test("a schema v2 revision 1 report is never a managed report, whatever redaction version it declares", () => {
  const read = (report: unknown) => {
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

  // As its producer wrote it, with that producer's redaction version.
  const asProduced = makePublicSingleReportV2();
  assert.notEqual(asProduced.run.privacy.redactionVersion, REDACTION_VERSION);
  // Relabelled as currently redacted and otherwise untouched.
  const relabelled = makePublicSingleReportV2();
  relabelled.run.privacy.redactionVersion = REDACTION_VERSION;
  const relabelledPair = makeInterventionComparisonReportV2();
  relabelledPair.baseline.privacy.redactionVersion = REDACTION_VERSION;
  relabelledPair.variant.privacy.redactionVersion = REDACTION_VERSION;

  for (const report of [relabelledRevision1ReportWithRawStrings(), relabelled, relabelledPair, asProduced]) {
    // The report is a readable revision 1 report: the refusal is the managed
    // reader's rule for the revision, not a malformed fixture. This is also
    // the reader a file a person opens goes through, which keeps reading r1.
    const unmanaged = readStoredScanReport(report);
    assert.equal(unmanaged.ok && unmanaged.stored.schemaVersion === 2 && unmanaged.stored.schemaRevision === 1, true);
    assert.deepEqual(read(report), { ok: false, error: "invalid", reason: "unmanaged-schema-revision" });
  }

  // No sidecar is consulted for a revision the reader does not manage.
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(relabelled),
      sidecarContents: null,
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "unmanaged-schema-revision" }
  );
});

test("a planted schema v2 revision 1 bundle is not served from the share store", async () => {
  // Three objects left in the store by someone who can write to it: a report,
  // a sidecar holding that report's own digest, and its retention clock. The
  // public permalink read (readStoredScanReportById) must not serve them.
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-managed-reader-store-"));
  const previousDir = process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_DIR;
  const previousBackend = process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND;
  process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_DIR = storeDir;
  delete process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND;
  try {
    // Inside every retention window whenever the test runs.
    const now = Date.now();
    const retention = {
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    };
    const plant = async (id: string, report: unknown) => {
      const sidecar = buildProvenanceEntry({
        reportId: id,
        publicReport: report,
        writtenAt: retention.createdAt,
        createdAt: retention.createdAt,
        expiresAt: retention.expiresAt
      });
      const backend = resolveReportStoreBackend();
      await backend.write(id, `${JSON.stringify(report, null, 2)}\n`, retention);
      await backend.writeSidecar(id, `${JSON.stringify(sidecar, null, 2)}\n`);
    };

    // The same three objects around a current report are served, so the
    // refusal below is the revision's and not the planting's.
    const currentId = "20260712-" + "c".repeat(32);
    await plant(currentId, currentManagedReport());
    assert.equal((await readStoredScanReportById(currentId)).outcome, "found");

    const plantedId = "20260712-" + "d".repeat(32);
    const planted = relabelledRevision1ReportWithRawStrings();
    assert.equal(readStoredScanReport(planted).ok, true);
    await plant(plantedId, planted);
    assert.deepEqual(await readStoredScanReportById(plantedId), { outcome: "unreadable", error: "invalid" });
  } finally {
    if (previousDir === undefined) delete process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_DIR;
    else process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_DIR = previousDir;
    if (previousBackend !== undefined) process.env.SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND = previousBackend;
    await rm(storeDir, { recursive: true, force: true });
  }
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
    { ok: false, error: "invalid", reason: "redaction-not-idempotent", redactionFailure: "digest-mismatch" }
  );
});

test("a fixed-point failure names whether the report's content or the build refused it", () => {
  // The reason stays redaction-not-idempotent, which CLIs and verifiers pin.
  // The detail beside it separates a report whose own content is not a fixed
  // point from a refusal the build would give every report alike, so a
  // caller can count the first as the report's and stop on the second.
  const read = (report: ReturnType<typeof makePublicSingleReportV2R2>) => {
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
  const current = () => {
    const report = makePublicSingleReportV2R2();
    report.run.privacy.redactionVersion = REDACTION_VERSION;
    return report;
  };
  const failureOf = (result: ReturnType<typeof readManagedReport>) =>
    result.ok ? null : { reason: result.reason, redactionFailure: result.redactionFailure };

  // Unredacted evidence relabelled as current: redacting it again changes it.
  const unredacted = current();
  unredacted.run.summary.pageTitle = "Alice's private account";
  assert.deepEqual(failureOf(read(unredacted)), {
    reason: "redaction-not-idempotent",
    redactionFailure: "digest-mismatch"
  });

  // A normalization identity this build has never reviewed: the build's
  // refusal, the same for every report that declares it.
  const unreviewed = current();
  unreviewed.run.toolchain.normalizationVersion = "node-r2-unreviewed";
  unreviewed.run.fingerprints = buildFingerprints(unreviewed.run);
  assert.deepEqual(failureOf(read(unreviewed)), {
    reason: "redaction-not-idempotent",
    redactionFailure: "unreviewed-normalization-identity"
  });

  // A subject redaction would rename: a tenant label under a private suffix.
  const tenant = current();
  tenant.run.subject.observed = {
    origin: "https://{label}.akamaihd.net",
    registrableDomain: "198-51-100-7-clienttons-s.akamaihd.net",
    routeShape: "/"
  };
  assert.deepEqual(failureOf(read(tenant)), {
    reason: "redaction-not-idempotent",
    redactionFailure: "unsafe-subject-identity"
  });

  // Every other reason carries no detail.
  assert.deepEqual(
    readManagedReport({
      reportId: REPORT_ID,
      reportContents: JSON.stringify(current()),
      sidecarContents: null,
      retention: RETENTION
    }),
    { ok: false, error: "invalid", reason: "no-sidecar" }
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
  // Each refusal names the limit it broke and where, so an operator log can
  // say why a finished scan was not persisted.
  const payloads: Array<[unknown, { limit: string; path: string }]> = [
    [
      {
        schemaVersion: 1,
        extra: Array.from({ length: REPORT_RESOURCE_LIMITS.maxAnyArray + 1 }, () => 0)
      },
      { limit: "maxAnyArray", path: "$.extra" }
    ],
    [
      {
        schemaVersion: 1,
        extra: "x".repeat(REPORT_RESOURCE_LIMITS.maxAnyStringChars + 1)
      },
      { limit: `string-chars:${REPORT_RESOURCE_LIMITS.maxAnyStringChars}`, path: "$.extra" }
    ],
    [
      {
        schemaVersion: 1,
        extra: Object.fromEntries(
          Array.from(
            { length: REPORT_RESOURCE_LIMITS.maxObjectProperties + 1 },
            (_, index) => [`property${index}`, 0]
          )
        )
      },
      { limit: "maxObjectProperties", path: "$.extra" }
    ]
  ];

  for (const [payload, resourceViolation] of payloads) {
    assert.deepEqual(
      readManagedReport({
        reportId: REPORT_ID,
        reportContents: JSON.stringify(payload),
        sidecarContents: null,
        retention: null
      }),
      { ok: false, error: "invalid", reason: "report-resource-limit", resourceViolation }
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
    { ok: false, error: "invalid", reason: "redaction-not-idempotent", redactionFailure: "digest-mismatch" }
  );

  const foreignId = "20260712-" + "f".repeat(32);
  const foreignShare = makePublicSingleReportV2R2();
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


function readWithOwnSidecar(report: unknown) {
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
}

test("a Node run's egress label is held to the scanner's public labels", () => {
  const withLabel = (label: string) => {
    const fixture = makePublicSingleReportV2R2();
    fixture.run.privacy.redactionVersion = REDACTION_VERSION;
    fixture.run.conditions.egress.label = label;
    fixture.run.fingerprints = buildFingerprints(fixture.run);
    return redactPublicScanReportV2R2(fixture);
  };

  // Every label the scanner can resolve an operator's setting to still reads.
  for (const label of PUBLIC_SCANNER_EGRESS_LABELS) {
    assert.equal(readWithOwnSidecar(withLabel(label)).ok, true, `public egress label ${label} must stay readable`);
  }

  // Any other text is a fixed point of the sanitizer, which copies the label,
  // so only this list refuses it.
  const planted = withLabel("scanner run for jane.doe@victim-mail.example");
  assert.equal(
    JSON.stringify(redactPublicScanReportV2R2(planted)),
    JSON.stringify(planted),
    "the planted label must survive the sanitizer for this test to mean anything"
  );
  assert.deepEqual(readWithOwnSidecar(planted), {
    ok: false,
    error: "invalid",
    reason: "producer-vocabulary-mismatch"
  });

  // One arm of a pair is enough.
  const pair = makeGpcInterventionReportV2R2();
  for (const run of r2ReportRuns(pair)) run.privacy.redactionVersion = REDACTION_VERSION;
  assert.equal(readWithOwnSidecar(redactPublicScanReportV2R2(pair)).ok, true);
  pair.variant.conditions.egress.label = "variant arm from 203.0.113.7";
  pair.variant.fingerprints = buildFingerprints(pair.variant);
  assert.deepEqual(readWithOwnSidecar(redactPublicScanReportV2R2(pair)), {
    ok: false,
    error: "invalid",
    reason: "producer-vocabulary-mismatch"
  });
});

test("a v1 comparison's run names are held to the reviewed run labels", () => {
  const arm = (
    scannedAt: string,
    consent?: { mode: "accept-all" | "reject-all"; clicked: boolean }
  ): ScanResult => {
    const report = redactScanReportV1(makeScanReportV1()).report;
    if (report.reportType === "comparison") throw new Error("expected single report fixture");
    report.conditions.scannedAt = scannedAt;
    if (consent) {
      const interaction = consent.clicked ? { ...consent, cmp: "OneTrust" } : consent;
      report.conditions.consentMode = consent.mode;
      report.consentInteraction = interaction;
      report.warnings = [consentInteractionWarning(interaction)];
    }
    return report;
  };
  const first = "2026-07-09T10:00:00.000Z";
  const second = "2026-07-09T10:01:00.000Z";

  // Every comparison the producers write is redacted and read back, so a
  // producer whose run names leave the reviewed labels fails here and not at
  // a visitor's save.
  const produced: ScanReport[] = [
    createGpcComparisonReport(arm(first), arm(second), { executedFirst: "baseline" }),
    createShieldsComparisonReport(arm(first), arm(second), { executedFirst: "variant" }),
    createTemporalComparisonReport(arm(first), arm(second)),
    ...[
      [true, true],
      [true, false],
      [false, true],
      [false, false]
    ].map(([accepted, rejected]) =>
      createConsentComparisonReport(
        arm(first, { mode: "accept-all", clicked: accepted }),
        arm(second, { mode: "reject-all", clicked: rejected }),
        { executedFirst: "baseline" }
      )
    )
  ];
  const reviewed = new Set(publicStringPolicyInputs().warningLabels);
  for (const comparison of produced) {
    if (comparison.reportType !== "comparison" || comparison.runLabels === undefined) {
      throw new Error("expected a comparison with run labels");
    }
    assert.equal(reviewed.has(comparison.runLabels.baseline), true, comparison.runLabels.baseline);
    assert.equal(reviewed.has(comparison.runLabels.variant), true, comparison.runLabels.variant);
    const read = readWithOwnSidecar(redactScanReportV1(comparison).report);
    assert.equal(read.ok, true, `${comparison.title} must stay readable${read.ok ? "" : ` (${read.reason})`}`);
  }

  // A run name outside the labels is a fixed point of the sanitizer, which
  // only bounds its length, so only this list refuses it.
  for (const side of ["baseline", "variant"] as const) {
    const planted = redactScanReportV1(produced[0]).report;
    if (planted.reportType !== "comparison" || planted.runLabels === undefined) {
      throw new Error("expected a comparison with run labels");
    }
    planted.runLabels[side] = "Visit ordered by jane.doe@victim-mail.example";
    assert.equal(
      JSON.stringify(redactScanReportV1(planted).report),
      JSON.stringify(planted),
      "the planted run name must survive the sanitizer for this test to mean anything"
    );
    assert.deepEqual(readWithOwnSidecar(planted), {
      ok: false,
      error: "invalid",
      reason: "producer-vocabulary-mismatch"
    });
  }

  // A v1 comparison from before run names existed carries none and still reads.
  const unnamed = redactScanReportV1(produced[0]).report;
  if (unnamed.reportType !== "comparison") throw new Error("expected a comparison");
  delete unnamed.runLabels;
  assert.equal(readWithOwnSidecar(unnamed).ok, true);
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { publicReportDigest } from "./canonical-json";
import { buildProvenanceEntry } from "./redaction-provenance";
import { readManagedReport } from "./managed-report-reader";
import {
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX,
  SUPERSEDED_R2_NORMALIZATIONS
} from "./scan-report-v2-normalization";
import {
  MIGRATABLE_REDACTION_VERSION,
  R2RedactionRemediationError,
  r2RemediationPreservesIdentity,
  r2ReportRuns,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import {
  makeConsentSingleReportV2R2,
  makeDescriptiveReportV2R2,
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { REDACTION_VERSION } from "./redaction-v2";
import { findTrackerMatch } from "./tracker-catalog";
import {
  HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION,
  HISTORICAL_NODE_R2_V3_ADBLOCK_IDENTITY,
  HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST,
  HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION,
  HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS,
  HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V3_TRACKER_CATALOG,
  HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION,
  HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION,
  NODE_R2_PUBLIC_LIMITS,
  NODE_R2_PRODUCER_TUPLES
} from "./scan-report-v2-r2-producer-contract";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";

const LEGACY_NODE_NORMALIZATION = [
  ...MIGRATABLE_REDACTION_V3_NORMALIZATIONS["node-playwright"]
][0];

test("a committed historical Node v3 report remains readable after producer epochs advance", () => {
  const reportId = "20260714-be94cc2d911e26d027950a336147917e";
  const reportContents = readFileSync(path.join(process.cwd(), "public", "reports", `${reportId}.json`), "utf8");
  const sidecarContents = readFileSync(
    path.join(process.cwd(), "public", "reports", `${reportId}.provenance.json`),
    "utf8"
  );
  const sidecar = JSON.parse(sidecarContents) as { createdAt: string; expiresAt: string | null };
  const read = readManagedReport({
    reportId,
    reportContents,
    sidecarContents,
    retention: { createdAt: sidecar.createdAt, expiresAt: sidecar.expiresAt }
  });
  assert.equal(read.ok, true);
});

function markHistoricalNodeV3(run: ScanRunV2R2): void {
  run.privacy.redactionVersion = MIGRATABLE_REDACTION_VERSION;
  run.toolchain.normalizationVersion = LEGACY_NODE_NORMALIZATION;
  run.provenance.methodologyVersion = HISTORICAL_NODE_R2_V3_METHODOLOGY_VERSION;
  run.provenance.detectorRegistry = {
    version: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_VERSION,
    digest: HISTORICAL_NODE_R2_V3_DETECTOR_REGISTRY_DIGEST
  };
  run.toolchain.trackerCatalog = { ...HISTORICAL_NODE_R2_V3_TRACKER_CATALOG };
  for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
    run.detectors[id] = { ...run.detectors[id], version: HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS[id] };
  }
  if (run.toolchain.adblock !== null) {
    run.toolchain.adblock = {
      ...HISTORICAL_NODE_R2_V3_ADBLOCK_IDENTITY,
      engineVersion: HISTORICAL_NODE_R2_V3_ADBLOCK_ENGINE_VERSION
    };
  }
}

function legacyV3Report() {
  const report = makeSupportingPairInterventionReportV2R2();
  for (const run of r2ReportRuns(report)) {
    markHistoricalNodeV3(run);
    run.summary.pageTitle = "Anna Schmidt's private dashboard";
    run.subject.requested.origin = "https://shop.example.com:8443";
    run.subject.observed.origin = "https://shop.example.com:8443";
    run.evidence.requests[0] = {
      ...run.evidence.requests[0],
      url: "http://192.168.1.37:8080/patient/abc",
      domain: "192.168.1.37",
      provenance: {
        graphRecordId: "id-000001",
        initiatorUrl: "http://[fd00::a:b:c:d]:3000/secret",
        initiatorDomain: "[fd00::a:b:c:d]"
      }
    };
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  return report;
}

function markLegacyV3<T extends ReturnType<typeof makePublicSingleReportV2R2>>(report: T): T {
  for (const run of r2ReportRuns(report)) {
    markHistoricalNodeV3(run);
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  return report;
}

function comprehensiveLegacyV3Report() {
  const report = markLegacyV3(makePublicSingleReportV2R2());
  const run = report.run;
  const tracker = findTrackerMatch("google-analytics.com");
  if (tracker === null) throw new Error("tracker fixture invariant");

  run.conditions.probes.policyVisit = true;
  run.phases.push({ phaseId: 1, kind: "policy-analysis", startedAtMs: 5_000, endedAtMs: 5_100 });
  run.detectors["privacy-policy"] = {
    version: HISTORICAL_NODE_R2_V3_DETECTOR_VERSIONS["privacy-policy"],
    status: "complete",
    phaseId: 1
  };
  run.summary.durationMs = 5_100;
  run.evidence.requests.push({
    id: 2,
    phaseId: 0,
    url: "https://google-analytics.com/collect/alice-account?token=secret",
    domain: "google-analytics.com",
    method: "ALICE-METHOD",
    resourceType: "alice-resource",
    status: 204,
    thirdParty: true,
    tracker,
    provenance: {
      graphRecordId: "alice-graph-id",
      initiatorId: "alice-initiator-id",
      initiatorType: "alice-node-type",
      initiatorUrl: "https://shop.example.com/users/alice?token=secret",
      initiatorDomain: "shop.example.com",
      scriptId: "alice-script-id",
      scriptUrl: "https://shop.example.com/users/alice.js?token=secret",
      scriptDomain: "shop.example.com",
      injectedById: "alice-injector-id",
      injectedByUrl: "https://shop.example.com/users/alice-loader.js?token=secret",
      injectedByDomain: "shop.example.com"
    },
    startedAtMs: 20
  });
  run.evidence.storageMutations.push({
    phaseId: 0,
    op: "added",
    entry: { area: "localStorage", key: "alice@example.com", valueBytes: 10 }
  });
  run.evidence.storageFinal.push({ area: "localStorage", key: "patient-alice-token", valueBytes: 10 });
  run.evidence.fingerprintEvents.push({ phaseId: 0, api: "canvas.measureText", count: 2 });
  run.evidence.cnameCloaks.push({
    host: run.evidence.requests[0].domain,
    cname: "google-analytics.com",
    tracker
  });
  run.evidence.pixelEvents.push({
    phaseId: 0,
    platform: "Meta",
    product: "Meta Pixel",
    events: ["AliceAccountCreated"],
    advancedMatching: ["email"],
    requests: 1
  });
  run.evidence.privacyPolicy = {
    url: "https://shop.example.com/legal/privacy/alice?account=secret",
    claims: [{ kind: "honors-gpc", quote: "A".repeat(300) }],
    mentionedEntities: [tracker.entity, "Alice Private Analytics"],
    unmentionedEntities: ["Alice Private Analytics"],
    policyTextLength: 900_000
  };
  run.fingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
  return report;
}

function comprehensiveLegacyConsentReport() {
  const report = markLegacyV3(makeConsentSingleReportV2R2());
  const consent = report.run.evidence.consent;
  if (consent === undefined) throw new Error("consent fixture invariant");
  consent.cmp = "Alice Private CMP";
  consent.selector = "#alice-private-account";
  consent.matchedText = "Accept for Alice only";
  consent.frameUrl = "https://consent.example.com/accounts/alice?token=secret";
  return report;
}

function redactSingle(report: ReturnType<typeof makePublicSingleReportV2R2>) {
  const redacted = redactPublicScanReportV2R2(report);
  if (redacted.reportType !== "single") throw new Error("single report fixture changed kind");
  return redacted;
}

test("v3 r2 migration sanitizes every embedded run and reaches a v4 fixed point", () => {
  const before = legacyV3Report();
  assert.deepEqual(scanReportV2R2SemanticViolations(before), []);

  const migrated = redactPublicScanReportV2R2(before);
  assert.notEqual(publicReportDigest(migrated), publicReportDigest(before));
  for (const run of r2ReportRuns(migrated)) {
    assert.equal(run.privacy.redactionVersion, REDACTION_VERSION);
    assert.equal(run.summary.pageTitle, "");
    assert.equal(run.subject.requested.origin, "https://shop.example.com");
    assert.equal(run.subject.observed.origin, "https://shop.example.com");
    assert.equal(run.evidence.requests[0].url, "{invalid-url}");
    assert.equal(run.evidence.requests[0].domain, "{invalid-host}");
    assert.equal(run.evidence.requests[0].provenance?.initiatorUrl, "{invalid-url}");
    assert.equal(run.evidence.requests[0].provenance?.initiatorDomain, "{invalid-host}");
    assert.equal(
      run.toolchain.normalizationVersion,
      `${LEGACY_NODE_NORMALIZATION}+${REDACTION_V3_TO_V4_NORMALIZATION_SUFFIX}`
    );
    assert.ok(run.privacy.redaction.malformedUrlsDropped >= 4);
  }
  assert.deepEqual(scanReportV2R2SemanticViolations(migrated), []);

  const fixedPoint = redactPublicScanReportV2R2(migrated);
  assert.equal(publicReportDigest(fixedPoint), publicReportDigest(migrated));
});

test("v3 migration replays every active public evidence sanitizer", () => {
  const source = comprehensiveLegacyV3Report();
  const migrated = redactSingle(source);
  const run = migrated.run;
  const request = run.evidence.requests[1];

  assert.equal(request.method, "OTHER");
  assert.equal(request.resourceType, "other");
  assert.equal(request.provenance?.graphRecordId, "id-000001");
  assert.equal(request.provenance?.initiatorId, "id-000002");
  assert.equal(request.provenance?.initiatorType, "[redacted]");
  assert.equal(request.provenance?.scriptId, "id-000003");
  assert.equal(request.provenance?.injectedById, "id-000004");
  assert.notEqual(run.evidence.storageMutations[0].entry.key, "alice@example.com");
  assert.notEqual(run.evidence.storageFinal[0].key, "patient-alice-token");
  assert.equal(run.evidence.fingerprintEvents[0].api, "canvas.measureText");
  assert.equal(run.evidence.cnameCloaks[0].tracker.entity, "Google");
  assert.deepEqual(run.evidence.pixelEvents[0].events, ["custom event"]);
  assert.equal(run.evidence.privacyPolicy?.claims[0].quote.length, 200);
  assert.deepEqual(run.evidence.privacyPolicy?.mentionedEntities, ["Google"]);
  assert.deepEqual(run.evidence.privacyPolicy?.unmentionedEntities, []);
  assert.equal(run.evidence.privacyPolicy?.policyTextLength, 400_000);
  assert.equal(
    publicReportDigest(redactPublicScanReportV2R2(migrated)),
    publicReportDigest(migrated)
  );
});

test("v3 migration sanitizes consent strings and rejects impossible producer vocabulary", () => {
  const consentReport = comprehensiveLegacyConsentReport();
  const migrated = redactSingle(consentReport);
  const consent = migrated.run.evidence.consent;
  assert.equal(consent?.cmp, "[redacted]");
  assert.equal(consent?.selector, "[redacted]");
  assert.equal(consent?.matchedText, "[redacted]");
  assert.equal(consent?.frameUrl, "https://{label}.example.com/{seg}/{seg}");

  const unknownFingerprint = comprehensiveLegacyV3Report();
  unknownFingerprint.run.evidence.fingerprintEvents[0].api = "AlicePrivateFingerprintAPI";
  assert.throws(
    () => redactPublicScanReportV2R2(unknownFingerprint),
    (error: unknown) =>
      error instanceof R2RedactionRemediationError && error.reason === "sanitizer-rejected-evidence"
  );

  const freeFormConsentFailure = comprehensiveLegacyConsentReport();
  freeFormConsentFailure.run.evidence.consent!.verificationFailureReason = "alice-private-reason";
  assert.throws(
    () => redactPublicScanReportV2R2(freeFormConsentFailure),
    (error: unknown) =>
      error instanceof R2RedactionRemediationError && error.reason === "sanitizer-rejected-evidence"
  );
});

test("managed v4 reads reject forged values in every public evidence family", () => {
  const current = redactSingle(comprehensiveLegacyV3Report());
  const reportId = `20260721-${"c".repeat(32)}`;
  const clock = { createdAt: "2026-07-21T12:00:00.000Z", expiresAt: null };
  const cases: Array<{ name: string; mutate: (report: typeof current) => void }> = [
    { name: "request method", mutate: (report) => { report.run.evidence.requests[1].method = "ALICE-METHOD"; } },
    { name: "request resource type", mutate: (report) => { report.run.evidence.requests[1].resourceType = "alice-resource"; } },
    {
      name: "request provenance id",
      mutate: (report) => { report.run.evidence.requests[1].provenance!.graphRecordId = "alice-private-id"; }
    },
    {
      name: "request tracker vocabulary",
      mutate: (report) => { report.run.evidence.requests[1].tracker!.entity = "Alice Private Tracker"; }
    },
    {
      name: "storage mutation",
      mutate: (report) => { report.run.evidence.storageMutations[0].entry.key = "alice@example.com"; }
    },
    {
      name: "final storage",
      mutate: (report) => { report.run.evidence.storageFinal[0].key = "patient-alice-token"; }
    },
    {
      name: "fingerprint event API",
      mutate: (report) => { report.run.evidence.fingerprintEvents[0].api = "AlicePrivateFingerprintAPI"; }
    },
    {
      name: "CNAME tracker vocabulary",
      mutate: (report) => { report.run.evidence.cnameCloaks[0].tracker.entity = "Alice Private Tracker"; }
    },
    {
      name: "pixel event name",
      mutate: (report) => { report.run.evidence.pixelEvents[0].events = ["AliceAccountCreated"]; }
    },
    {
      name: "privacy-policy quote",
      mutate: (report) => { report.run.evidence.privacyPolicy!.claims[0].quote = "  Alice private quote  "; }
    },
    {
      name: "privacy-policy entity",
      mutate: (report) => { report.run.evidence.privacyPolicy!.mentionedEntities.push("Alice Private Analytics"); }
    }
  ];

  for (const fixture of cases) {
    const forged = structuredClone(current);
    fixture.mutate(forged);
    const sidecar = buildProvenanceEntry({
      reportId,
      publicReport: forged,
      writtenAt: clock.createdAt,
      createdAt: clock.createdAt,
      expiresAt: null
    });
    const read = readManagedReport({
      reportId,
      reportContents: JSON.stringify(forged),
      sidecarContents: JSON.stringify(sidecar),
      retention: clock
    });
    assert.deepEqual(read, { ok: false, error: "invalid", reason: "redaction-not-idempotent" }, fixture.name);
  }
});

test("managed v4 reads reject forged consent interaction strings", () => {
  const current = redactSingle(comprehensiveLegacyConsentReport());
  const reportId = `20260721-${"d".repeat(32)}`;
  const clock = { createdAt: "2026-07-21T12:00:00.000Z", expiresAt: null };
  for (const field of ["cmp", "selector", "matchedText"] as const) {
    const forged = structuredClone(current);
    forged.run.evidence.consent![field] = "Alice Private Consent Value";
    const sidecar = buildProvenanceEntry({
      reportId,
      publicReport: forged,
      writtenAt: clock.createdAt,
      createdAt: clock.createdAt,
      expiresAt: null
    });
    assert.deepEqual(
      readManagedReport({
        reportId,
        reportContents: JSON.stringify(forged),
        sidecarContents: JSON.stringify(sidecar),
        retention: clock
      }),
      { ok: false, error: "invalid", reason: "redaction-not-idempotent" },
      field
    );
  }
});

test("active producer contracts reject Node cap overruns and retired observers", () => {
  const overCap = redactSingle(comprehensiveLegacyV3Report());
  const seed = overCap.run.evidence.requests[0];
  overCap.run.evidence.requests = Array.from(
    { length: NODE_R2_PUBLIC_LIMITS.requests + 1 },
    (_, index) => ({ ...structuredClone(seed), id: index + 1 })
  );
  assert.throws(
    () => redactPublicScanReportV2R2(overCap),
    (error: unknown) =>
      error instanceof R2RedactionRemediationError && error.reason === "sanitizer-rejected-evidence"
  );

  const retired = redactSingle(comprehensiveLegacyV3Report());
  retired.run.provenance.observer = "browser-run-worker";
  retired.run.fingerprints = buildFingerprints({
    conditions: retired.run.conditions,
    provenance: retired.run.provenance,
    toolchain: retired.run.toolchain,
    detectors: retired.run.detectors
  });
  assert.throws(
    () => redactPublicScanReportV2R2(retired),
    (error: unknown) =>
      error instanceof R2RedactionRemediationError && error.reason === "sanitizer-rejected-evidence"
  );
});

test("mixed versions and unreviewed v3 normalization identities fail closed", () => {
  const mixed = legacyV3Report();
  r2ReportRuns(mixed)[0].privacy.redactionVersion = REDACTION_VERSION;
  assert.throws(
    () => redactPublicScanReportV2R2(mixed),
    (error: unknown) => error instanceof R2RedactionRemediationError && error.reason === "mixed-redaction-versions"
  );

  const unreviewed = legacyV3Report();
  for (const run of r2ReportRuns(unreviewed)) {
    run.toolchain.normalizationVersion = `${LEGACY_NODE_NORMALIZATION}+self-declared`;
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  assert.throws(
    () => redactPublicScanReportV2R2(unreviewed),
    (error: unknown) =>
      error instanceof R2RedactionRemediationError && error.reason === "unreviewed-normalization-identity"
  );
});

test("every superseded normalization reads only with its pinned historical producer epoch", () => {
  // Widening the sanitizer's admitted strings retires an identity without
  // invalidating a single published byte: everything the narrower pass emitted
  // is still a fixed point. Those reports must keep reading, and must keep
  // declaring the vocabulary they were actually sanitized under.
  assert.deepEqual(
    Object.keys(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION).sort(),
    [...SUPERSEDED_R2_NORMALIZATIONS["node-playwright"]].sort()
  );
  const playwright161OnlyNormalization = Object.entries(
    HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION
  ).find(([normalization]) => normalization.includes("61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a"));
  assert.deepEqual(playwright161OnlyNormalization?.[1], [
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION
  ]);
  const dualMethodologyNormalization = Object.entries(
    HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION
  ).find(([normalization]) => normalization.includes("68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23"));
  assert.deepEqual(dualMethodologyNormalization?.[1], [
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION
  ]);
  for (const superseded of SUPERSEDED_R2_NORMALIZATIONS["node-playwright"]) {
    assert.notEqual(superseded, NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION);
    const historicalMethodologies = HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[superseded];
    assert.notEqual(historicalMethodologies, undefined);
    for (const historicalMethodology of historicalMethodologies!) {
      // Replay each retired identity from its own frozen producer row rather
      // than one hard-coded epoch: the b68c retirement proved the loop's V4
      // field set silently stops fitting when a later era joins the registry.
      const frozenTuple = NODE_R2_PRODUCER_TUPLES.find(
        (tuple) =>
          tuple.normalizationVersion === superseded &&
          tuple.methodologyVersion === historicalMethodology &&
          tuple.adblockIdentity === null
      );
      assert.notEqual(
        frozenTuple,
        undefined,
        `no frozen no-adblock producer row for ${superseded} + ${historicalMethodology}`
      );
      const report = makePublicSingleReportV2R2();
      for (const run of r2ReportRuns(report)) {
        run.privacy.redactionVersion = REDACTION_VERSION;
        run.toolchain.normalizationVersion = superseded;
        run.provenance.methodologyVersion = historicalMethodology;
        run.provenance.detectorRegistry = { ...frozenTuple!.detectorRegistry };
        run.toolchain.trackerCatalog = { ...frozenTuple!.trackerCatalog };
        run.toolchain.adblock = null;
        for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
          run.detectors[id] = { ...run.detectors[id], version: frozenTuple!.detectorVersions[id] };
        }
        run.fingerprints = buildFingerprints({
          conditions: run.conditions,
          provenance: run.provenance,
          toolchain: run.toolchain,
          detectors: run.detectors
        });
      }

      const redacted = redactPublicScanReportV2R2(structuredClone(report));
      for (const run of r2ReportRuns(redacted)) {
        assert.equal(run.toolchain.normalizationVersion, superseded);
      }
      assert.equal(JSON.stringify(redactPublicScanReportV2R2(redacted)), JSON.stringify(redacted));
    }
  }

  const [superseded] = SUPERSEDED_R2_NORMALIZATIONS["node-playwright"];
  assert.notEqual(superseded, undefined);

  // A fresh producer fixture relabeled with an old sanitizer identity is a
  // mixed epoch, not a historical report, and must fail closed.
  const mixedEpoch = makePublicSingleReportV2R2();
  mixedEpoch.run.toolchain.normalizationVersion = superseded!;
  mixedEpoch.run.fingerprints = buildFingerprints({
    conditions: mixedEpoch.run.conditions,
    provenance: mixedEpoch.run.provenance,
    toolchain: mixedEpoch.run.toolchain,
    detectors: mixedEpoch.run.detectors
  });
  assert.throws(
    () => redactPublicScanReportV2R2(mixedEpoch),
    (error: unknown) => error instanceof R2RedactionRemediationError
  );

  const forged = makePublicSingleReportV2R2();
  for (const run of r2ReportRuns(forged)) {
    run.privacy.redactionVersion = REDACTION_VERSION;
    run.toolchain.normalizationVersion = `${superseded}+self-declared`;
    run.fingerprints = buildFingerprints({
      conditions: run.conditions,
      provenance: run.provenance,
      toolchain: run.toolchain,
      detectors: run.detectors
    });
  }
  assert.throws(
    () => redactPublicScanReportV2R2(forged),
    (error: unknown) => error instanceof R2RedactionRemediationError
  );
});

test("the shared migration identity projection covers experiment metadata in both planners", () => {
  const reportId = `20260712-${"a".repeat(32)}`;
  const intervention = makeSupportingPairInterventionReportV2R2();
  assert.equal(r2RemediationPreservesIdentity(reportId, intervention, structuredClone(intervention)), true);

  const drifts = [
    (report: typeof intervention) => { report.baseline.runId = "drifted-run"; },
    (report: typeof intervention) => { report.experiment.pairId = "drifted-pair"; },
    (report: typeof intervention) => {
      if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
      report.experiment.verification.baseline.outcome = "failed";
    },
    (report: typeof intervention) => {
      if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
      report.experiment.evidence.pairs += 1;
    },
    (report: typeof intervention) => {
      if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
      const pair = report.experiment.supportingPairs?.[0];
      if (!pair) throw new Error("fixture invariant");
      pair.verification.variant.phaseId += 1;
    }
  ];
  for (const drift of drifts) {
    const changed = structuredClone(intervention);
    drift(changed);
    assert.equal(r2RemediationPreservesIdentity(reportId, intervention, changed), false);
  }

  const descriptive = makeDescriptiveReportV2R2();
  const descriptiveDrift = structuredClone(descriptive);
  if (descriptiveDrift.experiment.kind !== "descriptive") throw new Error("fixture invariant");
  descriptiveDrift.experiment.sourceOrder = "chronological";
  assert.equal(r2RemediationPreservesIdentity(reportId, descriptive, descriptiveDrift), false);
});

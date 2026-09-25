import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readManagedReport } from "./managed-report-reader";
import {
  buildPageGraphScanReportV2R2,
  type PageGraphCaptureMetadataV1
} from "./pagegraph-v2-r2-builder";
import {
  isReadableR2Normalization,
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  PAGEGRAPH_R2_NORMALIZATION_VERSION,
  SUPERSEDED_R2_NORMALIZATIONS
} from "./scan-report-v2-normalization";
import { PUBLIC_STRING_POLICY_DIGEST } from "./redact-scan-report-v1";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import {
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_ADBLOCK_IDENTITY,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_OBLIGATIONS,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_DIGEST,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_VERSION,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_VERSIONS,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_METHODOLOGY_VERSION,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_NORMALIZATION_VERSION,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_PUBLIC_LIMITS,
  HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_TRACKER_CATALOG,
  HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST,
  HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION,
  HISTORICAL_NODE_R2_V4_DETECTOR_VERSIONS,
  HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION,
  HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V4_TRACKER_CATALOG,
  HISTORICAL_DETECTOR_V4_RESOURCE_BUDGET_V2_NODE_R2_METHODOLOGY_VERSION,
  HISTORICAL_DETECTOR_V5_NODE_R2_METHODOLOGY_VERSION,
  HISTORICAL_DETECTOR_V6_NODE_R2_METHODOLOGY_VERSION,
  HISTORICAL_RESOURCE_BUDGET_V1_NODE_R2_METHODOLOGY_VERSION,
  HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
  HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
  HISTORICAL_PAGEGRAPH_R2_DETECTOR_VERSION,
  HISTORICAL_PAGEGRAPH_R2_EXPECTED_DETECTORS,
  HISTORICAL_PAGEGRAPH_R2_METHODOLOGY_VERSION,
  HISTORICAL_R2_LISTS_2026_08_04_ADBLOCK_IDENTITY,
  HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY,
  HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_IDENTITY,
  NODE_R2_CURRENT_ADBLOCK_IDENTITY,
  NODE_R2_PRODUCER_TUPLES,
  NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
  PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
  PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
  PAGEGRAPH_R2_DETECTOR_VERSION,
  PAGEGRAPH_R2_EXPECTED_DETECTORS,
  PAGEGRAPH_R2_METHODOLOGY_VERSION,
  PAGEGRAPH_R2_PRODUCER_TUPLES,
  R2ProducerContractError,
  assertR2ProducerContract,
  type NodeR2ProducerTuple
} from "./scan-report-v2-r2-producer-contract";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";

const V4_PREFIX =
  "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v3:";
const NODE_SUFFIX = "+tldts@7.4.9+node-evidence-policy-v1+r2-http-status-compat-v1";
const PAGEGRAPH_SUFFIX =
  "+tldts@7.4.9+pagegraph-request-evidence-v1+r2-http-status-compat-v1";
const N613 = `${V4_PREFIX}61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a${NODE_SUFFIX}`;
const N68C = `${V4_PREFIX}68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23${NODE_SUFFIX}`;
const NDBB = `${V4_PREFIX}dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3${NODE_SUFFIX}`;

function historicalV4Run(normalizationVersion: string, methodologyVersion: string): ScanRunV2R2 {
  const run = makeScanRunV2R2();
  run.toolchain.normalizationVersion = normalizationVersion;
  run.provenance.methodologyVersion = methodologyVersion;
  run.provenance.detectorRegistry = {
    version: HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION,
    digest: HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST
  };
  run.toolchain.trackerCatalog = { ...HISTORICAL_NODE_R2_V4_TRACKER_CATALOG };
  run.toolchain.adblock = null;
  for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
    run.detectors[id] = {
      ...run.detectors[id],
      version: HISTORICAL_NODE_R2_V4_DETECTOR_VERSIONS[id]
    };
  }
  return run;
}

function runForTuple(tuple: NodeR2ProducerTuple): ScanRunV2R2 {
  const run = makeScanRunV2R2();
  run.toolchain.normalizationVersion = tuple.normalizationVersion;
  run.provenance.methodologyVersion = tuple.methodologyVersion;
  run.provenance.detectorRegistry = { ...tuple.detectorRegistry };
  run.toolchain.trackerCatalog = { ...tuple.trackerCatalog };
  run.toolchain.adblock = tuple.adblockIdentity === null ? null : { ...tuple.adblockIdentity };
  for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
    run.detectors[id] = { ...run.detectors[id], version: tuple.detectorVersions[id] };
  }
  return run;
}

function rejectsNodeMutation(mutate: (run: ScanRunV2R2) => void, label: string): void {
  const run = makeScanRunV2R2();
  mutate(run);
  assert.throws(
    () => assertR2ProducerContract(run),
    (error: unknown) => error instanceof R2ProducerContractError,
    label
  );
}

test("closed v7 reports keep their exact decoder identity when v8 adds body coverage", () => {
  const closed = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v7-active-probe-v2-active-no-adblock");
  const current = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v8-pixel-coverage-active-no-adblock");
  assert.ok(closed && current);
  assert.deepEqual(closed.detectorRegistry, {
    version: "node-detectors-v7", digest: "e019df75386c8f89584f5d14b4b191fa00f76a4ddb88f79a5875e7d07c72c89b"
  });
  assert.equal(closed.detectorVersions["pixel-events"], "pixel-request-decoder@4");
  assert.equal(current.detectorVersions["pixel-events"], "pixel-request-decoder@5");
  assert.equal(closed.normalizationVersion, current.normalizationVersion, "no redaction or schema change");
  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(closed)));
  const hybrid = runForTuple(closed);
  hybrid.detectors["pixel-events"].version = current.detectorVersions["pixel-events"];
  assert.throws(() => assertR2ProducerContract(hybrid), R2ProducerContractError);
  assert.equal(Object.isFrozen(closed.detectorVersions), true);
});

test("Node producer rows are complete, immutable, and individually replayable", () => {
  const expectedTupleIds = [
      "node-v3-shadow-lists-2026-07-12",
      "node-v3-lists-2026-07-13",
      "node-v3-no-adblock",
      "node-v3-migrated-shadow-lists-2026-07-12",
      "node-v3-migrated-lists-2026-07-13",
      "node-v3-migrated-no-adblock",
      "node-v4-dbb6-lists-2026-07-13",
      "node-v4-dbb6-lists-2026-07-25",
      "node-v4-dbb6-no-adblock",
      "node-v4-6e87-lists-2026-07-25",
      "node-v4-6e87-no-adblock",
      "node-v4-5b1f-lists-2026-07-25",
      "node-v4-5b1f-no-adblock",
      "node-v4-6131-pw161-lists-2026-07-25",
      "node-v4-6131-pw161-no-adblock",
      "node-v4-68c3-pw161-lists-2026-07-25",
      "node-v4-68c3-pw161-no-adblock",
      "node-v4-68c3-pw162-lists-2026-07-25",
      "node-v4-68c3-pw162-no-adblock",
      "node-v4-b68c-pre-accountability-lists-2026-07-25",
      "node-v4-b68c-pre-accountability-no-adblock",
      "node-v4-b68c-accountability-v1-lists-2026-07-25",
      "node-v4-b68c-accountability-v1-no-adblock",
      "node-v4-b68c-service-role-v1-lists-2026-07-25",
      "node-v4-b68c-service-role-v1-no-adblock",
      "node-v4-ec26-lists-2026-07-25",
      "node-v4-ec26-no-adblock",
      "node-v4-6c78-tldts749-lists-2026-07-25",
      "node-v4-6c78-tldts749-no-adblock",
      "node-v4-6c78-tldts7410-lists-2026-08-04",
      "node-v4-6c78-tldts7410-lists-2026-08-11",
      "node-v4-6c78-tldts7410-lists-2026-08-14",
      "node-v4-6c78-tldts7410-lists-2026-08-14-evening",
      "node-v4-resource-budget-v1-lists-2026-08-15",
      "node-v4-resource-budget-v1-no-adblock",
      "node-v4-6c78-tldts7410-lists-2026-08-15",
      "node-v4-6c78-tldts7410-no-adblock",
      "node-v5-6c78-tldts7410-lists-2026-08-15",
      "node-v5-6c78-tldts7410-no-adblock",
      "node-v6-6c78-tldts7410-lists-2026-08-15",
      "node-v6-6c78-tldts7410-no-adblock",
      "node-v6-gpc-worker-v2-6c78-tldts7410-lists-2026-08-15",
      "node-v6-gpc-worker-v2-6c78-tldts7410-no-adblock",
      "node-v7-active-probe-v2-active-lists-2026-08-15",
      "node-v7-active-probe-v2-active-no-adblock",
      "node-v8-pixel-coverage-active-lists-2026-08-15",
      "node-v8-pixel-coverage-active-no-adblock",
      "node-v9-catalog-suffix-active-lists-2026-08-15",
      "node-v9-catalog-suffix-active-no-adblock",
      "node-v10-network-security-active-lists-2026-08-15",
      "node-v10-network-security-active-no-adblock",
      "node-v10-network-security-active-lists-2026-09-07",
      "node-v11-detectors-v9-active-lists-2026-09-21",
      "node-v11-detectors-v9-active-no-adblock",
      "node-v12-toolchain-2026-09-active-lists-2026-09-21",
      "node-v12-toolchain-2026-09-active-no-adblock",
      "node-v13-detectors-v10-active-lists-2026-09-21",
      "node-v13-detectors-v10-active-no-adblock",
      "node-v14-public-string-policy-v4-active-lists-2026-09-21",
      "node-v14-public-string-policy-v4-active-no-adblock",
      "node-v15-detectors-v11-active-lists-2026-09-21",
      "node-v15-detectors-v11-active-no-adblock"
  ];
  assert.deepEqual(NODE_R2_PRODUCER_TUPLES.map((tuple) => tuple.id), expectedTupleIds);
  assert.equal(Object.isFrozen(NODE_R2_PRODUCER_TUPLES), true);
  const preAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("pre-accountability-no-adblock")
  );
  const activeAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("active-no-adblock")
  );
  const historicalAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("accountability-v1-no-adblock")
  );
  assert.equal(preAccountability?.phaseOmissionContractVersion, "phase-omission-v1");
  assert.equal(preAccountability?.detectorObligations, null);
  assert.notEqual(activeAccountability, undefined);
  assert.notEqual(historicalAccountability, undefined);
  assert.equal(
    historicalAccountability?.methodologyVersion,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_METHODOLOGY_VERSION
  );
  assert.equal(
    historicalAccountability?.normalizationVersion,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_NORMALIZATION_VERSION
  );
  assert.deepEqual(historicalAccountability?.detectorRegistry, {
    version: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_VERSION,
    digest: HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_REGISTRY_DIGEST
  });
  assert.deepEqual(
    historicalAccountability?.detectorVersions,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_VERSIONS
  );
  assert.deepEqual(
    historicalAccountability?.detectorObligations,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_OBLIGATIONS
  );
  assert.equal(historicalAccountability?.serviceRoleTaxonomy, null);
  assert.deepEqual(
    historicalAccountability?.trackerCatalog,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_TRACKER_CATALOG
  );
  assert.deepEqual(
    historicalAccountability?.adblockIdentity,
    null,
    "the selected historical no-adblock row remains exact"
  );
  const historicalWithLists = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("accountability-v1-lists-2026-07-25")
  );
  assert.deepEqual(
    historicalWithLists?.adblockIdentity,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_ADBLOCK_IDENTITY
  );
  const historicalAugustLists = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v4-6c78-tldts7410-lists-2026-08-04"
  );
  assert.deepEqual(
    historicalAugustLists?.adblockIdentity,
    HISTORICAL_R2_LISTS_2026_08_04_ADBLOCK_IDENTITY
  );
  assert.deepEqual(
    historicalAccountability?.publicLimits,
    HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_PUBLIC_LIMITS
  );
  assert.equal(activeAccountability?.phaseOmissionContractVersion, "phase-omission-v2");
  assert.match(
    activeAccountability?.methodologyVersion ?? "",
    /\+detector-accountability-v1\+service-role-taxonomy-v1\+gpc-worker-application-v2\+active-probe-v2\+auxiliary-context-block-v1$/
  );
  assert.deepEqual(activeAccountability?.detectorObligations, {
    version: "detector-obligations-v1",
    digest: "fb8bd07786fdb71c02ffdf1eca40a73b8974c691c6d4ef3c89230ad5314c22a3"
  });
  assert.deepEqual(activeAccountability?.serviceRoleTaxonomy, {
    version: SERVICE_ROLE_TAXONOMY_VERSION,
    digest: SERVICE_ROLE_TAXONOMY_DIGEST
  });
  assert.deepEqual((activeAccountability ?? preAccountability)?.publicLimits, {
    phases: 16,
    warnings: 64,
    requests: 1_000,
    cookieRecords: 1_000,
    cookieMutations: 2_000,
    storageRecords: 1_000,
    storageMutations: 2_000,
    fingerprintEvents: 1_000,
    fingerprintDetections: 256,
    cnameCloaks: 256,
    pixelEvents: 512,
    consentObservations: 32,
    policyClaims: 32,
    policyEntities: 100
  });
  assert.deepEqual((activeAccountability ?? preAccountability)?.runtimeIdentity, {
    sourceArtifactDigest: "absent",
    automation: "playwright-chromium",
    browserName: "chromium",
    headless: true,
    language: "matches-locale"
  });
  for (const tuple of NODE_R2_PRODUCER_TUPLES) {
    // Every epoch since detector-accountability-v1 carries obligations: the
    // accountability-v1 rows, the frozen ServiceRole rows (ec26 and the 6c78
    // identity under tldts@7.4.9), and the active rows. Earlier epochs must
    // stay null. A newly frozen epoch needs its own marker here, or its rows
    // silently fall into the "earlier epoch" branch and this guard passes for
    // the wrong reason.
    const isServiceRoleEpoch =
      tuple.id.includes("-ec26-") || tuple.id.includes("-6c78-") || tuple.id.includes("-active-") ||
      tuple.id.includes("-service-role-v1-") || tuple.id.includes("-resource-budget-v1-");
    const hasAccountability = tuple.id.includes("-accountability-v1-") || isServiceRoleEpoch;
    assert.equal(tuple.detectorObligations !== null, hasAccountability, `${tuple.id} obligation identity`);
    assert.equal(
      tuple.serviceRoleTaxonomy !== null,
      isServiceRoleEpoch,
      `${tuple.id} ServiceRole taxonomy identity`
    );
    assert.equal(Object.isFrozen(tuple), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.detectorRegistry), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.detectorVersions), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.trackerCatalog), true, tuple.id);
    assert.equal(tuple.adblockIdentity === null || Object.isFrozen(tuple.adblockIdentity), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.publicLimits), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.runtimeIdentity), true, tuple.id);
    if (tuple.detectorObligations !== null) {
      assert.equal(Object.isFrozen(tuple.detectorObligations), true, tuple.id);
    }
    if (tuple.serviceRoleTaxonomy !== null) {
      assert.equal(Object.isFrozen(tuple.serviceRoleTaxonomy), true, tuple.id);
    }
    assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(tuple)), tuple.id);
  }
  assert.throws(() => {
    (NODE_R2_PRODUCER_TUPLES as NodeR2ProducerTuple[]).push(NODE_R2_PRODUCER_TUPLES[0]!);
  }, TypeError);
  assert.throws(() => {
    (NODE_R2_PRODUCER_TUPLES[0] as { methodologyVersion: string }).methodologyVersion = "mutated";
  }, TypeError);
});

test("the detector-v6 identity preserves the v4 resource-budget rows and the closed v5 rows", () => {
  assert.match(NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION, /\+resource-budget-v2(?:\+|$)/);
  assert.match(HISTORICAL_RESOURCE_BUDGET_V1_NODE_R2_METHODOLOGY_VERSION, /\+resource-budget-v1(?:\+|$)/);
  assert.doesNotMatch(HISTORICAL_RESOURCE_BUDGET_V1_NODE_R2_METHODOLOGY_VERSION, /resource-budget-v2/);

  const historical = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v4-6c78-tldts7410-lists-2026-08-14"
  );
  const detectorV4 = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v4-6c78-tldts7410-lists-2026-08-15"
  );
  const detectorV5 = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v5-6c78-tldts7410-lists-2026-08-15"
  );
  const detectorV6 = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v6-6c78-tldts7410-lists-2026-08-15"
  );
  const active = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v15-detectors-v11-active-lists-2026-09-21"
  );
  assert.equal(historical?.methodologyVersion, HISTORICAL_RESOURCE_BUDGET_V1_NODE_R2_METHODOLOGY_VERSION);
  assert.equal(
    detectorV4?.methodologyVersion,
    HISTORICAL_DETECTOR_V4_RESOURCE_BUDGET_V2_NODE_R2_METHODOLOGY_VERSION
  );
  assert.equal(detectorV5?.methodologyVersion, HISTORICAL_DETECTOR_V5_NODE_R2_METHODOLOGY_VERSION);
  assert.equal(detectorV6?.methodologyVersion, HISTORICAL_DETECTOR_V6_NODE_R2_METHODOLOGY_VERSION);
  assert.equal(active?.methodologyVersion, NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION);
  // Three registries, three epochs: the v5 row pins the fingerprint-observer@2
  // identity that ran for one day, and the active row must not alias either
  // OLDER closed registry.
  assert.equal(detectorV5?.detectorRegistry.version, "node-detectors-v5");
  assert.equal(detectorV5?.detectorVersions["fingerprint-heuristics"], "fingerprint-observer@2");
  assert.notDeepEqual(detectorV5?.detectorRegistry, detectorV4?.detectorRegistry);
  assert.notDeepEqual(active?.detectorRegistry, detectorV4?.detectorRegistry);
  assert.notDeepEqual(active?.detectorRegistry, detectorV5?.detectorRegistry);
});

test("the gpc-worker-application revision closes the v6 rows and separates them by methodology alone", () => {
  const closedV6 = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v6-6c78-tldts7410-lists-2026-08-15"
  );
  const active = NODE_R2_PRODUCER_TUPLES.find(
    (tuple) => tuple.id === "node-v6-gpc-worker-v2-6c78-tldts7410-lists-2026-08-15"
  );
  assert.notEqual(closedV6, undefined);
  assert.notEqual(active, undefined);
  if (closedV6 === undefined || active === undefined) return;

  // No detector's semantics moved with the worker-application revision, so
  // the registry and detector versions are deliberately shared; the ONLY
  // separator is the methodology component, and the closed literal must
  // never gain it.
  assert.deepEqual(active.detectorRegistry, closedV6.detectorRegistry);
  assert.deepEqual(active.detectorVersions, closedV6.detectorVersions);
  assert.equal(closedV6.detectorRegistry.version, "node-detectors-v6");
  assert.match(active.methodologyVersion, /\+gpc-worker-application-v2$/);
  assert.doesNotMatch(closedV6.methodologyVersion, /gpc-worker-application/);
  assert.notEqual(active.methodologyVersion, closedV6.methodologyVersion);

  // Both epochs replay exactly.
  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(closedV6)));
  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(active)));

  // The v1 mechanism was never a named component: a wire claiming one is an
  // unreviewed producer, not a member of either epoch.
  const namedV1 = runForTuple(closedV6);
  namedV1.provenance.methodologyVersion = `${closedV6.methodologyVersion}+gpc-worker-application-v1`;
  assert.throws(() => assertR2ProducerContract(namedV1), R2ProducerContractError);
});

test("pre-accountability and active accountability fields cannot be mixed", () => {
  const preAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("pre-accountability-no-adblock")
  );
  const activeAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("active-no-adblock")
  );
  assert.notEqual(preAccountability, undefined);
  assert.notEqual(activeAccountability, undefined);
  if (preAccountability === undefined || activeAccountability === undefined) return;

  assert.equal(
    NODE_R2_PRODUCER_TUPLES.some(
      (tuple) =>
        tuple.methodologyVersion === activeAccountability.methodologyVersion &&
        tuple.detectorObligations === null
    ),
    false
  );
  assert.equal(
    NODE_R2_PRODUCER_TUPLES.some(
      (tuple) =>
        tuple.methodologyVersion === preAccountability.methodologyVersion &&
        tuple.detectorObligations !== null
    ),
    false
  );

  const preWithActiveMethodology = runForTuple(preAccountability);
  preWithActiveMethodology.provenance.methodologyVersion = activeAccountability.methodologyVersion;
  assert.throws(() => assertR2ProducerContract(preWithActiveMethodology), R2ProducerContractError);

  const activeWithPreMethodology = runForTuple(activeAccountability);
  activeWithPreMethodology.provenance.methodologyVersion = preAccountability.methodologyVersion;
  assert.throws(() => assertR2ProducerContract(activeWithPreMethodology), R2ProducerContractError);

  const preWithActiveRegistry = runForTuple(preAccountability);
  preWithActiveRegistry.provenance.detectorRegistry = { ...activeAccountability.detectorRegistry };
  assert.throws(() => assertR2ProducerContract(preWithActiveRegistry), R2ProducerContractError);

  const activeWithPreRegistry = runForTuple(activeAccountability);
  activeWithPreRegistry.provenance.detectorRegistry = { ...preAccountability.detectorRegistry };
  assert.throws(() => assertR2ProducerContract(activeWithPreRegistry), R2ProducerContractError);

  const preWithActiveDetector = runForTuple(preAccountability);
  preWithActiveDetector.detectors["keystroke-exfiltration"].version =
    activeAccountability.detectorVersions["keystroke-exfiltration"];
  assert.throws(() => assertR2ProducerContract(preWithActiveDetector), R2ProducerContractError);
});

test("the ServiceRole producer epoch cannot be mixed with the prior accountability row", () => {
  const historical = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("accountability-v1-no-adblock")
  );
  const active = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("active-no-adblock")
  );
  assert.notEqual(historical, undefined);
  assert.notEqual(active, undefined);
  if (historical === undefined || active === undefined) return;

  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(historical)));
  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(active)));

  const historicalWithActiveMethodology = runForTuple(historical);
  historicalWithActiveMethodology.provenance.methodologyVersion = active.methodologyVersion;
  assert.throws(
    () => assertR2ProducerContract(historicalWithActiveMethodology),
    R2ProducerContractError
  );

  const activeWithHistoricalRegistry = runForTuple(active);
  activeWithHistoricalRegistry.provenance.detectorRegistry = { ...historical.detectorRegistry };
  assert.throws(
    () => assertR2ProducerContract(activeWithHistoricalRegistry),
    R2ProducerContractError
  );

  const activeWithHistoricalCname = runForTuple(active);
  activeWithHistoricalCname.detectors["cname-uncloaking"].version =
    historical.detectorVersions["cname-uncloaking"];
  assert.throws(
    () => assertR2ProducerContract(activeWithHistoricalCname),
    R2ProducerContractError
  );

  const activeWithHistoricalPolicy = runForTuple(active);
  activeWithHistoricalPolicy.detectors["privacy-policy"].version =
    historical.detectorVersions["privacy-policy"];
  assert.throws(
    () => assertR2ProducerContract(activeWithHistoricalPolicy),
    R2ProducerContractError
  );
});

test("normalization registries are frozen arrays, not runtime-mutable Sets", () => {
  for (const registry of [MIGRATABLE_REDACTION_V3_NORMALIZATIONS, SUPERSEDED_R2_NORMALIZATIONS]) {
    assert.equal(Object.isFrozen(registry), true);
    for (const observer of Object.keys(registry) as Array<keyof typeof registry>) {
      assert.equal(Array.isArray(registry[observer]), true);
      assert.equal(Object.isFrozen(registry[observer]), true);
      assert.equal("add" in registry[observer], false);
    }
  }
  assert.equal(
    SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].some((identity) =>
      identity.includes("dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3")
    ),
    true
  );
});

test("Playwright history is exact: 613 is 1.61-only and 68c spans 1.61 and 1.62", () => {
  assert.deepEqual(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[N613], [
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION
  ]);
  assert.deepEqual(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[N68C], [
    HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
    HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION
  ]);
  assert.doesNotThrow(() =>
    assertR2ProducerContract(historicalV4Run(NDBB, HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION))
  );
  assert.doesNotThrow(() =>
    assertR2ProducerContract(historicalV4Run(N613, HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION))
  );
  assert.throws(
    () =>
      assertR2ProducerContract(
        historicalV4Run(N613, HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION)
      ),
    R2ProducerContractError
  );
  assert.doesNotThrow(() =>
    assertR2ProducerContract(historicalV4Run(N68C, HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION))
  );
  assert.doesNotThrow(() =>
    assertR2ProducerContract(
      historicalV4Run(N68C, HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION)
    )
  );
});

test("one-field Node substitutions cannot synthesize an unreviewed producer", () => {
  const mutations: Array<[string, (run: ScanRunV2R2) => void]> = [
    ["normalization", (run) => { run.toolchain.normalizationVersion += "+mixed"; }],
    ["methodology", (run) => { run.provenance.methodologyVersion += "+mixed"; }],
    ["registry version", (run) => { run.provenance.detectorRegistry.version += "-mixed"; }],
    ["registry digest", (run) => { run.provenance.detectorRegistry.digest = "0".repeat(64); }],
    ["tracker source", (run) => { run.toolchain.trackerCatalog.source += " mixed"; }],
    ["tracker version", (run) => { run.toolchain.trackerCatalog.version += "-mixed"; }],
    ["tracker entries", (run) => { run.toolchain.trackerCatalog.entries += 1; }],
    ["tracker digest", (run) => { run.toolchain.trackerCatalog.digest = "0".repeat(64); }],
    ["adblock source", (run) => { if (run.toolchain.adblock) run.toolchain.adblock.source += " mixed"; }],
    ["adblock lists", (run) => { if (run.toolchain.adblock) run.toolchain.adblock.lists += 1; }],
    // `adblock fetchedAt` used to be listed here, on the reasoning that one
    // millisecond off the active snapshot is a near-miss identity rather than a
    // reviewed producer row. That instinct is right, and it still holds for
    // every field below -- but it was aimed at the wrong one.
    //
    // A differing `fetchedAt` with an identical `manifestDigest` is not a near
    // miss. The digest is sha256 over every source's url, byte length and
    // sha256, so it fixes the rule bytes exactly; the timestamp records only
    // when the download happened. Treating it as identity asserted that two
    // reports measured against byte-identical rules were different
    // measurements, which is false, and it made the scheduled refresh fail on
    // every run including the ones where upstream had not moved. A check that
    // cannot pass carries no signal: a real breakage and an ordinary week were
    // indistinguishable.
    //
    // The review this protects is already digest-scoped -- THIRD_PARTY_REVIEWS
    // keys filter lists by `url@sha256` -- so a refetch of identical bytes
    // inherits it exactly. `fetchedAt` stays on the wire as provenance, and the
    // two guards below still reject a moved manifest or engine, which is what
    // makes a genuine rule change a new identity.
    ["adblock digest", (run) => { if (run.toolchain.adblock) run.toolchain.adblock.manifestDigest = "0".repeat(64); }],
    ["adblock engine", (run) => { if (run.toolchain.adblock) run.toolchain.adblock.engineVersion += "-mixed"; }],
    ["source artifact", (run) => { run.provenance.sourceArtifactDigest = "0".repeat(64); }],
    ["automation", (run) => { run.conditions.automation = "brave-pagegraph"; }],
    ["browser", (run) => { run.conditions.browser.name = "brave"; }],
    ["headless", (run) => { run.conditions.headless = false; }],
    ["language", (run) => { run.conditions.language = "fr-FR"; }]
  ];
  for (const id of Object.keys(makeScanRunV2R2().detectors) as Array<keyof ScanRunV2R2["detectors"]>) {
    mutations.push([
      `detector ${id}`,
      (run) => { run.detectors[id] = { ...run.detectors[id], version: `${run.detectors[id].version}-mixed` }; }
    ]);
  }
  for (const [label, mutate] of mutations) rejectsNodeMutation(mutate, label);
});

test("every exact PageGraph normalization row replays and mixed tracker identities fail", () => {
  const fixtureDir = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");
  const bytes = new Uint8Array(readFileSync(path.join(fixtureDir, "real-wikipedia-2026-07-19.graphml")));
  const metadata = JSON.parse(
    readFileSync(path.join(fixtureDir, "real-wikipedia-2026-07-19.meta.json"), "utf8")
  ) as PageGraphCaptureMetadataV1;
  const active = buildPageGraphScanReportV2R2(bytes, metadata, {
    buildCommit: "a".repeat(40),
    runId: "pagegraph-producer-tuple-test"
  }).run;

  const historicalTracker = {
    source: "Hand-curated service catalog",
    version: "hand-curated-2026.06",
    entries: 133,
    digest: "b7d4991063310a81b56342ca7ad949723e785704326179e1658335d7af2f88cf"
  };
  const pagegraphV3 =
    "redaction-v3+allowlists-v2:042fbfccf7b914479b7100002c5f709b54314606840c4dde50fb2368e23c30e8+public-string-policy-v2:74f1170bbf38a2f85629fa612c01f5da3c0ab1d8f0042f4082eef21815db868c+tldts@7.4.3+pagegraph-request-evidence-v1";
  const accountabilityTracker = {
    source: "Hand-curated service catalog",
    version: "hand-curated-2026.07",
    entries: 137,
    digest: "7cade02ae20c3bb88e28e0de1135ef63c48f586e7196de3c02c13478f70c95bc"
  };
  const serviceRoleTracker = {
    source: "Hand-curated service catalog",
    version: "hand-curated-2026.08",
    entries: 146,
    digest: "e94970de235fc80254de8ed99b94316a252e52aa1c2e748c8fbfc3c093b908f4"
  };
  // Each retired identity replays only with the exact catalog it published
  // under, and any other catalog version mixed into the same row must throw.
  const oracle: Array<{ normalizationVersion: string; catalog: typeof historicalTracker; mixedVersion: string }> = [
    { normalizationVersion: pagegraphV3, catalog: historicalTracker, mixedVersion: "hand-curated-2026.07" },
    {
      normalizationVersion: `${pagegraphV3}+v3-to-v4-ip-port-title@1`,
      catalog: historicalTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    {
      normalizationVersion: `${V4_PREFIX}dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3${PAGEGRAPH_SUFFIX}`,
      catalog: historicalTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    {
      normalizationVersion: `${V4_PREFIX}6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b${PAGEGRAPH_SUFFIX}`,
      catalog: historicalTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    {
      normalizationVersion: `${V4_PREFIX}5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd${PAGEGRAPH_SUFFIX}`,
      catalog: historicalTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    {
      normalizationVersion: `${V4_PREFIX}61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a${PAGEGRAPH_SUFFIX}`,
      catalog: historicalTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    {
      normalizationVersion: `${V4_PREFIX}68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23${PAGEGRAPH_SUFFIX}`,
      catalog: historicalTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    {
      normalizationVersion: `${V4_PREFIX}b68c7b0c0312d1ea5799aa491859ff88737e16da2791453b0936a9b4c14d62a7${PAGEGRAPH_SUFFIX}`,
      catalog: accountabilityTracker,
      mixedVersion: "hand-curated-2026.08"
    },
    {
      normalizationVersion: `${V4_PREFIX}ec263b9176229101c26212bf1cef8a04cdeb167777a2f8501a842b4eab53d0ae${PAGEGRAPH_SUFFIX}`,
      catalog: serviceRoleTracker,
      mixedVersion: "hand-curated-2026.07"
    },
    // The 6c78 identity as it stood under tldts@7.4.9. Every retirement adds a
    // row here: the length assertion below pins this oracle to the tuple table
    // minus the single active row.
    {
      normalizationVersion: `${V4_PREFIX}6c78c05523e1f16c88264d0144af33587bd6dc11e04d337a6af2d58190639266${PAGEGRAPH_SUFFIX}`,
      catalog: serviceRoleTracker,
      mixedVersion: "hand-curated-2026.07"
    }
  ];
  oracle.push({
    normalizationVersion: `${V4_PREFIX}6c78c05523e1f16c88264d0144af33587bd6dc11e04d337a6af2d58190639266+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1`,
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  oracle.push({
    normalizationVersion: `${V4_PREFIX}980a41d7ebd83e46269be8565bfa4547185d2282415884d39b7592752064df26+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1`,
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  oracle.push({
    normalizationVersion: `${V4_PREFIX}42735187d5a7121bacd36074418a138c64dfb0eb5575b5983a134398670e5384+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1`,
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  // The cb7064 identity under tldts@7.4.10, closed by the 2026-09 toolchain
  // epoch's public-suffix engine move.
  oracle.push({
    normalizationVersion: `${V4_PREFIX}cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+tldts@7.4.10+pagegraph-request-evidence-v1+r2-http-status-compat-v1`,
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  // The cb7064 identity under tldts@7.4.13, closed by the four warnings the
  // node-detectors-v10 measurement epoch admits.
  oracle.push({
    normalizationVersion: `${V4_PREFIX}cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1`,
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  // The b40a333a identity, closed by the public-string-policy-v4 narrowing.
  oracle.push({
    normalizationVersion: `${V4_PREFIX}b40a333af90f0b6a7bd1e5c702edcd7ef768167bc811ae20272a6e993cb83d51+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1`,
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  // The 359b216f identity under the v4 policy name, closed by the
  // canvas.convertToBlob widening in node-detectors-v11.
  oracle.push({
    normalizationVersion: "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v4:359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1",
    catalog: serviceRoleTracker,
    mixedVersion: "hand-curated-2026.07"
  });
  assert.equal(PAGEGRAPH_R2_PRODUCER_TUPLES.length, oracle.length + 1);
  assert.equal(Object.isFrozen(PAGEGRAPH_R2_PRODUCER_TUPLES), true);
  const activeMethodologySuffix = active.provenance.methodologyVersion.slice(
    PAGEGRAPH_R2_METHODOLOGY_VERSION.length
  );
  for (const { normalizationVersion, catalog, mixedVersion } of oracle) {
    // Replay each retired identity from its own frozen producer row, not the
    // live builder: taking the registry, ledger, and methodology base from the
    // builder would let a future live bump silently restate what these closed
    // rows accept, mirroring the Node remediation replay.
    const frozenTuple = PAGEGRAPH_R2_PRODUCER_TUPLES.find(
      (tuple) => tuple.normalizationVersion === normalizationVersion
    );
    assert.notEqual(
      frozenTuple,
      undefined,
      `no frozen PageGraph producer row for ${normalizationVersion}`
    );
    const run = structuredClone(active);
    run.toolchain.normalizationVersion = normalizationVersion;
    run.toolchain.trackerCatalog = { ...catalog };
    run.provenance.methodologyVersion = `${frozenTuple!.methodologyVersion}${activeMethodologySuffix}`;
    run.provenance.detectorRegistry = { ...frozenTuple!.detectorRegistry };
    run.detectors = structuredClone(frozenTuple!.detectors);
    assert.doesNotThrow(() => assertR2ProducerContract(run), normalizationVersion);
    run.toolchain.trackerCatalog.version = mixedVersion;
    assert.throws(() => assertR2ProducerContract(run), R2ProducerContractError);
  }
  assert.doesNotThrow(() => assertR2ProducerContract(active));
});

test("closed PageGraph epochs are pinned literals that still match the live identity today", () => {
  const closedIds = PAGEGRAPH_R2_PRODUCER_TUPLES.filter(
    (tuple) => tuple.id !== "pagegraph-v4-convert-to-blob-active"
  ).map((tuple) => tuple.id);
  assert.equal(closedIds.length > 0, true);
  // (a) The frozen registry digest is this exact hex, and it is the sha256 of
  // the frozen version + ledger, so neither the pin nor its inputs can drift
  // on their own.
  assert.equal(
    HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
    "570dd008086e2ebbee8abfe96ff278c46f6f388bce6363ef3cfc3704bee8a321"
  );
  assert.equal(
    sha256Hex(
      canonicalJson({
        version: HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
        detectors: HISTORICAL_PAGEGRAPH_R2_EXPECTED_DETECTORS
      })
    ),
    HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST
  );
  // (b) The frozen identity deep-equals the live one TODAY. The first real
  // divergence must fail here and force a reviewed decision: freeze a new
  // PageGraph epoch row instead of restating the closed ones.
  const divergence = (field: string): string =>
    `live PageGraph ${field} diverged from the frozen literal pinned by the closed epochs ` +
    `${closedIds.join(", ")}; add a new reviewed epoch row instead of restating them`;
  assert.equal(
    PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
    HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
    divergence("detector registry version")
  );
  assert.equal(
    PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
    HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST,
    divergence("detector registry digest")
  );
  assert.equal(
    PAGEGRAPH_R2_DETECTOR_VERSION,
    HISTORICAL_PAGEGRAPH_R2_DETECTOR_VERSION,
    divergence("detector version")
  );
  assert.equal(
    PAGEGRAPH_R2_METHODOLOGY_VERSION,
    HISTORICAL_PAGEGRAPH_R2_METHODOLOGY_VERSION,
    divergence("methodology version")
  );
  assert.deepEqual(
    PAGEGRAPH_R2_EXPECTED_DETECTORS,
    HISTORICAL_PAGEGRAPH_R2_EXPECTED_DETECTORS,
    divergence("detector ledger")
  );
  // Every closed row names the frozen identity, never the live constants.
  for (const tuple of PAGEGRAPH_R2_PRODUCER_TUPLES) {
    if (tuple.id === "pagegraph-v4-convert-to-blob-active") continue;
    assert.deepEqual(
      tuple.detectorRegistry,
      {
        version: HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_VERSION,
        digest: HISTORICAL_PAGEGRAPH_R2_DETECTOR_REGISTRY_DIGEST
      },
      tuple.id
    );
    assert.deepEqual(tuple.detectors, HISTORICAL_PAGEGRAPH_R2_EXPECTED_DETECTORS, tuple.id);
    assert.equal(tuple.methodologyVersion, HISTORICAL_PAGEGRAPH_R2_METHODOLOGY_VERSION, tuple.id);
  }
});

test("every committed managed bundle remains readable through the exact producer rows", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const files = readdirSync(reportsDir).filter((name) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(name));
  // Structural floor only: retention lawfully shrinks the corpus inside
  // reviewed proposals (7-day age, newest generations exempt), so this guards
  // against an empty or misread directory, never against pruning.
  assert.equal(files.length >= 50, true, `expected a populated committed corpus, found ${files.length}`);
  for (const name of files) {
    const reportId = name.slice(0, -".json".length);
    const reportContents = readFileSync(path.join(reportsDir, name), "utf8");
    const sidecarContents = readFileSync(path.join(reportsDir, `${reportId}.provenance.json`), "utf8");
    const sidecar = JSON.parse(sidecarContents) as { createdAt: string; expiresAt: string | null };
    const read = readManagedReport({
      reportId,
      reportContents,
      sidecarContents,
      retention: { createdAt: sidecar.createdAt, expiresAt: sidecar.expiresAt }
    });
    assert.equal(read.ok, true, `${name}: ${read.ok ? "" : read.reason}`);
  }
});

test("a refetched but unchanged Brave snapshot is the same measurement identity", () => {
  // The weekly refresh stamps a fresh `fetchedAt` on every run, even when
  // upstream has not moved a byte. While that field participated in the tuple
  // match, the scheduled job could never pass: the snapshot it produced never
  // equalled the pinned literal, so the refresh was red every week regardless
  // of whether anything had actually changed.
  const tuple = NODE_R2_PRODUCER_TUPLES.find((candidate) => candidate.adblockIdentity !== null);
  assert.ok(tuple, "a Node tuple with an adblock identity is required for this guard");

  const run = runForTuple(tuple!);
  assert.ok(run.toolchain.adblock, "the fixture run must carry an adblock identity");
  run.toolchain.adblock = {
    ...run.toolchain.adblock!,
    fetchedAt: "2099-01-01T00:00:00.000Z"
  };
  assert.notEqual(
    run.toolchain.adblock.fetchedAt,
    tuple!.adblockIdentity!.fetchedAt,
    "the fixture must actually differ in the field under test"
  );
  assert.doesNotThrow(
    () => assertR2ProducerContract(run),
    "a refetch of identical rules must not be treated as a new measurement identity"
  );
});

test("changed Brave rules are still a different measurement identity", () => {
  // The other direction, and the reason the field above can be dropped safely:
  // `manifestDigest` is sha256 over every source's url, bytes and sha256, so it
  // determines the rule content completely. If it moves, the measurement really
  // did change and a reviewed commit is still required.
  const tuple = NODE_R2_PRODUCER_TUPLES.find((candidate) => candidate.adblockIdentity !== null);
  assert.ok(tuple, "a Node tuple with an adblock identity is required for this guard");

  const run = runForTuple(tuple!);
  run.toolchain.adblock = {
    ...run.toolchain.adblock!,
    manifestDigest: "0".repeat(64)
  };
  assert.throws(
    () => assertR2ProducerContract(run),
    R2ProducerContractError,
    "a different rule manifest must not pass as the pinned producer"
  );

  // Same for the engine: identical rules under a different engine version are a
  // different measurement, and dropping fetchedAt must not have loosened this.
  const engineRun = runForTuple(tuple!);
  engineRun.toolchain.adblock = {
    ...engineRun.toolchain.adblock!,
    engineVersion: "adblock-rust-0.0.0-not-the-pinned-engine"
  };
  assert.throws(() => assertR2ProducerContract(engineRun), R2ProducerContractError);
});

// Captured from the deployed 978030c source before refreshing filter inputs.
test("September filter adoption preserves both outgoing production identities exactly", () => {
  const ids = ["node-v10-network-security-active-lists-2026-08-15","node-v10-network-security-active-no-adblock"];
  const rows = ids.map((id) => NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === id));
  assert.equal(sha256Hex(canonicalJson(rows)), "a10f39d204897537247464e10a1e9dfbef75aedb5794151ed93849665d71871c");
});

// Captured by executing the tables at 32328b2c, the last node-detectors-v8
// source, before the v9 detector epoch closed them.
test("the detectors-v9 epoch preserves every outgoing production identity exactly", () => {
  const ids = ["node-v10-network-security-active-lists-2026-09-07", "node-v10-network-security-active-no-adblock"];
  const rows = ids.map((id) => NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === id));
  assert.equal(sha256Hex(canonicalJson(rows)), "bf69046092173a1afceb277cd5a960fbe456becb5b3e559ed83776a2526ce688");
  const pagegraph = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-catalog-suffix-active");
  assert.equal(sha256Hex(canonicalJson(pagegraph)), "fdea8ca72fa8fd2e835a3e3be514a9c55705f33134eb809e27d154eb8b4686f8");
});

test("the live Node producer is accepted with and without the Brave lists", () => {
  // Until v11 the active identity had no no-list row of its own: it matched
  // a closed v10 row byte for byte. Once the identity moves, a missing active
  // no-list row would reject every scan that ran without the lists.
  const withLists = makeScanRunV2R2();
  assert.notEqual(withLists.toolchain.adblock, null);
  assert.doesNotThrow(() => assertR2ProducerContract(withLists));
  const withoutLists = makeScanRunV2R2();
  withoutLists.toolchain.adblock = null;
  assert.doesNotThrow(() => assertR2ProducerContract(withoutLists));
  const live = NODE_R2_PRODUCER_TUPLES.filter(
    (tuple) =>
      tuple.normalizationVersion === withLists.toolchain.normalizationVersion &&
      tuple.methodologyVersion === withLists.provenance.methodologyVersion &&
      canonicalJson(tuple.detectorRegistry) === canonicalJson(withLists.provenance.detectorRegistry)
  );
  assert.deepEqual(live.map((tuple) => tuple.adblockIdentity === null), [false, true]);
});

test("every closed v4 producer row names a normalization readers still accept", () => {
  // A retired identity stays readable only through SUPERSEDED_R2_NORMALIZATIONS.
  // A closed row whose identity is missing there replays in the producer
  // contract yet fails remediation as an unreviewed identity. v3 identities are
  // governed by the migration table instead.
  for (const [observer, rows] of [
    ["node-playwright", NODE_R2_PRODUCER_TUPLES],
    ["pagegraph-import", PAGEGRAPH_R2_PRODUCER_TUPLES]
  ] as const) {
    for (const tuple of rows) {
      if (tuple.normalizationVersion.startsWith("redaction-v3+")) continue;
      assert.equal(isReadableR2Normalization(observer, tuple.normalizationVersion), true, tuple.id);
    }
  }
});

test("every superseded Node row is paired with its own methodology for remediation replay", () => {
  // Remediation replays each superseded identity once per methodology this map
  // names, so a row missing from the map is never replayed and a map pair with
  // no row replays nothing. Both directions must hold for every retirement.
  const superseded = new Set(SUPERSEDED_R2_NORMALIZATIONS["node-playwright"]);
  for (const tuple of NODE_R2_PRODUCER_TUPLES) {
    if (!superseded.has(tuple.normalizationVersion)) continue;
    assert.equal(
      HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[tuple.normalizationVersion]?.includes(tuple.methodologyVersion),
      true,
      `${tuple.id} is not paired with its methodology`
    );
  }
  for (const [normalization, methodologies] of Object.entries(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION)) {
    for (const methodology of methodologies) {
      assert.equal(
        NODE_R2_PRODUCER_TUPLES.some(
          (tuple) => tuple.normalizationVersion === normalization && tuple.methodologyVersion === methodology
        ),
        true,
        `${normalization} + ${methodology} names no producer row`
      );
    }
  }
});

test("closed v10 reports keep their exact detector identity when v11 moves three detectors", () => {
  const closed = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v10-network-security-active-lists-2026-09-07");
  const current = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v11-detectors-v9-active-lists-2026-09-21");
  assert.ok(closed && current);
  assert.deepEqual(closed.detectorRegistry, {
    version: "node-detectors-v8", digest: "fcd25504e7d18811478b440fbd738a01cacfdb8e4811099edc5be62d84402947"
  });
  assert.deepEqual(current.detectorRegistry, {
    version: "node-detectors-v9", digest: "b15c8281f0db49b91a46427ffee63e44bf7bbbfc0a9878069c2bb1098b6d4715"
  });
  const moved = { "fingerprint-heuristics": ["fingerprint-observer@3", "fingerprint-observer@4"],
    "pixel-events": ["pixel-request-decoder@5", "pixel-request-decoder@6"],
    "privacy-policy": ["policy-text-cross-check@6", "policy-text-cross-check@7"] } as const;
  for (const [id, [before, after]] of Object.entries(moved) as Array<[keyof typeof moved, readonly [string, string]]>) {
    assert.equal(closed.detectorVersions[id], before, id);
    assert.equal(current.detectorVersions[id], after, id);
  }
  assert.equal(closed.methodologyVersion, current.methodologyVersion, "no methodology component moved");
  assert.notEqual(closed.normalizationVersion, current.normalizationVersion, "the admitted listener disclosure widens the vocabulary");
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].includes(closed.normalizationVersion), true);
  // Both rows keep their list snapshot as a literal, never the live constant a
  // later adoption or engine move will change (the digest pins hold their
  // values; this holds their independence). The v11 row followed the live
  // constant until the 2026-09 toolchain epoch closed it.
  assert.notEqual(closed.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  assert.notEqual(current.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  assert.equal(closed.adblockIdentity?.fetchedAt, "2026-09-07T04:11:08.142Z");
  assert.equal(current.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_IDENTITY);
  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(closed)));
  assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(current)));
  for (const id of Object.keys(moved) as Array<keyof typeof moved>) {
    const hybrid = runForTuple(closed);
    hybrid.detectors[id].version = current.detectorVersions[id];
    assert.throws(() => assertR2ProducerContract(hybrid), R2ProducerContractError, id);
  }
  const relabeled = runForTuple(closed);
  relabeled.toolchain.normalizationVersion = current.normalizationVersion;
  assert.throws(() => assertR2ProducerContract(relabeled), R2ProducerContractError);
});

// Captured by executing the tables at cd43c7bce9a980037a74f7ee2a05b722c2638b17,
// the last source that emitted Playwright 1.62.1, adblock-rust 0.13.2 and
// tldts 7.4.10, before the 2026-09 toolchain epoch closed them.
test("the 2026-09 toolchain epoch preserves every outgoing production identity exactly", () => {
  const ids = ["node-v11-detectors-v9-active-lists-2026-09-21", "node-v11-detectors-v9-active-no-adblock"];
  const rows = ids.map((id) => NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === id));
  assert.equal(sha256Hex(canonicalJson(rows)), "a5b1a032e702f7e77ad71b4fc5b43afab7f7bfdc8bcda198ab4c379afddc2552");
  const pagegraph = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-listener-warning-active");
  assert.equal(sha256Hex(canonicalJson(pagegraph)), "2085494f53e395f585e6c4edcb2e12f58de29c16e7ae4221ab4bcd3fcde81637");
});

test("closed v11 reports keep their exact toolchain identity when v12 moves Playwright, adblock-rust and tldts", () => {
  const closedLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v11-detectors-v9-active-lists-2026-09-21");
  const closedBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v11-detectors-v9-active-no-adblock");
  const currentLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v12-toolchain-2026-09-active-lists-2026-09-21");
  const currentBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v12-toolchain-2026-09-active-no-adblock");
  const live = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v15-detectors-v11-active-lists-2026-09-21");
  assert.ok(closedLists && closedBare && currentLists && currentBare && live);
  // No detector moved: every detector field is equal. The v12 rows were
  // closed by node-detectors-v10 onto the same frozen node-detectors-v9
  // fields, so neither closed pair may hold the live objects.
  for (const field of ["detectorRegistry", "detectorVersions", "detectorStatusContractVersion", "detectorObligations",
    "serviceRoleTaxonomy", "trackerCatalog", "publicLimits", "phaseOmissionContractVersion", "runtimeIdentity"] as const) {
    assert.deepEqual(closedLists[field], currentLists[field], field);
    assert.deepEqual(closedBare[field], currentBare[field], field);
  }
  for (const closed of [closedLists, closedBare, currentLists, currentBare]) {
    for (const field of ["detectorRegistry", "detectorVersions", "detectorObligations", "serviceRoleTaxonomy",
      "trackerCatalog", "publicLimits"] as const) {
      assert.notEqual(closed[field], live[field], `${closed.id} ${field} aliases the live object`);
    }
  }
  // The methodology differs only in its engine and browser components. Both
  // sides are closed literals now, so the comparison names the exact versions.
  assert.equal(
    closedLists.methodologyVersion
      .replace("-adblock-rust-0.13.2-", "-adblock-rust-0.13.3-")
      .replace("-playwright-1.62.1+", "-playwright-1.63.0+"),
    currentLists.methodologyVersion
  );
  assert.notEqual(closedLists.methodologyVersion, currentLists.methodologyVersion);
  assert.equal(closedBare.methodologyVersion, closedLists.methodologyVersion);
  assert.equal(currentBare.methodologyVersion, currentLists.methodologyVersion);
  // The normalization differs only in its public-suffix engine, and the
  // outgoing one stays readable as a superseded identity for both observers.
  assert.equal(
    closedLists.normalizationVersion.replace("+tldts@7.4.10+", "+tldts@7.4.13+"),
    currentLists.normalizationVersion
  );
  assert.notEqual(closedLists.normalizationVersion, currentLists.normalizationVersion);
  assert.equal(closedBare.normalizationVersion, closedLists.normalizationVersion);
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].includes(closedLists.normalizationVersion), true);
  assert.equal(
    SUPERSEDED_R2_NORMALIZATIONS["pagegraph-import"].includes(
      closedLists.normalizationVersion.replace("+node-evidence-policy-v1+", "+pagegraph-request-evidence-v1+")
    ),
    true
  );
  assert.deepEqual(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[closedLists.normalizationVersion], [
    closedLists.methodologyVersion
  ]);
  // The list snapshot is the same; only the engine that applied it moved. Each
  // closed row names its engine as a literal, and neither follows the live
  // constant.
  assert.equal(closedLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_IDENTITY);
  assert.equal(currentLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY);
  assert.notEqual(currentLists.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  assert.deepEqual(
    { ...closedLists.adblockIdentity, engineVersion: "adblock-rust-0.13.3" },
    { ...currentLists.adblockIdentity }
  );
  assert.equal(closedLists.adblockIdentity?.engineVersion, "adblock-rust-0.13.2");
  assert.equal(closedBare.adblockIdentity, null);
  assert.equal(currentBare.adblockIdentity, null);
  for (const tuple of [closedLists, closedBare, currentLists, currentBare]) {
    assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(tuple)), tuple.id);
  }
  // A report mixing any one moved component into the v11 identity, or the v11
  // one into the v12 identity, matches no row.
  const hybrids: Array<[string, (run: ScanRunV2R2) => void]> = [
    ["v12 methodology", (run) => { run.provenance.methodologyVersion = currentLists.methodologyVersion; }],
    ["v12 normalization", (run) => { run.toolchain.normalizationVersion = currentLists.normalizationVersion; }],
    ["v12 engine", (run) => { run.toolchain.adblock = { ...currentLists.adblockIdentity! }; }]
  ];
  for (const [label, mutate] of hybrids) {
    const hybrid = runForTuple(closedLists);
    mutate(hybrid);
    assert.throws(() => assertR2ProducerContract(hybrid), R2ProducerContractError, label);
  }
  const backdated = runForTuple(currentLists);
  backdated.toolchain.adblock = { ...closedLists.adblockIdentity! };
  assert.throws(() => assertR2ProducerContract(backdated), R2ProducerContractError, "v11 engine on the v12 identity");
});

// Captured by executing the tables at 59ad6f52b3cd3066c1d97e3e82ae94ba3ed6fb04,
// the last source before the node-detectors-v10 measurement epoch closed them;
// the tables at c8b189ac59f50121e6f1777dabe12ba4854f6090, which deployed the
// 2026-09 toolchain epoch, produce the same rows byte for byte.
test("the node-detectors-v10 measurement epoch preserves every outgoing production identity exactly", () => {
  const ids = ["node-v12-toolchain-2026-09-active-lists-2026-09-21", "node-v12-toolchain-2026-09-active-no-adblock"];
  const rows = ids.map((id) => NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === id));
  assert.equal(sha256Hex(canonicalJson(rows)), "f65eeef5ee6add4dae9dcdca8d7ef13f9430659818a2ac51dfdf63c2daa29048");
  const pagegraph = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-tldts7413-active");
  assert.equal(sha256Hex(canonicalJson(pagegraph)), "ab4993e73277d2b2ce6006ff73a6e3475e97699301465695cfe2ce5e56a61806");
});

test("closed v12 reports keep their exact identity when v13 moves the methodology, the keystroke detector and the policy digest", () => {
  const closedLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v12-toolchain-2026-09-active-lists-2026-09-21");
  const closedBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v12-toolchain-2026-09-active-no-adblock");
  const currentLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v13-detectors-v10-active-lists-2026-09-21");
  const currentBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v13-detectors-v10-active-no-adblock");
  const live = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v15-detectors-v11-active-lists-2026-09-21");
  assert.ok(closedLists && closedBare && currentLists && currentBare && live);
  // Detectors: only the keystroke detector and the registry moved.
  assert.deepEqual(closedLists.detectorRegistry, {
    version: "node-detectors-v9", digest: "b15c8281f0db49b91a46427ffee63e44bf7bbbfc0a9878069c2bb1098b6d4715"
  });
  assert.deepEqual(currentLists.detectorRegistry, {
    version: "node-detectors-v10", digest: "6f8d32c39564e962b50e18ac72c414752154d533df1d1157131feed703e55657"
  });
  assert.equal(closedLists.detectorVersions["keystroke-exfiltration"], "synthetic-sentinel@4");
  assert.equal(currentLists.detectorVersions["keystroke-exfiltration"], "synthetic-sentinel@5");
  assert.deepEqual(
    { ...closedLists.detectorVersions, "keystroke-exfiltration": currentLists.detectorVersions["keystroke-exfiltration"] },
    { ...currentLists.detectorVersions }
  );
  for (const field of ["detectorStatusContractVersion", "detectorObligations", "serviceRoleTaxonomy", "trackerCatalog",
    "publicLimits", "phaseOmissionContractVersion", "runtimeIdentity"] as const) {
    assert.deepEqual(closedLists[field], currentLists[field], field);
    assert.deepEqual(closedBare[field], currentBare[field], field);
  }
  // The v13 rows were closed by public-string-policy-v4 onto their own frozen
  // node-detectors-v10 fields, so neither closed pair may hold the live
  // objects.
  for (const closed of [closedLists, closedBare, currentLists, currentBare]) {
    for (const field of ["detectorRegistry", "detectorVersions", "detectorObligations", "serviceRoleTaxonomy",
      "trackerCatalog", "publicLimits"] as const) {
      assert.notEqual(closed[field], live[field], `${closed.id} ${field} aliases the live object`);
    }
  }
  // The methodology differs in exactly four components and nothing else. Both
  // sides are closed literals now, so the comparison names the exact versions.
  assert.equal(
    closedLists.methodologyVersion
      .replace("+subject-validity-v3+", "+subject-validity-v4+")
      .replace("+consent-r2-v4+", "+consent-r2-v5+")
      .replace("+gpc-worker-application-v2+", "+gpc-worker-application-v3+")
      .replace("+active-probe-v2+", "+active-probe-v3+"),
    currentLists.methodologyVersion
  );
  assert.equal(closedBare.methodologyVersion, closedLists.methodologyVersion);
  // The normalization differs only in its public-string policy digest (an
  // admitted-string widening), and the outgoing one stays readable for both
  // observers and replays with its one methodology.
  assert.equal(
    closedLists.normalizationVersion.replace(
      ":cb7064a154022024d8ffa25c110de6feff64f2b0ecbd375b14a24ff17105059d+",
      ":b40a333af90f0b6a7bd1e5c702edcd7ef768167bc811ae20272a6e993cb83d51+"
    ),
    currentLists.normalizationVersion
  );
  assert.notEqual(closedLists.normalizationVersion, currentLists.normalizationVersion);
  assert.equal(closedBare.normalizationVersion, closedLists.normalizationVersion);
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].includes(closedLists.normalizationVersion), true);
  assert.equal(
    SUPERSEDED_R2_NORMALIZATIONS["pagegraph-import"].includes(
      closedLists.normalizationVersion.replace("+node-evidence-policy-v1+", "+pagegraph-request-evidence-v1+")
    ),
    true
  );
  assert.deepEqual(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[closedLists.normalizationVersion], [
    closedLists.methodologyVersion
  ]);
  // Neither the lists nor the engine moved: both closed rows hold the one
  // frozen copy, equal to the live constant today but never that object.
  assert.equal(closedLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY);
  assert.equal(currentLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY);
  assert.notEqual(currentLists.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  assert.equal(closedBare.adblockIdentity, null);
  assert.equal(currentBare.adblockIdentity, null);
  for (const tuple of [closedLists, closedBare, currentLists, currentBare]) {
    assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(tuple)), tuple.id);
  }
  // A report mixing any one moved component across the two identities, in
  // either direction, matches no row.
  const hybrids: Array<[string, NodeR2ProducerTuple, NodeR2ProducerTuple, (run: ScanRunV2R2, from: NodeR2ProducerTuple) => void]> = [
    ["methodology", closedLists, currentLists, (run, from) => { run.provenance.methodologyVersion = from.methodologyVersion; }],
    ["normalization", closedLists, currentLists, (run, from) => { run.toolchain.normalizationVersion = from.normalizationVersion; }],
    ["registry", closedLists, currentLists, (run, from) => { run.provenance.detectorRegistry = { ...from.detectorRegistry }; }],
    ["keystroke version", closedLists, currentLists, (run, from) => {
      run.detectors["keystroke-exfiltration"].version = from.detectorVersions["keystroke-exfiltration"];
    }]
  ];
  for (const [label, closed, current, mutate] of hybrids) {
    const forward = runForTuple(closed);
    mutate(forward, current);
    assert.throws(() => assertR2ProducerContract(forward), R2ProducerContractError, `v13 ${label} on the v12 identity`);
    const backdated = runForTuple(current);
    mutate(backdated, closed);
    assert.throws(() => assertR2ProducerContract(backdated), R2ProducerContractError, `v12 ${label} on the v13 identity`);
  }
});

// Captured by executing the tables at 6c4698f7dd70307e513a12e6ac3631823331f5de,
// the last source before public-string-policy-v4 closed them.
test("the public-string-policy-v4 narrowing preserves every outgoing production identity exactly", () => {
  const ids = ["node-v13-detectors-v10-active-lists-2026-09-21", "node-v13-detectors-v10-active-no-adblock"];
  const rows = ids.map((id) => NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === id));
  assert.equal(sha256Hex(canonicalJson(rows)), "440b4a1a032288686a4c4c295d98e48b225f3e175b2a96ec2f543916c46cab95");
  const pagegraph = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-listener-withheld-active");
  assert.equal(sha256Hex(canonicalJson(pagegraph)), "81bb9ed8b59a846ff833ce1ec3f23db4374b9e9ea576e98ae48bd99342ae51a7");
});

test("closed v13 reports keep their exact identity when v14 moves only the public-string policy", () => {
  const closedLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v13-detectors-v10-active-lists-2026-09-21");
  const closedBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v13-detectors-v10-active-no-adblock");
  const currentLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v14-public-string-policy-v4-active-lists-2026-09-21");
  const currentBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v14-public-string-policy-v4-active-no-adblock");
  const live = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v15-detectors-v11-active-lists-2026-09-21");
  assert.ok(closedLists && closedBare && currentLists && currentBare && live);
  // Nothing but the normalization moved: every other field is equal...
  for (const field of ["methodologyVersion", "detectorRegistry", "detectorVersions", "detectorStatusContractVersion",
    "detectorObligations", "serviceRoleTaxonomy", "trackerCatalog", "publicLimits", "phaseOmissionContractVersion",
    "runtimeIdentity"] as const) {
    assert.deepEqual(closedLists[field], currentLists[field], field);
    assert.deepEqual(closedBare[field], currentBare[field], field);
  }
  assert.equal(closedLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY);
  assert.equal(currentLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY);
  assert.equal(closedBare.adblockIdentity, null);
  assert.equal(currentBare.adblockIdentity, null);
  // ...and both pairs are closed now, onto the one frozen node-detectors-v10
  // field set, so neither may hold the live objects. Value equality alone
  // cannot tell a closed row from one that follows the live constants, so the
  // sha256 pins cannot either; only these reference checks and the source
  // check below can.
  for (const closed of [closedLists, closedBare, currentLists, currentBare]) {
    for (const field of ["detectorRegistry", "detectorVersions", "detectorObligations", "serviceRoleTaxonomy",
      "trackerCatalog", "publicLimits"] as const) {
      assert.notEqual(closed[field], live[field], `${closed.id} ${field} aliases the live object`);
    }
  }
  assert.notEqual(currentLists.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  // The normalization differs only in the public-string policy, version and
  // digest; the outgoing one stays readable for both observers and replays
  // with its one methodology. Both sides are closed literals now.
  assert.equal(
    closedLists.normalizationVersion.replace(
      "+public-string-policy-v3:b40a333af90f0b6a7bd1e5c702edcd7ef768167bc811ae20272a6e993cb83d51+",
      "+public-string-policy-v4:359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+"
    ),
    currentLists.normalizationVersion
  );
  assert.notEqual(closedLists.normalizationVersion, currentLists.normalizationVersion);
  assert.equal(closedBare.normalizationVersion, closedLists.normalizationVersion);
  assert.equal(currentBare.normalizationVersion, currentLists.normalizationVersion);
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].includes(closedLists.normalizationVersion), true);
  const closedPageGraph = closedLists.normalizationVersion.replace("+node-evidence-policy-v1+", "+pagegraph-request-evidence-v1+");
  const currentPageGraph = currentLists.normalizationVersion.replace("+node-evidence-policy-v1+", "+pagegraph-request-evidence-v1+");
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["pagegraph-import"].includes(closedPageGraph), true);
  assert.deepEqual(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[closedLists.normalizationVersion], [
    closedLists.methodologyVersion
  ]);
  for (const tuple of [closedLists, closedBare, currentLists, currentBare]) {
    assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(tuple)), tuple.id);
  }
  // Both PageGraph rows are frozen, each to its own normalization literal.
  const closedPageGraphRow = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-listener-withheld-active");
  const currentPageGraphRow = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-public-string-policy-v4-active");
  assert.ok(closedPageGraphRow && currentPageGraphRow);
  assert.equal(closedPageGraphRow.normalizationVersion, closedPageGraph);
  assert.equal(currentPageGraphRow.normalizationVersion, currentPageGraph);
  assert.deepEqual(closedPageGraphRow.trackerCatalog, currentPageGraphRow.trackerCatalog);

  // Each run replays, but one comparison may not pair them: a normalization
  // change rewrites hosts, and a pair across it is ineligible for every family
  // rather than compared as if the two visits were sanitized alike.
  const earlier = runForTuple(closedLists);
  earlier.runId = "retired-policy";
  earlier.startedAt = "2026-09-24T10:00:00.000Z";
  const later = runForTuple(currentLists);
  later.runId = "current-policy";
  const mixed = evaluateComparabilityR2({ kind: "temporal", pairId: "policy-v4" }, earlier, later);
  for (const [family, verdict] of Object.entries(mixed.perMetric)) {
    assert.equal(verdict.eligible, false, family);
    assert.equal(verdict.reasons.includes("dependency-version-mismatch:environment"), true, family);
  }
  const control = runForTuple(currentLists);
  control.runId = "current-policy-earlier";
  control.startedAt = "2026-09-24T10:00:00.000Z";
  const same = evaluateComparabilityR2({ kind: "temporal", pairId: "policy-v4" }, control, later);
  for (const [family, verdict] of Object.entries(same.perMetric)) {
    assert.equal(verdict.reasons.includes("dependency-version-mismatch:environment"), false, family);
  }
});

// Captured by executing the tables at 89ae341f26a1ba10fbff4106d413fb22dccb0b2a,
// the main and production tip and the last source before the node-detectors-v11
// measurement epoch closed them.
test("the node-detectors-v11 measurement epoch preserves every outgoing production identity exactly", () => {
  const ids = ["node-v14-public-string-policy-v4-active-lists-2026-09-21", "node-v14-public-string-policy-v4-active-no-adblock"];
  const rows = ids.map((id) => NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === id));
  assert.equal(sha256Hex(canonicalJson(rows)), "d3e06fbe8cf7cb924bbe68c94ac3b9d4b320b11abe602de1592bda64b1903e61");
  const pagegraph = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-public-string-policy-v4-active");
  assert.equal(sha256Hex(canonicalJson(pagegraph)), "b1c07862469fa1f8adbb68eae6383ee3d1c91138bdaf871fc6168f520a73013c");
});

test("closed v14 reports keep their exact identity when v15 moves the methodology, the fingerprint observer and the policy digest", () => {
  const closedLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v14-public-string-policy-v4-active-lists-2026-09-21");
  const closedBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v14-public-string-policy-v4-active-no-adblock");
  const currentLists = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v15-detectors-v11-active-lists-2026-09-21");
  const currentBare = NODE_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "node-v15-detectors-v11-active-no-adblock");
  assert.ok(closedLists && closedBare && currentLists && currentBare);
  assert.equal(currentLists.methodologyVersion, NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION);
  assert.equal(currentLists.normalizationVersion, NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION);
  assert.equal(currentLists.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  // Detectors: only the fingerprint observer and the registry moved.
  assert.deepEqual(closedLists.detectorRegistry, {
    version: "node-detectors-v10", digest: "6f8d32c39564e962b50e18ac72c414752154d533df1d1157131feed703e55657"
  });
  assert.deepEqual(currentLists.detectorRegistry, {
    version: "node-detectors-v11", digest: "80209bf72ba24bc29b3f3526fe4ed9cbc09c4e230fbdb3be0ad61092683ae22a"
  });
  assert.equal(closedLists.detectorVersions["fingerprint-heuristics"], "fingerprint-observer@4");
  assert.equal(currentLists.detectorVersions["fingerprint-heuristics"], "fingerprint-observer@5");
  assert.deepEqual(
    { ...closedLists.detectorVersions, "fingerprint-heuristics": currentLists.detectorVersions["fingerprint-heuristics"] },
    { ...currentLists.detectorVersions }
  );
  for (const field of ["detectorStatusContractVersion", "detectorObligations", "serviceRoleTaxonomy", "trackerCatalog",
    "publicLimits", "phaseOmissionContractVersion", "runtimeIdentity"] as const) {
    assert.deepEqual(closedLists[field], currentLists[field], field);
    assert.deepEqual(closedBare[field], currentBare[field], field);
  }
  // The closed rows hold their own frozen copies, never the live objects.
  for (const closed of [closedLists, closedBare]) {
    for (const field of ["detectorRegistry", "detectorVersions", "detectorObligations", "serviceRoleTaxonomy",
      "trackerCatalog", "publicLimits"] as const) {
      assert.notEqual(closed[field], currentLists[field], `${closed.id} ${field} aliases the live object`);
    }
  }
  // The methodology gains exactly one base component, after
  // detector-coverage-v2, and nothing else moves. The outgoing base is a strict
  // prefix of the new one, so the outgoing literal is spelled out here rather
  // than derived from the live string.
  assert.equal(
    closedLists.methodologyVersion,
    "shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v4+detector-coverage-v2+phase-kernel-v2+boundary-state-v1+consent-r2-v5+resource-budget-v2+proxy-traffic-v1+service-worker-block-v1+detector-accountability-v1+service-role-taxonomy-v1+gpc-worker-application-v3+active-probe-v3+auxiliary-context-block-v1"
  );
  assert.equal(
    closedLists.methodologyVersion.replace("+detector-coverage-v2+", "+detector-coverage-v2+fingerprint-surface-v2+"),
    currentLists.methodologyVersion
  );
  assert.equal(closedBare.methodologyVersion, closedLists.methodologyVersion);
  assert.equal(currentBare.methodologyVersion, currentLists.methodologyVersion);
  // The normalization differs only in its public-string policy digest, under
  // the same v4 policy name: an admitted-token widening. The outgoing literal
  // stays readable for both observers and replays with its one methodology.
  const retiredNode =
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v4:359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+tldts@7.4.13+node-evidence-policy-v1+r2-http-status-compat-v1";
  const retiredPageGraph =
    "redaction-v4+allowlists-v3:269f631f04090ce582644ee3cf0e5c5b6bb425dc4929bc283607b808bc9322a9+public-string-policy-v4:359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+tldts@7.4.13+pagegraph-request-evidence-v1+r2-http-status-compat-v1";
  assert.equal(closedLists.normalizationVersion, retiredNode);
  assert.equal(closedBare.normalizationVersion, retiredNode);
  assert.equal(
    retiredNode.replace(
      ":359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc+",
      `:${PUBLIC_STRING_POLICY_DIGEST}+`
    ),
    currentLists.normalizationVersion
  );
  assert.notEqual(PUBLIC_STRING_POLICY_DIGEST, "359b216f1168c4caf2f107e9f5220cbab5e0da9b4dad686129922a9ab3e4e9bc");
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["node-playwright"].includes(retiredNode), true);
  assert.equal(SUPERSEDED_R2_NORMALIZATIONS["pagegraph-import"].includes(retiredPageGraph), true);
  assert.deepEqual(HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION[retiredNode], [closedLists.methodologyVersion]);
  // Neither the lists nor the engine moved: the closed list row holds the one
  // frozen copy, equal to the live constant today but never that object.
  assert.equal(closedLists.adblockIdentity, HISTORICAL_R2_LISTS_2026_09_21_ADBLOCK_0_13_3_IDENTITY);
  assert.notEqual(closedLists.adblockIdentity, NODE_R2_CURRENT_ADBLOCK_IDENTITY);
  assert.deepEqual({ ...closedLists.adblockIdentity }, { ...currentLists.adblockIdentity });
  assert.equal(closedBare.adblockIdentity, null);
  assert.equal(currentBare.adblockIdentity, null);
  for (const tuple of [closedLists, closedBare, currentLists, currentBare]) {
    assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(tuple)), tuple.id);
  }
  // The frozen PageGraph row holds its own literal and catalog copy; the new
  // active row follows the live constants.
  const closedPageGraphRow = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-public-string-policy-v4-active");
  const livePageGraphRow = PAGEGRAPH_R2_PRODUCER_TUPLES.find((tuple) => tuple.id === "pagegraph-v4-convert-to-blob-active");
  assert.ok(closedPageGraphRow && livePageGraphRow);
  assert.equal(closedPageGraphRow.normalizationVersion, retiredPageGraph);
  assert.equal(livePageGraphRow.normalizationVersion, PAGEGRAPH_R2_NORMALIZATION_VERSION);
  assert.deepEqual(closedPageGraphRow.trackerCatalog, livePageGraphRow.trackerCatalog);
  assert.notEqual(closedPageGraphRow.trackerCatalog, livePageGraphRow.trackerCatalog);
  // A report mixing any one moved component across the two identities, in
  // either direction, matches no row.
  const hybrids: Array<[string, (run: ScanRunV2R2, from: NodeR2ProducerTuple) => void]> = [
    ["methodology", (run, from) => { run.provenance.methodologyVersion = from.methodologyVersion; }],
    ["normalization", (run, from) => { run.toolchain.normalizationVersion = from.normalizationVersion; }],
    ["registry", (run, from) => { run.provenance.detectorRegistry = { ...from.detectorRegistry }; }],
    ["fingerprint version", (run, from) => {
      run.detectors["fingerprint-heuristics"].version = from.detectorVersions["fingerprint-heuristics"];
    }]
  ];
  for (const [label, mutate] of hybrids) {
    const forward = runForTuple(closedLists);
    mutate(forward, currentLists);
    assert.throws(() => assertR2ProducerContract(forward), R2ProducerContractError, `v15 ${label} on the v14 identity`);
    const backdated = runForTuple(currentLists);
    mutate(backdated, closedLists);
    assert.throws(() => assertR2ProducerContract(backdated), R2ProducerContractError, `v14 ${label} on the v15 identity`);
  }
  // One comparison may not pair them: the normalization moved, so a pair
  // across it is ineligible for every family.
  const earlier = runForTuple(closedLists);
  earlier.runId = "fingerprint-surface-v1";
  earlier.startedAt = "2026-09-25T10:00:00.000Z";
  const later = runForTuple(currentLists);
  later.runId = "fingerprint-surface-v2";
  const mixed = evaluateComparabilityR2({ kind: "temporal", pairId: "detectors-v11" }, earlier, later);
  for (const [family, verdict] of Object.entries(mixed.perMetric)) {
    assert.equal(verdict.eligible, false, family);
    assert.equal(verdict.reasons.includes("dependency-version-mismatch:environment"), true, family);
  }
});

test("closed producer rows name frozen literals, never the live identity constants", () => {
  // A closed row that follows a live constant equal to its literal today is
  // invisible to every value check, the row sha256 pins included, until the
  // constant moves and silently restates what published reports were
  // validated against. So the closed tables' source may not name one.
  const source = readFileSync(path.join(process.cwd(), "lib", "scan-report-v2-r2-producer-contract.ts"), "utf8");
  const live = [
    "NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION",
    "NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION",
    "NODE_SCANNER_METHODOLOGY_VERSION",
    "PAGEGRAPH_R2_NORMALIZATION_VERSION",
    "PAGEGRAPH_R2_METHODOLOGY_VERSION",
    "PAGEGRAPH_R2_PUBLIC_LIMITS",
    "PAGEGRAPH_R2_EXPECTED_DETECTORS",
    "PAGEGRAPH_REGISTRY",
    "NODE_R2_PUBLIC_LIMITS",
    "NODE_R2_CURRENT_ADBLOCK_IDENTITY",
    "ACTIVE_NODE_FIELDS",
    "ACTIVE_REGISTRY",
    "ACTIVE_DETECTOR_VERSIONS",
    "ACTIVE_DETECTOR_OBLIGATIONS",
    "ACTIVE_SERVICE_ROLE_TAXONOMY",
    "ACTIVE_TRACKER_CATALOG",
    "DETECTOR_VERSIONS",
    "DETECTOR_REGISTRY_DIGEST"
  ];
  function assertNamesNoLiveConstant(label: string, text: string): void {
    assert.ok(text.length > 0, `${label} not found`);
    for (const name of live) {
      assert.equal(new RegExp(`\\b${name}\\b`).test(text), false, `${label} names the live ${name}`);
    }
  }
  const nodeStart = source.indexOf("export const NODE_R2_PRODUCER_TUPLES");
  const nodeEnd = source.indexOf("...ACTIVE_NODE_TUPLES", nodeStart);
  assert.ok(nodeStart > 0 && nodeEnd > nodeStart);
  assertNamesNoLiveConstant("the closed Node rows", source.slice(nodeStart, nodeEnd));
  const pageGraphStart = source.indexOf("export const PAGEGRAPH_R2_PRODUCER_TUPLES");
  const pageGraphEnd = source.indexOf('pageGraphTuple("pagegraph-v4-convert-to-blob-active"', pageGraphStart);
  assert.ok(pageGraphStart > 0 && pageGraphEnd > pageGraphStart);
  assertNamesNoLiveConstant("the closed PageGraph rows", source.slice(pageGraphStart, pageGraphEnd));
  // The closed rows reach their identities through these declarations, so each
  // must be a literal too.
  const declarations = [...source.matchAll(/\nconst (HISTORICAL_NODE_V\d+_(?:METHODOLOGY|NORMALIZATION)) = (.)/g)];
  assert.equal(declarations.some(([, name]) => name === "HISTORICAL_NODE_V14_NORMALIZATION"), true);
  for (const [, name, first] of declarations) assert.equal(first, '"', `${name} is not a string literal`);
  const fields = [...source.matchAll(/\nconst (HISTORICAL_NODE_V\d+_FIELDS): NodeTupleFields = Object\.freeze\(\{([\s\S]*?)\n\}\);/g)];
  assert.equal(fields.some(([, name]) => name === "HISTORICAL_NODE_V10_FIELDS"), true);
  for (const [, name, body] of fields) assertNamesNoLiveConstant(name, body);
});

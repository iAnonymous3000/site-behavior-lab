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
  MIGRATABLE_REDACTION_V3_NORMALIZATIONS,
  SUPERSEDED_R2_NORMALIZATIONS
} from "./scan-report-v2-normalization";
import {
  HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_DIGEST,
  HISTORICAL_NODE_R2_V4_DETECTOR_REGISTRY_VERSION,
  HISTORICAL_NODE_R2_V4_DETECTOR_VERSIONS,
  HISTORICAL_NODE_R2_V4_METHODOLOGIES_BY_NORMALIZATION,
  HISTORICAL_NODE_R2_V4_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V4_PLAYWRIGHT_1_62_METHODOLOGY_VERSION,
  HISTORICAL_NODE_R2_V4_TRACKER_CATALOG,
  NODE_R2_PRODUCER_TUPLES,
  PAGEGRAPH_R2_PRODUCER_TUPLES,
  R2ProducerContractError,
  assertR2ProducerContract,
  type NodeR2ProducerTuple
} from "./scan-report-v2-r2-producer-contract";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
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
      "node-v4-b68c-pre-accountability-no-adblock"
  ];
  if (NODE_R2_PRODUCER_TUPLES.some((tuple) => tuple.id.endsWith("active-no-adblock"))) {
    expectedTupleIds.push(
      "node-v4-b68c-active-lists-2026-07-25",
      "node-v4-b68c-active-no-adblock"
    );
  }
  assert.deepEqual(NODE_R2_PRODUCER_TUPLES.map((tuple) => tuple.id), expectedTupleIds);
  assert.equal(Object.isFrozen(NODE_R2_PRODUCER_TUPLES), true);
  const preAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("pre-accountability-no-adblock")
  );
  const activeAccountability = NODE_R2_PRODUCER_TUPLES.find((tuple) =>
    tuple.id.endsWith("active-no-adblock")
  );
  assert.equal(preAccountability?.phaseOmissionContractVersion, "phase-omission-v1");
  if (activeAccountability !== undefined) {
    assert.match(activeAccountability.phaseOmissionContractVersion, /^phase-omission-v[0-9]+$/);
  }
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
    assert.equal(Object.isFrozen(tuple), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.detectorRegistry), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.detectorVersions), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.trackerCatalog), true, tuple.id);
    assert.equal(tuple.adblockIdentity === null || Object.isFrozen(tuple.adblockIdentity), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.publicLimits), true, tuple.id);
    assert.equal(Object.isFrozen(tuple.runtimeIdentity), true, tuple.id);
    assert.doesNotThrow(() => assertR2ProducerContract(runForTuple(tuple)), tuple.id);
  }
  assert.throws(() => {
    (NODE_R2_PRODUCER_TUPLES as NodeR2ProducerTuple[]).push(NODE_R2_PRODUCER_TUPLES[0]!);
  }, TypeError);
  assert.throws(() => {
    (NODE_R2_PRODUCER_TUPLES[0] as { methodologyVersion: string }).methodologyVersion = "mutated";
  }, TypeError);
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
    ["adblock fetchedAt", (run) => { if (run.toolchain.adblock) run.toolchain.adblock.fetchedAt = "2026-07-25T14:05:35.224Z"; }],
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
  const oracle = [
    pagegraphV3,
    `${pagegraphV3}+v3-to-v4-ip-port-title@1`,
    `${V4_PREFIX}dbb6c25e0645a6a98c2290d562f931ccfe065cf0ab1feded4798920024d312a3${PAGEGRAPH_SUFFIX}`,
    `${V4_PREFIX}6e87d9833c274788638c00887eb2dc1f3edd6e45ea5137ac07871279b24ec40b${PAGEGRAPH_SUFFIX}`,
    `${V4_PREFIX}5b1fd8d09fed5a91b2f1e3a395a2a5a6794fc879f05f9eaea1b00652542cf0bd${PAGEGRAPH_SUFFIX}`,
    `${V4_PREFIX}61319540712ac2cf0c4851669a5a2fddbe96305b885818269808bd5706632f3a${PAGEGRAPH_SUFFIX}`,
    `${V4_PREFIX}68c36f5132e92c25d024a23e201f931304ff9527063ac622f622e5955682bf23${PAGEGRAPH_SUFFIX}`
  ];
  assert.equal(PAGEGRAPH_R2_PRODUCER_TUPLES.length, oracle.length + 1);
  assert.equal(Object.isFrozen(PAGEGRAPH_R2_PRODUCER_TUPLES), true);
  for (const normalizationVersion of oracle) {
    const run = structuredClone(active);
    run.toolchain.normalizationVersion = normalizationVersion;
    run.toolchain.trackerCatalog = { ...historicalTracker };
    assert.doesNotThrow(() => assertR2ProducerContract(run), normalizationVersion);
    run.toolchain.trackerCatalog.version = "hand-curated-2026.07";
    assert.throws(() => assertR2ProducerContract(run), R2ProducerContractError);
  }
  assert.doesNotThrow(() => assertR2ProducerContract(active));
});

test("every committed managed bundle remains readable through the exact producer rows", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const files = readdirSync(reportsDir).filter((name) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(name));
  assert.equal(files.length >= 514, true, `expected the 514-report historical corpus, found ${files.length}`);
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

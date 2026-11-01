import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  DETECTOR_OBLIGATION_CONTRACT_VERSION,
  DETECTOR_OBLIGATION_REGISTRY,
  DETECTOR_OBLIGATION_REGISTRY_DIGEST,
  DETECTOR_OBLIGATION_TARGET_REGISTRIES,
  detectorObligationContractVersion,
  HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION,
  HISTORICAL_DETECTOR_OBLIGATION_REGISTRY,
  HISTORICAL_V2_DETECTOR_OBLIGATION_CONTRACT_VERSION,
  HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY,
  HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY_DIGEST
} from "./detector-obligations";
import { DETECTOR_REASON_CODES, DETECTOR_STATUS_REASON_CODES } from "./detector-status-contract";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import { buildPageGraphScanReportV2R2, type PageGraphCaptureMetadataV1 } from "./pagegraph-v2-r2-builder";
import type { DetectorStatus } from "./scan-report-v2";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import * as productionContract from "./scan-report-v2-r2-producer-contract";
import type { NodeR2ProducerTuple, PageGraphR2ProducerTuple } from "./scan-report-v2-r2-producer-contract";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import { sha256Hex } from "./sha256";

/**
 * EB1, EB2 and EB3: a report's producer row is the one it names, and the fields
 * that row carries are the ones its epoch published.
 *
 * Exhaustive over the rows the tables hold at this commit, and over nothing else:
 * a run the fixtures cannot synthesize is out of the domain. Rows are only ever
 * added, so row counts are floors, and each check's case count follows from the
 * table it walked. The same tables are pinned by id and digest in
 * scan-report-v2-r2-producer-contract.test.ts.
 */

type Contract = typeof productionContract;

const contractPath = require.resolve("./scan-report-v2-r2-producer-contract");
const contractVariant = (...edits: SourceEdit[]) => loadVariant<Contract>(contractPath, edits);
const MIN_NODE_ROWS = 91;
const MIN_PAGEGRAPH_ROWS = 22;

function runForNodeRow(row: NodeR2ProducerTuple): ScanRunV2R2 {
  const run = makeScanRunV2R2();
  run.toolchain.normalizationVersion = row.normalizationVersion;
  run.provenance.methodologyVersion = row.methodologyVersion;
  run.provenance.detectorRegistry = { ...row.detectorRegistry };
  run.toolchain.trackerCatalog = { ...row.trackerCatalog };
  run.toolchain.adblock = row.adblockIdentity === null ? null : { ...row.adblockIdentity };
  for (const id of Object.keys(run.detectors) as Array<keyof typeof run.detectors>) {
    run.detectors[id] = { ...run.detectors[id], version: row.detectorVersions[id] };
  }
  return run;
}

function refused(contract: Contract, run: ScanRunV2R2): boolean {
  try {
    contract.assertR2ProducerContract(run);
    return false;
  } catch (error) {
    if (error instanceof contract.R2ProducerContractError) return true;
    throw error;
  }
}

function checkNodeRowsMatchThemselves(contract: Contract): number {
  let cases = 0;
  const rows = contract.NODE_R2_PRODUCER_TUPLES;
  for (const row of rows) {
    const run = runForNodeRow(row);
    for (const candidate of rows) {
      cases += 1;
      holds("a-node-run-matches-only-its-own-row", contract.nodeTupleMatches(run, candidate) === (candidate === row), () => ({
        run: row.id,
        candidate: candidate.id
      }));
    }
  }
  return cases;
}

/**
 * A row's limits decide what a report under it may hold. Today all rows share one
 * set, so this holds the path, not a difference between rows: the difference can
 * only arise through a shadowed row, which the check above refuses.
 */
function checkNodeRowLimitsGovern(contract: Contract): number {
  let cases = 0;
  for (const row of contract.NODE_R2_PRODUCER_TUPLES) {
    cases += 1;
    const run = runForNodeRow(row);
    const filler = run.evidence.requests[0];
    run.evidence.requests = new Array(row.publicLimits.requests).fill(filler);
    holds("a-node-row-admits-its-own-limit", !refused(contract, run), () => ({ row: row.id, limit: row.publicLimits.requests }));
    run.evidence.requests = new Array(row.publicLimits.requests + 1).fill(filler);
    holds("a-node-row-refuses-past-its-own-limit", refused(contract, run), () => ({ row: row.id, limit: row.publicLimits.requests }));
  }
  return cases;
}

const DETECTOR_IDS = Object.keys(makeScanRunV2R2().detectors) as Array<keyof ScanRunV2R2["detectors"]>;

/** Every field the Node match key compares, each changed to a value no row holds. */
const NODE_KEY_SUBSTITUTIONS: ReadonlyArray<readonly [string, (run: ScanRunV2R2) => boolean]> = [
  ["normalization", (run) => ((run.toolchain.normalizationVersion += "+mixed"), true)],
  ["methodology", (run) => ((run.provenance.methodologyVersion += "+mixed"), true)],
  ["registry version", (run) => ((run.provenance.detectorRegistry.version += "-mixed"), true)],
  ["registry digest", (run) => ((run.provenance.detectorRegistry.digest = "0".repeat(64)), true)],
  ["tracker source", (run) => ((run.toolchain.trackerCatalog.source += " mixed"), true)],
  ["tracker version", (run) => ((run.toolchain.trackerCatalog.version += "-mixed"), true)],
  ["tracker entries", (run) => ((run.toolchain.trackerCatalog.entries += 1), true)],
  ["tracker digest", (run) => ((run.toolchain.trackerCatalog.digest = "0".repeat(64)), true)],
  ["adblock source", (run) => (run.toolchain.adblock ? ((run.toolchain.adblock.source += " mixed"), true) : false)],
  ["adblock lists", (run) => (run.toolchain.adblock ? ((run.toolchain.adblock.lists += 1), true) : false)],
  ["adblock digest", (run) => (run.toolchain.adblock ? ((run.toolchain.adblock.manifestDigest = "0".repeat(64)), true) : false)],
  ["adblock engine", (run) => (run.toolchain.adblock ? ((run.toolchain.adblock.engineVersion += "-mixed"), true) : false)],
  ["source artifact", (run) => ((run.provenance.sourceArtifactDigest = "0".repeat(64)), true)],
  ["automation", (run) => ((run.conditions.automation = "brave-pagegraph"), true)],
  ["browser", (run) => ((run.conditions.browser.name = "brave"), true)],
  ["headless", (run) => ((run.conditions.headless = false), true)],
  ["language", (run) => ((run.conditions.language = "fr-FR"), true)],
  ...DETECTOR_IDS.map(
    (id) => [`detector ${id}`, (run: ScanRunV2R2) => ((run.detectors[id] = { ...run.detectors[id], version: `${run.detectors[id].version}-mixed` }), true)] as const
  )
];

function checkOneFieldSubstitutions(contract: Contract): number {
  let cases = 0;
  for (const row of contract.NODE_R2_PRODUCER_TUPLES) {
    for (const [field, substitute] of NODE_KEY_SUBSTITUTIONS) {
      const run = runForNodeRow(row);
      if (!substitute(run)) continue;
      cases += 1;
      holds(
        "a-one-field-substitution-matches-no-row",
        !contract.NODE_R2_PRODUCER_TUPLES.some((candidate) => contract.nodeTupleMatches(run, candidate)) && refused(contract, run),
        () => ({ row: row.id, field })
      );
    }
    // A refetch of the same lists is the same measurement, so the row still answers.
    if (row.adblockIdentity !== null) {
      cases += 1;
      const run = runForNodeRow(row);
      (run.toolchain.adblock as NonNullable<typeof run.toolchain.adblock>).fetchedAt = "2020-01-01T00:00:00.000Z";
      holds("a-refetch-of-the-same-lists-keeps-the-row", contract.nodeTupleMatches(run, row) && !refused(contract, run), () => ({ row: row.id }));
    }
  }
  return cases;
}

const pageGraphFixtures = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");
const pageGraphBase = () =>
  buildPageGraphScanReportV2R2(
    new Uint8Array(readFileSync(path.join(pageGraphFixtures, "real-wikipedia-2026-07-19.graphml"))),
    JSON.parse(readFileSync(path.join(pageGraphFixtures, "real-wikipedia-2026-07-19.meta.json"), "utf8")) as PageGraphCaptureMetadataV1,
    { buildCommit: "a".repeat(40), runId: "fv-producer-identity" }
  ).run;

/** The methodology a PageGraph row names is a base plus a validated suffix, so the suffix is part of the domain. */
const METHODOLOGY_SUFFIXES = [
  `+crawl-pagegraph-crawl@1+crawl-sha-${"a".repeat(40)}+schema-pagegraph@1+sanitizer-sbl@1`,
  `+crawl-a+b:c/d@e-f.g+crawl-sha-${"0".repeat(40)}+schema-A.B_c+sanitizer-z`
] as const;

function runForPageGraphRow(base: ScanRunV2R2, row: PageGraphR2ProducerTuple, suffix: string): ScanRunV2R2 {
  const run = structuredClone(base);
  run.toolchain.normalizationVersion = row.normalizationVersion;
  run.provenance.methodologyVersion = `${row.methodologyVersion}${suffix}`;
  run.provenance.detectorRegistry = { ...row.detectorRegistry };
  run.detectors = structuredClone(row.detectors) as ScanRunV2R2["detectors"];
  run.toolchain.trackerCatalog = { ...row.trackerCatalog };
  run.toolchain.adblock = row.adblockIdentity;
  return run;
}

function checkPageGraphRowsMatchThemselves(contract: Contract, base: ScanRunV2R2): number {
  let cases = 0;
  const rows = contract.PAGEGRAPH_R2_PRODUCER_TUPLES;
  for (const row of rows) {
    for (const suffix of METHODOLOGY_SUFFIXES) {
      const run = runForPageGraphRow(base, row, suffix);
      for (const candidate of rows) {
        cases += 1;
        holds(
          "a-pagegraph-run-matches-only-its-own-row",
          contract.pageGraphTupleMatches(run, candidate) === (candidate === row),
          () => ({ run: row.id, candidate: candidate.id, suffix })
        );
      }
    }
  }
  return cases;
}

/** Methodology spellings no row may accept: the base alone, a partial suffix, and text on either end. */
function checkPageGraphMethodologyShape(contract: Contract, base: ScanRunV2R2): number {
  let cases = 0;
  const good = METHODOLOGY_SUFFIXES[0];
  for (const row of contract.PAGEGRAPH_R2_PRODUCER_TUPLES) {
    for (const methodology of [
      row.methodologyVersion,
      `${row.methodologyVersion}+crawl-x`,
      `junk${row.methodologyVersion}${good}`,
      `${row.methodologyVersion}${good} junk`,
      `${row.methodologyVersion}+crawl-x+crawl-sha-${"a".repeat(39)}+schema-y+sanitizer-z`
    ]) {
      cases += 1;
      const run = runForPageGraphRow(base, row, "");
      run.provenance.methodologyVersion = methodology;
      holds("a-pagegraph-row-refuses-a-misshapen-methodology", !contract.pageGraphTupleMatches(run, row), () => ({ row: row.id, methodology }));
    }
  }
  return cases;
}

/** Every field the PageGraph match key compares, each changed to a value no row holds. */
const PAGEGRAPH_KEY_SUBSTITUTIONS: ReadonlyArray<readonly [string, (run: ScanRunV2R2) => void]> = [
  ["normalization", (run) => { run.toolchain.normalizationVersion += "+mixed"; }],
  ["registry version", (run) => { run.provenance.detectorRegistry.version += "-mixed"; }],
  ["registry digest", (run) => { run.provenance.detectorRegistry.digest = "0".repeat(64); }],
  ["tracker source", (run) => { run.toolchain.trackerCatalog.source += " mixed"; }],
  ["tracker version", (run) => { run.toolchain.trackerCatalog.version += "-mixed"; }],
  ["tracker entries", (run) => { run.toolchain.trackerCatalog.entries += 1; }],
  ["tracker digest", (run) => { run.toolchain.trackerCatalog.digest = "0".repeat(64); }],
  ["adblock", (run) => { run.toolchain.adblock = { ...(makeScanRunV2R2().toolchain.adblock as NonNullable<ScanRunV2R2["toolchain"]["adblock"]>) }; }],
  ["acquisition", (run) => { run.provenance.acquisition = "live-scan" as never; }],
  ["automation", (run) => { run.conditions.automation = "playwright-chromium"; }],
  ["consent", (run) => { run.conditions.consent = "accept-all"; }],
  ["shields", (run) => { run.conditions.shields = "block-simulation"; }],
  ["keystroke probe", (run) => { run.conditions.probes.keystroke = true; }],
  ["policy visit probe", (run) => { run.conditions.probes.policyVisit = true; }],
  ["verification facts", (run) => { run.verificationFacts = {}; }],
  ...DETECTOR_IDS.map(
    (id) => [`detector ${id}`, (run: ScanRunV2R2) => { run.detectors[id] = { ...run.detectors[id], version: `${run.detectors[id].version}-mixed` }; }] as const
  )
];

function checkPageGraphSubstitutions(contract: Contract, base: ScanRunV2R2): number {
  let cases = 0;
  for (const row of contract.PAGEGRAPH_R2_PRODUCER_TUPLES) {
    for (const [field, substitute] of PAGEGRAPH_KEY_SUBSTITUTIONS) {
      cases += 1;
      const run = runForPageGraphRow(base, row, METHODOLOGY_SUFFIXES[0]);
      substitute(run);
      holds(
        "a-one-field-substitution-matches-no-pagegraph-row",
        !contract.PAGEGRAPH_R2_PRODUCER_TUPLES.some((candidate) => contract.pageGraphTupleMatches(run, candidate)) && refused(contract, run),
        () => ({ row: row.id, field })
      );
    }
  }
  return cases;
}

test("EB1: each Node producer row's run matches that row and no other", () => {
  const rows = productionContract.NODE_R2_PRODUCER_TUPLES;
  assert.ok(rows.length >= MIN_NODE_ROWS, `only ${rows.length} Node rows`);
  assert.equal(checkNodeRowsMatchThemselves(productionContract), rows.length * rows.length);
});

test("EB1: each Node producer row admits exactly its own request limit", () => {
  assert.equal(checkNodeRowLimitsGovern(productionContract), productionContract.NODE_R2_PRODUCER_TUPLES.length);
});

test("EB1: a run with any one Node key field changed matches no row, and a refetch keeps its row", () => {
  const rows = productionContract.NODE_R2_PRODUCER_TUPLES;
  const listRows = rows.filter((row) => row.adblockIdentity !== null).length;
  const adblockFields = 4;
  assert.equal(
    checkOneFieldSubstitutions(productionContract),
    rows.length * (NODE_KEY_SUBSTITUTIONS.length - adblockFields) + listRows * (adblockFields + 1)
  );
});

test("EB1: each PageGraph producer row's run matches that row and no other", () => {
  const rows = productionContract.PAGEGRAPH_R2_PRODUCER_TUPLES;
  assert.ok(rows.length >= MIN_PAGEGRAPH_ROWS, `only ${rows.length} PageGraph rows`);
  assert.equal(
    checkPageGraphRowsMatchThemselves(productionContract, pageGraphBase()),
    rows.length * rows.length * METHODOLOGY_SUFFIXES.length
  );
});

test("EB1: a run with any one PageGraph key field changed matches no row", () => {
  assert.equal(
    checkPageGraphSubstitutions(productionContract, pageGraphBase()),
    productionContract.PAGEGRAPH_R2_PRODUCER_TUPLES.length * PAGEGRAPH_KEY_SUBSTITUTIONS.length
  );
});

test("EB1: no PageGraph row accepts a misshapen methodology", () => {
  assert.equal(
    checkPageGraphMethodologyShape(productionContract, pageGraphBase()),
    productionContract.PAGEGRAPH_R2_PRODUCER_TUPLES.length * 5
  );
});

const CANONICAL = "(0, scan_report_v2_fingerprints_1.canonicalJson)";
const NODE_MATCH_REGISTRY = `${CANONICAL}(run.provenance.detectorRegistry) === ${CANONICAL}(tuple.detectorRegistry) &&\n        `;
const NODE_MATCH_VERSIONS = `${CANONICAL}(detectorVersions(run.detectors)) === ${CANONICAL}(tuple.detectorVersions) &&\n        `;
const NODE_MATCH_CATALOG = `${CANONICAL}(run.toolchain.trackerCatalog) === ${CANONICAL}(tuple.trackerCatalog) &&\n        `;
const NODE_MATCH_LISTS = `${CANONICAL}(braveListMeasurementIdentity(run.toolchain.adblock)) ===\n            ${CANONICAL}(braveListMeasurementIdentity(tuple.adblockIdentity)) &&\n        `;

// PageGraph's matcher shares several of these lines, so each edit names the line
// after it too, which only the Node matcher has.
for (const [name, property, find, replace] of [
  [
    "normalization",
    "a-node-run-matches-only-its-own-row",
    "function nodeTupleMatches(run, tuple) {\n    return (run.toolchain.normalizationVersion === tuple.normalizationVersion &&\n        ",
    "function nodeTupleMatches(run, tuple) {\n    return ("
  ],
  [
    "methodology",
    "a-node-run-matches-only-its-own-row",
    "run.provenance.methodologyVersion === tuple.methodologyVersion &&\n        ",
    ""
  ],
  ["detector registry", "a-one-field-substitution-matches-no-row", `${NODE_MATCH_REGISTRY}${CANONICAL}(detectorVersions(`, `${CANONICAL}(detectorVersions(`],
  ["detector versions", "a-one-field-substitution-matches-no-row", NODE_MATCH_VERSIONS, ""],
  ["tracker catalog", "a-one-field-substitution-matches-no-row", `${NODE_MATCH_CATALOG}${CANONICAL}(braveList`, `${CANONICAL}(braveList`],
  ["adblock identity", "a-node-run-matches-only-its-own-row", NODE_MATCH_LISTS, ""]
] as const) {
  test(`EB1 catches a variant: the Node match key loses ${name}`, async () => {
    const broken = contractVariant({ find, replace });
    await assertCaughtBy(name, property, () => {
      checkNodeRowsMatchThemselves(broken);
      checkOneFieldSubstitutions(broken);
    });
  });
}

for (const [name, find, replace] of [
  ["detector registry", `${CANONICAL}(run.provenance.detectorRegistry) === ${CANONICAL}(tuple.detectorRegistry) &&\n        ${CANONICAL}(run.detectors)`, `${CANONICAL}(run.detectors)`],
  ["detectors", `${CANONICAL}(run.detectors) === ${CANONICAL}(tuple.detectors) &&\n        `, ""],
  ["tracker catalog", `${CANONICAL}(run.toolchain.trackerCatalog) === ${CANONICAL}(tuple.trackerCatalog) &&\n        run.toolchain.adblock`, "run.toolchain.adblock"],
  ["adblock identity", "run.toolchain.adblock === tuple.adblockIdentity &&\n        ", ""],
  ["runtime identity", `${CANONICAL}(pageGraphRuntimeIdentity(run)) === ${CANONICAL}(tuple.runtimeIdentity)`, "true"]
] as const) {
  test(`EB1 catches a variant: the PageGraph match key loses ${name}`, async () => {
    await assertCaughtBy(name, "a-one-field-substitution-matches-no-pagegraph-row", () =>
      checkPageGraphSubstitutions(contractVariant({ find, replace }), pageGraphBase())
    );
  });
}

test("EB1 catches a variant: the Node match key loses runtime identity", async () => {
  const broken = contractVariant({ find: `${CANONICAL}(nodeRuntimeIdentity(run)) === ${CANONICAL}(tuple.runtimeIdentity)`, replace: "true" });
  await assertCaughtBy("runtime identity", "a-one-field-substitution-matches-no-row", () => checkOneFieldSubstitutions(broken));
});

test("EB1 catches a variant: a refetch retires the row", async () => {
  const broken = contractVariant({ find: 'const { fetchedAt: _fetchedAt } = identity, measured = __rest(identity, ["fetchedAt"]);\n    return measured;', replace: "return identity;" });
  await assertCaughtBy("a refetch retires the row", "a-refetch-of-the-same-lists-keeps-the-row", () => checkOneFieldSubstitutions(broken));
});

test("EB1 catches a variant: a duplicated Node row carries different limits", async () => {
  const broken = contractVariant({
    find: "    ...ACTIVE_NODE_TUPLES\n]);",
    replace: `    ...ACTIVE_NODE_TUPLES,
    Object.freeze({ ...ACTIVE_NODE_TUPLES[0], id: "variant-duplicate", publicLimits: Object.freeze({ ...ACTIVE_NODE_TUPLES[0].publicLimits, requests: 1 }) })
]);`
  });
  const caught = await assertCaughtBy("a duplicated Node row", "a-node-run-matches-only-its-own-row", () =>
    checkNodeRowsMatchThemselves(broken)
  );
  assert.deepEqual(caught.input, { run: productionContract.NODE_R2_PRODUCER_TUPLES.at(-2)?.id, candidate: "variant-duplicate" });
});

test("EB1 catches a variant: the limit check is gone", async () => {
  const broken = contractVariant({ find: "assertNodePublicLimits(run, tuple.publicLimits);", replace: "" });
  await assertCaughtBy("the limit check is gone", "a-node-row-refuses-past-its-own-limit", () => checkNodeRowLimitsGovern(broken));
});

test("EB1 catches a variant: a limit refuses the value it allows", async () => {
  const broken = contractVariant({ find: "if (actual > maximum)", replace: "if (actual >= maximum)" });
  await assertCaughtBy("a limit off by one", "a-node-row-admits-its-own-limit", () => checkNodeRowLimitsGovern(broken));
});

test("EB1 catches a variant: a duplicated PageGraph row", async () => {
  const broken = contractVariant({
    find: "        detectors: exports.PAGEGRAPH_R2_EXPECTED_DETECTORS\n    })\n]);",
    replace: `        detectors: exports.PAGEGRAPH_R2_EXPECTED_DETECTORS
    }),
    pageGraphTuple("variant-duplicate", scan_report_v2_normalization_1.PAGEGRAPH_R2_NORMALIZATION_VERSION, ACTIVE_TRACKER_CATALOG, {
        methodologyVersion: exports.PAGEGRAPH_R2_METHODOLOGY_VERSION,
        publicLimits: exports.PAGEGRAPH_R2_PUBLIC_LIMITS,
        detectorRegistry: PAGEGRAPH_REGISTRY,
        detectors: exports.PAGEGRAPH_R2_EXPECTED_DETECTORS
    })
]);`
  });
  await assertCaughtBy("a duplicated PageGraph row", "a-pagegraph-run-matches-only-its-own-row", () =>
    checkPageGraphRowsMatchThemselves(broken, pageGraphBase())
  );
});

for (const [name, find, replace] of [
  ["its start anchor", "`^${escapeRegExp(base)}`", "`${escapeRegExp(base)}`"],
  ["its end anchor", 'String.raw `\\+sanitizer-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$`', 'String.raw `\\+sanitizer-[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}`']
] as const) {
  test(`EB1 catches a variant: the PageGraph methodology loses ${name}`, async () => {
    await assertCaughtBy(name, "a-pagegraph-row-refuses-a-misshapen-methodology", () =>
      checkPageGraphMethodologyShape(contractVariant({ find, replace }), pageGraphBase())
    );
  });
}

const OBLIGATION_DIGESTS = Object.fromEntries(
  (
    [
      [HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION, HISTORICAL_DETECTOR_OBLIGATION_REGISTRY],
      [HISTORICAL_V2_DETECTOR_OBLIGATION_CONTRACT_VERSION, HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY],
      [DETECTOR_OBLIGATION_CONTRACT_VERSION, DETECTOR_OBLIGATION_REGISTRY]
    ] as const
  ).map(([version, rules]) => [version, sha256Hex(canonicalJson({ version, rules }))])
) as Readonly<Record<string, string>>;

type Obligations = {
  detectorObligationContractVersion: typeof detectorObligationContractVersion;
};

function epochOf(row: NodeR2ProducerTuple) {
  return { detectorRegistryVersion: row.detectorRegistry.version, detectorRegistryDigest: row.detectorRegistry.digest };
}

function checkRowObligations(contract: Contract, obligations: Obligations): { declared: number; undeclared: number } {
  let declared = 0;
  let undeclared = 0;
  for (const row of contract.NODE_R2_PRODUCER_TUPLES) {
    if (row.detectorObligations === null) {
      undeclared += 1;
      let targeted = true;
      try {
        obligations.detectorObligationContractVersion(epochOf(row));
      } catch {
        targeted = false;
      }
      holds("a-row-without-obligations-names-no-target-epoch", !targeted, () => ({ row: row.id }));
      continue;
    }
    declared += 1;
    const input = () => ({ row: row.id, obligations: row.detectorObligations, registry: row.detectorRegistry });
    let version: string | null = null;
    try {
      version = obligations.detectorObligationContractVersion(epochOf(row));
    } catch {
      version = null;
    }
    holds("a-row-with-obligations-names-a-target-epoch", version !== null, input);
    holds("a-row-names-the-contract-its-registry-is-held-to", row.detectorObligations.version === version, input);
    holds("a-row-names-that-contract's-digest", row.detectorObligations.digest === OBLIGATION_DIGESTS[row.detectorObligations.version], input);
  }
  return { declared, undeclared };
}

test("EB2: every row's obligations are the contract its detector registry is held to", () => {
  // The digest recipe above is the production one, or these two would disagree.
  assert.equal(OBLIGATION_DIGESTS[DETECTOR_OBLIGATION_CONTRACT_VERSION], DETECTOR_OBLIGATION_REGISTRY_DIGEST);
  assert.equal(OBLIGATION_DIGESTS[HISTORICAL_V2_DETECTOR_OBLIGATION_CONTRACT_VERSION], HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY_DIGEST);
  const { declared, undeclared } = checkRowObligations(productionContract, { detectorObligationContractVersion });
  assert.equal(declared + undeclared, productionContract.NODE_R2_PRODUCER_TUPLES.length);
  assert.ok(declared > 0 && undeclared > 0, `declared ${declared}, undeclared ${undeclared}`);
});

test("EB2: every target epoch of the obligation contracts is named by a row", () => {
  const named = new Set(productionContract.NODE_R2_PRODUCER_TUPLES.map((row) => row.detectorRegistry.digest));
  const missing = DETECTOR_OBLIGATION_TARGET_REGISTRIES.filter((target) => !named.has(target.detectorRegistryDigest));
  assert.deepEqual(missing, []);
});

const ACCOUNTABILITY_OBLIGATIONS_FIND = `exports.HISTORICAL_ACCOUNTABILITY_V1_NODE_R2_DETECTOR_OBLIGATIONS = Object.freeze({
    version: "detector-obligations-v1",
    digest: "fb8bd07786fdb71c02ffdf1eca40a73b8974c691c6d4ef3c89230ad5314c22a3"`;

test("EB2 catches a variant: one row's obligation digest is edited", async () => {
  const broken = contractVariant({
    find: ACCOUNTABILITY_OBLIGATIONS_FIND,
    replace: ACCOUNTABILITY_OBLIGATIONS_FIND.replace(/digest: "[0-9a-f]+"/, `digest: "${"0".repeat(64)}"`)
  });
  await assertCaughtBy("an edited digest", "a-row-names-that-contract's-digest", () =>
    checkRowObligations(broken, { detectorObligationContractVersion })
  );
});

test("EB2 catches a variant: one row names another contract's version", async () => {
  const broken = contractVariant({
    find: ACCOUNTABILITY_OBLIGATIONS_FIND,
    replace: ACCOUNTABILITY_OBLIGATIONS_FIND.replace('version: "detector-obligations-v1"', 'version: "detector-obligations-v2"')
  });
  await assertCaughtBy("another contract's version", "a-row-names-the-contract-its-registry-is-held-to", () =>
    checkRowObligations(broken, { detectorObligationContractVersion })
  );
});

test("EB2 catches a variant: the epoch map sends v2 epochs to the active contract", async () => {
  const broken = loadVariant<Obligations>(require.resolve("./detector-obligations"), [
    { find: "if (DETECTOR_OBLIGATIONS_V2_TARGET_REGISTRIES.has(target))\n        return HISTORICAL_V2_OBLIGATION_CONTRACT;\n", replace: "" }
  ]);
  await assertCaughtBy("v2 epochs read as active", "a-row-names-the-contract-its-registry-is-held-to", () =>
    checkRowObligations(productionContract, broken)
  );
});

const TARGET_LOOKUP = `exports.DETECTOR_OBLIGATION_TARGET_REGISTRIES.find((candidate) => candidate.detectorRegistryVersion === epoch.detectorRegistryVersion &&
        candidate.detectorRegistryDigest === epoch.detectorRegistryDigest)`;

test("EB2 catches a variant: a row's registry is no longer a target epoch", async () => {
  const broken = loadVariant<Obligations>(require.resolve("./detector-obligations"), [
    { find: TARGET_LOOKUP, replace: "exports.DETECTOR_OBLIGATION_TARGET_REGISTRIES.find(() => false)" }
  ]);
  await assertCaughtBy("no target epochs", "a-row-with-obligations-names-a-target-epoch", () => checkRowObligations(productionContract, broken));
});

test("EB2 catches a variant: every registry reads as a target epoch", async () => {
  const broken = loadVariant<Obligations>(require.resolve("./detector-obligations"), [
    { find: TARGET_LOOKUP, replace: "exports.DETECTOR_OBLIGATION_TARGET_REGISTRIES.find(() => true)" }
  ]);
  await assertCaughtBy("every registry a target", "a-row-without-obligations-names-no-target-epoch", () => checkRowObligations(productionContract, broken));
});

const NON_COMPLETE_STATUSES = ["partial", "skipped", "unsupported", "failed"] as const satisfies readonly DetectorStatus[];
const REASONS = [...DETECTOR_REASON_CODES, "not-a-reason-code"] as const;
const CAP_REASON = "evidence-cap-reached";
/**
 * Spelled out, not read from DETECTOR_STATUS_REASON_CODES: production's status-v2
 * path reads that table, so a check against it could not tell if the table went
 * wrong. A change here is a change to what reports may say, and should read as one.
 */
const STATUS_REASONS: Readonly<Record<(typeof NON_COMPLETE_STATUSES)[number], readonly string[]>> = {
  partial: ["budget-unavailable", CAP_REASON, "load-failed", "scan-failed"],
  skipped: ["probe-disabled", "budget-unavailable", CAP_REASON, "not-requested", "load-failed", "engine-unavailable"],
  unsupported: ["unsupported"],
  failed: ["load-failed", "engine-unavailable", "scan-failed"]
};

function checkStatusReasonTables(contract: Contract): { v1Rows: number; v2Rows: number; cases: number } {
  let v1Rows = 0;
  let v2Rows = 0;
  let cases = 0;
  for (const row of contract.NODE_R2_PRODUCER_TUPLES) {
    const isV1 = row.detectorStatusContractVersion === "detector-status-v1";
    if (isV1) v1Rows += 1;
    else v2Rows += 1;
    const run = runForNodeRow(row);
    for (const detector of DETECTOR_IDS) {
      const original = run.detectors[detector];
      for (const status of NON_COMPLETE_STATUSES) {
        for (const reason of REASONS) {
          cases += 1;
          run.detectors[detector] = { ...original, status, reason: reason as never };
          const inCurrentTable = STATUS_REASONS[status].includes(reason);
          const expected = inCurrentTable && !(isV1 && reason === CAP_REASON);
          holds(
            isV1 ? "a-v1-row-admits-the-current-table-less-the-cap-reason" : "a-v2-row-admits-exactly-the-current-table",
            !refused(contract, run) === expected,
            () => ({ row: row.id, detector, status, reason })
          );
        }
      }
      for (const reason of REASONS) {
        cases += 1;
        run.detectors[detector] = { ...original, status: "complete", reason: reason as never };
        holds("a-complete-detector-carries-no-reason", refused(contract, run), () => ({ row: row.id, detector, reason }));
      }
      run.detectors[detector] = original;
    }
  }
  return { v1Rows, v2Rows, cases };
}

test("EB3: status-v1 rows admit the current status and reason table less the cap reason, and status-v2 rows all of it", () => {
  const { v1Rows, v2Rows, cases } = checkStatusReasonTables(productionContract);
  assert.ok(v1Rows > 0 && v2Rows > 0, `v1 ${v1Rows}, v2 ${v2Rows}`);
  assert.equal(cases, (v1Rows + v2Rows) * DETECTOR_IDS.length * (NON_COMPLETE_STATUSES.length * REASONS.length + REASONS.length));
  assert.deepEqual(DETECTOR_STATUS_REASON_CODES, STATUS_REASONS);
});

for (const [name, property, find, replace] of [
  [
    "the frozen table admits the cap reason",
    "a-v1-row-admits-the-current-table-less-the-cap-reason",
    'partial: Object.freeze(["budget-unavailable", "load-failed", "scan-failed"]),',
    'partial: Object.freeze(["budget-unavailable", "evidence-cap-reached", "load-failed", "scan-failed"]),'
  ],
  [
    "the frozen table loses a code",
    "a-v1-row-admits-the-current-table-less-the-cap-reason",
    'partial: Object.freeze(["budget-unavailable", "load-failed", "scan-failed"]),',
    'partial: Object.freeze(["budget-unavailable", "load-failed"]),'
  ],
  [
    "status-v1 rows are read under the current table",
    "a-v1-row-admits-the-current-table-less-the-cap-reason",
    'tuple.detectorStatusContractVersion === "detector-status-v1"',
    'tuple.detectorStatusContractVersion === "detector-status-v9"'
  ],
  [
    "a status-v2 row admits any status and reason",
    "a-v2-row-admits-exactly-the-current-table",
    "(0, measurement_kernel_1.isDetectorReasonCode)(entry.reason) && (0, measurement_kernel_1.isDetectorReasonForStatus)(entry.status, entry.reason)",
    "true"
  ],
  [
    "a complete detector may carry a reason",
    "a-complete-detector-carries-no-reason",
    'if (entry.status === "complete") {\n            if (entry.reason !== undefined) {',
    'if (entry.status === "complete") {\n            if (false) {'
  ]
] as const) {
  test(`EB3 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkStatusReasonTables(contractVariant({ find, replace })));
  });
}

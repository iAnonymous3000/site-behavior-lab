import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BRAVE_SNAPSHOT_METADATA_PATH,
  reportCarriesBraveIdentity,
  storedReportGeneration,
  type BraveAdoptionReportGeneration,
  type BraveSnapshotIdentity
} from "./brave-snapshot-adoption";
import { countReportsUnderIdentity } from "./brave-snapshot-adoption-cli";
import { canonicalJson } from "./canonical-json";
import {
  NODE_ADBLOCK_ENGINE_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  recordedAdblockEngineVersion
} from "./legacy-methodology";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makePublicSingleReportV2R2, makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { NODE_R2_CURRENT_ADBLOCK_IDENTITY, NODE_R2_PRODUCER_TUPLES } from "./scan-report-v2-r2-producer-contract";
import { listStaticReportCandidateIds } from "./static-report-files";
import type { ComparisonScanResult, ScanResult } from "./types";

/**
 * The count `npm run lists:adoption` prints for the outgoing Brave identity.
 *
 * On 2026-09-28 it printed 0 while 95 committed v1 reports carried the
 * outgoing snapshot: it matched `manifestDigest`, which no v1 report records.
 * These tests hold each generation to the fields it actually records, on
 * synthetic fixtures and on the committed corpus.
 */

const root = process.cwd();
const cliPath = path.join(root, ".unit-test-dist", "lib", "brave-snapshot-adoption-cli.js");
const CURRENT = NODE_R2_CURRENT_ADBLOCK_IDENTITY as BraveSnapshotIdentity;

/** A frozen v1 run as the Node producer stamps one: the snapshot in `conditions.adblock`, the engine only in its methodology token. */
function v1Report(
  snapshot: Pick<BraveSnapshotIdentity, "source" | "lists" | "fetchedAt">,
  methodology: string | null,
  active = true
): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.conditions = {
    ...report.conditions,
    ...(active ? { shieldsMode: "classification" as const } : {}),
    adblock: { active, source: snapshot.source, lists: snapshot.lists, fetchedAt: snapshot.fetchedAt },
    scannerDisclosure:
      methodology === null
        ? "Automated Chromium scan using Playwright."
        : `Automated Chromium scan under methodology ${methodology}; main-frame navigations are not blocked.`
  };
  return report;
}

/**
 * The Node no-list variant: the engine did not load, so the scanner wrote no
 * `conditions.adblock` at all while its methodology still names the pinned
 * engine. The corpus tests reach it only if a committed report happens to
 * have this shape, so it is held here.
 */
function v1NoListReport(): ScanResult {
  const report = v1Report(CURRENT, NODE_SCANNER_METHODOLOGY_VERSION);
  delete report.conditions.adblock;
  return report;
}

function read(value: unknown): StoredScanReport {
  const result = readStoredScanReport(JSON.parse(JSON.stringify(value)) as unknown);
  assert.ok(result.ok, `the fixture must pass the typed reader, or a non-match proves nothing: ${JSON.stringify(result)}`);
  return result.stored;
}

test("a v1 report counts under the identity its snapshot fetch and methodology engine record", () => {
  assert.equal(CURRENT.engineVersion, NODE_ADBLOCK_ENGINE_VERSION, "the fixture's methodology must name the pinned engine");
  const stored = read(v1Report(CURRENT, NODE_SCANNER_METHODOLOGY_VERSION));
  assert.equal(storedReportGeneration(stored), "v1");

  assert.equal(reportCarriesBraveIdentity(stored, CURRENT), true);
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, engineVersion: "adblock-rust-9.9.9" }), false);
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, lists: CURRENT.lists + 1 }), false);
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, source: "Another list source" }), false);
  // A byte-identical refetch is the same measurement, but a v1 report cannot
  // show it: `fetchedAt` is its only witness of the bytes. Uncounted, never guessed.
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, fetchedAt: "2099-01-01T00:00:00.000Z" }), false);
  // The converse limit: v1 cannot see a manifest, so one fetch time is all of its evidence.
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, manifestDigest: "a".repeat(64) }), true);
});

test("a v1 run proves nothing about an engine it did not name or did not run", () => {
  const unnamed = read(v1Report(CURRENT, null));
  assert.equal(storedReportGeneration(unnamed), "v1");
  assert.equal(reportCarriesBraveIdentity(unnamed, CURRENT), false);

  const inactive = read(v1Report(CURRENT, NODE_SCANNER_METHODOLOGY_VERSION, false));
  assert.equal(reportCarriesBraveIdentity(inactive, CURRENT), false);

  const noList = read(v1NoListReport());
  assert.equal(storedReportGeneration(noList), "v1");
  assert.ok(noList.schemaVersion === 1 && noList.report.reportType !== "comparison");
  assert.equal(noList.report.conditions.adblock, undefined, "the reader must keep the no-list shape, or this proves nothing");
  assert.equal(reportCarriesBraveIdentity(noList, CURRENT), false);

  const earlierEngine = read(
    v1Report(CURRENT, "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1")
  );
  assert.equal(reportCarriesBraveIdentity(earlierEngine, CURRENT), false);
  assert.equal(reportCarriesBraveIdentity(earlierEngine, { ...CURRENT, engineVersion: "adblock-rust-0.13.2" }), true);
});

test("an r2 report counts under its measurement identity, whatever its fetch time", () => {
  for (const report of [makePublicSingleReportV2R2(), makeShieldsInterventionReportV2R2()]) {
    const stored = read(report);
    assert.equal(storedReportGeneration(stored), "v2-r2");
    assert.equal(reportCarriesBraveIdentity(stored, CURRENT), true);
    assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, fetchedAt: "2099-01-01T00:00:00.000Z" }), true);
    assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, manifestDigest: "a".repeat(64) }), false);
    assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, engineVersion: "adblock-rust-9.9.9" }), false);
    assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, lists: CURRENT.lists + 1 }), false);
  }
});

test("a v2 revision 1 report is its own generation and compares its full identity", () => {
  const report = makePublicSingleReportV2();
  const recorded = report.run.toolchain.adblock;
  assert.ok(recorded !== null);
  const stored = read(report);
  assert.equal(storedReportGeneration(stored), "v2-r1");
  assert.equal(reportCarriesBraveIdentity(stored, recorded), true);
  assert.equal(reportCarriesBraveIdentity(stored, CURRENT), false);
});

/**
 * A report was measured under an identity when any of its runs was. Every
 * committed comparison records one snapshot for both runs, so only a pair
 * whose runs differ can tell "any" from "every".
 */
test("a comparison counts when either of its runs carries the identity", async () => {
  const facts = await readCorpusFacts();
  assert.ok(facts.v1ComparisonId, "the corpus holds no v1 comparison whose runs both name a snapshot and an engine");
  const raw = JSON.parse(
    readFileSync(path.join(root, "public", "reports", `${facts.v1ComparisonId}.json`), "utf8")
  ) as ComparisonScanResult;
  const variantAdblock = raw.variant.conditions.adblock!;
  const variantIdentity: BraveSnapshotIdentity = {
    source: variantAdblock.source,
    lists: variantAdblock.lists,
    fetchedAt: variantAdblock.fetchedAt,
    manifestDigest: "a".repeat(64),
    engineVersion: recordedAdblockEngineVersion(raw.variant.conditions.scannerDisclosure)!
  };
  raw.baseline.conditions.adblock = { ...raw.baseline.conditions.adblock!, fetchedAt: "2026-01-01T00:00:00.000Z" };
  const v1 = read(raw);
  assert.equal(reportCarriesBraveIdentity(v1, variantIdentity), true);
  assert.equal(reportCarriesBraveIdentity(v1, { ...variantIdentity, fetchedAt: "2026-01-01T00:00:00.000Z" }), true);
  assert.equal(reportCarriesBraveIdentity(v1, { ...variantIdentity, fetchedAt: "2026-01-02T00:00:00.000Z" }), false);

  // An r2 run cannot be edited without breaking its fingerprints, so this pair
  // skips the reader; the predicate never consults it.
  const r2 = makeShieldsInterventionReportV2R2();
  r2.baseline.toolchain.adblock = { ...CURRENT, manifestDigest: "b".repeat(64) };
  const stored: StoredScanReport = { schemaVersion: 2, schemaRevision: 2, report: r2 };
  assert.equal(reportCarriesBraveIdentity(stored, CURRENT), true);
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, manifestDigest: "b".repeat(64) }), true);
  assert.equal(reportCarriesBraveIdentity(stored, { ...CURRENT, manifestDigest: "c".repeat(64) }), false);
});

function writeReports(reportsDir: string, reports: Record<string, unknown>): void {
  mkdirSync(reportsDir, { recursive: true });
  for (const [id, report] of Object.entries(reports)) {
    writeFileSync(path.join(reportsDir, `${id}.json`), typeof report === "string" ? report : JSON.stringify(report));
  }
}

test("the counter tallies every generation it read and every file it could not", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brave-adoption-count-"));
  try {
    const reportsDir = path.join(dir, "public", "reports");
    writeReports(reportsDir, {
      [`20260928-${"1".repeat(32)}`]: v1Report(CURRENT, NODE_SCANNER_METHODOLOGY_VERSION),
      [`20260928-${"2".repeat(32)}`]: v1Report({ ...CURRENT, fetchedAt: "2026-01-01T00:00:00.000Z" }, NODE_SCANNER_METHODOLOGY_VERSION),
      [`20260928-${"3".repeat(32)}`]: makePublicSingleReportV2R2(),
      [`20260928-${"4".repeat(32)}`]: makeShieldsInterventionReportV2R2(),
      [`20260928-${"5".repeat(32)}`]: makePublicSingleReportV2(),
      [`20260928-${"6".repeat(32)}`]: "{ not json",
      [`20260928-${"7".repeat(32)}`]: { schemaVersion: 1 },
      // The no-list variant: read as v1, matched by nothing. The predicate runs
      // outside the counter's try, so a throw would end the refresh rather than
      // count this file as unreadable.
      [`20260928-${"8".repeat(32)}`]: v1NoListReport()
    });
    // Not report files: never read, never counted as unreadable.
    writeFileSync(path.join(reportsDir, "index.json"), "[]");
    writeFileSync(path.join(reportsDir, `20260928-${"1".repeat(32)}.provenance.json`), "{}");

    assert.deepEqual(await countReportsUnderIdentity(dir, CURRENT), {
      generations: {
        v1: { read: 3, matched: 1 },
        "v2-r1": { read: 1, matched: 0 },
        "v2-r2": { read: 2, matched: 2 }
      },
      unreadable: 2
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run as the refresh workflow runs it: a snapshot whose rules moved, so the
 * count path is reached, which the committed snapshot never reaches while the
 * pinned identity describes it.
 */
test("the CLI prints and emits the per-generation count when the rules moved", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brave-adoption-cli-"));
  try {
    const metaPath = path.join(dir, BRAVE_SNAPSHOT_METADATA_PATH);
    mkdirSync(path.dirname(metaPath), { recursive: true });
    writeFileSync(
      metaPath,
      JSON.stringify({ fetchedAt: "2099-01-01T00:00:00.000Z", sourceCount: CURRENT.lists, manifestDigest: "f".repeat(64) })
    );
    writeReports(path.join(dir, "public", "reports"), {
      [`20260928-${"1".repeat(32)}`]: v1Report(CURRENT, NODE_SCANNER_METHODOLOGY_VERSION),
      [`20260928-${"2".repeat(32)}`]: makePublicSingleReportV2R2()
    });
    const outputPath = path.join(dir, "github-output");
    writeFileSync(outputPath, "");

    const result = spawnSync(process.execPath, [cliPath], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputPath }
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /measured under the outgoing identity: \*\*2\*\*/);
    assert.match(result.stdout, /v1 1 of 1, v2-r1 0 of 0, v2-r2 1 of 1; 0 unreadable/);

    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /^adoption_required=true$/m);
    assert.match(output, /^published_under_pinned=2$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The committed corpus. Reports are selected by what they record, never by id,
// and the oracle below reads the raw wire without the lift under test.
// ---------------------------------------------------------------------------

type RawRun = {
  conditions?: { adblock?: { active?: unknown; source?: unknown; lists?: unknown; fetchedAt?: unknown }; scannerDisclosure?: unknown };
  toolchain?: { adblock?: { source?: unknown; lists?: unknown; manifestDigest?: unknown; engineVersion?: unknown } | null };
};
type RawReport = RawRun & {
  schemaVersion?: unknown;
  schemaRevision?: unknown;
  reportType?: unknown;
  run?: RawRun;
  baseline?: RawRun;
  variant?: RawRun;
};

function rawRuns(raw: RawReport): RawRun[] {
  if (raw.reportType === "comparison") return [raw.baseline ?? {}, raw.variant ?? {}];
  return raw.schemaVersion === 1 ? [raw] : [raw.run ?? {}];
}

function rawGeneration(raw: RawReport): BraveAdoptionReportGeneration {
  if (raw.schemaVersion === 1) return "v1";
  return raw.schemaRevision === 1 ? "v2-r1" : "v2-r2";
}

function oracleCarries(raw: RawReport, identity: BraveSnapshotIdentity): boolean {
  if (raw.schemaVersion === 1) {
    return rawRuns(raw).some((run) => {
      const adblock = run.conditions?.adblock;
      return (
        adblock?.active === true &&
        adblock.source === identity.source &&
        adblock.lists === identity.lists &&
        adblock.fetchedAt === identity.fetchedAt &&
        String(run.conditions?.scannerDisclosure).includes(
          ` methodology shields-request-context-v2-${identity.engineVersion}-request-method-v1`
        )
      );
    });
  }
  return rawRuns(raw).some((run) => {
    const adblock = run.toolchain?.adblock;
    return (
      adblock !== null &&
      adblock !== undefined &&
      adblock.source === identity.source &&
      adblock.lists === identity.lists &&
      adblock.manifestDigest === identity.manifestDigest &&
      adblock.engineVersion === identity.engineVersion
    );
  });
}

/** Every Brave identity the producer contract accepts, found by shape rather than by name. */
function producerContractIdentities(): { label: string; identity: BraveSnapshotIdentity }[] {
  const byKey = new Map<string, BraveSnapshotIdentity>();
  for (const identity of [
    CURRENT,
    ...NODE_R2_PRODUCER_TUPLES.map((tuple) => tuple.adblockIdentity as BraveSnapshotIdentity | null)
  ]) {
    if (identity !== null) byKey.set(canonicalJson(identity), identity);
  }
  return [...byKey.values()].map((identity) => ({
    label: `${identity.fetchedAt} ${identity.manifestDigest.slice(0, 12)} ${identity.engineVersion}`,
    identity
  }));
}

type CorpusFacts = {
  identities: { label: string; identity: BraveSnapshotIdentity }[];
  predicted: Map<string, string[]>;
  expected: Map<string, string[]>;
  expectedByGeneration: Map<string, Record<BraveAdoptionReportGeneration, number>>;
  read: Record<BraveAdoptionReportGeneration, number>;
  unreadable: string[];
  /** v1 reports that share an identity's fetch time but not its engine. */
  engineOnlyDisagreements: number;
  /** A v1 comparison whose runs both name an active snapshot and an engine, selected by that property. */
  v1ComparisonId: string | null;
};

let corpusFacts: Promise<CorpusFacts> | null = null;

/** One pass over the committed corpus, holding ids only; the corpus is too large to keep parsed. */
function readCorpusFacts(): Promise<CorpusFacts> {
  corpusFacts ??= (async () => {
    const reportsDir = path.join(root, "public", "reports");
    const identities = producerContractIdentities();
    const predicted = new Map(identities.map(({ label }) => [label, [] as string[]]));
    const expected = new Map(identities.map(({ label }) => [label, [] as string[]]));
    const expectedByGeneration = new Map(
      identities.map(({ label }) => [label, { v1: 0, "v2-r1": 0, "v2-r2": 0 } as Record<BraveAdoptionReportGeneration, number>])
    );
    const facts: CorpusFacts = {
      identities,
      predicted,
      expected,
      expectedByGeneration,
      read: { v1: 0, "v2-r1": 0, "v2-r2": 0 },
      unreadable: [],
      engineOnlyDisagreements: 0,
      v1ComparisonId: null
    };
    for (const id of await listStaticReportCandidateIds(reportsDir)) {
      const raw = JSON.parse(await readFile(path.join(reportsDir, `${id}.json`), "utf8")) as RawReport;
      const result = readStoredScanReport(raw);
      if (!result.ok) {
        facts.unreadable.push(id);
        continue;
      }
      facts.read[rawGeneration(raw)] += 1;
      if (
        facts.v1ComparisonId === null &&
        raw.schemaVersion === 1 &&
        raw.reportType === "comparison" &&
        rawRuns(raw).every(
          (run) =>
            run.conditions?.adblock?.active === true &&
            / methodology shields-request-context-v2-adblock-rust-/.test(String(run.conditions.scannerDisclosure))
        )
      ) {
        facts.v1ComparisonId = id;
      }
      for (const { label, identity } of identities) {
        if (reportCarriesBraveIdentity(result.stored, identity)) predicted.get(label)!.push(id);
        if (oracleCarries(raw, identity)) {
          expected.get(label)!.push(id);
          expectedByGeneration.get(label)![rawGeneration(raw)] += 1;
        } else if (
          raw.schemaVersion === 1 &&
          rawRuns(raw).some((run) => run.conditions?.adblock?.fetchedAt === identity.fetchedAt)
        ) {
          facts.engineOnlyDisagreements += 1;
        }
      }
    }
    return facts;
  })();
  return corpusFacts;
}

test("every committed report is counted under exactly the identities its own wire records", async () => {
  const facts = await readCorpusFacts();
  assert.deepEqual(facts.unreadable, [], "a committed report the typed reader rejects cannot be counted by generation");
  assert.ok(facts.identities.length > 0, "the producer contract must name at least one Brave identity");

  for (const { label } of facts.identities) {
    assert.deepEqual(facts.predicted.get(label), facts.expected.get(label), `reports counted under ${label}`);
  }

  // Empty-set guards: each generation the corpus holds must be matched under
  // some identity, or the agreement above could hold with nothing counted.
  const matchedIn = (generation: BraveAdoptionReportGeneration) =>
    facts.identities.reduce((sum, { label }) => sum + facts.expectedByGeneration.get(label)![generation], 0);
  assert.ok(facts.read.v1 > 0 && matchedIn("v1") > 0, "no committed v1 report was matched under any producer identity");
  assert.ok(facts.read["v2-r2"] > 0 && matchedIn("v2-r2") > 0, "no committed r2 report was matched under any producer identity");
  // The engine must decide something real: some v1 report shares an
  // identity's fetch time while its methodology names another engine.
  assert.ok(facts.engineOnlyDisagreements > 0, "the corpus no longer exercises the v1 engine comparison");
});

test("the counter reports the committed corpus by generation under the identity most v1 reports carry", async () => {
  const facts = await readCorpusFacts();
  const [chosen] = [...facts.identities].sort(
    (a, b) =>
      facts.expectedByGeneration.get(b.label)!.v1 - facts.expectedByGeneration.get(a.label)!.v1 ||
      a.label.localeCompare(b.label)
  );
  assert.ok(chosen, "the producer contract must name at least one Brave identity");
  const expected = facts.expectedByGeneration.get(chosen.label)!;
  assert.ok(expected.v1 > 0, `no committed v1 report carries any producer identity (chose ${chosen.label})`);

  assert.deepEqual(await countReportsUnderIdentity(root, chosen.identity), {
    generations: {
      v1: { read: facts.read.v1, matched: expected.v1 },
      "v2-r1": { read: facts.read["v2-r1"], matched: expected["v2-r1"] },
      "v2-r2": { read: facts.read["v2-r2"], matched: expected["v2-r2"] }
    },
    unreadable: facts.unreadable.length
  });
});

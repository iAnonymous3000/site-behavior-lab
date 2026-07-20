import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTemporalComparisonReport } from "./compare-reports";
import {
  buildCorpusNeutralitySnapshot,
  compareCorpusNeutralitySnapshots,
  formatCorpusNeutralityComparison,
  parseCorpusNeutralityCliArgs,
  serializeCorpusNeutralitySnapshot,
  type CorpusNeutralitySnapshot
} from "./corpus-neutrality-cli";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

const COMPARABLE_ID = "20260709-" + "a".repeat(32);
const RAW_ONLY_ID = "20260709-" + "b".repeat(32);
const SINGLE_ID = "20260709-" + "c".repeat(32);
const ADDED_ID = "20260709-" + "d".repeat(32);

test("snapshot uses managed canonical views and emits deterministic decision metadata only", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "sbl-corpus-neutrality-"));
  const reportsDir = path.join(rootDir, "public", "reports");
  try {
    await mkdir(reportsDir, { recursive: true });
    // Write out of order to prove that directory enumeration does not affect
    // snapshot bytes. Singles are valid managed corpus members but omitted.
    await writeManagedReport(reportsDir, RAW_ONLY_ID, makeTemporalComparison({ failedVariant: true }));
    await writeManagedReport(reportsDir, SINGLE_ID, makeScanReportV1());
    await writeManagedReport(reportsDir, COMPARABLE_ID, makeTemporalComparison());

    const first = await buildCorpusNeutralitySnapshot(rootDir);
    const second = await buildCorpusNeutralitySnapshot(rootDir);
    assert.equal(serializeCorpusNeutralitySnapshot(first), serializeCorpusNeutralitySnapshot(second));
    assert.deepEqual(first.reports.map((report) => report.reportId), [COMPARABLE_ID, RAW_ONLY_ID]);
    assert.deepEqual(first.reports.map((report) => report.overallMode), ["comparable", "raw-only"]);

    for (const report of first.reports) {
      assert.deepEqual(
        report.families.map((entry) => entry.family),
        [
          "consent-verification",
          "detector-findings",
          "raw-counts",
          "shields-simulation",
          "tracker-classification"
        ]
      );
      assert.deepEqual(Object.keys(report).sort(), ["families", "overallMode", "reportId"]);
      assert.equal(report.families.every((entry) => Object.keys(entry).sort().join(",") === "family,mode,reasons"), true);
    }

    const wire = serializeCorpusNeutralitySnapshot(first);
    assert.equal(wire.includes("example.com"), false);
    assert.equal(wire.includes('"subject"'), false);
    assert.equal(wire.includes('"evidence"'), false);
    assert.equal(wire.includes('"generatedAt"'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("snapshot fails closed when a committed report is not a managed bundle", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "sbl-corpus-neutrality-invalid-"));
  const reportsDir = path.join(rootDir, "public", "reports");
  try {
    await mkdir(reportsDir, { recursive: true });
    const report = redactScanReportV1(makeTemporalComparison()).report;
    await writeFile(path.join(reportsDir, `${COMPARABLE_ID}.json`), `${JSON.stringify(report)}\n`);
    await assert.rejects(() => buildCorpusNeutralitySnapshot(rootDir), /no-sidecar/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("comparison requires exact report sets and zero mode or reason changes", () => {
  const baseline = makeSnapshot();
  const candidate = structuredClone(baseline);
  candidate.reports[0].overallMode = "raw-only";
  candidate.reports[0].families[0].mode = "raw-only";
  candidate.reports[0].families[0].reasons = ["The decision explanation changed."];

  const changed = compareCorpusNeutralitySnapshots(baseline, candidate);
  assert.equal(changed.ok, false);
  assert.equal(changed.reportSetDifferences, 0);
  assert.equal(changed.overallModeFlips, 1);
  assert.equal(changed.familyModeFlips, 1);
  assert.equal(changed.familyReasonChanges, 1);
  assert.match(formatCorpusNeutralityComparison(changed), /1 overall-mode flip/);

  const differentSet = structuredClone(baseline);
  differentSet.reports.pop();
  const added = structuredClone(differentSet.reports[0]);
  added.reportId = ADDED_ID;
  differentSet.reports.push(added);
  const setResult = compareCorpusNeutralitySnapshots(baseline, differentSet);
  assert.equal(setResult.ok, false);
  assert.equal(setResult.reportSetDifferences, 2);
  assert.deepEqual(setResult.differences.map((entry) => entry.kind), ["report-removed", "report-added"]);

  const unchanged = compareCorpusNeutralitySnapshots(baseline, structuredClone(baseline));
  assert.equal(unchanged.ok, true);
  assert.equal(formatCorpusNeutralityComparison(unchanged), "Corpus neutrality unchanged across 2 managed comparison reports.");
});

test("strict snapshot parsing rejects extra subject data and CLI compare exits nonzero on a difference", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-corpus-neutrality-cli-"));
  try {
    const baselineFile = path.join(directory, "baseline.json");
    const candidateFile = path.join(directory, "candidate.json");
    const baseline = makeSnapshot();
    const candidate = structuredClone(baseline);
    candidate.reports[0].families[0].reasons = ["Changed."];
    await Promise.all([
      writeFile(baselineFile, serializeCorpusNeutralitySnapshot(baseline)),
      writeFile(candidateFile, serializeCorpusNeutralitySnapshot(candidate))
    ]);

    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "corpus-neutrality-cli.js"), "compare", "--baseline", baselineFile, "--candidate", candidateFile],
      { encoding: "utf8" }
    );
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.match(run.stdout, /1 family-reason change/);

    const contaminated = structuredClone(baseline) as unknown as {
      reports: Array<Record<string, unknown>>;
    };
    contaminated.reports[0].subject = "https://private.example/path";
    assert.throws(() => compareCorpusNeutralitySnapshots(contaminated, baseline), /invalid shape/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI arguments keep snapshot and compare inputs explicit", () => {
  assert.deepEqual(parseCorpusNeutralityCliArgs(["snapshot", "--out", "baseline.json"]), {
    command: "snapshot",
    rootDir: path.resolve(process.cwd()),
    outputFile: path.resolve("baseline.json")
  });
  assert.throws(
    () => parseCorpusNeutralityCliArgs(["snapshot", "--root", "checkout", "--out", "baseline.json"]),
    /Unknown snapshot argument/
  );
  assert.deepEqual(
    parseCorpusNeutralityCliArgs(["compare", "--baseline", "baseline.json", "--candidate", "candidate.json"]),
    {
      command: "compare",
      baselineFile: path.resolve("baseline.json"),
      candidateFile: path.resolve("candidate.json")
    }
  );
  assert.throws(() => parseCorpusNeutralityCliArgs([]), /snapshot or compare/);
  assert.throws(() => parseCorpusNeutralityCliArgs(["snapshot"]), /--out is required/);
  assert.throws(
    () => parseCorpusNeutralityCliArgs(["compare", "--baseline", "same.json", "--candidate", "same.json"]),
    /different files/
  );
});

function makeTemporalComparison(options: { failedVariant?: boolean } = {}): ScanReport {
  const baseline = makeScanReportV1();
  if (baseline.reportType === "comparison") throw new Error("fixture invariant");
  const variant: ScanResult = structuredClone(baseline);
  variant.conditions.scannedAt = "2026-07-09T11:00:00.000Z";
  if (options.failedVariant) variant.summary.status = 403;
  return createTemporalComparisonReport(baseline, variant);
}

async function writeManagedReport(reportsDir: string, reportId: string, input: ScanReport): Promise<void> {
  const report = redactScanReportV1(input).report;
  const createdAt = report.reportType === "comparison" ? report.scannedAt : report.conditions.scannedAt;
  const sidecar = buildProvenanceEntry({
    reportId,
    publicReport: report,
    writtenAt: "2026-07-19T00:00:00.000Z",
    createdAt,
    expiresAt: null
  });
  await Promise.all([
    writeFile(path.join(reportsDir, `${reportId}.json`), `${JSON.stringify(report)}\n`),
    writeFile(path.join(reportsDir, committedSidecarFilename(reportId)), `${JSON.stringify(sidecar)}\n`)
  ]);
}

function makeSnapshot(): CorpusNeutralitySnapshot {
  const families = [
    { family: "consent-verification" as const, mode: "suppressed" as const, reasons: ["Consent was not measured."] },
    { family: "detector-findings" as const, mode: "raw-only" as const, reasons: ["Versions were not recorded."] },
    { family: "raw-counts" as const, mode: "comparable" as const, reasons: [] },
    { family: "shields-simulation" as const, mode: "suppressed" as const, reasons: ["Shields was not measured."] },
    { family: "tracker-classification" as const, mode: "comparable" as const, reasons: [] }
  ];
  return {
    snapshotVersion: 1,
    reports: [
      { reportId: COMPARABLE_ID, overallMode: "comparable", families: structuredClone(families) },
      { reportId: RAW_ONLY_ID, overallMode: "raw-only", families: structuredClone(families) }
    ]
  };
}

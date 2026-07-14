import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  aggregateV2ShadowFiles,
  formatV2ShadowAggregationResult,
  parseAggregateV2ShadowArgs
} from "./aggregate-v2-shadow-cli";
import { readStoredScanReport } from "./scan-report-reader";
import { makeGpcInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import type { PublicComparisonReportV2R2 } from "./scan-report-v2-r2";

const BUILD = "f".repeat(40);

test("the aggregation CLI writes one create-only artifact and a hash-bound local receipt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-v2-aggregate-"));
  try {
    const primaryFile = path.join(directory, "primary.json");
    const supportingFile = path.join(directory, "supporting.json");
    const outputDirectory = path.join(directory, "derived");
    const primaryWire = `${JSON.stringify(makeGpcInterventionReportV2R2(), null, 2)}\n`;
    const supportingWire = `${JSON.stringify(makeSupportingGpcPair(), null, 2)}\n`;
    await Promise.all([
      writeFile(primaryFile, primaryWire),
      writeFile(supportingFile, supportingWire)
    ]);

    const result = await aggregateV2ShadowFiles(
      {
        primaryFile,
        supportingFile,
        outputDirectory,
        expectedBuild: BUILD,
        primaryKey: `v2-shadow/${BUILD}/comparison/pair-gpc-r2.json`,
        supportingKey: `v2-shadow/${BUILD}/comparison/pair-gpc-r2-support-cli.json`,
        requireCounterbalanced: true
      },
      () => new Date("2026-07-13T20:00:00.000Z")
    );

    assert.equal(path.basename(result.artifactPath), "pair-gpc-r2.json");
    assert.equal(path.basename(result.receiptPath), "pair-gpc-r2.receipt.json");
    assert.equal(result.receipt.createdAt, "2026-07-13T20:00:00.000Z");
    assert.equal(result.receipt.counterbalanced, true);
    assert.equal(result.receipt.strength, "observed-difference");
    assert.deepEqual(result.receipt.inputs.map((entry) => entry.sha256), [sha256(primaryWire), sha256(supportingWire)]);
    assert.deepEqual(result.receipt.inputs.map((entry) => entry.pairId), [
      "pair-gpc-r2",
      "pair-gpc-r2-support-cli"
    ]);

    const artifactWire = await readFile(result.artifactPath, "utf8");
    assert.equal(result.receipt.artifact.sha256, sha256(artifactWire));
    assert.equal(result.receipt.artifact.publicBytes, Buffer.byteLength(artifactWire, "utf8"));
    const parsed = JSON.parse(artifactWire) as unknown;
    const read = readStoredScanReport(parsed);
    assert.equal(read.ok, true);
    if (read.ok && read.stored.schemaVersion === 2 && read.stored.schemaRevision === 2) {
      assert.equal(read.stored.report.reportType, "comparison");
      if (read.stored.report.reportType === "comparison" && read.stored.report.experiment.kind === "intervention") {
        assert.equal(read.stored.report.experiment.supportingPairs?.length, 1);
        assert.deepEqual(read.stored.report.experiment.evidence, {
          pairs: 2,
          counterbalanced: true,
          strength: "observed-difference"
        });
      }
    }

    const receiptWire = await readFile(result.receiptPath, "utf8");
    assert.equal(receiptWire.includes(directory), false, "receipt never leaks local absolute paths");
    assert.match(formatV2ShadowAggregationResult(result), /does not represent a replicated-effect claim/);

    await assert.rejects(
      () =>
        aggregateV2ShadowFiles({
          primaryFile,
          supportingFile,
          outputDirectory,
          expectedBuild: BUILD,
          requireCounterbalanced: true
        }),
      /EEXIST/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI gate can require opposite AB/BA orders and the expected build", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-v2-aggregate-gates-"));
  try {
    const primaryFile = path.join(directory, "primary.json");
    const supportingFile = path.join(directory, "supporting.json");
    await Promise.all([
      writeFile(primaryFile, `${JSON.stringify(makeGpcInterventionReportV2R2())}\n`),
      writeFile(supportingFile, `${JSON.stringify(makeSupportingGpcPair("AB"))}\n`)
    ]);

    await assert.rejects(
      () =>
        aggregateV2ShadowFiles({
          primaryFile,
          supportingFile,
          outputDirectory: path.join(directory, "same-order"),
          expectedBuild: BUILD,
          requireCounterbalanced: true
        }),
      /counterbalanced AB\/BA evidence was required/
    );
    await assert.rejects(
      () =>
        aggregateV2ShadowFiles({
          primaryFile,
          supportingFile,
          outputDirectory: path.join(directory, "wrong-build"),
          expectedBuild: "a".repeat(40),
          requireCounterbalanced: false
        }),
      /does not match --expected-build/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI arguments are explicit, bounded, and path-normalized", () => {
  assert.deepEqual(
    parseAggregateV2ShadowArgs([
      "--primary",
      "downloads/primary.json",
      "--supporting",
      "downloads/support.json",
      "--out-dir",
      "derived",
      "--expected-build",
      BUILD.toUpperCase(),
      "--primary-key",
      "v2-shadow/build/comparison/primary.json",
      "--supporting-key",
      "v2-shadow/build/comparison/support.json",
      "--require-counterbalanced"
    ]),
    {
      primaryFile: path.resolve("downloads/primary.json"),
      supportingFile: path.resolve("downloads/support.json"),
      outputDirectory: path.resolve("derived"),
      expectedBuild: BUILD,
      primaryKey: "v2-shadow/build/comparison/primary.json",
      supportingKey: "v2-shadow/build/comparison/support.json",
      requireCounterbalanced: true
    }
  );
  assert.throws(() => parseAggregateV2ShadowArgs([]), /--primary is required/);
  assert.throws(
    () =>
      parseAggregateV2ShadowArgs([
        "--primary",
        "same.json",
        "--supporting",
        "same.json",
        "--out-dir",
        "out",
        "--expected-build",
        BUILD
      ]),
    /different files/
  );
  assert.throws(
    () =>
      parseAggregateV2ShadowArgs([
        "--primary",
        "a.json",
        "--supporting",
        "b.json",
        "--out-dir",
        "out",
        "--expected-build",
        "main"
      ]),
    /full 40-character/
  );
  assert.throws(() => parseAggregateV2ShadowArgs(["--wat"]), /Unknown argument/);
});

function makeSupportingGpcPair(order: "AB" | "BA" = "BA"): PublicComparisonReportV2R2 {
  const report = structuredClone(makeGpcInterventionReportV2R2());
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  report.experiment.pairId = "pair-gpc-r2-support-cli";
  report.experiment.order = order;
  report.experiment.evidence = { pairs: 1, counterbalanced: false, strength: "observed-difference" };
  report.baseline.runId = "run-gpc-off-support-cli";
  report.variant.runId = "run-gpc-on-support-cli";
  if (order === "AB") {
    report.baseline.startedAt = "2026-07-09T11:00:00.000Z";
    report.variant.startedAt = "2026-07-09T11:01:00.000Z";
  } else {
    report.baseline.startedAt = "2026-07-09T11:01:00.000Z";
    report.variant.startedAt = "2026-07-09T11:00:00.000Z";
  }
  return report;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

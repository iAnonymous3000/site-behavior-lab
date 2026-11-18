import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { censusInputProblems, readCensusInputs } from "./census-inputs.mjs";
import {
  assertDiscriminatorMatchesProduct,
  normalizeHistoricalLossDetail,
  RESPONSE_BYTE_CAPTURE_LOSS_DETAIL
} from "./historical-loss-detail.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const BYTE_WARNING =
  "Some responses were not fully read after reaching the 64 MiB aggregate response-byte budget.";
const CAP_WARNING =
  "The scan stopped recording or loading additional requests after 1000 requests.";
const merged = () => ({
  family: "requests",
  phaseId: null,
  kind: "cap",
  count: 42,
  detail: "request-capture"
});

test("a byte-budget loss is resolved away from the recording cap", () => {
  assert.equal(
    normalizeHistoricalLossDetail(merged(), [BYTE_WARNING]).detail,
    RESPONSE_BYTE_CAPTURE_LOSS_DETAIL
  );
});

test("a recording-cap loss is left alone", () => {
  assert.equal(normalizeHistoricalLossDetail(merged(), [CAP_WARNING]).detail, "request-capture");
  assert.equal(normalizeHistoricalLossDetail(merged(), []).detail, "request-capture");
});

/**
 * The ambiguous run is the whole reason this is a discriminator and not a
 * rename. When both ceilings fired, nothing in the record says which one cut
 * which request, so the merged token stands.
 */
test("a run that hit both ceilings keeps the merged token", () => {
  assert.equal(
    normalizeHistoricalLossDetail(merged(), [BYTE_WARNING, CAP_WARNING]).detail,
    "request-capture"
  );
});

test("losses that never shared a token are untouched", () => {
  for (const detail of ["proxy-traffic", "cname-lookups", "public-request-unregistrable-hosts"]) {
    const loss = { ...merged(), detail };
    assert.equal(normalizeHistoricalLossDetail(loss, [BYTE_WARNING]).detail, detail);
  }
  assert.equal(normalizeHistoricalLossDetail(null, [BYTE_WARNING]), null);
});

test("the restated discriminator still matches the product rule", () => {
  assert.doesNotThrow(() => assertDiscriminatorMatchesProduct(repoRoot));

  // Mutation coverage. The pin's whole value is refusing a drifted product
  // source, so it is shown refusing one.
  const fake = mkdtempSync(path.join(tmpdir(), "loss-detail-pin-"));
  try {
    mkdirSync(path.join(fake, "lib"), { recursive: true });
    writeFileSync(
      path.join(fake, "lib", "scan-report-censorship.ts"),
      "const RESPONSE_BYTE_LIMIT_WARNING = /a different sentence/;\n"
    );
    assert.throws(
      () => assertDiscriminatorMatchesProduct(fake),
      /historical capture-loss discriminator drifted/
    );
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

/**
 * Anchored to the committed artifact, not only to the function, so the
 * attribution cannot silently revert to the merged token the next time the
 * driver is regenerated.
 */
test("the committed findings attribute the byte-budget loss separately", () => {
  const findings = readFileSync(
    path.join(here, "corpus-censoring-findings.txt"),
    "utf8"
  );
  assert.match(findings, /requests\/response-bytes\/cap/);
  assert.doesNotMatch(
    findings,
    /5 {2}requests\/request-capture\/cap/,
    "five recording-cap losses is the pre-discriminator count"
  );
});

test("the census pin check names every way the reports read and the pins disagree", () => {
  const runs = [{ reportId: "a" }, { reportId: "a" }, { reportId: "b" }, { reportId: "b" }];
  assert.deepEqual(censusInputProblems(runs, { reportIds: ["a", "b"], runCount: 4 }), []);
  assert.deepEqual(censusInputProblems(runs, { reportIds: ["a"], runCount: 4 }), ["read but not pinned: b"]);
  assert.deepEqual(censusInputProblems(runs, { reportIds: ["a", "b", "c"], runCount: 4 }), ["pinned but not read: c"]);
  assert.deepEqual(censusInputProblems(runs, { reportIds: ["a", "b"], runCount: 6 }), ["runs read: 4, pinned runCount: 6"]);
  assert.deepEqual(censusInputProblems(runs, { reportIds: ["a", "b", "b"], runCount: 4 }), ["the pin list names a report twice"]);
});

test("the committed census pins cite the 126 runs the committed findings state", () => {
  const inputs = readCensusInputs(repoRoot);
  assert.equal(inputs.reportIds.length, 63);
  assert.equal(inputs.runCount, 126);
  assert.equal(new Set(inputs.reportIds).size, inputs.reportIds.length, "no report is cited twice");
  assert.deepEqual(inputs.reportIds, [...inputs.reportIds].sort(), "the list stays sorted so a change reads as a diff");
  const findings = readFileSync(path.join(here, "corpus-censoring-findings.txt"), "utf8");
  assert.equal(Number(findings.match(/generated from (\d+) r2 runs/)?.[1]), inputs.runCount);
});

/**
 * The binding is only worth its pins if the analyzer refuses a list that
 * disagrees with what it reads. A scratch root holds one frozen r2 report and
 * links the code the analyzer reads at startup, so the check runs for real.
 */
test("the analyzer refuses a census pin list that disagrees with the reports it reads", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "census-pins-"));
  const reportId = "20260714-be94cc2d911e26d027950a336147917e";
  try {
    const packageDir = path.join(scratch, "research", "calibration-censoring");
    mkdirSync(packageDir, { recursive: true });
    for (const file of ["analyze-corpus-censoring.mjs", "census-inputs.mjs", "historical-loss-detail.mjs", "corpus-censoring-findings.txt"]) {
      copyFileSync(path.join(here, file), path.join(packageDir, file));
    }
    for (const dir of ["lib", "scripts"]) symlinkSync(path.join(repoRoot, dir), path.join(scratch, dir));
    mkdirSync(path.join(scratch, "public", "reports"), { recursive: true });
    copyFileSync(path.join(repoRoot, "public", "featured-sites.json"), path.join(scratch, "public", "featured-sites.json"));
    copyFileSync(
      path.join(repoRoot, "test-fixtures", "reports", `${reportId}.json`),
      path.join(scratch, "public", "reports", `${reportId}.json`)
    );
    const check = (reportIds, runCount) => {
      writeFileSync(path.join(packageDir, "corpus-censoring-inputs.json"), `${JSON.stringify({ reportIds, runCount })}\n`);
      const result = spawnSync(process.execPath, [path.join(packageDir, "analyze-corpus-censoring.mjs"), "--check"], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL"
      });
      assert.equal(result.signal, null, "the analyzer must exit on its own");
      assert.equal(result.error, undefined);
      return result;
    };

    const disagreeing = check(["20260814-001603a1f90af9cd2fee0e1c9be85758"], 2);
    assert.equal(disagreeing.status, 1);
    assert.match(disagreeing.stderr, /corpus-censoring-inputs\.json disagrees with the reports this package reads/);
    assert.match(disagreeing.stderr, new RegExp(`read but not pinned: ${reportId}`));
    assert.match(disagreeing.stderr, /pinned but not read: 20260814-001603a1f90af9cd2fee0e1c9be85758/);

    // Pins that agree pass the binding, and the analyzer goes on to render.
    // (One report is too few for its policy simulation to finish, so only
    // the start of the rendering is asserted.)
    const agreeing = check([reportId], 2);
    assert.doesNotMatch(agreeing.stderr, /disagrees/);
    assert.match(agreeing.stdout, /^CALIBRATION CENSORING DECISION PACKAGE\n/);
    assert.match(agreeing.stdout, /generated from 2 r2 runs/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

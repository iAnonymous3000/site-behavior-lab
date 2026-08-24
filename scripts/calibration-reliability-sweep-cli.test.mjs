import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bareLoadOutcome, EXPECTED_EVIDENCE_FAMILIES } from "./calibration-reliability-sweep-lib.mjs";
import { buildPassArtifact } from "./calibration-reliability-sweep-run-lib.mjs";

/**
 * END-TO-END: these tests SPAWN the real CLI. The corrective history behind
 * them: a merge changed the driver's header comments while its implementation
 * kept importing a removed export, and every library test stayed green
 * because none launched the process. A missing export, a stale command
 * table, or comment-only wiring must fail HERE.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(moduleDir, "calibration-reliability-sweep-run.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const sha = (seed) => seed.repeat(64).slice(0, 64);

function soundReport() {
  return {
    run: {
      summary: { status: 200 },
      quality: {
        run: { outcome: "complete" },
        byFamily: Object.fromEntries(
          EXPECTED_EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete" }])
        )
      },
      qualityFacts: {
        status: 200,
        navigationSettled: true,
        botWallTitleMatched: false,
        captureLoss: [],
        budgetsExhausted: []
      }
    }
  };
}

test("the CLI actually launches: import errors and stale commands cannot hide behind green library tests", () => {
  const noArgs = run([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /collect <round 1\.\.12>/);
  assert.match(noArgs.stderr, /receipt <candidates> <round1> \[round2 \.\.\.\] <out>/);
  assert.match(noArgs.stderr, /bound <candidates> <round1> \[round2 \.\.\.\] <receipt> <out>/);
  // The exact invocation that exposed the broken merge.
  const help = run(["--help"]);
  assert.equal(help.status, 1);
  assert.doesNotMatch(help.stderr, /is not exported|SyntaxError|ReferenceError/);

  const badRound = run(["collect", "0", "a.json", "b.json"]);
  assert.equal(badRound.status, 1);
  assert.match(badRound.stderr, /collect <round 1\.\.12>/);
  const round13 = run(["collect", "13", "a.json", "b.json"]);
  assert.equal(round13.status, 1);
});

test("receipt and bound run end to end through the real process over five rounds", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-cli-"));
  const candidateSet = {
    studyId: "cli-smoke-study",
    candidates: [
      { caseId: "alpha.example", url: "https://alpha.example/" },
      { caseId: "beta.example", url: "https://beta.example/" }
    ]
  };
  const candidatesPath = path.join(dir, "candidates.json");
  const candidateBytes = `${JSON.stringify(candidateSet, null, 2)}\n`;
  writeFileSync(candidatesPath, candidateBytes);
  const { createHash } = await import("node:crypto");
  const candidateSetDigest = createHash("sha256").update(candidateBytes).digest("hex");

  const identity = {
    buildCommit: "a".repeat(40),
    runtime: "node-test",
    runnerLabel: "cli-smoke",
    egress: "cli-smoke"
  };
  const condition = { device: "desktop", consentMode: "observe", gpcEnabled: false };
  const at = [
    "2026-08-23T01:00:00.000Z",
    "2026-08-25T02:00:00.000Z",
    "2026-08-26T03:00:00.000Z",
    "2026-08-27T04:00:00.000Z",
    "2026-08-28T05:00:00.000Z"
  ];
  const roundPaths = at.map((when, index) => {
    const artifact = buildPassArtifact({
      studyId: "cli-smoke-study",
      pass: index + 1,
      candidateSetDigest,
      measurementCondition: condition,
      identity,
      outcomes: candidateSet.candidates.map((candidate) =>
        bareLoadOutcome(candidate.caseId, soundReport(), { pass: index + 1, observedAt: when })
      )
    });
    const file = path.join(dir, `round-${index + 1}.json`);
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    return file;
  });

  const receiptPath = path.join(dir, "receipt.json");
  const receiptRun = run(["receipt", candidatesPath, ...roundPaths, receiptPath]);
  assert.equal(receiptRun.status, 0, receiptRun.stderr);
  assert.match(receiptRun.stdout, /receipt: 5 rounds, 2 candidates, 2 eligible/);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.diagnostics.allFamiliesCompleteBothPasses, 2);

  const boundPath = path.join(dir, "bound.json");
  const boundRun = run(["bound", candidatesPath, ...roundPaths, receiptPath, boundPath]);
  assert.equal(boundRun.status, 0, boundRun.stderr);
  assert.match(boundRun.stdout, /loss bound over 5 rounds/);
  const boundArtifact = readFileSync(boundPath, "utf8");
  const parsed = JSON.parse(boundArtifact);
  assert.equal(parsed.rounds, 5);
  assert.equal(parsed.method.algorithm, "cluster-bootstrap");
  assert.equal(/wilson|interval95/i.test(boundArtifact), false);

  // Below the preregistered minimum the CLI itself refuses, end to end.
  const shortReceiptPath = path.join(dir, "short-receipt.json");
  const shortRun = run(["receipt", candidatesPath, ...roundPaths.slice(0, 3), shortReceiptPath]);
  assert.equal(shortRun.status, 0, shortRun.stderr);
  const shortBound = run([
    "bound",
    candidatesPath,
    ...roundPaths.slice(0, 3),
    shortReceiptPath,
    path.join(dir, "short-bound.json")
  ]);
  assert.equal(shortBound.status, 1);
  assert.match(shortBound.stderr, /preregistered minimum is 4/);
});

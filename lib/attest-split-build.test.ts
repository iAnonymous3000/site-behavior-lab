import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSyncBounded } from "./bounded-spawn";

/**
 * attest's check of the split build runs only on main, where a pass also
 * promotes, so it is first exercised here: this file takes the exact script
 * text out of ci.yml and runs it against fixture evidence, so a change to the
 * step is a change to what these cases run.
 */
const root = process.cwd();
const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const STEP = "      - name: Validate the split build and every image-Node verdict\n";

function validatorStep(): { script: string; legs: string } {
  const start = ci.indexOf(STEP);
  assert.ok(start >= 0, "attest no longer validates the split build");
  const step = ci.slice(start, ci.indexOf("\n      - name: ", start + 1));
  const open = "          node <<'SPLIT'\n";
  const close = "\n          SPLIT\n";
  const body = step.slice(step.indexOf(open) + open.length, step.indexOf(close));
  assert.ok(step.includes(open) && step.includes(close) && body.length > 0, "the validator must be one quoted heredoc");
  const legs = /\n {10}EXPECTED_LEGS: ([^\n]+)\n/.exec(step)?.[1];
  assert.ok(legs, "the validator must name its expected legs");
  return { script: body.replace(/^ {10}/gm, ""), legs };
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = 43775620944;
const id = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const SOURCE = id(1);
const RUNNER = id(4);

type Fixture = {
  record?: Record<string, unknown> | null;
  receiptImageId?: string;
  verdicts?: Record<string, Record<string, unknown> | null>;
  extraVerdict?: string;
  /** null leaves GITHUB_RUN_ATTEMPT unset; a string is passed as written. */
  attempt?: number | string | null;
};

function goodRecord(): Record<string, unknown> {
  return {
    schema: "site-behavior-lab/split-build/v1",
    buildPath: "split",
    commit: COMMIT,
    sourceOciDigest: id(2),
    sourceImageId: SOURCE,
    compiledOciDigest: id(3),
    runnerImageId: RUNNER
  };
}

function goodVerdict(leg: string): Record<string, unknown> {
  return { schema: "site-behavior-lab/image-test-verdict/v1", leg, commit: COMMIT, runId: RUN_ID, runAttempt: 1, sourceImageId: SOURCE, exitCode: 0 };
}

function run(t: { after(fn: () => void): void }, fixture: Fixture = {}) {
  const { script, legs } = validatorStep();
  const dir = mkdtempSync(path.join(os.tmpdir(), "attest-split-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const verdictDir = path.join(dir, "verdicts");
  mkdirSync(verdictDir);
  const record = fixture.record === undefined ? goodRecord() : fixture.record;
  if (record !== null) writeFileSync(path.join(dir, "split-build.json"), JSON.stringify(record));
  const receipt = { artifacts: [{ name: "container-image", kind: "docker-image-inspection", imageId: fixture.receiptImageId ?? RUNNER }] };
  writeFileSync(path.join(dir, "receipt.json"), JSON.stringify(receipt));
  for (const leg of legs.split(" ")) {
    const verdict = fixture.verdicts && leg in fixture.verdicts ? fixture.verdicts[leg] : goodVerdict(leg);
    if (verdict !== null) writeFileSync(path.join(verdictDir, `image-test-verdict-${leg}.json`), JSON.stringify(verdict));
  }
  if (fixture.extraVerdict) writeFileSync(path.join(verdictDir, fixture.extraVerdict), JSON.stringify(goodVerdict("extra")));
  const manifest = path.join(dir, "out", "verdicts.json");
  const result = spawnSyncBounded(process.execPath, ["-"], {
    input: script,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_SHA: COMMIT,
      GITHUB_RUN_ID: String(RUN_ID),
      ...(fixture.attempt === null ? {} : { GITHUB_RUN_ATTEMPT: String(fixture.attempt ?? 1) }),
      EXPECTED_LEGS: legs,
      SPLIT_BUILD_PATH: path.join(dir, "split-build.json"),
      CONTAINER_EVIDENCE_PATH: path.join(dir, "receipt.json"),
      VERDICT_DIR: verdictDir,
      VERDICT_MANIFEST_PATH: manifest
    }
  });
  return { status: result.status, stderr: `${result.stderr}`, manifest, legs: legs.split(" ") };
}

const refuses = (outcome: { status: number | null; stderr: string }, message: RegExp) => {
  assert.notEqual(outcome.status, 0, "the validator must refuse");
  assert.match(outcome.stderr, message);
};

test("attest's split build check passes a complete split build and writes the verdict manifest", (t) => {
  const outcome = run(t);
  assert.equal(outcome.status, 0, outcome.stderr);
  const manifest = JSON.parse(readFileSync(outcome.manifest, "utf8"));
  assert.equal(manifest.schema, "site-behavior-lab/image-test-verdicts/v1");
  assert.equal(manifest.commit, COMMIT);
  assert.equal(manifest.sourceImageId, SOURCE);
  assert.deepEqual(manifest.verdicts.map((verdict: { leg: string }) => verdict.leg), outcome.legs);
  assert.ok(outcome.legs.length > 0);
  // A leg rerun in a later attempt keeps the other legs' earlier attempts.
  const rerun = run(t, { attempt: 2, verdicts: { [outcome.legs[0]]: { ...goodVerdict(outcome.legs[0]), runAttempt: 2 } } });
  assert.equal(rerun.status, 0, rerun.stderr);
});

test("attest's split build check refuses a missing record, or one of another path, commit or schema", (t) => {
  refuses(run(t, { record: null }), /ENOENT|no such file/);
  refuses(run(t, { record: { ...goodRecord(), buildPath: "plain" } }), /not a split build/);
  refuses(run(t, { record: { ...goodRecord(), schema: "site-behavior-lab/split-build/v2" } }), /not a split build/);
  refuses(run(t, { record: { ...goodRecord(), commit: "f".repeat(40) } }), /Split build record identifies/);
  refuses(run(t, { record: { ...goodRecord(), sourceImageId: "site-behavior-lab:source" } }), /sourceImageId is not a sha256 digest/);
  refuses(run(t, { record: { ...goodRecord(), extra: true } }), /does not hold exactly/);
});

test("attest's split build check refuses a record with any field absent", (t) => {
  for (const key of Object.keys(goodRecord())) {
    const record = goodRecord();
    delete record[key];
    refuses(run(t, { record }), /Split build record does not hold exactly/);
  }
});

test("attest's split build check refuses a runner image other than the container evidence's", (t) => {
  refuses(run(t, { receiptImageId: id(9) }), /names another image than the container evidence/);
});

test("attest's split build check refuses a verdict that tested another source image, failed, or is not this run's", (t) => {
  const { legs } = run(t);
  const leg = legs[legs.length - 1];
  refuses(run(t, { verdicts: { [leg]: { ...goodVerdict(leg), sourceImageId: id(8) } } }), /tested another image than the split build's source/);
  refuses(run(t, { verdicts: { [leg]: { ...goodVerdict(leg), exitCode: 1 } } }), new RegExp(`Leg ${leg} did not pass`));
  refuses(run(t, { verdicts: { [leg]: { ...goodVerdict(leg), commit: "f".repeat(40) } } }), /is not this commit's run/);
  refuses(run(t, { verdicts: { [leg]: { ...goodVerdict(leg), runId: RUN_ID + 1 } } }), /is not this commit's run/);
  refuses(run(t, { verdicts: { [leg]: { ...goodVerdict(leg), runAttempt: 2 } } }), /names attempt 2/);
  refuses(run(t, { verdicts: { [leg]: { ...goodVerdict(leg), leg: "tail-of-another" } } }), /names tail-of-another/);
  const partial = goodVerdict(leg);
  delete partial.exitCode;
  refuses(run(t, { verdicts: { [leg]: partial } }), /does not hold exactly/);
});

test("attest's split build check refuses a run attempt that is not a positive integer", (t) => {
  // Number() of any of these is NaN or below 1, so a verdict of any attempt
  // would pass the attempt bound unless the attempt itself is checked first.
  for (const attempt of [null, "", "0", "-1", "1.5", "two", " 1"]) {
    refuses(run(t, { attempt }), /GITHUB_RUN_ATTEMPT must be a positive integer/);
  }
});

test("attest's split build check requires exactly one verdict per expected leg", (t) => {
  const { legs } = run(t);
  refuses(run(t, { verdicts: { [legs[0]]: null } }), /Image-Node verdicts are/);
  refuses(run(t, { extraVerdict: "image-test-verdict-extra.json" }), /Image-Node verdicts are/);
  const none = Object.fromEntries(legs.map((leg) => [leg, null]));
  refuses(run(t, { verdicts: none }), /Image-Node verdicts are none/);
});

test("the split build record is written after the release build, kept with the container evidence, checked before any signature and signed", () => {
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:\n`);
    const next = ci.slice(start + 1).search(/\n  [\w-]+:\n/);
    return ci.slice(start, start + 1 + next);
  };
  const docker = job("docker");
  const at = (text: string, name: string) => text.indexOf(`      - name: ${name}\n`);
  assert.ok(at(docker, "Build exact deployable Docker image") < at(docker, "Record the split build"));
  assert.ok(at(docker, "Record the split build") < at(docker, "Preserve exact-SHA container build evidence"));
  assert.match(docker, /node scripts\/split-image\.mjs record\n\s+"\$RUNNER_TEMP\/source-oci" "\$RUNNER_TEMP\/compiled-oci"\n\s+"\$\(docker image inspect --format '\{\{\.Id\}\}' site-behavior-lab:smoke\)"\n/);
  const evidence = docker.slice(at(docker, "Preserve exact-SHA container build evidence"));
  assert.match(evidence.slice(0, evidence.indexOf("retention-days")), /\$\{\{ runner\.temp \}\}\/site-behavior-lab-split-build\.json\n/);
  const attest = job("attest");
  assert.match(attest, /needs:\n(?:\s+- [\w-]+\n)*\s+- image-tests\n/);
  assert.ok(at(attest, "Download every image-Node leg's verdict") >= 0);
  assert.match(attest, /pattern: image-test-verdict-\*-\$\{\{ github\.sha \}\}\n\s+merge-multiple: true\n/);
  const validate = at(attest, "Validate the split build and every image-Node verdict");
  const firstSignature = attest.indexOf("uses: actions/attest@");
  assert.ok(validate > 0 && validate < firstSignature, "the split build is checked before any signature");
  const sign = attest.slice(at(attest, "Attest split build record and image-Node verdicts"));
  assert.match(sign, /subject-path: \|\n\s+\$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/container\/site-behavior-lab-split-build\.json\n\s+\$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/image-tests\/site-behavior-lab-image-test-verdicts\.json\n/);
  // The bundle artifact hosted-evidence reads by an exact member list does not gain it.
  const bundles = attest.slice(at(attest, "Collect attestation bundles and result references"), at(attest, "Preserve exact-SHA attestation bundles and results"));
  assert.doesNotMatch(bundles, /split|SPLIT|image-test/);
});

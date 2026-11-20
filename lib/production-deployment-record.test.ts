import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// The record a production container deployment leaves, and the job that
// signs it. scripts/production-deployment-record.mjs says what a record is;
// .github/workflows/deploy-container.yml writes it after the rollout
// converges and signs it in a job that runs none of the promoted code.

type Readback = { observedAt: string; sourceCommit: string; applicationId: string; image: string };
type Runs = { ciRunId: number; deployRunId: number; deployRunAttempt: number };
type DeploymentRecord = {
  schemaVersion: number;
  kind: string;
  sourceCommit: string;
  image: string;
  applicationId: string;
  observedAt: string;
  ciRun: { id: number };
  deployRun: { id: number; attempt: number };
};
type Helpers = {
  DEPLOYMENT_RECORD_KIND: string;
  DEPLOYMENT_RECORD_FILE: string;
  DEPLOYMENT_RECORD_KEYS: string[];
  positiveInteger(value: unknown, name: string): number;
  deploymentRecord(readback: Readback, runs: Runs): DeploymentRecord;
  deploymentRecordProblems(value: unknown, expected: { commit: string; deployRunId: number; deployRunAttempt: number }): string[];
};
type ImageLib = { IMAGE_REPOSITORY: string };

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;
const helpers = nativeImport<Helpers>(pathToFileURL(path.join(root, "scripts", "production-deployment-record.mjs")).href);
const imageLib = nativeImport<ImageLib>(pathToFileURL(path.join(root, "scripts", "published-container-lib.mjs")).href);
const source = (file: string): string => readFileSync(path.join(root, file), "utf8");

const COMMIT = "1".repeat(40);
const RUNS: Runs = { ciRunId: 44271944079, deployRunId: 44274689360, deployRunAttempt: 3 };

async function goodRecord(): Promise<DeploymentRecord> {
  const { deploymentRecord } = await helpers;
  const { IMAGE_REPOSITORY } = await imageLib;
  return deploymentRecord(
    { observedAt: "2026-11-18T10:04:50.123Z", sourceCommit: COMMIT, applicationId: "production-app", image: `${IMAGE_REPOSITORY}@sha256:d55f2bc766ef1dc722b08154902d636bf916474b69027b284739c394a9e55666` },
    RUNS
  );
}

test("the record of a converged rollout names the image, the live commit and both runs, and is this run's record", async () => {
  const { deploymentRecordProblems, DEPLOYMENT_RECORD_KEYS, DEPLOYMENT_RECORD_KIND } = await helpers;
  const record = await goodRecord();
  assert.deepEqual(Object.keys(record), DEPLOYMENT_RECORD_KEYS);
  assert.equal(record.kind, DEPLOYMENT_RECORD_KIND);
  assert.deepEqual(record.ciRun, { id: RUNS.ciRunId });
  assert.deepEqual(record.deployRun, { id: RUNS.deployRunId, attempt: RUNS.deployRunAttempt });
  assert.deepEqual(deploymentRecordProblems(record, { commit: COMMIT, deployRunId: RUNS.deployRunId, deployRunAttempt: RUNS.deployRunAttempt }), []);
});

test("a record is refused for each way it is not this deployment's", async () => {
  const { deploymentRecordProblems } = await helpers;
  const cases: [string, (record: DeploymentRecord) => void, RegExp][] = [
    ["another commit", (r) => { r.sourceCommit = "2".repeat(40); }, /names commit 2+, not 1+/],
    ["another kind", (r) => { r.kind = "site-behavior-lab-tla-checks-receipt"; }, /another kind or version/],
    ["a mutable tag", (r) => { r.image = r.image.replace(/@sha256:[0-9a-f]+$/, ":latest"); }, /no immutable image/],
    ["another repository", (r) => { r.image = r.image.replace("site-behavior-lab-scanner", "other-scanner"); }, /no immutable image/],
    // A digest no build gives: a placeholder of zeros, or any one digit repeated.
    ["an all-zero digest", (r) => { r.image = r.image.replace(/@sha256:[0-9a-f]{64}$/, `@sha256:${"0".repeat(64)}`); }, /one repeated digit/],
    ["a single-digit digest", (r) => { r.image = r.image.replace(/@sha256:[0-9a-f]{64}$/, `@sha256:${"4".repeat(64)}`); }, /one repeated digit/],
    ["no application", (r) => { r.applicationId = ""; }, /names no application/],
    ["a loose time", (r) => { r.observedAt = "2026-11-18T10:04:50Z"; }, /not a canonical instant/],
    // A text no date reads is refused, not thrown on: toISOString would throw on it.
    ["an unparseable time", (r) => { r.observedAt = "yesterday"; }, /not a canonical instant/],
    ["no CI run", (r) => { r.ciRun = { id: 0 }; }, /names no CI run/],
    ["another deployment run", (r) => { r.deployRun = { id: RUNS.deployRunId + 1, attempt: RUNS.deployRunAttempt }; }, /not of deployment run/],
    ["another attempt", (r) => { r.deployRun = { id: RUNS.deployRunId, attempt: 1 }; }, /not of deployment run/],
    ["an added field", (r) => { (r as Record<string, unknown>).scanRanInImage = true; }, /exactly its fields, in order/]
  ];
  for (const [what, edit, message] of cases) {
    const record = await goodRecord();
    edit(record);
    const problems = deploymentRecordProblems(record, { commit: COMMIT, deployRunId: RUNS.deployRunId, deployRunAttempt: RUNS.deployRunAttempt });
    assert.ok(problems.some((problem) => message.test(problem)), `${what}: ${JSON.stringify(problems)}`);
  }
});

test("a run id is read from the environment only as a positive integer", async () => {
  const { positiveInteger } = await helpers;
  assert.equal(positiveInteger("44274689360", "GITHUB_RUN_ID"), 44274689360);
  for (const value of [undefined, "", "0", "-1", "1.5", "12a", " 7", "07"]) {
    assert.throws(() => positiveInteger(value, "CI_RUN_ID"), /CI_RUN_ID is not a positive integer/, String(value));
  }
});

test("the deploy workflow writes the record from the readback step and signs it in a job that holds no Cloudflare secret and runs none of the promoted code", async () => {
  const { DEPLOYMENT_RECORD_FILE } = await helpers;
  const workflow = source(".github/workflows/deploy-container.yml");
  const [deployJob, rest] = workflow.split(/^  attest-deployment:\n/m);
  assert.ok(rest !== undefined, "no job signs the deployment record");
  const attestJob = rest;

  // The job that deploys holds the provider secret and may not sign; the
  // job that signs holds no secret and runs no code of the commit.
  assert.doesNotMatch(deployJob, /id-token|attestations: write/);
  assert.doesNotMatch(attestJob, /actions\/checkout|npm ci|scripts\/|secrets\.|CLOUDFLARE/);
  assert.match(attestJob, /needs:\n      - deploy\n    if: needs\.deploy\.outputs\.current == 'true'\n/);
  assert.match(attestJob, /permissions:\n      contents: read\n      id-token: write\n      attestations: write\n      artifact-metadata: write\n/);
  assert.match(attestJob, /uses: actions\/attest@[0-9a-f]{40} # v/);
  assert.match(attestJob, /record\?\.sourceCommit !== process\.env\.GITHUB_SHA/);
  assert.match(attestJob, /record\?\.deployRun\?\.id\) !== process\.env\.GITHUB_RUN_ID/);
  assert.match(deployJob, /\n    outputs:\n      current: \$\{\{ steps\.candidate\.outputs\.current \}\}\n/);

  // The readback step is given the CI run the image was resolved from, and
  // the job signs the very file that step kept.
  const readback = deployJob.slice(deployJob.indexOf("- name: Verify provider image and live scanner revision"), deployJob.indexOf("- name: Preserve deployment readback"));
  assert.match(readback, /CI_RUN_ID: \$\{\{ steps\.candidate\.outputs\.ci_run \}\}\n/);
  assert.match(readback, /run: node scripts\/verify-deployed-container\.mjs\n/);
  const kept = /name: (production-container-readback-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\})\n {10}path: \$\{\{ runner\.temp \}\}\/([^\n]+)\n/.exec(deployJob);
  assert.ok(kept, "the record is not kept under its commit and attempt");
  // The record's bytes outlive the run for exactly this long, written out
  // rather than left to the repository's default.
  assert.match(deployJob, /path: \$\{\{ runner\.temp \}\}\/production-container-readback\.json\n {10}if-no-files-found: error\n {10}retention-days: 90\n/);
  assert.equal(kept[2], DEPLOYMENT_RECORD_FILE);
  assert.ok(attestJob.includes(`name: ${kept[1]}\n`), "the signing job downloads another artifact");
  assert.ok(attestJob.includes(`subject-path: \${{ runner.temp }}/production-deployment-record/${DEPLOYMENT_RECORD_FILE}\n`), "the signing job signs another file");

  // The resolver writes the output the readback step reads.
  assert.match(source("scripts/resolve-production-container.mjs"), /ci_run=\$\{runId\}/);
  // The readback script builds the record with the shared module and checks
  // it before writing.
  const script = source("scripts/verify-deployed-container.mjs");
  assert.match(script, /from "\.\/production-deployment-record\.mjs"/);
  assert.match(script, /deploymentRecordProblems\(record, \{ commit: process\.env\.GITHUB_SHA, \.\.\.runs \}\)/);
});

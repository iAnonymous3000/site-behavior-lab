import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// scripts/archive-deployment-records.mjs copies signed production deployment
// records out of their Actions artifacts for a reviewed proposal. These
// tests drive it with a fake GitHub CLI; nothing here reaches GitHub.

type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  path: string;
  event: string;
  status: string;
  conclusion: string;
  repository: { full_name: string };
  head_repository: { full_name: string };
};
type Gh = (args: string[], options?: { cwd?: string }) => string;
type Helpers = {
  ARCHIVE_DIRECTORY: string;
  MAX_RUNS: number;
  parseRunIds(text: string): number[];
  deploymentRunProblems(run: unknown, runId: number): string[];
  recordArtifactName(run: Run): string;
  archivePaths(run: Run): { record: string; bundle: string };
  recordAttestationArgs(file: string, commit: string): string[];
  collectDeploymentRecords(input: { runIds: number[]; root: string; gh: Gh; verifier: Gh }): string[];
  recordBundleProblems(recordBytes: Buffer, bundleText: string): string[];
  keptRecordProblems(root: string): { records: number; names: string[]; problems: string[] };
};
type RecordLib = {
  DEPLOYMENT_RECORD_FILE: string;
  deploymentRecord(
    readback: { observedAt: string; sourceCommit: string; applicationId: string; image: string },
    runs: { ciRunId: number; deployRunId: number; deployRunAttempt: number }
  ): Record<string, unknown>;
};
type ImageLib = { IMAGE_REPOSITORY: string; REPOSITORY: string };

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;
const helpers = nativeImport<Helpers>(pathToFileURL(path.join(root, "scripts", "archive-deployment-records.mjs")).href);
const recordLib = nativeImport<RecordLib>(pathToFileURL(path.join(root, "scripts", "production-deployment-record.mjs")).href);
const imageLib = nativeImport<ImageLib>(pathToFileURL(path.join(root, "scripts", "published-container-lib.mjs")).href);

const COMMIT = "1".repeat(40);

async function goodRun(id: number, attempt = 1): Promise<Run> {
  const { REPOSITORY } = await imageLib;
  return {
    id,
    run_attempt: attempt,
    head_sha: COMMIT,
    head_branch: "production",
    path: ".github/workflows/deploy-container.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY }
  };
}

type World = {
  runs: Map<number, Run>;
  records: Map<number, string>;
  artifacts: Map<number, { name: string; expired: boolean }[]>;
  verified: unknown;
  bundles: number;
  calls: string[];
};

async function world(runIds: number[]): Promise<World> {
  const { deploymentRecord } = await recordLib;
  const { IMAGE_REPOSITORY } = await imageLib;
  const { recordArtifactName } = await helpers;
  const state: World = { runs: new Map(), records: new Map(), artifacts: new Map(), verified: [{ verificationResult: {} }], bundles: 1, calls: [] };
  for (const id of runIds) {
    const run = await goodRun(id);
    state.runs.set(id, run);
    state.artifacts.set(id, [{ name: recordArtifactName(run), expired: false }, { name: "other-artifact", expired: false }]);
    const record = deploymentRecord(
      { observedAt: "2026-11-18T10:04:50.123Z", sourceCommit: COMMIT, applicationId: "production-app", image: `${IMAGE_REPOSITORY}@sha256:d55f2bc766ef1dc722b08154902d636bf916474b69027b284739c394a9e55666` },
      { ciRunId: 44271944079, deployRunId: id, deployRunAttempt: 1 }
    );
    state.records.set(id, `${JSON.stringify(record, null, 2)}\n`);
  }
  return state;
}

function fakes(state: World, recordFile: string): { gh: Gh; verifier: Gh } {
  const gh: Gh = (args) => {
    state.calls.push(`gh ${args.join(" ")}`);
    const runPath = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(args[1] ?? "");
    if (args[0] === "api" && runPath) return JSON.stringify(state.runs.get(Number(runPath[1])));
    const artifactsPath = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts/.exec(args[1] ?? "");
    if (args[0] === "api" && artifactsPath) return JSON.stringify({ artifacts: state.artifacts.get(Number(artifactsPath[1])) });
    if (args[0] === "run" && args[1] === "download") {
      const directory = args[args.indexOf("--dir") + 1];
      writeFileSync(path.join(directory, recordFile), state.records.get(Number(args[2])) ?? "");
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const verifier: Gh = (args, options = {}) => {
    state.calls.push(`verifier ${args.slice(0, 2).join(" ")}`);
    if (args[0] === "attestation" && args[1] === "verify") return JSON.stringify(state.verified);
    if (args[0] === "attestation" && args[1] === "download") {
      for (let index = 0; index < state.bundles; index += 1) writeFileSync(path.join(options.cwd ?? ".", `sha256:${index}.jsonl`), `{"bundle":${index}}\n`);
      return "";
    }
    throw new Error(`unexpected verifier ${args.join(" ")}`);
  };
  return { gh, verifier };
}

function scratchRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sbl-deployment-records-test-"));
}

test("a batch of good runs is kept as one record and one bundle each, byte for byte, after every check", async () => {
  const { collectDeploymentRecords, archivePaths, ARCHIVE_DIRECTORY } = await helpers;
  const { DEPLOYMENT_RECORD_FILE } = await recordLib;
  const state = await world([101, 102]);
  const target = scratchRoot();
  try {
    const written = collectDeploymentRecords({ runIds: [101, 102], root: target, ...fakes(state, DEPLOYMENT_RECORD_FILE) });
    const expected = [101, 102].flatMap((id) => Object.values(archivePaths(state.runs.get(id)!)));
    assert.deepEqual(written, expected);
    assert.deepEqual(readdirSync(path.join(target, ARCHIVE_DIRECTORY)).sort(), ["101-1.bundle.jsonl", "101-1.json", "102-1.bundle.jsonl", "102-1.json"]);
    assert.equal(readFileSync(path.join(target, ARCHIVE_DIRECTORY, "101-1.json"), "utf8"), state.records.get(101));
    // Each record's signature is checked before anything is written.
    assert.equal(state.calls.filter((call) => call === "verifier attestation verify").length, 2);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("a batch with one refused run writes nothing at all", async () => {
  const { collectDeploymentRecords, recordArtifactName, ARCHIVE_DIRECTORY } = await helpers;
  const { DEPLOYMENT_RECORD_FILE } = await recordLib;
  const cases: [string, (state: World) => void, RegExp][] = [
    ["another workflow", (s) => { s.runs.get(102)!.path = ".github/workflows/deploy-pages.yml"; }, /not \.github\/workflows\/deploy-container\.yml/],
    ["the main branch", (s) => { s.runs.get(102)!.head_branch = "main"; }, /on main, not production/],
    ["a failed run", (s) => { s.runs.get(102)!.conclusion = "failure"; }, /did not complete successfully/],
    ["a pull request event", (s) => { s.runs.get(102)!.event = "pull_request"; }, /started by pull_request/],
    ["a fork", (s) => { s.runs.get(102)!.head_repository = { full_name: "someone/site-behavior-lab" }; }, /not of this repository/],
    ["an expired record", (s) => { s.artifacts.get(102)![0].expired = true; }, /no single unexpired artifact/],
    ["no record artifact", (s) => { s.artifacts.set(102, []); }, /no single unexpired artifact/],
    ["two record artifacts", (s) => { s.artifacts.get(102)!.push({ name: recordArtifactName(s.runs.get(102)!), expired: false }); }, /no single unexpired artifact/],
    ["a record of another attempt", (s) => { s.runs.get(102)!.run_attempt = 2; s.artifacts.set(102, [{ name: recordArtifactName(s.runs.get(102)!), expired: false }]); }, /not of deployment run 102 attempt 2/],
    ["a record of another commit", (s) => { s.records.set(102, s.records.get(102)!.replaceAll(COMMIT, "2".repeat(40))); }, /names commit 2+, not 1+/],
    ["no verified attestation", (s) => { s.verified = []; }, /no verified attestation/],
    ["two bundles", (s) => { s.bundles = 2; }, /2 attestation bundle files, not one/]
  ];
  for (const [what, edit, message] of cases) {
    const state = await world([101, 102]);
    edit(state);
    const target = scratchRoot();
    try {
      assert.throws(() => collectDeploymentRecords({ runIds: [101, 102], root: target, ...fakes(state, DEPLOYMENT_RECORD_FILE) }), message, what);
      assert.equal(existsSync(path.join(target, ARCHIVE_DIRECTORY)), false, `${what}: something was written`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("a record already kept is never overwritten, and then nothing of the batch is written", async () => {
  const { collectDeploymentRecords, ARCHIVE_DIRECTORY } = await helpers;
  const { DEPLOYMENT_RECORD_FILE } = await recordLib;
  const state = await world([101, 102]);
  const target = scratchRoot();
  try {
    mkdirSync(path.join(target, ARCHIVE_DIRECTORY), { recursive: true });
    writeFileSync(path.join(target, ARCHIVE_DIRECTORY, "102-1.json"), "kept\n");
    assert.throws(() => collectDeploymentRecords({ runIds: [101, 102], root: target, ...fakes(state, DEPLOYMENT_RECORD_FILE) }), /102-1\.json is already kept/);
    assert.deepEqual(readdirSync(path.join(target, ARCHIVE_DIRECTORY)), ["102-1.json"]);
    assert.equal(readFileSync(path.join(target, ARCHIVE_DIRECTORY, "102-1.json"), "utf8"), "kept\n");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("a dispatch names one to twenty distinct run ids, and a signature is checked against the deploy workflow on production at the run's commit", async () => {
  const { parseRunIds, recordAttestationArgs, MAX_RUNS } = await helpers;
  const { REPOSITORY } = await imageLib;
  assert.deepEqual(parseRunIds("44274689360, 44031818477"), [44274689360, 44031818477]);
  for (const text of ["", "0", "12a", "1,1", "-3", Array.from({ length: MAX_RUNS + 1 }, (_, index) => index + 1).join(",")]) {
    assert.throws(() => parseRunIds(text), Error, JSON.stringify(text));
  }
  const args = recordAttestationArgs("/tmp/record.json", COMMIT);
  for (const [flag, value] of [
    ["--repo", REPOSITORY],
    ["--signer-workflow", `${REPOSITORY}/.github/workflows/deploy-container.yml`],
    ["--source-ref", "refs/heads/production"],
    ["--source-digest", COMMIT],
    ["--signer-digest", COMMIT]
  ]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.ok(args.includes("--deny-self-hosted-runners"));
});

test("the workflow is started only by hand from main, passes the run ids through the environment, and proposes on a branch of its own run", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/archive-deployment-records.yml"), "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|schedule|workflow_run|pull_request\w*):/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /RUN_IDS: \$\{\{ inputs\.run_ids \}\}\n/);
  assert.match(workflow, /node scripts\/archive-deployment-records\.mjs collect --runs "\$RUN_IDS"/);
  assert.doesNotMatch(workflow.replace(/RUN_IDS: \$\{\{ inputs\.run_ids \}\}/, ""), /inputs\.run_ids/, "the run ids reach a shell only through the environment");
  assert.match(workflow, /PROPOSAL_BRANCH: automation\/production-deployments-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n/);
  assert.doesNotMatch(workflow, /id-token|secrets\.|npm ci|--force/);
  assert.match(workflow, /git add research\/production-deployments\n/);
});

// A bundle line of the shape GitHub's artifact attestation writes: a DSSE
// envelope whose payload is an in-toto statement with SLSA provenance v1.
// The shape follows GitHub's documented workflow build type; the first real
// kept record is the first bundle of this repository it is read against.
function bundleLine(recordBytes: Buffer, change: (statement: Record<string, any>) => void = () => {}): string {
  const statement: Record<string, any> = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "production-container-readback.json", digest: { sha256: createHash("sha256").update(recordBytes).digest("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: { workflow: { ref: "refs/heads/production", repository: "https://github.com/iAnonymous3000/site-behavior-lab", path: ".github/workflows/deploy-container.yml" } },
        resolvedDependencies: [{ uri: "git+https://github.com/iAnonymous3000/site-behavior-lab@refs/heads/production", digest: { gitCommit: COMMIT } }]
      }
    }
  };
  change(statement);
  return `${JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ sig: "c2ln" }] }
  })}\n`;
}

test("a kept bundle names its record offline by digest, signer workflow, ref, repository and commit", async () => {
  const { recordBundleProblems } = await helpers;
  const state = await world([101]);
  const bytes = Buffer.from(state.records.get(101)!);
  assert.deepEqual(recordBundleProblems(bytes, bundleLine(bytes)), []);
  const cases: [string, Buffer, string][] = [
    ["a record changed after signing", Buffer.from(bytes.toString().replace("production-app", "other-app")), bundleLine(bytes)],
    ["another workflow", bytes, bundleLine(bytes, (s) => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/ci.yml"; })],
    ["the main branch", bytes, bundleLine(bytes, (s) => { s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; })],
    ["a fork", bytes, bundleLine(bytes, (s) => { s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/someone/site-behavior-lab"; })],
    ["another commit", bytes, bundleLine(bytes, (s) => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "2".repeat(40); })],
    ["another predicate", bytes, bundleLine(bytes, (s) => { s.predicateType = "https://example.invalid/other"; })]
  ];
  for (const [what, record, bundle] of cases) {
    const problems = recordBundleProblems(record, bundle);
    assert.ok(problems.some((problem) => /no statement in the bundle names this record/.test(problem)), `${what}: ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(recordBundleProblems(bytes, "not json\n"), ["the bundle holds a line that is no in-toto statement"]);
});

test("a kept folder refuses a record without its bundle, a bundle without its record, and a stray file", async () => {
  const { keptRecordProblems, ARCHIVE_DIRECTORY } = await helpers;
  const state = await world([101]);
  const bytes = Buffer.from(state.records.get(101)!);
  const target = scratchRoot();
  try {
    const directory = path.join(target, ARCHIVE_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, ".gitkeep"), "");
    writeFileSync(path.join(directory, "101-1.json"), bytes);
    writeFileSync(path.join(directory, "101-1.bundle.jsonl"), bundleLine(bytes));
    assert.deepEqual(keptRecordProblems(target), { records: 1, names: [".gitkeep", "101-1.bundle.jsonl", "101-1.json"], problems: [] });
    writeFileSync(path.join(directory, "102-1.bundle.jsonl"), bundleLine(bytes));
    writeFileSync(path.join(directory, "103-1.json"), bytes);
    writeFileSync(path.join(directory, "notes.txt"), "x");
    const { problems } = keptRecordProblems(target);
    for (const expected of [/^103-1\.json has no bundle beside it$/, /^102-1\.bundle\.jsonl has no record beside it$/, /^notes\.txt is neither a record, a bundle nor \.gitkeep$/]) {
      assert.ok(problems.some((problem) => expected.test(problem)), `${expected}: ${JSON.stringify(problems)}`);
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("every kept deployment record binds to its bundle, and with none kept the folder holds only .gitkeep", async () => {
  const { keptRecordProblems } = await helpers;
  const kept = keptRecordProblems(root);
  if (kept.records === 0) {
    assert.deepEqual(kept.names, [".gitkeep"], "no record is kept yet, so the folder holds only .gitkeep");
  }
  assert.deepEqual(kept.problems, []);
});

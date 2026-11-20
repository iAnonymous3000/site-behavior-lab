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
  archivePaths(run: Run, attempt: number): { record: string; bundle: string };
  recordAttestationArgs(file: string, commit: string): string[];
  collectDeploymentRecords(input: { runIds: number[]; root: string; gh: Gh; verifier: Gh }): { written: string[]; expired: string[] };
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

// The name the deploy workflow keeps a record under, read from its own
// upload step and filled for one commit and attempt, so these tests hold the
// archive to the workflow's name rather than to a second copy of it.
function keptArtifactName(attempt: number): string {
  const workflow = readFileSync(path.join(root, ".github/workflows/deploy-container.yml"), "utf8");
  const template = /name: (production-container-readback-[^\n]+)\n {10}path: \$\{\{ runner\.temp \}\}\/production-container-readback\.json\n/.exec(workflow);
  assert.ok(template, "the deploy workflow keeps no record artifact");
  const values: Record<string, string> = { "github.sha": COMMIT, "github.run_attempt": String(attempt) };
  return template[1].replace(/\$\{\{ ([a-z_.]+) \}\}/g, (_, name: string) => {
    assert.ok(name in values, `the record artifact is named by ${name}`);
    return values[name];
  });
}

type World = {
  runs: Map<number, Run>;
  /** Record text by "<run>-<attempt>". */
  records: Map<string, string>;
  artifacts: Map<number, { name: string; expired: boolean }[]>;
  verified: unknown;
  bundles: number;
  calls: string[];
};

/** A record of run `id` written by the deploy job at `attempt`. */
async function recordText(id: number, attempt: number): Promise<string> {
  const { deploymentRecord } = await recordLib;
  const { IMAGE_REPOSITORY } = await imageLib;
  const record = deploymentRecord(
    { observedAt: "2026-11-18T10:04:50.123Z", sourceCommit: COMMIT, applicationId: "production-app", image: `${IMAGE_REPOSITORY}@sha256:d55f2bc766ef1dc722b08154902d636bf916474b69027b284739c394a9e55666` },
    { ciRunId: 44271944079, deployRunId: id, deployRunAttempt: attempt }
  );
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Runs whose deploy job kept a record at each of `deployAttempts` and whose
 * latest attempt is `latestAttempt`. A full rerun deploys again and keeps
 * another record; a rerun of the failed signing job alone keeps none, so the
 * latest attempt can be later than every kept one.
 */
async function world(runIds: number[], deployAttempts = [1], latestAttempt = Math.max(...deployAttempts)): Promise<World> {
  const state: World = { runs: new Map(), records: new Map(), artifacts: new Map(), verified: [{ verificationResult: {} }], bundles: 1, calls: [] };
  for (const id of runIds) {
    state.runs.set(id, await goodRun(id, latestAttempt));
    state.artifacts.set(id, [...deployAttempts.map((attempt) => ({ name: keptArtifactName(attempt), expired: false })), { name: "other-artifact", expired: false }]);
    for (const attempt of deployAttempts) state.records.set(`${id}-${attempt}`, await recordText(id, attempt));
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
      const name = args[args.indexOf("--name") + 1];
      const listed = (state.artifacts.get(Number(args[2])) ?? []).find((artifact) => artifact.name === name);
      if (listed === undefined) throw new Error(`run ${args[2]} lists no artifact ${name}`);
      if (listed.expired) throw new Error(`artifact ${name} has expired and cannot be downloaded`);
      const directory = args[args.indexOf("--dir") + 1];
      writeFileSync(path.join(directory, recordFile), state.records.get(`${args[2]}-${/-([0-9]+)$/.exec(name)![1]}`) ?? "");
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const verifier: Gh = (args, options = {}) => {
    state.calls.push(`verifier ${args.slice(0, 2).join(" ")}`);
    if (args[0] === "attestation" && args[1] === "verify") return JSON.stringify(state.verified);
    if (args[0] === "attestation" && args[1] === "download") {
      const bytes = readFileSync(args[2]);
      for (let index = 0; index < state.bundles; index += 1) writeFileSync(path.join(options.cwd ?? ".", `sha256:${index}.jsonl`), bundleLine(bytes));
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
    const { written, expired } = collectDeploymentRecords({ runIds: [101, 102], root: target, ...fakes(state, DEPLOYMENT_RECORD_FILE) });
    assert.deepEqual(expired, []);
    const expected = [101, 102].flatMap((id) => Object.values(archivePaths(state.runs.get(id)!, 1)));
    assert.deepEqual(written, expected);
    assert.deepEqual(readdirSync(path.join(target, ARCHIVE_DIRECTORY)).sort(), ["101-1.bundle.jsonl", "101-1.json", "102-1.bundle.jsonl", "102-1.json"]);
    assert.equal(readFileSync(path.join(target, ARCHIVE_DIRECTORY, "101-1.json"), "utf8"), state.records.get("101-1"));
    // Each record's signature is checked before anything is written.
    assert.equal(state.calls.filter((call) => call === "verifier attestation verify").length, 2);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("a batch with one refused run writes nothing at all", async () => {
  const { collectDeploymentRecords, ARCHIVE_DIRECTORY } = await helpers;
  const { DEPLOYMENT_RECORD_FILE } = await recordLib;
  const cases: [string, (state: World) => void, RegExp][] = [
    ["another workflow", (s) => { s.runs.get(102)!.path = ".github/workflows/deploy-pages.yml"; }, /not \.github\/workflows\/deploy-container\.yml/],
    ["the main branch", (s) => { s.runs.get(102)!.head_branch = "main"; }, /on main, not production/],
    ["a failed run", (s) => { s.runs.get(102)!.conclusion = "failure"; }, /did not complete successfully/],
    ["a pull request event", (s) => { s.runs.get(102)!.event = "pull_request"; }, /started by pull_request/],
    ["a fork", (s) => { s.runs.get(102)!.head_repository = { full_name: "someone/site-behavior-lab" }; }, /not of this repository/],
    ["no record artifact", (s) => { s.artifacts.set(102, [{ name: "other-artifact", expired: false }]); }, /: run 102 has no record artifact$/],
    ["two record artifacts of one attempt", (s) => { s.artifacts.get(102)!.push({ name: keptArtifactName(1), expired: false }); }, /: run 102 lists two record artifacts of attempt 1$/],
    ["a record artifact of another commit", (s) => { s.artifacts.get(102)!.push({ name: keptArtifactName(1).replace(COMMIT, "2".repeat(40)), expired: false }); }, /: run 102 lists production-container-readback-2{40}-1, which is not a record artifact of commit 1{40}$/],
    ["a record artifact of attempt 0", (s) => { s.artifacts.set(102, [{ name: keptArtifactName(0), expired: false }]); }, /: run 102 lists production-container-readback-1{40}-0, which is not a record artifact of commit 1{40}$/],
    ["a record artifact after the run's latest attempt", (s) => {
      s.artifacts.set(102, [{ name: keptArtifactName(2), expired: false }]);
      s.records.set("102-2", s.records.get("102-1")!.replace('"attempt": 1', '"attempt": 2'));
    }, /: run 102's record artifact production-container-readback-1{40}-2 is of attempt 2, after the run's latest attempt 1$/],
    ["a record of another attempt than its artifact", (s) => {
      s.runs.get(102)!.run_attempt = 2;
      s.artifacts.set(102, [{ name: keptArtifactName(2), expired: false }]);
      s.records.set("102-2", s.records.get("102-1")!);
    }, /not of deployment run 102 attempt 2/],
    ["a record of another commit", (s) => { s.records.set("102-1", s.records.get("102-1")!.replaceAll(COMMIT, "2".repeat(40))); }, /names commit 2+, not 1+/],
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

test("every record a run's deploy job kept is archived by its own attempt, on a first run, a full rerun and a rerun of the signing job alone", async () => {
  const { collectDeploymentRecords, keptRecordProblems, ARCHIVE_DIRECTORY } = await helpers;
  const { DEPLOYMENT_RECORD_FILE } = await recordLib;
  // [attempts whose deploy job kept a record, the run's latest attempt].
  const runs: [number[], number][] = [[[1], 1], [[1, 2], 2], [[1], 2], [[1], 3], [[2], 2]];
  for (const [deployAttempts, latestAttempt] of runs) {
    const what = `deploy attempts ${deployAttempts.join(",")}, latest attempt ${latestAttempt}`;
    const state = await world([101], deployAttempts, latestAttempt);
    const target = scratchRoot();
    try {
      let result = { written: [] as string[], expired: [] as string[] };
      assert.doesNotThrow(() => { result = collectDeploymentRecords({ runIds: [101], root: target, ...fakes(state, DEPLOYMENT_RECORD_FILE) }); }, `${what}: the archive refused the run`);
      assert.deepEqual(
        result.written,
        deployAttempts.flatMap((attempt) => [`${ARCHIVE_DIRECTORY}/101-${attempt}.json`, `${ARCHIVE_DIRECTORY}/101-${attempt}.bundle.jsonl`]),
        `${what}: the kept records are not one per deploying attempt, each under its own attempt`
      );
      assert.deepEqual(result.expired, [], `${what}: an attempt was reported expired`);
      assert.deepEqual(keptRecordProblems(target).problems, [], `${what}: a kept record does not hold to its name`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("an expired record of one attempt is named as not kept, and the run's other attempts are kept", async () => {
  const { collectDeploymentRecords, keptRecordProblems, ARCHIVE_DIRECTORY } = await helpers;
  const { DEPLOYMENT_RECORD_FILE } = await recordLib;
  const state = await world([101], [1, 2]);
  state.artifacts.get(101)![0].expired = true;
  const target = scratchRoot();
  try {
    let result = { written: [] as string[], expired: [] as string[] };
    assert.doesNotThrow(() => { result = collectDeploymentRecords({ runIds: [101], root: target, ...fakes(state, DEPLOYMENT_RECORD_FILE) }); }, "an expired earlier attempt: the archive refused the run");
    assert.deepEqual(result.written, [`${ARCHIVE_DIRECTORY}/101-2.json`, `${ARCHIVE_DIRECTORY}/101-2.bundle.jsonl`], "an expired earlier attempt: the later attempt is not the one record kept");
    assert.deepEqual(result.expired, [`run 101's record artifact ${keptArtifactName(1)} has expired and is not kept`], "an expired earlier attempt: the expired attempt is not named");
    assert.deepEqual(keptRecordProblems(target).problems, []);
  } finally {
    rmSync(target, { recursive: true, force: true });
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
  const bytes = Buffer.from(state.records.get("101-1")!);
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
  const bytes = Buffer.from(state.records.get("101-1")!);
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
  // Problems first, so a stray or unpaired file is named by its own message
  // even while no record is kept.
  assert.deepEqual(kept.problems, []);
  if (kept.records === 0) {
    assert.deepEqual(kept.names, [".gitkeep"], "no record is kept yet, so the folder holds only .gitkeep");
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const CLI = path.join(
  process.cwd(),
  "scripts",
  "runner-destruction-evidence.mjs"
);
const WORKFLOW = path.join(
  process.cwd(),
  ".github",
  "workflows",
  "runner-destruction-evidence.yml"
);

function collection() {
  return {
    repository: "iAnonymous3000/site-behavior-lab",
    workflow: ".github/workflows/scan-featured.yml",
    runId: 30_600_000_001,
    runAttempt: 1,
    headSha: "a".repeat(40)
  };
}

function expectedCollection() {
  return {
    ...collection(),
    jobCompletedAt: "2026-08-03T07:40:00.000Z"
  };
}

function observation() {
  return {
    collection: collection(),
    destroyedAt: "2026-08-03T07:45:00.000Z",
    verifiedAbsentAt: "2026-08-03T07:50:00.000Z",
    computeAbsent: true,
    registrationAbsent: true
  };
}

function collectionEvidenceRef() {
  return {
    kind: "github-actions-run-evidence",
    actionsRunId: 30_600_000_001,
    runUrl:
      "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001",
    artifactName:
      "site-behavior-featured-publication-30600000001-1",
    artifactRef:
      "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/artifacts/8760000001",
    artifactSha256: "b".repeat(64)
  };
}

async function validEvidence() {
  const { buildRunnerDestructionEvidence } = await script(
    "runner-destruction-evidence-lib.mjs"
  );
  return buildRunnerDestructionEvidence({
    expectedCollection: expectedCollection(),
    providerObservation: observation(),
    collectionEvidenceRef: collectionEvidenceRef()
  });
}

test("provider-normalized absence evidence is exact, canonical, and non-circular", async () => {
  const {
    parseRunnerDestructionEvidence,
    runnerDestructionEvidenceDigest,
    runnerDestructionEvidenceProblems,
    serializeRunnerDestructionEvidence
  } = await script("runner-destruction-evidence-lib.mjs");
  const evidence = await validEvidence();
  assert.deepEqual(runnerDestructionEvidenceProblems(evidence), []);
  assert.equal(evidence.computeAbsent, true);
  assert.equal(evidence.registrationAbsent, true);
  assert.equal(evidence.runnerAbsent, true);
  assert.deepEqual(Object.keys(evidence).sort(), [
    "artifactKind",
    "collection",
    "computeAbsent",
    "destroyedAt",
    "evidenceRefs",
    "registrationAbsent",
    "runnerAbsent",
    "schemaVersion",
    "verifiedAbsentAt"
  ]);

  const bytes = serializeRunnerDestructionEvidence(evidence);
  assert.deepEqual(parseRunnerDestructionEvidence(bytes), evidence);
  assert.match(runnerDestructionEvidenceDigest(evidence), /^[0-9a-f]{64}$/);
  assert.equal(bytes.endsWith("\n"), true);

  // The provider artifact is produced before its Actions artifact id/digest
  // exists. It may bind the already-authenticated collection artifact, but it
  // must never contain a receipt or a reference to its own future artifact.
  assert.equal(Object.hasOwn(evidence, "receipt"), false);
  assert.equal(Object.hasOwn(evidence, "destructionEvidence"), false);
  assert.equal(
    evidence.evidenceRefs[0].artifactName.startsWith(
      "site-behavior-featured-publication-"
    ),
    true
  );
  assert.doesNotMatch(bytes, /"receipt"/);
  assert.doesNotMatch(
    bytes,
    /"artifactName":"site-behavior-runner-destruction-evidence-/
  );

  const selfReference = structuredClone(evidence);
  selfReference.evidenceRefs[0] = {
    kind: "github-actions-run-evidence",
    actionsRunId: 30_700_000_001,
    runUrl:
      "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001",
    artifactName:
      "site-behavior-runner-destruction-evidence-30700000001-1",
    artifactRef:
      "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/artifacts/9760000001",
    artifactSha256: "c".repeat(64)
  };
  assert.match(
    runnerDestructionEvidenceProblems(selfReference).join("; "),
    /actionsRunId must match the authenticated collection run/
  );
});

test("tampering, softened absence claims, and non-canonical bytes are rejected", async () => {
  const {
    parseRunnerDestructionEvidence,
    runnerDestructionEvidenceProblems,
    serializeRunnerDestructionEvidence
  } = await script("runner-destruction-evidence-lib.mjs");
  const baseline = await validEvidence();
  const tampered: Array<[string, Record<string, unknown>, RegExp]> = [];

  const compute = structuredClone(baseline);
  compute.computeAbsent = false;
  tampered.push(["compute", compute, /computeAbsent must be literally true/]);

  const registration = structuredClone(baseline);
  registration.registrationAbsent = "yes";
  tampered.push([
    "registration",
    registration,
    /registrationAbsent must be literally true/
  ]);

  const combined = structuredClone(baseline);
  combined.runnerAbsent = false;
  tampered.push(["combined", combined, /runnerAbsent must be literally true/]);

  const timeline = structuredClone(baseline);
  timeline.verifiedAbsentAt = "2026-08-03T07:44:00.000Z";
  tampered.push([
    "timeline",
    timeline,
    /verifiedAbsentAt must not precede destroyedAt/
  ]);

  const commit = structuredClone(baseline);
  commit.collection.headSha = "not-a-commit";
  tampered.push(["commit", commit, /collection\.headSha/]);

  const digest = structuredClone(baseline);
  digest.evidenceRefs[0].artifactSha256 = "provider-said-ok";
  tampered.push(["digest", digest, /artifactSha256/]);

  const unknown = structuredClone(baseline) as Record<string, unknown>;
  unknown.providerToken = "must-never-be-serialized";
  tampered.push([
    "unknown",
    unknown,
    /runner destruction evidence must contain exactly/
  ]);

  for (const [label, value, pattern] of tampered) {
    const problems = runnerDestructionEvidenceProblems(value);
    assert.match(problems.join("; "), pattern, label);
    assert.throws(
      () => serializeRunnerDestructionEvidence(value),
      pattern,
      label
    );
  }

  const pretty = `${JSON.stringify(baseline, null, 2)}\n`;
  assert.throws(
    () => parseRunnerDestructionEvidence(pretty),
    /not in canonical evidence serialization/
  );
});

test("the builder refuses an unrelated collection or provider-negative observation", async () => {
  const { buildRunnerDestructionEvidence } = await script(
    "runner-destruction-evidence-lib.mjs"
  );
  const unrelated = observation();
  unrelated.collection.runId += 1;
  assert.throws(
    () =>
      buildRunnerDestructionEvidence({
        expectedCollection: expectedCollection(),
        providerObservation: unrelated,
        collectionEvidenceRef: collectionEvidenceRef()
      }),
    /does not match the authenticated collection run/
  );

  const wrongCommit = observation();
  wrongCommit.collection.headSha = "c".repeat(40);
  assert.throws(
    () =>
      buildRunnerDestructionEvidence({
        expectedCollection: expectedCollection(),
        providerObservation: wrongCommit,
        collectionEvidenceRef: collectionEvidenceRef()
      }),
    /does not match the authenticated collection run/
  );

  const stillRegistered = observation();
  stillRegistered.registrationAbsent = false;
  assert.throws(
    () =>
      buildRunnerDestructionEvidence({
        expectedCollection: expectedCollection(),
        providerObservation: stillRegistered,
        collectionEvidenceRef: collectionEvidenceRef()
      }),
    /registrationAbsent must be literally true/
  );

  const tooEarly = observation();
  tooEarly.destroyedAt = expectedCollection().jobCompletedAt;
  assert.throws(
    () =>
      buildRunnerDestructionEvidence({
        expectedCollection: expectedCollection(),
        providerObservation: tooEarly,
        collectionEvidenceRef: collectionEvidenceRef()
      }),
    /must follow the authenticated collection job/
  );
});

test("capture is secretless-fail-closed and remains blocked without a reviewed provider client", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-runner-destruction-")
  );
  const output = path.join(directory, "destruction-evidence.json");
  try {
    const cleanEnv = { ...process.env };
    for (const key of [
      "RUNNER_DESTRUCTION_PROVIDER_KIND",
      "RUNNER_DESTRUCTION_PROVIDER_API_URL",
      "RUNNER_DESTRUCTION_PROVIDER_API_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "COLLECTION_RUN_ID",
      "COLLECTION_RUN_ATTEMPT"
    ]) {
      delete cleanEnv[key];
    }
    const secretless = spawnSync(
      process.execPath,
      [CLI, "--capture", "--output", output],
      { encoding: "utf8", env: cleanEnv }
    );
    assert.equal(secretless.status, 1);
    assert.match(secretless.stderr, /requires non-empty scoped environment/);
    assert.equal(existsSync(output), false);

    const token = "never-print-this-provider-token";
    const configured = spawnSync(
      process.execPath,
      [CLI, "--capture", "--output", output],
      {
        encoding: "utf8",
        env: {
          ...cleanEnv,
          RUNNER_DESTRUCTION_PROVIDER_KIND: "provider-not-selected",
          RUNNER_DESTRUCTION_PROVIDER_API_URL:
            "https://provider.invalid/v1/runner-absence",
          RUNNER_DESTRUCTION_PROVIDER_API_TOKEN: token,
          GITHUB_TOKEN: "github-token",
          GITHUB_REPOSITORY: "iAnonymous3000/site-behavior-lab",
          COLLECTION_RUN_ID: "30600000001",
          COLLECTION_RUN_ATTEMPT: "1"
        }
      }
    );
    assert.equal(configured.status, 1);
    assert.match(configured.stderr, /no reviewed controlled-runner provider adapter/);
    assert.doesNotMatch(`${configured.stdout}${configured.stderr}`, new RegExp(token));
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hosted workflow is trusted, exact-artifact-only, and carries no caller digest escape hatch", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(
    workflow,
    /name: Read back provider destruction and absence/
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: release-evidence/);
  assert.match(
    workflow,
    /RUNNER_DESTRUCTION_PROVIDER_API_URL: \$\{\{ secrets\.RUNNER_DESTRUCTION_PROVIDER_API_URL \}\}/
  );
  assert.match(
    workflow,
    /RUNNER_DESTRUCTION_PROVIDER_API_TOKEN: \$\{\{ secrets\.RUNNER_DESTRUCTION_PROVIDER_API_TOKEN \}\}/
  );
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(
    workflow,
    /inputs\.(?:digest|sha|head_sha|provider_url|provider_response)/
  );
  assert.doesNotMatch(workflow, /\b(?:curl|wget|eval)\b/);
  assert.match(
    workflow,
    /name: site-behavior-runner-destruction-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(
    workflow,
    /path: hosted-runner-destruction-evidence\/destruction-evidence\.json/
  );
  assert.doesNotMatch(workflow, /receipt\.json/);

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(
    packageJson.scripts["runner:destruction:evidence"],
    "node scripts/run-schema-cli.mjs runner-destruction-evidence"
  );
  const launcher = readFileSync("scripts/run-schema-cli.mjs", "utf8");
  assert.match(
    launcher,
    /"runner-destruction-evidence": \[\s*"scripts",\s*"runner-destruction-evidence\.mjs"\s*\]/
  );
});

test("the verifier CLI accepts only canonical provider evidence", async () => {
  const {
    RUNNER_DESTRUCTION_PROVIDER_RESPONSE_MAX_BYTES,
    serializeRunnerDestructionEvidence
  } = await script("runner-destruction-evidence-lib.mjs");
  assert.equal(RUNNER_DESTRUCTION_PROVIDER_RESPONSE_MAX_BYTES, 1024 * 1024);
  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-runner-destruction-verify-")
  );
  const artifact = path.join(directory, "destruction-evidence.json");
  try {
    writeFileSync(
      artifact,
      serializeRunnerDestructionEvidence(await validEvidence())
    );
    const result = spawnSync(
      process.execPath,
      [CLI, "--verify", artifact],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stdout,
      /verified 30600000001\/1 destruction evidence sha256:[0-9a-f]{64}/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

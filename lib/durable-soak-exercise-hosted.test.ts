import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { initFixtureRepo, runFixtureGit } from "./git-fixture";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, any>;
const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

const DEPLOYMENT = "a".repeat(40);
const CONFIG_SHA = "b".repeat(64);
const ENABLE_RECEIPT_SHA = "c".repeat(64);
const NORMAL_JOB = `20260801-${"1".repeat(32)}`;
const NORMAL_REPORT = `20260801-${"2".repeat(32)}`;
const CANCEL_JOB = `20260801-${"3".repeat(32)}`;
const CANCEL_REPORT = `20260801-${"4".repeat(32)}`;

function healthBytes(deployment = DEPLOYMENT) {
  return Buffer.from(
    JSON.stringify({
      deployment,
      status: "ok",
      warnings: [],
      checks: {
        durableJobs: {
          requested: true,
          enabled: true,
          readiness: "ready"
        }
      }
    })
  );
}

async function hostedFixture() {
  const evidenceModule = await script(
    "durable-soak-exercise-evidence-lib.mjs"
  );
  const health = healthBytes();
  const postHealth = healthBytes();
  const evidence = {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-durable-soak-exercise-evidence",
    sourceCommit: DEPLOYMENT,
    deploymentCommit: DEPLOYMENT,
    durableConfig: {
      path: "wrangler.container.jsonc",
      sha256: CONFIG_SHA
    },
    health: {
      observedAt: "2026-08-01T01:00:01.000Z",
      sha256: createHash("sha256").update(health).digest("hex")
    },
    postHealth: {
      observedAt: "2026-08-01T01:09:30.000Z",
      sha256: createHash("sha256")
        .update(postHealth)
        .digest("hex")
    },
    session: {
      startedAt: "2026-08-01T01:00:00.000Z",
      completedAt: "2026-08-01T01:10:00.000Z"
    },
    behaviors: [
      {
        id: "normal-completion",
        observedAt: "2026-08-01T01:05:00.000Z",
        jobId: NORMAL_JOB,
        reportId: NORMAL_REPORT,
        reportSha256: "d".repeat(64)
      },
      {
        id: "cancellation",
        observedAt: "2026-08-01T01:09:00.000Z",
        jobId: CANCEL_JOB,
        reportId: CANCEL_REPORT,
        status: "cancelled",
        responseSha256: "e".repeat(64)
      },
      {
        id: "completed-report-recovery",
        observedAt: "2026-08-01T01:06:00.000Z",
        jobId: NORMAL_JOB,
        reportId: NORMAL_REPORT,
        reportSha256: "d".repeat(64)
      },
      {
        id: "duplicate-prevention",
        observedAt: "2026-08-01T01:01:00.000Z",
        jobId: NORMAL_JOB,
        reportId: NORMAL_REPORT,
        firstStatus: 202,
        replayStatus: 202,
        requestCommitmentSha256: "f".repeat(64)
      }
    ]
  };
  return {
    evidence,
    exerciseBytes: Buffer.from(
      evidenceModule.serializeDurableSoakExerciseEvidence(evidence)
    ),
    healthBytes: health,
    postHealthBytes: postHealth,
    sourceHeadSha: DEPLOYMENT,
    requiredJobs: [
      {
        name:
          "Exercise durable completion, cancellation, and recovery",
        startedAt: "2026-08-01T00:59:00.000Z",
        completedAt: "2026-08-01T01:11:00.000Z"
      }
    ],
    subjectBindings: {
      soakDeploymentCommit: DEPLOYMENT,
      durableConfigDigest: CONFIG_SHA,
      durableEnableReceiptDigest: ENABLE_RECEIPT_SHA
    },
    window: {
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-02T00:00:00.000Z"
    }
  };
}

test("durable-soak hosted profile requires the distinct exercise source and exact retained members", async () => {
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const contract =
    hosted.hostedEvidenceCollectionContract("durable-soak");
  assert.deepEqual(contract.exactRoles, [
    "monitor",
    "restart",
    "exercises"
  ]);
  assert.deepEqual(contract.sources.exercises.workflows, [
    ".github/workflows/durable-soak-exercises.yml"
  ]);
  assert.deepEqual(
    contract.sources.monitor.trustedSourcePaths,
    [
      "package-lock.json",
      "package.json",
      "tsconfig.json",
      "tsconfig.schema.json",
      "lib/canonical-json.ts",
      "lib/sha256.ts",
      "lib/strict-json.ts",
      "scripts/archive-hosted-evidence.mjs",
      "scripts/build-schema.mjs",
      "scripts/durable-soak-exercise-evidence-lib.mjs",
      "scripts/durable-soak-ledger-lib.mjs",
      "scripts/durable-soak-ledger.mjs",
      "scripts/durable-soak-restart-evidence-lib.mjs",
      "scripts/hosted-evidence-provenance-lib.mjs",
      "scripts/operator-evidence-common.mjs",
      "scripts/staging-teardown-evidence-lib.mjs",
      "scripts/staging-teardown-github-app-token.mjs",
      "scripts/staging-teardown-hosted-capture-lib.mjs",
      "scripts/staging-teardown-provider-adapter.mjs",
      "scripts/staging-teardown-provider-adapters.mjs",
      "scripts/staging-teardown-provider-http.mjs",
      "scripts/staging-teardown-target-projections.mjs",
      "scripts/waf-ceiling-evidence-lib.mjs",
      "scripts/waf-hosted-capture-lib.mjs"
    ]
  );
  assert.deepEqual(
    contract.sources.restart.trustedSourcePaths,
    [
      "package-lock.json",
      "package.json",
      "tsconfig.json",
      "tsconfig.schema.json",
      "lib/canonical-json.ts",
      "lib/durable-restart-control-auth.ts",
      "lib/sha256.ts",
      "lib/strict-json.ts",
      "scripts/build-schema.mjs",
      "scripts/durable-soak-restart-evidence-lib.mjs",
      "scripts/durable-soak-restart-evidence.mjs",
      "scripts/http-response.mjs",
      "scripts/operator-evidence-common.mjs",
      "scripts/scan-admission.mjs"
    ]
  );
  assert.deepEqual(
    contract.sources.exercises.trustedSourcePaths,
    [
      "package-lock.json",
      "package.json",
      "tsconfig.json",
      "tsconfig.schema.json",
      "lib/canonical-json.ts",
      "lib/sha256.ts",
      "lib/strict-json.ts",
      "scripts/build-schema.mjs",
      "scripts/durable-soak-exercise-evidence-lib.mjs",
      "scripts/durable-soak-exercise-evidence.mjs",
      "scripts/http-response.mjs",
      "scripts/operator-evidence-common.mjs",
      "scripts/scan-admission.mjs",
      "scripts/smoke-deployed-scanner-report.mjs"
    ]
  );
  assert.deepEqual(
    contract.sources.exercises.requiredArtifactMembers,
    [
      "exercise-evidence.json",
      "post-production-health.json",
      "production-health.json"
    ]
  );
});

test("hosted exercise binding joins candidate subject, deployment, config, enable receipt, job, and window", async () => {
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const fixture = await hostedFixture();
  const verified =
    hosted.verifyDurableSoakExerciseHostedBinding(fixture);
  assert.equal(verified.sourceCommit, DEPLOYMENT);
  assert.equal(verified.deploymentCommit, DEPLOYMENT);
  assert.deepEqual(verified.behaviorIds, [
    "normal-completion",
    "cancellation",
    "completed-report-recovery",
    "duplicate-prevention"
  ]);
});

test("missing, mismatched, replayed, cross-window, and unauthenticated-looking exercise evidence fails closed", async () => {
  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const cases: Array<{
    mutate: (fixture: Awaited<ReturnType<typeof hostedFixture>>) => void;
    pattern: RegExp;
  }> = [
    {
      mutate: (fixture) => {
        fixture.exerciseBytes = Buffer.from("{}\n");
      },
      pattern: /canonical evidence serialization|must contain exactly/
    },
    {
      mutate: (fixture) => {
        fixture.sourceHeadSha = "9".repeat(40);
      },
      pattern: /authenticated source commit/
    },
    {
      mutate: (fixture) => {
        fixture.subjectBindings.soakDeploymentCommit =
          "8".repeat(40);
      },
      pattern: /expected deployment/
    },
    {
      mutate: (fixture) => {
        fixture.subjectBindings.durableConfigDigest =
          "7".repeat(64);
      },
      pattern: /candidate durable config/
    },
    {
      mutate: (fixture) => {
        fixture.subjectBindings.durableEnableReceiptDigest = "";
      },
      pattern: /enable receipt/
    },
    {
      mutate: (fixture) => {
        fixture.window.startedAt = "2026-08-01T02:00:00.000Z";
      },
      pattern: /outside the authenticated soak window/
    },
    {
      mutate: (fixture) => {
        fixture.requiredJobs[0].startedAt =
          "2026-08-01T01:02:00.000Z";
      },
      pattern: /authenticated exercise job/
    },
    {
      mutate: (fixture) => {
        fixture.healthBytes = healthBytes("6".repeat(40));
      },
      pattern: /health digest|exact deployment/
    }
  ];
  for (const { mutate, pattern } of cases) {
    const fixture = await hostedFixture();
    mutate(fixture);
    assert.throws(
      () =>
        hosted.verifyDurableSoakExerciseHostedBinding(fixture),
      pattern
    );
  }

  const attestationArgs =
    hosted.hostedEvidenceAttestationVerifyArgs({
      contextPath: "/tmp/context.json",
      bundlePath: "/tmp/context.sigstore.json",
      expectedArchiverCommit: "5".repeat(40)
    });
  assert.equal(attestationArgs.includes("--deny-self-hosted-runners"), true);
  assert.equal(attestationArgs.includes("--signer-digest"), true);
  assert.equal(attestationArgs.includes("--source-digest"), true);
  assert.equal(
    attestationArgs.includes(
      "https://token.actions.githubusercontent.com"
    ),
    true
  );
});

test("candidate verification runs durable source-closure enforcement only for the durable archive", async () => {
  const candidateSource = readFileSync(
    path.join(
      process.cwd(),
      "lib",
      "measurement-candidate-binding.ts"
    ),
    "utf8"
  );
  const stagingStart = candidateSource.indexOf(
    "function verifyStagingTeardownProvenanceWithCanonicalCli"
  );
  const durableStart = candidateSource.indexOf(
    "function verifyDurableSoakProvenanceWithCanonicalCli"
  );
  const durableEnd = candidateSource.indexOf(
    "export function verifyStagingTeardownHostedSourceTrust"
  );
  assert.ok(
    stagingStart >= 0 &&
      durableStart > stagingStart &&
      durableEnd > durableStart
  );
  assert.doesNotMatch(
    candidateSource.slice(stagingStart, durableStart),
    /verify-hosted-source-closure\.mjs/
  );
  assert.match(
    candidateSource.slice(durableStart, durableEnd),
    /verify-hosted-source-closure\.mjs[\s\S]*--profile[\s\S]*MEASUREMENT_DURABLE_SOAK_HOSTED_PROFILE[\s\S]*--candidate-commit/
  );

  const hosted = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const verifier = await script(
    "verify-hosted-source-closure.mjs"
  );
  const root = mkdtempSync(
    path.join(tmpdir(), "durable-source-closure-verifier-")
  );
  const contract =
    hosted.hostedEvidenceCollectionContract("durable-soak");
  const sourceContract = contract.sources.exercises;
  const workflowPath = sourceContract.workflows[0];
  try {
    for (const relativePath of [
      workflowPath,
      ...sourceContract.trustedSourcePaths
    ]) {
      const absolutePath = path.join(
        root,
        ...relativePath.split("/")
      );
      mkdirSync(path.dirname(absolutePath), {
        recursive: true
      });
      writeFileSync(
        absolutePath,
        `${relativePath}: source\n`
      );
    }
    initFixtureRepo(root, {
      name: "Durable Source Test",
      email: "durable@example.test"
    });
    runFixtureGit(root, ["add", "."]);
    runFixtureGit(root, ["commit", "-q", "-m", "source"]);
    const sourceCommit = runFixtureGit(root, ["rev-parse", "HEAD"]).trim();
    const contextPath = path.join(root, "context.json");
    writeFileSync(
      contextPath,
      JSON.stringify({
        profile: "durable-soak",
        sources: [
          {
            role: "exercises",
            workflowPath,
            headSha: sourceCommit
          }
        ]
      })
    );
    writeFileSync(
      path.join(
        root,
        "scripts",
        "durable-soak-exercise-evidence.mjs"
      ),
      "candidate drift\n"
    );
    execFileSync(
      "git",
      [
        "add",
        "context.json",
        "scripts/durable-soak-exercise-evidence.mjs"
      ],
      { cwd: root }
    );
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "candidate"
      ],
      { cwd: root }
    );
    const candidateCommit = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: root, encoding: "utf8" }
    ).trim();
    assert.throws(
      () =>
        verifier.verifyHostedSourceClosure({
          rootDir: root,
          contextPath,
          profile: "durable-soak",
          candidateCommit
        }),
      /producer bytes that do not equal the candidate-approved scripts\/durable-soak-exercise-evidence\.mjs/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

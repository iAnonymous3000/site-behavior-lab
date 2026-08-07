import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runFixtureGit } from "./git-fixture";

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

const SOURCE_COMMIT = "a".repeat(40);
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<{ name: string; bytes: Buffer }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, entry.bytes);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + entry.bytes.length;
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralBytes, end]);
}

function git(root: string, args: string[]) {
  return runFixtureGit(root, args, {
    GIT_AUTHOR_DATE: "2026-08-01T13:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-01T13:00:00Z"
  }).trim();
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function stagingReceipt() {
  const staging = await script("staging-teardown-evidence-lib.mjs");
  const plan = staging.stagingTeardownDryRunPlan();
  const before = plan.map(
    (entry: { kind: string; logicalName: string }) => ({
      kind: entry.kind,
      logicalName: entry.logicalName,
      externalIds: [`id:${entry.logicalName}`],
      state: "present",
      evidenceArtifact: {
        kind: "provider-inventory-response",
        sessionId: SESSION_ID,
        bytes: `fixture:before:${entry.logicalName}`
      }
    })
  );
  const actions = plan.map(
    (entry: {
      kind: string;
      logicalName: string;
      ifPresent: string;
    }) => ({
      kind: entry.kind,
      logicalName: entry.logicalName,
      externalIds: [`id:${entry.logicalName}`],
      disposition: entry.ifPresent,
      completedAt: "2026-08-01T14:00:02.000Z",
      evidenceArtifact: {
        kind: "provider-removal-response",
        sessionId: SESSION_ID,
        bytes: `fixture:remove:${entry.logicalName}`
      }
    })
  );
  const after = plan.map(
    (entry: { kind: string; logicalName: string }) => ({
      kind: entry.kind,
      logicalName: entry.logicalName,
      externalIds: [],
      state: "absent",
      evidenceArtifact: {
        kind: "provider-inventory-response",
        sessionId: SESSION_ID,
        bytes: `fixture:after:${entry.logicalName}`
      }
    })
  );
  return staging.buildStagingTeardownEvidence({
    sourceBytes: `${JSON.stringify({
      stagingSourceCommit: SOURCE_COMMIT,
      recordedAt: "2026-08-01T14:00:04.000Z",
      session: {
        id: SESSION_ID,
        startedAt: "2026-08-01T14:00:00.000Z",
        inventoryBeforeAt: "2026-08-01T14:00:01.000Z",
        inventoryAfterAt: "2026-08-01T14:00:03.000Z",
        completedAt: "2026-08-01T14:00:04.000Z"
      },
      inventory: { before, actions, after }
    })}\n`
  });
}

async function stagingArchiveFixture(
  mutateManifest?: (manifest: Record<string, any>) => void
) {
  const hosted = await script(
    "staging-teardown-hosted-capture-lib.mjs"
  );
  const staging = await script("staging-teardown-evidence-lib.mjs");
  const common = await script("operator-evidence-common.mjs");
  const provenance = await script(
    "hosted-evidence-provenance-lib.mjs"
  );
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "sbl-staging-archive-"))
  );
  for (const repositoryPath of
    hosted.STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS) {
    const target = path.join(root, ...repositoryPath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(
        path.join(process.cwd(), ...repositoryPath.split("/"))
      )
    );
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Staging Archive Test"]);
  git(root, [
    "config",
    "user.email",
    "staging-archive@example.invalid"
  ]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-q", "-m", "authenticated capture source"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const receipt = await stagingReceipt();
  const receiptBytes = Buffer.from(
    staging.serializeStagingTeardownEvidence(receipt),
    "utf8"
  );
  const manifest = hosted.buildStagingTeardownHostedManifest(
    receipt,
    hosted.stagingTeardownHostedProducerClosureFromDirectory(root)
  );
  mutateManifest?.(manifest);
  const manifestBytes = Buffer.from(
    common.serializeCanonicalEvidence(manifest),
    "utf8"
  );
  const archive = storedZip([
    { name: "receipt.json", bytes: receiptBytes },
    {
      name: "sanitized-provider-manifest.json",
      bytes: manifestBytes
    }
  ]);
  const archiveDigest = sha256(archive);
  const runId = 501;
  const runAttempt = 1;
  const artifactId = 502;
  const artifactName =
    `site-behavior-staging-teardown-evidence-${runId}-${runAttempt}`;
  const inputDirectory = path.join(root, "fixture-inputs");
  mkdirSync(inputDirectory);
  const runPath = path.join(inputDirectory, "run.json");
  const jobsPath = path.join(inputDirectory, "jobs.json");
  const artifactsPath = path.join(inputDirectory, "artifacts.json");
  const metadataPath = path.join(inputDirectory, "artifact.json");
  const archivePath = path.join(inputDirectory, "artifact.zip");
  const subjectPath = path.join(inputDirectory, "subject.json");
  writeJson(runPath, {
    id: runId,
    run_attempt: runAttempt,
    repository: { full_name: "iAnonymous3000/site-behavior-lab" },
    path: ".github/workflows/staging-teardown-evidence.yml",
    head_branch: "main",
    head_sha: sourceCommit,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    run_started_at: "2026-08-01T13:59:00Z",
    updated_at: "2026-08-01T14:05:00Z"
  });
  writeJson(jobsPath, {
    total_count: 1,
    jobs: [
      {
        id: 503,
        name: "Capture sanitized staging teardown evidence",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-01T13:59:00Z",
        completed_at: "2026-08-01T14:05:00Z"
      }
    ]
  });
  const artifact = {
    id: artifactId,
    name: artifactName,
    digest: `sha256:${archiveDigest}`,
    expired: false,
    size_in_bytes: archive.byteLength,
    workflow_run: { id: runId, head_sha: sourceCommit }
  };
  writeJson(artifactsPath, {
    total_count: 1,
    artifacts: [artifact]
  });
  writeJson(metadataPath, artifact);
  writeFileSync(archivePath, archive, { mode: 0o600 });
  writeFileSync(subjectPath, receiptBytes, { mode: 0o600 });
  const subjectSha256 = sha256(receiptBytes);
  const relative = provenance.hostedEvidenceArchiveRelativePath(
    "staging-teardown",
    subjectSha256
  );
  const outputDirectory = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(outputDirectory), { recursive: true });
  return {
    root,
    outputDirectory,
    create: () =>
      provenance.createHostedEvidenceDirectory({
        profile: "staging-teardown",
        recordedAt: "2026-08-01T14:05:00.000Z",
        archiver: {
          runId: 504,
          runAttempt: 1,
          sourceCommit,
          runnerEnvironment: "github-hosted"
        },
        subject: {
          repositoryPath:
            "research/ops-evidence/staging-teardown.json",
          commit: sourceCommit,
          filePath: subjectPath
        },
        sources: [
          {
            role: "provider-capture",
            workflowPath:
              ".github/workflows/staging-teardown-evidence.yml",
            runId,
            runAttempt,
            headSha: sourceCommit,
            runPath,
            jobsPagePaths: [jobsPath],
            artifactsPagePaths: [artifactsPath],
            artifact: {
              id: artifactId,
              name: artifactName,
              sha256: archiveDigest,
              members: [
                "receipt.json",
                "sanitized-provider-manifest.json"
              ]
            },
            artifactMetadataPath: metadataPath,
            artifactArchivePath: archivePath
          }
        ],
        outputDirectory,
        repositoryRoot: root
      })
  };
}

test("staging teardown hosted producer closure is an exact ordered source set", async () => {
  const hosted = await script(
    "staging-teardown-hosted-capture-lib.mjs"
  );
  const closure = hosted.buildStagingTeardownHostedProducerClosure(
    (repositoryPath: string) =>
      Buffer.from(`exact:${repositoryPath}`, "utf8")
  );
  assert.deepEqual(
    closure.files.map((entry: { path: string }) => entry.path),
    hosted.STAGING_TEARDOWN_HOSTED_PRODUCER_CLOSURE_PATHS
  );
  assert.equal(
    closure.files.every((entry: { sha256: string }) =>
      /^[0-9a-f]{64}$/.test(entry.sha256)
    ),
    true
  );
  assert.equal(
    hosted.validateStagingTeardownHostedProducerClosure(closure),
    closure
  );

  const cases = [
    {
      mutate(value: any) {
        value.files.pop();
      },
      message: /exact source path set/
    },
    {
      mutate(value: any) {
        value.files.push({
          path: "scripts/undeclared-provider.mjs",
          sha256: "0".repeat(64)
        });
      },
      message: /exact source path set/
    },
    {
      mutate(value: any) {
        [value.files[0], value.files[1]] = [
          value.files[1],
          value.files[0]
        ];
      },
      message: /must bind/
    }
  ];
  for (const entry of cases) {
    const changed = structuredClone(closure);
    entry.mutate(changed);
    assert.throws(
      () =>
        hosted.validateStagingTeardownHostedProducerClosure(changed),
      entry.message
    );
  }
});

test("staging teardown hosted verifier rejects a stale producer digest", async () => {
  const hosted = await script(
    "staging-teardown-hosted-capture-lib.mjs"
  );
  const staging = await script("staging-teardown-evidence-lib.mjs");
  const common = await script("operator-evidence-common.mjs");
  const receipt = await stagingReceipt();
  const closure =
    hosted.stagingTeardownHostedProducerClosureFromDirectory(
      process.cwd()
    );
  const directory = mkdtempSync(
    path.join(tmpdir(), "sbl-staging-hosted-source-")
  );
  try {
    writeFileSync(
      path.join(directory, "receipt.json"),
      staging.serializeStagingTeardownEvidence(receipt)
    );
    const manifest = hosted.buildStagingTeardownHostedManifest(
      receipt,
      closure
    );
    writeFileSync(
      path.join(directory, "sanitized-provider-manifest.json"),
      common.serializeCanonicalEvidence(manifest)
    );
    assert.equal(
      hosted.verifyStagingTeardownHostedSafeDirectory(directory).ok,
      true
    );

    manifest.producerClosure.files[0].sha256 = "0".repeat(64);
    writeFileSync(
      path.join(directory, "sanitized-provider-manifest.json"),
      common.serializeCanonicalEvidence(manifest)
    );
    assert.throws(
      () => hosted.verifyStagingTeardownHostedSafeDirectory(directory),
      /does not canonically rederive/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("staging teardown archive executes exact producer-closure validation", async () => {
  const fixture = await stagingArchiveFixture();
  try {
    const created = fixture.create();
    assert.match(created.subjectSha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("staging teardown archive rejects missing, extra, and stale closure members", async () => {
  const cases = [
    {
      mutate(manifest: Record<string, any>) {
        manifest.producerClosure.files.pop();
      },
      message: /not rederived by the authenticated/
    },
    {
      mutate(manifest: Record<string, any>) {
        manifest.producerClosure.files.push({
          path: "scripts/undeclared-provider.mjs",
          sha256: "0".repeat(64)
        });
      },
      message: /not rederived by the authenticated/
    },
    {
      mutate(manifest: Record<string, any>) {
        manifest.producerClosure.files[0].sha256 = "0".repeat(64);
      },
      message: /not rederived by the authenticated/
    }
  ];
  for (const entry of cases) {
    const fixture = await stagingArchiveFixture(entry.mutate);
    try {
      assert.throws(() => fixture.create(), entry.message);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

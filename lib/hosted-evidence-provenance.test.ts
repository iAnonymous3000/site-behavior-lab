// @ts-nocheck

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import { pathToFileURL } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

let hosted: any;
let collector: any;
let durableRestart: any;
let soakCollector: any;
const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<any>;
before(async () => {
  hosted = await nativeImport(
    pathToFileURL(
      path.join(
        process.cwd(),
        "scripts",
        "hosted-evidence-provenance-lib.mjs"
      )
    ).href
  );
  collector = await nativeImport(
    pathToFileURL(
      path.join(process.cwd(), "scripts", "archive-hosted-evidence.mjs")
    ).href
  );
  durableRestart = await nativeImport(
    pathToFileURL(
      path.join(
        process.cwd(),
        "scripts",
        "durable-soak-restart-evidence-lib.mjs"
      )
    ).href
  );
  soakCollector = await nativeImport(
    pathToFileURL(
      path.join(
        process.cwd(),
        "scripts",
        "durable-soak-ledger.mjs"
      )
    ).href
  );
});

const SHA = "a".repeat(40);
const ARCHIVER_SHA = "b".repeat(40);
const RUN_ID = 101;
const RUN_ATTEMPT = 2;
const ARTIFACT_ID = 303;
const REPORT_ID = `20260801-${"c".repeat(32)}`;

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<any>, options: any = {}) {
  const preamble = Buffer.from(options.preamble ?? []);
  const locals: Buffer[] = preamble.length > 0 ? [preamble] : [];
  const central: Buffer[] = [];
  const centralEntryOffsets: number[] = [];
  let localOffset = preamble.length;
  let centralOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localExtra = Buffer.from(entry.localExtra ?? []);
    const centralExtra = Buffer.from(entry.centralExtra ?? []);
    const plain = Buffer.from(entry.bytes);
    let compressed =
      entry.method === 8 ? deflateRawSync(plain) : Buffer.from(plain);
    if (entry.trailingDeflate) {
      compressed = Buffer.concat([compressed, Buffer.from([0xde, 0xad])]);
    }
    const checksum =
      entry.badCrc === true ? (crc32(plain) ^ 0xffffffff) >>> 0 : crc32(plain);
    const flags = entry.flags ?? (entry.descriptor ? 0x8 : 0x800);
    const local = Buffer.alloc(30 + name.length + localExtra.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(entry.descriptor ? 0 : checksum, 14);
    local.writeUInt32LE(entry.descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(entry.descriptor ? 0 : plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    name.copy(local, 30);
    localExtra.copy(local, 30 + name.length);
    const descriptor = entry.descriptor
      ? (() => {
          const value = Buffer.alloc(entry.signedDescriptor ? 16 : 12);
          let offset = 0;
          if (entry.signedDescriptor) {
            value.writeUInt32LE(0x08074b50, 0);
            offset = 4;
          }
          value.writeUInt32LE(checksum, offset);
          value.writeUInt32LE(compressed.length, offset + 4);
          value.writeUInt32LE(plain.length, offset + 8);
          return value;
        })()
      : Buffer.alloc(0);
    const gap = Buffer.from(entry.gapAfter ?? []);
    locals.push(local, compressed, descriptor, gap);

    const record = Buffer.alloc(
      46 + name.length + centralExtra.length
    );
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(entry.method ?? 0, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(plain.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(
      ((entry.mode ?? 0o100644) << 16) >>> 0,
      38
    );
    record.writeUInt32LE(localOffset, 42);
    name.copy(record, 46);
    centralExtra.copy(record, 46 + name.length);
    centralEntryOffsets.push(centralOffset);
    central.push(record);
    centralOffset += record.length;
    localOffset +=
      local.length + compressed.length + descriptor.length + gap.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return {
    bytes: Buffer.concat([...locals, centralBytes, eocd]),
    centralStart: localOffset,
    centralEntryOffsets
  };
}

function featuredZip(extra: Array<any> = []) {
  return zip([
    {
      name: "publication.json",
      bytes: Buffer.from('{"ok":true}\n')
    },
    {
      name: "corpus-stats.json",
      bytes: Buffer.from('{"sampleSize":1}\n')
    },
    {
      name: "reports/index.json",
      bytes: Buffer.from('{"reports":[]}\n')
    },
    {
      name: `reports/${REPORT_ID}.json`,
      bytes: Buffer.from('{"schemaVersion":2}\n')
    },
    {
      name: `reports/${REPORT_ID}.provenance.json`,
      bytes: Buffer.from('{"source":"fixture"}\n')
    },
    ...extra
  ]);
}

test("featured publication accepts the actual report/provenance sidecar layout", () => {
  const archive = featuredZip().bytes;
  const members = hosted.inspectHostedEvidenceArtifactZip(
    archive,
    ["publication.json"],
    "featured-publication"
  );
  assert.equal(members.length, 1);
  assert.equal(members[0].path, "publication.json");
});

test("ZIP parser accepts GitHub's real deflate data-descriptor shape", () => {
  for (const signedDescriptor of [false, true]) {
    const archive = zip([
      {
        name: "publication.json",
        bytes: Buffer.from('{"ok":true}\n'),
        method: 8,
        descriptor: true,
        signedDescriptor
      }
    ]).bytes;
    assert.equal(
      hosted.inspectHostedEvidenceArtifactZip(
        archive,
        ["publication.json"],
        "exact"
      )[0].path,
      "publication.json"
    );
  }
});

test("featured publication refuses the obsolete .json.provenance spelling and unknown files", () => {
  assert.throws(
    () =>
      hosted.inspectHostedEvidenceArtifactZip(
        featuredZip([
          {
            name: `reports/${REPORT_ID}.json.provenance.json`,
            bytes: Buffer.from("{}\n")
          }
        ]).bytes,
        ["publication.json"],
        "featured-publication"
      ),
    /unapproved member/
  );
  assert.throws(
    () =>
      hosted.inspectHostedEvidenceArtifactZip(
        featuredZip([
          { name: "private-provider.json", bytes: Buffer.from("{}\n") }
        ]).bytes,
        ["publication.json"],
        "featured-publication"
      ),
    /unapproved member/
  );
});

test("ZIP parser refuses duplicate, traversal, symlink, malformed descriptor, ZIP64, CRC, hidden bytes, and overlap", () => {
  const inspect = (bytes: Buffer) =>
    hosted.inspectHostedEvidenceArtifactZip(
      bytes,
      ["publication.json"],
      "exact"
    );
  assert.throws(
    () =>
      inspect(
        zip([
          { name: "publication.json", bytes: Buffer.from("{}") },
          { name: "publication.json", bytes: Buffer.from("{}") }
        ]).bytes
      ),
    /repeats a member path/
  );
  assert.throws(
    () =>
      hosted.inspectHostedEvidenceArtifactZip(
        zip([{ name: "../publication.json", bytes: Buffer.from("{}") }]).bytes,
        ["../publication.json"],
        "exact"
      ),
    /safe repository-relative path/
  );
  assert.throws(
    () =>
      inspect(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            mode: 0o120777
          }
        ]).bytes
      ),
    /not a regular file/
  );
  assert.throws(
    () =>
      inspect(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            flags: 0x808
          }
        ]).bytes
      ),
    /local and central|data descriptor/
  );
  const zip64 = zip([
    { name: "publication.json", bytes: Buffer.from("{}") }
  ]);
  zip64.bytes.writeUInt32LE(
    0xffffffff,
    zip64.centralStart + zip64.centralEntryOffsets[0] + 20
  );
  assert.throws(() => inspect(zip64.bytes), /ZIP64|unsupported metadata/);
  assert.throws(
    () =>
      inspect(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            badCrc: true
          }
        ]).bytes
      ),
    /CRC/
  );
  assert.throws(
    () =>
      inspect(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            method: 8,
            trailingDeflate: true
          }
        ]).bytes
      ),
    /decompressed|trailing/
  );
  const overlap = zip([
    { name: "publication.json", bytes: Buffer.from("{}") },
    { name: "receipt.json", bytes: Buffer.from("{}") }
  ]);
  overlap.bytes.writeUInt32LE(
    0,
    overlap.centralStart + overlap.centralEntryOffsets[1] + 42
  );
  assert.throws(
    () =>
      hosted.inspectHostedEvidenceArtifactZip(
        overlap.bytes,
        ["publication.json", "receipt.json"],
        "exact"
      ),
    /repeats a local-header offset|overlap/
  );
  assert.throws(
    () =>
      inspect(
        zip(
          [{ name: "publication.json", bytes: Buffer.from("{}") }],
          { preamble: [0x41] }
        ).bytes
      ),
    /preamble/
  );
  assert.throws(
    () =>
      hosted.inspectHostedEvidenceArtifactZip(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            gapAfter: [0x42]
          },
          { name: "receipt.json", bytes: Buffer.from("{}") }
        ]).bytes,
        ["publication.json", "receipt.json"],
        "exact"
      ),
    /hide a gap/
  );
  assert.throws(
    () =>
      inspect(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            centralExtra: [0x01, 0x00, 0x00, 0x00]
          }
        ]).bytes
      ),
    /unsupported metadata/
  );
  assert.throws(
    () =>
      inspect(
        zip([
          {
            name: "publication.json",
            bytes: Buffer.from("{}"),
            localExtra: [0x55, 0x54, 0x00, 0x00]
          }
        ]).bytes
      ),
    /local and central metadata/
  );
});

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function mutateJson(file: string, mutate: (value: any) => void) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  mutate(value);
  writeJson(file, value);
}

function controlledFixture(options: any = {}) {
  const publisherRunAttempt =
    options.publisherRunAttempt ?? RUN_ATTEMPT;
  const acquisitionRunAttempt =
    options.acquisitionRunAttempt ?? RUN_ATTEMPT;
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "sbl-hosted-test-"))
  );
  const inputs = path.join(root, "inputs");
  mkdirSync(inputs);
  const publication = {
    schemaVersion: 1,
    sourceCommit: SHA,
    publicationKind: "featured",
    reportMode: "r2",
    expectedReportIds: [],
    files: []
  };
  const publicationBytes = Buffer.from(`${JSON.stringify(publication)}\n`);
  const receipt = {
    actionsRun: {
      id: RUN_ID,
      attempt: acquisitionRunAttempt,
      sourceCommit: options.receiptSha ?? SHA
    },
    publicationArtifact: {
      manifestSha256: sha256(publicationBytes)
    }
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const archive = zip([
    { name: "publication.json", bytes: publicationBytes },
    { name: "receipt.json", bytes: receiptBytes }
  ]).bytes;
  const archiveDigest = sha256(archive);
  const artifactName =
    `site-behavior-controlled-publication-evidence-${RUN_ID}-${publisherRunAttempt}`;
  const runPath = path.join(inputs, "run.json");
  const jobsPath = path.join(inputs, "jobs.json");
  const artifactsPath = path.join(inputs, "artifacts.json");
  const metadataPath = path.join(inputs, "artifact.json");
  const archivePath = path.join(inputs, "artifact.zip");
  const subjectPath = path.join(inputs, "subject.json");
  writeJson(runPath, {
    id: RUN_ID,
    run_attempt: publisherRunAttempt,
    repository: { full_name: "iAnonymous3000/site-behavior-lab" },
    path: ".github/workflows/scan-featured.yml",
    head_branch: "main",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    run_started_at: "2026-08-01T12:03:18Z",
    updated_at: "2026-08-01T12:03:23Z"
  });
  writeJson(jobsPath, {
    total_count: 1,
    jobs: [
      {
        id: 202,
        name:
          options.jobName ?? "Validate and Publish Featured Reports",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-01T12:03:18Z",
        completed_at: "2026-08-01T12:03:23Z"
      }
    ]
  });
  const artifact = {
    id: ARTIFACT_ID,
    name: artifactName,
    digest: `sha256:${archiveDigest}`,
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: { id: RUN_ID, head_sha: SHA }
  };
  writeJson(artifactsPath, { total_count: 1, artifacts: [artifact] });
  writeJson(metadataPath, artifact);
  writeFileSync(archivePath, archive, { mode: 0o600 });
  writeFileSync(subjectPath, receiptBytes, { mode: 0o600 });
  const subjectSha = sha256(receiptBytes);
  const relative = hosted.hostedEvidenceArchiveRelativePath(
    "controlled-publication",
    subjectSha
  );
  const output = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(output), { recursive: true });
  return {
    root,
    output,
    subjectSha,
    source: {
      role: "publisher",
      workflowPath: ".github/workflows/scan-featured.yml",
      runId: RUN_ID,
      runAttempt: publisherRunAttempt,
      headSha: SHA,
      requiredJobNames: options.requiredJobNames,
      runPath,
      jobsPagePaths: [jobsPath],
      artifactsPagePaths: [artifactsPath],
      artifact: {
        id: ARTIFACT_ID,
        name: artifactName,
        sha256: archiveDigest,
        members: options.members ?? ["publication.json", "receipt.json"]
      },
      artifactMetadataPath: metadataPath,
      artifactArchivePath: archivePath
    },
    subjectPath
  };
}

function createControlled(fixture: any) {
  return hosted.createHostedEvidenceDirectory({
    profile: "controlled-publication",
    recordedAt: "2026-08-01T01:00:00.000Z",
    archiver: {
      runId: 404,
      runAttempt: 1,
      sourceCommit: ARCHIVER_SHA,
      runnerEnvironment: "github-hosted"
    },
    subject: {
      repositoryPath: "research/controlled-publications/101-2/receipt.json",
      commit: SHA,
      filePath: fixture.subjectPath
    },
    sources: [fixture.source],
    outputDirectory: fixture.output
  });
}

test("controlled profile retains and re-verifies exact raw bytes plus attestation", () => {
  const fixture = controlledFixture();
  const created = createControlled(fixture);
  writeFileSync(
    path.join(fixture.output, hosted.HOSTED_EVIDENCE_BUNDLE_FILE),
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n'
  );
  const verified = hosted.verifyHostedEvidenceDirectory({
    rootDir: fixture.root,
    directory: fixture.output,
    expectedProfile: "controlled-publication",
    expectedSubjectPath:
      "research/controlled-publications/101-2/receipt.json",
    expectedSubjectSha256: created.subjectSha256,
    expectedSubjectCommit: SHA,
    expectedArchiverCommit: ARCHIVER_SHA,
    attestationVerifier: () => ({
      status: "verified-by-gh-attestation"
    })
  });
  assert.equal(verified.ok, true, verified.issues.join("; "));
  assert.equal(
    verified.sources[0].requiredJobs[0].startedAt,
    "2026-08-01T12:03:18.000Z"
  );
  assert.equal(
    verified.sources[0].files.artifactArchive.endsWith("/artifact.zip"),
    true
  );
  const runFile = path.join(
    fixture.output,
    verified.sources[0].files.run
  );
  writeFileSync(runFile, Buffer.from('{"tampered":true}\n'));
  const tampered = hosted.verifyHostedEvidenceDirectory({
    rootDir: fixture.root,
    directory: fixture.output,
    expectedProfile: "controlled-publication",
    expectedSubjectPath:
      "research/controlled-publications/101-2/receipt.json",
    expectedSubjectSha256: created.subjectSha256,
    expectedSubjectCommit: SHA,
    expectedArchiverCommit: ARCHIVER_SHA,
    attestationVerifier: () => ({
      status: "verified-by-gh-attestation"
    })
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.issues.join("; "), /does not match its exact bytes/);
});

test("publisher rerun authenticates an earlier acquisition attempt without relabeling it", () => {
  const fixture = controlledFixture({
    publisherRunAttempt: 2,
    acquisitionRunAttempt: 1
  });
  const created = createControlled(fixture);
  assert.equal(created.context.sources[0].runAttempt, 2);
  assert.equal(
    JSON.parse(
      readFileSync(
        path.join(fixture.output, hosted.HOSTED_EVIDENCE_SUBJECT_FILE),
        "utf8"
      )
    ).actionsRun.attempt,
    1
  );
});

test("coherent-looking fabricated publication, caller member override, and job override fail", () => {
  assert.throws(
    () => createControlled(controlledFixture({ receiptSha: "d".repeat(40) })),
    /does not bind the authenticated publisher run/
  );
  assert.throws(
    () =>
      createControlled(
        controlledFixture({ members: ["publication.json"] })
      ),
    /members must be exactly/
  );
  assert.throws(
    () =>
      createControlled(
        controlledFixture({
          jobName: "Unrelated successful job",
          requiredJobNames: []
        })
      ),
    /must contain one successful completed job named/
  );
});

test("wrong repository, branch, event, conclusion, and expired artifact cannot authenticate", () => {
  for (const mutate of [
    (fixture: any) =>
      mutateJson(fixture.source.runPath, (run) => {
        run.repository.full_name = "attacker/example";
      }),
    (fixture: any) =>
      mutateJson(fixture.source.runPath, (run) => {
        run.head_branch = "topic";
      }),
    (fixture: any) =>
      mutateJson(fixture.source.runPath, (run) => {
        run.event = "pull_request";
      }),
    (fixture: any) =>
      mutateJson(fixture.source.runPath, (run) => {
        run.conclusion = "failure";
      }),
    (fixture: any) =>
      mutateJson(fixture.source.jobsPagePaths[0], (page) => {
        page.jobs[0].conclusion = "failure";
      }),
    (fixture: any) => {
      mutateJson(fixture.source.artifactsPagePaths[0], (page) => {
        page.artifacts[0].expired = true;
      });
      mutateJson(fixture.source.artifactMetadataPath, (artifact) => {
        artifact.expired = true;
      });
    }
  ]) {
    const fixture = controlledFixture();
    mutate(fixture);
    assert.throws(
      () => createControlled(fixture),
      /metadata|event|successful completed job|expired/
    );
  }
});

test("source-role duplication, self-hosted archiver, unenumerated files, and failed attestation refuse", () => {
  const duplicate = controlledFixture();
  assert.throws(
    () =>
      hosted.createHostedEvidenceDirectory({
        profile: "controlled-publication",
        recordedAt: "2026-08-01T01:00:00.000Z",
        archiver: {
          runId: 404,
          runAttempt: 1,
          sourceCommit: ARCHIVER_SHA,
          runnerEnvironment: "github-hosted"
        },
        subject: {
          repositoryPath:
            "research/controlled-publications/101-2/receipt.json",
          commit: SHA,
          filePath: duplicate.subjectPath
        },
        sources: [duplicate.source, duplicate.source],
        outputDirectory: duplicate.output
      }),
    /must retain exactly/
  );

  const selfHosted = controlledFixture();
  assert.throws(
    () =>
      hosted.createHostedEvidenceDirectory({
        profile: "controlled-publication",
        recordedAt: "2026-08-01T01:00:00.000Z",
        archiver: {
          runId: 404,
          runAttempt: 1,
          sourceCommit: ARCHIVER_SHA,
          runnerEnvironment: "self-hosted"
        },
        subject: {
          repositoryPath:
            "research/controlled-publications/101-2/receipt.json",
          commit: SHA,
          filePath: selfHosted.subjectPath
        },
        sources: [selfHosted.source],
        outputDirectory: selfHosted.output
      }),
    /GitHub-hosted runner/
  );

  const fixture = controlledFixture();
  const created = createControlled(fixture);
  writeFileSync(
    path.join(fixture.output, hosted.HOSTED_EVIDENCE_BUNDLE_FILE),
    '{"bundle":true}\n'
  );
  writeFileSync(path.join(fixture.output, "unexpected.txt"), "no\n");
  const unenumerated = hosted.verifyHostedEvidenceDirectory({
    rootDir: fixture.root,
    directory: fixture.output,
    expectedProfile: "controlled-publication",
    expectedSubjectPath:
      "research/controlled-publications/101-2/receipt.json",
    expectedSubjectSha256: created.subjectSha256,
    expectedSubjectCommit: SHA,
    expectedArchiverCommit: ARCHIVER_SHA,
    attestationVerifier: () => ({
      status: "verified-by-gh-attestation"
    })
  });
  assert.equal(unenumerated.ok, false);
  assert.match(unenumerated.issues.join("; "), /unenumerated files/);

  const failedFixture = controlledFixture();
  const failedCreated = createControlled(failedFixture);
  writeFileSync(
    path.join(
      failedFixture.output,
      hosted.HOSTED_EVIDENCE_BUNDLE_FILE
    ),
    '{"bundle":true}\n'
  );
  const failed = hosted.verifyHostedEvidenceDirectory({
    rootDir: failedFixture.root,
    directory: failedFixture.output,
    expectedProfile: "controlled-publication",
    expectedSubjectPath:
      "research/controlled-publications/101-2/receipt.json",
    expectedSubjectSha256: failedCreated.subjectSha256,
    expectedSubjectCommit: SHA,
    expectedArchiverCommit: ARCHIVER_SHA,
    attestationVerifier: () => ({ status: "rejected" })
  });
  assert.equal(failed.ok, false);
  assert.match(
    failed.issues.join("; "),
    /did not return a verified status/
  );
});

test("runner and durable profiles cannot relabel insufficient sources", () => {
  const runner = hosted.hostedEvidenceCollectionContract(
    "runner-destruction"
  );
  assert.deepEqual(runner.exactRoles, ["collection", "destruction"]);
  assert.deepEqual(
    runner.sources.destruction.requiredArtifactMembers,
    ["destruction-evidence.json"]
  );
  const soak = hosted.hostedEvidenceCollectionContract("durable-soak");
  assert.deepEqual(soak.exactRoles, [
    "monitor",
    "restart",
    "exercises"
  ]);
  assert.deepEqual(soak.sources.monitor.workflows, [
    ".github/workflows/durable-soak-monitor.yml"
  ]);
  assert.deepEqual(
    soak.sources.monitor.requiredArtifactMembers,
    ["ledger.json", "source-digests.json"]
  );
  assert.deepEqual(soak.sources.restart.workflows, [
    ".github/workflows/durable-soak-restart.yml"
  ]);
  assert.equal(
    soak.sources.restart.workflows.includes(
      ".github/workflows/production-health.yml"
    ),
    false
  );
  assert.deepEqual(soak.sources.exercises.workflows, [
    ".github/workflows/durable-soak-exercises.yml"
  ]);
  assert.deepEqual(
    soak.sources.exercises.requiredArtifactMembers,
    [
      "exercise-evidence.json",
      "post-production-health.json",
      "production-health.json"
    ]
  );
  const lifecycle =
    hosted.hostedEvidenceCollectionContract("lifecycle");
  assert.deepEqual(lifecycle.exactRoles, [
    "readback",
    "production-health"
  ]);
});

test("durable Production Health sources require both deep R2 steps to run successfully", () => {
  const stepNames = [
    "Validate availability and production posture",
    "Preserve exact production-health evidence",
    "Run production scan, R2 readback, and report-page synthetic",
    "Run isolated production R2 write/read/delete canary"
  ];
  const jobs = [
    {
      id: 9001,
      name: "Verify scanner health and posture",
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-01T12:03:18Z",
      completed_at: "2026-08-01T12:05:18Z",
      steps: stepNames.map((name, index) => ({
        name,
        number: index + 1,
        status: "completed",
        conclusion: "success",
        started_at: `2026-08-01T12:04:0${index}Z`,
        completed_at: `2026-08-01T12:04:1${index}Z`
      }))
    }
  ];
  const inspected = hosted.inspectHostedEvidenceJobs(
    "durable-transition",
    "production-health",
    jobs
  );
  assert.deepEqual(
    inspected[0].requiredSteps.map((step: any) => step.name),
    stepNames
  );
  for (const skippedName of stepNames.slice(2)) {
    const shallow = structuredClone(jobs);
    const skipped = shallow[0].steps.find(
      (step: any) => step.name === skippedName
    );
    skipped.status = "completed";
    skipped.conclusion = "skipped";
    skipped.started_at = null;
    skipped.completed_at = null;
    assert.throws(
      () =>
        hosted.inspectHostedEvidenceJobs(
          "lifecycle",
          "production-health",
          shallow
        ),
      new RegExp(
        `must execute one successful completed step named ${skippedName.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}`
      )
    );
  }
});

test("runner destruction raw Jobs metadata must be deliberately public-safe", () => {
  const safe = {
    id: 9111,
    name: "Populate Featured Gallery",
    status: "completed",
    conclusion: "success",
    started_at: "2026-08-01T12:03:18Z",
    completed_at: "2026-08-01T12:05:18Z",
    runner_name: "sbl-controlled-0123456789abcdef",
    runner_group_name: "Default",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "sbl-controlled-r2-fedcba9876543210"
    ]
  };
  assert.doesNotThrow(() =>
    hosted.inspectHostedEvidenceJobs(
      "runner-destruction",
      "collection",
      [safe]
    )
  );
  for (const unsafe of [
    { ...safe, runner_name: "10.0.0.12" },
    {
      ...safe,
      runner_name:
        "arn:aws:ec2:us-west-2:123456789012:instance/i-123"
    },
    {
      ...safe,
      labels: [...safe.labels, "project-customer-prod"]
    },
    { ...safe, runner_group_name: "provider-account-123" }
  ]) {
    assert.throws(
      () =>
        hosted.inspectHostedEvidenceJobs(
          "runner-destruction",
          "collection",
          [unsafe]
        ),
      /not deliberately public-safe/
    );
  }
  assert.throws(
    () =>
      hosted.inspectHostedEvidenceJobs(
        "runner-destruction",
        "collection",
        [
          safe,
          {
            ...safe,
            id: safe.id + 1,
            name: "Future extra self-hosted helper",
            runner_name: "vm-prod-provider-123"
          }
        ]
      ),
    /not deliberately public-safe/
  );
});

test("durable restart publishes only hashed runtime identity references", () => {
  const deployment = "e".repeat(40);
  const preRef = `sha256:${"1".repeat(64)}`;
  const postRef = `sha256:${"2".repeat(64)}`;
  const recovery = {
    schemaVersion: 1,
    artifactKind: "site-behavior-durable-queued-work-recovery",
    preRestartObservedAt: "2026-08-01T00:01:00.000Z",
    preRestartJob: {
      schemaVersion: 1,
      artifactKind:
        "site-behavior-durable-restart-job-snapshot",
      jobId: `20260801-${"3".repeat(32)}`,
      reportId: `20260801-${"4".repeat(32)}`,
      state: "leased",
      createdAt: "2026-08-01T00:00:30.000Z",
      finishedAt: null,
      attemptCount: 1,
      leaseGeneration: 1
    },
    terminalJob: {
      schemaVersion: 1,
      artifactKind:
        "site-behavior-durable-restart-job-snapshot",
      jobId: `20260801-${"3".repeat(32)}`,
      reportId: `20260801-${"4".repeat(32)}`,
      state: "succeeded",
      createdAt: "2026-08-01T00:00:30.000Z",
      finishedAt: "2026-08-01T00:09:00.000Z",
      attemptCount: 2,
      leaseGeneration: 2
    },
    publicationIdentity: {
      reportId: `20260801-${"4".repeat(32)}`,
      jsonPath: `/api/reports/20260801-${"4".repeat(32)}`,
      readbackAt: "2026-08-01T00:09:30.000Z",
      reportSha256: "5".repeat(64)
    }
  };
  const recoveryBytes = Buffer.from(
    JSON.stringify(recovery),
    "utf8"
  );
  const preHealth = {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-durable-runtime-provider-observation",
    deploymentCommit: deployment,
    observedAt: "2026-07-31T23:59:00.000Z",
    runtimeIdentityRef: preRef,
    provider: "cloudflare-containers-api",
    providerObservationSha256: "6".repeat(64)
  };
  const postHealth = {
    ...preHealth,
    observedAt: "2026-08-01T00:08:00.000Z",
    runtimeIdentityRef: postRef,
    providerObservationSha256: "7".repeat(64)
  };
  const restart = {
    schemaVersion: 1,
    artifactKind: "site-behavior-durable-runtime-restart-evidence",
    deploymentCommit: deployment,
    startedAt: "2026-08-01T00:05:00.000Z",
    restartObservedAt: "2026-08-01T00:08:00.000Z",
    completedAt: "2026-08-01T00:10:00.000Z",
    preRuntimeIdentityRef: preRef,
    postRuntimeIdentityRef: postRef,
    queuedWorkRecoverySha256: sha256(recoveryBytes)
  };
  assert.doesNotThrow(() =>
    durableRestart.verifyDurableRestartEvidenceSet({
      preHealth,
      postHealth,
      recovery,
      restart,
      recoverySha256: sha256(recoveryBytes)
    })
  );
  assert.throws(
    () =>
      durableRestart.verifyDurableRestartEvidenceSet({
        preHealth: {
          ...preHealth,
          runtimeIdentityRef: "raw-instance-id"
        },
        postHealth,
        recovery,
        restart,
        recoverySha256: sha256(recoveryBytes)
      }),
    /domain-separated sha256/
  );
});

test("staging teardown session must fit inside the authenticated capture job", () => {
  const job = {
    startedAt: "2026-08-01T12:03:18.000Z",
    completedAt: "2026-08-01T12:05:18.000Z"
  };
  assert.equal(
    hosted.verifyHostedEvidenceSessionWithinJob({
      session: {
        startedAt: "2026-08-01T12:03:30.000Z",
        completedAt: "2026-08-01T12:04:30.000Z"
      },
      recordedAt: "2026-08-01T12:04:45.000Z",
      job,
      label: "fixture"
    }),
    true
  );
  assert.throws(
    () =>
      hosted.verifyHostedEvidenceSessionWithinJob({
        session: {
          startedAt: "2026-07-31T12:03:30.000Z",
          completedAt: "2026-08-01T12:04:30.000Z"
        },
        recordedAt: "2026-08-01T12:04:45.000Z",
        job,
        label: "fixture"
      }),
    /fully contained/
  );
});

test("attestation verification pins workflow, source commit, main ref, issuer, and hosted runner", () => {
  const args = hosted.hostedEvidenceAttestationVerifyArgs({
    contextPath: "/tmp/context.json",
    bundlePath: "/tmp/context.sigstore.json",
    expectedArchiverCommit: ARCHIVER_SHA
  });
  for (const expected of [
    "--cert-identity",
    `https://github.com/iAnonymous3000/site-behavior-lab/.github/workflows/archive-hosted-evidence.yml@refs/heads/main`,
    "--signer-digest",
    ARCHIVER_SHA,
    "--source-digest",
    "--source-ref",
    "refs/heads/main",
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners"
  ]) {
    assert.equal(args.includes(expected), true, expected);
  }
});

test("collector strips authorization on allowed artifact redirects and rejects other hosts", async () => {
  const calls: any[] = [];
  const fetchImpl = async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init.headers });
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://pipelines.actions.githubusercontent.com/safe/archive"
        }
      });
    }
    return new Response(Buffer.from("zip"), {
      status: 200,
      headers: { "content-length": "3" }
    });
  };
  assert.equal(
    (
      await collector.githubApi(
        "/repos/x/actions/artifacts/1/zip",
        "secret-token",
        100,
        "application/octet-stream",
        fetchImpl
      )
    ).toString(),
    "zip"
  );
  assert.match(calls[0].headers.Authorization, /secret-token/);
  assert.equal("Authorization" in calls[1].headers, false);

  await assert.rejects(
    () =>
      collector.githubApi(
        "/repos/x/actions/artifacts/1/zip",
        "secret-token",
        100,
        "application/octet-stream",
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/archive" }
          })
      ),
    /untrusted host/
  );
});

test("collector request-slot and deadline budgets cover every hosted profile", () => {
  const expected = new Map([
    ["controlled-publication", [1, 26, 26]],
    ["runner-destruction", [2, 52, 26]],
    ["durable-transition", [3, 73, 26]],
    ["durable-soak", [3, 78, 26]],
    ["lifecycle", [2, 52, 26]],
    ["staging-teardown", [1, 26, 26]],
    ["waf-ceilings", [1, 26, 26]]
  ]);
  for (const [profile, values] of expected) {
    assert.deepEqual(
      collector.hostedEvidenceCollectionBudget(
        hosted.hostedEvidenceCollectionContract(profile)
      ),
      {
        sourceCount: values[0],
        requestSlotCap: values[1],
        elapsedRequestTimeoutSlotCap: values[2]
      },
      profile
    );
  }
  assert.equal(collector.HOSTED_EVIDENCE_MAX_PROFILE_REQUEST_SLOT_CAP, 78);
  assert.equal(collector.HOSTED_EVIDENCE_COLLECTION_DEADLINE_MS, 30 * 60_000);
  assert.equal(
    collector.HOSTED_EVIDENCE_COLLECTION_DEADLINE_MS,
    (collector.HOSTED_EVIDENCE_ARTIFACT_SOURCE_REQUEST_SLOT_CAP *
      collector.HOSTED_EVIDENCE_REQUEST_TIMEOUT_MS) +
      collector.HOSTED_EVIDENCE_COLLECTION_PROCESSING_RESERVE_MS
  );
});

test("collector runs at most three independent sources concurrently and preserves order", async () => {
  const control = collector.createHostedEvidenceCollectionControl(10_000);
  const started: number[] = [];
  const releases = new Map<number, (value: string) => void>();
  const resultPromise = collector.collectHostedEvidenceSources(
    [0, 1, 2].map((index) => async () => {
      started.push(index);
      return new Promise<string>((resolve) => releases.set(index, resolve));
    }),
    control
  );
  while (releases.size !== 3) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, [0, 1, 2]);
  releases.get(2)?.("third");
  releases.get(0)?.("first");
  releases.get(1)?.("second");
  assert.deepEqual(await resultPromise, ["first", "second", "third"]);

  await assert.rejects(
    () =>
      collector.collectHostedEvidenceSources(
        [() => 1, () => 2, () => 3, () => 4],
        control
      ),
    /requires 1\.\.3 task factories/
  );
});

test("collector cancels and settles sibling sources after one source fails", async () => {
  const control = collector.createHostedEvidenceCollectionControl(10_000);
  let siblingAborted = false;
  await assert.rejects(
    () =>
      collector.collectHostedEvidenceSources(
        [
          async () => {
            await Promise.resolve();
            throw new Error("fixture source failure");
          },
          async (signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              const abort = () => {
                siblingAborted = true;
                reject(signal.reason);
              };
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            })
        ],
        control
      ),
    /fixture source failure/
  );
  assert.equal(siblingAborted, true);
  assert.equal(control.signal.aborted, true);
});

test("collector refuses zero budgets and stops before a request-slot overrun", async () => {
  assert.throws(
    () => collector.createHostedEvidenceRequestLedger(0),
    /request-slot cap must be 1/
  );
  assert.throws(
    () => collector.createHostedEvidenceCollectionControl(0),
    /collection deadline must be 1/
  );

  const ledger = collector.createHostedEvidenceRequestLedger(1);
  let calls = 0;
  await assert.rejects(
    () =>
      collector.githubApi(
        "/repos/x/actions/artifacts/1/zip",
        "secret-token",
        100,
        "application/octet-stream",
        async () => {
          calls += 1;
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://pipelines.actions.githubusercontent.com/safe/archive"
            }
          });
        },
        { requestLedger: ledger }
      ),
    /exceeded its 1-request slot cap/
  );
  assert.equal(calls, 1);
  assert.deepEqual(ledger.snapshot(), { used: 1, maximum: 1 });
});

test("collector global deadline aborts a hostile pending request", async () => {
  const control = collector.createHostedEvidenceCollectionControl(1);
  if (!control.signal.aborted) {
    await new Promise<void>((resolve) =>
      control.signal.addEventListener("abort", () => resolve(), { once: true })
    );
  }
  await assert.rejects(
    () =>
      collector.githubApi(
        "/repos/x/actions/runs/1",
        "secret-token",
        100,
        "application/vnd.github+json",
        async (_url: unknown, init: RequestInit) => {
          assert.equal(init.signal?.aborted, true);
          throw init.signal?.reason;
        },
        { overallSignal: control.signal }
      ),
    /timeout/i
  );
});

test("collector deadline uses its fixed clock even before the timeout event is delivered", async () => {
  let now = 1_000;
  const dormantDeadline = new AbortController();
  const control = collector.createHostedEvidenceCollectionControl(10, {
    now: () => now,
    deadlineSignal: dormantDeadline.signal
  });
  assert.equal(control.signal.aborted, false);
  await assert.rejects(
    collector.collectHostedEvidenceSources(
      [async () => {
        now = 1_010;
        return "late";
      }],
      control
    ),
    /deadline expired before source collection completion/
  );
  assert.equal(dormantDeadline.signal.aborted, false);

  now = 2_000;
  const requestControl = collector.createHostedEvidenceCollectionControl(10, {
    now: () => now,
    deadlineSignal: new AbortController().signal
  });
  now = 2_010;
  let fetches = 0;
  await assert.rejects(
    collector.githubApi(
      "/repos/x/actions/runs/1",
      "secret-token",
      100,
      "application/vnd.github+json",
      async () => {
        fetches += 1;
        return new Response("{}");
      },
      {
        overallSignal: requestControl.signal,
        assertActive: (phase: string) => requestControl.assertActive(phase)
      }
    ),
    /deadline expired before provider request/
  );
  assert.equal(fetches, 0);
});

test("collector policy bounds redirect hops and honors the overall collection signal", async () => {
  let redirectCalls = 0;
  await assert.rejects(
    () =>
      collector.githubApi(
        "/repos/x/actions/artifacts/1/zip",
        "secret-token",
        100,
        "application/octet-stream",
        async () => {
          redirectCalls += 1;
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://pipelines.actions.githubusercontent.com/safe/archive"
            }
          });
        },
        { maximumArtifactRedirects: 1 }
      ),
    /exceeded redirect bound/
  );
  assert.equal(redirectCalls, 2);

  const cancelled = new AbortController();
  cancelled.abort(new Error("fixture collection deadline"));
  await assert.rejects(
    () =>
      collector.githubApi(
        "/repos/x/actions/runs/1",
        "secret-token",
        100,
        "application/vnd.github+json",
        async (_url: unknown, init: RequestInit) => {
          assert.equal(init.signal?.aborted, true);
          throw init.signal?.reason;
        },
        { overallSignal: cancelled.signal }
      ),
    /fixture collection deadline/
  );
});

test("collector body retention stays bounded across many empty and one-byte chunks", async () => {
  const emptyChunkCount = 50_000;
  const expectedBytes = 256;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls < emptyChunkCount) {
          pulls += 1;
          controller.enqueue(new Uint8Array());
          return;
        }
        if (pulls < emptyChunkCount + expectedBytes) {
          pulls += 1;
          controller.enqueue(Uint8Array.of(120));
          return;
        }
        controller.close();
      }
    },
    { highWaterMark: 0 }
  );

  const bytes = await collector.githubApi(
    "/repos/x/actions/runs/1",
    "secret-token",
    expectedBytes,
    "application/octet-stream",
    async () => new Response(body)
  );
  assert.equal(bytes.toString("utf8"), "x".repeat(expectedBytes));
  assert.equal(pulls, emptyChunkCount + expectedBytes);
});

test("collector bounds decoded encoded bodies without trusting wire Content-Length", async () => {
  const decoded = Buffer.from("x".repeat(1024));
  const wire = gzipSync(decoded);
  assert.notEqual(wire.byteLength, decoded.byteLength);
  const bytes = await collector.githubApi(
    "/repos/x/actions/artifacts/1/zip",
    "secret-token",
    decoded.byteLength,
    "application/octet-stream",
    async () =>
      new Response(decoded, {
        headers: {
          "content-encoding": "gzip",
          "content-length": String(wire.byteLength)
        }
      })
  );
  assert.deepEqual(bytes, decoded);

  await assert.rejects(
    () =>
      collector.githubApi(
        "/repos/x/actions/artifacts/2/zip",
        "secret-token",
        decoded.byteLength - 1,
        "application/octet-stream",
        async () =>
          new Response(decoded, {
            headers: {
              "content-encoding": "br",
              "content-length": "1"
            }
          })
      ),
    /exceeds its byte bound/
  );
});

test("collector cleanup cannot hold open or mask a body-size refusal", async () => {
  for (const fixture of [
    {
      maximumBytes: 1,
      headers: new Headers(),
      expected: /exceeds its byte bound/
    },
    {
      maximumBytes: 3,
      headers: new Headers({ "content-length": "1" }),
      expected: /body length changed in transit/
    }
  ]) {
    let cancelled = false;
    const reader = {
      async read() {
        return { done: false, value: Uint8Array.of(120, 121) };
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
      releaseLock() {
        throw new Error("fixture releaseLock failure");
      }
    };
    const response = {
      status: 200,
      ok: true,
      headers: fixture.headers,
      body: { getReader: () => reader }
    };

    await assert.rejects(
      settleWithin(
        collector.githubApi(
          "/repos/x/actions/runs/1",
          "secret-token",
          fixture.maximumBytes,
          "application/octet-stream",
          async () => response as any
        )
      ),
      fixture.expected
    );
    assert.equal(cancelled, true);
  }
});

test("collector bounded reader refuses final symlinks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sbl-hosted-read-"));
  const target = path.join(root, "target.json");
  const link = path.join(root, "link.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, link);
  assert.throws(
    () => collector.readBoundedNoFollow(link, 100, "fixture"),
    /ELOOP|symbolic|bounded regular file/
  );
});

async function settleWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("collector body refusal did not settle")),
          1_000
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("durable soak monitor CLI rejects hostile dispatch values before collection", () => {
  const base = [
    "--start-at",
    "2026-08-01T00:00:00.000Z",
    "--end-at",
    "2026-08-02T00:10:00.000Z",
    "--restart-run-id",
    "123",
    "--restart-run-attempt",
    "1",
    "--restart-artifact-id",
    "456",
    "--output",
    "/tmp/durable-soak-ledger-fixture"
  ];
  assert.doesNotThrow(() => soakCollector.parseOptions(base));
  for (const [index, hostile] of [
    [1, '2026-08-01T00:00:00.000Z"; touch /tmp/pwn'],
    [5, "1; echo pwn"],
    [9, "456$(id)"]
  ]) {
    const args = [...base];
    args[index] = hostile;
    assert.throws(
      () => soakCollector.parseOptions(args),
      /must be/
    );
  }
});

test("trusted workflow scaffolds preserve exact privacy and provenance boundaries", () => {
  const archiveWorkflow = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/archive-hosted-evidence.yml"
    ),
    "utf8"
  );
  assert.match(archiveWorkflow, /runner\.environment/);
  assert.match(archiveWorkflow, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);
  assert.match(archiveWorkflow, /context\.sigstore\.json/);
  assert.match(archiveWorkflow, /67108864/);
  assert.match(archiveWorkflow, /automation\/hosted-evidence-.*run_id/);
  const archiveTimeoutMinutes = Number(
    archiveWorkflow.match(/timeout-minutes:\s*(\d+)/)?.[1]
  );
  assert.equal(
    archiveTimeoutMinutes,
    collector.HOSTED_EVIDENCE_WORKFLOW_TIMEOUT_MINUTES
  );
  assert.ok(
    archiveTimeoutMinutes * 60_000 >=
      collector.HOSTED_EVIDENCE_COLLECTION_DEADLINE_MS +
        collector.HOSTED_EVIDENCE_WORKFLOW_NON_COLLECTION_RESERVE_MS,
    "archive job timeout must cover the global collector deadline plus non-collection reserve"
  );
  const runBlockText: string[] = [];
  const workflowLines = archiveWorkflow.split(/\r?\n/);
  let runIndent: number | null = null;
  for (const line of workflowLines) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (
      runIndent !== null &&
      line.trim().length > 0 &&
      indentation <= runIndent
    ) {
      runIndent = null;
    }
    const runStart = line.match(/^(\s*)run:\s*(?:\||>-|.+)$/);
    if (runStart) runIndent = runStart[1].length;
    if (runIndent !== null) runBlockText.push(line);
  }
  assert.doesNotMatch(
    runBlockText.join("\n"),
    /\$\{\{\s*inputs\.(?:profile|subject_(?:path|commit))\s*\}\}/,
    "dispatch inputs must enter shell steps only through quoted environment variables"
  );
  assert.match(
    archiveWorkflow,
    /HOSTED_PROFILE: \$\{\{ inputs\.profile \}\}[\s\S]*SUBJECT_PATH: \$\{\{ inputs\.subject_path \}\}[\s\S]*SUBJECT_COMMIT: \$\{\{ inputs\.subject_commit \}\}/
  );

  const stagingWorkflow = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/staging-teardown-evidence.yml"
    ),
    "utf8"
  );
  assert.match(stagingWorkflow, /sanitized-provider-manifest\.json/);
  assert.doesNotMatch(stagingWorkflow, /provider-transcript\.json/);

  const restartWorkflow = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/durable-soak-restart.yml"
    ),
    "utf8"
  );
  assert.match(
    restartWorkflow,
    /Restart runtime and prove queued work recovery/
  );
  assert.match(restartWorkflow, /queued-work-recovery\.json/);

  const monitorWorkflow = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/durable-soak-monitor.yml"
    ),
    "utf8"
  );
  assert.match(
    monitorWorkflow,
    /Aggregate authenticated hourly durable health/
  );
  assert.match(
    monitorWorkflow,
    /site-behavior-durable-soak-ledger-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  const monitorCollect = monitorWorkflow.slice(
    monitorWorkflow.indexOf(
      "- name: Collect and rederive the bounded hourly ledger"
    ),
    monitorWorkflow.indexOf(
      "- name: Preserve canonical ledger",
      monitorWorkflow.indexOf(
        "- name: Collect and rederive the bounded hourly ledger"
      )
    )
  );
  for (const variable of [
    "SOAK_START_AT",
    "SOAK_END_AT",
    "RESTART_RUN_ID",
    "RESTART_RUN_ATTEMPT",
    "RESTART_ARTIFACT_ID"
  ]) {
    assert.match(monitorCollect, new RegExp(`${variable}:`));
    assert.equal(
      monitorCollect.includes(`"$${variable}"`),
      true,
      variable
    );
  }
  const monitorRun = monitorCollect.slice(
    monitorCollect.indexOf("run: |")
  );
  assert.doesNotMatch(monitorRun, /\$\{\{\s*inputs\./);

  const exerciseWorkflow = readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/durable-soak-exercises.yml"
    ),
    "utf8"
  );
  assert.match(
    exerciseWorkflow,
    /Exercise durable completion, cancellation, and recovery/
  );
  assert.match(
    exerciseWorkflow,
    /site-behavior-durable-soak-exercises-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.doesNotMatch(
    exerciseWorkflow,
    /evidence_(?:json|path)|receipt_(?:json|path)/
  );

  const controlledParser = readFileSync(
    path.join(
      process.cwd(),
      "scripts",
      "controlled-publication-receipt-lib.mjs"
    ),
    "utf8"
  );
  const compileStart = controlledParser.indexOf(
    "function ensureTrustedArchiveParser"
  );
  const extractStart = controlledParser.indexOf(
    "function extractAuthenticatedPublicationArchive",
    compileStart
  );
  const compileContract = controlledParser.slice(
    compileStart,
    extractStart
  );
  assert.match(compileContract, /tsconfig\.schema\.json/);
  assert.match(compileContract, /timeout: 60_000/);
  assert.doesNotMatch(
    compileContract,
    /SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY/
  );
});

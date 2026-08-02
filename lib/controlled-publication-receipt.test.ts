import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

type ControlledPublicationModule = {
  canonicalControlledPublicationReceiptText: (receipt: unknown) => string;
  createControlledPublicationArchive: (input: Record<string, unknown>) => {
    outputDirectory: string;
    relativePath: string;
    receipt: ControlledReceipt;
    receiptSha256: string;
    manifestSha256: string;
  };
  parseAndVerifyControlledPublicationReceipt: (
    text: string,
    options?: Record<string, unknown>
  ) => { ok: boolean; issues: string[]; receipt: ControlledReceipt | null };
  sha256Hex: (value: string | Buffer) => string;
  verifyControlledPublicationDirectory: (
    input: Record<string, unknown>
  ) => {
    receipt: ControlledReceipt;
    receiptSha256: string;
    manifestSha256: string;
  };
  verifyControlledPublicationArtifact: (
    input: Record<string, unknown>
  ) => {
    receipt: ControlledReceipt;
    archiveSha256: string;
    manifestSha256: string;
  };
};

type ControlledReceipt = {
  schemaVersion: number;
  artifactKind: string;
  publicationKind: string;
  reportMode: string;
  actionsRun: { id: number; attempt: number; sourceCommit: string };
  publicationArtifact: {
    id: number;
    name: string;
    archiveSha256: string;
    manifestSha256: string;
  };
  reports: Array<{
    id: string;
    reportPath: string;
    reportSha256: string;
    provenancePath: string;
    provenanceSha256: string;
  }>;
};

type Fixture = {
  root: string;
  checkoutRoot: string;
  artifactDir: string;
  metadataPath: string;
  archivePath: string;
  outputDirectory: string;
  publicationBytes: Buffer;
  sourceCommit: string;
  runId: number;
  runAttempt: number;
  artifactId: number;
  artifactName: string;
  artifactDigest: string;
  reportIds: string[];
};

const roots = new Set<string>();
const REPORT_IDS = [
  `20260801-${"1".repeat(32)}`,
  `20260802-${"2".repeat(32)}`
];
const nativeImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<ControlledPublicationModule>;

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function controlledModule(): Promise<ControlledPublicationModule> {
  return nativeImport(
    pathToFileURL(
      path.join(
        process.cwd(),
        "scripts",
        "controlled-publication-receipt-lib.mjs"
      )
    ).href
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildStoredZip(
  entries: ReadonlyArray<{ name: string; data: Buffer }>
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    const localRecord = Buffer.concat([local, name, entry.data]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([central, name]));
    localOffset += localRecord.byteLength;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(localBytes.byteLength, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) !== 0
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum =
      CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function makeFixture(label: string): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), `sbl-controlled-${label}-`));
  roots.add(root);
  const checkoutRoot = path.join(root, "checkout");
  const artifactDir = path.join(root, "artifact");
  const reportsDir = path.join(checkoutRoot, "public", "reports");
  const artifactReportsDir = path.join(artifactDir, "reports");
  mkdirSync(path.join(checkoutRoot, "research"), { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(artifactReportsDir, { recursive: true });

  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const id of REPORT_IDS) {
    const report = Buffer.from(
      `${JSON.stringify({ id, kind: "controlled-r2-report" })}\n`
    );
    const provenance = Buffer.from(
      `${JSON.stringify({ reportId: id, source: "controlled-runner" })}\n`
    );
    for (const [relative, contents] of [
      [`reports/${id}.json`, report],
      [`reports/${id}.provenance.json`, provenance]
    ] as const) {
      writeFileSync(
        path.join(artifactDir, ...relative.split("/")),
        contents
      );
      writeFileSync(
        path.join(checkoutRoot, "public", ...relative.split("/")),
        contents
      );
      files.push({
        path: relative,
        bytes: contents.byteLength,
        sha256: sha256(contents)
      });
    }
  }
  for (const [relative, contents] of [
    ["corpus-stats.json", Buffer.from('{"sampleSize":2}\n')],
    ["reports/index.json", Buffer.from('{"reports":[]}\n')]
  ] as const) {
    writeFileSync(path.join(artifactDir, ...relative.split("/")), contents);
    files.push({
      path: relative,
      bytes: contents.byteLength,
      sha256: sha256(contents)
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const sourceCommit = "a".repeat(40);
  const runId = 30600000001;
  const runAttempt = 2;
  const artifactId = 8760000001;
  const artifactName =
    `site-behavior-featured-publication-${runId}-${runAttempt}`;
  const manifest = {
    schemaVersion: 1,
    sourceCommit,
    publicationKind: "featured",
    reportMode: "r2",
    expectedReportIds: [...REPORT_IDS],
    files
  };
  const publicationBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  writeFileSync(path.join(artifactDir, "publication.json"), publicationBytes);

  const archive = buildStoredZip([
    { name: "publication.json", data: publicationBytes },
    ...files.map((entry) => ({
      name: entry.path,
      data: readFileSync(path.join(artifactDir, ...entry.path.split("/")))
    }))
  ]);
  const archivePath = path.join(root, "publication.zip");
  writeFileSync(archivePath, archive);
  const artifactDigest = sha256(archive);
  const metadataPath = path.join(root, "metadata.json");
  writeFileSync(
    metadataPath,
    `${JSON.stringify({
      total_count: 1,
      artifacts: [
        {
          id: artifactId,
          name: artifactName,
          expired: false,
          size_in_bytes: archive.byteLength,
          digest: `sha256:${artifactDigest}`,
          workflow_run: { id: runId, head_sha: sourceCommit }
        }
      ]
    })}\n`
  );
  return {
    root,
    checkoutRoot,
    artifactDir,
    metadataPath,
    archivePath,
    outputDirectory: path.join(
      checkoutRoot,
      "research",
      "controlled-publications",
      `${runId}-${runAttempt}`
    ),
    publicationBytes,
    sourceCommit,
    runId,
    runAttempt,
    artifactId,
    artifactName,
    artifactDigest,
    reportIds: [...REPORT_IDS]
  };
}

function createInput(fixture: Fixture): Record<string, unknown> {
  return {
    checkoutRoot: fixture.checkoutRoot,
    metadataPath: fixture.metadataPath,
    archivePath: fixture.archivePath,
    artifactId: fixture.artifactId,
    artifactName: fixture.artifactName,
    artifactDigest: fixture.artifactDigest,
    runId: fixture.runId,
    sourceCommit: fixture.sourceCommit,
    outputDirectory: fixture.outputDirectory
  };
}

function rebuildAuthenticatedArchive(fixture: Fixture): void {
  const manifest = JSON.parse(
    readFileSync(path.join(fixture.artifactDir, "publication.json"), "utf8")
  ) as { files: Array<{ path: string }> };
  const publicationBytes = readFileSync(
    path.join(fixture.artifactDir, "publication.json")
  );
  const archive = buildStoredZip([
    { name: "publication.json", data: publicationBytes },
    ...manifest.files.map((entry) => ({
      name: entry.path,
      data: readFileSync(
        path.join(fixture.artifactDir, ...entry.path.split("/"))
      )
    }))
  ]);
  writeFileSync(fixture.archivePath, archive);
  fixture.artifactDigest = sha256(archive);
  writeFileSync(
    fixture.metadataPath,
    `${JSON.stringify({
      total_count: 1,
      artifacts: [
        {
          id: fixture.artifactId,
          name: fixture.artifactName,
          expired: false,
          size_in_bytes: archive.byteLength,
          digest: `sha256:${fixture.artifactDigest}`,
          workflow_run: {
            id: fixture.runId,
            head_sha: fixture.sourceCommit
          }
        }
      ]
    })}\n`
  );
}

function verifyInput(fixture: Fixture): Record<string, unknown> {
  return {
    checkoutRoot: fixture.checkoutRoot,
    directory: fixture.outputDirectory,
    runId: fixture.runId,
    runAttempt: fixture.runAttempt,
    sourceCommit: fixture.sourceCommit,
    artifactId: fixture.artifactId,
    archiveSha256: fixture.artifactDigest
  };
}

test("archives exact publication bytes and a canonical cross-binding receipt", async () => {
  const fixture = makeFixture("create");
  const module = await controlledModule();
  const created = module.createControlledPublicationArchive(
    createInput(fixture)
  );

  assert.equal(
    created.relativePath,
    `research/controlled-publications/${fixture.runId}-${fixture.runAttempt}`
  );
  assert.deepEqual(
    readFileSync(path.join(created.outputDirectory, "publication.json")),
    fixture.publicationBytes
  );
  assert.deepEqual(created.receipt, {
    schemaVersion: 1,
    artifactKind: "site-behavior-controlled-r2-publication-receipt",
    publicationKind: "featured",
    reportMode: "r2",
    actionsRun: {
      id: fixture.runId,
      attempt: fixture.runAttempt,
      sourceCommit: fixture.sourceCommit
    },
    publicationArtifact: {
      id: fixture.artifactId,
      name: fixture.artifactName,
      archiveSha256: fixture.artifactDigest,
      manifestSha256: sha256(fixture.publicationBytes)
    },
    reports: fixture.reportIds.map((id) => ({
      id,
      reportPath: `public/reports/${id}.json`,
      reportSha256: sha256(
        readFileSync(path.join(fixture.checkoutRoot, "public", "reports", `${id}.json`))
      ),
      provenancePath: `public/reports/${id}.provenance.json`,
      provenanceSha256: sha256(
        readFileSync(
          path.join(
            fixture.checkoutRoot,
            "public",
            "reports",
            `${id}.provenance.json`
          )
        )
      )
    }))
  });
  const receiptText = readFileSync(
    path.join(created.outputDirectory, "receipt.json"),
    "utf8"
  );
  assert.equal(
    receiptText,
    module.canonicalControlledPublicationReceiptText(created.receipt)
  );
  assert.equal(created.receiptSha256, sha256(receiptText));

  const verified = module.verifyControlledPublicationDirectory(
    verifyInput(fixture)
  );
  assert.deepEqual(verified.receipt, created.receipt);
  assert.equal(verified.manifestSha256, sha256(fixture.publicationBytes));
  const rawVerified = module.verifyControlledPublicationArtifact({
    checkoutRoot: fixture.checkoutRoot,
    metadataPath: fixture.metadataPath,
    archivePath: fixture.archivePath,
    receipt: created.receipt
  });
  assert.equal(rawVerified.archiveSha256, fixture.artifactDigest);
  assert.equal(
    rawVerified.manifestSha256,
    sha256(fixture.publicationBytes)
  );

  const unrelatedReceipt = structuredClone(created.receipt);
  unrelatedReceipt.publicationArtifact.archiveSha256 = "0".repeat(64);
  assert.throws(
    () =>
      module.verifyControlledPublicationArtifact({
        checkoutRoot: fixture.checkoutRoot,
        metadataPath: fixture.metadataPath,
        archivePath: fixture.archivePath,
        receipt: unrelatedReceipt
      }),
    /trusted publication archive extraction failed/
  );
});

test("derives acquisition attempt from artifact identity and rejects metadata or file drift", async () => {
  const fixture = makeFixture("binding");
  const module = await controlledModule();

  assert.throws(
    () =>
      module.createControlledPublicationArchive({
        ...createInput(fixture),
        artifactName:
          `site-behavior-featured-publication-${fixture.runId}-3`
      }),
    /trusted publication archive extraction failed.*metadata did not identify exactly/i
  );

  const metadata = JSON.parse(
    readFileSync(fixture.metadataPath, "utf8")
  ) as { artifacts: Array<{ size_in_bytes: number }> };
  metadata.artifacts[0].size_in_bytes += 1;
  writeFileSync(fixture.metadataPath, `${JSON.stringify(metadata)}\n`);
  assert.throws(
    () => module.createControlledPublicationArchive(createInput(fixture)),
    /trusted publication archive extraction failed.*archive size differs/i
  );
});

test("rejects expected report sets without exact declared and committed digest pairs", async () => {
  const fixture = makeFixture("reports");
  const module = await controlledModule();
  const manifestPath = path.join(fixture.artifactDir, "publication.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    expectedReportIds: string[];
  };
  manifest.expectedReportIds.push(`20260803-${"3".repeat(32)}`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  rebuildAuthenticatedArchive(fixture);
  assert.throws(
    () => module.createControlledPublicationArchive(createInput(fixture)),
    /missing the expected report pair/
  );

  const second = makeFixture("published-drift");
  writeFileSync(
    path.join(
      second.checkoutRoot,
      "public",
      "reports",
      `${second.reportIds[0]}.json`
    ),
    '{"tampered":true}\n'
  );
  assert.throws(
    () => module.createControlledPublicationArchive(createInput(second)),
    /published report .* differs from the validated artifact/
  );

  const alternateOrder = makeFixture("manifest-order");
  const alternateManifest = JSON.parse(
    readFileSync(
      path.join(alternateOrder.artifactDir, "publication.json"),
      "utf8"
    )
  ) as Record<string, unknown>;
  writeFileSync(
    path.join(alternateOrder.artifactDir, "publication.json"),
    `${JSON.stringify(
      {
        sourceCommit: alternateManifest.sourceCommit,
        schemaVersion: alternateManifest.schemaVersion,
        publicationKind: alternateManifest.publicationKind,
        reportMode: alternateManifest.reportMode,
        expectedReportIds: alternateManifest.expectedReportIds,
        files: alternateManifest.files
      },
      null,
      2
    )}\n`
  );
  rebuildAuthenticatedArchive(alternateOrder);
  assert.throws(
    () =>
      module.createControlledPublicationArchive(createInput(alternateOrder)),
    /not canonical acquisition JSON/
  );
});

test("verification refuses non-canonical, unknown, tampered, or extra archive content", async () => {
  const fixture = makeFixture("verify");
  const module = await controlledModule();
  module.createControlledPublicationArchive(createInput(fixture));
  const receiptPath = path.join(fixture.outputDirectory, "receipt.json");
  const receipt = JSON.parse(
    readFileSync(receiptPath, "utf8")
  ) as ControlledReceipt & { unexpected?: boolean };
  receipt.unexpected = true;
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 4)}\n`);
  assert.throws(
    () => module.verifyControlledPublicationDirectory(verifyInput(fixture)),
    /canonical|exactly/
  );

  const extra = makeFixture("extra");
  module.createControlledPublicationArchive(createInput(extra));
  writeFileSync(path.join(extra.outputDirectory, "notes.txt"), "forbidden\n");
  assert.throws(
    () => module.verifyControlledPublicationDirectory(verifyInput(extra)),
    /must contain exactly publication\.json and receipt\.json/
  );

  const committedDrift = makeFixture("verify-drift");
  const committedCreated = module.createControlledPublicationArchive(
    createInput(committedDrift)
  );
  writeFileSync(
    path.join(
      committedDrift.checkoutRoot,
      "public",
      "reports",
      `${committedDrift.reportIds[1]}.provenance.json`
    ),
    '{"tampered":true}\n'
  );
  assert.throws(
    () =>
      module.verifyControlledPublicationDirectory(
        verifyInput(committedDrift)
      ),
    /published provenance .* differs from the validated artifact/
  );

  const malformed = module.parseAndVerifyControlledPublicationReceipt(
    module.canonicalControlledPublicationReceiptText({
      ...committedCreated.receipt,
      reports: [null]
    }),
    { expectedReportIds: committedDrift.reportIds }
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.issues.join("; "), /reports\[0\] must be an object/);
});

test("the create-only run directory and strict CLI reject reuse and ambiguous arguments", async () => {
  const fixture = makeFixture("cli");
  const module = await controlledModule();
  module.createControlledPublicationArchive(createInput(fixture));
  assert.throws(
    () => module.createControlledPublicationArchive(createInput(fixture)),
    /EEXIST/
  );

  const fresh = makeFixture("cli-create");
  const cli = path.join(
    process.cwd(),
    "scripts",
    "controlled-publication-receipt.mjs"
  );
  const created = spawnSync(
    process.execPath,
    [
      cli,
      "--create",
      "--checkout-root",
      fresh.checkoutRoot,
      "--metadata",
      fresh.metadataPath,
      "--archive",
      fresh.archivePath,
      "--artifact-id",
      String(fresh.artifactId),
      "--artifact-name",
      fresh.artifactName,
      "--artifact-digest",
      fresh.artifactDigest,
      "--run-id",
      String(fresh.runId),
      "--source-commit",
      fresh.sourceCommit,
      "--output-dir",
      fresh.outputDirectory
    ],
    { encoding: "utf8" }
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).relativePath,
    `research/controlled-publications/${fresh.runId}-${fresh.runAttempt}`);

  const verified = spawnSync(
    process.execPath,
    [
      cli,
      "--verify",
      "--checkout-root",
      fresh.checkoutRoot,
      "--directory",
      fresh.outputDirectory,
      "--run-id",
      String(fresh.runId),
      "--run-attempt",
      String(fresh.runAttempt),
      "--source-commit",
      fresh.sourceCommit,
      "--artifact-id",
      String(fresh.artifactId),
      "--archive-digest",
      fresh.artifactDigest
    ],
    { encoding: "utf8" }
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).ok, true);

  const ambiguous = spawnSync(
    process.execPath,
    [cli, "--verify", "--verify"],
    { encoding: "utf8" }
  );
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /choose exactly one/);
});

test("a caller-supplied fake extraction cannot influence authenticated bytes", async () => {
  const fixture = makeFixture("fake-directory");
  const module = await controlledModule();
  writeFileSync(
    path.join(fixture.artifactDir, "publication.json"),
    '{"callerControlled":true}\n'
  );
  writeFileSync(
    path.join(
      fixture.artifactDir,
      "reports",
      `${fixture.reportIds[0]}.json`
    ),
    '{"callerControlled":true}\n'
  );

  assert.throws(
    () =>
      module.createControlledPublicationArchive({
        ...createInput(fixture),
        artifactDir: fixture.artifactDir
      }),
    /create input must contain exactly/
  );
  const created = module.createControlledPublicationArchive(
    createInput(fixture)
  );
  assert.deepEqual(
    readFileSync(path.join(created.outputDirectory, "publication.json")),
    fixture.publicationBytes
  );

  const cli = path.join(
    process.cwd(),
    "scripts",
    "controlled-publication-receipt.mjs"
  );
  const rejected = spawnSync(
    process.execPath,
    [
      cli,
      "--create",
      "--artifact-dir",
      fixture.artifactDir
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unknown argument: --artifact-dir/);
});

test("the featured publisher archives and stages only exact freeze-time r2 bindings", () => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"),
    "utf8"
  );
  const archiveStart = workflow.indexOf(
    "- name: Archive exact controlled-r2 publication binding"
  );
  const retentionStart = workflow.indexOf(
    "- name: Apply retention policy and rebuild trusted aggregate outputs"
  );
  assert.ok(archiveStart > 0 && archiveStart < retentionStart);
  const archiveStep = workflow.slice(archiveStart, retentionStart);
  assert.match(
    archiveStep,
    /env\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE == '1' &&\s+env\.FEATURED_REPORT_MODE == 'r2'/
  );
  assert.match(
    archiveStep,
    /artifact_prefix="site-behavior-featured-publication-\$\{GITHUB_RUN_ID\}-"/
  );
  assert.doesNotMatch(archiveStep, /GITHUB_RUN_ATTEMPT/);
  assert.match(
    archiveStep,
    /relative_path="research\/controlled-publications\/\$\{GITHUB_RUN_ID\}-\$\{artifact_attempt\}"/
  );
  for (const required of [
    "--metadata \"$RUNNER_TEMP/report-publication-metadata.json\"",
    "--archive \"$RUNNER_TEMP/report-publication.zip\"",
    "--artifact-id \"$ARTIFACT_ID\"",
    "--artifact-name \"$ARTIFACT_NAME\"",
    "--artifact-digest \"$ARTIFACT_DIGEST\"",
    "--source-commit \"$GITHUB_SHA\""
  ]) {
    assert.ok(archiveStep.includes(required), required);
  }
  assert.doesNotMatch(archiveStep, /--artifact-dir\b/);
  assert.match(archiveStep, /--create[\s\S]*--verify/);

  const commitStart = workflow.indexOf("- name: Commit static reports");
  const commitEnd = workflow.indexOf(
    "# The validated tree becomes a reviewed automation/* proposal",
    commitStart
  );
  const commit = workflow.slice(commitStart, commitEnd);
  assert.match(
    commit,
    /CONTROLLED_PUBLICATION_PATH: \$\{\{ steps\.controlled_publication\.outputs\.relative_path \}\}/
  );
  assert.match(
    commit,
    /if \[\[ "\$SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE" == "1" && "\$FEATURED_REPORT_MODE" == "r2" \]\]/
  );
  assert.match(commit, /git add -- "\$CONTROLLED_PUBLICATION_PATH"/);
  assert.doesNotMatch(commit, /git add (?:-- )?research\/controlled-publications\b/);

  const rollout = readFileSync(
    path.join(process.cwd(), "docs", "featured-corpus-r2-rollout.md"),
    "utf8"
  );
  assert.match(rollout, /Freeze-time publication cross-binding/);
  assert.match(
    rollout,
    /publication\.json` is the\s+byte-for-byte manifest extracted/
  );
  assert.match(rollout, /attempt is deliberately parsed from the immutable\s+artifact name/);
  assert.match(rollout, /reports:controlled-publication-receipt --/);

  const activation = readFileSync(
    path.join(process.cwd(), "docs", "measurement-freeze-activation.md"),
    "utf8"
  );
  assert.match(
    activation,
    /research\/controlled-publications\/<actions-run-id>-<acquisition-attempt>/
  );
  assert.match(activation, /freeze-time r2 proposal without it is\s+refused/);
});

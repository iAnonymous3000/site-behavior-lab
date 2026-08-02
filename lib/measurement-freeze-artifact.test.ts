import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
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

const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const WORKFLOW = ".github/workflows/activate-measurement-freeze.yml";
const RUN_ID = 30_700_000_001;
const RUN_ATTEMPT = 2;
const CANDIDATE = "a".repeat(40);
const ARTIFACT_ID = 4_700_000_001;
const ARTIFACT_NAME =
  `measurement-freeze-activation-${RUN_ID}-${RUN_ATTEMPT}`;
const RECEIPT_FILE = "measurement-freeze-activation-receipt.json";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function buildZip(
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

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptFixture() {
  const receipt = {
    repository: {
      fullName: REPOSITORY,
      defaultBranch: "main"
    },
    candidate: {
      commit: CANDIDATE
    },
    activation: {
      workflow: WORKFLOW,
      event: "workflow_dispatch",
      headSha: CANDIDATE,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT
    },
    handoff: {
      artifactName: ARTIFACT_NAME,
      receiptFile: RECEIPT_FILE
    }
  };
  return {
    receipt,
    receiptBytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
  };
}

function recordsFor(archive: Buffer, options: {
  expired?: boolean;
  digest?: string;
  duplicate?: boolean;
} = {}) {
  const digest = options.digest ?? sha256(archive);
  const artifact = {
    id: ARTIFACT_ID,
    name: ARTIFACT_NAME,
    expired: options.expired ?? false,
    size_in_bytes: archive.byteLength,
    digest: `sha256:${digest}`,
    workflow_run: {
      id: RUN_ID,
      head_branch: "main",
      head_sha: CANDIDATE
    }
  };
  const listed = [structuredClone(artifact)];
  if (options.duplicate) {
    listed.push({
      ...structuredClone(artifact),
      id: ARTIFACT_ID + 1
    });
  }
  return {
    run: {
      id: RUN_ID,
      run_attempt: RUN_ATTEMPT,
      event: "workflow_dispatch",
      path: WORKFLOW,
      head_branch: "main",
      head_sha: CANDIDATE,
      html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      status: "completed",
      conclusion: "success"
    },
    pages: [{ total_count: listed.length, artifacts: listed }],
    artifact
  };
}

function writeContext(
  directory: string,
  archive: Buffer,
  records = recordsFor(archive)
) {
  mkdirSync(directory);
  const files = {
    "run.json": Buffer.from(JSON.stringify(records.run)),
    "artifacts-pages.json": Buffer.from(JSON.stringify(records.pages)),
    "artifact.json": Buffer.from(JSON.stringify(records.artifact)),
    "artifact.zip": archive
  };
  for (const [filename, bytes] of Object.entries(files)) {
    writeFileSync(path.join(directory, filename), bytes);
  }
  return files;
}

function response(value: unknown): Response {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(value));
  return new Response(Uint8Array.from(bytes).buffer, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) }
  });
}

test("trusted live fetch and bounded offline context verify the same immutable activation artifact", async (t) => {
  const module = await script("measurement-freeze-artifact-lib.mjs");
  const fixture = receiptFixture();
  const archive = buildZip([
    { name: RECEIPT_FILE, data: fixture.receiptBytes }
  ]);
  const records = recordsFor(archive);
  const routes = new Map<string, unknown>([
    [`/repos/${REPOSITORY}/actions/runs/${RUN_ID}`, records.run],
    [
      `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100&page=1`,
      records.pages[0]
    ],
    [
      `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}`,
      records.artifact
    ],
    [
      `/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`,
      archive
    ]
  ]);
  const fetchImpl = async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const value = routes.get(`${url.pathname}${url.search}`);
    assert.notEqual(value, undefined, `unexpected URL ${url.href}`);
    return response(value);
  };
  const live = await module.verifyMeasurementFreezeActivationArtifactLive({
    ...fixture,
    token: "read-only-test-token",
    fetchImpl
  });
  assert.equal(live.artifactId, ARTIFACT_ID);
  assert.equal(live.artifactSha256, sha256(archive));

  const root = mkdtempSync(path.join(tmpdir(), "sbl-freeze-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = path.join(root, "context");
  const contextFiles = writeContext(contextDirectory, archive, records);
  const offline =
    module.verifyMeasurementFreezeActivationArtifactContext({
      ...fixture,
      contextDirectory,
      expectedContextSha256:
        module.measurementFreezeArtifactContextSha256(contextFiles)
    });
  const {
    contextSha256,
    ...offlineArtifact
  } = offline;
  assert.equal(
    contextSha256,
    module.measurementFreezeArtifactContextSha256(contextFiles)
  );
  assert.deepEqual(offlineArtifact, live);
});

test("offline context rejects a substituted receipt even when its ZIP digest and metadata agree", async (t) => {
  const module = await script("measurement-freeze-artifact-lib.mjs");
  const fixture = receiptFixture();
  const substituted = Buffer.from(
    fixture.receiptBytes.toString("utf8").replace(CANDIDATE, "b".repeat(40))
  );
  const archive = buildZip([{ name: RECEIPT_FILE, data: substituted }]);
  const root = mkdtempSync(path.join(tmpdir(), "sbl-freeze-substitute-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = path.join(root, "context");
  const contextFiles = writeContext(contextDirectory, archive);
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(contextFiles)
      }),
    /do not match the committed carrier receipt/
  );
});

test("offline context refuses expired, duplicate, and oversized matching artifacts", async (t) => {
  const module = await script("measurement-freeze-artifact-lib.mjs");
  const fixture = receiptFixture();
  const archive = buildZip([
    { name: RECEIPT_FILE, data: fixture.receiptBytes }
  ]);
  const root = mkdtempSync(path.join(tmpdir(), "sbl-freeze-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const expiredDirectory = path.join(root, "expired");
  const expiredFiles = writeContext(
    expiredDirectory,
    archive,
    recordsFor(archive, { expired: true })
  );
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: expiredDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(expiredFiles)
      }),
    /does not bind the exact activation artifact/
  );

  const duplicateDirectory = path.join(root, "duplicate");
  const duplicateFiles = writeContext(
    duplicateDirectory,
    archive,
    recordsFor(archive, { duplicate: true })
  );
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: duplicateDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(duplicateFiles)
      }),
    /exactly one artifact/
  );

  const oversizedRecords = recordsFor(archive);
  oversizedRecords.pages[0].artifacts[0].size_in_bytes = 1024 * 1024 + 1;
  oversizedRecords.artifact.size_in_bytes = 1024 * 1024 + 1;
  const oversizedDirectory = path.join(root, "oversized");
  const oversizedFiles = writeContext(
    oversizedDirectory,
    archive,
    oversizedRecords
  );
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: oversizedDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(oversizedFiles)
      }),
    /does not bind the exact activation artifact/
  );
});

test("offline context is exact: missing files, extra files, and digest substitution fail", async (t) => {
  const module = await script("measurement-freeze-artifact-lib.mjs");
  const fixture = receiptFixture();
  const archive = buildZip([
    { name: RECEIPT_FILE, data: fixture.receiptBytes }
  ]);
  const root = mkdtempSync(path.join(tmpdir(), "sbl-freeze-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missingDirectory = path.join(root, "missing");
  const missingFiles = writeContext(missingDirectory, archive);
  unlinkSync(path.join(missingDirectory, "artifact.json"));
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: missingDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(missingFiles)
      }),
    /must contain exactly/
  );

  const extraDirectory = path.join(root, "extra");
  const extraFiles = writeContext(extraDirectory, archive);
  writeFileSync(path.join(extraDirectory, "untrusted.json"), "{}");
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: extraDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(extraFiles)
      }),
    /must contain exactly/
  );

  const digestDirectory = path.join(root, "digest");
  const digestFiles = writeContext(
    digestDirectory,
    archive,
    recordsFor(archive, { digest: "f".repeat(64) })
  );
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: digestDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(digestFiles)
      }),
    /ZIP digest does not match metadata/
  );

  const trustDirectory = path.join(root, "trust");
  writeContext(trustDirectory, archive);
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory: trustDirectory,
        expectedContextSha256: "0".repeat(64)
      }),
    /do not match the trusted prefetch digest/
  );
});

test("offline context uses strict single-file ZIP extraction", async (t) => {
  const module = await script("measurement-freeze-artifact-lib.mjs");
  const fixture = receiptFixture();
  const archive = buildZip([
    { name: RECEIPT_FILE, data: fixture.receiptBytes },
    { name: "hidden.json", data: Buffer.from("{}\n") }
  ]);
  const root = mkdtempSync(path.join(tmpdir(), "sbl-freeze-zip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextDirectory = path.join(root, "context");
  const contextFiles = writeContext(contextDirectory, archive);
  assert.throws(
    () =>
      module.verifyMeasurementFreezeActivationArtifactContext({
        ...fixture,
        contextDirectory,
        expectedContextSha256:
          module.measurementFreezeArtifactContextSha256(contextFiles)
      }),
    /artifact ZIP must contain exactly one entry/
  );
});

test("the canonical receipt CLI exposes mutually exclusive trusted-live and offline-context verification", () => {
  const source = readFileSync(
    path.join(
      process.cwd(),
      "scripts",
      "validate-measurement-freeze-activation-receipt.mjs"
    ),
    "utf8"
  );
  assert.match(source, /"--verify-live-artifact"/);
  assert.match(source, /"--live-artifact-context"/);
  assert.match(source, /"--live-artifact-context-sha256"/);
  assert.match(
    source,
    /--verify-live-artifact and --live-artifact-context are mutually exclusive/
  );
  assert.match(
    source,
    /--live-artifact-context and --live-artifact-context-sha256 must be supplied together/
  );
  assert.match(source, /verifyMeasurementFreezeActivationArtifactLive/);
  assert.match(source, /verifyMeasurementFreezeActivationArtifactContext/);
});

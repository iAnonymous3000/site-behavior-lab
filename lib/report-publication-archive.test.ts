import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  extractReportPublicationArchive,
  REPORT_PUBLICATION_ARCHIVE_MAX_BYTES,
  validateGithubReportPublicationArtifactMetadata
} from "./report-publication-archive";

const SOURCE_COMMIT = "a".repeat(40);
const DIGEST_PREFIX = "sha256:";
const ARTIFACT_ID = "123456";
const RUN_ID = "654321";
const ARTIFACT_NAME = "site-behavior-report-publication-654321-1";
const REPORT_ID = `20260721-${"1".repeat(32)}`;

let testRoot = "";

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "sbl-publication-zip-"));
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("validates exact GitHub run metadata before safely extracting a bounded ZIP", async () => {
  const archive = buildZip(baseEntries());
  const archivePath = path.join(testRoot, "artifact.zip");
  const metadataPath = path.join(testRoot, "metadata.json");
  const destination = path.join(testRoot, "extracted");
  const digest = sha256(archive);
  await writeFile(archivePath, archive);
  await writeMetadata(metadataPath, archive.byteLength, digest);

  const metadata = await validateMetadata(metadataPath, digest);
  assert.deepEqual(metadata, { archiveBytes: archive.byteLength });
  const extracted = await extractReportPublicationArchive({
    archivePath,
    destinationDir: destination,
    expectedDigest: `${DIGEST_PREFIX}${digest}`,
    expectedArchiveBytes: metadata.archiveBytes
  });
  assert.deepEqual(extracted, {
    entries: 5,
    compressedBytes: compressedTotal(baseEntries()),
    uncompressedBytes: baseEntries().reduce((total, entry) => total + entry.data.byteLength, 0)
  });
  assert.deepEqual(await readFile(path.join(destination, "publication.json")), Buffer.from("{}\n"));
  assert.deepEqual(
    await readFile(path.join(destination, "reports", `${REPORT_ID}.provenance.json`)),
    Buffer.from('{"sidecar":true}\n')
  );
});

test("metadata binding rejects wrong run identity, digest, and pre-download archive size", async () => {
  const metadataPath = path.join(testRoot, "metadata.json");
  const digest = "b".repeat(64);
  await writeMetadata(metadataPath, 123, digest);
  await assert.rejects(
    () => validateGithubReportPublicationArtifactMetadata({
      ...metadataInput(metadataPath, digest),
      expectedRunId: "999"
    }),
    /different workflow run/
  );
  await assert.rejects(() => validateMetadata(metadataPath, "c".repeat(64)), /digest does not match/);
  await writeMetadata(metadataPath, REPORT_PUBLICATION_ARCHIVE_MAX_BYTES + 1, digest);
  await assert.rejects(() => validateMetadata(metadataPath, digest), /exceeds/);
});

test("rejects a forged-size deflate bomb before writing any destination", async () => {
  const entries = baseEntries();
  entries[0] = {
    ...entries[0],
    data: Buffer.alloc(2 * 1024 * 1024, 65),
    // Large enough for the tiny compressed stream to pass the central
    // compressed-size bound, far below the real inflated output.
    declaredUncompressed: 3_000
  };
  await assertArchiveRejected(entries, /deflate output is invalid or exceeds its declared bound/);
});

test("rejects traversal and absolute-style paths from the central directory", async () => {
  for (const name of ["../publication.json", "/publication.json", "reports\\index.json"]) {
    const entries = baseEntries();
    entries[0] = { ...entries[0], name };
    await assertArchiveRejected(entries, /path is not allowed|printable ASCII/);
  }
});

test("rejects Unix symbolic-link entries", async () => {
  const entries = baseEntries();
  entries[0] = { ...entries[0], externalAttributes: (0o120777 << 16) >>> 0 };
  await assertArchiveRejected(entries, /non-regular or symbolic-link entry is forbidden/);
});

test("rejects duplicate paths before inflation", async () => {
  const entries = [...baseEntries(), { ...baseEntries()[0] }];
  await assertArchiveRejected(entries, /duplicate path publication\.json/);
});

test("rejects local-header mismatches, ZIP64, encryption, and CRC forgery", async (context) => {
  await context.test("local header", async () => {
    const entries = baseEntries();
    entries[0] = { ...entries[0], localName: "xublication.json" };
    await assertArchiveRejected(entries, /local header mismatch/);
  });
  await context.test("ZIP64", async () => {
    const entries = baseEntries();
    entries[0] = { ...entries[0], extra: zip64Extra() };
    await assertArchiveRejected(entries, /ZIP64 publication artifacts are forbidden/);
  });
  await context.test("encryption", async () => {
    const entries = baseEntries();
    entries[0] = { ...entries[0], flags: 1 };
    await assertArchiveRejected(entries, /Encrypted publication ZIP entries are forbidden/);
  });
  await context.test("CRC", async () => {
    const entries = baseEntries();
    entries[0] = { ...entries[0], declaredCrc: 0 };
    await assertArchiveRejected(entries, /length or CRC mismatch/);
  });
});

type ZipEntryInput = {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  localName?: string;
  declaredUncompressed?: number;
  declaredCrc?: number;
  externalAttributes?: number;
  extra?: Buffer;
  useDescriptor?: boolean;
};

function baseEntries(): ZipEntryInput[] {
  return [
    { name: "publication.json", data: Buffer.from("{}\n"), method: 8, useDescriptor: true },
    { name: "corpus-stats.json", data: Buffer.from('{"stats":true}\n'), method: 0 },
    { name: "reports/index.json", data: Buffer.from('{"index":true}\n'), method: 8 },
    { name: `reports/${REPORT_ID}.json`, data: Buffer.from('{"report":true}\n'), method: 8 },
    { name: `reports/${REPORT_ID}.provenance.json`, data: Buffer.from('{"sidecar":true}\n'), method: 0 }
  ];
}

function compressedTotal(entries: readonly ZipEntryInput[]): number {
  return entries.reduce((total, entry) => total + compressedData(entry).byteLength, 0);
}

async function assertArchiveRejected(entries: ZipEntryInput[], pattern: RegExp): Promise<void> {
  const archive = buildZip(entries);
  const archivePath = path.join(testRoot, `rejected-${Math.random().toString(16).slice(2)}.zip`);
  const destination = `${archivePath}.out`;
  await writeFile(archivePath, archive);
  await assert.rejects(
    () => extractReportPublicationArchive({
      archivePath,
      destinationDir: destination,
      expectedDigest: sha256(archive),
      expectedArchiveBytes: archive.byteLength
    }),
    pattern
  );
  await assert.rejects(() => readFile(path.join(destination, "publication.json")), /ENOENT/);
}

function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const extra = entry.extra ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const flags = (entry.flags ?? 0) | (entry.useDescriptor ? 1 << 3 : 0);
    const compressed = compressedData(entry);
    const declaredUncompressed = entry.declaredUncompressed ?? entry.data.byteLength;
    const declaredCrc = entry.declaredCrc ?? crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.useDescriptor ? 0 : declaredCrc, 14);
    local.writeUInt32LE(entry.useDescriptor ? 0 : compressed.byteLength, 18);
    local.writeUInt32LE(entry.useDescriptor ? 0 : declaredUncompressed, 22);
    local.writeUInt16LE(localName.byteLength, 26);
    local.writeUInt16LE(extra.byteLength, 28);
    const descriptor = entry.useDescriptor ? signedDescriptor(declaredCrc, compressed.byteLength, declaredUncompressed) : Buffer.alloc(0);
    const localRecord = Buffer.concat([local, localName, extra, compressed, descriptor]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(declaredCrc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(declaredUncompressed, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(extra.byteLength, 30);
    central.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([central, name, extra]));
    localOffset += localRecord.byteLength;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.byteLength, 12);
  eocd.writeUInt32LE(localBytes.byteLength, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function compressedData(entry: ZipEntryInput): Buffer {
  return (entry.method ?? 8) === 0 ? entry.data : deflateRawSync(entry.data);
}

function zip64Extra(): Buffer {
  const value = Buffer.alloc(12);
  value.writeUInt16LE(0x0001, 0);
  value.writeUInt16LE(8, 2);
  return value;
}

function signedDescriptor(crc: number, compressed: number, uncompressed: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed, 8);
  descriptor.writeUInt32LE(uncompressed, 12);
  return descriptor;
}

async function writeMetadata(file: string, archiveBytes: number, digest: string): Promise<void> {
  await writeFile(file, `${JSON.stringify({
    total_count: 1,
    artifacts: [{
      id: Number(ARTIFACT_ID),
      name: ARTIFACT_NAME,
      size_in_bytes: archiveBytes,
      expired: false,
      digest: `${DIGEST_PREFIX}${digest}`,
      workflow_run: { id: Number(RUN_ID), head_sha: SOURCE_COMMIT }
    }]
  })}\n`);
}

function metadataInput(metadataPath: string, digest: string) {
  return {
    metadataPath,
    expectedArtifactId: ARTIFACT_ID,
    expectedArtifactName: ARTIFACT_NAME,
    expectedRunId: RUN_ID,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedDigest: digest
  };
}

function validateMetadata(metadataPath: string, digest: string) {
  return validateGithubReportPublicationArtifactMetadata(metadataInput(metadataPath, digest));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

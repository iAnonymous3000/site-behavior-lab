import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";
import {
  REPORT_PUBLICATION_ARTIFACT_MAX_FILES,
  REPORT_PUBLICATION_ARTIFACT_MAX_INDEX_BYTES,
  REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES,
  REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS,
  REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES,
  REPORT_PUBLICATION_ARTIFACT_MAX_STATS_BYTES,
  REPORT_PUBLICATION_ARTIFACT_MAX_TOTAL_BYTES
} from "./report-publication-artifact";
import { SERVER_STORED_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { parseStrictJson } from "./strict-json";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_ID = 0x0001;
const UTF8_FLAG = 1 << 11;
const DATA_DESCRIPTOR_FLAG = 1 << 3;
const ALLOWED_FLAGS = UTF8_FLAG | DATA_DESCRIPTOR_FLAG;
const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const FULL_SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/;
const REPORT_PATH = /^reports\/([0-9]{8}-[0-9a-f]{32})\.json$/;
const SIDECAR_PATH = /^reports\/([0-9]{8}-[0-9a-f]{32})\.provenance\.json$/;
const GITHUB_METADATA_MAX_BYTES = 1024 * 1024;

// Includes publication.json, ZIP metadata, and conservative deflate framing
// above the 512 MiB artifact data budget. GitHub metadata is checked against
// this before the raw archive is downloaded; the local reader checks it again.
export const REPORT_PUBLICATION_ARCHIVE_MAX_BYTES = 528 * 1024 * 1024;
export const REPORT_PUBLICATION_ARCHIVE_MAX_ENTRIES = REPORT_PUBLICATION_ARTIFACT_MAX_FILES + 1;
const REPORT_PUBLICATION_ARCHIVE_MAX_COMPRESSED_DATA_BYTES =
  REPORT_PUBLICATION_ARTIFACT_MAX_TOTAL_BYTES + REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES + 2 * 1024 * 1024;

type CentralEntry = {
  name: string;
  rawName: Buffer;
  madeBy: number;
  needed: number;
  flags: number;
  method: 0 | 8;
  modifiedTime: number;
  modifiedDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  recordEnd: number;
};

export type ValidatedGithubArtifactMetadata = {
  archiveBytes: number;
};

export async function validateGithubReportPublicationArtifactMetadata(input: {
  metadataPath: string;
  expectedArtifactId: string;
  expectedArtifactName: string;
  expectedRunId: string;
  expectedSourceCommit: string;
  expectedDigest: string;
}): Promise<ValidatedGithubArtifactMetadata> {
  const expectedArtifactId = safePositiveId(input.expectedArtifactId, "artifact");
  const expectedRunId = safePositiveId(input.expectedRunId, "workflow run");
  if (!/^[0-9a-f]{40}$/.test(input.expectedSourceCommit)) throw new Error("Expected artifact source commit is invalid.");
  const digest = normalizedDigest(input.expectedDigest);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.expectedArtifactName)) {
    throw new Error("Expected artifact name is invalid.");
  }

  const wire = await readRegularFileNoFollow(input.metadataPath, GITHUB_METADATA_MAX_BYTES);
  const metadata = strictJson(wire, "GitHub artifact metadata");
  if (!isRecord(metadata) || !Array.isArray(metadata.artifacts)) {
    throw new Error("GitHub artifact metadata has no artifacts array.");
  }
  if (
    !Number.isSafeInteger(metadata.total_count) ||
    metadata.total_count !== metadata.artifacts.length ||
    metadata.artifacts.length > 100
  ) {
    throw new Error("GitHub artifact metadata is paginated or has an invalid entry count.");
  }
  const matches = metadata.artifacts.filter((candidate) => {
    if (!isRecord(candidate)) return false;
    return candidate.id === expectedArtifactId && candidate.name === input.expectedArtifactName;
  });
  if (matches.length !== 1) throw new Error("GitHub artifact metadata did not identify exactly the requested run artifact.");
  const artifact = matches[0];
  if (artifact.expired !== false) throw new Error("GitHub publication artifact is expired.");
  if (!Number.isSafeInteger(artifact.size_in_bytes) || (artifact.size_in_bytes as number) <= 0) {
    throw new Error("GitHub publication artifact size is invalid.");
  }
  const archiveBytes = artifact.size_in_bytes as number;
  if (archiveBytes > REPORT_PUBLICATION_ARCHIVE_MAX_BYTES) {
    throw new Error(`GitHub publication artifact exceeds ${REPORT_PUBLICATION_ARCHIVE_MAX_BYTES} bytes.`);
  }
  if (!isRecord(artifact.workflow_run)) throw new Error("GitHub artifact metadata has no workflow-run identity.");
  if (artifact.workflow_run.id !== expectedRunId) {
    throw new Error("GitHub publication artifact belongs to a different workflow run.");
  }
  if (artifact.workflow_run.head_sha !== input.expectedSourceCommit) {
    throw new Error("GitHub publication artifact belongs to a different source commit.");
  }
  if (typeof artifact.digest !== "string" || normalizedDigest(artifact.digest) !== digest) {
    throw new Error("GitHub publication artifact digest does not match the upload result.");
  }
  return { archiveBytes };
}

export async function extractReportPublicationArchive(input: {
  archivePath: string;
  destinationDir: string;
  expectedDigest: string;
  expectedArchiveBytes: number;
}): Promise<{ entries: number; compressedBytes: number; uncompressedBytes: number }> {
  const expectedDigest = normalizedDigest(input.expectedDigest);
  if (
    !Number.isSafeInteger(input.expectedArchiveBytes) ||
    input.expectedArchiveBytes <= 0 ||
    input.expectedArchiveBytes > REPORT_PUBLICATION_ARCHIVE_MAX_BYTES
  ) {
    throw new Error("Expected publication archive size is invalid.");
  }
  if (!path.isAbsolute(input.archivePath) || !path.isAbsolute(input.destinationDir)) {
    throw new Error("Publication archive and destination paths must be absolute.");
  }
  const archive = await readRegularFileNoFollow(input.archivePath, REPORT_PUBLICATION_ARCHIVE_MAX_BYTES);
  if (archive.byteLength !== input.expectedArchiveBytes) {
    throw new Error("Downloaded publication archive size differs from GitHub metadata.");
  }
  if (sha256(archive) !== expectedDigest) throw new Error("Downloaded publication archive digest is invalid.");

  // Parse and cross-check every central/local record before creating the
  // destination or inflating a single attacker-controlled byte.
  const entries = parseZipArchive(archive);
  validateEntrySet(entries);

  await mkdir(input.destinationDir, { recursive: false, mode: 0o700 });
  await mkdir(path.join(input.destinationDir, "reports"), { recursive: false, mode: 0o700 });

  let compressedBytes = 0;
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const compressed = archive.subarray(entry.dataStart, entry.dataEnd);
    const contents = inflateEntry(entry, compressed);
    if (contents.byteLength !== entry.uncompressedSize || crc32(contents) !== entry.crc32) {
      throw new Error(`Publication ZIP length or CRC mismatch for ${entry.name}.`);
    }
    compressedBytes += entry.compressedSize;
    uncompressedBytes += contents.byteLength;
    const destination = path.join(input.destinationDir, ...entry.name.split("/"));
    await writeExclusiveNoFollow(destination, contents);
  }
  return { entries: entries.length, compressedBytes, uncompressedBytes };
}

function parseZipArchive(archive: Buffer): CentralEntry[] {
  if (archive.byteLength < 22 || archive.readUInt32LE(archive.byteLength - 22) !== EOCD_SIGNATURE) {
    throw new Error("Publication ZIP must end in an un-commented EOCD record.");
  }
  const eocd = archive.byteLength - 22;
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (commentLength !== 0 || disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("Publication ZIP must be a single-disk archive with no comment.");
  }
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    totalEntries < 5 ||
    totalEntries > REPORT_PUBLICATION_ARCHIVE_MAX_ENTRIES
  ) {
    throw new Error("Publication ZIP entry count or central directory requires unsupported ZIP64/bounds.");
  }
  const centralEnd = checkedAdd(centralOffset, centralSize, "central directory");
  if (centralEnd !== eocd) throw new Error("Publication ZIP central directory is not contiguous with EOCD.");

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let aggregateCompressed = 0;
  let aggregateUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(archive, cursor, 46, "central header");
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("Publication ZIP central header is invalid.");
    const madeBy = archive.readUInt16LE(cursor + 4);
    const needed = archive.readUInt16LE(cursor + 6);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const modifiedTime = archive.readUInt16LE(cursor + 12);
    const modifiedDate = archive.readUInt16LE(cursor + 14);
    const entryCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    requireRange(archive, cursor, recordLength, "central entry");
    if (
      needed > 20 ||
      diskStart !== 0 ||
      entryCommentLength !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("Publication ZIP uses unsupported version, disk, comment, or ZIP64 metadata.");
    }
    validateFlagsAndMethod(flags, method);
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeEntryName(rawName);
    if (!allowedArchivePath(name)) throw new Error(`Publication ZIP path is not allowed: ${name}.`);
    if (names.has(name)) throw new Error(`Publication ZIP contains duplicate path ${name}.`);
    names.add(name);
    validateExtraFields(archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    validateExternalAttributes(madeBy, externalAttributes, name);
    const limit = archiveEntryLimit(name);
    if (uncompressedSize > limit) throw new Error(`Publication ZIP entry ${name} exceeds its uncompressed limit.`);
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error(`Stored publication ZIP entry ${name} has unequal sizes.`);
    }
    if (compressedSize > maxCompressedSize(uncompressedSize)) {
      throw new Error(`Publication ZIP entry ${name} exceeds its compressed limit.`);
    }
    aggregateCompressed = checkedAdd(aggregateCompressed, compressedSize, "compressed entry sizes");
    aggregateUncompressed = checkedAdd(aggregateUncompressed, uncompressedSize, "uncompressed entry sizes");
    if (
      aggregateUncompressed > REPORT_PUBLICATION_ARTIFACT_MAX_TOTAL_BYTES + REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES ||
      aggregateCompressed > REPORT_PUBLICATION_ARCHIVE_MAX_COMPRESSED_DATA_BYTES
    ) {
      throw new Error("Publication ZIP aggregate data exceeds its limit.");
    }
    entries.push({
      name,
      rawName: Buffer.from(rawName),
      madeBy,
      needed,
      flags,
      method: method as 0 | 8,
      modifiedTime,
      modifiedDate,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localOffset,
      dataStart: 0,
      dataEnd: 0,
      recordEnd: 0
    });
    cursor += recordLength;
  }
  if (cursor !== centralEnd) throw new Error("Publication ZIP central directory size is inconsistent.");

  for (const entry of entries) validateLocalRecord(archive, entry, centralOffset);
  const byOffset = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of byOffset) {
    if (entry.localOffset !== expectedOffset) throw new Error("Publication ZIP has hidden, overlapping, or gapped local data.");
    expectedOffset = entry.recordEnd;
  }
  if (expectedOffset !== centralOffset) throw new Error("Publication ZIP local records do not end at the central directory.");
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function validateLocalRecord(archive: Buffer, entry: CentralEntry, centralOffset: number): void {
  const cursor = entry.localOffset;
  requireRange(archive, cursor, 30, "local header");
  if (archive.readUInt32LE(cursor) !== LOCAL_SIGNATURE) throw new Error(`Publication ZIP local header is invalid for ${entry.name}.`);
  const needed = archive.readUInt16LE(cursor + 4);
  const flags = archive.readUInt16LE(cursor + 6);
  const method = archive.readUInt16LE(cursor + 8);
  const modifiedTime = archive.readUInt16LE(cursor + 10);
  const modifiedDate = archive.readUInt16LE(cursor + 12);
  const localCrc = archive.readUInt32LE(cursor + 14);
  const localCompressed = archive.readUInt32LE(cursor + 18);
  const localUncompressed = archive.readUInt32LE(cursor + 22);
  const nameLength = archive.readUInt16LE(cursor + 26);
  const extraLength = archive.readUInt16LE(cursor + 28);
  const headerLength = 30 + nameLength + extraLength;
  requireRange(archive, cursor, headerLength, "local entry header");
  const rawName = archive.subarray(cursor + 30, cursor + 30 + nameLength);
  if (
    needed !== entry.needed ||
    flags !== entry.flags ||
    method !== entry.method ||
    modifiedTime !== entry.modifiedTime ||
    modifiedDate !== entry.modifiedDate ||
    !rawName.equals(entry.rawName)
  ) {
    throw new Error(`Publication ZIP local header mismatch for ${entry.name}.`);
  }
  validateExtraFields(archive.subarray(cursor + 30 + nameLength, cursor + headerLength));
  const descriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0;
  if (!descriptor) {
    if (localCrc !== entry.crc32 || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
      throw new Error(`Publication ZIP local sizes or CRC mismatch for ${entry.name}.`);
    }
  } else if (
    !zeroOrEqual(localCrc, entry.crc32) ||
    !zeroOrEqual(localCompressed, entry.compressedSize) ||
    !zeroOrEqual(localUncompressed, entry.uncompressedSize)
  ) {
    throw new Error(`Publication ZIP local descriptor placeholders mismatch for ${entry.name}.`);
  }
  entry.dataStart = checkedAdd(cursor, headerLength, `data offset for ${entry.name}`);
  entry.dataEnd = checkedAdd(entry.dataStart, entry.compressedSize, `data size for ${entry.name}`);
  if (entry.dataEnd > centralOffset) throw new Error(`Publication ZIP data overlaps central directory for ${entry.name}.`);
  entry.recordEnd = descriptor ? descriptorEnd(archive, entry) : entry.dataEnd;
  if (entry.recordEnd > centralOffset) throw new Error(`Publication ZIP descriptor overlaps central directory for ${entry.name}.`);
}

function descriptorEnd(archive: Buffer, entry: CentralEntry): number {
  requireRange(archive, entry.dataEnd, 12, "data descriptor");
  const first = archive.readUInt32LE(entry.dataEnd);
  if (
    first === entry.crc32 &&
    archive.readUInt32LE(entry.dataEnd + 4) === entry.compressedSize &&
    archive.readUInt32LE(entry.dataEnd + 8) === entry.uncompressedSize
  ) {
    return entry.dataEnd + 12;
  }
  requireRange(archive, entry.dataEnd, 16, "signed data descriptor");
  if (
    first !== DATA_DESCRIPTOR_SIGNATURE ||
    archive.readUInt32LE(entry.dataEnd + 4) !== entry.crc32 ||
    archive.readUInt32LE(entry.dataEnd + 8) !== entry.compressedSize ||
    archive.readUInt32LE(entry.dataEnd + 12) !== entry.uncompressedSize
  ) {
    throw new Error(`Publication ZIP data descriptor mismatch for ${entry.name}.`);
  }
  return entry.dataEnd + 16;
}

function validateEntrySet(entries: readonly CentralEntry[]): void {
  const names = new Set(entries.map((entry) => entry.name));
  for (const required of ["publication.json", "corpus-stats.json", "reports/index.json"]) {
    if (!names.has(required)) throw new Error(`Publication ZIP is missing required path ${required}.`);
  }
  const reports = new Set<string>();
  const sidecars = new Set<string>();
  for (const name of names) {
    const report = REPORT_PATH.exec(name);
    if (report) reports.add(report[1]);
    const sidecar = SIDECAR_PATH.exec(name);
    if (sidecar) sidecars.add(sidecar[1]);
  }
  if (reports.size < 1 || reports.size > REPORT_PUBLICATION_ARTIFACT_MAX_REPORTS) {
    throw new Error("Publication ZIP report count is outside the allowed range.");
  }
  if (canonicalStrings(reports) !== canonicalStrings(sidecars)) {
    throw new Error("Publication ZIP report and sidecar paths do not pair exactly.");
  }
  if (entries.length !== 3 + reports.size * 2) {
    throw new Error("Publication ZIP contains a path outside its exact artifact entry set.");
  }
}

function validateFlagsAndMethod(flags: number, method: number): void {
  if ((flags & 1) !== 0) throw new Error("Encrypted publication ZIP entries are forbidden.");
  if ((flags & ~ALLOWED_FLAGS) !== 0) throw new Error("Publication ZIP uses unsupported general-purpose flags.");
  if (method !== 0 && method !== 8) throw new Error("Publication ZIP compression method must be stored or deflate.");
}

function validateExtraFields(extra: Buffer): void {
  let cursor = 0;
  while (cursor < extra.byteLength) {
    if (extra.byteLength - cursor < 4) throw new Error("Publication ZIP extra field is truncated.");
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (size > extra.byteLength - cursor) throw new Error("Publication ZIP extra field length is invalid.");
    if (id === ZIP64_EXTRA_ID) throw new Error("ZIP64 publication artifacts are forbidden.");
    cursor += size;
  }
}

function validateExternalAttributes(madeBy: number, attributes: number, name: string): void {
  if ((attributes & DOS_DIRECTORY_ATTRIBUTE) !== 0) throw new Error(`Publication ZIP directory entry is forbidden: ${name}.`);
  if ((madeBy >>> 8) !== UNIX_HOST) return;
  const fileType = (attributes >>> 16) & UNIX_FILE_TYPE_MASK;
  if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE) {
    throw new Error(`Publication ZIP non-regular or symbolic-link entry is forbidden: ${name}.`);
  }
}

function inflateEntry(entry: CentralEntry, compressed: Buffer): Buffer {
  if (entry.method === 0) return Buffer.from(compressed);
  try {
    const result = inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, entry.uncompressedSize),
      info: true
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (result.engine.bytesWritten !== compressed.byteLength) {
      throw new Error("deflate stream did not consume its exact compressed extent");
    }
    return result.buffer;
  } catch (error) {
    throw new Error(
      `Publication ZIP deflate output is invalid or exceeds its declared bound for ${entry.name}: ${error instanceof Error ? error.message : error}`
    );
  }
}

function allowedArchivePath(name: string): boolean {
  return name === "publication.json" || name === "corpus-stats.json" || name === "reports/index.json" ||
    REPORT_PATH.test(name) || SIDECAR_PATH.test(name);
}

function archiveEntryLimit(name: string): number {
  if (name === "publication.json") return REPORT_PUBLICATION_ARTIFACT_MAX_MANIFEST_BYTES;
  if (name === "corpus-stats.json") return REPORT_PUBLICATION_ARTIFACT_MAX_STATS_BYTES;
  if (name === "reports/index.json") return REPORT_PUBLICATION_ARTIFACT_MAX_INDEX_BYTES;
  if (SIDECAR_PATH.test(name)) return REPORT_PUBLICATION_ARTIFACT_MAX_SIDECAR_BYTES;
  if (REPORT_PATH.test(name)) return SERVER_STORED_REPORT_JSON_MAX_BYTES;
  throw new Error(`Publication ZIP path is not allowed: ${name}.`);
}

function decodeEntryName(raw: Buffer): string {
  if (raw.byteLength === 0 || raw.byteLength > 100 || raw.some((value) => value < 0x20 || value > 0x7e)) {
    throw new Error("Publication ZIP entry name must be bounded printable ASCII.");
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
}

function maxCompressedSize(uncompressed: number): number {
  return uncompressed + Math.ceil(Math.max(1, uncompressed) / 16_383) * 5 + 64;
}

function zeroOrEqual(actual: number, expected: number): boolean {
  return actual === 0 || actual === expected;
}

function requireRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > buffer.byteLength - length) {
    throw new Error(`Publication ZIP ${label} is outside the archive.`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Publication ZIP ${label} overflows its bound.`);
  return result;
}

function canonicalStrings(values: ReadonlySet<string>): string {
  return JSON.stringify([...values].sort());
}

async function readRegularFileNoFollow(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) {
      throw new Error(`${file} is not a bounded regular file.`);
    }
    const contents = await handle.readFile();
    if (contents.byteLength !== metadata.size) throw new Error(`${file} changed while it was read.`);
    return contents;
  } finally {
    await handle.close();
  }
}

async function writeExclusiveNoFollow(file: string, contents: Buffer): Promise<void> {
  const handle = await open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

function strictJson(contents: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  try {
    return parseStrictJson(text, contents.byteLength);
  } catch {
    throw new Error(`${label} is not strict JSON.`);
  }
}

function normalizedDigest(value: string): string {
  const match = FULL_SHA256.exec(value);
  if (!match) throw new Error("Expected artifact digest is invalid.");
  return match[1];
}

function safePositiveId(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Expected ${label} id is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected ${label} id is invalid.`);
  return parsed;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

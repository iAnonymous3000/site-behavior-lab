import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";
import {
  CALIBRATION_ACQUISITION_KIND,
  parseStrictJsonBuffer,
  sha256Hex
} from "./calibration-study-lib.mjs";

export const CALIBRATION_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const CALIBRATION_WORKFLOW_PATH =
  ".github/workflows/calibration-study.yml";
export const CALIBRATION_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const METADATA_MAX_BYTES = 1024 * 1024;
const RUN_METADATA_MAX_BYTES = 1024 * 1024;
const JOB_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const FILE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 200_001;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMPRESSED_MEMBER_BYTES = 64 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_ALLOWED_FLAGS = ZIP_FLAG_DATA_DESCRIPTOR | ZIP_FLAG_UTF8;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const ARTIFACT_NAME =
  /^site-behavior-calibration-([a-z0-9][a-z0-9._-]{0,99})-([1-9][0-9]*)-([1-9][0-9]*)$/;

export function validateCalibrationGithubArtifactMetadata(input) {
  const runId = positiveInteger(input.runId, "run id");
  const runAttempt = positiveInteger(input.runAttempt, "run attempt");
  if (runAttempt > 100) {
    throw new Error("run attempt must be no greater than 100");
  }
  const artifactId = positiveInteger(input.artifactId, "artifact id");
  const expectedDigest = normalizedDigest(input.archiveSha256);
  const expectedName =
    `site-behavior-calibration-${input.studyId}-${runId}-${runAttempt}`;
  if (input.artifactName !== expectedName || !ARTIFACT_NAME.test(expectedName)) {
    throw new Error("calibration artifact name does not bind study, run, and attempt");
  }
  const run = parseStrictJsonBuffer(
    readRegularNoFollow(input.runMetadataPath, RUN_METADATA_MAX_BYTES, "Actions run metadata"),
    "Actions run metadata",
    RUN_METADATA_MAX_BYTES
  ).value;
  if (
    !isRecord(run) ||
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    run.event !== "workflow_dispatch" ||
    run.path !== CALIBRATION_WORKFLOW_PATH ||
    run.head_branch !== "main" ||
    typeof run.head_sha !== "string" ||
    !FULL_SHA.test(run.head_sha) ||
    run.conclusion !== "success" ||
    run.repository?.full_name !== CALIBRATION_REPOSITORY
  ) {
    throw new Error("Actions run metadata does not identify one successful governed calibration run");
  }
  const runStartedAt = normalizedInstant(
    run.run_started_at,
    "calibration run run_started_at"
  );
  const runCompletedAt = normalizedInstant(
    run.updated_at,
    "calibration run updated_at"
  );
  if (Date.parse(runCompletedAt) < Date.parse(runStartedAt)) {
    throw new Error("calibration run server timestamps are reversed");
  }
  const jobs = parseStrictJsonBuffer(
    readRegularNoFollow(
      input.jobMetadataPath,
      JOB_METADATA_MAX_BYTES,
      "Actions job metadata"
    ),
    "Actions job metadata",
    JOB_METADATA_MAX_BYTES
  ).value;
  if (
    !isRecord(jobs) ||
    !Number.isSafeInteger(jobs.total_count) ||
    !Array.isArray(jobs.jobs) ||
    jobs.total_count !== jobs.jobs.length ||
    jobs.jobs.length > 100
  ) {
    throw new Error("Actions job metadata is malformed or paginated");
  }
  const jobMatches = jobs.jobs.filter(
    (job) =>
      isRecord(job) &&
      job.name === "Acquire blinded detector predictions" &&
      job.run_id === runId &&
      job.run_attempt === runAttempt &&
      job.head_sha === run.head_sha &&
      job.head_branch === "main"
  );
  if (jobMatches.length !== 1) {
    throw new Error("Actions metadata did not identify exactly one acquisition job");
  }
  const job = jobMatches[0];
  const jobStartedAt = normalizedInstant(
    job.started_at,
    "acquisition job started_at"
  );
  const jobCompletedAt = normalizedInstant(
    job.completed_at,
    "acquisition job completed_at"
  );
  if (
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    typeof job.runner_name !== "string" ||
    job.runner_name.length < 1 ||
    job.runner_name.length > 200 ||
    !Array.isArray(job.labels) ||
    !job.labels.includes("self-hosted") ||
    !job.labels.includes(input.runnerLabel) ||
    Date.parse(jobStartedAt) < Date.parse(runStartedAt) ||
    Date.parse(jobCompletedAt) < Date.parse(jobStartedAt) ||
    Date.parse(jobCompletedAt) > Date.parse(runCompletedAt)
  ) {
    throw new Error(
      "acquisition job did not complete successfully on the exact controlled runner label"
    );
  }
  const metadata = parseStrictJsonBuffer(
    readRegularNoFollow(
      input.artifactMetadataPath,
      METADATA_MAX_BYTES,
      "Actions artifact metadata"
    ),
    "Actions artifact metadata",
    METADATA_MAX_BYTES
  ).value;
  if (
    !isRecord(metadata) ||
    !Number.isSafeInteger(metadata.total_count) ||
    !Array.isArray(metadata.artifacts) ||
    metadata.total_count !== metadata.artifacts.length ||
    metadata.artifacts.length > 100
  ) {
    throw new Error("Actions artifact metadata is malformed or paginated");
  }
  const matches = metadata.artifacts.filter(
    (artifact) =>
      isRecord(artifact) &&
      artifact.id === artifactId &&
      artifact.name === expectedName
  );
  if (matches.length !== 1) {
    throw new Error("Actions artifact metadata did not identify exactly one requested artifact");
  }
  const artifact = matches[0];
  const archiveBytes = artifact.size_in_bytes;
  const createdAt = normalizedInstant(
    artifact.created_at,
    "Actions artifact created_at"
  );
  const expiresAt = normalizedInstant(
    artifact.expires_at,
    "Actions artifact expires_at"
  );
  if (
    artifact.expired !== false ||
    !Number.isSafeInteger(archiveBytes) ||
    archiveBytes <= 0 ||
    archiveBytes > CALIBRATION_ARCHIVE_MAX_BYTES ||
    artifact.workflow_run?.id !== runId ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    normalizedDigest(artifact.digest) !== expectedDigest
  ) {
    throw new Error("Actions artifact metadata does not bind the expected live archive");
  }
  if (
    Date.parse(createdAt) < Date.parse(jobStartedAt) ||
    Date.parse(createdAt) > Date.parse(jobCompletedAt) ||
    Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    throw new Error(
      "Actions artifact creation/expiry must fall inside the authenticated acquisition job"
    );
  }
  return {
    runId,
    runAttempt,
    headCommit: run.head_sha,
    artifactId,
    artifactName: expectedName,
    archiveSha256: expectedDigest,
    archiveBytes,
    createdAt,
    expiresAt,
    jobId: positiveInteger(job.id, "acquisition job id"),
    jobStartedAt,
    jobCompletedAt,
    runnerName: job.runner_name,
    runStartedAt,
    runCompletedAt
  };
}

/**
 * Parse and extract the GitHub artifact ZIP in-process. No executable is
 * resolved through PATH and no archive implementation is allowed to create
 * paths. Central and local records are cross-checked before bounded
 * decompression, then this code writes only prevalidated regular files with
 * O_EXCL/O_NOFOLLOW.
 */
export function extractCalibrationAcquisitionArchive(input) {
  const expectedDigest = normalizedDigest(input.archiveSha256);
  const archive = readRegularNoFollow(
    input.archivePath,
    CALIBRATION_ARCHIVE_MAX_BYTES,
    "calibration archive"
  );
  if (
    archive.byteLength !== input.archiveBytes ||
    sha256Hex(archive) !== expectedDigest
  ) {
    throw new Error("downloaded calibration archive size or digest does not match GitHub metadata");
  }
  const parsedArchive = parseCalibrationZip(archive);
  const names = [...parsedArchive.entries.keys()];
  if (
    names.length < 2 ||
    names.length > MAX_FILES ||
    names.some((name) => !safeArchivePath(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("calibration archive entry names are empty, duplicated, unsafe, or outside bounds");
  }
  const manifestBuffer = readArchiveMember(
    archive,
    parsedArchive,
    "acquisition.json",
    MANIFEST_MAX_BYTES
  );
  const parsed = parseStrictJsonBuffer(
    manifestBuffer,
    "calibration acquisition manifest",
    MANIFEST_MAX_BYTES
  );
  const manifest = parsed.value;
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 3 ||
    manifest.artifactKind !== CALIBRATION_ACQUISITION_KIND ||
    manifest.studyId !== input.studyId ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("calibration acquisition manifest identity is invalid");
  }
  const declared = new Map();
  for (const [index, file] of manifest.files.entries()) {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      !safeArchivePath(file.path) ||
      file.path === "acquisition.json" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > FILE_MAX_BYTES ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256) ||
      declared.has(file.path)
    ) {
      throw new Error(`calibration acquisition files[${index}] is invalid`);
    }
    declared.set(file.path, file);
  }
  const expectedNames = ["acquisition.json", ...declared.keys()].sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("calibration archive entries are not set-equal to its manifest");
  }
  mkdirSync(input.destinationDir, { recursive: false, mode: 0o700 });
  writeExclusive(
    path.join(input.destinationDir, "acquisition.json"),
    manifestBuffer
  );
  let aggregateBytes = manifestBuffer.byteLength;
  for (const [relative, file] of [...declared.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const contents = readArchiveMember(
      archive,
      parsedArchive,
      relative,
      file.bytes
    );
    if (
      contents.byteLength !== file.bytes ||
      sha256Hex(contents) !== file.sha256
    ) {
      throw new Error(`calibration archive member ${relative} does not match its manifest`);
    }
    parseStrictJsonBuffer(contents, relative, FILE_MAX_BYTES);
    aggregateBytes += contents.byteLength;
    if (aggregateBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("calibration archive uncompressed aggregate exceeds 2 GiB");
    }
    const destination = path.join(
      input.destinationDir,
      ...relative.split("/")
    );
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeExclusive(destination, contents);
  }
  return {
    entries: expectedNames.length,
    uncompressedBytes: aggregateBytes,
    manifest
  };
}

/**
 * Read one immutable Actions artifact that is required to contain exactly one
 * canonical JSON member. This is used for pre-acquisition label/adjudication
 * batches, where extraction to an executable filesystem is unnecessary.
 */
export function readCalibrationSingleJsonArtifact(input) {
  const expectedDigest = normalizedDigest(input.archiveSha256);
  const archive = readRegularNoFollow(
    input.archivePath,
    CALIBRATION_ARCHIVE_MAX_BYTES,
    input.label
  );
  if (
    archive.byteLength !== input.archiveBytes ||
    sha256Hex(archive) !== expectedDigest
  ) {
    throw new Error(`${input.label} size or digest does not match GitHub metadata`);
  }
  const parsedArchive = parseCalibrationZip(archive);
  const names = [...parsedArchive.entries.keys()];
  if (
    names.length !== 1 ||
    names[0] !== input.memberName ||
    !safeArchivePath(names[0])
  ) {
    throw new Error(`${input.label} must contain exactly ${input.memberName}`);
  }
  const bytes = readArchiveMember(
    archive,
    parsedArchive,
    input.memberName,
    input.maximumBytes ?? FILE_MAX_BYTES
  );
  return parseStrictJsonBuffer(
    bytes,
    `${input.label} ${input.memberName}`,
    input.maximumBytes ?? FILE_MAX_BYTES
  );
}

function parseCalibrationZip(archive) {
  if (!Buffer.isBuffer(archive) || archive.byteLength < 22) {
    throw new Error("calibration archive is not a bounded ZIP file");
  }
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = readUInt16(archive, eocdOffset + 4, "EOCD disk number");
  const centralDisk = readUInt16(
    archive,
    eocdOffset + 6,
    "EOCD central-directory disk"
  );
  const entriesOnDisk = readUInt16(
    archive,
    eocdOffset + 8,
    "EOCD entries on disk"
  );
  const entryCount = readUInt16(
    archive,
    eocdOffset + 10,
    "EOCD total entries"
  );
  const centralSize = readUInt32(
    archive,
    eocdOffset + 12,
    "EOCD central-directory size"
  );
  const centralOffset = readUInt32(
    archive,
    eocdOffset + 16,
    "EOCD central-directory offset"
  );
  const commentLength = readUInt16(
    archive,
    eocdOffset + 20,
    "EOCD comment length"
  );
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount < 1 ||
    entryCount > MAX_FILES ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    commentLength !== 0 ||
    eocdOffset + 22 !== archive.byteLength ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw new Error(
      "calibration ZIP must be a single-disk, comment-free, non-ZIP64 archive with exact bounds"
    );
  }
  const entries = new Map();
  let centralCursor = centralOffset;
  let aggregateBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, centralCursor, 46, "central-directory record");
    if (archive.readUInt32LE(centralCursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`calibration ZIP central record ${index} has an invalid signature`);
    }
    const versionMadeBy = archive.readUInt16LE(centralCursor + 4);
    const flags = archive.readUInt16LE(centralCursor + 8);
    const method = archive.readUInt16LE(centralCursor + 10);
    const crc32 = archive.readUInt32LE(centralCursor + 16);
    const compressedSize = archive.readUInt32LE(centralCursor + 20);
    const uncompressedSize = archive.readUInt32LE(centralCursor + 24);
    const nameLength = archive.readUInt16LE(centralCursor + 28);
    const extraLength = archive.readUInt16LE(centralCursor + 30);
    const entryCommentLength = archive.readUInt16LE(centralCursor + 32);
    const diskStart = archive.readUInt16LE(centralCursor + 34);
    const externalAttributes = archive.readUInt32LE(centralCursor + 38);
    const localOffset = archive.readUInt32LE(centralCursor + 42);
    const recordLength =
      46 + nameLength + extraLength + entryCommentLength;
    requireRange(
      archive,
      centralCursor,
      recordLength,
      `central-directory record ${index}`
    );
    if (
      nameLength < 1 ||
      nameLength > 500 ||
      entryCommentLength !== 0 ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      compressedSize > MAX_COMPRESSED_MEMBER_BYTES ||
      uncompressedSize > FILE_MAX_BYTES
    ) {
      throw new Error(`calibration ZIP central record ${index} exceeds strict bounds`);
    }
    assertSupportedFlagsAndMethod(flags, method, `central record ${index}`);
    const nameBytes = archive.subarray(
      centralCursor + 46,
      centralCursor + 46 + nameLength
    );
    const name = decodeArchiveName(nameBytes, `central record ${index}`);
    if (!safeArchivePath(name) || entries.has(name)) {
      throw new Error(
        "calibration archive entry names are empty, duplicated, unsafe, or outside bounds"
      );
    }
    const extra = archive.subarray(
      centralCursor + 46 + nameLength,
      centralCursor + 46 + nameLength + extraLength
    );
    validateExtraFields(extra, `central record ${index}`);
    validateRegularFileAttributes(
      versionMadeBy,
      externalAttributes,
      `central record ${index}`
    );
    aggregateBytes += uncompressedSize;
    if (
      !Number.isSafeInteger(aggregateBytes) ||
      aggregateBytes > MAX_UNCOMPRESSED_BYTES
    ) {
      throw new Error("calibration archive uncompressed aggregate exceeds 2 GiB");
    }
    entries.set(name, {
      name,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset: null,
      dataEnd: null
    });
    centralCursor += recordLength;
  }
  if (centralCursor !== eocdOffset) {
    throw new Error("calibration ZIP central directory has undeclared bytes");
  }

  const orderedByLocalOffset = [...entries.values()].sort(
    (left, right) => left.localOffset - right.localOffset
  );
  let priorOffset = -1;
  for (const [index, entry] of orderedByLocalOffset.entries()) {
    if (
      entry.localOffset <= priorOffset ||
      entry.localOffset >= centralOffset
    ) {
      throw new Error("calibration ZIP local records overlap or are outside the file area");
    }
    priorOffset = entry.localOffset;
    requireRange(archive, entry.localOffset, 30, `local record ${entry.name}`);
    if (archive.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`calibration ZIP local record ${entry.name} has an invalid signature`);
    }
    const flags = archive.readUInt16LE(entry.localOffset + 6);
    const method = archive.readUInt16LE(entry.localOffset + 8);
    const crc32 = archive.readUInt32LE(entry.localOffset + 14);
    const compressedSize = archive.readUInt32LE(entry.localOffset + 18);
    const uncompressedSize = archive.readUInt32LE(entry.localOffset + 22);
    const nameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    requireRange(
      archive,
      entry.localOffset,
      30 + nameLength + extraLength,
      `local record ${entry.name}`
    );
    const nameBytes = archive.subarray(
      entry.localOffset + 30,
      entry.localOffset + 30 + nameLength
    );
    const extra = archive.subarray(
      entry.localOffset + 30 + nameLength,
      entry.localOffset + 30 + nameLength + extraLength
    );
    validateExtraFields(extra, `local record ${entry.name}`);
    if (
      flags !== entry.flags ||
      method !== entry.method ||
      !nameBytes.equals(entry.nameBytes)
    ) {
      throw new Error(
        `calibration ZIP local record ${entry.name} disagrees with its central record`
      );
    }
    const usesDescriptor = (flags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0;
    if (
      (!usesDescriptor &&
        (crc32 !== entry.crc32 ||
          compressedSize !== entry.compressedSize ||
          uncompressedSize !== entry.uncompressedSize)) ||
      (usesDescriptor &&
        ((crc32 !== 0 && crc32 !== entry.crc32) ||
          (compressedSize !== 0 && compressedSize !== entry.compressedSize) ||
          (uncompressedSize !== 0 &&
            uncompressedSize !== entry.uncompressedSize)))
    ) {
      throw new Error(
        `calibration ZIP local record ${entry.name} has inconsistent sizes or CRC`
      );
    }
    entry.dataOffset =
      entry.localOffset + 30 + nameLength + extraLength;
    entry.dataEnd = entry.dataOffset + entry.compressedSize;
    const nextBoundary =
      index + 1 < orderedByLocalOffset.length
        ? orderedByLocalOffset[index + 1].localOffset
        : centralOffset;
    if (entry.dataEnd > nextBoundary) {
      throw new Error(
        `calibration ZIP compressed data for ${entry.name} overlaps another record`
      );
    }
  }
  return { entries };
}

function findEndOfCentralDirectory(archive) {
  const earliest = Math.max(0, archive.byteLength - (0xffff + 22));
  for (let offset = archive.byteLength - 22; offset >= earliest; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === EOCD_SIGNATURE &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.byteLength
    ) {
      return offset;
    }
  }
  throw new Error("calibration ZIP end-of-central-directory record is missing");
}

function readArchiveMember(archive, parsed, member, maximum) {
  const entry = parsed.entries.get(member);
  if (entry === undefined) {
    throw new Error(`calibration archive is missing ${member}`);
  }
  if (entry.uncompressedSize > maximum) {
    throw new Error(`calibration archive member ${member} exceeds its allowed size`);
  }
  const compressed = archive.subarray(entry.dataOffset, entry.dataEnd);
  let contents;
  try {
    if (entry.method === ZIP_METHOD_STORE) {
      contents = Buffer.from(compressed);
    } else {
      contents = inflateRawSync(compressed, {
        maxOutputLength: Math.min(maximum, entry.uncompressedSize) + 1
      });
    }
  } catch (error) {
    throw new Error(
      `trusted calibration archive extraction failed for ${member}: ${
        error instanceof Error ? error.message.slice(0, 160) : "unknown error"
      }`
    );
  }
  if (
    contents.byteLength !== entry.uncompressedSize ||
    crc32Buffer(contents) !== entry.crc32
  ) {
    throw new Error(
      `trusted calibration archive extraction failed for ${member}: size or CRC mismatch`
    );
  }
  return contents;
}

function assertSupportedFlagsAndMethod(flags, method, label) {
  if (
    (flags & ~ZIP_ALLOWED_FLAGS) !== 0 ||
    (method !== ZIP_METHOD_STORE && method !== ZIP_METHOD_DEFLATE)
  ) {
    throw new Error(`${label} uses encryption, unsupported flags, or an unsupported method`);
  }
}

function decodeArchiveName(bytes, label) {
  if ([...bytes].some((value) => value > 0x7f)) {
    throw new Error(`${label} filename must be canonical ASCII`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} filename is not valid UTF-8`);
  }
}

function validateExtraFields(extra, label) {
  let cursor = 0;
  while (cursor < extra.byteLength) {
    if (cursor + 4 > extra.byteLength) {
      throw new Error(`${label} has a truncated ZIP extra field`);
    }
    const identifier = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > extra.byteLength) {
      throw new Error(`${label} has a truncated ZIP extra field payload`);
    }
    if (identifier === ZIP64_EXTRA_ID) {
      throw new Error(`${label} uses unsupported ZIP64 metadata`);
    }
    cursor += size;
  }
}

function validateRegularFileAttributes(versionMadeBy, attributes, label) {
  const creatorSystem = versionMadeBy >>> 8;
  if (creatorSystem === 3) {
    const fileType = (attributes >>> 16) & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000) {
      throw new Error(`${label} is not a regular file`);
    }
  } else if ((attributes & 0x10) !== 0) {
    throw new Error(`${label} is a directory rather than a regular file`);
  }
}

function requireRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.byteLength
  ) {
    throw new Error(`${label} exceeds the calibration ZIP bounds`);
  }
}

function readUInt16(buffer, offset, label) {
  requireRange(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  requireRange(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

let crc32Table;

function crc32Buffer(buffer) {
  if (crc32Table === undefined) {
    crc32Table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value =
          (value & 1) !== 0
            ? 0xedb88320 ^ (value >>> 1)
            : value >>> 1;
      }
      crc32Table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readRegularNoFollow(file, maximum, label) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const contents = readFileSync(descriptor);
    if (contents.byteLength !== stat.size) throw new Error(`${label} changed while being read`);
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusive(file, contents) {
  let descriptor;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(descriptor, contents);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function safeArchivePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          /^[a-z0-9][a-z0-9._-]{0,199}$/.test(part)
      )
  );
}

function normalizedDigest(value) {
  const normalized =
    typeof value === "string" && value.startsWith("sha256:")
      ? value.slice(7)
      : value;
  if (typeof normalized !== "string" || !SHA256.test(normalized)) {
    throw new Error("artifact archive digest must be a lowercase sha256");
  }
  return normalized;
}

function positiveInteger(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return number;
}

function normalizedInstant(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO 8601 instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO 8601 instant`);
  }
  return new Date(milliseconds).toISOString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

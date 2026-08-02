import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

export const GITHUB_CLI_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const GITHUB_CLI_BINARY_MAX_BYTES = 64 * 1024 * 1024;
const GITHUB_CLI_EXPANDED_TAR_MAX_BYTES = 128 * 1024 * 1024;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_FLAG = 1 << 3;
const ZIP_UTF8_FLAG = 1 << 11;
const ZIP_ALLOWED_FLAGS = ZIP_DATA_DESCRIPTOR_FLAG | ZIP_UTF8_FLAG;
const ZIP_UNIX_HOST = 3;
const ZIP_UNIX_FILE_TYPE_MASK = 0xf000;
const ZIP_UNIX_REGULAR_FILE = 0x8000;
const ZIP_DOS_DIRECTORY_ATTRIBUTE = 0x10;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : null;
}

function requireRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > buffer.length ||
    length > buffer.length - offset
  ) {
    throw new Error(`GitHub CLI ${label} is truncated or out of bounds`);
  }
}

function checkedAdd(left, right, label) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < left) {
    throw new Error(`GitHub CLI ${label} overflows its safe bound`);
  }
  return sum;
}

export async function readBoundedResponseBody(
  response,
  maximumBytes = GITHUB_CLI_ARCHIVE_MAX_BYTES
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("GitHub CLI response byte ceiling is invalid");
  }
  const rawLength = response.headers?.get?.("content-length");
  let declaredLength = null;
  if (rawLength !== null && rawLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawLength)) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("GitHub CLI bootstrap Content-Length is invalid");
    }
    declaredLength = Number(rawLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maximumBytes
    ) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error("GitHub CLI bootstrap archive exceeds the byte ceiling");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("GitHub CLI bootstrap response has no readable body");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("GitHub CLI bootstrap response yielded a non-byte chunk");
      }
      if (value.byteLength === 0) continue;
      if (value.byteLength > maximumBytes - total) {
        await reader.cancel("GitHub CLI bootstrap archive exceeds the byte ceiling");
        throw new Error("GitHub CLI bootstrap archive exceeds the byte ceiling");
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  if (total === 0) {
    throw new Error("GitHub CLI bootstrap archive is empty");
  }
  if (declaredLength !== null && total !== declaredLength) {
    throw new Error("GitHub CLI bootstrap body length does not match Content-Length");
  }
  return Buffer.concat(chunks, total);
}

export function extractGithubCliBinary(
  archiveBytes,
  asset,
  maximumBinaryBytes = GITHUB_CLI_BINARY_MAX_BYTES
) {
  const archive = Buffer.from(archiveBytes);
  if (
    archive.length === 0 ||
    archive.length > GITHUB_CLI_ARCHIVE_MAX_BYTES
  ) {
    throw new Error("GitHub CLI archive size is invalid");
  }
  if (
    !asset ||
    typeof asset.directory !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(asset.directory)
  ) {
    throw new Error("GitHub CLI archive directory is invalid");
  }
  if (!Number.isSafeInteger(maximumBinaryBytes) || maximumBinaryBytes <= 0) {
    throw new Error("GitHub CLI extracted binary ceiling is invalid");
  }
  const expectedPath = `${asset.directory}/bin/gh`;
  if (asset.format === "tar.gz") {
    return extractTarGzEntry(archive, expectedPath, maximumBinaryBytes);
  }
  if (asset.format === "zip") {
    return extractZipEntry(archive, expectedPath, maximumBinaryBytes);
  }
  throw new Error(`Unsupported GitHub CLI archive format ${String(asset.format)}`);
}

function extractTarGzEntry(archive, expectedPath, maximumBinaryBytes) {
  let expanded;
  try {
    const result = gunzipSync(archive, {
      maxOutputLength: GITHUB_CLI_EXPANDED_TAR_MAX_BYTES,
      info: true
    });
    if (result.engine.bytesWritten !== archive.length) {
      throw new Error("gzip stream did not consume its exact archive extent");
    }
    expanded = result.buffer;
  } catch (error) {
    throw new Error(
      `GitHub CLI tar.gz is invalid or exceeds its expanded bound: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
  let cursor = 0;
  let found = null;
  let sawTerminator = false;
  while (cursor < expanded.length) {
    requireRange(expanded, cursor, 512, "tar header");
    const header = expanded.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) {
      if (expanded.length - cursor < 1024) {
        throw new Error("GitHub CLI tar terminator is truncated");
      }
      if (!expanded.subarray(cursor).every((byte) => byte === 0)) {
        throw new Error("GitHub CLI tar contains nonzero data after its terminator");
      }
      sawTerminator = true;
      break;
    }
    validateTarChecksum(header);
    const name = tarString(header.subarray(0, 100), "tar name");
    const prefix = tarString(header.subarray(345, 500), "tar prefix", true);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136), "tar entry size");
    const dataStart = checkedAdd(cursor, 512, "tar data offset");
    const dataEnd = checkedAdd(dataStart, size, "tar entry size");
    requireRange(expanded, dataStart, size, `tar entry ${entryPath}`);
    const paddedSize = Math.ceil(size / 512) * 512;
    cursor = checkedAdd(dataStart, paddedSize, "tar padded entry size");
    if (cursor > expanded.length) {
      throw new Error(`GitHub CLI tar padding is truncated for ${entryPath}`);
    }
    if (entryPath !== expectedPath) continue;
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      throw new Error("GitHub CLI tar target is not a regular file");
    }
    if (found !== null) {
      throw new Error("GitHub CLI tar contains duplicate target binaries");
    }
    if (size === 0 || size > maximumBinaryBytes) {
      throw new Error("GitHub CLI tar target size is invalid");
    }
    found = Buffer.from(expanded.subarray(dataStart, dataEnd));
  }
  if (!sawTerminator) {
    throw new Error("GitHub CLI tar has no canonical zero-block terminator");
  }
  if (found === null) {
    throw new Error(`GitHub CLI tar is missing ${expectedPath}`);
  }
  return found;
}

function tarString(field, label, emptyAllowed = false) {
  const nul = field.indexOf(0);
  const raw = field.subarray(0, nul < 0 ? field.length : nul);
  if (raw.some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new Error(`GitHub CLI ${label} is not printable ASCII`);
  }
  const value = raw.toString("ascii");
  if (!emptyAllowed && value.length === 0) {
    throw new Error(`GitHub CLI ${label} is empty`);
  }
  return value;
}

function tarOctal(field, label) {
  if ((field[0] & 0x80) !== 0) {
    throw new Error(`GitHub CLI ${label} uses unsupported base-256 encoding`);
  }
  const value = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(value)) {
    throw new Error(`GitHub CLI ${label} is not canonical octal`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`GitHub CLI ${label} is outside the safe range`);
  }
  return parsed;
}

function validateTarChecksum(header) {
  const expected = tarOctal(header.subarray(148, 156), "tar header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error("GitHub CLI tar header checksum is invalid");
  }
}

function extractZipEntry(archive, expectedPath, maximumBinaryBytes) {
  if (
    archive.length < 22 ||
    archive.readUInt32LE(archive.length - 22) !== ZIP_EOCD_SIGNATURE
  ) {
    throw new Error("GitHub CLI ZIP must end in an un-commented EOCD record");
  }
  const eocd = archive.length - 22;
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    commentLength !== 0 ||
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    totalEntries > 4096 ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("GitHub CLI ZIP disk, count, ZIP64, or comment metadata is invalid");
  }
  if (checkedAdd(centralOffset, centralSize, "ZIP central directory") !== eocd) {
    throw new Error("GitHub CLI ZIP central directory is not contiguous with EOCD");
  }
  let cursor = centralOffset;
  let target = null;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(archive, cursor, 46, "ZIP central header");
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("GitHub CLI ZIP central header is invalid");
    }
    const madeBy = archive.readUInt16LE(cursor + 4);
    const needed = archive.readUInt16LE(cursor + 6);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
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
    requireRange(archive, cursor, recordLength, "ZIP central entry");
    if (
      needed > 63 ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("GitHub CLI ZIP entry uses unsupported version, disk, or ZIP64 metadata");
    }
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipName(rawName);
    if (name === expectedPath) {
      if (target !== null) {
        throw new Error("GitHub CLI ZIP contains duplicate target binaries");
      }
      validateZipTargetMetadata({
        madeBy,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        externalAttributes,
        maximumBinaryBytes
      });
      target = {
        name,
        rawName: Buffer.from(rawName),
        needed,
        flags,
        method,
        crc32: entryCrc,
        compressedSize,
        uncompressedSize,
        localOffset
      };
    }
    cursor += recordLength;
  }
  if (cursor !== eocd) {
    throw new Error("GitHub CLI ZIP central directory size is inconsistent");
  }
  if (target === null) {
    throw new Error(`GitHub CLI ZIP is missing ${expectedPath}`);
  }
  return inflateZipTarget(archive, target, centralOffset);
}

function decodeZipName(rawName) {
  if (
    rawName.length === 0 ||
    rawName.length > 4096 ||
    rawName.includes(0)
  ) {
    throw new Error("GitHub CLI ZIP entry name is invalid");
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    rawName
  );
}

function validateZipTargetMetadata(metadata) {
  if (
    (metadata.flags & 1) !== 0 ||
    (metadata.flags & ~ZIP_ALLOWED_FLAGS) !== 0
  ) {
    throw new Error("GitHub CLI ZIP target uses encrypted or unsupported flags");
  }
  if (metadata.method !== 0 && metadata.method !== 8) {
    throw new Error("GitHub CLI ZIP target compression method is unsupported");
  }
  if (
    metadata.uncompressedSize === 0 ||
    metadata.uncompressedSize > metadata.maximumBinaryBytes ||
    metadata.compressedSize === 0 ||
    (metadata.method === 0 &&
      metadata.compressedSize !== metadata.uncompressedSize)
  ) {
    throw new Error("GitHub CLI ZIP target size is invalid");
  }
  if ((metadata.externalAttributes & ZIP_DOS_DIRECTORY_ATTRIBUTE) !== 0) {
    throw new Error("GitHub CLI ZIP target is a directory");
  }
  if ((metadata.madeBy >>> 8) === ZIP_UNIX_HOST) {
    const fileType =
      (metadata.externalAttributes >>> 16) & ZIP_UNIX_FILE_TYPE_MASK;
    if (fileType !== 0 && fileType !== ZIP_UNIX_REGULAR_FILE) {
      throw new Error("GitHub CLI ZIP target is not a regular file");
    }
  }
}

function inflateZipTarget(archive, entry, centralOffset) {
  const cursor = entry.localOffset;
  requireRange(archive, cursor, 30, "ZIP target local header");
  if (archive.readUInt32LE(cursor) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error("GitHub CLI ZIP target local header is invalid");
  }
  const needed = archive.readUInt16LE(cursor + 4);
  const flags = archive.readUInt16LE(cursor + 6);
  const method = archive.readUInt16LE(cursor + 8);
  const localCrc = archive.readUInt32LE(cursor + 14);
  const localCompressed = archive.readUInt32LE(cursor + 18);
  const localUncompressed = archive.readUInt32LE(cursor + 22);
  const nameLength = archive.readUInt16LE(cursor + 26);
  const extraLength = archive.readUInt16LE(cursor + 28);
  const headerLength = 30 + nameLength + extraLength;
  requireRange(archive, cursor, headerLength, "ZIP target local entry");
  const rawName = archive.subarray(cursor + 30, cursor + 30 + nameLength);
  if (
    needed !== entry.needed ||
    flags !== entry.flags ||
    method !== entry.method ||
    !rawName.equals(entry.rawName)
  ) {
    throw new Error("GitHub CLI ZIP target local and central headers disagree");
  }
  const descriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
  if (!descriptor) {
    if (
      localCrc !== entry.crc32 ||
      localCompressed !== entry.compressedSize ||
      localUncompressed !== entry.uncompressedSize
    ) {
      throw new Error("GitHub CLI ZIP target local sizes or CRC disagree");
    }
  } else if (
    !zeroOrEqual(localCrc, entry.crc32) ||
    !zeroOrEqual(localCompressed, entry.compressedSize) ||
    !zeroOrEqual(localUncompressed, entry.uncompressedSize)
  ) {
    throw new Error("GitHub CLI ZIP target descriptor placeholders disagree");
  }
  const dataStart = checkedAdd(cursor, headerLength, "ZIP target data offset");
  const dataEnd = checkedAdd(
    dataStart,
    entry.compressedSize,
    "ZIP target compressed size"
  );
  if (dataEnd > centralOffset) {
    throw new Error("GitHub CLI ZIP target overlaps the central directory");
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let contents;
  if (entry.method === 0) {
    contents = Buffer.from(compressed);
  } else {
    try {
      const result = inflateRawSync(compressed, {
        maxOutputLength: entry.uncompressedSize,
        info: true
      });
      if (result.engine.bytesWritten !== compressed.length) {
        throw new Error("deflate stream did not consume its exact extent");
      }
      contents = result.buffer;
    } catch (error) {
      throw new Error(
        `GitHub CLI ZIP target deflate data is invalid: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }
  if (
    contents.length !== entry.uncompressedSize ||
    crc32(contents) !== entry.crc32
  ) {
    throw new Error("GitHub CLI ZIP target length or CRC is invalid");
  }
  return contents;
}

function zeroOrEqual(value, expected) {
  return value === 0 || value === expected;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
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

function crc32(value) {
  let checksum = 0xffffffff;
  for (const byte of value) {
    checksum =
      CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export async function canonicalWorkingDirectory(cwd) {
  const absolute = await realpath(path.resolve(cwd));
  const stats = await lstat(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("GitHub CLI verifier working directory must be a real directory");
  }
  return absolute;
}

export function absolutePathGhCandidates(pathValue, cwd) {
  if (!path.isAbsolute(cwd)) {
    throw new Error("GitHub CLI PATH resolution requires an absolute working directory");
  }
  return String(pathValue ?? "")
    .split(path.delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => path.resolve(cwd, directory, "gh"));
}

export async function ensureSafeCacheDirectory(rootDir, components) {
  if (!path.isAbsolute(rootDir)) {
    throw new Error("GitHub CLI cache root must be absolute");
  }
  let current = rootDir;
  await requireSafeDirectory(current, "cache root");
  for (const component of components) {
    if (
      typeof component !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(component) ||
      component === "." ||
      component === ".."
    ) {
      throw new Error("GitHub CLI cache path component is invalid");
    }
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await requireSafeDirectory(current, `cache directory ${component}`);
  }
  return current;
}

async function requireSafeDirectory(directory, label) {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`GitHub CLI ${label} must be a non-symbolic directory`);
  }
  if ((await realpath(directory)) !== directory) {
    throw new Error(`GitHub CLI ${label} must have a canonical parent chain`);
  }
  if (
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  ) {
    throw new Error(`GitHub CLI ${label} must be owned by the current user`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`GitHub CLI ${label} must not be group/world writable`);
  }
}

export async function refuseExistingCacheDestination(destination) {
  if (!path.isAbsolute(destination)) {
    throw new Error("GitHub CLI cache destination must be absolute");
  }
  try {
    const stats = await lstat(destination);
    const kind = stats.isSymbolicLink()
      ? "a symbolic link"
      : stats.isFile()
        ? "an untrusted regular file"
        : "a non-regular entry";
    throw new Error(
      `GitHub CLI cache destination already exists as ${kind}; refusing replacement`
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

export async function installCacheBinaryNoClobber({
  destination,
  binary,
  expectedSha256,
  verifyExecutable
}) {
  if (!path.isAbsolute(destination)) {
    throw new Error("GitHub CLI cache destination must be absolute");
  }
  if (
    typeof expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    sha256(binary) !== expectedSha256
  ) {
    throw new Error("GitHub CLI cache install bytes do not match the pin");
  }
  if (typeof verifyExecutable !== "function") {
    throw new Error("GitHub CLI cache install verifier is missing");
  }
  await refuseExistingCacheDestination(destination);
  const parent = path.dirname(destination);
  await requireSafeDirectory(parent, "cache destination parent");
  const temporary = path.join(
    parent,
    `.gh-install-${process.pid}-${randomBytes(16).toString("hex")}`
  );
  let handle = null;
  let linked = false;
  let temporaryStats = null;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o700
    );
    await handle.writeFile(binary);
    await handle.chmod(0o700);
    await handle.sync();
    await handle.close();
    handle = null;
    temporaryStats = await lstat(temporary);
    if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink()) {
      throw new Error("GitHub CLI cache temporary is not a regular file");
    }
    if (!(await verifyExecutable(temporary))) {
      throw new Error("GitHub CLI cache temporary does not verify");
    }
    try {
      await link(temporary, destination);
      linked = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(
          "GitHub CLI cache destination appeared during install; refusing replacement"
        );
      }
      throw error;
    }
    const installedStats = await lstat(destination);
    if (
      !installedStats.isFile() ||
      installedStats.isSymbolicLink() ||
      installedStats.dev !== temporaryStats.dev ||
      installedStats.ino !== temporaryStats.ino
    ) {
      throw new Error("GitHub CLI cache install did not preserve the exclusive file");
    }
    if (!(await verifyExecutable(destination))) {
      throw new Error("GitHub CLI cached binary does not verify after install");
    }
    return destination;
  } catch (error) {
    if (linked && temporaryStats !== null) {
      try {
        const installedStats = await lstat(destination);
        if (
          installedStats.dev === temporaryStats.dev &&
          installedStats.ino === temporaryStats.ino
        ) {
          await unlink(destination);
        }
      } catch {
        // Leave any path that no longer names our exact inode untouched.
      }
    }
    throw error;
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export async function readRegularFileNoFollow(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("GitHub CLI executable path must be absolute");
  }
  const pathStats = await lstat(filePath);
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new Error("GitHub CLI executable must be a non-symbolic regular file");
  }
  if ((await realpath(filePath)) !== filePath) {
    throw new Error("GitHub CLI executable path must be canonical");
  }
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK
    );
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("GitHub CLI executable must be a regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytes.length !== before.size
    ) {
      throw new Error("GitHub CLI executable changed while being read");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

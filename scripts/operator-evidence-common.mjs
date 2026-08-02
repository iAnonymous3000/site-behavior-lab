import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  realpath,
  unlink
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);
let sharedCanonicalSerializer;

export const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const CANONICAL_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value, expected, label, problems) {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    problems.push(`${label} must contain exactly ${canonical.join(", ")}`);
    return false;
  }
  return true;
}

export function isCanonicalInstant(value) {
  if (typeof value !== "string" || !CANONICAL_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

export function requireCanonicalInstant(value, label, problems) {
  if (!isCanonicalInstant(value)) {
    problems.push(`${label} must be a canonical millisecond-precision UTC instant`);
    return null;
  }
  return new Date(value).getTime();
}

export function requireCommit(value, label, problems) {
  if (typeof value !== "string" || !FULL_GIT_SHA_PATTERN.test(value)) {
    problems.push(`${label} must be a full lowercase Git commit`);
    return false;
  }
  return true;
}

export function requireSha256(value, label, problems) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    problems.push(`${label} must be a lowercase sha256 digest`);
    return false;
  }
  return true;
}

export function boundedString(value, { maximum = 512, pattern } = {}) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    (pattern === undefined || pattern.test(value))
  );
}

function sharedCanonicalJson(value) {
  if (sharedCanonicalSerializer === undefined) {
    for (const candidate of [
      "../dist/schema/lib/canonical-json.js",
      "../.unit-test-dist/lib/canonical-json.js"
    ]) {
      try {
        const loaded = requireFromHere(candidate);
        if (typeof loaded.canonicalJson === "function") {
          sharedCanonicalSerializer = loaded.canonicalJson;
          break;
        }
      } catch {
        // Production commands compile tsconfig.schema.json first; unit tests
        // compile the same source into .unit-test-dist.
      }
    }
    if (sharedCanonicalSerializer === undefined) {
      throw new Error(
        "the shared canonical JSON module is unavailable; compile tsconfig.schema.json first"
      );
    }
  }
  return sharedCanonicalSerializer(value);
}

/**
 * Canonical evidence bytes use recursively sorted JSON keys, no insignificant
 * whitespace, UTF-8, and one trailing LF. Arrays retain their declared order.
 */
export function serializeCanonicalEvidence(value) {
  return `${sharedCanonicalJson(value)}\n`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalEvidenceDigest(value) {
  return sha256Bytes(serializeCanonicalEvidence(value));
}

export function parseCanonicalEvidence(bytes, label = "evidence") {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (serializeCanonicalEvidence(value) !== bytes) {
    throw new Error(`${label} is not in canonical evidence serialization`);
  }
  return value;
}

export async function readBoundedNoFollowUtf8(
  inputPath,
  label,
  maximumBytes
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes must be a positive safe integer");
  }
  let handle;
  try {
    handle = await open(
      inputPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      ["ELOOP", "EISDIR"].includes(error.code)
    ) {
      throw new Error(`${label} must be a regular file, not a symbolic link or directory`);
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
    if (info.size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte input limit`);
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximumBytes + 1 - total)
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) {
        throw new Error(`${label} exceeds the ${maximumBytes}-byte input limit`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true
      }).decode(
        Buffer.concat(chunks, total)
      );
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function resolveTrustedOutputPath(
  outputPath,
  trustedRoot = process.cwd()
) {
  const rootResolved = path.resolve(trustedRoot);
  const rootReal = await realpath(rootResolved);
  if (rootReal !== rootResolved) {
    throw new Error("trusted output root must not be reached through a symbolic link");
  }
  const requested = path.resolve(outputPath);
  const requestedParent = path.dirname(requested);
  const parentReal = await realpath(requestedParent);
  const resolvedOutput = path.join(parentReal, path.basename(requested));
  const relative = path.relative(rootReal, resolvedOutput);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("output must stay inside the trusted repository root");
  }
  if (parentReal !== requestedParent) {
    throw new Error("output parent chain must not contain symbolic links");
  }
  let cursor = rootReal;
  for (const component of path.relative(rootReal, parentReal).split(path.sep)) {
    if (component.length === 0) continue;
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("output parent chain must contain only real directories");
    }
  }
  return resolvedOutput;
}

/** Write once, without following a final symlink, and remove partial output. */
export async function writeExclusive(
  outputPath,
  bytes,
  mode = 0o600,
  trustedRoot = process.cwd()
) {
  const resolvedOutput = await resolveTrustedOutputPath(outputPath, trustedRoot);
  let handle;
  try {
    handle = await open(
      resolvedOutput,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      mode
    );
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      ["EEXIST", "ELOOP", "EISDIR"].includes(error.code)
    ) {
      throw new Error("output must not already exist as a file, directory, or symbolic link");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("output could not be created as a regular file");
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(resolvedOutput).catch(() => undefined);
    throw error;
  }
}

/**
 * Publish complete bytes atomically without overwriting an existing path.
 * A fully written, fsynced sibling inode is hard-linked into place, so the
 * final name is either absent or points at the complete file. Neither the
 * parent chain nor the final name may be a symbolic link.
 */
export async function writeExclusiveAtomic(
  outputPath,
  bytes,
  mode = 0o600,
  trustedRoot = process.cwd()
) {
  const resolvedOutput = await resolveTrustedOutputPath(outputPath, trustedRoot);
  const parent = path.dirname(resolvedOutput);
  const temporary = path.join(
    parent,
    `.${path.basename(resolvedOutput)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  );
  let handle;
  let linked = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      mode
    );
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error("temporary output could not be created as a regular file");
    }
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, resolvedOutput);
      linked = true;
    } catch (error) {
      if (
        isRecord(error) &&
        typeof error.code === "string" &&
        ["EEXIST", "ELOOP", "EISDIR"].includes(error.code)
      ) {
        throw new Error(
          "output must not already exist as a file, directory, or symbolic link"
        );
      }
      throw error;
    }
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (linked) await unlink(resolvedOutput).catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

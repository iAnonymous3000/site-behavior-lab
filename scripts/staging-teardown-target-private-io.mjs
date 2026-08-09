import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES } from "./staging-teardown-provider-http.mjs";

const RAW_NAME = /^(\d{3})\.(cloudflare|github)\.[a-z0-9][a-z0-9.-]{0,80}\.json$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function currentOwner(info, label) {
  if (typeof process.getuid === "function") {
    requireValue(info.uid === process.getuid(), `${label} must be owned by the current user`);
  }
}

function canonicalChildPath(input, label) {
  const requested = path.resolve(input);
  const parent = path.dirname(requested);
  const canonicalParent = realpathSync(parent);
  const parentInfo = lstatSync(canonicalParent);
  requireValue(
    parentInfo.isDirectory() && !parentInfo.isSymbolicLink(),
    `${label} parent must resolve to one real directory`
  );
  return path.join(canonicalParent, path.basename(requested));
}

function exactPrivateDirectory(directory) {
  const absolute = canonicalChildPath(directory, "private provider response directory");
  const info = lstatSync(absolute);
  requireValue(
    info.isDirectory() && !info.isSymbolicLink() && realpathSync(absolute) === absolute,
    "private provider response directory must be a real non-symbolic-link directory"
  );
  requireValue(
    (info.mode & 0o777) === 0o700,
    "private provider response directory must have mode 0700"
  );
  currentOwner(info, "private provider response directory");
  return absolute;
}

export function createIndexedPrivateResponseSink(directory) {
  const absolute = canonicalChildPath(directory, "private provider response directory");
  requireValue(
    !existsSync(absolute),
    "private provider response directory must not already exist"
  );
  mkdirSync(absolute, { recursive: false, mode: 0o700 });
  exactPrivateDirectory(absolute);
  let expectedIndex = 1;
  return Object.freeze({
    directory: absolute,
    async persistRaw(name, bytes) {
      exactPrivateDirectory(absolute);
      const match = typeof name === "string" ? name.match(RAW_NAME) : null;
      requireValue(
        match !== null && Number(match[1]) === expectedIndex,
        "private provider response names must be strictly indexed"
      );
      requireValue(
        Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
        "private provider response must contain exact bytes"
      );
      requireValue(
        bytes.byteLength <= STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES,
        "private provider response exceeds the bounded byte limit"
      );
      const destination = path.join(absolute, name);
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      const info = lstatSync(destination);
      requireValue(
        info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 &&
          info.size === bytes.byteLength,
        "private provider response was not persisted as one exact mode-0600 file"
      );
      currentOwner(info, "private provider response file");
      expectedIndex += 1;
    },
    count() {
      return expectedIndex - 1;
    }
  });
}

export function destroyIndexedPrivateResponseDirectory(directory) {
  const absolute = exactPrivateDirectory(directory);
  rmSync(absolute, { recursive: true, force: false });
  requireValue(
    !existsSync(absolute),
    "private provider response bytes were not destroyed"
  );
}

export function readMode0600SecretFile(file) {
  const absolute = canonicalChildPath(file, "capture credential file");
  const info = lstatSync(absolute);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && realpathSync(absolute) === absolute,
    "capture credential file must be one real non-symbolic-link file"
  );
  requireValue(
    (info.mode & 0o777) === 0o600 && info.size >= 20 && info.size <= 4_098,
    "capture credential file must be mode 0600 with bounded bytes"
  );
  currentOwner(info, "capture credential file");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
  } catch {
    throw new Error("capture credential file must contain UTF-8 text");
  }
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  requireValue(
    text.length >= 20 && text.length <= 4_096 && text === text.trim() && !/\s/.test(text),
    "capture credential file must contain one bounded non-whitespace value"
  );
  return text;
}

export function assertMode0700OutputParent(file) {
  const absolute = canonicalChildPath(file, "target-manifest output");
  const parent = path.dirname(absolute);
  const parentInfo = statSync(parent);
  requireValue(
    parentInfo.isDirectory() && !parentInfo.isSymbolicLink() && realpathSync(parent) === parent &&
      (parentInfo.mode & 0o777) === 0o700,
    "target-manifest output parent must be a real mode-0700 directory"
  );
  currentOwner(parentInfo, "target-manifest output parent");
  return path.join(parent, path.basename(absolute));
}

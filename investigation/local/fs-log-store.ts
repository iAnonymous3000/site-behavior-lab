// The case log's stores on a local filesystem, for tests and local historical
// ingestion. Node only: nothing the Worker reaches may import this folder
// (investigation/test/workspace-boundaries.test.ts).
//
//   <root>/entries/<digest>    create-only entry objects
//   <root>/evidence/<digest>   create-only evidence objects
//   <root>/head/<slot>         the head, apart from both
//   <root>/tmp/                writes in progress, read by nothing
//
// Each write goes to a new temp file and is synced before it appears under its real
// name, as M1 does, and the directory is synced after. A process killed at any
// moment leaves either no trace under a real name or a complete file, and holds
// nothing another process waits on.
//
// M1 publishes with rename, and this does not, for a stated reason: rename replaces
// its target, so it can give neither promise here. Create-only would overwrite an
// object that exists, and a compare-and-swap built as read, compare, rename would let
// two writers both pass the compare and the second silently erase the first. A hard
// link fails when the name is taken, atomically, and the kernel decides the winner.
// So the head is not one file: each swap creates the next numbered slot holding the
// new value, the highest slot is the head, and a writer that loses the slot loses the
// swap. There is no lock to go stale after a kill.
//
// A read opens the file once, without waiting on a FIFO or following a link at the file
// itself, and decides from that one open file: only a regular file within the bound is
// read. A folder of the log that is a link, or open to anyone else, is refused when the
// stores are opened and when the folder is prepared. One swapped after that is not seen.
// A slot removed by hand moves the head back, and a removed newest entry is caught
// because the head still names it. Rewriting both is the limit case-log.ts states.

import * as nodeFs from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import type { HeadStore, LogStores, ObjectStore, UnreadableObject } from "../core/case-log";
import { isDigest, MAX_HEAD_CHARS } from "../core/case-log";

export type FsOps = Pick<
  typeof nodeFs,
  "closeSync" | "fstatSync" | "fsyncSync" | "linkSync" | "lstatSync" | "mkdirSync" | "openSync" | "readSync" | "readdirSync" | "unlinkSync" | "writeSync"
>;

const SLOT_DIGITS = 12;
const SLOT = /^[0-9]{12}$/;
/** Past this a slot's name would stop matching SLOT, and a swap would land where no read looks. */
const LAST_SLOT = 10 ** SLOT_DIGITS - 1;
/** Numeric flags, which is how a read's open tells itself from a write's. */
const READ_FLAGS = nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK;
/** Nothing outside this user may read a log or change one. */
const PRIVATE_MODE = 0o700;
const FOLDERS = ["entries", "evidence", "head", "tmp"] as const;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isTaken(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * A symbolic link, under O_NOFOLLOW, and a socket refuse to open at all. Read by number:
 * Node has no name for what macOS answers about a socket, so the code is "Unknown system error".
 */
function isNotOpenable(error: unknown): boolean {
  const { ELOOP, ENXIO, EOPNOTSUPP } = osConstants.errno;
  return [ELOOP, ENXIO, EOPNOTSUPP].includes(Math.abs(Number((error as NodeJS.ErrnoException).errno)));
}

function syncDirectory(ops: FsOps, directory: string): void {
  const handle = ops.openSync(directory, "r");
  ops.fsyncSync(handle);
  ops.closeSync(handle);
}

/** A complete, synced temp file, ready to appear under its real name in one step. */
function writeTemp(ops: FsOps, root: string, bytes: Uint8Array): string {
  const temp = path.join(root, "tmp", `${process.pid}-${crypto.randomUUID()}`);
  const handle = ops.openSync(temp, "wx", 0o600);
  let written = 0;
  while (written < bytes.length) written += ops.writeSync(handle, bytes, written);
  ops.fsyncSync(handle);
  ops.closeSync(handle);
  return temp;
}

/** True when this call created `target`. False when the name was taken, which changes nothing. */
function publish(ops: FsOps, root: string, target: string, bytes: Uint8Array): boolean {
  const temp = writeTemp(ops, root, bytes);
  let created = true;
  try {
    ops.linkSync(temp, target);
  } catch (error) {
    if (!isTaken(error)) throw error;
    created = false;
  }
  // Also when taken: the writer that created it may have died before this sync, and
  // what this caller does next must not rest on a name a power loss could undo.
  syncDirectory(ops, path.dirname(target));
  ops.unlinkSync(temp);
  return created;
}

/** The file's bytes, or null for nothing there, without holding more than the bound or waiting on anything. */
function readRegular(ops: FsOps, file: string, maxBytes: number): Uint8Array<ArrayBuffer> | UnreadableObject | null {
  let handle: number;
  try {
    handle = ops.openSync(file, READ_FLAGS);
  } catch (error) {
    if (isMissing(error)) return null;
    if (isNotOpenable(error)) return "not-an-object";
    throw error;
  }
  try {
    const stats = ops.fstatSync(handle);
    if (!stats.isFile()) return "not-an-object";
    if (stats.size > maxBytes) return "too-large";
    const bytes = new Uint8Array(stats.size);
    let read = 0;
    while (read < bytes.length) {
      const got = ops.readSync(handle, bytes, read, bytes.length - read, read);
      // Shorter than it said a moment ago, so what it holds is not what was written.
      if (got === 0) return "not-an-object";
      read += got;
    }
    return bytes;
  } finally {
    ops.closeSync(handle);
  }
}

function objectStore(ops: FsOps, root: string, kind: "entries" | "evidence"): ObjectStore {
  const fileFor = (address: string): string => {
    // A digest is the only thing that may reach a path.
    if (!isDigest(address)) throw new Error(`Not an object address: ${JSON.stringify(address)}`);
    return path.join(root, kind, address);
  };
  return {
    async createOnly(address, bytes) {
      return publish(ops, root, fileFor(address), bytes) ? "created" : "exists";
    },
    async read(address, maxBytes) {
      return readRegular(ops, fileFor(address), maxBytes);
    }
  };
}

function headStore(ops: FsOps, root: string): HeadStore {
  const directory = path.join(root, "head");
  const slotName = (slot: number): string => String(slot).padStart(SLOT_DIGITS, "0");

  /** The highest slot, read directly. Anything else in the folder, such as a .DS_Store, is not a slot. */
  const current = (maxChars: number): { slot: number; value: string } | null => {
    let names: string[];
    try {
      names = ops.readdirSync(directory);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const highest = names.filter((name) => SLOT.test(name)).sort().at(-1);
    if (highest === undefined) return null;
    const bytes = readRegular(ops, path.join(directory, highest), maxChars);
    // Whatever cannot be read as a head reads as no digest, and the log refuses that as malformed.
    return { slot: Number(highest), value: bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : "" };
  };

  return {
    async read(maxChars) {
      const now = current(maxChars);
      return now === null ? null : now.value;
    },
    async compareAndSwap(expected, next) {
      if (!isDigest(next)) throw new Error(`Not a head: ${JSON.stringify(next)}`);
      const now = current(MAX_HEAD_CHARS);
      const value = now === null ? null : now.value;
      if (value !== expected) return false;
      const slot = now === null ? 1 : now.slot + 1;
      if (slot > LAST_SLOT) throw new Error(`The head has no slot past ${slotName(LAST_SLOT)}`);
      return publish(ops, root, path.join(directory, slotName(slot)), new TextEncoder().encode(next));
    }
  };
}

/** A folder of the log that is a link, or open to anyone else, is refused rather than used. One not there yet is nobody's. */
function refuseUnsafeFolders(ops: FsOps, root: string): void {
  for (const folder of [root, ...FOLDERS.map((name) => path.join(root, name))]) {
    let stats: nodeFs.Stats;
    try {
      stats = ops.lstatSync(folder);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
      throw new Error(`Not a folder private to this user: ${folder} (mode ${(stats.mode & 0o777).toString(8)})`);
    }
  }
}

/**
 * The stores over `root`, which must hold a prepared directory. Nothing is cached, so
 * this reads the disk every time. Resolved first, since a trailing slash on a link would
 * make the check below read what it points to.
 */
export function fsLogStores(root: string, ops: FsOps = nodeFs): LogStores {
  const resolved = path.resolve(root);
  refuseUnsafeFolders(ops, resolved);
  return { entries: objectStore(ops, resolved, "entries"), evidence: objectStore(ops, resolved, "evidence"), head: headStore(ops, resolved) };
}

/**
 * Create the folders a log needs, private to this user. Safe to repeat. A folder that
 * is already there and open to anyone else is refused rather than used, since a mode
 * given to mkdir changes nothing that exists. Creates no head: that is createLog.
 */
export function prepareFsLogDirectory(root: string, ops: FsOps = nodeFs): void {
  const resolved = path.resolve(root);
  const folders = FOLDERS.map((name) => path.join(resolved, name));
  // Before anything is made, so a link at the root leaves its target's contents alone.
  refuseUnsafeFolders(ops, resolved);
  for (const folder of folders) ops.mkdirSync(folder, { recursive: true, mode: PRIVATE_MODE });
  for (const folder of folders) syncDirectory(ops, folder);
  syncDirectory(ops, resolved);
  syncDirectory(ops, path.dirname(resolved));
}

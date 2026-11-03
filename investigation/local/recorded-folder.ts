// Reading a recorded run's folder for an import, read only. Node only: nothing the Worker reaches
// may import this folder (investigation/test/workspace-boundaries.test.ts).
//
// The adapters in investigation/core say which paths inside the folder they need, and this opens
// those and nothing else, so a large output no question needs is never read. Every path is relative
// to the folder and held to the core's rule for one (isInsidePath), so none can name its way out.
// Each component on the way to a file, the folder itself included, is checked, and a symbolic link
// anywhere on the path is refused, not followed. The file itself is opened once without following a
// link or waiting on a FIFO, and the open file must be the very file the last check saw (the same
// device and inode), or it was swapped and is refused. After the open every component, the folder
// included, is checked again: each must still be the directory the first walk saw, by device and
// inode, and none a link, so a folder swapped for a link during the walk is refused too. What stays
// open is a swap and a swap back timed around both walks: Node has no openat, so a path is resolved
// again at each step. A file with a second hard link is refused, since its other name can sit
// outside the folder, and two paths asked for in one read that open one file (two names that fold to
// one on a volume that ignores case or composition) are refused as one file; a caller that reads in
// rounds is held to this within each round. Only a regular file within the bound is read. A path
// asked for and not there comes back as null, for the adapter to call missing.
//
// Folding lives in two places. The harness-runs adapter compares run names after folding case and
// composition (foldedName in capture-adapter.ts); this reader refuses any two paths that reach one
// file, whatever folded them, which also covers saved-script paths, whose mirrored names are matched
// case-sensitively below.
//
// A refusal never names a path by its text, since a path can mirror a URL or carry a folder named for
// a site: it names it by the name the caller passes for it (the adapter's manifest entry for a saved
// script, a trial folder's place), and otherwise by its place in the list asked for (paths[3]). A
// listing names a link or other entry below a folder of saved script files by its place in the same way.
//
// A listing walks the folder the same way: it descends into real directories only and names each
// link it met without following it, so a caller can report each one. Nothing here writes, renames or
// deletes anything.

import * as nodeFs from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { isInsidePath, mirroredFolder } from "../core/recorder-shapes";

export type FolderOps = Pick<typeof nodeFs, "closeSync" | "fstatSync" | "lstatSync" | "openSync" | "readSync" | "readdirSync">;

/** Larger than any output a recorded question needs here, and far smaller than the analysis outputs no question reads. */
export const MAX_RECORDED_FILE_BYTES = 48 * 1024 * 1024;

const READ_FLAGS = nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK;


export type FolderListing = Readonly<{ files: readonly string[]; links: readonly string[]; other: readonly string[] }>;

export type FolderRefusal = Readonly<{ ok: false; refusal: "not-a-folder" | "path-outside" | "link-in-path" | "swapped" | "hard-link" | "same-file" | "not-a-file" | "too-large"; at: string }>;

export type ListResult = Readonly<{ ok: true; listing: FolderListing }> | FolderRefusal;

export type ReadResult = Readonly<{ ok: true; files: ReadonlyMap<string, Uint8Array | null> }> | FolderRefusal;

export type ReadOptions = Readonly<{ maxBytes?: number; names?: ReadonlyMap<string, string> }>;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isNotFolder(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOTDIR";
}

/** The handle opened is the file the last check saw: the same device and the same inode. */
function sameFile(opened: nodeFs.Stats, checked: nodeFs.Stats): boolean {
  const { dev: openedDevice, ino: openedInode } = opened;
  const { dev: checkedDevice, ino: checkedInode } = checked;
  return openedDevice === checkedDevice && openedInode === checkedInode;
}

function isLinkRefusal(error: unknown): boolean {
  const { ELOOP, EMLINK } = osConstants.errno;
  return [ELOOP, EMLINK].includes(Math.abs(Number((error as NodeJS.ErrnoException).errno)));
}

/** A place a walk passed: its path and the device and inode it had then. */
type Seen = Readonly<{ path: string; stats: nodeFs.Stats }>;

/** The folder itself must be a real directory. A link at the root is refused, since its target is somewhere else. */
function rootOf(root: string, ops: FolderOps): Seen | FolderRefusal {
  const resolved = path.resolve(root);
  let stats: nodeFs.Stats;
  try {
    stats = ops.lstatSync(resolved);
  } catch {
    return { ok: false, refusal: "not-a-folder", at: "." };
  }
  return stats.isDirectory() ? { path: resolved, stats } : { ok: false, refusal: "not-a-folder", at: "." };
}

function isRefusal(value: Seen | FolderRefusal): value is FolderRefusal {
  return "ok" in value;
}

/** A path as a listing shows it: as it is, unless it sits below a folder of saved script files. */
function shown(relative: string, fallback: string): string {
  const folder = mirroredFolder(relative);
  return folder === null ? relative : `${folder}#${fallback}`;
}

/** Every regular file under the folder, by its path inside it, with the links met and anything else, each sorted. A link below saved script files is named by its place. */
export function listRecordedFolder(root: string, ops: FolderOps = nodeFs): ListResult {
  const top = rootOf(root, ops);
  if (isRefusal(top)) return top;
  const resolved = top.path;
  const files: string[] = [];
  const links: string[] = [];
  const other: string[] = [];
  const walk = (relative: string): void => {
    const directory = relative === "" ? resolved : path.join(resolved, relative);
    for (const name of ops.readdirSync(directory).sort()) {
      const inside = relative === "" ? name : `${relative}/${name}`;
      const stats = ops.lstatSync(path.join(directory, name));
      if (stats.isSymbolicLink()) links.push(shown(inside, `link${links.length + 1}`));
      else if (stats.isDirectory()) walk(inside);
      else if (stats.isFile()) files.push(inside);
      else other.push(shown(inside, `other${other.length + 1}`));
    }
  };
  walk("");
  return { ok: true, listing: { files: files.sort(), links: links.sort(), other: other.sort() } };
}

/** One file's bytes, null when it is not there, or a refusal naming the file as `name`. `opened` holds each file read so far by device and inode. */
function readOne(root: Seen, relative: string, name: string, maxBytes: number, ops: FolderOps, opened: Set<string>): Uint8Array | null | FolderRefusal {
  if (!isInsidePath(relative)) return { ok: false, refusal: "path-outside", at: name };
  const walked: Seen[] = [root];
  let current = root.path;
  let leaf: nodeFs.Stats | null = null;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      leaf = ops.lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return null;
      // A component before this one is not a folder, so nothing is under it to read.
      if (isNotFolder(error)) return { ok: false, refusal: "not-a-file", at: name };
      throw error;
    }
    if (leaf.isSymbolicLink()) return { ok: false, refusal: "link-in-path", at: name };
    walked.push({ path: current, stats: leaf });
  }
  let handle: number;
  try {
    handle = ops.openSync(current, READ_FLAGS);
  } catch (error) {
    if (isMissing(error)) return null;
    if (isLinkRefusal(error)) return { ok: false, refusal: "link-in-path", at: name };
    return { ok: false, refusal: "not-a-file", at: name };
  }
  try {
    const stats = ops.fstatSync(handle);
    if (!stats.isFile()) return { ok: false, refusal: "not-a-file", at: name };
    // The file opened must be the one the last check saw: a name swapped for another file in between is not.
    if (leaf === null || !sameFile(stats, leaf)) return { ok: false, refusal: "swapped", at: name };
    // And every place on the way, the folder included, must still be what the walk saw, and none a link now.
    for (const seen of walked) {
      let again: nodeFs.Stats;
      try {
        again = ops.lstatSync(seen.path);
      } catch {
        return { ok: false, refusal: "swapped", at: name };
      }
      if (again.isSymbolicLink()) return { ok: false, refusal: "link-in-path", at: name };
      if (!sameFile(again, seen.stats)) return { ok: false, refusal: "swapped", at: name };
    }
    // A second name for the same bytes can sit anywhere, so the file may not be inside the folder at all.
    if (stats.nlink > 1) return { ok: false, refusal: "hard-link", at: name };
    // Two paths asked for that open one file are two names for it, as a volume that folds case gives.
    const { dev: device, ino: inode } = stats;
    const identity = `${device}:${inode}`;
    if (opened.has(identity)) return { ok: false, refusal: "same-file", at: name };
    opened.add(identity);
    if (stats.size > maxBytes) return { ok: false, refusal: "too-large", at: name };
    const bytes = new Uint8Array(stats.size);
    let read = 0;
    while (read < bytes.length) {
      const got = ops.readSync(handle, bytes, read, bytes.length - read, read);
      if (got === 0) return { ok: false, refusal: "not-a-file", at: name };
      read += got;
    }
    return bytes;
  } finally {
    ops.closeSync(handle);
  }
}

/** The bytes of exactly these paths inside the folder. The first refusal refuses the whole read. */
export function readRecordedFiles(root: string, paths: readonly string[], options: ReadOptions = {}, ops: FolderOps = nodeFs): ReadResult {
  const top = rootOf(root, ops);
  if (isRefusal(top)) return top;
  const maxBytes = options.maxBytes ?? MAX_RECORDED_FILE_BYTES;
  const files = new Map<string, Uint8Array | null>();
  const opened = new Set<string>();
  for (const [index, relative] of paths.entries()) {
    // A refusal names a path by the name the caller gave it, and otherwise by its place in the request, never by its text.
    const bytes = readOne(top, relative, options.names?.get(relative) ?? `paths[${index}]`, maxBytes, ops, opened);
    if (bytes !== null && !(bytes instanceof Uint8Array)) return bytes;
    files.set(relative, bytes);
  }
  return { ok: true, files };
}

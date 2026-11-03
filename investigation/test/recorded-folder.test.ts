import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as production from "../local/recorded-folder";

/**
 * The local reader of a recorded folder: it opens exactly the paths it is given, refuses a link
 * anywhere on a path, a file swapped between its check and its open, a file with a second hard link
 * and any path that would leave the folder, never names a saved script by the path that mirrors its
 * URL, never follows a link while listing, and writes nothing.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../local/recorded-folder"), edits);

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A recorded folder, a sibling outside it, and links that point out of it, at the first component, in the middle and at the leaf. */
function folder(): Readonly<{ root: string; outside: string }> {
  const base = mkdtempSync(path.join(tmpdir(), "sbl-recorded-"));
  roots.push(base);
  const root = path.join(base, "run");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "runs", "first"), { recursive: true });
  mkdirSync(path.join(root, "runs", "first", "exported", "files", "origins"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.json"), '{"outside":true}');
  writeFileSync(path.join(root, "runs", "first", "row.json"), '{"ms":1}');
  writeFileSync(path.join(root, "notes.md"), "notes");
  symlinkSync(path.join(outside, "secret.json"), path.join(root, "runs", "first", "linked.json"));
  symlinkSync(outside, path.join(root, "runs", "away"));
  symlinkSync(outside, path.join(root, "top"));
  symlinkSync(path.join(outside, "secret.json"), path.join(root, "runs", "first", "exported", "files", "origins", "mirror.js"));
  return { root, outside };
}

test("exactly the paths given are read, and a path not there comes back as null", () => {
  const { root } = folder();
  let read: production.ReadResult | undefined;
  // A path not there, at its last component or before it, is an answer, not an error.
  assert.doesNotThrow(() => {
    read = production.readRecordedFiles(root, ["runs/first/row.json", "runs/first/absent.json", "runs/none/row.json"]);
  });
  const result = read as production.ReadResult;
  assert.ok(result.ok);
  assert.deepEqual([...result.files.keys()], ["runs/first/row.json", "runs/first/absent.json", "runs/none/row.json"]);
  assert.equal(new TextDecoder().decode(result.files.get("runs/first/row.json") as Uint8Array), '{"ms":1}');
  assert.equal(result.files.get("runs/first/absent.json"), null);
  assert.equal(result.files.get("runs/none/row.json"), null);
});

const CONTAINED = "nothing outside the folder is read, or even opened, through a link, a second hard link or a path";

const checkContained = (module: Module, root: string) => {
  for (const [relative, refusal] of [
    ["top/secret.json", "link-in-path"],
    ["runs/first/linked.json", "link-in-path"],
    ["runs/away/secret.json", "link-in-path"],
    ["../outside/secret.json", "path-outside"],
    ["runs/../../outside/secret.json", "path-outside"],
    ["/etc/hosts", "path-outside"],
    ["runs//first/row.json", "path-outside"],
    ["runs\\first\\row.json", "path-outside"],
    ["runs/first/row.json/more", "not-a-file"],
    ["hard.json", "hard-link"]
  ] as const) {
    const opened: string[] = [];
    const recording: production.FolderOps = { ...nodeFs, openSync: ((file: nodeFs.PathLike, flag: number) => (opened.push(String(file)), nodeFs.openSync(file, flag))) as typeof nodeFs.openSync };
    const result = module.readRecordedFiles(root, [relative], {}, recording);
    // A link is refused where the walk meets it, before anything past it is opened.
    holds(CONTAINED, !result.ok && result.refusal === refusal && (refusal !== "link-in-path" || opened.length === 0), () => ({ relative, opened, result: result.ok ? [...result.files.entries()].map(([key, value]) => [key, value === null ? null : new TextDecoder().decode(value)]) : result }));
  }
};

test("a link anywhere on a path, at its first component included, a second hard link, or a path that leaves the folder, is refused", async () => {
  const { root, outside } = folder();
  linkSync(path.join(outside, "secret.json"), path.join(root, "hard.json"));
  checkContained(production, root);
  assert.deepEqual(production.readRecordedFiles(root, ["top/secret.json"]), { ok: false, refusal: "link-in-path", at: "paths[0]" });
  await assertCaughtBy("a reader that checks only the last component", CONTAINED, () =>
    checkContained(variant({ find: 'if (leaf.isSymbolicLink())\n            return { ok: false, refusal: "link-in-path", at: name };', replace: 'if (leaf.isSymbolicLink() && segment === relative.split("/").at(-1))\n            return { ok: false, refusal: "link-in-path", at: name };' }), root)
  );
  await assertCaughtBy("a reader that trusts any relative path", CONTAINED, () =>
    checkContained(variant({ find: 'if (!(0, recorder_shapes_1.isInsidePath)(relative))\n        return { ok: false, refusal: "path-outside", at: name };', replace: "" }), root)
  );
  await assertCaughtBy("a reader that reads a file with a second name", CONTAINED, () => checkContained(variant({ find: 'if (stats.nlink > 1)\n            return { ok: false, refusal: "hard-link", at: name };', replace: "" }), root));
  await assertCaughtBy("a reader that calls a path through a file missing", CONTAINED, () => checkContained(variant({ find: 'if (isNotFolder(error))\n                return { ok: false, refusal: "not-a-file", at: name };', replace: "if (isNotFolder(error))\n                return null;" }), root));
});

test("a file swapped for another between its check and its open is refused", () => {
  const { root, outside } = folder();
  // Ops that open a different file than the one the last check saw, as a swap in between would.
  const swapping: production.FolderOps = { ...nodeFs, openSync: ((file: nodeFs.PathLike, flags: number) => nodeFs.openSync(String(file).endsWith("row.json") ? path.join(outside, "secret.json") : file, flags)) as typeof nodeFs.openSync };
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json"], {}, swapping), { ok: false, refusal: "swapped", at: "paths[0]" });
  // A name swapped for a link is refused at the open itself, even a link to the very file the check saw.
  const selfLink = path.join(root, "runs", "first", "again.json");
  symlinkSync(path.join(root, "runs", "first", "row.json"), selfLink);
  const linking: production.FolderOps = { ...nodeFs, openSync: ((file: nodeFs.PathLike, flags: number) => nodeFs.openSync(String(file).endsWith("row.json") ? selfLink : file, flags)) as typeof nodeFs.openSync };
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json"], {}, linking), { ok: false, refusal: "link-in-path", at: "paths[0]" });
  // The same inode number on another device is another file.
  const otherDevice: production.FolderOps = {
    ...nodeFs,
    fstatSync: ((fd: number) => {
      const opened = nodeFs.fstatSync(fd);
      const { dev } = opened;
      return Object.assign(Object.create(Object.getPrototypeOf(opened) as object) as nodeFs.Stats, opened, { dev: dev + 1 });
    }) as typeof nodeFs.fstatSync
  };
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json"], {}, otherDevice), { ok: false, refusal: "swapped", at: "paths[0]" });
  assert.ok(production.readRecordedFiles(root, ["runs/first/row.json"]).ok);
});

/** A folder and a sibling holding the same layout, for swaps that point the folder's path at the sibling. */
function twins(): Readonly<{ root: string; outside: string }> {
  const base = mkdtempSync(path.join(tmpdir(), "sbl-recorded-"));
  roots.push(base);
  const root = path.join(base, "run");
  const outside = path.join(base, "outside");
  for (const top of [root, outside]) mkdirSync(path.join(top, "runs", "first"), { recursive: true });
  writeFileSync(path.join(root, "runs", "first", "row.json"), '{"inside":true}');
  writeFileSync(path.join(outside, "runs", "first", "row.json"), '{"outside":true}');
  return { root, outside };
}

/** Ops whose lstat swaps one place for a link to the sibling right after checking it, once, as a racing writer could. */
const swapAfterCheck = (place: string, target: string): production.FolderOps => {
  let swapped = false;
  return {
    ...nodeFs,
    lstatSync: ((file: nodeFs.PathLike, ...rest: unknown[]) => {
      const stats = (nodeFs.lstatSync as (...args: unknown[]) => nodeFs.Stats)(file, ...rest);
      if (!swapped && String(file) === place) {
        swapped = true;
        renameSync(place, `${place}-held`);
        symlinkSync(target, place);
      }
      return stats;
    }) as typeof nodeFs.lstatSync
  };
};

test("a folder on the way, or the folder itself, swapped for a link during the walk is refused by the second walk", () => {
  const middle = twins();
  assert.deepEqual(production.readRecordedFiles(middle.root, ["runs/first/row.json"], {}, swapAfterCheck(path.join(middle.root, "runs"), path.join(middle.outside, "runs"))), { ok: false, refusal: "link-in-path", at: "paths[0]" });
  const top = twins();
  assert.deepEqual(production.readRecordedFiles(top.root, ["runs/first/row.json"], {}, swapAfterCheck(top.root, top.outside)), { ok: false, refusal: "link-in-path", at: "paths[0]" });
  // A folder swapped for another real folder, no link anywhere, is swapped all the same.
  const moved = twins();
  let done = false;
  const replacing: production.FolderOps = {
    ...nodeFs,
    lstatSync: ((file: nodeFs.PathLike, ...rest: unknown[]) => {
      const stats = (nodeFs.lstatSync as (...args: unknown[]) => nodeFs.Stats)(file, ...rest);
      if (!done && String(file) === path.join(moved.root, "runs", "first", "row.json")) {
        done = true;
        renameSync(path.join(moved.root, "runs"), path.join(moved.root, "held"));
        renameSync(path.join(moved.outside, "runs"), path.join(moved.root, "runs"));
      }
      return stats;
    }) as typeof nodeFs.lstatSync
  };
  assert.deepEqual(production.readRecordedFiles(moved.root, ["runs/first/row.json"], {}, replacing), { ok: false, refusal: "swapped", at: "paths[0]" });
  // A folder on the way replaced by another that holds the very same file: the open file matches, and only the second walk sees the folder change.
  const rehoused = twins();
  let rehoming = false;
  const sameFileNewFolder: production.FolderOps = {
    ...nodeFs,
    lstatSync: ((file: nodeFs.PathLike, ...rest: unknown[]) => {
      const stats = (nodeFs.lstatSync as (...args: unknown[]) => nodeFs.Stats)(file, ...rest);
      if (!rehoming && String(file) === path.join(rehoused.root, "runs", "first", "row.json")) {
        rehoming = true;
        renameSync(path.join(rehoused.root, "runs"), path.join(rehoused.root, "held"));
        mkdirSync(path.join(rehoused.root, "runs", "first"), { recursive: true });
        renameSync(path.join(rehoused.root, "held", "first", "row.json"), path.join(rehoused.root, "runs", "first", "row.json"));
      }
      return stats;
    }) as typeof nodeFs.lstatSync
  };
  assert.deepEqual(production.readRecordedFiles(rehoused.root, ["runs/first/row.json"], {}, sameFileNewFolder), { ok: false, refusal: "swapped", at: "paths[0]" });
});

test("a leaf swapped for a link, or a folder renamed away, after the open is caught by the second walk", () => {
  const afterOpen = (change: (root: string) => void, root: string): production.FolderOps => ({
    ...nodeFs,
    fstatSync: ((fd: number) => {
      const stats = nodeFs.fstatSync(fd);
      change(root);
      return stats;
    }) as typeof nodeFs.fstatSync
  });
  const leafLinked = twins();
  const leaf = path.join(leafLinked.root, "runs", "first", "row.json");
  assert.deepEqual(production.readRecordedFiles(leafLinked.root, ["runs/first/row.json"], {}, afterOpen(() => (renameSync(leaf, `${leaf}.held`), symlinkSync(path.join(leafLinked.outside, "runs", "first", "row.json"), leaf)), leafLinked.root)), { ok: false, refusal: "link-in-path", at: "paths[0]" });
  const renamed = twins();
  assert.deepEqual(production.readRecordedFiles(renamed.root, ["runs/first/row.json"], {}, afterOpen((root) => renameSync(path.join(root, "runs"), path.join(root, "held")), renamed.root)), { ok: false, refusal: "swapped", at: "paths[0]" });
});

test("two files that share an inode number on different devices are two files, and both are read", () => {
  const { root } = twins();
  const rowPath = path.join(root, "runs", "first", "row.json");
  const otherPath = path.join(root, "runs", "first", "other.json");
  writeFileSync(otherPath, '{"other":true}');
  const { dev: rowDevice, ino: rowInode } = nodeFs.lstatSync(rowPath);
  const disguised = (stats: nodeFs.Stats) => Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as nodeFs.Stats, stats, { dev: rowDevice + 1, ino: rowInode });
  let otherHandle = -1;
  const mounted: production.FolderOps = {
    ...nodeFs,
    lstatSync: ((file: nodeFs.PathLike, ...rest: unknown[]) => {
      const stats = (nodeFs.lstatSync as (...args: unknown[]) => nodeFs.Stats)(file, ...rest);
      return String(file) === otherPath ? disguised(stats) : stats;
    }) as typeof nodeFs.lstatSync,
    openSync: ((file: nodeFs.PathLike, flag: number) => {
      const handle = nodeFs.openSync(file, flag);
      if (String(file) === otherPath) otherHandle = handle;
      return handle;
    }) as typeof nodeFs.openSync,
    fstatSync: ((fd: number) => (fd === otherHandle ? disguised(nodeFs.fstatSync(fd)) : nodeFs.fstatSync(fd))) as typeof nodeFs.fstatSync
  };
  const result = production.readRecordedFiles(root, ["runs/first/row.json", "runs/first/other.json"], {}, mounted);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(new TextDecoder().decode(result.files.get("runs/first/other.json") as Uint8Array), '{"other":true}');
});

test("a regular file renamed over the leaf between its check and its open is refused as swapped, not as a link", () => {
  const { root } = twins();
  const leaf = path.join(root, "runs", "first", "row.json");
  const renaming: production.FolderOps = {
    ...nodeFs,
    openSync: ((file: nodeFs.PathLike, flag: number) => {
      if (String(file) === leaf) {
        writeFileSync(`${leaf}.new`, '{"replaced":true}');
        renameSync(`${leaf}.new`, leaf);
      }
      return nodeFs.openSync(file, flag);
    }) as typeof nodeFs.openSync
  };
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json"], {}, renaming), { ok: false, refusal: "swapped", at: "paths[0]" });
});

test("two paths asked for that open one file are refused as one file, and a file that ends early is not a file", () => {
  const { root } = folder();
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json", "runs/first/row.json"]), { ok: false, refusal: "same-file", at: "paths[1]" });
  // On a volume that folds case, two spellings of one name open one file.
  if (statSync(path.join(root, "runs", "FIRST", "row.json"), { throwIfNoEntry: false }) !== undefined) {
    assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json", "runs/FIRST/row.json"]), { ok: false, refusal: "same-file", at: "paths[1]" });
  }
  const short: production.FolderOps = { ...nodeFs, readSync: (() => 0) as typeof nodeFs.readSync };
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json"], {}, short), { ok: false, refusal: "not-a-file", at: "paths[0]" });
});

test("a saved script's file is named by the name the adapter gives it, or by its place, never by the path that mirrors its URL", () => {
  const { root } = folder();
  const mirrored = "runs/first/exported/files/origins/mirror.js";
  assert.deepEqual(production.readRecordedFiles(root, ["notes.md", mirrored]), { ok: false, refusal: "link-in-path", at: "paths[1]" });
  assert.deepEqual(production.readRecordedFiles(root, [mirrored], { names: new Map([[mirrored, "runs/first/exported/manifest.json#scr_one"]]) }), { ok: false, refusal: "link-in-path", at: "runs/first/exported/manifest.json#scr_one" });
  const listed = production.listRecordedFolder(root);
  assert.ok(listed.ok);
  assert.ok(!JSON.stringify(listed.listing).includes("mirror"), "a link below saved script files is named by its place in the listing");
  // The name stops at the first folder of saved files, so a mirrored path holding another folder named files says nothing more.
  mkdirSync(path.join(root, "runs", "r", "exported", "files", "origins", "files"), { recursive: true });
  symlinkSync(path.join(root, "notes.md"), path.join(root, "runs", "r", "exported", "files", "origins", "files", "app.js"));
  assert.deepEqual(production.readRecordedFiles(root, ["runs/r/exported/files/origins/files/app.js"]), { ok: false, refusal: "link-in-path", at: "paths[0]" });
  const nested = production.listRecordedFolder(root);
  assert.ok(nested.ok);
  assert.ok(nested.listing.links.includes("runs/r/exported/files#link4"), JSON.stringify(nested.listing.links));
  assert.ok(!JSON.stringify(nested.listing).includes("origins"), JSON.stringify(nested.listing));
});

test("a path the caller gave no name is named by its place in the request in every refusal, never by its text", () => {
  const base = mkdtempSync(path.join(tmpdir(), "sbl-recorded-"));
  roots.push(base);
  const label = "www.lantern.example";
  const root = path.join(base, "run");
  const folder = path.join(root, "out", label);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "harness.json"), "{}");
  writeFileSync(path.join(base, "elsewhere.json"), "{}");
  linkSync(path.join(base, "elsewhere.json"), path.join(folder, "hard.json"));
  symlinkSync(path.join(base, "elsewhere.json"), path.join(folder, "soft.json"));
  const at = (name: string) => `out/${label}/${name}`;
  const named = new Map([[at("harness.json"), "folder 1/harness.json"]]);
  const cases: readonly (readonly [readonly string[], production.ReadOptions, string, string])[] = [
    [[at("soft.json")], {}, "link-in-path", "paths[0]"],
    [[at("hard.json")], {}, "hard-link", "paths[0]"],
    [[at("harness.json/below")], {}, "not-a-file", "paths[0]"],
    [[at("harness.json")], { maxBytes: 1 }, "too-large", "paths[0]"],
    [[at("harness.json"), at("harness.json")], {}, "same-file", "paths[1]"],
    // A map that names one path and not the next names the next by its place too.
    [[at("harness.json"), at("harness.json/below")], { names: named }, "not-a-file", "paths[1]"],
    [[at("harness.json"), at("harness.json")], { names: new Map([[at("other.json"), "folder 1/other.json"]]) }, "same-file", "paths[1]"]
  ];
  for (const [paths, options, refusal, place] of cases) {
    const result = production.readRecordedFiles(root, paths, options);
    assert.deepEqual(result, { ok: false, refusal, at: place }, `${refusal} ${place}`);
    assert.ok(!JSON.stringify(result).toLowerCase().includes("lantern"), JSON.stringify(result));
  }
  // On a volume that folds case, the second spelling of one file is refused by its place, though the map names the first.
  if (statSync(path.join(root, "out", label.toUpperCase(), "harness.json"), { throwIfNoEntry: false }) !== undefined) {
    const folded = production.readRecordedFiles(root, [at("harness.json"), `out/${label.toUpperCase()}/harness.json`], { names: named });
    assert.deepEqual(folded, { ok: false, refusal: "same-file", at: "paths[1]" });
  }
});

test("a root that is a link or not a folder is refused, and a file past the bound is refused, not read, to the byte", () => {
  const { root } = folder();
  const linkedRoot = path.join(path.dirname(root), "linked-root");
  symlinkSync(root, linkedRoot);
  assert.deepEqual(production.readRecordedFiles(linkedRoot, ["notes.md"]), { ok: false, refusal: "not-a-folder", at: "." });
  assert.deepEqual(production.listRecordedFolder(linkedRoot), { ok: false, refusal: "not-a-folder", at: "." });
  assert.deepEqual(production.listRecordedFolder(path.join(root, "notes.md")), { ok: false, refusal: "not-a-folder", at: "." });
  // The row holds 8 bytes: a bound of 8 reads it and a bound of 7 refuses it.
  assert.ok(production.readRecordedFiles(root, ["runs/first/row.json"], { maxBytes: 8 }).ok);
  assert.deepEqual(production.readRecordedFiles(root, ["runs/first/row.json"], { maxBytes: 7 }), { ok: false, refusal: "too-large", at: "paths[0]" });
  assert.deepEqual(production.readRecordedFiles(root, ["runs"]), { ok: false, refusal: "not-a-file", at: "paths[0]" });
});

test("a listing names the files inside, and each link it met without following it", () => {
  const { root } = folder();
  const listed = production.listRecordedFolder(root);
  assert.ok(listed.ok);
  assert.deepEqual(listed.listing, { files: ["notes.md", "runs/first/row.json"], links: ["runs/away", "runs/first/exported/files#link2", "runs/first/linked.json", "top"], other: [] });
});

test("a FIFO inside the folder is listed as other and refused as not a file, without waiting on a writer", () => {
  const base = mkdtempSync(path.join(tmpdir(), "sbl-recorded-"));
  roots.push(base);
  assert.equal(spawnSync("mkfifo", [path.join(base, "pipe")]).status, 0);
  assert.deepEqual(production.listRecordedFolder(base), { ok: true, listing: { files: [], links: [], other: ["pipe"] } });
  // Run in a child with a deadline, so a reader that waits on the FIFO shows as a wrong answer, not a hung suite.
  const reader = require.resolve("../local/recorded-folder");
  const child = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(reader)}).readRecordedFiles(${JSON.stringify(base)}, ["pipe"])))`], { encoding: "utf8", timeout: 10_000 });
  // A child stopped by the deadline says only that it ran out of time, which host load alone can cause: it is not a finding.
  if ((child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || child.signal !== null) assert.fail(`TIMEOUT-NOT-A-KILL: the reading child was stopped after 10 s (${child.signal ?? "no signal"})`);
  assert.equal(child.status, 0, "the read returned on its own");
  assert.deepEqual(JSON.parse(child.stdout), { ok: false, refusal: "not-a-file", at: "paths[0]" });
});

test("the one open asks not to follow a link at the leaf and not to wait on a FIFO", () => {
  const flags: number[] = [];
  const recording: production.FolderOps = { ...nodeFs, openSync: ((file: nodeFs.PathLike, flag: number) => (flags.push(flag), nodeFs.openSync(file, flag))) as typeof nodeFs.openSync };
  const { root } = folder();
  assert.ok(production.readRecordedFiles(root, ["runs/first/row.json"], {}, recording).ok);
  assert.equal(flags.length, 1);
  assert.equal(flags[0] & nodeFs.constants.O_NONBLOCK, nodeFs.constants.O_NONBLOCK, "opened without waiting on a FIFO");
  assert.equal(flags[0] & nodeFs.constants.O_NOFOLLOW, nodeFs.constants.O_NOFOLLOW, "opened without following a link at the leaf");
});

test("reading and listing write nothing to the folder", () => {
  const { root } = folder();
  const snapshot = () => {
    const entries: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory).sort()) {
        const full = path.join(directory, name);
        const stats = statSync(full, { throwIfNoEntry: false });
        const relative = path.relative(root, full);
        entries.push(`${relative} ${stats?.size ?? "link"} ${stats?.mtimeMs ?? ""}`);
        if (stats?.isDirectory() && !["runs/away", "top"].includes(relative)) walk(full);
      }
    };
    walk(root);
    return entries;
  };
  const before = snapshot();
  production.listRecordedFolder(root);
  production.readRecordedFiles(root, ["runs/first/row.json", "notes.md", "absent"]);
  assert.deepEqual(snapshot(), before);
});

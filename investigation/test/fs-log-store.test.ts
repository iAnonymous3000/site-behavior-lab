import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { appendCommand, createLog, openLog, type LogStores } from "../core/case-log";
import { runnerActorFrom, type Actor } from "../core/actor";
import * as productionStore from "../local/fs-log-store";
import { fsLogStores, prepareFsLogDirectory, type FsOps } from "../local/fs-log-store";
import { ATTEMPT_ONE, CASE_A, decode, encode, freshDirectory, GENESIS, sha256OfText, withDirectory } from "./log-fixture";
import * as productionMemory from "./memory-log-store";
import { memoryStores } from "./memory-log-store";

/**
 * The store rules the log rests on: create-only objects and a compare-and-swap head.
 * One contract holds the in-memory store and the filesystem store alike, and each rule
 * in each has a broken variant. Durability cannot be shown by killing a process, since
 * a killed process loses nothing the kernel already has, so the order of the file
 * system calls is written out and held exactly. fs-log-store-kill.test.ts has the kills.
 */

type StoreModule = typeof productionStore;
type MemoryModule = typeof productionMemory;

const storeVariant = (...edits: SourceEdit[]) => loadVariant<StoreModule>(require.resolve("../local/fs-log-store"), edits);
const memoryVariant = (...edits: SourceEdit[]) => loadVariant<MemoryModule>(require.resolve("./memory-log-store"), edits);

const ONE = sha256OfText("one");
const TWO = sha256OfText("two");
const THREE = sha256OfText("three");

function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  return withDirectory("store", (root) => {
    prepareFsLogDirectory(root);
    return run(root);
  });
}

const BOUND = 1024;
const read = async (stores: LogStores, kind: "entries" | "evidence", address: string): Promise<string> => {
  const bytes = await stores[kind].read(address, BOUND);
  return bytes instanceof Uint8Array ? decode(bytes) : String(bytes);
};

/** The rules every store must keep, read through nothing but the store's own interface. */
async function checkContract(stores: LogStores): Promise<void> {
  for (const kind of ["entries", "evidence"] as const) {
    const objects = stores[kind];
    holds("an absent object reads as null", (await objects.read(ONE, BOUND)) === null, () => ONE);
    const written = encode("first bytes");
    holds("a free address is created", (await objects.createOnly(ONE, written)) === "created", () => ONE);
    holds("what was written reads back", (await read(stores, kind, ONE)) === "first bytes", () => ONE);

    holds("a taken address says so", (await objects.createOnly(ONE, encode("other bytes"))) === "exists", () => ONE);
    holds("create-only never overwrites", (await read(stores, kind, ONE)) === "first bytes", () => ONE);

    written.fill(0);
    holds("changing the caller's buffer changes nothing stored", (await read(stores, kind, ONE)) === "first bytes", () => ONE);
    ((await objects.read(ONE, BOUND)) as Uint8Array).fill(0);
    holds("changing a read buffer changes nothing stored", (await read(stores, kind, ONE)) === "first bytes", () => ONE);
    holds("an empty object is an object", (await objects.createOnly(TWO, new Uint8Array(0))) === "created" && ((await objects.read(TWO, BOUND)) as Uint8Array).length === 0, () => TWO);

    const atBound = await objects.read(ONE, "first bytes".length);
    holds("an object exactly at the bound reads", atBound instanceof Uint8Array && decode(atBound) === "first bytes", () => atBound);
    const pastBound = await objects.read(ONE, "first bytes".length - 1);
    holds("an object past the bound is too large, not its first part", pastBound === "too-large", () => pastBound);
  }

  const { head } = stores;
  holds("a head never set reads as null", (await head.read(64)) === null, () => "head");
  holds("a stale swap of an unset head is refused", (await head.compareAndSwap(ONE, TWO)) === false && (await head.read(64)) === null, () => "unset");
  holds("the first swap from null succeeds", (await head.compareAndSwap(null, ONE)) === true && (await head.read(64)) === ONE, () => "first");
  holds("a second swap from null is refused", (await head.compareAndSwap(null, TWO)) === false && (await head.read(64)) === ONE, () => "second");
  holds("a swap from the current value succeeds", (await head.compareAndSwap(ONE, TWO)) === true && (await head.read(64)) === TWO, () => "current");
  holds("a stale swap is refused and changes nothing", (await head.compareAndSwap(ONE, THREE)) === false && (await head.read(64)) === TWO, () => "stale");
  holds("a swap to the same value is still a swap", (await head.compareAndSwap(TWO, TWO)) === true && (await head.read(64)) === TWO, () => "same");
  const headPastBound = await head.read(63);
  holds("a head past its bound reads as no digest", headPastBound === "", () => headPastBound);
}

test("the in-memory store keeps the contract", async () => {
  await checkContract(memoryStores());
});

test("the filesystem store keeps the contract", async () => {
  await withRoot(async (root) => checkContract(fsLogStores(root)));
});

test("evidence and entries are separate address spaces", async () => {
  await withRoot(async (root) => {
    const stores = fsLogStores(root);
    await stores.entries.createOnly(ONE, encode("an entry"));
    assert.equal(await stores.evidence.read(ONE, BOUND), null);
    assert.equal(await stores.evidence.createOnly(ONE, encode("evidence")), "created");
    assert.equal(await read(stores, "entries", ONE), "an entry");
  });
});

for (const [name, property, edit] of [
  ["the memory store's create-only", "a taken address says so", { find: 'if (this.objects.has(address))\n            return "exists";', replace: "" }],
  ["the memory store's create-only, while still answering as if it held", "create-only never overwrites", { find: 'if (this.objects.has(address))\n            return "exists";', replace: 'if (this.objects.has(address)) {\n            this.objects.set(address, new Uint8Array(bytes));\n            return "exists";\n        }' }],
  ["the memory store's compare", "a stale swap of an unset head is refused", { find: "if (this.value !== expected)\n            return false;", replace: "" }],
  ["the memory store's copy on write", "changing the caller's buffer changes nothing stored", { find: "this.objects.set(address, new Uint8Array(bytes));", replace: "this.objects.set(address, bytes);" }],
  ["the memory store's copy on read", "changing a read buffer changes nothing stored", { find: "return new Uint8Array(bytes);", replace: "return bytes;" }],
  ["the memory store's bound", "an object past the bound is too large, not its first part", { find: 'if (bytes.length > maxBytes)\n            return "too-large";', replace: "" }],
  ["the memory store's head bound", "a head past its bound reads as no digest", { find: 'return this.value !== null && this.value.length > maxChars ? "" : this.value;', replace: "return this.value;" }]
] as const) {
  test(`removing ${name} is caught`, async () => {
    const memory = memoryVariant(edit);
    await assertCaughtBy(name, property, () => checkContract(memory.memoryStores()));
  });
}

/** Publishing by rename, as M1 does: the temp file is gone afterward, and rename replaces its target. */
const PUBLISH_BY_RENAME: readonly SourceEdit[] = [
  { find: "ops.linkSync(temp, target);", replace: "ops.renameSync(temp, target);" },
  { find: "ops.unlinkSync(temp);", replace: "" }
];

for (const [name, property, edits] of [
  ["publishing by a rename that replaces its target", "a taken address says so", PUBLISH_BY_RENAME],
  ["the head's compare", "a stale swap of an unset head is refused", [{ find: "if (value !== expected)\n                return false;", replace: "" }]],
  ["the taken name's answer", "a taken address says so", [{ find: "created = false;", replace: "" }]],
  ["reading the highest slot", "a swap from the current value succeeds", [{ find: ".sort().at(-1)", replace: ".sort().at(0)" }]],
  ["the next slot's number", "a swap from the current value succeeds", [{ find: "const slot = now === null ? 1 : now.slot + 1;", replace: "const slot = 1;" }]],
  ["the read bound", "an object past the bound is too large, not its first part", [{ find: 'if (stats.size > maxBytes)\n            return "too-large";', replace: "" }]],
  ["the read bound's edge", "an object exactly at the bound reads", [{ find: "if (stats.size > maxBytes)", replace: "if (stats.size >= maxBytes)" }]],
  ["the head's read bound", "a head past its bound reads as no digest", [{ find: "async read(maxChars) {\n            const now = current(maxChars);", replace: "async read(maxChars) {\n            const now = current(1000 + maxChars);" }]]
] as const) {
  test(`removing ${name} from the filesystem store is caught`, async () => {
    await withRoot(async (root) => {
      const module = storeVariant(...edits);
      await assertCaughtBy(name, property, () => checkContract(module.fsLogStores(root)));
    });
  });
}

// The call order, written out. It is the only evidence of durability a test can give.

type Traced = Readonly<{ ops: FsOps; trace: string[] }>;

function tracedOps(root: string, overrides: Partial<FsOps> = {}): Traced {
  const trace: string[] = [];
  const descriptors = new Map<number, string>();
  const label = (target: unknown): string => path.relative(root, String(target)).replace(/^tmp\/.*/, "tmp").replace(/[0-9a-f]{64}$/, "<digest>") || ".";
  const real: FsOps = { ...nodeFs, ...overrides };
  const ops: FsOps = {
    ...real,
    // A read opens with numeric flags. It changes nothing, so it has no place in this order.
    openSync: ((target: nodeFs.PathLike, flags: unknown, ...rest: never[]) => {
      const handle = (real.openSync as (...args: unknown[]) => number)(target, flags, ...rest);
      if (typeof flags !== "number") {
        descriptors.set(handle, label(target));
        trace.push(`open ${label(target)}`);
      }
      return handle;
    }) as FsOps["openSync"],
    writeSync: ((handle: number, ...rest: never[]) => {
      trace.push(`write ${descriptors.get(handle)}`);
      return (real.writeSync as (...args: unknown[]) => number)(handle, ...rest);
    }) as FsOps["writeSync"],
    fsyncSync: (handle) => {
      trace.push(`fsync ${descriptors.get(handle)}`);
      real.fsyncSync(handle);
    },
    closeSync: (handle) => {
      // A descriptor's number comes back after a close, so a read must not inherit a write's label.
      if (descriptors.has(handle)) trace.push(`close ${descriptors.get(handle)}`);
      descriptors.delete(handle);
      real.closeSync(handle);
    },
    linkSync: (from, to) => {
      trace.push(`link ${label(from)} ${label(to)}`);
      real.linkSync(from, to);
    },
    unlinkSync: (target) => {
      trace.push(`unlink ${label(target)}`);
      real.unlinkSync(target);
    }
  };
  return { ops, trace };
}

const PUBLISH_ENTRY = [
  "open tmp",
  "write tmp",
  "fsync tmp",
  "close tmp",
  "link tmp entries/<digest>",
  "open entries",
  "fsync entries",
  "close entries",
  "unlink tmp"
];

const checkOrder = async (module: StoreModule) => {
  const root = freshDirectory("order");
  try {
    module.prepareFsLogDirectory(root);
    const created = tracedOps(root);
    const stores = module.fsLogStores(root, created.ops);
    await stores.entries.createOnly(ONE, encode("bytes"));
    holds(
      "the bytes are durable under a temp name before the real name appears, and the name is durable before the temp goes",
      JSON.stringify(created.trace) === JSON.stringify(PUBLISH_ENTRY),
      () => created.trace
    );

    // Another writer may have died after linking and before syncing, so a taken name syncs too.
    const taken = tracedOps(root);
    await module.fsLogStores(root, taken.ops).entries.createOnly(ONE, encode("bytes"));
    holds("finding a name taken still syncs its folder, and leaves no temp", JSON.stringify(taken.trace) === JSON.stringify(PUBLISH_ENTRY), () => taken.trace);

    const swap = tracedOps(root);
    await module.fsLogStores(root, swap.ops).head.compareAndSwap(null, ONE);
    holds(
      "a swap publishes a new slot the same way",
      JSON.stringify(swap.trace) === JSON.stringify(PUBLISH_ENTRY.map((step) => step.replace("entries/<digest>", "head/000000000001").replaceAll("entries", "head"))),
      () => swap.trace
    );
    holds("no temp is left after a normal write", readdirSync(path.join(root, "tmp")).length === 0, () => readdirSync(path.join(root, "tmp")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("the file system calls happen in the stated order", async () => {
  await checkOrder(productionStore);
});

const ORDER_PROPERTY = "the bytes are durable under a temp name before the real name appears, and the name is durable before the temp goes";

for (const [name, property, edits] of [
  ["the file's sync", ORDER_PROPERTY, [{ find: "ops.fsyncSync(handle);\n    ops.closeSync(handle);\n    return temp;", replace: "ops.closeSync(handle);\n    return temp;" }]],
  ["the folder's sync", ORDER_PROPERTY, [{ find: "syncDirectory(ops, node_path_1.default.dirname(target));", replace: "" }]],
  ["the temp file's removal", ORDER_PROPERTY, [{ find: "ops.unlinkSync(temp);", replace: "" }]],
  ["the sync coming before the link", ORDER_PROPERTY, [{ find: "    let created = true;\n    try {\n        ops.linkSync(temp, target);", replace: "    let created = true;\n    syncDirectory(ops, node_path_1.default.dirname(target));\n    try {\n        ops.linkSync(temp, target);" }, { find: "    syncDirectory(ops, node_path_1.default.dirname(target));\n    ops.unlinkSync(temp);", replace: "    ops.unlinkSync(temp);" }]],
  ["the sync when a name is taken", "finding a name taken still syncs its folder, and leaves no temp", [{ find: "created = false;", replace: "ops.unlinkSync(temp);\n        return false;" }]]
] as const) {
  test(`removing ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkOrder(storeVariant(...edits)));
  });
}

test("preparing a folder syncs each new folder and the folders above it", async () => {
  const check = (module: StoreModule) => {
    const root = freshDirectory("prepare");
    try {
      const { ops, trace } = tracedOps(root);
      module.prepareFsLogDirectory(root, ops);
      const sync = (name: string) => [`open ${name}`, `fsync ${name}`, `close ${name}`];
      const expected = [...sync("entries"), ...sync("evidence"), ...sync("head"), ...sync("tmp"), ...sync("."), ...sync("..")];
      holds("a new folder is durable before anything is written into it", JSON.stringify(trace) === JSON.stringify(expected), () => trace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  check(productionStore);
  await assertCaughtBy("the sync of the new folders", "a new folder is durable before anything is written into it", () =>
    check(storeVariant({ find: "for (const folder of folders)\n        syncDirectory(ops, folder);", replace: "" }))
  );
  await assertCaughtBy("the sync of the log's own folder", "a new folder is durable before anything is written into it", () =>
    check(storeVariant({ find: "syncDirectory(ops, resolved);", replace: "" }))
  );
  await assertCaughtBy("the sync above the log's folder", "a new folder is durable before anything is written into it", () =>
    check(storeVariant({ find: "syncDirectory(ops, node_path_1.default.dirname(resolved));", replace: "" }))
  );
});

test("a short write is finished, not left short", async () => {
  const oneByteAtATime: FsOps = {
    ...nodeFs,
    writeSync: ((handle: number, buffer: Uint8Array, offset: number) => nodeFs.writeSync(handle, buffer, offset, 1)) as FsOps["writeSync"]
  };
  const check = async (module: StoreModule) => {
    const root = freshDirectory("short");
    try {
      module.prepareFsLogDirectory(root);
      const stores = module.fsLogStores(root, oneByteAtATime);
      await stores.entries.createOnly(ONE, encode("every byte of this"));
      holds("a short write is finished", (await read(module.fsLogStores(root), "entries", ONE)) === "every byte of this", () => "short");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  await check(productionStore);
  await assertCaughtBy("the write loop", "a short write is finished", () =>
    check(storeVariant({ find: "while (written < bytes.length)\n        written += ops.writeSync(handle, bytes, written);", replace: "written += ops.writeSync(handle, bytes, written);" }))
  );
});

test("what is stored is private to this user", async () => {
  const check = async (module: StoreModule) => {
    await withDirectory("mode", async (root) => {
      module.prepareFsLogDirectory(root);
      const stores = module.fsLogStores(root);
      await stores.evidence.createOnly(ONE, encode("evidence"));
      await stores.entries.createOnly(ONE, encode("entry"));
      await stores.head.compareAndSwap(null, ONE);
      for (const file of [path.join("evidence", ONE), path.join("entries", ONE), path.join("head", "000000000001")]) {
        const mode = statSync(path.join(root, file)).mode & 0o777;
        holds("an object is readable by this user alone", mode === 0o600, () => ({ file, mode: mode.toString(8) }));
      }
      for (const folder of ["entries", "evidence", "head", "tmp"]) {
        const mode = statSync(path.join(root, folder)).mode & 0o777;
        holds("a folder is open to this user alone", mode === 0o700, () => ({ folder, mode: mode.toString(8) }));
      }
    });
  };
  await check(productionStore);
  // A stricter umask would hide a looser mode from either variant, so this holds the umask open.
  const umask = process.umask(0o022);
  try {
    await assertCaughtBy("the file mode", "an object is readable by this user alone", () =>
      check(storeVariant({ find: 'ops.openSync(temp, "wx", 0o600)', replace: 'ops.openSync(temp, "wx", 0o644)' }))
    );
    await assertCaughtBy("the private mode", "a folder is open to this user alone", () =>
      check(storeVariant({ find: "if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {", replace: "if (false) {" }, { find: "const PRIVATE_MODE = 0o700;", replace: "const PRIVATE_MODE = 0o755;" }))
    );
  } finally {
    process.umask(umask);
  }
});

const refusedBy = (run: () => unknown): boolean => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

const checkOpenFolders = async (module: StoreModule) => {
  await withDirectory("fresh", (base) => {
    holds("a tree not made yet can be prepared", !refusedBy(() => module.prepareFsLogDirectory(path.join(base, "log"))), () => base);
  });
  const refuses = (root: string): boolean => refusedBy(() => module.prepareFsLogDirectory(root));
  for (const folder of [".", "entries", "evidence", "head", "tmp"]) {
    for (const mode of [0o777, 0o770, 0o707, 0o710, 0o701, 0o740, 0o704]) {
      await withDirectory("open", (root) => {
        mkdirSync(path.join(root, folder), { recursive: true });
        chmodSync(path.join(root, folder), mode);
        holds("a folder already open to anyone else is refused, not used", refuses(root), () => ({ folder, mode: mode.toString(8) }));
      });
      await withDirectory("open-later", (root) => {
        module.prepareFsLogDirectory(root);
        chmodSync(path.join(root, folder), mode);
        holds("a tree that has since opened up is refused when its stores open", refusedBy(() => module.fsLogStores(root)), () => ({ folder, mode: mode.toString(8) }));
      });
    }
  }
  for (const folder of ["entries", "evidence", "head", "tmp"]) {
    await withDirectory("link", (root) => {
      mkdirSync(path.join(root, "elsewhere"), { mode: 0o700 });
      symlinkSync(path.join(root, "elsewhere"), path.join(root, folder));
      holds("a link standing in for a folder is refused", refuses(root), () => folder);
    });
    await withDirectory("link-later", (root) => {
      module.prepareFsLogDirectory(root);
      renameSync(path.join(root, folder), path.join(root, "moved"));
      symlinkSync(path.join(root, "moved"), path.join(root, folder));
      holds("a folder swapped for a link is refused when the stores open", refusedBy(() => module.fsLogStores(root)), () => folder);
    });
  }
  for (const spelling of ["link", "link/", "link/."]) {
    await withDirectory("root-link", (base) => {
      const target = path.join(base, "target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, path.join(base, "link"));
      const root = path.join(base, spelling);
      holds("a link as the log's own folder is refused by prepare, however it is spelled", refusedBy(() => module.prepareFsLogDirectory(root)), () => spelling);
      holds("a refused link has nothing made in its target", readdirSync(target).length === 0, () => ({ spelling, made: readdirSync(target) }));
      holds("a link as the log's own folder is refused on open, however it is spelled", refusedBy(() => module.fsLogStores(root)), () => spelling);
    });
  }
  // A link's own mode is usually open, which refuses it anyway, so this one reads as private.
  await withDirectory("private-link", (root) => {
    const privateLink: FsOps = { ...nodeFs, lstatSync: (() => ({ isDirectory: () => false, mode: 0o40700 })) as unknown as FsOps["lstatSync"] };
    holds("a link standing in for a folder is refused", refusedBy(() => module.prepareFsLogDirectory(root, privateLink)), () => root);
  });
  await withDirectory("private", (root) => {
    module.prepareFsLogDirectory(root);
    holds("a private folder is accepted, and preparing it again is safe", !refuses(root), () => root);
    holds("a private tree opens", !refusedBy(() => module.fsLogStores(root)), () => root);
  });
  holds("a tree not made yet is nobody's, and opens to read as absent", !refusedBy(() => module.fsLogStores(path.join(freshNonexistent(), "never"))), () => "never");
};

/** A path under a folder that is not there. Nothing is created, so nothing is left behind. */
const freshNonexistent = (): string => path.join(tmpdir(), `sbl-case-log-absent-${crypto.randomUUID()}`);

test("a folder that already exists open to anyone else is refused, whichever one it is", async () => {
  await checkOpenFolders(productionStore);
});

const CHECKED_FOLDERS = "for (const folder of [root, ...FOLDERS.map((name) => node_path_1.default.join(root, name))]) {";

for (const [name, property, edit] of [
  ["the refusal of an open folder", "a folder already open to anyone else is refused, not used", { find: "(stats.mode & 0o077) !== 0", replace: "false" }],
  ["the check of group access", "a folder already open to anyone else is refused, not used", { find: "(stats.mode & 0o077) !== 0", replace: "(stats.mode & 0o007) !== 0" }],
  ["the check of other access", "a folder already open to anyone else is refused, not used", { find: "(stats.mode & 0o077) !== 0", replace: "(stats.mode & 0o070) !== 0" }],
  ["the check of the log's own folder", "a folder already open to anyone else is refused, not used", { find: CHECKED_FOLDERS, replace: "for (const folder of FOLDERS.map((name) => node_path_1.default.join(root, name))) {" }],
  ["the check of the folders inside it", "a folder already open to anyone else is refused, not used", { find: CHECKED_FOLDERS, replace: "for (const folder of [root]) {" }],
  ["the check that it is a folder", "a link standing in for a folder is refused", { find: "!stats.isDirectory() || ", replace: "" }],
  ["prepare's check", "a folder already open to anyone else is refused, not used", { find: "alone.\n    refuseUnsafeFolders(ops, resolved);\n    for (const folder of folders)", replace: "alone.\n    for (const folder of folders)" }],
  ["open's check", "a tree that has since opened up is refused when its stores open", { find: "refuseUnsafeFolders(ops, resolved);\n    return {", replace: "return {" }],
  ["prepare's resolving", "a link as the log's own folder is refused by prepare, however it is spelled", { find: "const resolved = node_path_1.default.resolve(root);\n    const folders", replace: "const resolved = root;\n    const folders" }],
  ["open's resolving", "a link as the log's own folder is refused on open, however it is spelled", { find: "const resolved = node_path_1.default.resolve(root);\n    refuseUnsafeFolders", replace: "const resolved = root;\n    refuseUnsafeFolders" }],
  ["reading a missing folder as a refusal", "a tree not made yet can be prepared", { find: "if (isMissing(error))\n                continue;\n            throw error;", replace: "throw error;" }]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkOpenFolders(storeVariant(edit)));
  });
}

// Two writers, at the exact moment that matters, by a hook on the link call.

/** Run `hook` once, at the moment a writer goes to publish, whichever call it publishes with. */
function atPublish(hook: (target: string) => void): FsOps {
  let fired = false;
  const once = (target: nodeFs.PathLike) => {
    if (fired) return;
    fired = true;
    hook(String(target));
  };
  return {
    ...nodeFs,
    linkSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
      once(to);
      nodeFs.linkSync(from, to);
    },
    renameSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
      once(to);
      nodeFs.renameSync(from, to);
    }
  } as FsOps;
}

const checkLinkRace = async (module: StoreModule) => {
  const root = freshDirectory("race");
  try {
    module.prepareFsLogDirectory(root);
    const plain = module.fsLogStores(root);
    await plain.head.compareAndSwap(null, ONE);
    // The other writer read the same head, and gets there first.
    const racing = atPublish((slot) => writeFileSync(slot, TWO));
    const loser = await module.fsLogStores(root, racing).head.compareAndSwap(ONE, THREE);
    holds("a writer that loses the slot loses the swap", loser === false, () => loser);
    holds("a swap that lost leaves the winner's head", (await plain.head.read(64)) === TWO, () => "winner");

    const objectRacing = atPublish((object) => writeFileSync(object, "the winner's bytes"));
    const object = await module.fsLogStores(root, objectRacing).entries.createOnly(ONE, encode("the loser's bytes"));
    holds("a writer that loses an address is told so", object === "exists", () => object);
    holds("a writer that loses an address leaves the winner's bytes", (await read(plain, "entries", ONE)) === "the winner's bytes", () => "bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("two writers at the same instant: the kernel picks one, and the other changes nothing", async () => {
  await checkLinkRace(productionStore);
});

test("publishing by rename would let the second writer erase the first, and is caught", async () => {
  await assertCaughtBy("publishing by rename", "a writer that loses the slot loses the swap", () => checkLinkRace(storeVariant(...PUBLISH_BY_RENAME)));
});

// Failures that are not what they look like.

const eio = (): NodeJS.ErrnoException => Object.assign(new Error("EIO: input/output error"), { code: "EIO" });

const checkFailures = async (module: StoreModule) => {
  const root = freshDirectory("failures");
  try {
    module.prepareFsLogDirectory(root);
    const rejects = async (run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run();
        return false;
      } catch {
        return true;
      }
    };
    const failingLink = module.fsLogStores(root, { ...nodeFs, linkSync: () => { throw eio(); } });
    holds("a failed link is a failure, not a taken name", await rejects(() => failingLink.entries.createOnly(ONE, encode("bytes"))), () => "link");
    holds("a failed swap is a failure, not a lost race", await rejects(() => failingLink.head.compareAndSwap(null, ONE)), () => "swap");
    const failingRead = module.fsLogStores(root, { ...nodeFs, openSync: (() => { throw eio(); }) as FsOps["openSync"], readdirSync: (() => { throw eio(); }) as unknown as FsOps["readdirSync"] });
    holds("a failed read is a failure, not an absent object", await rejects(() => failingRead.entries.read(ONE, BOUND)), () => "read");
    holds("a failed listing is a failure, not an unset head", await rejects(() => failingRead.head.read(64)), () => "listing");
    // A folder replaced by a file is damage, and not the same as an object never written.
    await withDirectory("replaced", async (replaced) => {
      module.prepareFsLogDirectory(replaced);
      const stores = module.fsLogStores(replaced);
      for (const folder of ["entries", "head"]) {
        rmSync(path.join(replaced, folder), { recursive: true });
        writeFileSync(path.join(replaced, folder), "a file");
      }
      holds("a folder replaced by a file is a failure, not an absent object", await rejects(() => stores.entries.read(ONE, BOUND)), () => "entries");
      holds("a folder replaced by a file is a failure, not an unset head", await rejects(() => stores.head.read(64)), () => "head");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a failure of the disk is a failure, and is never read as an absent object or a lost race", async () => {
  await checkFailures(productionStore);
});

for (const [name, property, edit] of [
  ["the rethrow after a failed link", "a failed link is a failure, not a taken name", { find: "if (!isTaken(error))\n            throw error;", replace: "" }],
  ["the rethrow after a failed read", "a failed read is a failure, not an absent object", { find: 'if (isNotOpenable(error))\n            return "not-an-object";\n        throw error;', replace: "return null;" }],
  ["a folder replaced by a file reading as absent", "a folder replaced by a file is a failure, not an absent object", { find: 'return error.code === "ENOENT";', replace: 'return error.code === "ENOENT" || error.code === "ENOTDIR";' }],
  ["the rethrow after a failed listing", "a failed listing is a failure, not an unset head", { find: "if (isMissing(error))\n                return null;\n            throw error;", replace: "return null;" }]
] as const) {
  test(`removing ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkFailures(storeVariant(edit)));
  });
}

test("only a digest reaches a path, and only a digest becomes a head", async () => {
  const check = async (module: StoreModule) => {
    const root = freshDirectory("paths");
    try {
      module.prepareFsLogDirectory(root);
      const stores = module.fsLogStores(root);
      const rejects = async (run: () => Promise<unknown>): Promise<boolean> => {
        try {
          await run();
          return false;
        } catch {
          return true;
        }
      };
      for (const address of ["../escape", "../head/000000000001", "/etc/hosts", "", "ONE", ONE.toUpperCase(), `${ONE}/x`]) {
        holds("an address that is no digest is refused on write", await rejects(() => stores.entries.createOnly(address, encode("x"))), () => address);
        holds("an address that is no digest is refused on read", await rejects(() => stores.evidence.read(address, BOUND)), () => address);
      }
      holds("nothing escaped the folder", !existsSync(path.join(root, "escape")), () => "escape");
      holds("a value that is no digest cannot become the head", (await rejects(() => stores.head.compareAndSwap(null, "not a digest"))) && (await stores.head.read(64)) === null, () => "head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  await check(productionStore);
  await assertCaughtBy("the address check", "an address that is no digest is refused on write", () =>
    check(storeVariant({ find: "if (!(0, case_log_1.isDigest)(address))\n            throw new Error(`Not an object address: ${JSON.stringify(address)}`);", replace: "" }))
  );
  await assertCaughtBy("the head value check", "a value that is no digest cannot become the head", () =>
    check(storeVariant({ find: "if (!(0, case_log_1.isDigest)(next))\n                throw new Error(`Not a head: ${JSON.stringify(next)}`);", replace: "" }))
  );
});

test("what else is in the head folder is not a head", async () => {
  const check = async (module: StoreModule) => {
    const root = freshDirectory("foreign");
    try {
      module.prepareFsLogDirectory(root);
      const stores = module.fsLogStores(root);
      await stores.head.compareAndSwap(null, ONE);
      for (const name of [".DS_Store", "zzz", "99999999999999", "1"]) writeFileSync(path.join(root, "head", name), "not a head");
      holds("a stray file in the head folder is not the head", (await stores.head.read(64)) === ONE, () => readdirSync(path.join(root, "head")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  await check(productionStore);
  await assertCaughtBy("the slot filter", "a stray file in the head folder is not the head", () => check(storeVariant({ find: ".filter((name) => SLOT.test(name))", replace: "" })));
});

test("preparing a folder twice changes nothing, and creates no head", async () => {
  await withRoot(async (root) => {
    const stores = fsLogStores(root);
    await stores.entries.createOnly(ONE, encode("kept"));
    prepareFsLogDirectory(root);
    assert.equal(await stores.head.read(64), null);
    assert.equal(await read(stores, "entries", ONE), "kept");
  });
});

test("a folder never prepared reads as absent, and writes fail rather than creating one", async () => {
  const root = path.join(freshDirectory("unprepared"), "never-prepared");
  try {
    const stores = fsLogStores(root);
    assert.equal(await stores.head.read(64), null);
    assert.equal(await stores.entries.read(ONE, BOUND), null);
    await assert.rejects(() => stores.entries.createOnly(ONE, encode("x")));
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test("a head slot's bytes are the digest and nothing else", async () => {
  await withRoot(async (root) => {
    await fsLogStores(root).head.compareAndSwap(null, ONE);
    assert.equal(readFileSync(path.join(root, "head", "000000000001"), "utf8"), ONE);
    mkdirSync(path.join(root, "head", "not-a-slot"));
    assert.equal(await fsLogStores(root).head.read(64), ONE);
  });
});

// Reads.

test("a short read is finished, and a file that shrinks while being read is not its first part", async () => {
  await withRoot(async (root) => {
    await fsLogStores(root).entries.createOnly(ONE, encode("every byte of this"));
    const oneByteAtATime: FsOps = { ...nodeFs, readSync: ((handle: number, buffer: Uint8Array, offset: number, _length: number, position: number) => nodeFs.readSync(handle, buffer, offset, 1, position)) as FsOps["readSync"] };
    assert.equal(await read(fsLogStores(root, oneByteAtATime), "entries", ONE), "every byte of this");
    let calls = 0;
    const shrinks: FsOps = { ...nodeFs, readSync: ((handle: number, buffer: Uint8Array, offset: number, length: number, position: number) => (calls += 1) === 1 ? nodeFs.readSync(handle, buffer, offset, Math.min(length, 4), position) : 0) as FsOps["readSync"] };
    assert.equal(await fsLogStores(root, shrinks).entries.read(ONE, BOUND), "not-an-object");
  });
});

const answerOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await run();
  } catch (error) {
    // A throw is an answer too, and not the one a caller was promised.
    return `threw ${String((error as NodeJS.ErrnoException).code)}`;
  }
};

const checkNotObjects = async (module: StoreModule) => {
  await withDirectory("not-object", async (root) => {
    module.prepareFsLogDirectory(root);
    const stores = module.fsLogStores(root);
    mkdirSync(path.join(root, "entries", ONE));
    const directory = await answerOf(() => stores.entries.read(ONE, BOUND));
    holds("a folder at an address is not an object", directory === "not-an-object", () => directory);

    writeFileSync(path.join(root, "bytes"), "the true bytes");
    symlinkSync(path.join(root, "bytes"), path.join(root, "entries", TWO));
    const link = await answerOf(() => stores.entries.read(TWO, BOUND));
    holds("a link at an address is not followed", link === "not-an-object", () => link);

    mkdirSync(path.join(root, "head", "000000000001"));
    const headFolder = await answerOf(() => stores.head.read(64));
    holds("a folder at a head slot reads as no digest", headFolder === "", () => headFolder);
  });
};

test("something at an address that cannot be an object says so, by name", async () => {
  await checkNotObjects(productionStore);
});

for (const [name, property, edit] of [
  ["the file type check", "a folder at an address is not an object", { find: 'if (!stats.isFile())\n            return "not-an-object";', replace: "" }],
  ["refusing to follow a link", "a link at an address is not followed", { find: "nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW |", replace: "nodeFs.constants.O_RDONLY |" }],
  ["naming a file that cannot open", "a link at an address is not followed", { find: 'if (isNotOpenable(error))\n            return "not-an-object";', replace: "" }]
] as const) {
  test(`removing ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkNotObjects(storeVariant(edit)));
  });
}

test("a socket at an address is not an object either, though it will not even open", async () => {
  await withRoot(async (root) => {
    // Bound at a short name, since a socket's path has a low limit, then moved to the address.
    const server = createServer();
    const short = path.join(root, "s");
    await new Promise<void>((resolve) => server.listen(short, resolve));
    try {
      renameSync(short, path.join(root, "entries", ONE));
      assert.equal(await fsLogStores(root).entries.read(ONE, BOUND), "not-an-object");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("the log reads a folder at an address as a changed object, by its typed refusal", async () => {
  await withRoot(async (root) => {
    const stores = fsLogStores(root);
    await createLog(stores);
    const actor = runnerActorFrom(ATTEMPT_ONE) as Actor;
    const evidence = sha256OfText("evidence");
    await stores.evidence.createOnly(evidence, encode("evidence"));
    const first = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "first", data: {} }], evidence: [evidence], expectedHead: GENESIS, now: () => 1 });
    assert.ok(first.ok);

    rmSync(path.join(root, "evidence", evidence));
    mkdirSync(path.join(root, "evidence", evidence));
    assert.deepEqual(await openLog(stores, CASE_A), { ok: false, refusal: "evidence-changed", at: evidence });

    rmSync(path.join(root, "entries", first.digest));
    mkdirSync(path.join(root, "entries", first.digest));
    assert.deepEqual(await openLog(stores, CASE_A), { ok: false, refusal: "entry-edited", at: first.digest });
  });
});

test("every read closes what it opened, whatever it found", async () => {
  const check = async (module: StoreModule) => {
    await withDirectory("handles", async (root) => {
      module.prepareFsLogDirectory(root);
      await module.fsLogStores(root).entries.createOnly(ONE, encode("bytes"));
      await module.fsLogStores(root).head.compareAndSwap(null, ONE);
      mkdirSync(path.join(root, "entries", TWO));
      const open = new Set<number>();
      const counting: FsOps = {
        ...nodeFs,
        openSync: ((target: nodeFs.PathLike, flags: never) => {
          const handle = nodeFs.openSync(target, flags);
          open.add(handle);
          return handle;
        }) as FsOps["openSync"],
        closeSync: (handle) => {
          open.delete(handle);
          nodeFs.closeSync(handle);
        }
      };
      const stores = module.fsLogStores(root, counting);
      await stores.entries.read(ONE, BOUND);
      await stores.entries.read(ONE, 1);
      await stores.entries.read(TWO, BOUND);
      await stores.head.read(64);
      const left = [...open];
      for (const handle of left) nodeFs.closeSync(handle);
      holds("no read leaves a file open", left.length === 0, () => left);
    });
  };
  await check(productionStore);
  await assertCaughtBy("the close", "no read leaves a file open", () => check(storeVariant({ find: "ops.closeSync(handle);\n    }\n}\nfunction objectStore", replace: "}\n}\nfunction objectStore" })));
});

test("a swap compares the head exactly as stored, so a stray newline is not the same head", async () => {
  const check = async (module: StoreModule) => {
    await withDirectory("exact", async (root) => {
      module.prepareFsLogDirectory(root);
      writeFileSync(path.join(root, "head", "000000000001"), `${ONE.slice(0, 63)}\n`);
      const swapped = await module.fsLogStores(root).head.compareAndSwap(ONE.slice(0, 63), TWO);
      holds("a head that differs by a newline is another head", swapped === false, () => swapped);
    });
  };
  await check(productionStore);
  await assertCaughtBy("a trimmed comparison", "a head that differs by a newline is another head", () =>
    check(storeVariant({ find: "const value = now === null ? null : now.value;", replace: "const value = now === null ? null : now.value.trim();" }))
  );
});

test("a file past the bound is answered without reading it, whichever store holds it", async () => {
  await withRoot(async (root) => {
    await fsLogStores(root).evidence.createOnly(ONE, new Uint8Array(BOUND + 1));
    let reads = 0;
    const counting: FsOps = { ...nodeFs, readSync: ((...args: Parameters<typeof nodeFs.readSync>) => ((reads += 1), nodeFs.readSync(...args))) as FsOps["readSync"] };
    assert.equal(await fsLogStores(root, counting).evidence.read(ONE, BOUND), "too-large");
    assert.equal(reads, 0);
  });
});

test("a head past a digest's length reads as no digest, unread", async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, "head", "000000000001"), "f".repeat(65));
    assert.equal(await fsLogStores(root).head.read(64), "");
    writeFileSync(path.join(root, "head", "000000000001"), "f".repeat(64));
    assert.equal(await fsLogStores(root).head.read(64), "f".repeat(64));
  });
});

test("the head is the highest slot whatever order the folder lists in", async () => {
  const check = async (module: StoreModule) => {
    await withDirectory("order", async (root) => {
      module.prepareFsLogDirectory(root);
      const plain = module.fsLogStores(root);
      await plain.head.compareAndSwap(null, ONE);
      await plain.head.compareAndSwap(ONE, TWO);
      for (const order of [(names: string[]) => [...names].sort(), (names: string[]) => [...names].sort().reverse()]) {
        const listed: FsOps = { ...nodeFs, readdirSync: ((directory: string) => order(nodeFs.readdirSync(directory))) as unknown as FsOps["readdirSync"] };
        const value = await module.fsLogStores(root, listed).head.read(64);
        holds("the head is the highest slot, in any listing order", value === TWO, () => value);
      }
    });
  };
  await check(productionStore);
  await assertCaughtBy("the sort", "the head is the highest slot, in any listing order", () => check(storeVariant({ find: ".filter((name) => SLOT.test(name)).sort().at(-1)", replace: ".filter((name) => SLOT.test(name)).at(-1)" })));
});

const checkLastSlot = async (module: StoreModule) => {
  await withDirectory("last-slot", async (root) => {
    module.prepareFsLogDirectory(root);
    const stores = module.fsLogStores(root);
    await createLog(stores);
    const actor = runnerActorFrom(ATTEMPT_ONE) as Actor;
    const first = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "first", data: {} }], evidence: [], expectedHead: GENESIS, now: () => 1 });
    assert.ok(first.ok);
    // A planted last slot, naming the true head so that everything before the swap passes.
    writeFileSync(path.join(root, "head", "999999999999"), first.digest);
    let result: unknown;
    try {
      result = await appendCommand(stores, { caseId: CASE_A, actor, events: [{ type: "second", data: {} }], evidence: [], expectedHead: first.digest, now: () => 2 });
    } catch (error) {
      result = error;
    }
    holds("a swap past the last slot fails, and never reports a command it did not keep", result instanceof Error, () => result);
    holds("no slot is written where no read would look", !existsSync(path.join(root, "head", "1000000000000")), () => readdirSync(path.join(root, "head")));
    const opened = await openLog(stores, CASE_A);
    holds("the log still opens at its last true head", opened.ok && opened.log.head === first.digest, () => opened);
  });
};

test("a swap past the last slot is refused, so an append cannot report what no read would find", async () => {
  await checkLastSlot(productionStore);
});

test("removing the last slot's check is caught", async () => {
  await assertCaughtBy("the last slot's check", "a swap past the last slot fails, and never reports a command it did not keep", () =>
    checkLastSlot(storeVariant({ find: "if (slot > LAST_SLOT)\n                throw new Error(`The head has no slot past ${slotName(LAST_SLOT)}`);", replace: "" }))
  );
});

test("the slot just below the last one is still a slot, so the check is not early", async () => {
  await withRoot(async (root) => {
    const stores = fsLogStores(root);
    writeFileSync(path.join(root, "head", "999999999998"), ONE);
    assert.equal(await stores.head.compareAndSwap(ONE, TWO), true);
    assert.equal(await stores.head.read(64), TWO);
    assert.ok(existsSync(path.join(root, "head", "999999999999")));
  });
});

test("a temp file left by a failed link does not stand in the way of the next write in this process", async () => {
  const check = async (module: StoreModule) => {
    await withDirectory("leftover", async (root) => {
      module.prepareFsLogDirectory(root);
      let failed = false;
      const failingOnce: FsOps = {
        ...nodeFs,
        linkSync: (from, to) => {
          if (!failed) {
            failed = true;
            throw Object.assign(new Error("EIO"), { code: "EIO" });
          }
          nodeFs.linkSync(from, to);
        }
      };
      const stores = module.fsLogStores(root, failingOnce);
      await assert.rejects(() => stores.entries.createOnly(ONE, encode("first try")));
      let second: unknown;
      try {
        second = await stores.entries.createOnly(ONE, encode("second try"));
      } catch (error) {
        second = error;
      }
      holds("each write takes a temp name of its own", second === "created", () => second);
    });
  };
  await check(productionStore);
  await assertCaughtBy("a temp name that repeats", "each write takes a temp name of its own", () =>
    check(storeVariant({ find: "`${process.pid}-${crypto.randomUUID()}`", replace: "`${process.pid}`" }))
  );
});

test("prepare's first check is what keeps a refused link's target empty", async () => {
  const leavesTargetEmpty = async (module: StoreModule) => {
    await withDirectory("first-check", (base) => {
      const target = path.join(base, "target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, path.join(base, "link"));
      holds("a refused prepare makes nothing first", refusedBy(() => module.prepareFsLogDirectory(path.join(base, "link"))) && readdirSync(target).length === 0, () => readdirSync(target));
    });
  };
  await leavesTargetEmpty(productionStore);
  await assertCaughtBy("no first check", "a refused prepare makes nothing first", () =>
    leavesTargetEmpty(storeVariant({ find: "// Before anything is made, so a link at the root leaves its target's contents alone.\n    refuseUnsafeFolders(ops, resolved);\n", replace: "" }))
  );
});

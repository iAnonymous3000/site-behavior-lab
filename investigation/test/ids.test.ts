import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { isAttemptId } from "../core/actor";
import { isCaseId } from "../core/case-log";
import * as production from "../core/ids";
import { mintAttemptId, mintCaseId } from "../core/ids";

/**
 * The one source of ids. Each check here replaces WebCrypto's random source with bytes this
 * file chose, so what is compared is the mapping from those bytes to an id, spelled out,
 * and a mint that used any other source would not show those bytes at all.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/ids"), edits);

const BYTES = [0x00, 0x01, 0x0f, 0x10, 0xff, 0x7a, 0x80, 0xa5, 0x09, 0xc3, 0x3c, 0x5a, 0xe7, 0x18, 0x60, 0x06];
const HEX = "00010f10ff7a80a509c33c5ae7186006";

function withFixedRandom<T>(run: () => T): T {
  const original = crypto.getRandomValues;
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true,
    value: (array: Uint8Array) => {
      array.set(BYTES.slice(0, array.length));
      return array;
    }
  });
  try {
    return run();
  } finally {
    delete (crypto as unknown as Record<string, unknown>).getRandomValues;
    assert.equal(crypto.getRandomValues, original, "the real source is back");
  }
}

const MINT = "an id is sixteen bytes from WebCrypto, in lowercase hex, zero padded";

const checkMint = (module: Module) => {
  for (const mint of [module.mintCaseId, module.mintAttemptId]) {
    const id = withFixedRandom(mint);
    holds(MINT, id === HEX, () => id);
  }
};

test("an id is exactly the bytes WebCrypto gave, in hex, and the log and the actor accept its shape", () => {
  checkMint(production);
  for (const id of [mintCaseId(), mintAttemptId()]) {
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(isCaseId(id));
    assert.ok(isAttemptId(id));
  }
});

for (const [name, find, replace] of [
  ["fifteen bytes", "const ID_BYTES = 16;", "const ID_BYTES = 15;"],
  ["no padding", '.toString(16).padStart(2, "0")', ".toString(16)"],
  ["another random source", "const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTES));", "const bytes = new Uint8Array(ID_BYTES).map(() => Math.floor(Math.random() * 256));"],
  ["a time-based id", "const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTES));", "const bytes = new Uint8Array(ID_BYTES).fill(Date.now() % 256);"],
  ["uppercase hex", 'byte.toString(16).padStart(2, "0")', 'byte.toString(16).padStart(2, "0").toUpperCase()']
] as const) {
  test(`minting catches ${name}`, async () => {
    await assertCaughtBy(name, MINT, () => checkMint(variant({ find, replace })));
  });
}

test("real draws do not repeat, across a thousand of each", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 1000; index += 1) {
    seen.add(mintCaseId());
    seen.add(mintAttemptId());
  }
  assert.equal(seen.size, 2000);
});

const RANDOM_NAMES: readonly string[] = ["getRandomValues", "randomUUID", "randomBytes", "random"];

/**
 * Every place in a file that names something that could mint an id some other way: as a property,
 * an element access, a destructured or imported binding, or a string. It reads names, not
 * calls, so holding one to use later is seen too. A name built up at run time, such as by joining
 * two strings, is out of its reach, and that limit stands.
 */
function randomSourcesIn(file: string, source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && RANDOM_NAMES.includes(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return found;
}

const ROOT = process.cwd();
const CORE = "investigation/core";
const WORKER_ENTRY = "cloudflare/investigation-worker.ts";
const SINGLE = "nothing but ids.ts is a source of random ids";

const checkSingleSource = (read: (file: string) => string) => {
  const files = [WORKER_ENTRY, ...readdirSync(path.join(ROOT, CORE)).filter((file) => file.endsWith(".ts")).map((file) => `${CORE}/${file}`)];
  for (const file of files) {
    const found = randomSourcesIn(file, read(file));
    const expected = file === `${CORE}/ids.ts` ? ["getRandomValues"] : [];
    holds(SINGLE, JSON.stringify(found) === JSON.stringify(expected), () => ({ file, found }));
  }
};

const readProject = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

test("the Worker's side has exactly one source of randomness, and ids.ts is it", async () => {
  checkSingleSource(readProject);
  for (const [name, target, line] of [
    ["a second mint in the log", "investigation/core/case-log.ts", 'const mint = () => crypto.randomUUID();'],
    ["a second mint in the store", "investigation/core/case-store.ts", "const mint = () => crypto.getRandomValues(new Uint8Array(16));"],
    ["Math.random in the machine", "investigation/core/case-machine.ts", "const mint = () => Math.random();"],
    ["a second call in ids.ts", "investigation/core/ids.ts", "const again = () => crypto.getRandomValues(new Uint8Array(16));"],
    ["a mint in the Worker's entry", WORKER_ENTRY, "const mint = () => crypto.randomUUID();"],
    ["an element access in the store", "investigation/core/case-store.ts", 'const mint = () => crypto["randomUUID"]();'],
    ["an element access through a template", "investigation/core/case-store.ts", "const mint = () => crypto[`randomUUID`]();"],
    ["a destructured source in the store", "investigation/core/case-store.ts", "const { getRandomValues: draw } = crypto;"],
    ["a destructured source of the same name", "investigation/core/case-store.ts", "const { randomUUID } = crypto;"],
    ["an element access on Math", "investigation/core/case-machine.ts", 'const mint = () => Math["random"]();'],
    ["a destructured Math.random", "investigation/core/case-machine.ts", "const { random } = Math;"],
    ["an imported source", "investigation/core/case-store.ts", 'import { randomBytes } from "node:crypto";']
  ] as const) {
    await assertCaughtBy(name, SINGLE, () => checkSingleSource((file) => (file === target ? `${line}\n${readProject(file)}` : readProject(file))));
  }
});

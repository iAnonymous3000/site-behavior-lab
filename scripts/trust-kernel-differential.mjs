#!/usr/bin/env node
// Holds the Rust trust kernel's canonical JSON to the TypeScript reference,
// byte for byte, and refusal for refusal.
//
// The reference is lib/canonical-json.ts behind lib/strict-json.ts, read from
// the compiled unit-test tree (npx tsc -p tsconfig.test.json). It is not
// changed, wrapped or patched here; `reference` below only names the two
// conversions around it (strict UTF-8 in, UTF-8 out) and gives each of its
// thrown errors a word. The kernel is the WebAssembly module itself, the
// artifact a later phase would ship, not a native build of the same source.
//
// Two bodies of input:
//   corpus  every tracked *.json file in the repository, as its bytes, and
//           every entry of the transparency log on its own;
//   fuzz    generated from a fixed seed, so a run can be repeated exactly:
//           numbers, normalization, whole documents, and damaged documents.
//
// Any difference is a failure, and so is a reference error this file has no
// word for. Nothing is skipped and nothing is retried.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_WASM = "tools/trust-kernel/target/wasm32-unknown-unknown/release/sbl_trust_kernel_wasm.wasm";
export const FUZZ_SEED = 0x5b1c0de;

// The kernel's refusal codes (tools/trust-kernel/wasm/src/lib.rs), in the
// reference's own words where it has them.
const KERNEL_REFUSALS = [
  null,
  "too-large",
  "invalid-json",
  "duplicate-key",
  "too-deep",
  "non-finite-number",
  "key-not-nfc",
  "invalid-utf8",
  "not-admitted"
];

function parseArguments(argv) {
  const options = { wasm: DEFAULT_WASM, report: null, scale: 1, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--wasm") options.wasm = argv[++index];
    else if (argument === "--report") options.report = argv[++index];
    else if (argument === "--scale") options.scale = Number(argv[++index]);
    else if (argument === "--only") options.only = argv[++index];
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!(options.scale > 0)) throw new Error("--scale takes a positive number");
  return options;
}

function loadReference() {
  const require = createRequire(import.meta.url);
  const compiled = path.join(ROOT, ".unit-test-dist/lib");
  if (!existsSync(path.join(compiled, "canonical-json.js"))) {
    throw new Error("compile the reference first: npx tsc -p tsconfig.test.json");
  }
  const { canonicalJson } = require(path.join(compiled, "canonical-json.js"));
  const { parseStrictJson, StrictJsonError } = require(path.join(compiled, "strict-json.js"));
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  return function reference(bytes, maxUtf8Bytes) {
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      return { refusal: "invalid-utf8" };
    }
    let value;
    try {
      value = parseStrictJson(text, maxUtf8Bytes);
    } catch (error) {
      if (error instanceof StrictJsonError) return { refusal: error.reason };
      throw error;
    }
    let canonical;
    try {
      canonical = canonicalJson(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("canonicalJson: non-finite number at ")) return { refusal: "non-finite-number" };
      if (message.startsWith("canonicalJson: object key is not NFC-normalized at ")) return { refusal: "key-not-nfc" };
      throw error;
    }
    // The digest is taken over the UTF-8 of this string. A lone surrogate
    // has no UTF-8 form, and JSON.stringify escapes each one, so none can
    // be left; if one were, the encoder below would silently replace it.
    if (!canonical.isWellFormed()) throw new Error("the reference produced a lone surrogate");
    return { bytes: encoder.encode(canonical) };
  };
}

async function loadKernel(wasmPath) {
  const wasmBytes = readFileSync(path.resolve(ROOT, wasmPath));
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const { memory, sbl_input, sbl_canonicalize, sbl_output, sbl_output_length } = instance.exports;
  const kernel = function kernel(bytes, maxUtf8Bytes) {
    const at = sbl_input(bytes.length);
    new Uint8Array(memory.buffer, at, bytes.length).set(bytes);
    const code = sbl_canonicalize(maxUtf8Bytes === undefined ? -1 : maxUtf8Bytes);
    if (code !== 0) {
      const refusal = KERNEL_REFUSALS[code];
      if (!refusal) throw new Error(`the kernel returned an unknown code ${code}`);
      return { refusal };
    }
    const length = sbl_output_length();
    return { bytes: new Uint8Array(memory.buffer, sbl_output(), length).slice() };
  };
  kernel.sha256 = createHash("sha256").update(wasmBytes).digest("hex");
  kernel.byteLength = wasmBytes.length;
  return kernel;
}

function sameBytes(left, right) {
  return left.length === right.length && Buffer.compare(left, right) === 0;
}

class Tally {
  constructor(name) {
    this.name = name;
    this.cases = 0;
    this.accepted = 0;
    this.refused = {};
    this.differences = [];
    this.inputBytes = 0;
    this.numbersPrinted = 0;
  }

  record(label, bytes, expected, actual) {
    this.cases += 1;
    this.inputBytes += bytes.length;
    const same = expected.refusal !== undefined
      ? expected.refusal === actual.refusal
      : actual.bytes !== undefined && sameBytes(expected.bytes, actual.bytes);
    if (expected.refusal !== undefined) this.refused[expected.refusal] = (this.refused[expected.refusal] ?? 0) + 1;
    else this.accepted += 1;
    if (!same && this.differences.length < 20) {
      this.differences.push({
        label,
        inputHex: Buffer.from(bytes.subarray(0, 400)).toString("hex"),
        reference: describe(expected),
        kernel: describe(actual)
      });
    }
    if (!same) this.differenceCount = (this.differenceCount ?? 0) + 1;
    return same;
  }

  summary() {
    return {
      name: this.name,
      cases: this.cases,
      inputBytes: this.inputBytes,
      accepted: this.accepted,
      refused: Object.fromEntries(Object.entries(this.refused).sort()),
      ...(this.numbersPrinted > 0 ? { numbersPrinted: this.numbersPrinted } : {}),
      differences: this.differenceCount ?? 0
    };
  }
}

function describe(result) {
  if (result.refusal !== undefined) return { refusal: result.refusal };
  return {
    sha256: createHash("sha256").update(result.bytes).digest("hex"),
    length: result.bytes.length,
    head: Buffer.from(result.bytes.subarray(0, 200)).toString("utf8")
  };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function corpusGroup(file) {
  if (/^public\/reports\/[^/]+\.provenance\.json$/.test(file)) return "public/reports provenance sidecars";
  if (/^public\/reports\//.test(file)) return "public/reports reports";
  if (/^docs\/release-receipts\//.test(file)) return "release receipts";
  if (file === "public/transparency-log.json") return "transparency log (whole file)";
  if (/^public\//.test(file)) return "other public JSON";
  return "other tracked JSON";
}

function runCorpus(reference, kernel) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.json"], { cwd: ROOT, maxBuffer: 1 << 26 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const tallies = new Map();
  const tallyFor = (group) => {
    if (!tallies.has(group)) tallies.set(group, new Tally(group));
    return tallies.get(group);
  };
  const digests = { sidecars: 0, matchedByBoth: 0, matchedByNeither: 0, reportMissing: 0 };
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  for (const file of files) {
    const bytes = readFileSync(path.join(ROOT, file));
    const expected = reference(bytes);
    const actual = kernel(bytes);
    tallyFor(corpusGroup(file)).record(file, bytes, expected, actual);

    // A provenance sidecar names the digest of its report's canonical form.
    // Where the reference still reproduces that digest, the kernel must too.
    const sidecar = /^(public\/reports\/[^/]+)\.provenance\.json$/.exec(file);
    if (sidecar && expected.bytes) {
      const published = JSON.parse(bytes.toString("utf8")).publicDigest;
      const reportPath = path.join(ROOT, `${sidecar[1]}.json`);
      if (typeof published === "string" && existsSync(reportPath)) {
        digests.sidecars += 1;
        const report = readFileSync(reportPath);
        const fromReference = reference(report);
        const fromKernel = kernel(report);
        const referenceMatches = fromReference.bytes !== undefined && sha256(fromReference.bytes) === published;
        const kernelMatches = fromKernel.bytes !== undefined && sha256(fromKernel.bytes) === published;
        if (referenceMatches !== kernelMatches) {
          tallyFor("published digests").record(`${file} publicDigest`, report, fromReference, { refusal: "digest-mismatch" });
        } else if (referenceMatches) digests.matchedByBoth += 1;
        else digests.matchedByNeither += 1;
      } else {
        digests.reportMissing += 1;
      }
    }
  }

  // The transparency log's digests are taken over single entries, so each
  // entry is a canonical JSON artifact of its own.
  const log = JSON.parse(readFileSync(path.join(ROOT, "public/transparency-log.json"), "utf8"));
  const entries = new Tally("transparency log entries, each alone");
  for (const entry of log.entries) {
    const bytes = Buffer.from(JSON.stringify(entry), "utf8");
    entries.record(`transparency-log entry ${entry.sequence}`, bytes, reference(bytes), kernel(bytes));
  }
  tallies.set(entries.name, entries);

  return { files: files.length, digests, tallies: [...tallies.values()] };
}

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and the same sequence on every engine. */
function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  return {
    u32: next,
    below: (n) => next() % n,
    chance: (p) => next() / 0x100000000 < p,
    pick: (list) => list[next() % list.length]
  };
}

const doubleView = new DataView(new ArrayBuffer(8));
function doubleFromBits(high, low) {
  doubleView.setUint32(0, high);
  doubleView.setUint32(4, low);
  return doubleView.getFloat64(0);
}

const NUMBER_EDGES = [
  "0", "-0", "0.0", "-0.0", "0e0", "0E-0", "-0e+5", "1", "-1", "10", "100", "1e0", "1E0", "1e+0", "1e-0",
  "1e21", "1e20", "999999999999999999999", "1000000000000000000000", "123456789012345680000",
  "1e-6", "1e-7", "0.000001", "0.0000001", "0.00000123", "1.5e-7", "9.999999e-7",
  "5e-324", "4.9e-324", "2.4703282292062327e-324", "2.4703282292062328e-324", "2e-324", "1e-400",
  "1.7976931348623157e308", "1.7976931348623158e308", "1.7976931348623159e308", "1.797693134862315807e308",
  "1e308", "1e309", "-1e309", "2e308", "1e999", "1e99999999999999999999", "1e-99999999999999999999",
  "9007199254740991", "9007199254740992", "9007199254740993", "9007199254740995", "18014398509481985",
  "0.1", "0.2", "0.30000000000000004", "2.2250738585072014e-308", "2.2250738585072011e-308",
  "2.2250738585072012e-308", "4.35", "0.000035", "1.0000000000000002", "1.00000000000000011102230246251565404236316680908203125",
  "1.00000000000000011102230246251565404236316680908203124", "1.00000000000000011102230246251565404236316680908203126",
  "8.41e21", "5e-7", "123e-20", "123456789e-5", "0.1e1", "100e-2", "1.5e+300", "12345678901234567890123456789012345678901234567890"
];

function randomDouble(rng) {
  const mode = rng.below(8);
  if (mode === 0) return (rng.u32() | 0);
  if (mode === 1) return (rng.u32() | 0) / [10, 100, 1000, 1e4, 1e5, 1e6][rng.below(6)];
  if (mode === 2) return rng.u32() * 2 ** (rng.below(120) - 60);
  if (mode === 3) return doubleFromBits(rng.u32() & 0x800fffff, rng.u32()); // subnormals
  if (mode === 4) return doubleFromBits((rng.u32() & 0x80000000) | ((0x3ff + rng.below(80) - 30) << 20), rng.u32() & 0xff000000);
  return doubleFromBits(rng.u32(), rng.u32());
}

function numberText(rng) {
  if (rng.chance(0.04)) return rng.pick(NUMBER_EDGES);
  let x = randomDouble(rng);
  if (!Number.isFinite(x)) x = 0;
  const style = rng.below(10);
  let text;
  if (style < 4) text = Object.is(x, -0) ? "-0" : String(x);
  else if (style === 4) text = x.toExponential();
  else if (style === 5) text = x.toExponential(rng.below(25));
  else if (style === 6) text = x.toPrecision(1 + rng.below(21));
  else if (style === 7) text = Math.abs(x) < 1e21 ? x.toFixed(rng.below(20)) : String(x);
  else if (style === 8) {
    // The shortest text with digits appended: often one unit in the last
    // place away, sometimes exactly between two doubles.
    text = x.toExponential();
    const [mantissa, exponent] = text.split("e");
    let extra = "";
    for (let count = rng.below(30); count > 0; count -= 1) extra += String(rng.below(10));
    text = `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}${extra}e${exponent}`;
  } else {
    let digits = String(1 + rng.below(9));
    for (let count = rng.below(40); count > 0; count -= 1) digits += String(rng.below(10));
    text = rng.chance(0.5) ? digits : `${digits}e${rng.below(700) - 350}`;
    if (rng.chance(0.3)) text = `-${text}`;
  }
  if (rng.chance(0.2)) text = text.replace("e", "E");
  if (rng.chance(0.2)) text = text.replace(/[eE]\+/, (found) => found[0]);
  return text;
}

function fuzzNumbers(reference, kernel, rng, cases) {
  const tally = new Tally("fuzz: numbers");
  for (let index = 0; index < cases; index += 1) {
    const parts = [];
    // One number alone sometimes, so a refusal is a single number's.
    const count = rng.chance(0.3) ? 1 : 1 + rng.below(64);
    for (let item = 0; item < count; item += 1) parts.push(numberText(rng));
    const bytes = Buffer.from(count === 1 && rng.chance(0.5) ? parts[0] : `[${parts.join(",")}]`, "utf8");
    const expected = reference(bytes);
    tally.record(`numbers ${index}`, bytes, expected, kernel(bytes));
    // An array with one number past the largest double is refused whole, so
    // only the numbers of accepted cases were compared as printed text.
    if (expected.bytes) tally.numbersPrinted += count;
  }
  return tally;
}

/** Every code point through normalization: alone and in three contexts. */
function fuzzEveryCodePoint(reference, kernel) {
  const tally = new Tally("exhaustive: every code point, as a value and as a key");
  const BATCH = 2048;
  const contexts = [
    (ch) => ch,
    (ch) => `a${ch}`,
    (ch) => `${ch}́`,
    (ch) => `̣${ch}̈̄`
  ];
  for (let start = 0; start <= 0x10ffff; start += BATCH) {
    const values = [];
    for (let cp = start; cp < start + BATCH && cp <= 0x10ffff; cp += 1) {
      // A lone surrogate can reach the parser only as an escape.
      const ch = cp >= 0xd800 && cp <= 0xdfff ? `\\u${cp.toString(16)}` : String.fromCodePoint(cp);
      const literal = cp < 0x20 || cp === 0x22 || cp === 0x5c ? `\\u${cp.toString(16).padStart(4, "0")}` : ch;
      for (const context of contexts) values.push(`"${context(literal)}"`);
    }
    const asValues = Buffer.from(`[${values.join(",")}]`, "utf8");
    tally.record(`code points from U+${start.toString(16)} as values`, asValues, reference(asValues), kernel(asValues));
    // As keys, each alone: one key that is not in form C refuses the object,
    // so a shared object would hide every key after the first such.
    if (start < 0x30000 || start >= 0xe0000) {
      for (let cp = start; cp < start + BATCH && cp <= 0x10ffff; cp += 1) {
        const ch = cp >= 0xd800 && cp <= 0xdfff ? `\\u${cp.toString(16)}` : String.fromCodePoint(cp);
        const literal = cp < 0x20 || cp === 0x22 || cp === 0x5c ? `\\u${cp.toString(16).padStart(4, "0")}` : ch;
        const asKey = Buffer.from(`{"${literal}":0,"x${literal}́":1}`, "utf8");
        tally.record(`code point U+${cp.toString(16)} as a key`, asKey, reference(asKey), kernel(asKey));
      }
    }
  }
  return tally;
}

/** The code points normalization does anything with, found in this runtime. */
function activeCodePoints() {
  const active = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (cp >= 0xac00 && cp < 0xac00 + 11172) continue;
    const ch = String.fromCodePoint(cp);
    if (
      ch.normalize("NFD") !== ch ||
      `ͅ${ch}`.normalize("NFD") !== `ͅ${ch}` ||
      `${ch}̴`.normalize("NFD") !== `${ch}̴`
    ) {
      active.push(cp);
    }
  }
  // Everything that begins a composition: the first code points of the
  // decompositions above, which are mostly unremarkable letters.
  const firsts = new Set();
  for (const cp of active) firsts.add(String.fromCodePoint(cp).normalize("NFD").codePointAt(0));
  return [...new Set([...active, ...firsts])];
}

function fuzzNormalization(reference, kernel, rng, cases) {
  const tally = new Tally("fuzz: normalization sequences");
  const active = activeCodePoints();
  const jamo = [];
  for (let cp = 0x1100; cp <= 0x1112; cp += 1) jamo.push(cp);
  for (let cp = 0x1161; cp <= 0x1175; cp += 1) jamo.push(cp);
  for (let cp = 0x11a7; cp <= 0x11c3; cp += 1) jamo.push(cp);
  jamo.push(0x1113, 0x1160, 0x1176, 0x11a6);
  const unit = () => {
    const kind = rng.below(20);
    if (kind < 11) return String.fromCodePoint(rng.pick(active));
    if (kind < 13) return String.fromCodePoint(rng.pick(jamo));
    if (kind === 13) return String.fromCodePoint(0xac00 + rng.below(11172));
    if (kind === 14) return String.fromCharCode(0x61 + rng.below(26));
    if (kind === 15) return `\\u${(0xd800 + rng.below(0x800)).toString(16)}`;
    if (kind === 16) return String.fromCodePoint(0x10000 + rng.below(0x100000));
    if (kind === 17) return String.fromCodePoint(0x300 + rng.below(0x70));
    if (kind === 18) return String.fromCodePoint(0x80 + rng.below(0x2f80));
    const cp = rng.below(0xd800);
    return cp < 0x20 || cp === 0x22 || cp === 0x5c ? "x" : String.fromCodePoint(cp);
  };
  for (let index = 0; index < cases; index += 1) {
    const strings = [];
    for (let count = 1 + rng.below(40); count > 0; count -= 1) {
      let text = "";
      for (let length = 1 + rng.below(rng.chance(0.1) ? 40 : 6); length > 0; length -= 1) text += unit();
      strings.push(`"${text}"`);
    }
    const asKeys = rng.chance(0.25);
    const document = asKeys
      ? `{${strings.slice(0, 1 + rng.below(3)).map((key, at) => `${key}:${at}`).join(",")}}`
      : `[${strings.join(",")}]`;
    const bytes = Buffer.from(document, "utf8");
    tally.record(`normalization ${index}`, bytes, reference(bytes), kernel(bytes));
  }
  return tally;
}

const WHITESPACE = ["", "", "", " ", "\n", "\t", "\r", "  ", " \n\t"];
const KEY_POOL = [
  "a", "b", "c", "id", "url", "schemaVersion", "reportType", "", "1", "2", "10", "01", "__proto__", "constructor",
  "toString", "length", "café", "café", "é", "é", "", "😀", "￿", "\u007f",
  "A", "Z", "a b", "a\\\"b", "a\\\\b", "a\\/b", "\\u0061", "\\u0000", "\\ud800", "\\udc00", "\\ud83d\\ude00", " ",
  "가", "가", "Å", "Å", "ḳ̇", "ḳ̇"
];
const STRING_PIECES = [
  "", "a", "https://example.test/path?q=1", "\\n", "\\t", "\\r", "\\b", "\\f", "\\\"", "\\\\", "\\/", "\\u0000", "\\u001f",
  "\\u007f", "\\u00e9", "\\u0301", "é", "é", "\\ud800", "\\udfff", "\\ud83d\\ude00", "\\ud83d", "\\ude00\\ud83d",
  "😀", " ", " ", "\u007f", "\u0080", "߿", "ࠀ", "￿", "﻿", "각",
  "각", "̈́", "ཱི", "क़", "K", "יִ", "ẛ̣", "à֮̀̕b",
  " ", " ", "\\u0022", "\\u005c", "\\u005C", "\\uD83D\\uDE00", "\\u00E9"
];

function documentText(rng, depth, budget) {
  const ws = () => rng.pick(WHITESPACE);
  const kind = depth > budget.maxDepth ? rng.below(5) : rng.below(8);
  if (kind === 0) return rng.pick(["null", "true", "false"]);
  if (kind === 1 || kind === 2) return numberText(rng);
  if (kind === 3 || kind === 4) {
    let text = "";
    for (let count = rng.below(5); count > 0; count -= 1) text += rng.pick(STRING_PIECES);
    return `"${text}"`;
  }
  if (kind === 5) {
    const items = [];
    for (let count = rng.below(6); count > 0; count -= 1) items.push(documentText(rng, depth + 1, budget));
    return `[${ws()}${items.join(`${ws()},${ws()}`)}${ws()}]`;
  }
  const members = [];
  const used = new Set();
  for (let count = rng.below(7); count > 0; count -= 1) {
    let key = rng.pick(KEY_POOL);
    if (rng.chance(0.3)) key += String(rng.below(1000));
    // Mostly distinct keys, so the documents reach the canonicalizer;
    // sometimes a repeat, which the parser must refuse.
    if (used.has(key) && !rng.chance(0.05)) continue;
    used.add(key);
    members.push(`"${key}"${ws()}:${ws()}${documentText(rng, depth + 1, budget)}`);
  }
  return `{${ws()}${members.join(`${ws()},${ws()}`)}${ws()}}`;
}

function fuzzDocuments(reference, kernel, rng, cases) {
  const tally = new Tally("fuzz: documents");
  for (let index = 0; index < cases; index += 1) {
    let text = documentText(rng, 0, { maxDepth: 1 + rng.below(6) });
    // Nesting around the bound of 128, from both sides.
    if (rng.chance(0.03)) {
      const depth = 120 + rng.below(16);
      const open = rng.chance(0.5) ? "[" : '{"k":';
      const close = open === "[" ? "]" : "}";
      text = `${open.repeat(depth)}${text}${close.repeat(depth)}`;
    }
    text = `${rng.pick(WHITESPACE)}${text}${rng.pick(WHITESPACE)}`;
    const bytes = Buffer.from(text, "utf8");
    // A byte budget sometimes, around the document's own size.
    const budget = rng.chance(0.1) ? Math.max(0, bytes.length + rng.below(5) - 2) : undefined;
    tally.record(`document ${index}`, bytes, reference(bytes, budget), kernel(bytes, budget));
  }
  return tally;
}

const SPLICES = [
  "\"", "\\", "{", "}", "[", "]", ",", ":", "\\u", "\\ud800", "\\x", "e", "E", "-", "+", ".", "0", "00", "1e", "null",
  "tru", "nul", "\u0000", "\u001f", "́", "﻿", " ", "\n", " ", "\u000b", "//", "'", "NaN", "Infinity", "undefined"
].map((text) => Buffer.from(text, "utf8"));
const RAW_BYTES = [0x00, 0x1f, 0x22, 0x5c, 0x7f, 0x80, 0xbf, 0xc0, 0xc2, 0xe0, 0xed, 0xa0, 0xf0, 0xf4, 0xf5, 0xff];

function fuzzDamaged(reference, kernel, rng, cases) {
  const tally = new Tally("fuzz: damaged documents");
  for (let index = 0; index < cases; index += 1) {
    let bytes = Buffer.from(documentText(rng, 0, { maxDepth: 1 + rng.below(4) }), "utf8");
    for (let edits = 1 + rng.below(3); edits > 0; edits -= 1) {
      const at = bytes.length === 0 ? 0 : rng.below(bytes.length + 1);
      const edit = rng.below(6);
      if (edit === 0) bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(Math.min(bytes.length, at + 1 + rng.below(3)))]);
      else if (edit === 1) bytes = Buffer.concat([bytes.subarray(0, at), rng.pick(SPLICES), bytes.subarray(at)]);
      else if (edit === 2) bytes = Buffer.concat([bytes.subarray(0, at), Buffer.from([rng.pick(RAW_BYTES)]), bytes.subarray(at)]);
      else if (edit === 3) bytes = Buffer.from(bytes.subarray(0, at));
      else if (edit === 4 && bytes.length > 0) {
        bytes = Buffer.from(bytes);
        bytes[Math.min(at, bytes.length - 1)] ^= 1 << rng.below(8);
      } else {
        const from = rng.below(bytes.length + 1);
        bytes = Buffer.concat([bytes.subarray(0, at), bytes.subarray(from, from + rng.below(12)), bytes.subarray(at)]);
      }
    }
    tally.record(`damaged ${index}`, bytes, reference(bytes), kernel(bytes));
  }
  return tally;
}

// ---------------------------------------------------------------------------

/**
 * A comparison that cannot fail proves nothing. Before any real case, hold
 * the comparison itself to five broken kernels and one honest one, on fixed
 * inputs, and stop unless it counts exactly the broken ones as different.
 */
function checkTheComparison(reference, kernel) {
  const inputs = ['{"b":1,"a":[1.5,"e\u0301"]}', "[1e999]", '{"a":1,"a":2}', "[1,]", "957340073933683.25"].map((text) =>
    Buffer.from(text, "utf8")
  );
  const broken = [
    ["one byte changed", (bytes) => {
      const result = kernel(bytes);
      if (result.bytes && result.bytes.length > 0) result.bytes[result.bytes.length - 1] ^= 1;
      return result;
    }],
    ["one byte dropped", (bytes) => {
      const result = kernel(bytes);
      return result.bytes ? { bytes: result.bytes.subarray(0, result.bytes.length - 1) } : result;
    }],
    ["accepts everything", (bytes) => {
      const result = kernel(bytes);
      return result.bytes ? result : { bytes: new Uint8Array(0) };
    }],
    ["refuses everything", () => ({ refusal: "invalid-json" })],
    ["one refusal for every reason", (bytes) => {
      const result = kernel(bytes);
      return result.bytes ? result : { refusal: "not-admitted" };
    }]
  ];
  const honest = new Tally("comparison check: honest");
  for (const bytes of inputs) honest.record("honest", bytes, reference(bytes), kernel(bytes));
  if (honest.summary().differences !== 0 || honest.accepted !== 2) {
    throw new Error("the comparison check's fixed inputs no longer behave as written");
  }
  for (const [name, wrong] of broken) {
    const tally = new Tally(`comparison check: ${name}`);
    for (const bytes of inputs) tally.record(name, bytes, reference(bytes), wrong(bytes));
    if (tally.summary().differences === 0) {
      throw new Error(`the comparison did not notice a kernel with ${name}`);
    }
  }
  return broken.length;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = process.hrtime.bigint();
  const reference = loadReference();
  const kernel = await loadKernel(options.wasm);
  const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
  const wanted = (name) => options.only === null || options.only === name;
  const count = (base) => Math.max(1, Math.round(base * options.scale));
  const brokenKernelsCaught = checkTheComparison(reference, kernel);

  const report = {
    reference: "lib/canonical-json.ts canonicalJson after lib/strict-json.ts parseStrictJson",
    runtime: { node: process.versions.node, v8: process.versions.v8, unicode: process.versions.unicode },
    kernel: { wasm: options.wasm, sha256: kernel.sha256, bytes: kernel.byteLength },
    fuzzSeed: FUZZ_SEED,
    scale: options.scale,
    brokenKernelsCaught,
    sections: [],
    timings: {}
  };

  if (wanted("corpus")) {
    const before = seconds();
    const corpus = runCorpus(reference, kernel);
    report.corpus = { trackedJsonFiles: corpus.files, publishedDigests: corpus.digests };
    for (const tally of corpus.tallies) report.sections.push(tally);
    report.timings.corpus = seconds() - before;
  }
  const fuzz = [
    ["numbers", (rng) => fuzzNumbers(reference, kernel, rng, count(400_000))],
    ["code-points", () => fuzzEveryCodePoint(reference, kernel)],
    ["normalization", (rng) => fuzzNormalization(reference, kernel, rng, count(400_000))],
    ["documents", (rng) => fuzzDocuments(reference, kernel, rng, count(1_000_000))],
    ["damaged", (rng) => fuzzDamaged(reference, kernel, rng, count(1_000_000))]
  ];
  fuzz.forEach(([name, run], index) => {
    if (!wanted(name)) return;
    const before = seconds();
    // Each section has its own stream, so one can be rerun alone.
    report.sections.push(run(generator(FUZZ_SEED + index)));
    report.timings[name] = seconds() - before;
  });

  const differences = report.sections.flatMap((tally) => tally.differences);
  report.sections = report.sections.map((tally) => tally.summary());
  report.totals = {
    cases: report.sections.reduce((sum, section) => sum + section.cases, 0),
    accepted: report.sections.reduce((sum, section) => sum + section.accepted, 0),
    differences: report.sections.reduce((sum, section) => sum + section.differences, 0),
    seconds: Number(seconds().toFixed(1))
  };
  for (const key of Object.keys(report.timings)) report.timings[key] = Number(report.timings[key].toFixed(1));

  if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.totals.differences > 0) {
    console.error(`\n${report.totals.differences} difference(s) between the kernel and the reference. First ones:`);
    console.error(JSON.stringify(differences, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`\nNo difference in ${report.totals.cases} cases (${report.totals.seconds} s).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

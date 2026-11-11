#!/usr/bin/env node
// Writes tools/trust-kernel/kernel/src/nfc_tables.rs from the running
// JavaScript engine.
//
// canon-v1 normalizes string values with String.prototype.normalize("NFC"),
// so the Unicode data that decides its bytes is whatever the reference
// runtime carries. The Rust kernel has no Unicode library, by choice, so its
// tables are read out of that same runtime here. Nothing is downloaded.
//
// What is read:
// - the full canonical decomposition of each code point (normalize("NFD"));
// - which code points are non-starters, and the ORDER of their combining
//   classes. JavaScript does not expose the class numbers, and the algorithm
//   only ever compares two classes, so the table holds a rank per class: the
//   classes sorted, numbered from 1. Rank 0 is a starter.
// - the primary composites, as pairs (first, second) -> composite.
//
// Hangul syllables are composed and decomposed by arithmetic in the kernel
// and are left out of the tables.
//
// --check regenerates in memory and fails unless the committed file is
// byte-identical, which also fails when the runtime's Unicode version moves.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = path.join(ROOT, "tools/trust-kernel/kernel/src/nfc_tables.rs");

const S_BASE = 0xac00;
const S_COUNT = 11172;
const isHangulSyllable = (cp) => cp >= S_BASE && cp < S_BASE + S_COUNT;
const isSurrogate = (cp) => cp >= 0xd800 && cp <= 0xdfff;
const codePoints = (text) => Array.from(text, (ch) => ch.codePointAt(0));
const str = (...cps) => String.fromCodePoint(...cps);

export function buildTables() {
  // 1. Full canonical decompositions.
  const decompositions = [];
  const stable = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (isSurrogate(cp)) continue;
    const text = str(cp);
    const nfd = text.normalize("NFD");
    if (nfd === text) {
      stable.push(cp);
    } else if (!isHangulSyllable(cp)) {
      decompositions.push([cp, codePoints(nfd)]);
    }
  }

  // 2. Non-starters among the code points NFD leaves alone. A mark of class
  // 240 moves behind any mark of a lower nonzero class; a mark of class 1
  // moves ahead of any mark of a higher class. Between them the two probes
  // catch every nonzero class.
  const HIGH = 0x0345; // class 240, the highest assigned
  const LOW = 0x0334; // class 1, the lowest assigned
  const nonStarters = [];
  for (const cp of stable) {
    const afterHigh = str(HIGH, cp);
    const beforeLow = str(cp, LOW);
    if (afterHigh.normalize("NFD") !== afterHigh || beforeLow.normalize("NFD") !== beforeLow) {
      nonStarters.push(cp);
    }
  }
  if (!nonStarters.includes(HIGH) || !nonStarters.includes(LOW)) {
    throw new Error("the two probe marks are not non-starters in this runtime");
  }

  // 3. Order of classes: x has a higher class than y exactly when the pair
  // (x, y) is reordered.
  const higher = (x, y) => str(x, y).normalize("NFD") === str(y, x) && x !== y;
  const sorted = [...nonStarters].sort((x, y) => (higher(x, y) ? 1 : higher(y, x) ? -1 : x - y));
  const rankOf = new Map();
  let rank = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    if (index === 0 || higher(sorted[index], sorted[index - 1])) rank += 1;
    rankOf.set(sorted[index], rank);
  }
  if (rank > 255) throw new Error("more combining classes than a byte holds");
  // The sort assumed a strict weak order. Hold every pair of class
  // representatives, and every mark against each representative, to it.
  const representatives = [];
  for (const cp of sorted) {
    if (representatives.length < rankOf.get(cp)) representatives.push(cp);
  }
  for (const cp of nonStarters) {
    for (const representative of representatives) {
      const expected = rankOf.get(cp) > rankOf.get(representative);
      if (higher(cp, representative) !== expected) {
        throw new Error(`class order is not consistent at U+${cp.toString(16)}`);
      }
    }
  }
  const rankRanges = [];
  for (const cp of nonStarters) {
    const last = rankRanges.at(-1);
    if (last && last[1] === cp - 1 && last[2] === rankOf.get(cp)) last[1] = cp;
    else rankRanges.push([cp, cp, rankOf.get(cp)]);
  }

  // 4. Primary composites. A code point that decomposes and that NFC leaves
  // alone is one; its pair is the NFC of all but the last code point of its
  // full decomposition, and that last code point.
  const compositions = [];
  for (const [cp, nfd] of decompositions) {
    if (str(cp).normalize("NFC") !== str(cp)) continue;
    const second = nfd.at(-1);
    const head = codePoints(str(...nfd.slice(0, -1)).normalize("NFC"));
    if (head.length !== 1 || str(head[0], second).normalize("NFC") !== str(cp)) {
      throw new Error(`cannot read the composition pair of U+${cp.toString(16)}`);
    }
    compositions.push([head[0], second, cp]);
  }
  compositions.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let index = 1; index < compositions.length; index += 1) {
    const [a, b] = compositions[index];
    const [c, d] = compositions[index - 1];
    if (a === c && b === d) throw new Error("two composites share one pair");
  }

  return { decompositions, rankRanges, compositions };
}

const hex = (value) => `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;

function wrapped(items, perLine) {
  const lines = [];
  for (let index = 0; index < items.length; index += perLine) {
    lines.push(`    ${items.slice(index, index + perLine).join(", ")},`);
  }
  return lines.join("\n");
}

export function renderTables({ decompositions, rankRanges, compositions }) {
  const pool = [];
  const index = [];
  for (const [cp, nfd] of decompositions) {
    index.push(`(${hex(cp)}, ${pool.length}, ${nfd.length})`);
    pool.push(...nfd.map(hex));
  }
  if (pool.length > 0xffff) throw new Error("decomposition pool outgrew a u16 offset");
  return `// Generated by scripts/trust-kernel-nfc-tables.mjs. Do not edit by hand.
//
// Read out of the reference runtime: Node ${process.versions.node}, Unicode ${process.versions.unicode}
// (ICU ${process.versions.icu}). canon-v1 normalizes string values with that
// runtime's String.prototype.normalize, so these tables are what the bytes
// of a canonical form rest on. Hangul syllables are handled by arithmetic
// and are not listed.

/// The Unicode version of the runtime the tables were read from.
pub const UNICODE_VERSION: &str = "${process.versions.unicode}";

/// (code point, offset into DECOMPOSITION_POOL, length): the full canonical
/// decomposition of each code point that has one, sorted by code point.
#[rustfmt::skip]
pub static DECOMPOSITION_INDEX: [(u32, u16, u8); ${index.length}] = [
${wrapped(index, 4)}
];

#[rustfmt::skip]
pub static DECOMPOSITION_POOL: [u32; ${pool.length}] = [
${wrapped(pool, 10)}
];

/// (first, last, rank): inclusive ranges of non-starters. The rank orders
/// the canonical combining classes and is not the class number.
#[rustfmt::skip]
pub static CLASS_RANK_RANGES: [(u32, u32, u8); ${rankRanges.length}] = [
${wrapped(rankRanges.map(([a, b, r]) => `(${hex(a)}, ${hex(b)}, ${r})`), 4)}
];

/// (first, second, composite): the primary composites, sorted by pair.
#[rustfmt::skip]
pub static COMPOSITIONS: [(u32, u32, u32); ${compositions.length}] = [
${wrapped(compositions.map(([a, b, c]) => `(${hex(a)}, ${hex(b)}, ${hex(c)})`), 4)}
];
`;
}

function main() {
  const [command] = process.argv.slice(2);
  const rendered = renderTables(buildTables());
  if (command === "--write") {
    writeFileSync(OUTPUT, rendered);
    console.log(`wrote ${path.relative(ROOT, OUTPUT)} (Unicode ${process.versions.unicode})`);
    return;
  }
  if (command === "--check") {
    if (readFileSync(OUTPUT, "utf8") !== rendered) {
      throw new Error(
        `tools/trust-kernel/kernel/src/nfc_tables.rs is not what this runtime (Unicode ${process.versions.unicode}) generates`
      );
    }
    console.log(`NFC tables match this runtime (Unicode ${process.versions.unicode}).`);
    return;
  }
  throw new Error("Usage: trust-kernel-nfc-tables.mjs --write | --check");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

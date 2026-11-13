// Holds the Rust trust kernel's address classifier to the TypeScript
// reference, answer for answer. scripts/trust-kernel-differential.mjs runs
// this as its "addresses" part; it is not a program of its own.
//
// The reference is lib/ip-safety.ts, read from the compiled unit-test tree:
// the real exported isIpAddress, isPublicIpAddress and normalizeHostname,
// not changed, wrapped or patched. The kernel is the WebAssembly module.
//
// Two things are compared for every text:
//
//   the answer  the kernel's one of three (not an address, an address that
//               is not public, a public address) against isIpAddress and
//               isPublicIpAddress;
//   the value   where the kernel reads an address, the value it read against
//               a second reader. The checked statements in
//               tools/trust-kernel/kernel/src/address.rs are about values,
//               so a wrong reading would make them be about another address.
//               For four decimal octets the second reader is the text
//               itself and Node's net.isIPv4. For an IPv6 text it is this
//               Node's URL parser. One form the reference accepts has no
//               second reader, because no parser reads it: a dotted quad
//               before a closing `::`. The kernel has to mark that form, the
//               URL parser has to refuse it, and its value is held to the
//               reference's own reading (the words before the quad, then
//               zeros), restated here.
//
// The texts: every family of spellings lib/fv-ipv4-classifier.test.ts walks,
// both ends of every block either rule names and the address outside each
// end, in every way this file can spell an address, walks over whole words,
// and generated input from a fixed seed, valid and broken. Any difference is
// a failure. Nothing is skipped and nothing is retried.
//
// What this does not show: it is a sample of texts. The IPv6 space in the
// reference stays held by written-out cases in its own unit tests and by
// this comparison, and by nothing stronger.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

export const ADDRESS_FUZZ_SEED = 0x1b4dd2e5;

const ANSWERS = ["not-an-address", "not-public", "public"];

// ---------------------------------------------------------------------------
// The two sides
// ---------------------------------------------------------------------------

export function loadAddressReference(root) {
  const require = createRequire(import.meta.url);
  const compiled = path.join(root, ".unit-test-dist/lib/ip-safety.js");
  if (!existsSync(compiled)) throw new Error("compile the reference first: npx tsc -p tsconfig.test.json");
  const { isIpAddress, isPublicIpAddress, normalizeHostname } = require(compiled);
  return { isIpAddress, isPublicIpAddress, normalizeHostname };
}

/** The kernel's two address entry points, on a text or on bytes. */
export function addressKernel(exports) {
  const { memory, sbl_input, sbl_classify_address, sbl_read_address, sbl_output, sbl_output_length } = exports;
  const encoder = new TextEncoder();
  const give = (input) => {
    if (typeof input !== "string") {
      new Uint8Array(memory.buffer, sbl_input(input.length), input.length).set(input);
      return;
    }
    // A lone surrogate has no UTF-8 form and the encoder would replace it,
    // so the kernel would be asked about another text than the reference.
    if (!input.isWellFormed()) throw new Error("a text with a lone surrogate has no bytes to give the kernel");
    let ascii = true;
    for (let index = 0; index < input.length; index += 1) {
      if (input.charCodeAt(index) > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (!ascii) {
      const bytes = encoder.encode(input);
      new Uint8Array(memory.buffer, sbl_input(bytes.length), bytes.length).set(bytes);
      return;
    }
    const view = new Uint8Array(memory.buffer, sbl_input(input.length), input.length);
    for (let index = 0; index < input.length; index += 1) view[index] = input.charCodeAt(index);
  };
  return function ask(input) {
    give(input);
    const answer = sbl_classify_address();
    const family = sbl_read_address();
    const length = sbl_output_length();
    const value = Buffer.from(new Uint8Array(memory.buffer, sbl_output(), length)).toString("hex");
    return { answer, family, value };
  };
}

// ---------------------------------------------------------------------------
// The second reader of values
// ---------------------------------------------------------------------------

const hex4 = (word) => word.toString(16).padStart(4, "0");

/** The sixteen bytes, as hex, of the IPv6 address this Node's URL parser reads from a text, or null where it refuses. */
function urlParserReads(bare) {
  let host;
  try {
    host = new URL(`http://[${bare}]/`).hostname;
  } catch {
    return null;
  }
  if (!host.startsWith("[") || !host.endsWith("]")) throw new Error(`the URL parser gave ${host} for an IPv6 literal`);
  const [left, right] = host.slice(1, -1).split("::");
  const leftWords = left ? left.split(":") : [];
  const rightWords = right ? right.split(":") : [];
  const zeros = right === undefined ? 0 : 8 - leftWords.length - rightWords.length;
  const words = [...leftWords, ...Array(zeros).fill("0"), ...rightWords];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) throw new Error(`the URL parser gave ${host}, which is not eight words`);
  return words.map((word) => word.padStart(4, "0")).join("");
}

/**
 * What the kernel's reading of a text must be, by the second reader, given
 * the family the kernel named. Returns the expected family and value, or a
 * sentence saying why the kernel's reading cannot stand.
 */
function expectedReading(reference, text, family) {
  const bare = reference.normalizeHostname(text);
  if (family === 4) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(bare) || !net.isIPv4(bare)) return { problem: "Node does not read these as four decimal octets" };
    return { family: 4, value: bare.split(".").map((octet) => Number(octet).toString(16).padStart(2, "0")).join("") };
  }
  // Only these characters can stand in an address; anything else inside a
  // URL's brackets could end the host early and make the parser read less.
  if (!/^[0-9a-f:.]+$/.test(bare)) return { problem: "the text holds a character no IPv6 address has" };
  const parsed = urlParserReads(bare);
  if (parsed !== null) return { family: 6, value: parsed };
  // The URL parser refuses it. The one such form the reference accepts: a
  // dotted quad as the last part before a closing `::`. The reference then
  // judges the words before the quad as if zeros followed.
  const form = /^((?:[0-9a-f]{1,4}:){0,5})\d+\.\d+\.\d+\.\d+::$/.exec(bare);
  if (!form) return { problem: "the URL parser refuses the text, and it is not a dotted quad before a closing ::" };
  const words = form[1].split(":").filter(Boolean).map((word) => word.padStart(4, "0"));
  return { family: 7, value: [...words, ...Array(8 - words.length).fill("0000")].join("") };
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

class AddressTally {
  constructor(name) {
    this.name = name;
    this.cases = 0;
    this.answers = { "not-an-address": 0, "not-public": 0, public: 0 };
    this.valuesCompared = 0;
    this.dottedBeforeCompression = 0;
    this.differenceCount = 0;
    this.differences = [];
  }

  differ(text, detail) {
    this.differenceCount += 1;
    if (this.differences.length < 20) this.differences.push({ section: this.name, text: JSON.stringify(text), ...detail });
  }

  /** One text through both sides. `ask` is the kernel, or a broken one when the comparison itself is being tested. */
  compare(reference, ask, text) {
    this.cases += 1;
    const isAddress = reference.isIpAddress(text);
    const isPublic = reference.isPublicIpAddress(text);
    if (isPublic && !isAddress) throw new Error(`the reference calls ${JSON.stringify(text)} public and not an address`);
    const expected = isPublic ? 2 : isAddress ? 1 : 0;
    this.answers[ANSWERS[expected]] += 1;
    const kernel = ask(text);
    if (kernel.answer !== expected) {
      this.differ(text, { reference: ANSWERS[expected], kernel: ANSWERS[kernel.answer] ?? `code ${kernel.answer}` });
      return;
    }
    if ((kernel.family === 0) !== (kernel.answer === 0)) {
      this.differ(text, { reference: ANSWERS[expected], kernel: `answers ${ANSWERS[kernel.answer]} and reads family ${kernel.family}` });
      return;
    }
    if (kernel.family === 0) return;
    this.valuesCompared += 1;
    const second = expectedReading(reference, text, kernel.family);
    if (second.problem !== undefined || second.family !== kernel.family || second.value !== kernel.value) {
      this.differ(text, { reference: ANSWERS[expected], kernelRead: { family: kernel.family, value: kernel.value }, secondReader: second });
      return;
    }
    if (kernel.family === 7) this.dottedBeforeCompression += 1;
  }

  summary() {
    return {
      name: this.name,
      cases: this.cases,
      answers: this.answers,
      valuesCompared: this.valuesCompared,
      ...(this.dottedBeforeCompression > 0 ? { dottedBeforeClosingCompression: this.dottedBeforeCompression } : {}),
      differences: this.differenceCount
    };
  }
}

// ---------------------------------------------------------------------------
// Addresses and their spellings
// ---------------------------------------------------------------------------

/** mulberry32, as in the canonical JSON comparison: the same sequence on every engine. */
function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return { u32: next, below: (n) => next() % n, chance: (p) => next() / 0x100000000 < p, pick: (list) => list[next() % list.length] };
}

const OCTET = Array.from({ length: 256 }, (_, value) => String(value));
const quad = (address) => `${OCTET[address >>> 24]}.${OCTET[(address >>> 16) & 255]}.${OCTET[(address >>> 8) & 255]}.${OCTET[address & 255]}`;
const wordPair = (address) => `${(address >>> 16).toString(16)}:${(address & 0xffff).toString(16)}`;
const paddedWordPair = (address) => `${hex4(address >>> 16)}:${hex4(address & 0xffff)}`;

/**
 * Where to look in IPv4: the lines of the table in
 * lib/fv-ipv4-classifier.test.ts (its sixteen blocks, the two addresses the
 * registry marks reachable inside one, and three reachable blocks outside
 * all). The lines only choose addresses here. No verdict is taken from them:
 * every verdict is the reference's.
 */
const IPV4_LINES = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "255.255.255.255/32", "192.0.0.9/32", "192.0.0.10/32", "192.31.196.0/24", "192.52.193.0/24", "192.175.48.0/24"
];
const IPV4_PUBLIC_SAMPLES = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "172.32.0.1", "223.255.255.254", "8.8.8.25"];

function ipv4Number(text) {
  const [a, b, c, d] = text.split(".").map(Number);
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

function ipv4Edges() {
  const edges = [];
  for (const line of IPV4_LINES) {
    const [address, length] = line.split("/");
    const low = ipv4Number(address);
    const high = low + 2 ** (32 - Number(length)) - 1;
    for (const edge of [low - 1, low, high, high + 1]) if (edge >= 0 && edge < 2 ** 32) edges.push(edge);
  }
  return edges;
}

const IPV4_EDGE_PREFIXES = [...new Set(ipv4Edges().map((address) => Math.floor(address / 256)))].sort((a, b) => a - b);
const IPV4_SAMPLE = [...new Set([...ipv4Edges(), ...IPV4_PUBLIC_SAMPLES.map(ipv4Number)])].sort((a, b) => a - b);

/**
 * Where to look in IPv6: every prefix the kernel's rule names, every prefix
 * the reference's comments name, and their neighbours. As with IPv4, these
 * only choose addresses.
 */
const IPV6_LINES = [
  "::/128", "::1/128", "::ffff:0:0/96", "::ffff:0:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "200::/7", "2000::/3", "2001::/23", "2001::/32",
  "2001:1::/32", "2001:1::1/128", "2001:1::2/128", "2001:1::3/128", "2001:2::/48", "2001:3::/32", "2001:4::/32", "2001:4:112::/48",
  "2001:10::/28", "2001:20::/28", "2001:30::/28", "2001:200::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20",
  "4000::/3", "5f00::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"
];

/** An IPv6 address written with one `::` or none, as eight words. For this file's own tables only. */
function wordsOf(text) {
  const [left, right] = text.split("::");
  const leftWords = left ? left.split(":").map((word) => Number.parseInt(word, 16)) : [];
  const rightWords = right ? right.split(":").map((word) => Number.parseInt(word, 16)) : [];
  if (right === undefined) return leftWords;
  return [...leftWords, ...Array(8 - leftWords.length - rightWords.length).fill(0), ...rightWords];
}

const bigOf = (words) => words.reduce((sum, word) => (sum << 16n) | BigInt(word), 0n);
const wordsOfBig = (value) => Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(16 * (7 - index))) & 0xffffn));
const TOP = (1n << 128n) - 1n;

function ipv6Edges() {
  const edges = new Map();
  for (const line of IPV6_LINES) {
    const [address, length] = line.split("/");
    const low = bigOf(wordsOf(address));
    const high = low + (1n << BigInt(128 - Number(length))) - 1n;
    for (const edge of [low - 1n, low, low + 1n, low + 2n, low + 3n, low + 4n, high - 1n, high, high + 1n]) {
      if (edge >= 0n && edge <= TOP) edges.set(edge, wordsOfBig(edge));
    }
  }
  return [...edges.values()];
}

/** Every run of zero words, and every part of one: each can be written `::`. */
function zeroRanges(words) {
  const ranges = [];
  for (let start = 0; start < 8; start += 1) {
    for (let end = start + 1; end <= 8 && words[end - 1] === 0; end += 1) ranges.push([start, end]);
  }
  return ranges;
}

/**
 * One spelling of eight words. `range` is the words written as `::`, `dotted`
 * writes the last two words as a dotted quad, `widths` pads each word with
 * zeros to a width, `upper` picks the letters written in upper case.
 */
function spell(words, { range = null, dotted = false, widths = null, upper = null } = {}) {
  const piece = (word, index) => {
    let text = word.toString(16).padStart(widths ? widths[index] : 1, "0");
    if (upper) text = upper === true ? text.toUpperCase() : [...text].map((character, at) => (upper(index, at) ? character.toUpperCase() : character)).join("");
    return text;
  };
  const head = words.slice(0, 6).map(piece);
  const tail = dotted ? [`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`] : [piece(words[6], 6), piece(words[7], 7)];
  const parts = [...head, ...tail];
  if (!range) return parts.join(":");
  // With a dotted tail the parts after word 5 are one, so a range must end
  // at word 6 or before; the callers keep to that.
  return `${parts.slice(0, range[0]).join(":")}::${parts.slice(range[1]).join(":")}`;
}

/** The spelling RFC 5952 recommends: the longest run of two or more zero words, the first of equals, written `::`. */
function canonicalSpelling(words) {
  let best = null;
  for (const [start, end] of zeroRanges(words)) {
    if (end - start >= 2 && (best === null || end - start > best[1] - best[0])) best = [start, end];
  }
  return spell(words, { range: best });
}

const FOUR = Array(8).fill(4);

/** Every spelling of eight words this file knows, without decoration. */
function everySpelling(words) {
  const spellings = new Set([
    spell(words),
    spell(words, { widths: FOUR }),
    spell(words, { widths: FOUR, upper: true }),
    spell(words, { upper: true }),
    spell(words, { dotted: true }),
    canonicalSpelling(words)
  ]);
  for (const range of zeroRanges(words)) {
    spellings.add(spell(words, { range }));
    spellings.add(spell(words, { range, widths: FOUR }));
    if (range[1] <= 6) spellings.add(spell(words, { range, dotted: true }));
  }
  return [...spellings];
}

/** A text as normalizeHostname may meet it: bare, bracketed, with dots and with stray marks. */
const decorated = (text) => [text, `[${text}]`, `${text}.`, `[${text}].`, `[${text}`, `${text}]`, `${text}..`, `[[${text}]]`, `${text}.]`, ` ${text}`, `${text}%1`];

function randomSpelling(rng, words) {
  const ranges = zeroRanges(words);
  const range = ranges.length > 0 && rng.chance(0.7) ? rng.pick(ranges) : null;
  const dotted = rng.chance(0.25) && (range === null || range[1] <= 6);
  const widths = rng.chance(0.3) ? Array.from({ length: 8 }, () => 1 + rng.below(4)) : null;
  const bits = rng.u32();
  const upper = rng.chance(0.3) ? (index, at) => ((bits >>> ((index * 4 + at) % 32)) & 1) === 1 : null;
  return spell(words, { range, dotted, widths, upper });
}

const INTERESTING_WORDS = [
  0, 0, 0, 0, 1, 2, 3, 4, 0x64, 0x100, 0x111, 0x112, 0x113, 0x1ff, 0x200, 0xdb8, 0xfff, 0x1000, 0x1fff, 0x2000, 0x2001, 0x2002,
  0x2600, 0x2620, 0x3ffe, 0x3fff, 0x4000, 0x5f00, 0x7f00, 0x808, 0xa00, 0xc0a8, 0xfc00, 0xfe80, 0xfec0, 0xff00, 0xff9b, 0xffff
];

function randomWords(rng, edges) {
  const kind = rng.below(20);
  if (kind < 5) {
    // Near a line of either rule.
    const words = [...rng.pick(edges)];
    if (rng.chance(0.5)) words[7 - rng.below(4)] = rng.pick(INTERESTING_WORDS);
    return words;
  }
  if (kind < 7) {
    // IPv4-mapped, and what looks like it.
    const address = rng.chance(0.6) ? rng.pick(IPV4_SAMPLE) : rng.u32();
    const words = [0, 0, 0, 0, 0, 0xffff, address >>> 16, address & 0xffff];
    if (rng.chance(0.15)) words[rng.below(6)] = rng.pick([0, 1, 0xffff, 0xfffe]);
    return words;
  }
  if (kind < 9) {
    // The three anycast addresses and their neighbours.
    const words = [0x2001, 1, 0, 0, 0, 0, 0, rng.below(6)];
    if (rng.chance(0.3)) words[2 + rng.below(5)] = rng.pick([0, 1, 0xffff]);
    if (rng.chance(0.2)) words[1] = rng.pick([0, 1, 2, 3, 4]);
    return words;
  }
  if (kind < 14) return Array.from({ length: 8 }, () => rng.pick(INTERESTING_WORDS));
  return Array.from({ length: 8 }, () => (rng.chance(0.3) ? 0 : rng.u32() & 0xffff));
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

/** Every address of every /24 that holds an end of a table line or the address outside it, as a dotted quad and in both mapped spellings. */
function ipv4EdgePrefixes(compare) {
  for (const prefix of IPV4_EDGE_PREFIXES) {
    for (let d = 0; d < 256; d += 1) {
      const address = prefix * 256 + d;
      compare(quad(address));
      compare(`::ffff:${quad(address)}`);
      compare(`::ffff:${wordPair(address)}`);
    }
  }
}

/**
 * Every prefix of three octets, at the fourth octets 0 and 255 and at one
 * that moves with the prefix through 1 to 254: the walk of the TypeScript
 * suite. `stride` above 1 takes every stride-th prefix, for a short run.
 */
function ipv4EveryPrefix(compare, stride) {
  for (let prefix = 0; prefix < 2 ** 24; prefix += stride) {
    const abc = `${OCTET[prefix >>> 16]}.${OCTET[(prefix >>> 8) & 255]}.${OCTET[prefix & 255]}.`;
    compare(`${abc}0`);
    compare(`${abc}255`);
    compare(abc + OCTET[1 + (prefix % 254)]);
  }
}

const RADIXES = [(value) => String(value), (value) => `0${value.toString(8)}`, (value) => `0x${value.toString(16)}`, (value) => `0X${value.toString(16).toUpperCase()}`];

/** Every spelling of an address inet_aton accepts in these radixes: four parts, three, two and one. */
function inetAtonSpellings(address) {
  const a = address >>> 24;
  const b = (address >>> 16) & 255;
  const c = (address >>> 8) & 255;
  const d = address & 255;
  const out = [];
  for (const parts of [[a, b, c, d], [a, b, c * 256 + d], [a, (b * 256 + c) * 256 + d], [address]]) {
    const choose = (index, texts) => {
      if (index === parts.length) out.push(texts.join("."));
      else for (const radix of RADIXES) choose(index + 1, [...texts, radix(parts[index])]);
    };
    choose(0, []);
  }
  return out;
}

const PAST_RANGE = ["256.8.8.8", "8.256.8.8", "8.8.256.8", "8.8.8.256", "999.8.8.8", "8.8.8.1000", "8.8.8.4294967296", "8.8.8.1e1", "8.8.8.-1", "8.8.8.+1"];

function ipv4OddSpellings(compare) {
  for (const address of IPV4_SAMPLE) {
    for (const text of inetAtonSpellings(address)) {
      compare(text);
      compare(`${text}.`);
    }
  }
  for (const text of PAST_RANGE) compare(text);
  // Leading zeros, of every length that could still look like an octet.
  for (const octet of ["0", "00", "000", "01", "001", "0001", "08", "09", "010", "0255", "00255"]) {
    for (let position = 0; position < 4; position += 1) {
      const parts = ["8", "8", "8", "8"];
      parts[position] = octet;
      compare(parts.join("."));
      compare(`::ffff:${parts.join(".")}`);
      compare(`2600::${parts.join(".")}`);
    }
  }
}

/** One further character before or after the sample: every ASCII code, and marks from outside ASCII. */
function ipv4Decorated(compare) {
  const marks = [...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)), "\u00a0", "\u0660", "\u06f1", "\uff11", "\u2028", "\ufeff", "\u212a", "\u0130", "\uff0e", "\u3002"];
  for (const address of IPV4_SAMPLE) {
    const plain = quad(address);
    for (const text of decorated(plain)) compare(text);
    for (const mark of marks) {
      compare(`${mark}${plain}`);
      compare(`${plain}${mark}`);
    }
  }
}

/** The mapped spellings and the other IPv6 carriers of an IPv4 address that the TypeScript suite writes out. */
function ipv4Carried(compare) {
  for (let high = 0; high < 2 ** 16; high += 1) {
    for (const low of [0, 255, 255 * 256, 2 ** 16 - 1]) {
      const address = high * 2 ** 16 + low;
      compare(`::ffff:${quad(address)}`);
      compare(`::ffff:${wordPair(address)}`);
    }
  }
  for (const address of IPV4_SAMPLE) {
    const q = quad(address);
    const w = wordPair(address);
    for (const text of [
      `::ffff:${q}`, `::FFFF:${q}`, `[::ffff:${q}]`, `::ffff:${w}`, `::ffff:${paddedWordPair(address)}`, `::FFFF:${w.toUpperCase()}`, `[::ffff:${w}]`,
      `::${q}`, `::${w}`, `0:0:0:0:0:ffff:${w}`, `0:0:0:0:0:ffff:${q}`, `::ffff:0:${w}`, `::ffff:0:${q}`, `64:ff9b::${q}`, `64:ff9b::${w}`,
      `64:ff9b:1::${w}`, `2002:${w}::1`, `2001:0:${w}::1`, `::0:ffff:${q}`, `0::ffff:${w}`, `::0ffff:${q}`, `::fffff:${q}`, `:ffff:${q}`, `::ffff:${q}:`,
      `::ffff:${q}::`, `::ffff::${q}`, `::ffff:${q}.`, `::ffff:${w}.`, `::ffff.${q}`
    ]) {
      compare(text);
    }
    // Every spelling of the mapped address as eight words: only two forms get the IPv4 rule.
    for (const text of everySpelling([0, 0, 0, 0, 0, 0xffff, address >>> 16, address & 0xffff])) compare(text);
  }
}

/** Both ends of every line of either rule and the addresses around them, in every spelling and decoration. */
function ipv6EdgeSpellings(compare, edges) {
  for (const words of edges) {
    for (const spelling of everySpelling(words)) {
      for (const text of decorated(spelling)) compare(text);
    }
  }
}

/** Whole words: every first word, every second word under 2001 and 3fff, with thirds and tails that the rule tells apart. */
function ipv6WordWalks(compare, rng) {
  const tails = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [0, 0, 0, 0, 3], [0, 0, 0, 0, 4], [0, 0, 0, 1, 1], [1, 0, 0, 0, 1], [0xffff, 0xffff, 0xffff, 0xffff, 0xffff]];
  const write = (words) => {
    compare(spell(words));
    compare(canonicalSpelling(words));
    compare(randomSpelling(rng, words));
  };
  for (let first = 0; first < 2 ** 16; first += 1) {
    for (const second of [0, 1, 3, 4, 0x1ff, 0x200, 0xdb8, 0xfff, 0x1000, 0xffff]) write([first, second, rng.pick([0, 0x112]), ...rng.pick(tails)]);
  }
  for (let second = 0; second < 2 ** 16; second += 1) {
    for (const third of [0, 0x111, 0x112, 0x113, 0xffff]) write([0x2001, second, third, ...rng.pick(tails)]);
    write([0x3fff, second, rng.u32() & 0xffff, ...rng.pick(tails)]);
    write([0x2002, second, rng.u32() & 0xffff, ...rng.pick(tails)]);
  }
  for (let third = 0; third < 2 ** 16; third += 1) {
    for (const second of [1, 3, 4, 5]) write([0x2001, second, third, ...rng.pick(tails)]);
  }
  // 2001:1::/32 by its last word and by one stray word: only three addresses are let through.
  for (let last = 0; last < 2 ** 16; last += 1) {
    write([0x2001, 1, 0, 0, 0, 0, 0, last]);
    const stray = [0x2001, 1, 0, 0, 0, 0, 0, 1 + (last % 3)];
    stray[2 + (last % 5)] = 1 + (last >> 4);
    write(stray);
  }
}

/** A dotted quad before a closing `::`, which the reference accepts, and the forms beside it, which it does not. */
function dottedBeforeCompression(compare) {
  const firsts = ["", "0", "1", "64", "1fff", "2000", "2001", "2002", "2600", "3ffe", "3fff", "4000", "fc00", "fe80", "ffff"];
  const seconds = ["", "0", "1", "3", "4", "1ff", "200", "db8", "fff", "1000"];
  const thirds = ["", "0", "112", "113"];
  const rests = [[], ["0"], ["0", "0"], ["ffff", "0"], ["0", "0", "0"], ["0", "0", "ffff"], ["0", "0", "0", "0"]];
  const quads = ["8.8.8.8", "127.0.0.1", "1.18.0.0", "0.0.0.0", "255.255.255.255", "10.0.0.1", "01.2.3.4", "256.1.1.1", "1.2.3", "1.2.3.4.5"];
  const closings = ["::", "::1", ":", "", "::0", ":::", "::.", "::]"];
  for (const first of firsts) {
    for (const second of seconds) {
      for (const third of thirds) {
        for (const rest of rests) {
          const words = [first, second, third, ...rest].filter((word) => word !== "");
          for (const dottedQuad of quads) {
            for (const closing of closings) {
              const text = `${[...words, dottedQuad].join(":")}${closing}`;
              compare(text);
              if (closing === "::") for (const wrapped of decorated(text).slice(1)) compare(wrapped);
            }
          }
        }
      }
    }
  }
}

/** Every code point but the surrogates, beside two addresses: no character outside ASCII may make or keep an address. */
function everyCodePoint(compare) {
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const mark = String.fromCodePoint(codePoint);
    compare(`8.8.8.8${mark}`);
    compare(`${mark}2600::1`);
    compare(`2001:1:${mark}:1`);
  }
}

function fuzzValid(compare, rng, edges, cases) {
  for (let index = 0; index < cases; index += 1) {
    let text;
    if (rng.chance(0.15)) {
      text = quad(rng.chance(0.5) ? rng.pick(IPV4_SAMPLE) : rng.u32());
    } else {
      text = randomSpelling(rng, randomWords(rng, edges));
    }
    if (rng.chance(0.2)) text = rng.pick(decorated(text).slice(1, 6));
    compare(text);
  }
}

const SPLICES = [
  "::", ":", ".", "::", ":", ".", "0", "00", "1", "f", "ffff", "ffff:", "::ffff:", "1.2.3.4", "8.8.8.8", "256", "01", "2001:1::1", "2001", "db8", "[", "]", "%", "g", "G", "x", " ",
  "/", "-", "+", "e", "E", "\u0000", "\n", "\u212a", "\u0130", "\uff11", "\u0660", "\u3002", "\ud83d\ude00"
];
const ALPHABET = "0123456789abcdefABCDEF::::....[]%gx ";

function fuzzBroken(compare, rng, edges, cases) {
  for (let index = 0; index < cases; index += 1) {
    let text;
    const start = rng.below(10);
    if (start < 2) {
      text = "";
      for (let length = rng.below(30); length > 0; length -= 1) text += ALPHABET[rng.below(ALPHABET.length)];
    } else if (start < 4) {
      text = quad(rng.chance(0.5) ? rng.pick(IPV4_SAMPLE) : rng.u32());
    } else if (start === 4) {
      // A dotted quad in the middle of the words, closed or not.
      const words = Array.from({ length: rng.below(7) }, () => rng.pick(INTERESTING_WORDS).toString(16));
      text = `${[...words, quad(rng.pick(IPV4_SAMPLE))].join(":")}${rng.pick(["::", "::", "::", ":", "", "::1"])}`;
    } else {
      text = randomSpelling(rng, randomWords(rng, edges));
    }
    for (let edits = start === 4 ? rng.below(2) : 1 + rng.below(3); edits > 0; edits -= 1) {
      // Whole characters, so a pair of surrogates is never cut in two.
      const characters = [...text];
      const at = rng.below(characters.length + 1);
      const edit = rng.below(6);
      if (edit === 0) characters.splice(at, 1 + rng.below(2));
      else if (edit === 1 || edit === 2) characters.splice(at, 0, rng.pick(SPLICES));
      else if (edit === 3) characters.splice(at, 1, rng.pick(SPLICES));
      else if (edit === 4) characters.length = at;
      else characters.splice(at, 0, ...characters.slice(rng.below(characters.length + 1)).slice(0, rng.below(8)));
      text = characters.join("");
    }
    compare(text);
  }
}

/**
 * Bytes that are not UTF-8 have no text to give the reference. The kernel
 * must call each one no address. Returns how many it called an address.
 */
function notUtf8(ask, rng, cases) {
  const strict = new TextDecoder("utf-8", { fatal: true });
  const bases = ["8.8.8.8", "2600::1", "::ffff:8.8.8.8", "[2001:1::1]", ""].map((text) => Buffer.from(text, "latin1"));
  const raw = [0x80, 0xbf, 0xc0, 0xc2, 0xe0, 0xed, 0xa0, 0xf0, 0xf4, 0xf5, 0xff];
  let tried = 0;
  let wrong = 0;
  while (tried < cases) {
    const base = rng.pick(bases);
    const at = rng.below(base.length + 1);
    const bytes = Buffer.concat([base.subarray(0, at), Buffer.from(Array.from({ length: 1 + rng.below(2) }, () => rng.pick(raw))), base.subarray(at)]);
    try {
      strict.decode(bytes);
      continue;
    } catch {
      // Not UTF-8, as wanted.
    }
    tried += 1;
    const kernel = ask(bytes);
    if (kernel.answer !== 0 || kernel.family !== 0) wrong += 1;
  }
  return { cases: tried, calledAnAddress: wrong };
}

// ---------------------------------------------------------------------------
// The comparison's own test
// ---------------------------------------------------------------------------

/**
 * A comparison that cannot fail shows nothing. Before any real case, hold it
 * to eight kernels that are wrong in ways the real one could be, on fixed
 * texts, and stop unless it counts each as different and the real one as the
 * same. The last three are wrong only in a place where the reference's
 * verdict follows the spelling, or only in the value.
 */
function checkTheAddressComparison(reference, ask) {
  const texts = [
    "8.8.8.8", "10.0.0.1", "192.0.0.9", "0177.0.0.1", "example.test", "2600::1", "::1", "2001:1::1", "2001:1:0:0:0:0:0:1", "::ffff:8.8.8.8",
    "0:0:0:0:0:ffff:8.8.8.8", "2600:8.8.8.8::", "[8.8.8.8", "2001:db8::1", "1:2:3:4:5:6:7:8"
  ];
  // The same address in the spelling RFC 5952 recommends: what a reader of values alone would judge.
  const respelled = (text) => {
    const read = ask(text);
    if (read.family !== 6) return text;
    const words = read.value.match(/.{4}/g).map((word) => Number.parseInt(word, 16));
    const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    return mapped ? `::ffff:${words[6].toString(16)}:${words[7].toString(16)}` : canonicalSpelling(words);
  };
  const broken = [
    ["every address public", (text) => ({ ...ask(text), answer: ask(text).answer === 0 ? 0 : 2 })],
    ["no address public", (text) => ({ ...ask(text), answer: Math.min(ask(text).answer, 1) })],
    ["nothing an address", () => ({ answer: 0, family: 0, value: "" })],
    ["every text an address", (text) => ({ ...ask(text), answer: Math.max(ask(text).answer, 1) })],
    ["a leading zero read as decimal", (text) => ask(text.replace(/(^|\.)0+(\d)/g, "$1$2"))],
    ["the value judged, whatever the spelling", (text) => ({ ...ask(text), answer: ask(respelled(text)).answer })],
    ["only what a parser reads is an address", (text) => (ask(text).family === 7 ? { answer: 0, family: 0, value: "" } : ask(text))],
    ["the last byte of the value wrong", (text) => {
      const read = ask(text);
      return read.family === 0 ? read : { ...read, value: `${read.value.slice(0, -1)}${read.value.endsWith("0") ? "1" : "0"}` };
    }]
  ];
  const honest = new AddressTally("comparison check: the kernel itself");
  for (const text of texts) honest.compare(reference, ask, text);
  if (honest.differenceCount !== 0 || honest.answers.public < 3 || honest.answers["not-public"] < 3 || honest.answers["not-an-address"] < 2 || honest.dottedBeforeCompression !== 1) {
    throw new Error(`the address comparison's fixed texts no longer behave as written: ${JSON.stringify(honest.summary())} ${JSON.stringify(honest.differences)}`);
  }
  for (const [name, wrong] of broken) {
    const tally = new AddressTally(`comparison check: ${name}`);
    for (const text of texts) tally.compare(reference, wrong, text);
    if (tally.differenceCount === 0) throw new Error(`the address comparison did not notice a kernel with ${name}`);
  }
  return broken.length;
}

// ---------------------------------------------------------------------------

/**
 * Runs every section. `scale` multiplies the generated cases and thins the
 * walk over every IPv4 prefix; every other section is the same on every run.
 */
export function runAddressComparison({ root, exports, scale }) {
  const reference = loadAddressReference(root);
  const ask = addressKernel(exports);
  const brokenKernelsCaught = checkTheAddressComparison(reference, ask);
  const edges = ipv6Edges();
  const count = (base) => Math.max(1, Math.round(base * scale));
  const stride = scale >= 1 ? 1 : Math.max(1, Math.round(1 / scale));
  const sections = [];
  const timings = {};
  const run = (name, body) => {
    const started = process.hrtime.bigint();
    const tally = new AddressTally(name);
    body((text) => tally.compare(reference, ask, text));
    sections.push(tally);
    timings[name] = Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(1));
  };

  run("IPv4: every address of every /24 at an end of a table line, plain and mapped", (compare) => ipv4EdgePrefixes(compare));
  run(`IPv4: every prefix of three octets at three fourth octets${stride > 1 ? ` (every ${stride}th prefix only)` : ""}`, (compare) => ipv4EveryPrefix(compare, stride));
  run("IPv4: every spelling inet_aton accepts, leading zeros, octets past their range", (compare) => ipv4OddSpellings(compare));
  run("IPv4: brackets, dots and one further character", (compare) => ipv4Decorated(compare));
  run("IPv4 carried in IPv6: mapped, compatible, translated, NAT64, 6to4, Teredo", (compare) => ipv4Carried(compare));
  run("IPv6: both ends of every line of the rule, every spelling and decoration", (compare) => ipv6EdgeSpellings(compare, edges));
  run("IPv6: walks over whole words", (compare) => ipv6WordWalks(compare, generator(ADDRESS_FUZZ_SEED)));
  run("IPv6: a dotted quad before a closing ::, and the forms beside it", (compare) => dottedBeforeCompression(compare));
  run("every code point beside an address", (compare) => everyCodePoint(compare));
  run("fuzz: valid addresses in generated spellings", (compare) => fuzzValid(compare, generator(ADDRESS_FUZZ_SEED + 1), edges, count(2_000_000)));
  run("fuzz: broken addresses", (compare) => fuzzBroken(compare, generator(ADDRESS_FUZZ_SEED + 2), edges, count(3_000_000)));
  const outside = notUtf8(ask, generator(ADDRESS_FUZZ_SEED + 3), count(200_000));

  const summaries = sections.map((tally) => tally.summary());
  const sum = (field) => summaries.reduce((total, section) => total + section[field], 0);
  // A section that never met one of the three answers, or the whole run
  // never meeting the odd form, would mean the texts stopped reaching the
  // rule. Each generated family is made to meet all three.
  const dotted = summaries.reduce((total, section) => total + (section.dottedBeforeClosingCompression ?? 0), 0);
  if (dotted === 0) throw new Error("no text of the run was a dotted quad before a closing ::, so that form went uncompared");
  return {
    report: {
      reference: "lib/ip-safety.ts isIpAddress and isPublicIpAddress; values against this Node's URL parser and net.isIPv4",
      fuzzSeed: ADDRESS_FUZZ_SEED,
      brokenKernelsCaught,
      sections: summaries,
      notUtf8: outside,
      totals: {
        cases: sum("cases"),
        answers: Object.fromEntries(ANSWERS.map((answer) => [answer, summaries.reduce((total, section) => total + section.answers[answer], 0)])),
        valuesCompared: sum("valuesCompared"),
        dottedBeforeClosingCompression: dotted,
        differences: sum("differences") + outside.calledAnAddress
      },
      timings
    },
    differences: sections.flatMap((tally) => tally.differences)
  };
}

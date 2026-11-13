import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import * as productionModule from "./ip-safety";
import { PublicScanError } from "./public-errors";
import * as productionUrlModule from "./url-safety";

/**
 * IP4, a finite check of the address classifier in lib/ip-safety.ts over IPv4: which
 * addresses the scanner may connect to.
 *
 * The specification is the table below, NON_PUBLIC_BLOCKS with REACHABLE_EXCEPTIONS, written
 * by hand from the IANA IPv4 Special-Purpose Address Registry, the IANA IPv4 Address Space
 * Registry and the RFC each line names. It is not derived from the classifier's branches.
 * An address is public by the table exactly when it lies in no block, or lies in an
 * exception. Nothing here holds the table to the registries: a block the table lacks, or
 * states wrongly, is not seen.
 *
 * What is walked, each through the real exported isPublicIpAddress:
 *
 * - Every prefix of three octets, 2 ** 24 of them, at the fourth octets 0 and 255 and at one
 *   more that moves with the prefix through 1 to 254. This is not all of IPv4: of each
 *   prefix's 256 addresses it reads 3.
 * - Every address, over every fourth octet, of each prefix that holds the first or the last
 *   address of a table line, or the address just outside either end.
 * - That the emitted classifier names its octets once, to take the first three, and its
 *   argument once, to split it. This is a check of the emitted text, and it is why the
 *   first walk reads only 3 fourth octets: a classifier that read the fourth octet by a
 *   spelling this text check does not look for, away from the edges, would pass.
 *
 * The textual entry points, over the suite's sample of addresses (each line's first and last
 * address, the address outside each end, and the public addresses written out below):
 *
 * - Direct: each spelling inet_aton accepts (1 to 4 parts, each decimal, octal or
 *   hexadecimal), with and without a trailing dot. Only four decimal octets with no leading
 *   zero are an address here; every other spelling is no address and never public.
 * - Wrapped and decorated: the dotted quad inside brackets, and with one further character
 *   before or after it, read as normalizeHostname documents. This part restates that
 *   function, so it catches drift from it and not a wrong rule.
 * - Through a URL: the same spellings as the host of an http and an https URL, which
 *   Node's parser rewrites to a dotted quad, held to assertPublicHttpUrlShape in
 *   lib/url-safety.ts. That Node reads each spelling as its address is checked here, on the
 *   Node that runs the suite.
 * - IPv4-mapped IPv6: the two compressed spellings, `::ffff:` before a dotted quad and
 *   before two hexadecimal words, read as the address they carry. Every other embedding
 *   written out below reads public for no address the table calls non-public.
 *
 * Not claimed: the IPv6 space. lib/ip-safety.test.ts and lib/serious-use-audit-fixes.test.ts
 * hold IPv6 by written-out cases only. Not claimed either: what a resolver answers, or that
 * a caller asks this classifier at all.
 *
 * One difference between the table and the classifier is pinned open below and left as it
 * is: the registry marks 192.0.0.9 and 192.0.0.10 globally reachable, and the classifier,
 * which cannot tell addresses inside 192.0.0.0/24 apart, reads both as not public. Those two
 * addresses are outside every claim here.
 */

type IpModule = typeof productionModule;
type UrlModule = typeof productionUrlModule;
type Line = Readonly<{ cidr: string; name: string; source: string }>;
type Range = Line & Readonly<{ low: number; high: number }>;

/** Not public: no scan may connect to an address in one of these. */
const NON_PUBLIC_BLOCKS: readonly Line[] = [
  { cidr: "0.0.0.0/8", name: "this network", source: "RFC 791, section 3.2; special-purpose registry" },
  { cidr: "10.0.0.0/8", name: "private use", source: "RFC 1918; special-purpose registry" },
  { cidr: "100.64.0.0/10", name: "shared address space", source: "RFC 6598; special-purpose registry" },
  { cidr: "127.0.0.0/8", name: "loopback", source: "RFC 1122, section 3.2.1.3; special-purpose registry" },
  { cidr: "169.254.0.0/16", name: "link local", source: "RFC 3927; special-purpose registry" },
  { cidr: "172.16.0.0/12", name: "private use", source: "RFC 1918; special-purpose registry" },
  // The registry lists narrower lines inside this block. Those it marks not reachable fall
  // under the block; the two it marks reachable are REACHABLE_EXCEPTIONS.
  { cidr: "192.0.0.0/24", name: "IETF protocol assignments", source: "RFC 6890, section 2.1; special-purpose registry" },
  { cidr: "192.0.2.0/24", name: "documentation, TEST-NET-1", source: "RFC 5737; special-purpose registry" },
  // Deprecated, and to stay unassigned: the registry gives it no reachability.
  { cidr: "192.88.99.0/24", name: "deprecated 6to4 relay anycast", source: "RFC 7526; special-purpose registry" },
  { cidr: "192.168.0.0/16", name: "private use", source: "RFC 1918; special-purpose registry" },
  { cidr: "198.18.0.0/15", name: "benchmarking", source: "RFC 2544; special-purpose registry" },
  { cidr: "198.51.100.0/24", name: "documentation, TEST-NET-2", source: "RFC 5737; special-purpose registry" },
  { cidr: "203.0.113.0/24", name: "documentation, TEST-NET-3", source: "RFC 5737; special-purpose registry" },
  // Not in the special-purpose registry: a multicast group is no host to connect to.
  { cidr: "224.0.0.0/4", name: "multicast", source: "RFC 5771; IPv4 address space registry" },
  { cidr: "240.0.0.0/4", name: "reserved", source: "RFC 1112, section 4; special-purpose registry" },
  { cidr: "255.255.255.255/32", name: "limited broadcast", source: "RFC 8190 and RFC 919, section 7; special-purpose registry" }
];

/** Inside a block, and marked Globally Reachable in the special-purpose registry. */
const REACHABLE_EXCEPTIONS: readonly Line[] = [
  { cidr: "192.0.0.9/32", name: "Port Control Protocol anycast", source: "RFC 7723; special-purpose registry" },
  { cidr: "192.0.0.10/32", name: "Traversal Using Relays around NAT anycast", source: "RFC 8155; special-purpose registry" }
];

/** Special-purpose lines the registry marks Globally Reachable, in no block: public, and walked at their edges. */
const REACHABLE_BLOCKS: readonly Line[] = [
  { cidr: "192.31.196.0/24", name: "AS112-v4", source: "RFC 7535; special-purpose registry" },
  { cidr: "192.52.193.0/24", name: "Automatic Multicast Tunneling", source: "RFC 7450; special-purpose registry" },
  { cidr: "192.175.48.0/24", name: "direct delegation AS112 service", source: "RFC 7534; special-purpose registry" }
];

/** Ordinary public addresses for the textual checks. The last ends in 25, so one more digit steps past an octet's range. */
const PUBLIC_SAMPLES = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "172.32.0.1", "223.255.255.254", "8.8.8.25"] as const;

const ADDRESSES = 2 ** 32;
const PREFIXES = 2 ** 24;
const OCTET = Array.from({ length: 256 }, (_, value) => String(value));

const P = {
  table: "an-address-reads-as-the-table-says",
  literal: "four-decimal-octets-are-an-address",
  fourth: "the-classifier-reads-no-fourth-octet",
  odd: "an-odd-spelling-is-no-address",
  wrapped: "a-wrapped-or-decorated-spelling-reads-as-its-address-or-as-none",
  node: "node-reads-a-url-spelling-as-its-address",
  url: "a-url-literal-is-refused-exactly-when-the-table-says",
  mapped: "a-mapped-spelling-reads-as-the-address-it-carries",
  embedded: "no-embedding-of-a-non-public-address-reads-public"
} as const;

// ---------------------------------------------------------------------------------------
// The table, read on its own.
// ---------------------------------------------------------------------------------------

function rangeOf(line: Line): Range {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(line.cidr);
  assert.ok(match, `${line.cidr} is no CIDR block`);
  const [a, b, c, d, length] = match.slice(1).map(Number);
  assert.ok([a, b, c, d].every((octet) => octet <= 255) && length >= 1 && length <= 32, line.cidr);
  const low = ((a * 256 + b) * 256 + c) * 256 + d;
  const size = 2 ** (32 - length);
  assert.equal(low % size, 0, `${line.cidr} does not start on its own block's first address`);
  return { ...line, low, high: low + size - 1 };
}

const BLOCKS = NON_PUBLIC_BLOCKS.map(rangeOf);
const EXCEPTIONS = REACHABLE_EXCEPTIONS.map(rangeOf);
const REACHABLE = REACHABLE_BLOCKS.map(rangeOf);

const within = (ranges: readonly Range[], address: number) => ranges.some(({ low, high }) => address >= low && address <= high);
/** The specification: public exactly when in no block, or in an exception. */
const publicByTable = (address: number) => within(EXCEPTIONS, address) || !within(BLOCKS, address);
/** The addresses the classifier and the table differ on, pinned open below and outside every claim. */
const unclaimed = (address: number) => within(EXCEPTIONS, address);

const quad = (address: number) => `${OCTET[Math.floor(address / 2 ** 24)]}.${OCTET[Math.floor(address / 2 ** 16) % 256]}.${OCTET[Math.floor(address / 256) % 256]}.${OCTET[address % 256]}`;

/** What the table says of a whole prefix of three octets: public, not public, or told apart only by the fourth octet. */
const WHOLE_NON_PUBLIC = 0;
const WHOLE_PUBLIC = 1;
const BY_ADDRESS = 2;
const TABLE_BY_PREFIX = (() => {
  const byPrefix = new Uint8Array(PREFIXES).fill(WHOLE_PUBLIC);
  for (const { low, high } of BLOCKS) {
    if (high - low + 1 >= 256) byPrefix.fill(WHOLE_NON_PUBLIC, low / 256, (high + 1) / 256);
  }
  for (const { low, high } of [...BLOCKS, ...EXCEPTIONS]) {
    if (high - low + 1 < 256) byPrefix[Math.floor(low / 256)] = BY_ADDRESS;
  }
  return byPrefix;
})();

/** Each prefix that holds a table line's first or last address, or the address just outside either end. */
const EDGE_PREFIXES = [
  ...new Set(
    [...BLOCKS, ...EXCEPTIONS, ...REACHABLE].flatMap(({ low, high }) => [low - 1, low, high, high + 1].filter((address) => address >= 0 && address < ADDRESSES).map((address) => Math.floor(address / 256)))
  )
].sort((left, right) => left - right);

/** The textual checks' addresses: each line's ends, the address outside each, and the written-out public ones. */
const SAMPLE_ADDRESSES = [
  ...new Set([
    ...[...BLOCKS, ...EXCEPTIONS, ...REACHABLE].flatMap(({ low, high }) => [low - 1, low, high, high + 1].filter((address) => address >= 0 && address < ADDRESSES)),
    ...PUBLIC_SAMPLES.map((text) => rangeOf({ cidr: `${text}/32`, name: text, source: "sample" }).low)
  ])
].sort((left, right) => left - right);

// ---------------------------------------------------------------------------------------
// The walks over addresses.
// ---------------------------------------------------------------------------------------

type Walked = { checked: number; unclaimed: number };

/** Every address of every edge prefix, over every fourth octet. */
function checkEdges(module: IpModule): Walked {
  const walked = { checked: 0, unclaimed: 0 };
  for (const prefix of EDGE_PREFIXES) {
    for (let d = 0; d < 256; d += 1) {
      const address = prefix * 256 + d;
      const text = quad(address);
      holds(P.literal, module.isIpAddress(text), () => ({ address: text }));
      if (unclaimed(address)) {
        walked.unclaimed += 1;
        continue;
      }
      const expected = publicByTable(address);
      holds(P.table, module.isPublicIpAddress(text) === expected, () => ({ address: text, table: expected ? "public" : "not public" }));
      walked.checked += 1;
    }
  }
  return walked;
}

/** The fourth octet that moves with the prefix, through 1 to 254. */
const movingOctet = (prefix: number) => 1 + (prefix % 254);

/** Every prefix of three octets, at the fourth octets 0 and 255 and at the one that moves. */
function checkPrefixes(module: IpModule): Walked {
  const walked = { checked: 0, unclaimed: 0 };
  const isPublic = module.isPublicIpAddress;
  for (let a = 0; a < 256; a += 1) {
    for (let b = 0; b < 256; b += 1) {
      const ab = `${OCTET[a]}.${OCTET[b]}.`;
      for (let c = 0; c < 256; c += 1) {
        const prefix = (a * 256 + b) * 256 + c;
        const abc = `${ab}${OCTET[c]}.`;
        const kind = TABLE_BY_PREFIX[prefix];
        for (let pass = 0; pass < 3; pass += 1) {
          const d = pass === 0 ? 0 : pass === 1 ? 255 : movingOctet(prefix);
          const address = prefix * 256 + d;
          if (kind === BY_ADDRESS && unclaimed(address)) {
            walked.unclaimed += 1;
            continue;
          }
          const expected = kind === BY_ADDRESS ? publicByTable(address) : kind === WHOLE_PUBLIC;
          if (isPublic(abc + OCTET[d]) !== expected) holds(P.table, false, () => ({ address: abc + OCTET[d], table: expected ? "public" : "not public" }));
          walked.checked += 1;
        }
      }
    }
  }
  return walked;
}

// ---------------------------------------------------------------------------------------
// The emitted classifier's text.
// ---------------------------------------------------------------------------------------

const ipModulePath = require.resolve("./ip-safety");
const urlModulePath = require.resolve("./url-safety");
const CLASSIFIER_START = "function isPublicIpv4(address) {";
const CLASSIFIER_END = "\nfunction isIpv6Address(";
const TAKES_THREE = "const [a, b, c] = octets;";
const SPLITS_ONCE = 'const octets = address.split(".").map((part) => Number(part));';

function editedSource(edits: readonly SourceEdit[]): string {
  let source = readFileSync(ipModulePath, "utf8");
  for (const { find, replace } of edits) {
    assert.equal(source.split(find).length - 1, 1, `an edit must land exactly once: ${find}`);
    source = source.replace(find, () => replace);
  }
  return source;
}

/**
 * The classifier's emitted body names `octets` twice, where it is made and where the first
 * three are taken, and `address` once, where it is split. A text check: it looks for those
 * two names and nothing else, so it is a change detector for this shape and no more.
 */
function checkFourthOctetUnread(source: string): void {
  const start = source.indexOf(CLASSIFIER_START);
  const end = source.indexOf(CLASSIFIER_END, start);
  assert.ok(start >= 0 && end > start, "the emitted classifier was not found, so this check saw nothing");
  const body = source.slice(start + CLASSIFIER_START.length, end);
  const uses = (name: string) => body.split(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`)).length - 1;
  holds(P.fourth, body.includes(SPLITS_ONCE) && body.includes(TAKES_THREE), () => ({ missing: [SPLITS_ONCE, TAKES_THREE].filter((line) => !body.includes(line)) }));
  holds(P.fourth, uses("octets") === 2 && uses("address") === 1 && uses("arguments") === 0, () => ({ octets: uses("octets"), address: uses("address"), arguments: uses("arguments") }));
}

// ---------------------------------------------------------------------------------------
// The textual entry points.
// ---------------------------------------------------------------------------------------

type Spelling = Readonly<{ text: string; plain: boolean }>;

const RADIXES: readonly ((value: number) => string)[] = [
  (value) => String(value),
  (value) => `0${value.toString(8)}`,
  (value) => `0x${value.toString(16)}`,
  (value) => `0X${value.toString(16).toUpperCase()}`
];

/** Every spelling of an address inet_aton accepts within these radixes: 4, 3, 2 parts and 1, the last part filling what is left. */
function spellingsOf(address: number): Spelling[] {
  const a = Math.floor(address / 2 ** 24);
  const b = Math.floor(address / 2 ** 16) % 256;
  const c = Math.floor(address / 256) % 256;
  const d = address % 256;
  const shapes = [[a, b, c, d], [a, b, c * 256 + d], [a, (b * 256 + c) * 256 + d], [address]];
  const out: Spelling[] = [];
  for (const parts of shapes) {
    const choose = (index: number, texts: string[], plain: boolean): void => {
      if (index === parts.length) {
        out.push({ text: texts.join("."), plain: plain && parts.length === 4 });
        return;
      }
      RADIXES.forEach((radix, which) => choose(index + 1, [...texts, radix(parts[index])], plain && which === 0));
    };
    choose(0, [], true);
  }
  return out;
}

/** Each octet position stepped just past its range, and well past it: no address by any reading. */
const PAST_RANGE = ["256.8.8.8", "8.256.8.8", "8.8.256.8", "8.8.8.256", "999.8.8.8", "8.8.8.1000", "8.8.8.4294967296"] as const;

/** Direct: only four decimal octets with no leading zero are an address, with or without a trailing dot. */
function checkSpellings(module: IpModule): number {
  let cases = 0;
  for (const address of SAMPLE_ADDRESSES) {
    for (const { text, plain } of spellingsOf(address)) {
      for (const spelled of [text, `${text}.`]) {
        cases += 1;
        if (!plain) {
          holds(P.odd, !module.isIpAddress(spelled) && !module.isPublicIpAddress(spelled), () => ({ spelled, address: quad(address) }));
          continue;
        }
        holds(P.literal, module.isIpAddress(spelled), () => ({ spelled }));
        if (unclaimed(address)) continue;
        holds(P.table, module.isPublicIpAddress(spelled) === publicByTable(address), () => ({ spelled, table: publicByTable(address) ? "public" : "not public" }));
      }
    }
  }
  for (const spelled of PAST_RANGE) {
    cases += 1;
    holds(P.odd, !module.isIpAddress(spelled) && !module.isPublicIpAddress(spelled), () => ({ spelled }));
  }
  return cases;
}

/** One further character: every ASCII code, and digits and spaces from outside ASCII. */
const DECORATIONS = [...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)), "\u00a0", "\u0660", "\u06f1", "\uff11", "\u2028", "\ufeff"];

/**
 * The address a string names as normalizeHostname documents it and as the classifier's own
 * comment states the dotted quad: lower case, one trailing dot gone, a leading `[` and a
 * trailing `]` gone, then four decimal octets, none with a leading zero. A restatement.
 */
function addressNamedBy(text: string): number | null {
  const bare = text.toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");
  const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(bare);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3] : null;
}

/** Wrapped and decorated: the dotted quad in brackets and with a trailing dot, and with one further character before or after it. */
function checkWrappers(module: IpModule): number {
  let cases = 0;
  for (const address of SAMPLE_ADDRESSES) {
    const plain = quad(address);
    const wrapped = [`[${plain}]`, `[${plain}`, `${plain}]`, `[${plain}].`, `${plain}.]`, `${plain}..`, `[[${plain}]]`];
    for (const spelled of [...wrapped, ...DECORATIONS.flatMap((mark) => [`${mark}${plain}`, `${plain}${mark}`])]) {
      cases += 1;
      const named = addressNamedBy(spelled);
      const input = () => ({ spelled: JSON.stringify(spelled), names: named === null ? null : quad(named) });
      holds(P.wrapped, module.isIpAddress(spelled) === (named !== null), input);
      if (named !== null && unclaimed(named)) continue;
      holds(P.wrapped, module.isPublicIpAddress(spelled) === (named !== null && publicByTable(named)), input);
    }
  }
  return cases;
}

const words = (address: number) => `${Math.floor(address / 2 ** 16).toString(16)}:${(address % 2 ** 16).toString(16)}`;
const paddedWords = (address: number) =>
  `${Math.floor(address / 2 ** 16).toString(16).padStart(4, "0")}:${(address % 2 ** 16).toString(16).padStart(4, "0")}`;

/** The compressed IPv4-mapped spellings, which read as the address they carry. */
const mappedSpellings = (address: number) => [
  `::ffff:${quad(address)}`,
  `::FFFF:${quad(address)}`,
  `[::ffff:${quad(address)}]`,
  `::ffff:${words(address)}`,
  `::ffff:${paddedWords(address)}`,
  `::FFFF:${words(address).toUpperCase()}`,
  `[::ffff:${words(address)}]`
];

/** Other ways an IPv6 literal can carry an IPv4 address: compatible, mapped written out, translated, NAT64, 6to4 and Teredo. */
const embeddedSpellings = (address: number) => [
  `::${quad(address)}`,
  `::${words(address)}`,
  `0:0:0:0:0:ffff:${words(address)}`,
  `0:0:0:0:0:ffff:${quad(address)}`,
  `::ffff:0:${words(address)}`,
  `::ffff:0:${quad(address)}`,
  `64:ff9b::${quad(address)}`,
  `64:ff9b::${words(address)}`,
  `64:ff9b:1::${words(address)}`,
  `2002:${words(address)}::1`,
  `2001:0:${words(address)}::1`
];

/**
 * IPv4-mapped: every address of every edge prefix, the corners of every prefix of two
 * octets, and the sample, in each mapped spelling; and the sample in each other embedding.
 */
function checkMapped(module: IpModule): number {
  let cases = 0;
  const mapped = (address: number, spellings: readonly string[]) => {
    if (unclaimed(address)) return;
    const expected = publicByTable(address);
    for (const spelled of spellings) {
      cases += 1;
      holds(P.mapped, module.isPublicIpAddress(spelled) === expected, () => ({ spelled, carries: quad(address), table: expected ? "public" : "not public" }));
    }
  };
  for (const prefix of EDGE_PREFIXES) {
    for (let d = 0; d < 256; d += 1) mapped(prefix * 256 + d, [`::ffff:${quad(prefix * 256 + d)}`, `::ffff:${words(prefix * 256 + d)}`]);
  }
  for (let high = 0; high < 2 ** 16; high += 1) {
    for (const low of [0, 255, 255 * 256, 2 ** 16 - 1]) mapped(high * 2 ** 16 + low, [`::ffff:${quad(high * 2 ** 16 + low)}`, `::ffff:${words(high * 2 ** 16 + low)}`]);
  }
  for (const address of SAMPLE_ADDRESSES) {
    mapped(address, mappedSpellings(address));
    if (publicByTable(address)) continue;
    for (const spelled of embeddedSpellings(address)) {
      cases += 1;
      holds(P.embedded, !module.isPublicIpAddress(spelled), () => ({ spelled, carries: quad(address) }));
    }
  }
  return cases;
}

/** Whether the shape check refuses this URL as a private target. Any other refusal breaks the check. */
function refusedAsPrivate(module: UrlModule, url: URL): boolean {
  try {
    module.assertPublicHttpUrlShape(url);
    return false;
  } catch (error) {
    // The variant's own module raises the same class, loaded from the real lib/public-errors.
    if (error instanceof PublicScanError && error.failureCause === "private-target") return true;
    throw error;
  }
}

/** Through a URL: each spelling, with and without a trailing dot, and each mapped spelling, as the host of an http and an https URL. */
function checkUrlEntry(module: UrlModule): number {
  let cases = 0;
  for (const address of SAMPLE_ADDRESSES) {
    if (unclaimed(address)) continue;
    const expected = !publicByTable(address);
    for (const scheme of ["http", "https"]) {
      for (const { text } of spellingsOf(address)) {
        for (const spelled of [text, `${text}.`]) {
          cases += 1;
          const url = new URL(`${scheme}://${spelled}/`);
          holds(P.node, url.hostname.replace(/\.$/, "") === quad(address), () => ({ spelled, hostname: url.hostname, address: quad(address) }));
          holds(P.url, refusedAsPrivate(module, url) === expected, () => ({ spelled, hostname: url.hostname, table: expected ? "not public" : "public" }));
        }
      }
      for (const spelled of [`[::ffff:${quad(address)}]`, `[::ffff:${words(address)}]`, `[::FFFF:${paddedWords(address)}]`]) {
        cases += 1;
        const url = new URL(`${scheme}://${spelled}/`);
        holds(P.node, url.hostname === `[::ffff:${words(address)}]`, () => ({ spelled, hostname: url.hostname }));
        holds(P.url, refusedAsPrivate(module, url) === expected, () => ({ spelled, hostname: url.hostname, table: expected ? "not public" : "public" }));
      }
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------------------
// The checks on production.
// ---------------------------------------------------------------------------------------

test("the table is well formed: each line starts its own block, one block lies inside another, each exception lies inside a block, and no reachable line touches a block", () => {
  assert.equal(BLOCKS.length, 16);
  assert.equal(EXCEPTIONS.length, 2);
  assert.equal(REACHABLE.length, 3);
  const overlaps = BLOCKS.flatMap((left, index) => BLOCKS.slice(index + 1).filter((right) => left.low <= right.high && right.low <= left.high).map((right) => `${right.cidr} in ${left.cidr}`));
  // Limited broadcast is the reserved block's last address, and the registry lists both.
  assert.deepEqual(overlaps, ["255.255.255.255/32 in 240.0.0.0/4"]);
  for (const exception of EXCEPTIONS) assert.equal(BLOCKS.filter((block) => exception.low >= block.low && exception.high <= block.high).length, 1, exception.cidr);
  for (const reachable of REACHABLE) assert.ok(!within(BLOCKS, reachable.low) && !within(BLOCKS, reachable.high), reachable.cidr);
  for (const text of PUBLIC_SAMPLES) assert.ok(publicByTable(rangeOf({ cidr: `${text}/32`, name: text, source: "sample" }).low), text);
  // The table by prefix agrees with the table by address, on every address of every prefix the fourth octet tells apart and at both ends of every other.
  let byAddress = 0;
  for (let prefix = 0; prefix < PREFIXES; prefix += 1) {
    const kind = TABLE_BY_PREFIX[prefix];
    if (kind === BY_ADDRESS) byAddress += 1;
    else for (const d of [0, 255]) assert.equal(publicByTable(prefix * 256 + d), kind === WHOLE_PUBLIC, quad(prefix * 256 + d));
  }
  assert.equal(byAddress, 2);
  assert.equal(EDGE_PREFIXES.length, 59);
  assert.equal(SAMPLE_ADDRESSES.length, 79);
});

test("IP4: every address of every prefix at an edge of a table line reads as the table says, over every fourth octet", () => {
  const walked = checkEdges(productionModule);
  assert.deepEqual(walked, { checked: EDGE_PREFIXES.length * 256 - 2, unclaimed: 2 });
});

test("IP4: every prefix of three octets reads as the table says at the lowest fourth octet, the highest and one that moves with the prefix", () => {
  // The moving octet takes every value from 1 to 254, and never one of the two ends.
  assert.deepEqual([...new Set(Array.from({ length: 254 }, (_, prefix) => movingOctet(prefix)))].sort((left, right) => left - right), Array.from({ length: 254 }, (_, index) => index + 1));
  const walked = checkPrefixes(productionModule);
  assert.deepEqual(walked, { checked: 3 * PREFIXES, unclaimed: 0 });
});

test("IP4: the emitted classifier names its octets once to take the first three, and its argument once to split it", () => {
  checkFourthOctetUnread(readFileSync(ipModulePath, "utf8"));
});

test("IP4: only four decimal octets with no leading zero are an address, and every other spelling of the sample is none and never public", () => {
  // Per address: 4 radixes to the power of the parts, over 4, 3, 2 parts and 1, each with and without a trailing dot.
  assert.equal(checkSpellings(productionModule), SAMPLE_ADDRESSES.length * (4 ** 4 + 4 ** 3 + 4 ** 2 + 4) * 2 + PAST_RANGE.length);
});

test("IP4: a dotted quad in brackets, with a trailing dot or with one further character reads as the address it then names, or as none", () => {
  assert.equal(checkWrappers(productionModule), SAMPLE_ADDRESSES.length * (7 + DECORATIONS.length * 2));
});

test("IP4: through a URL, every spelling of the sample is refused exactly when the table says its address is not public", () => {
  const claimed = SAMPLE_ADDRESSES.filter((address) => !unclaimed(address)).length;
  assert.equal(checkUrlEntry(productionUrlModule), claimed * 2 * ((4 ** 4 + 4 ** 3 + 4 ** 2 + 4) * 2 + 3));
});

test("IP4: an IPv4-mapped spelling reads as the address it carries, and no other embedding of a non-public address reads public", () => {
  assert.ok(checkMapped(productionModule) > 2 ** 16 * 4 * 2);
});

test("open (IP4): the two anycast addresses the registry marks globally reachable read as not public", () => {
  // The classifier takes three octets, so it cannot tell these from their neighbours in
  // 192.0.0.0/24. Its IPv6 side admits the same two services at 2001:1::1 and 2001:1::2.
  for (const { low } of EXCEPTIONS) {
    assert.equal(publicByTable(low), true, quad(low));
    assert.equal(productionModule.isIpAddress(quad(low)), true, quad(low));
    assert.equal(productionModule.isPublicIpAddress(quad(low)), false, quad(low));
    assert.equal(productionModule.isPublicIpAddress(`::ffff:${quad(low)}`), false, quad(low));
  }
  assert.deepEqual(EXCEPTIONS.map(({ low }) => quad(low)), ["192.0.0.9", "192.0.0.10"]);
  assert.equal(productionModule.isPublicIpAddress("2001:1::1"), true);
  assert.equal(productionModule.isPublicIpAddress("2001:1::2"), true);
});

// ---------------------------------------------------------------------------------------
// Seeded faults.
// ---------------------------------------------------------------------------------------

const ipVariant = (...edits: SourceEdit[]) => loadVariant<IpModule>(ipModulePath, edits);
const urlVariant = (...edits: SourceEdit[]) => loadVariant<UrlModule>(urlModulePath, edits);
const branch = (condition: string) => `    if (${condition})\n        return false;\n`;

/** Each block's own branch taken out of the classifier, by the block it leaves public. */
const REMOVED: readonly (readonly [cidr: string, find: string, replace: string])[] = [
  ["0.0.0.0/8", "a === 0 || ", ""],
  ["10.0.0.0/8", "a === 10 || ", ""],
  ["100.64.0.0/10", branch("a === 100 && b >= 64 && b <= 127"), ""],
  ["127.0.0.0/8", "a === 127 || ", ""],
  ["169.254.0.0/16", branch("a === 169 && b === 254"), ""],
  ["172.16.0.0/12", branch("a === 172 && b >= 16 && b <= 31"), ""],
  ["192.0.0.0/24", branch("a === 192 && b === 0 && c === 0"), ""],
  ["192.0.2.0/24", branch("a === 192 && b === 0 && c === 2"), ""],
  ["192.88.99.0/24", branch("a === 192 && b === 88 && c === 99"), ""],
  ["192.168.0.0/16", branch("a === 192 && b === 168"), ""],
  ["198.18.0.0/15", branch("a === 198 && (b === 18 || b === 19)"), ""],
  ["198.51.100.0/24", branch("a === 198 && b === 51 && c === 100"), ""],
  ["203.0.113.0/24", branch("a === 203 && b === 0 && c === 113"), ""],
  ["224.0.0.0/4", "a >= 224", "a >= 240"],
  ["240.0.0.0/4", "a >= 224", "(a >= 224 && a < 240)"],
  ["255.255.255.255/32", "a >= 224", "(a >= 224 && !(a === 255 && b === 255 && c === 255 && octets[3] === 255))"]
];

test("every block of the table has a variant that removes it", () => {
  assert.deepEqual(REMOVED.map(([cidr]) => cidr), NON_PUBLIC_BLOCKS.map(({ cidr }) => cidr));
});

for (const [cidr, find, replace] of REMOVED) {
  test(`IP4 catches a variant: the block ${cidr} is removed`, async () => {
    const caught = await assertCaughtBy(`the block ${cidr} is removed`, P.table, () => checkEdges(ipVariant({ find, replace })));
    // The first address it reads wrongly is one of that block's own.
    const address = rangeOf({ cidr: `${(caught.input as { address: string }).address}/32`, name: cidr, source: "variant" }).low;
    assert.ok(within([rangeOf({ cidr, name: cidr, source: "variant" })], address), `${cidr} was caught at ${quad(address)}`);
  });
}

/** One address read the other way, which moves an end of a block by one address. */
const flipped = (address: number, to: boolean): SourceEdit => ({
  find: TAKES_THREE,
  replace: `${TAKES_THREE}\n    if (((a * 256 + b) * 256 + c) * 256 + octets[3] === ${address})\n        return ${to};`
});

/**
 * For each block, each end moved by one address, in and out. An end that does not part
 * public from non-public has no such variant: moving it changes no verdict the table states.
 */
const MOVED: readonly (readonly [name: string, edit: SourceEdit])[] = BLOCKS.flatMap((block) => {
  const moves: [string, SourceEdit][] = [];
  if (block.low === block.high) moves.push([`${block.cidr} loses its one address`, flipped(block.low, true)]);
  else {
    moves.push([`${block.cidr} starts one address late`, flipped(block.low, true)]);
    moves.push([`${block.cidr} ends one address early`, flipped(block.high, true)]);
  }
  if (block.low > 0 && publicByTable(block.low - 1)) moves.push([`${block.cidr} starts one address early`, flipped(block.low - 1, false)]);
  if (block.high < ADDRESSES - 1 && publicByTable(block.high + 1)) moves.push([`${block.cidr} ends one address late`, flipped(block.high + 1, false)]);
  return moves;
});

test("every block of the table has a variant that moves each end that parts public from non-public", () => {
  for (const block of BLOCKS) assert.ok(MOVED.some(([name]) => name.startsWith(`${block.cidr} `)), block.cidr);
  // 0.0.0.0/8 has nothing below it; 224.0.0.0/4, 240.0.0.0/4 and the broadcast address meet each other.
  assert.equal(MOVED.length, 16 * 2 - 1 + 13 + 13);
});

for (const [name, edit] of MOVED) {
  test(`IP4 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, P.table, () => checkEdges(ipVariant(edit)));
  });
}

/** The classifier's own comparisons moved by one, where it states a range. */
for (const [name, find, replace] of [
  ["the shared address space starts one second octet late", "b >= 64", "b >= 65"],
  ["the shared address space starts one second octet early", "b >= 64", "b >= 63"],
  ["the shared address space ends one second octet early", "b <= 127", "b <= 126"],
  ["the shared address space ends one second octet late", "b <= 127", "b <= 128"],
  ["172.16.0.0/12 starts one second octet late", "b >= 16", "b >= 17"],
  ["172.16.0.0/12 starts one second octet early", "b >= 16", "b >= 15"],
  ["172.16.0.0/12 ends one second octet early", "b <= 31", "b <= 30"],
  ["172.16.0.0/12 ends one second octet late", "b <= 31", "b <= 32"],
  ["the benchmarking block loses its first half", "(b === 18 || b === 19)", "b === 19"],
  ["the benchmarking block loses its second half", "(b === 18 || b === 19)", "b === 18"],
  ["the benchmarking block starts one second octet early", "(b === 18 || b === 19)", "(b === 17 || b === 18 || b === 19)"],
  ["the benchmarking block ends one second octet late", "(b === 18 || b === 19)", "(b === 18 || b === 19 || b === 20)"],
  ["multicast starts one first octet late", "a >= 224", "a >= 225"],
  ["multicast starts one first octet early", "a >= 224", "a >= 223"],
  ["the classifier judges the second octet where it should judge the first", "a === 127 || ", "b === 127 || "]
] as const) {
  test(`IP4 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, P.table, () => checkEdges(ipVariant({ find, replace })));
  });
}

/** Faults in a prefix that is no edge prefix, which only the walk over every prefix reaches. */
for (const [name, find, replace] of [
  ["a prefix inside 10.0.0.0/8 reads public", "a === 10 || ", "(a === 10 && !(b === 77 && c === 77)) || "],
  ["a prefix inside public space reads not public", TAKES_THREE, `${TAKES_THREE}\n    if (a === 8 && b === 8 && c === 8)\n        return false;`]
] as const) {
  test(`IP4 catches a variant no edge prefix holds: ${name}`, async () => {
    const edit = { find, replace };
    // The edge walk passes it, which is why the walk over every prefix is there.
    checkEdges(ipVariant(edit));
    await assertCaughtBy(name, P.table, () => checkPrefixes(ipVariant(edit)));
  });
}

for (const [name, edits] of [
  ["the classifier takes a fourth octet", [{ find: TAKES_THREE, replace: "const [a, b, c, d] = octets;" }]],
  ["the classifier reads the fourth octet by its index", [{ find: branch("a === 169 && b === 254"), replace: branch("a === 169 && b === 254 && octets[3] !== 77") }]],
  ["the classifier reads its argument's last character", [{ find: branch("a === 169 && b === 254"), replace: branch('a === 169 && b === 254 && !address.endsWith("7")') }]],
  ["the classifier splits its argument another way", [{ find: SPLITS_ONCE, replace: 'const octets = address.split(".").reverse().map((part) => Number(part));' }]]
] as const) {
  test(`IP4 catches a variant of the emitted text: ${name}`, async () => {
    await assertCaughtBy(name, P.fourth, () => checkFourthOctetUnread(editedSource(edits)));
  });
}

test("the text check passes a fault it does not look for, which is what it leaves out", () => {
  // One address away from every edge, at a fourth octet the prefix walk does not take, read through a helper.
  const hidden = { find: TAKES_THREE, replace: `${TAKES_THREE}\n    if (a === 8 && b === 8 && c === 8 && lastOf(address) === 8)\n        return false;` };
  const helper = { find: "function isPublicIpv4(address) {", replace: 'const lastOf = (text) => Number(text.slice(text.lastIndexOf(".") + 1));\nfunction isPublicIpv4(address) {' };
  assert.equal(ipVariant(hidden, helper).isPublicIpAddress("8.8.8.8"), false);
  assert.notEqual(movingOctet((8 * 256 + 8) * 256 + 8), 8);
  // It names `address` twice, so this spelling is caught; one that hid the read in the helper's caller would not be.
  assert.throws(() => checkFourthOctetUnread(editedSource([hidden, helper])), /the-classifier-reads-no-fourth-octet/);
  const hiddenWhole = {
    find: "    if (isIpv4Address(normalized))\n        return isPublicIpv4(normalized);",
    replace: '    if (isIpv4Address(normalized))\n        return normalized !== "8.8.8.8" && isPublicIpv4(normalized);'
  };
  checkFourthOctetUnread(editedSource([hiddenWhole]));
  checkEdges(ipVariant(hiddenWhole));
  assert.equal(ipVariant(hiddenWhole).isPublicIpAddress("8.8.8.8"), false);
});

for (const [name, property, find, replace] of [
  ["a leading zero is read as decimal", P.odd, '        if (part.length > 1 && part.startsWith("0"))\n            return false;\n', ""],
  ["an octet may be 256", P.odd, "value <= 255", "value <= 256"],
  ["an octet has no upper bound", P.odd, "value >= 0 && value <= 255", "value >= 0"]
] as const) {
  test(`IP4 catches a variant of the reader: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkSpellings(ipVariant({ find, replace })));
  });
}

for (const [name, find, replace] of [
  ["brackets are not taken off", '.replace(/^\\[|\\]$/g, "")', ""],
  ["a trailing dot is not taken off", '.replace(/\\.$/, "")', ""],
  ["every trailing dot is taken off", '.replace(/\\.$/, "")', '.replace(/\\.+$/, "")'],
  ["every bracket is taken off", '.replace(/^\\[|\\]$/g, "")', '.replace(/[[\\]]/g, "")'],
  ["the quad may start after another character", "/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(address)", "/\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(address)"],
  ["the quad may end before another character", "/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(address)", "/^\\d+\\.\\d+\\.\\d+\\.\\d+/.test(address)"]
] as const) {
  test(`IP4 catches a variant of the wrapping: ${name}`, async () => {
    await assertCaughtBy(name, P.wrapped, () => checkWrappers(ipVariant({ find, replace })));
  });
}

for (const [name, property, find, replace] of [
  ["a mapped address is public whatever it carries", P.mapped, "    if (mappedIpv4)\n        return isPublicIpv4(mappedIpv4);", "    if (mappedIpv4)\n        return true;"],
  ["a mapped address is never read as the address it carries", P.mapped, "    if (mappedIpv4)\n        return isPublicIpv4(mappedIpv4);", ""],
  ["the first two octets of a mapped address trade places", P.mapped, "`${(high >> 8) & 0xff}.${high & 0xff}.", "`${high & 0xff}.${(high >> 8) & 0xff}."],
  ["the last two octets of a mapped address trade places", P.mapped, ".${(low >> 8) & 0xff}.${low & 0xff}`", ".${low & 0xff}.${(low >> 8) & 0xff}`"],
  ["the space below global unicast reads public", P.embedded, "first < 0x2000 || first > 0x3fff", "first > 0x3fff"],
  ["6to4 reads public", P.embedded, "    if (first === 0x2002)\n        return false;\n", ""],
  ["Teredo reads public", P.embedded, "first === 0x2001 && second <= 0x01ff", "first === 0x2001 && second <= 0x01ff && second !== 0"]
] as const) {
  test(`IP4 catches a variant of the IPv6 carriers: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkMapped(ipVariant({ find, replace })));
  });
}

const SHAPE_CHECK = '(0, ip_safety_1.isIpAddress)(hostname) && !(0, address_kernel_comparison_1.isPublicIpAddressCompared)(hostname, "url-address-literal")';
for (const [name, find, replace] of [
  ["the shape check asks nothing of a literal", SHAPE_CHECK, "false"],
  ["the shape check refuses every literal", SHAPE_CHECK, "(0, ip_safety_1.isIpAddress)(hostname)"],
  ["the shape check reads the host before its brackets are off", SHAPE_CHECK, `!url.hostname.startsWith("[") && ${SHAPE_CHECK}`]
] as const) {
  test(`IP4 catches a variant of the URL entry: ${name}`, async () => {
    await assertCaughtBy(name, P.url, () => checkUrlEntry(urlVariant({ find, replace })));
  });
}

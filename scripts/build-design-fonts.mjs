#!/usr/bin/env node
// Builds the self-hosted WOFF2 files under public/fonts/ from upstream TTF
// sources that the maintainer has already placed on this machine, and, from
// the same sources and the same glyph set, the static TTF instances the share
// card renders with (lib/og-fonts/). next/og reads TrueType, not WOFF2, and
// draws a variable font at its default instance only, so the card needs one
// static file per weight it sets. Those files are read at build time and in
// the container; nothing under lib/ is served.
//
//   node scripts/build-design-fonts.mjs <source-dir>
//
// <source-dir> holds stix-two/, atkinson-next/ and atkinson-mono/ exactly as
// each project's own repository publishes them. Nothing is downloaded here.
//
// Subsetting is done by HarfBuzz's `hb-subset`, which must be on PATH. The
// WOFF2 container is written here with Node's own Brotli, using the null
// transform the format allows for every table (WOFF2 section 5: glyf and loca
// carry transform version 3, all other tables version 0). The reference
// encoder's glyf transform would make each file somewhat smaller; this
// writer trades those bytes for needing no further tool.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";

// Basic Latin, Latin-1, and the punctuation and signs the report pages print:
// quotes, ellipsis, dagger, bullet, primes, arrows, minus, the comparison
// signs behind "at least" counts, and the multiplication sign of a viewport.
const UNICODES = [
  "0020-007E", "00A0-00FF", "0131", "0152-0153", "02C6", "02DA", "02DC",
  "2010-2011", "2018-201A", "201C-201E", "2020-2022", "2026", "2032-2033",
  "2039-203A", "2044", "20AC", "2122", "2190-2193", "2212", "2260", "2264-2265"
].join(",");

const FONTS = [
  { family: "stix-two-text", source: "stix-two/STIXTwoText.ttf", out: "STIXTwoText-wght.latin.woff2" },
  { family: "stix-two-text", source: "stix-two/STIXTwoText-Italic.ttf", out: "STIXTwoText-Italic-wght.latin.woff2" },
  {
    family: "atkinson-hyperlegible-next",
    source: "atkinson-next/AtkinsonHyperlegibleNext[wght].ttf",
    out: "AtkinsonHyperlegibleNext-wght.latin.woff2"
  },
  {
    family: "atkinson-hyperlegible-next",
    source: "atkinson-next/AtkinsonHyperlegibleNext-Italic[wght].ttf",
    out: "AtkinsonHyperlegibleNext-Italic-wght.latin.woff2"
  },
  {
    family: "atkinson-hyperlegible-mono",
    source: "atkinson-mono/AtkinsonHyperlegibleMono[wght].ttf",
    out: "AtkinsonHyperlegibleMono-wght.latin.woff2"
  }
];

// The share card's weights (lib/og-report-card.tsx): the wordmark at 600,
// the finding sentence and the numerals at 500 in STIX; the attribution, the
// limit, the subhead and the labels at 400 and the correction label at 600
// in Atkinson Hyperlegible Next.
const CARD_FONTS = [
  { source: "stix-two/STIXTwoText.ttf", weight: 500, out: "STIXTwoText-500.latin.ttf", license: "public/fonts/stix-two-text/OFL.txt", licenseOut: "STIXTwoText-OFL.txt" },
  { source: "stix-two/STIXTwoText.ttf", weight: 600, out: "STIXTwoText-600.latin.ttf", license: "public/fonts/stix-two-text/OFL.txt", licenseOut: "STIXTwoText-OFL.txt" },
  {
    source: "atkinson-next/AtkinsonHyperlegibleNext[wght].ttf",
    weight: 400,
    out: "AtkinsonHyperlegibleNext-400.latin.ttf",
    license: "public/fonts/atkinson-hyperlegible-next/OFL.txt",
    licenseOut: "AtkinsonHyperlegibleNext-OFL.txt"
  },
  {
    source: "atkinson-next/AtkinsonHyperlegibleNext[wght].ttf",
    weight: 600,
    out: "AtkinsonHyperlegibleNext-600.latin.ttf",
    license: "public/fonts/atkinson-hyperlegible-next/OFL.txt",
    licenseOut: "AtkinsonHyperlegibleNext-OFL.txt"
  }
];

const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep",
  "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE",
  "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt",
  "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar",
  "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"
];

function uintBase128(value) {
  const bytes = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

/** Wrap one TrueType-flavored sfnt in a WOFF2 container, every table untransformed. */
export function sfntToWoff2(sfnt) {
  const flavor = sfnt.readUInt32BE(0);
  const numTables = sfnt.readUInt16BE(4);
  const tables = [];
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const offset = sfnt.readUInt32BE(record + 8);
    const length = sfnt.readUInt32BE(record + 12);
    tables.push({ tag: sfnt.toString("latin1", record, record + 4), data: sfnt.subarray(offset, offset + length) });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  // loca directly after glyf, the order every WOFF2 reader accepts.
  const loca = tables.findIndex((table) => table.tag === "loca");
  const glyf = tables.findIndex((table) => table.tag === "glyf");
  if (loca >= 0 && glyf >= 0) tables.splice(glyf + 1, 0, ...tables.splice(loca, 1));

  const directory = [];
  let totalSfntSize = 12 + 16 * tables.length;
  for (const table of tables) {
    const known = KNOWN_TAGS.indexOf(table.tag);
    const nullTransform = table.tag === "glyf" || table.tag === "loca" ? 3 << 6 : 0;
    directory.push(Buffer.from([(known < 0 ? 63 : known) | nullTransform]));
    if (known < 0) directory.push(Buffer.from(table.tag, "latin1"));
    directory.push(uintBase128(table.data.length));
    totalSfntSize += (table.data.length + 3) & ~3;
  }
  const stream = Buffer.concat(tables.map((table) => table.data));
  const compressed = brotliCompressSync(stream, {
    params: {
      [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_FONT,
      [zlib.BROTLI_PARAM_QUALITY]: 11,
      [zlib.BROTLI_PARAM_LGWIN]: 24,
      [zlib.BROTLI_PARAM_SIZE_HINT]: stream.length
    }
  });
  const header = Buffer.alloc(48);
  const body = Buffer.concat([...directory, compressed]);
  // The length field is the size of the whole file, padding included. A
  // reader refuses a file whose length field disagrees with its size, and
  // the browser then falls back to another font without an error on the page.
  const unpadded = header.length + body.length;
  const length = (unpadded + 3) & ~3;
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(flavor, 4);
  header.writeUInt32BE(length, 8);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(totalSfntSize, 16);
  header.writeUInt32BE(compressed.length, 20);
  // Version fields, metadata and private blocks stay zero: none is carried.
  return Buffer.concat([header, body, Buffer.alloc(length - unpadded)]);
}

function main() {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    console.error("usage: node scripts/build-design-fonts.mjs <source-dir>");
    process.exit(2);
  }
  const outRoot = path.join(process.cwd(), "public", "fonts");
  const work = mkdtempSync(path.join(tmpdir(), "sbl-fonts-"));
  const files = [];
  try {
    for (const font of FONTS) {
      const source = path.join(sourceDir, font.source);
      const subset = path.join(work, `${font.out}.ttf`);
      execFileSync("hb-subset", [
        source,
        `--unicodes=${UNICODES}`,
        "--name-IDs=0,1,2,3,4,5,6,7,13,14,16,17,25",
        `--output-file=${subset}`
      ]);
      const woff2 = sfntToWoff2(readFileSync(subset));
      mkdirSync(path.join(outRoot, font.family), { recursive: true });
      writeFileSync(path.join(outRoot, font.family, font.out), woff2);
      files.push({
        path: `public/fonts/${font.family}/${font.out}`,
        bytes: woff2.length,
        sha256: createHash("sha256").update(woff2).digest("hex"),
        source: path.basename(font.source),
        sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex")
      });
    }
    // The card's static instances: the same glyph set and name records, the
    // weight axis pinned, written as TrueType.
    const cardRoot = path.join(process.cwd(), "lib", "og-fonts");
    mkdirSync(cardRoot, { recursive: true });
    for (const font of CARD_FONTS) {
      const source = path.join(sourceDir, font.source);
      const out = path.join(cardRoot, font.out);
      execFileSync("hb-subset", [
        source,
        `--unicodes=${UNICODES}`,
        "--name-IDs=0,1,2,3,4,5,6,7,13,14,16,17,25",
        `--variations=wght=${font.weight}`,
        `--output-file=${out}`
      ]);
      // Each family's license, as committed beside its WOFF2 files.
      writeFileSync(path.join(cardRoot, font.licenseOut), readFileSync(path.join(process.cwd(), font.license)));
      const ttf = readFileSync(out);
      files.push({
        path: `lib/og-fonts/${font.out}`,
        bytes: ttf.length,
        sha256: createHash("sha256").update(ttf).digest("hex"),
        source: path.basename(font.source),
        weight: font.weight,
        sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex")
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ unicodes: UNICODES, files }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

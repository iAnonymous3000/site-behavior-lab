import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The share card's fonts and its line measure.
 *
 * The card is drawn by next/og, which wraps text itself and never reports how
 * many lines a block took. The card's rules are about lines (the finding
 * sentence at most three lines before it steps down a size; the limit and the
 * subhead held to a number of lines), so this measures text with the same font
 * files the card renders with: each character's advance from the font's own
 * cmap and hmtx tables, and lines broken at spaces the way the renderer breaks
 * them. A small margin keeps a measured line from ending exactly at the edge.
 *
 * The fonts are static TrueType instances made from the committed sources by
 * scripts/build-design-fonts.mjs, in lib/og-fonts/, which nothing serves.
 */

export const CARD_FONT_FILES = Object.freeze({
  serif500: "STIXTwoText-500.latin.ttf",
  serif600: "STIXTwoText-600.latin.ttf",
  sans400: "AtkinsonHyperlegibleNext-400.latin.ttf",
  sans600: "AtkinsonHyperlegibleNext-600.latin.ttf"
});

type FontKey = keyof typeof CARD_FONT_FILES;

const fontCache = new Map<FontKey, Buffer>();

/** The bytes of one card font, read once from lib/og-fonts/. */
export function cardFont(key: FontKey): Buffer {
  let bytes = fontCache.get(key);
  if (!bytes) {
    bytes = readFileSync(path.join(process.cwd(), "lib", "og-fonts", CARD_FONT_FILES[key]));
    fontCache.set(key, bytes);
  }
  return bytes;
}

type Metrics = { unitsPerEm: number; advance: (codePoint: number) => number };

const metricsCache = new Map<FontKey, Metrics>();

/** Advance widths from a TrueType font's head, hhea, hmtx and cmap (format 4) tables. */
function readMetrics(bytes: Buffer): Metrics {
  const tables = new Map<string, number>();
  const count = bytes.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    tables.set(bytes.toString("latin1", record, record + 4), bytes.readUInt32BE(record + 8));
  }
  const table = (tag: string) => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`card font has no ${tag} table`);
    return offset;
  };
  const unitsPerEm = bytes.readUInt16BE(table("head") + 18);
  const metricCount = bytes.readUInt16BE(table("hhea") + 34);
  const hmtx = table("hmtx");
  const advanceOfGlyph = (glyph: number) =>
    bytes.readUInt16BE(hmtx + 4 * Math.min(glyph, metricCount - 1));

  // The Unicode BMP subtable, format 4.
  const cmap = table("cmap");
  let format4 = -1;
  for (let index = 0; index < bytes.readUInt16BE(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    const offset = cmap + bytes.readUInt32BE(record + 4);
    if (bytes.readUInt16BE(offset) === 4) {
      format4 = offset;
      break;
    }
  }
  if (format4 < 0) throw new Error("card font has no format 4 cmap");
  const segments = bytes.readUInt16BE(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  const glyphOf = (codePoint: number): number => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (codePoint > bytes.readUInt16BE(ends + segment * 2)) continue;
      const start = bytes.readUInt16BE(starts + segment * 2);
      if (codePoint < start) return 0;
      const delta = bytes.readInt16BE(deltas + segment * 2);
      const rangeOffset = bytes.readUInt16BE(rangeOffsets + segment * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyphAt = rangeOffsets + segment * 2 + rangeOffset + (codePoint - start) * 2;
      const glyph = bytes.readUInt16BE(glyphAt);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  return { unitsPerEm, advance: (codePoint) => advanceOfGlyph(glyphOf(codePoint)) };
}

function metrics(key: FontKey): Metrics {
  let found = metricsCache.get(key);
  if (!found) {
    found = readMetrics(cardFont(key));
    metricsCache.set(key, found);
  }
  return found;
}

/** The width of a run of text in pixels, set in one card font at one size. */
export function textWidth(text: string, key: FontKey, sizePx: number): number {
  const { unitsPerEm, advance } = metrics(key);
  let units = 0;
  for (const character of text) units += advance(character.codePointAt(0)!);
  return (units / unitsPerEm) * sizePx;
}

/** Measured widths are held to this share of the box, so a line never ends at its edge. */
const SAFETY = 0.96;

/** How many lines a text takes in a box of a given width, broken at spaces. */
export function lineCount(text: string, key: FontKey, sizePx: number, boxWidth: number): number {
  const limit = boxWidth * SAFETY;
  const space = textWidth(" ", key, sizePx);
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const width = textWidth(word, key, sizePx);
    if (used === 0) {
      used = width;
      // A single word wider than the box is broken by the renderer.
      while (used > limit) {
        lines += 1;
        used -= limit;
      }
    } else if (used + space + width <= limit) {
      used += space + width;
    } else {
      lines += 1;
      used = width;
      while (used > limit) {
        lines += 1;
        used -= limit;
      }
    }
  }
  return lines;
}

/** The report card's drawn padding: 72 px either side, 56 above the wordmark, 44 at the foot. */
export const OG_REPORT_CARD_SIDE = 72;
export const OG_REPORT_CARD_TOP = 56;
export const OG_REPORT_CARD_FOOT = 44;

/**
 * The bands no text may enter, which lib/og-report-card-fit.test.ts checks
 * on every committed card: 64 px at either side, 36 px at the head and foot.
 * They sit 8 px inside the drawn padding (20 px at the head), so the 1 px a
 * serif can reach past its text box (STIX Two Text's "w") is not text in the
 * padding, while a line that runs past its box by more is.
 */
export const OG_REPORT_CARD_PADDING = { vertical: 36, horizontal: 64 } as const;

/** The card's box: 1200 by 630, less the padding either side. */
export const CARD_TEXT_WIDTH = 1200 - 2 * OG_REPORT_CARD_SIDE;

/** The finding sentence's three sizes, largest first; the first that fits in three lines is used. */
export const SENTENCE_SIZES = [
  { size: 44, lineHeight: 52 },
  { size: 38, lineHeight: 46 },
  { size: 34, lineHeight: 42 }
] as const;

/** The size the finding sentence is set at: the largest that keeps it to three lines, else the smallest. */
export function sentenceSize(sentence: string): (typeof SENTENCE_SIZES)[number] {
  return (
    SENTENCE_SIZES.find((step) => lineCount(sentence, "serif500", step.size, CARD_TEXT_WIDTH) <= 3) ??
    SENTENCE_SIZES[SENTENCE_SIZES.length - 1]
  );
}

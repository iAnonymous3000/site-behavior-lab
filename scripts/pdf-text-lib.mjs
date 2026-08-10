import zlib from "node:zlib";

/**
 * Just enough PDF reading to check what a generated document actually contains.
 *
 * The container smoke test has to answer one question about /api/reports/<id>/pdf:
 * is this the COMPLETE printable rendering, or a summary that quietly dropped
 * the evidence? "200, application/pdf, non-zero bytes" cannot tell those apart,
 * and a summary-only regression is exactly the failure the printable route was
 * built to prevent. So the smoke reads the text back out and counts rows.
 *
 * Scope is deliberately narrow: it reads what Chromium's own PDF writer emits,
 * which is PDF 1.4 with every stream FlateDecode-compressed, every /Length a
 * direct integer, no object streams, and a ToUnicode CMap per subset font. It
 * is not a general PDF parser and must not be used as one. Every assumption it
 * makes is asserted rather than assumed, so a Chromium change that breaks one
 * fails loudly here instead of silently returning empty text that would make
 * the smoke's own assertions vacuous.
 */

export class PdfShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PdfShapeError";
  }
}

const OBJECT_HEADER = /(?:^|[\s>])(\d+)\s+0\s+obj\b/g;
/** Bounds the dictionary scan; Chromium's object dictionaries are far smaller. */
const MAX_DICTIONARY_BYTES = 64 * 1024;

/**
 * Every indirect object, by number.
 *
 * Streams are sliced by their dictionary's `/Length` rather than by scanning
 * for `endstream`: compressed bytes routinely contain that literal, and a
 * scan-based slice would silently truncate and then fail to inflate. An
 * indirect `/Length` would break that, so it is rejected outright.
 */
export function readPdfObjects(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = buffer.toString("latin1");
  const objects = new Map();

  // Sequential, with the cursor stepped PAST every stream body. Compressed
  // bytes contain "N 0 obj" and "endstream" often enough that any scan which
  // walks over them will eventually parse binary noise as structure; the first
  // version of this reader did, and inflate failed on the phantom object.
  let cursor = 0;
  for (;;) {
    OBJECT_HEADER.lastIndex = cursor;
    const header = OBJECT_HEADER.exec(text);
    if (!header) break;

    const number = Number(header[1]);
    const bodyStart = header.index + header[0].length;
    const window = text.slice(bodyStart, bodyStart + MAX_DICTIONARY_BYTES);
    const streamMarker = /stream\r?\n/.exec(window);
    const endObject = window.indexOf("endobj");

    if (!streamMarker || (endObject >= 0 && endObject < streamMarker.index)) {
      const dictionaryEnd = endObject >= 0 ? endObject : window.length;
      objects.set(number, { dictionary: window.slice(0, dictionaryEnd), stream: null });
      cursor = bodyStart + (endObject >= 0 ? endObject + "endobj".length : dictionaryEnd);
      continue;
    }

    const dictionary = window.slice(0, streamMarker.index);
    const length = /\/Length\s+(\d+)(?!\s*\d*\s*R)/.exec(dictionary);
    if (!length) {
      throw new PdfShapeError(
        `object ${number} has a stream with no direct /Length; this reader cannot resolve indirect lengths`
      );
    }
    const streamStart = bodyStart + streamMarker.index + streamMarker[0].length;
    const streamEnd = streamStart + Number(length[1]);
    const raw = buffer.subarray(streamStart, streamEnd);
    // Not every stream is compressed: Chromium writes Type 3 glyph procedures
    // with no /Filter at all, and inflating those unconditionally fails.
    const filter = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dictionary);
    let stream;
    if (!filter) {
      stream = raw.toString("latin1");
    } else if (/^\/FlateDecode$/.test(filter[1])) {
      try {
        stream = zlib.inflateSync(raw).toString("latin1");
      } catch (error) {
        throw new PdfShapeError(`object ${number} stream did not inflate: ${String(error)}`);
      }
    } else {
      throw new PdfShapeError(
        `object ${number} uses filter ${filter[1]}; this reader only understands uncompressed and FlateDecode streams`
      );
    }
    objects.set(number, { dictionary, stream });
    cursor = streamEnd;
  }

  if (objects.size === 0) throw new PdfShapeError("no indirect objects; this is not a PDF this reader understands");
  return objects;
}

/** Total pages, from the page-tree root the catalog names. */
export function pdfPageCount(bytes) {
  const objects = readPdfObjects(bytes);
  for (const { dictionary } of objects.values()) {
    if (!/\/Type\s*\/Catalog\b/.test(dictionary)) continue;
    const pages = /\/Pages\s+(\d+)\s+0\s+R/.exec(dictionary);
    if (!pages) continue;
    const root = objects.get(Number(pages[1]));
    const count = root && /\/Count\s+(\d+)/.exec(root.dictionary);
    if (count) return Number(count[1]);
  }
  throw new PdfShapeError("could not resolve a page count from the catalog");
}

function parseToUnicodeCMap(source) {
  const map = new Map();
  const decode = (hex) =>
    String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)));

  for (const block of source.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), decode(pair[2]));
    }
  }
  for (const block of source.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const range of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const low = parseInt(range[1], 16);
      const high = parseInt(range[2], 16);
      const destination = parseInt(range[3], 16);
      // A subset font's range is small; a malformed one must not spin.
      if (high - low > 65_535) throw new PdfShapeError("implausible bfrange width");
      for (let code = low; code <= high; code += 1) {
        map.set(code, String.fromCharCode(destination + (code - low)));
      }
    }
  }
  return map;
}

/**
 * The document's text, in content-stream order.
 *
 * Glyph runs are concatenated with no inserted separators, because PDF text
 * positioning carries the spacing and inventing it would let a caller assert
 * word boundaries this reader did not observe. Callers that want to match a
 * phrase should collapse whitespace on BOTH sides; `pdfTextIncludes` does that.
 */
export function pdfText(bytes) {
  const objects = readPdfObjects(bytes);

  const fontByObject = new Map();
  for (const [number, { dictionary }] of objects) {
    if (!/\/Type\s*\/Font\b/.test(dictionary)) continue;
    const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dictionary);
    if (!toUnicode) continue;
    const source = objects.get(Number(toUnicode[1]))?.stream;
    if (!source) continue;
    // Chromium mixes two code widths in one document, and the width is the
    // whole decode: a Type3 glyph is written `<92> Tj`, one byte per show,
    // while an Identity-H composite font is two. Reading a Type3 run as
    // 2-byte codes drops it entirely (an odd-length nibble string yields no
    // full code), which is how the first version of this reader returned
    // clean-looking text that was missing every paragraph on the page.
    const composite = /\/Subtype\s*\/Type0\b/.test(dictionary);
    if (composite && !/\/Encoding\s*\/Identity-H\b/.test(dictionary)) {
      throw new PdfShapeError(
        `font object ${number} is a composite font with a non-Identity-H encoding; ` +
          "this reader cannot determine its code width"
      );
    }
    fontByObject.set(number, { bytesPerCode: composite ? 2 : 1, cmap: parseToUnicodeCMap(source) });
  }
  if (fontByObject.size === 0) {
    throw new PdfShapeError("no ToUnicode CMaps; text in this document is not recoverable");
  }

  // Chromium names each font resource uniquely across the document, so one flat
  // name->font map is sound. Assert it rather than assume it: if two resource
  // dictionaries ever reused a name for different fonts, a flat map would
  // silently decode one of them with the other's glyph table and produce
  // plausible nonsense.
  const fontByResourceName = new Map();
  for (const { dictionary } of objects.values()) {
    const fonts = /\/Font\s*<<([\s\S]*?)>>/.exec(dictionary);
    if (!fonts) continue;
    for (const entry of fonts[1].matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) {
      const existing = fontByResourceName.get(entry[1]);
      const target = Number(entry[2]);
      if (existing !== undefined && existing !== target) {
        throw new PdfShapeError(
          `font resource /${entry[1]} refers to objects ${existing} and ${target}; ` +
            "this reader assumes document-unique font resource names"
        );
      }
      fontByResourceName.set(entry[1], target);
    }
  }

  let out = "";
  for (const { stream } of objects.values()) {
    if (!stream || !/\bTf\b/.test(stream)) continue;
    let font = null;
    const tokens = stream.matchAll(
      /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F\s]*)>\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ/g
    );
    for (const token of tokens) {
      if (token[1] !== undefined) {
        const fontObject = fontByResourceName.get(token[1]);
        font = fontObject === undefined ? null : fontByObject.get(fontObject) ?? null;
        continue;
      }
      const runs =
        token[2] !== undefined
          ? [token[2]]
          : [...token[3].matchAll(/<([0-9a-fA-F\s]*)>/g)].map((piece) => piece[1]);
      for (const run of runs) {
        const nibbles = run.replace(/\s+/g, "");
        if (nibbles.length === 0) continue;
        if (!font) {
          // A show with no resolvable font is a decode failure, not empty text.
          out += "�";
          continue;
        }
        const width = font.bytesPerCode * 2;
        if (nibbles.length % width !== 0) {
          throw new PdfShapeError(
            `a ${nibbles.length}-nibble glyph run does not divide into ${font.bytesPerCode}-byte codes`
          );
        }
        for (const glyph of nibbles.match(new RegExp(`.{${width}}`, "g")) ?? []) {
          // An unmapped glyph becomes U+FFFD rather than nothing: dropping it
          // would let a broken decode read as clean text, which is exactly what
          // the width bug did.
          out += font.cmap.get(parseInt(glyph, 16)) ?? "�";
        }
      }
    }
    out += "\n";
  }
  return out;
}

/** Whitespace-insensitive phrase match, since glyph runs carry no separators. */
export function pdfTextIncludes(text, phrase) {
  return text.replace(/\s+/g, "").includes(phrase.replace(/\s+/g, ""));
}

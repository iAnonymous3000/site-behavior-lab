import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { PdfShapeError, pdfPageCount, pdfText, pdfTextIncludes, readPdfObjects } from "./pdf-text-lib.mjs";

/**
 * Hand-built documents, not a rendered fixture.
 *
 * The reader exists so the container smoke can prove a generated PDF still
 * contains the evidence. A test that renders one with Chromium would prove the
 * reader and the writer agree today and say nothing about what happens when
 * either drifts, so each Chromium-shaped assumption gets an explicit document
 * here: the one-byte Type3 code, the two-byte Identity-H code, an uncompressed
 * stream, and binary that contains PDF structure. Every one of these was a real
 * defect in this reader before it was a test.
 */

function object(number, dictionary, streamBytes = null, { compress = true } = {}) {
  if (!streamBytes) return Buffer.from(`${number} 0 obj\n<<${dictionary}>>\nendobj\n`, "latin1");
  const payload = compress ? zlib.deflateSync(streamBytes) : streamBytes;
  return Buffer.concat([
    Buffer.from(
      `${number} 0 obj\n<<${dictionary}${compress ? "\n/Filter /FlateDecode" : ""}\n/Length ${payload.length}>>\nstream\n`,
      "latin1"
    ),
    payload,
    Buffer.from("\nendstream\nendobj\n", "latin1")
  ]);
}

function pdf(parts) {
  return Buffer.concat([Buffer.from("%PDF-1.4\n%\xd3\xeb\xe9\xe1\n", "latin1"), ...parts]);
}

/** A ToUnicode CMap mapping each code to the corresponding character. */
function toUnicodeStream(pairs) {
  const entries = pairs
    .map(([code, char]) => {
      const codeHex = code.toString(16).padStart(4, "0");
      const charHex = char.charCodeAt(0).toString(16).padStart(4, "0");
      return `<${codeHex}> <${charHex}>`;
    })
    .join("\n");
  return Buffer.from(
    `/CIDInit /ProcSet findresource begin\nbeginbfchar\n${entries}\nendbfchar\nend\n`,
    "latin1"
  );
}

/** Codes for "HI" under a chosen offset, so mapping is never accidental. */
const SIMPLE_CMAP = [
  [0x28, "H"],
  [0x29, "I"]
];
const COMPOSITE_CMAP = [
  [0x0128, "O"],
  [0x0129, "K"]
];

function documentWith(contentStream, { fontDictionary, cmapPairs }) {
  return pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
    object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
    object(4, `/Type /Font\n${fontDictionary}\n/ToUnicode 5 0 R`),
    object(5, "", toUnicodeStream(cmapPairs)),
    object(6, "", Buffer.from(contentStream, "latin1"))
  ]);
}

test("a one-byte Type3 code is decoded, not silently dropped", () => {
  // The defect this catches: reading `<28> Tj` as a 2-byte code yields an
  // odd-length nibble string, no complete code, and therefore NO text. The
  // reader looked correct because the composite-font runs still decoded, so
  // the document read as clean text with every paragraph missing.
  const document = documentWith("BT\n/F1 12 Tf\n<28> Tj\n<29> Tj\nET\n", {
    fontDictionary: "/Subtype /Type3\n/FirstChar 0\n/LastChar 254",
    cmapPairs: SIMPLE_CMAP
  });
  assert.equal(pdfText(document).trim(), "HI");
});

test("a two-byte Identity-H code is decoded at its own width", () => {
  const document = documentWith("BT\n/F1 12 Tf\n<01280129> Tj\nET\n", {
    fontDictionary: "/Subtype /Type0\n/Encoding /Identity-H",
    cmapPairs: COMPOSITE_CMAP
  });
  assert.equal(pdfText(document).trim(), "OK");
});

test("both widths in one document decode independently", () => {
  // Chromium emits exactly this mix: Type3 for the page's body text and
  // Identity-H for the monospaced runs. One global width corrupts one of them.
  const document = pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
    object(
      3,
      "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R\n/F2 7 0 R>>>>\n/Contents 9 0 R"
    ),
    object(4, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R"),
    object(5, "", toUnicodeStream(SIMPLE_CMAP)),
    object(7, "/Type /Font\n/Subtype /Type0\n/Encoding /Identity-H\n/ToUnicode 8 0 R"),
    object(8, "", toUnicodeStream(COMPOSITE_CMAP)),
    object(9, "", Buffer.from("BT\n/F1 12 Tf\n<28> Tj\n/F2 12 Tf\n<0128> Tj\n/F1 12 Tf\n<29> Tj\nET\n", "latin1"))
  ]);
  assert.equal(pdfText(document).trim(), "HOI");
});

test("TJ arrays contribute their glyph runs and drop their kerning numbers", () => {
  const document = documentWith("BT\n/F1 12 Tf\n[<28> -250 <29>] TJ\nET\n", {
    fontDictionary: "/Subtype /Type3\n/FirstChar 0\n/LastChar 254",
    cmapPairs: SIMPLE_CMAP
  });
  assert.equal(pdfText(document).trim(), "HI");
});

test("an uncompressed stream is read as-is", () => {
  // Chromium writes Type3 glyph procedures with no /Filter at all. Inflating
  // those unconditionally threw, which aborted the whole read.
  const document = pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
    object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
    object(4, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R"),
    object(5, "", toUnicodeStream(SIMPLE_CMAP)),
    object(6, "", Buffer.from("BT\n/F1 12 Tf\n<28> Tj\nET\n", "latin1"), { compress: false })
  ]);
  assert.equal(pdfText(document).trim(), "H");
});

test("binary stream content that looks like PDF structure is stepped over", () => {
  // Compressed bytes contain "N 0 obj" and "endstream" often enough that a
  // scanning reader eventually parses noise as an object and fails to inflate
  // it. This is that document, made deterministic.
  // The decoy sits INSIDE the stream with bytes before it, so the header is
  // preceded by whitespace the object-header pattern will happily match. A
  // decoy placed at the very first byte of the body is not a real test: the
  // pattern needs a leading delimiter, and a cursor parked exactly on the
  // header cannot see the one behind it, so a broken reader passes by luck.
  const decoy = Buffer.from(
    "glyph data\n443 0 obj\n<</Length 17>> stream\nnot a real object\nendstream\nendobj\n",
    "latin1"
  );
  const document = pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
    object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
    object(4, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R"),
    object(5, "", toUnicodeStream(SIMPLE_CMAP)),
    object(6, "", Buffer.from("BT\n/F1 12 Tf\n<28> Tj\nET\n", "latin1")),
    object(7, "", decoy, { compress: false })
  ]);
  const objects = readPdfObjects(document);
  assert.equal(objects.has(443), false, "a decoy header inside a stream body must not become an object");
  assert.equal(pdfText(document).trim(), "H");
});

test("the page count comes from the catalog's page tree, not from counting matches", () => {
  const document = pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R 7 0 R]\n/Count 9"),
    object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
    object(4, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R"),
    object(5, "", toUnicodeStream(SIMPLE_CMAP)),
    object(6, "", Buffer.from("BT\n/F1 12 Tf\n<28> Tj\nET\n", "latin1")),
    object(7, "/Type /Pages\n/Parent 2 0 R\n/Kids []\n/Count 8")
  ]);
  assert.equal(pdfPageCount(document), 9);
});

test("an unmapped glyph becomes a replacement character rather than nothing", () => {
  // Silence is the dangerous failure: a reader that drops what it cannot decode
  // returns clean-looking text, and every assertion built on it passes.
  const document = documentWith("BT\n/F1 12 Tf\n<28> Tj\n<FF> Tj\nET\n", {
    fontDictionary: "/Subtype /Type3\n/FirstChar 0\n/LastChar 254",
    cmapPairs: SIMPLE_CMAP
  });
  assert.equal(pdfText(document).trim(), "H�");
});

test("a show with no resolvable font is a replacement character, not empty text", () => {
  const document = pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
    object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
    object(4, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R"),
    object(5, "", toUnicodeStream(SIMPLE_CMAP)),
    object(6, "", Buffer.from("BT\n/F9 12 Tf\n<28> Tj\nET\n", "latin1"))
  ]);
  assert.equal(pdfText(document).trim(), "�");
});

test("shapes this reader cannot honestly read are refused, not guessed at", () => {
  const base = (extra) =>
    pdf([
      object(1, "/Type /Catalog\n/Pages 2 0 R"),
      object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
      object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
      ...extra
    ]);

  // An indirect /Length cannot be resolved by a single forward pass, and
  // guessing the stream end is how a reader silently truncates.
  const indirectLength = Buffer.concat([
    base([]),
    Buffer.from("6 0 obj\n<</Length 9 0 R>>\nstream\nBT ET\nendstream\nendobj\n", "latin1")
  ]);
  assert.throws(() => readPdfObjects(indirectLength), PdfShapeError);

  // A filter this reader does not implement must fail loudly; treating the
  // bytes as text would produce garbage that still "contains" nothing.
  const unknownFilter = Buffer.concat([
    base([]),
    Buffer.from("6 0 obj\n<</Filter /LZWDecode\n/Length 5>>\nstream\nabcde\nendstream\nendobj\n", "latin1")
  ]);
  assert.throws(() => readPdfObjects(unknownFilter), PdfShapeError);

  // Two different fonts under one resource name would make a flat name->font
  // map decode one of them with the other's glyph table: plausible nonsense.
  const ambiguousFont = pdf([
    object(1, "/Type /Catalog\n/Pages 2 0 R"),
    object(2, "/Type /Pages\n/Kids [3 0 R]\n/Count 1"),
    object(3, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 4 0 R>>>>\n/Contents 6 0 R"),
    object(4, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R"),
    object(5, "", toUnicodeStream(SIMPLE_CMAP)),
    object(6, "", Buffer.from("BT\n/F1 12 Tf\n<28> Tj\nET\n", "latin1")),
    object(7, "/Type /Page\n/Parent 2 0 R\n/Resources <</Font <</F1 8 0 R>>>>\n/Contents 6 0 R"),
    object(8, "/Type /Font\n/Subtype /Type3\n/FirstChar 0\n/LastChar 254\n/ToUnicode 5 0 R")
  ]);
  assert.throws(() => pdfText(ambiguousFont), PdfShapeError);

  // A composite font with an encoding whose code width this reader does not
  // know must not be read at the Identity-H width.
  const unknownEncoding = documentWith("BT\n/F1 12 Tf\n<0128> Tj\nET\n", {
    fontDictionary: "/Subtype /Type0\n/Encoding /UniJIS-UCS2-H",
    cmapPairs: COMPOSITE_CMAP
  });
  assert.throws(() => pdfText(unknownEncoding), PdfShapeError);

  // Nothing that is a PDF at all.
  assert.throws(() => readPdfObjects(Buffer.from("not a pdf")), PdfShapeError);
});

test("phrase matching is whitespace-insensitive on both sides", () => {
  // Glyph runs carry no separators, so "Approved use" comes back as
  // "Approveduse". A caller that matched raw text would assert nothing.
  const text = "Approveduse:Thisreportisinvestigative\nevidence";
  assert.equal(pdfTextIncludes(text, "Approved use"), true);
  assert.equal(pdfTextIncludes(text, "  Approved\n use "), true);
  assert.equal(pdfTextIncludes(text, "Approved abuse"), false);
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const fontsDir = path.join(process.cwd(), "public", "fonts");

function woff2Files(): string[] {
  return readdirSync(fontsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(path.join(fontsDir, entry.name))
        .filter((name) => name.endsWith(".woff2"))
        .map((name) => path.join(entry.name, name))
    )
    .sort();
}

/**
 * A browser refuses a WOFF2 file whose header disagrees with the file, and
 * then sets the page in a fallback font with nothing on the page to say so.
 * The first build of these files gave the unpadded length in the header of a
 * padded file; four of the five never loaded. These are the header facts a
 * reader checks before it decompresses anything.
 */
test("every self-hosted font file has a WOFF2 header that agrees with the file", () => {
  const files = woff2Files();
  assert.equal(files.length, 5, `expected the five design font files, found ${files.join(", ")}`);
  for (const file of files) {
    const bytes = readFileSync(path.join(fontsDir, file));
    assert.equal(bytes.toString("latin1", 0, 4), "wOF2", file);
    assert.equal(bytes.readUInt32BE(8), bytes.length, `${file}: the header's length field is not the file's size`);
    assert.equal(bytes.length % 4, 0, `${file}: not padded to four bytes`);
    assert.ok(bytes.readUInt16BE(12) > 0, `${file}: no tables`);
    const compressed = bytes.readUInt32BE(20);
    assert.ok(compressed > 0 && compressed < bytes.length - 48, `${file}: compressed size ${compressed}`);
    // No metadata and no private block is carried.
    for (const offset of [28, 32, 36, 40, 44]) assert.equal(bytes.readUInt32BE(offset), 0, `${file}: header field at ${offset}`);
  }
});

test("the font builder writes the padded size into the header", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts", "build-design-fonts.mjs"), "utf8");
  assert.match(source, /const length = \(unpadded \+ 3\) & ~3;/);
  assert.match(source, /header\.writeUInt32BE\(length, 8\);/);
  assert.match(source, /Buffer\.alloc\(length - unpadded\)/);
});

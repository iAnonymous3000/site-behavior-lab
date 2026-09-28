import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type PdfDocument = { getMarkInfo(): Promise<unknown> };
type LoadingTask = { promise: Promise<PdfDocument>; destroy(): Promise<void> };

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
const acceptance = nativeImport(
  pathToFileURL(path.join(process.cwd(), "scripts/report-export-acceptance.mjs")).href
) as Promise<{ pdfRetainsReadingStructure(doc: PdfDocument): Promise<boolean> }>;
// The same pdf.js build the acceptance script imports, resolved from the checkout.
const pdfjs = nativeImport(
  pathToFileURL(createRequire(path.join(process.cwd(), "package.json")).resolve("pdfjs-dist/legacy/build/pdf.mjs")).href
) as Promise<{ getDocument(options: { data: Uint8Array; useSystemFonts: boolean; useWasm: boolean }): LoadingTask }>;

test("the export smoke reads a tagged PDF's MarkInfo from the Map pdf.js returns", async () => {
  // pdf.js 6.3 returns the catalog's MarkInfo as a Map. Reading `.Marked` off
  // it is undefined for every document, so the Docker smoke's reading-structure
  // assertion would fail the correctly tagged export it exists to accept.
  const { pdfRetainsReadingStructure } = await acceptance;
  const { getDocument } = await pdfjs;
  const readingStructure = async (catalog: string): Promise<boolean> => {
    const loading = getDocument({ data: pdfWithCatalog(catalog), useSystemFonts: false, useWasm: false });
    try {
      return await pdfRetainsReadingStructure(await loading.promise);
    } finally {
      await loading.destroy();
    }
  };

  assert.equal(await readingStructure("<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> >>"), true);
  assert.equal(await readingStructure("<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked false >> >>"), false);
  assert.equal(await readingStructure("<< /Type /Catalog /Pages 2 0 R >>"), false);
});

/** A one-page document with no content under the given catalog dictionary. */
function pdfWithCatalog(catalog: string): Uint8Array {
  const objects = [
    catalog,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n", "latin1")];
  const offsets: number[] = [];
  let byteLength = parts[0].byteLength;
  objects.forEach((object, index) => {
    offsets.push(byteLength);
    const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    parts.push(bytes);
    byteLength += bytes.byteLength;
  });
  parts.push(
    Buffer.from(
      [
        `xref\n0 ${objects.length + 1}\n`,
        "0000000000 65535 f \n",
        ...offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${byteLength}\n%%EOF\n`
      ].join(""),
      "latin1"
    )
  );
  return new Uint8Array(Buffer.concat(parts));
}

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { inflateSync } from "node:zlib";
import { ImageResponse } from "next/og";
import { createElement } from "react";
import ts from "typescript";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-view";
import type { ReportView } from "./scan-report-views";

type OgReportCardModule = {
  OG_SIZE: { width: number; height: number };
  OG_REPORT_CARD_PADDING: { vertical: number; horizontal: number };
  renderReportCard: (view: ReportView) => ImageResponse;
};

const reportsDir = path.join(process.cwd(), "public", "reports");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;

// A pixel counts as card text when any channel reaches this. The card's
// background and the accent glow over it stay below 50 in every channel for
// every accent, and the dimmest card text colour reaches 144, so neither the
// background nor the edge of a glyph can be mistaken for the other.
const TEXT_CHANNEL_MIN = 100;

/**
 * Compile the renderer with the real next/og, so the card is laid out and
 * rasterised by the same code the static export runs. The unit compiler
 * excludes TSX, as og-report-card.test.ts explains.
 */
function loadOgReportCardModule(): OgReportCardModule {
  const file = path.join(process.cwd(), "lib", "og-report-card.tsx");
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017
    }
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => (id === "next/og" ? { ImageResponse } : require(id));
  const evaluate = new Script(`(function (require, module, exports) { ${compiled}\n})`, { filename: file }).runInThisContext() as (
    requireModule: (id: string) => unknown,
    targetModule: typeof module,
    exports: typeof module.exports
  ) => void;
  evaluate(localRequire, module, module.exports);
  return module.exports as OgReportCardModule;
}

type Pixels = { width: number; height: number; channels: number; data: Buffer };

/** Decode the 8-bit, non-interlaced RGB or RGBA PNG the card renderer writes. */
function decodePng(png: Buffer): Pixels {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8, "card PNG bit depth");
      assert.ok(chunk[9] === 6 || chunk[9] === 2, `card PNG colour type ${chunk[9]}`);
      assert.equal(chunk[12], 0, "card PNG interlace");
      channels = chunk[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") idat.push(chunk);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? data[y * stride + i - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        predictor = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      } else assert.equal(filter, 0, `unknown PNG filter ${filter}`);
      data[y * stride + i] = (raw[source + i] + predictor) & 255;
    }
  }
  return { width, height, channels, data };
}

type PaddingHits = { right: number; left: number; bottom: number; top: number };

/**
 * Count text pixels inside the card's padding. The 12 px accent bar along the
 * top edge is decoration inside the top padding and is skipped. Text that runs
 * off an edge is cut there, and the part still on the card always crosses the
 * padding beside that edge, so a cut line is always counted.
 */
function textInPadding(pixels: Pixels, padding: OgReportCardModule["OG_REPORT_CARD_PADDING"]): PaddingHits {
  const hits: PaddingHits = { right: 0, left: 0, bottom: 0, top: 0 };
  const { width, height, channels, data } = pixels;
  for (let y = 12; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      if (Math.max(data[at], data[at + 1], data[at + 2]) < TEXT_CHANNEL_MIN) continue;
      if (x >= width - padding.horizontal) hits.right++;
      else if (x < padding.horizontal) hits.left++;
      else if (y >= height - padding.vertical) hits.bottom++;
      else if (y < padding.vertical) hits.top++;
    }
  }
  return hits;
}

async function renderPixels(response: ImageResponse): Promise<Pixels> {
  return decodePng(Buffer.from(await response.arrayBuffer()));
}

test("the padding check sees text placed in each padding band", async () => {
  const og = loadOgReportCardModule();
  const { width, height } = og.OG_SIZE;
  const { vertical, horizontal } = og.OG_REPORT_CARD_PADDING;
  const at = (left: number, top: number) =>
    createElement("div", { style: { position: "absolute", left, top, display: "flex", fontSize: 16, color: "#7a9085" } }, "cut");
  // The clean card carries the brightest glow a report card paints (the alarm
  // accent at the card's alpha, centred on the corner where it is strongest),
  // so a threshold low enough to mistake background for text fails here.
  const card = (...children: ReturnType<typeof at>[]) =>
    new ImageResponse(
      createElement(
        "div",
        {
          style: {
            display: "flex",
            width: "100%",
            height: "100%",
            backgroundColor: "#0b1110",
            backgroundImage: "radial-gradient(900px 420px at 100% 100%, #fb718526, transparent 60%)"
          }
        },
        ...children
      ),
      og.OG_SIZE
    );
  const clean = await renderPixels(card(at(400, 300)));
  assert.deepEqual(textInPadding(clean, og.OG_REPORT_CARD_PADDING), { right: 0, left: 0, bottom: 0, top: 0 });
  const planted = await renderPixels(card(at(width - 24, 300), at(4, 300), at(400, height - vertical + 4), at(400, 16)));
  const hits = textInPadding(planted, og.OG_REPORT_CARD_PADDING);
  assert.ok(horizontal > 24 && vertical > 20, "the planted text lies inside the padding");
  for (const band of ["right", "left", "bottom", "top"] as const) assert.ok(hits[band] > 0, `no text found in the ${band} padding`);
});

test("every committed report card keeps all of its text inside the card's padding", async () => {
  const og = loadOgReportCardModule();
  const names = readdirSync(reportsDir).filter((entry) => reportFilePattern.test(entry)).sort();
  assert.ok(names.length > 0, "no committed reports found");
  const cut: string[] = [];
  for (const name of names) {
    const read = readStoredScanReport(JSON.parse(readFileSync(path.join(reportsDir, name), "utf8")) as unknown);
    if (!read.ok) throw new Error(`reader rejected committed report ${name}: ${read.error}`);
    const pixels = await renderPixels(og.renderReportCard(toReportView(read.stored)));
    assert.equal(pixels.width, og.OG_SIZE.width, name);
    assert.equal(pixels.height, og.OG_SIZE.height, name);
    const hits = textInPadding(pixels, og.OG_REPORT_CARD_PADDING);
    if (hits.right || hits.left || hits.bottom || hits.top) cut.push(`${name} ${JSON.stringify(hits)}`);
  }
  assert.deepEqual(cut, [], `${cut.length} of ${names.length} cards put text into the padding or past an edge`);
});

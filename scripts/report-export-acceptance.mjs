import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readResponseBytesWithinLimit, readResponseTextWithinLimit } from "./http-response.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const compact = (text) => text.replace(/\s+/g, "");
// Immutable published witnesses; expected populations are not derived from the renderer.
export const PDF_EXPORT_WITNESSES = [
  { id: "20260730-748f7a920c0fdcf86c9a348a8660d395", rows: [6] },
  { id: "20260814-f47e5f1cd64def348acb6072ca7dae41", rows: [150, 91], corrected: true },
  { id: "20260625-2bfb0a20225479c5400ff86da338ad75", rows: [1000, 53], capped: true },
  { id: "20260824-4f89a805b50169b2c0e8b01a975018c9", rows: [183, 180], corrected: true }
];

export async function verifyPdfArtifact(pdfBytes, wire, correctionBytes) {
  const report = JSON.parse(wire);
  const comparison = report.reportType === "comparison";
  const runs = comparison ? [["B", report.baseline], ["V", report.variant]] : [["S", report.run ?? report]];
  const rows = runs.flatMap(([prefix, run]) => (run.evidence?.requests ?? run.requests).map((row, index) => ({
    ref: `${prefix}:R${String(index + 1).padStart(4, "0")}`, row
  })));
  const loading = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false, useWasm: false });
  const doc = await loading.promise;
  try {
    const texts = []; let links = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!item.str) continue;
        if (/^[BVS]:R\d{4}$/.test(item.str.trim())) {
          assert.ok(Math.abs(item.transform[3]) >= 8.9, `request references shrank below 9pt on page ${number}`);
        }
      }
      texts.push(content.items.map(item => item.str ?? "").join(" "));
      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        const url = annotation.url ?? annotation.unsafeUrl;
        if (!url) continue;
        assert.doesNotMatch(url, /^https?:\/\/(?:localhost|127\.|\[::1\])/, `non-portable PDF link on page ${number}`);
        links++;
      }
    }
    const text = texts.join("\n");
    const references = [...text.matchAll(/\b[BVS]:R\d{4}\b/g)].map(match => match[0]);
    assert.deepEqual(references, rows.map(row => row.ref), "every retained request row must appear once, in visit order");
    // Compare each printed row with independent recorded timing and type, not a URL-count proxy.
    for (let index = 0; index < rows.length; index++) {
      const {ref, row} = rows[index];
      const start = text.indexOf(ref);
      const end = index + 1 < rows.length ? text.indexOf(rows[index + 1].ref, start + ref.length) : text.length;
      const rendered = compact(text.slice(start, end));
      assert.ok(rendered.includes(`${row.startedAtMs.toLocaleString("en-US")}ms`), `${ref}: wrong or missing request time`);
      assert.ok(rendered.includes(compact(row.resourceType)), `${ref}: wrong or missing resource type`);
    }
    assert.ok(compact(text).includes(sha256(wire)), "PDF must name the exact source bytes");
    if (correctionBytes) assert.ok(compact(text).includes(sha256(correctionBytes)), "PDF must bind the packaged correction context");
    assert.ok((await doc.getMarkInfo())?.Marked, "PDF must retain its reading structure");
    assert.ok((await doc.getOutline())?.length, "PDF must have bookmarks");
    assert.ok(links > 0, "methodology links must survive export");
    assert.doesNotMatch(text, /other visit.s evidence is not printed/);
    return { pages: doc.numPages, rows: rows.length, links, text };
  } finally { await loading.destroy(); }
}

export async function assertReportExportAcceptance(baseUrl, { outputDir } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "sbl-export-acceptance-"));
  const results = [];
  try {
    for (const witness of PDF_EXPORT_WITNESSES) {
      const response = await fetch(`${baseUrl}/api/reports/${witness.id}`, { signal: AbortSignal.timeout(90_000) });
      assert.equal(response.status, 200);
      const wire = Buffer.from(await readResponseBytesWithinLimit(response, { maxBytes: 20 * 1024 * 1024, label: "export source" }));
      const parsed = JSON.parse(wire);
      const runs = parsed.reportType === "comparison" ? [parsed.baseline, parsed.variant] : [parsed.run ?? parsed];
      assert.deepEqual(runs.map(run => (run.evidence?.requests ?? run.requests).length), witness.rows);
      const started = performance.now();
      const bundleResponse = await fetch(`${baseUrl}/api/reports/${witness.id}/pdf?download=bundle&sha256=${sha256(wire)}`, { signal: AbortSignal.timeout(90_000) });
      assert.equal(bundleResponse.status, 200, await (bundleResponse.ok ? Promise.resolve("") : readResponseTextWithinLimit(bundleResponse, { maxBytes: 16384, label: "export refusal" })));
      assert.match(bundleResponse.headers.get("content-type"), /application\/zip/);
      const bundle = Buffer.from(await readResponseBytesWithinLimit(bundleResponse, { maxBytes: 48 * 1024 * 1024, label: "document package" }));
      const zip = path.join(scratch, "document.zip"); await writeFile(zip, bundle);
      execFileSync("unzip", ["-t", zip]);
      const get = (file) => execFileSync("unzip", ["-p", zip, file], { maxBuffer: 48 * 1024 * 1024 });
      const pdf = get("report.pdf"), corrections = get("corrections.json");
      assert.deepEqual(get(`${witness.id}.json`), wire, "package changed the canonical JSON");
      const manifest = JSON.parse(get("export.json"));
      for (const file of ["report.pdf", `${witness.id}.json`, "corrections.json", `${witness.id}.provenance.json`]) {
        const digest = sha256(get(file));
        assert.equal(manifest.files[file].sha256, digest);
        assert.ok(get("SHA256SUMS").toString().includes(`${digest}  ${file}\n`));
      }
      if (outputDir) {
        await writeFile(path.join(outputDir, `${witness.id}.pdf`), pdf);
        await writeFile(path.join(outputDir, `${witness.id}.zip`), bundle);
      }
      const result = await verifyPdfArtifact(pdf, wire, corrections);
      if (witness.corrected) assert.match(result.text, /SBL-CORR-2026-001/);
      if (witness.capped) assert.match(result.text, /lower bounds/);
      const {text, ...summary} = result;
      results.push({id: witness.id, ...summary, milliseconds: Math.round(performance.now() - started), bytes: pdf.length});
      console.log(JSON.stringify(results.at(-1)));
    }
    await assertReportDownloadUi(baseUrl);
    const refusal = await fetch(`${baseUrl}/api/reports/${PDF_EXPORT_WITNESSES[0].id}/pdf?sha256=${"0".repeat(64)}`);
    assert.equal(refusal.status, 409, "a page/renderer evidence mismatch must refuse export");
    const correctionRefusal = await fetch(`${baseUrl}/api/reports/${PDF_EXPORT_WITNESSES[0].id}/pdf?correctionsSha256=${"0".repeat(64)}`);
    assert.equal(correctionRefusal.status, 409, "a page/renderer correction mismatch must refuse export");
    return results;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Exercise the ordinary controls, not only hand-constructed API URLs. */
export async function assertReportDownloadUi(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  const id = PDF_EXPORT_WITNESSES[3].id;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "sbl-export-ui-"));
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(`${baseUrl}/reports/${id}/`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Download PDF + evidence", exact: false }).waitFor();
    const packageHref = await page.getByRole("link", { name: "Download PDF + evidence", exact: false }).getAttribute("href");
    assert.match(packageHref, /sha256=[a-f0-9]{64}&download=bundle/);
    await page.getByRole("button", { name: "Explore full evidence" }).click();
    const jsonControl = page.getByRole("button", { name: /JSON/ });
    await jsonControl.waitFor();
    const downloadPromise = page.waitForEvent("download");
    await jsonControl.click();
    const downloaded = await downloadPromise;
    const zip = path.join(scratch, "ui-download.zip"); await downloaded.saveAs(zip);
    const actual = execFileSync("unzip", ["-p", zip, "report.json"]);
    const source = Buffer.from(await readResponseBytesWithinLimit(await fetch(`${baseUrl}/api/reports/${id}`, { signal: AbortSignal.timeout(30_000) }), { maxBytes: 20 * 1024 * 1024, label: "UI export source" }));
    assert.deepEqual(actual, source, "normal JSON download must preserve the PDF's exact source bytes");
    await page.goto(`${baseUrl}/reports/${id}/print/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.reportPrintReady === "true");
    const ids = await page.locator("main [id]").evaluateAll(elements => elements.map(element => element.id));
    assert.equal(new Set(ids).size, ids.length, `duplicate printable IDs: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`);
    assert.equal(await page.locator('[data-evidence-arm="baseline"] [data-request-row]').count(), 183);
    assert.equal(await page.locator('[data-evidence-arm="variant"] [data-request-row]').count(), 180);
  } finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await assertReportExportAcceptance(process.argv[2] ?? "http://127.0.0.1:3106", { outputDir: process.env.PDF_EXPORT_OUTPUT_DIR });
}

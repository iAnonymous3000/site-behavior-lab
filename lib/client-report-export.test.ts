import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reportWireForDownload } from "./client-report-export";
import { asLocalReport, readLoadedReport } from "./client-report-reader";

const runtime = { staticExport: true, liveApiBacked: false, basePath: "" };
const cases = ["20260730-748f7a920c0fdcf86c9a348a8660d395", "20260814-f47e5f1cd64def348acb6072ca7dae41"];
for (const id of cases) test(`managed ${id} download preserves independent source bytes including whitespace`, async () => {
  const wire = readFileSync(`public/reports/${id}.json`, "utf8");
  const read = await readLoadedReport(JSON.parse(wire));
  assert.ok(read.ok);
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, `/reports/${id}.json`);
    return new Response(wire);
  };
  try { assert.equal(await reportWireForDownload(read.loaded, runtime), wire); }
  finally { globalThis.fetch = previous; }
});

test("a changed managed source refuses export; a local import never fetches its claimed share", async () => {
  const wire = readFileSync(`public/reports/${cases[0]}.json`, "utf8");
  const read = await readLoadedReport(JSON.parse(wire)); assert.ok(read.ok);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":false,"error":"not found"}');
  try {
    await assert.rejects(reportWireForDownload(read.loaded, runtime), /does not match/);
    globalThis.fetch = async () => { throw new Error("An import must not fetch"); };
    const exported = JSON.parse(await reportWireForDownload(asLocalReport(read.loaded), runtime));
    assert.equal(exported.share.id, cases[0]);
  } finally { globalThis.fetch = previous; }
});

test("an already verified saved report remains exportable after the share goes offline", async () => {
  const wire = readFileSync(`public/reports/${cases[0]}.json`, "utf8");
  const read = await readLoadedReport(JSON.parse(wire)); assert.ok(read.ok);
  read.loaded.canonicalEvidence = { wire, sha256: createHash("sha256").update(wire).digest("hex") };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("share expired"); };
  try {
    assert.equal(await reportWireForDownload(read.loaded, runtime), wire);
    read.loaded.canonicalEvidence.wire = wire.trimEnd();
    await assert.rejects(reportWireForDownload(read.loaded, runtime), /integrity check/);
  } finally { globalThis.fetch = previous; }
});

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{
  readScannerFidelityResponse(response: Response, label: string): Promise<{ ok: boolean; report?: unknown; reason?: string }>;
}>;
const helpers = nativeImport(pathToFileURL(path.join(process.cwd(), "scripts/scanner-fidelity-response.mjs")).href);

test("fidelity refuses scanner 5xx rather than counting it as an unavailable target", async () => {
  const { readScannerFidelityResponse: read } = await helpers;
  for (const status of [500, 502, 503, 504]) {
    await assert.rejects(read(new Response("upstream failure", { status }), "scan"), /scanner endpoint failed/);
  }
  await assert.rejects(read(new Response("<html>not a report</html>"), "scan"));
});

test("fidelity keeps a site's failed visit report distinct from an admission refusal", async () => {
  const { readScannerFidelityResponse: read } = await helpers;
  const report = { run: { qualityFacts: { status: 403 }, quality: { run: { outcome: "failed" } } } };
  assert.deepEqual(await read(Response.json(report), "scan"), { ok: true, report });
  assert.deepEqual(await read(Response.json({ ok: false, error: "Host does not resolve." }, { status: 400 }), "scan"),
    { ok: false, reason: "Host does not resolve." });
});

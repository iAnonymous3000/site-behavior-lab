import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CANONICALIZATION_VERSION, canonicalJson, publicReportDigest } from "./canonical-json";

test("canonical JSON sorts keys, strips whitespace, and is stable across formatting", () => {
  const a = { b: 1, a: { d: [1, 2], c: "x" } };
  const b = { a: { c: "x", d: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[1,2]},"b":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  // A pretty-printed committed report and a compact R2 object digest identically.
  assert.equal(publicReportDigest(JSON.parse(JSON.stringify(a, null, 2))), publicReportDigest(b));
});

test("strings normalize to NFC so byte-different composed forms digest identically", () => {
  const composed = "café";
  const decomposed = "café";
  assert.notEqual(composed, decomposed);
  assert.equal(canonicalJson({ v: composed }), canonicalJson({ v: decomposed }));
});

test("undefined members are omitted; an absent and an undefined field digest identically", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test("non-JSON values are rejected loudly, never coerced", () => {
  assert.throws(() => canonicalJson({ v: Number.NaN }), /non-finite number/);
  assert.throws(() => canonicalJson({ v: [1, undefined, 2] }), /undefined array element/);
  assert.throws(() => canonicalJson({ v: () => 1 }), /unsupported function/);
});

test("the canonicalization version is pinned; changing the rules must change it", () => {
  assert.equal(CANONICALIZATION_VERSION, "canon-v1");
  // A frozen digest of a fixed value. Every committed provenance sidecar
  // carries a publicDigest produced by these exact rules, so a silent change
  // to the canonical form would orphan them; this literal fails first.
  assert.equal(
    publicReportDigest({ reportType: "single", schemaVersion: 1 }),
    "982655edf95cbd97825f20ad2f1fbd8b5ba9b299498fa248e5c6248d81810362"
  );
  assert.equal(
    publicReportDigest({ reportType: "single", schemaVersion: 1 }),
    publicReportDigest({ schemaVersion: 1, reportType: "single" })
  );
  assert.equal(canonicalJson({ z: true, a: null }), '{"a":null,"z":true}');
});

test("exactly one module defines the canonicalizer", async () => {
  // This repository's recurring defect is one contract restated in two files,
  // each with its own passing tests. A second canonicalJson existed in
  // lib/scan-report-v2-fingerprints.ts and silently disagreed on non-finite
  // numbers and undefined array elements, either of which digests two
  // different states identically. Keep the definition singular.
  const roots = ["lib", "scripts", "cloudflare", "app"];
  const definition = /(?:export\s+)?(?:async\s+)?function\s+canonicalJson\b|(?:const|let|var)\s+canonicalJson\s*=/;
  const definingFiles: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        if (definition.test(await readFile(entryPath, "utf8"))) definingFiles.push(entryPath);
      }
    }
  };
  for (const root of roots) await walk(path.join(process.cwd(), root));
  assert.deepEqual(
    definingFiles.map((file) => path.relative(process.cwd(), file)).sort(),
    ["lib/canonical-json.ts"]
  );
});

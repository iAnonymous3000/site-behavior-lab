#!/usr/bin/env node

// Three fresh-process samples of the complete managed corpus read. Compilation
// and result fingerprinting sit outside the measured interval. This benchmark
// does not cache admissions or substitute for any test or release gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const require = createRequire(import.meta.url);

if (process.argv[2] === "--sample") {
  const { listStaticReportBundles } = require(path.join(root, "dist/schema/lib/static-report-files.js"));
  const started = performance.now();
  const bundles = await listStaticReportBundles(root);
  const elapsedMs = performance.now() - started;
  const digest = createHash("sha256");
  for (const { id, stored } of bundles) digest.update(id).update(JSON.stringify(stored));
  console.log(JSON.stringify({ node: process.version, count: bundles.length, elapsedMs, digest: digest.digest("hex") }));
} else {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/benchmark-report-corpus.mjs");
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.schema.json"], {
    cwd: root, stdio: "inherit"
  });
  const samples = Array.from({ length: 3 }, () => JSON.parse(execFileSync(process.execPath, [script, "--sample"], {
    cwd: root, encoding: "utf8"
  })));
  if (samples.some((sample) => sample.count !== samples[0].count || sample.digest !== samples[0].digest)) {
    throw new Error("Corpus results changed between samples; the measurements are not comparable.");
  }
  console.log(JSON.stringify({
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "",
    samples,
    medianMs: samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)[1]
  }, null, 2));
}

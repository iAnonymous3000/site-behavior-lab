#!/usr/bin/env node

// Thin launcher for the DRY-RUN redaction-v2 remediation inventory
// (lib/remediation-inventory-cli.ts). Analysis lives in lib so it shares the
// canonical version-aware deep reader and the one sanitizer with everything
// else. Compiles the dedicated production artifact (tsconfig.schema.json ->
// dist/schema, RFC 10.3), never the .unit-test-dist test tree, then runs the
// compiled CLI with cwd at the repo root. Never writes to the corpus.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

if (process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY !== "1") {
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.schema.json"], { cwd: rootDir, stdio: "inherit" });
}
execFileSync(
  process.execPath,
  [path.join(rootDir, "dist", "schema", "lib", "remediation-inventory-cli.js"), ...process.argv.slice(2)],
  { cwd: rootDir, stdio: "inherit" }
);

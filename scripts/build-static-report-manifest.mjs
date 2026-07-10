#!/usr/bin/env node

// Thin launcher for the TypeScript manifest builder (lib/static-report-manifest-cli.ts).
// The build logic lives in lib so it shares the canonical version-aware deep
// reader with the app instead of duplicating report recognition (and silently
// zero-coercing malformed metrics) in build-time JS. Compiles the dedicated
// production artifact (tsconfig.schema.json -> dist/schema, RFC 10.3), never
// the .unit-test-dist test tree, then runs the compiled CLI with cwd at the
// repo root.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

execFileSync(process.execPath, [tsc, "-p", "tsconfig.schema.json"], { cwd: rootDir, stdio: "inherit" });
execFileSync(process.execPath, [path.join(rootDir, "dist", "schema", "lib", "static-report-manifest-cli.js")], {
  cwd: rootDir,
  stdio: "inherit"
});

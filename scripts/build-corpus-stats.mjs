#!/usr/bin/env node

// Thin launcher for the TypeScript corpus-stats builder (lib/corpus-stats-builder-cli.ts).
// The build logic lives in lib so it shares the canonical version-aware deep
// reader with the app instead of duplicating report recognition (and silently
// zero-coercing malformed metrics into the percentile distribution) in
// build-time JS. Compiles with the same tsconfig the unit tests use, then
// runs the compiled CLI.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

execFileSync(process.execPath, [tsc, "-p", "tsconfig.test.json"], { cwd: rootDir, stdio: "inherit" });
execFileSync(process.execPath, [path.join(rootDir, ".unit-test-dist", "lib", "corpus-stats-builder-cli.js")], {
  cwd: rootDir,
  stdio: "inherit"
});

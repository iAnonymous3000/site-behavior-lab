#!/usr/bin/env node

// Thin launcher for the TypeScript retention pruner (lib/prune-static-reports-cli.ts).
// The retention logic lives in lib so it shares the canonical version-aware
// deep reader with the app instead of hand-parsing committed JSON; a file the
// reader cannot read is never deleted. Compiles the dedicated production
// artifact (tsconfig.schema.json -> dist/schema, RFC 10.3), never the
// .unit-test-dist test tree, then runs the compiled CLI with cwd at the repo
// root.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

// An orchestrator that already built dist/schema for the whole run sets the
// env flag so repeated invocations skip the recompile.
if (process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY !== "1") {
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.schema.json"], { cwd: rootDir, stdio: "inherit" });
}
execFileSync(process.execPath, [path.join(rootDir, "dist", "schema", "lib", "prune-static-reports-cli.js")], {
  cwd: rootDir,
  stdio: "inherit"
});

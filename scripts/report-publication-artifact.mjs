#!/usr/bin/env node

// Thin launcher for the bounded data-only acquisition/publisher handoff. The
// canonical validation lives in TypeScript and is compiled into dist/schema;
// orchestrators that already built that artifact set the shared readiness flag.

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
  [path.join(rootDir, "dist", "schema", "lib", "report-publication-artifact-cli.js"), ...process.argv.slice(2)],
  { cwd: rootDir, stdio: "inherit" }
);

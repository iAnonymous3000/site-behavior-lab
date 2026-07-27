#!/usr/bin/env node

// One launcher for every consumer of the dist/schema production artifact
// (tsconfig.schema.json, RFC 10.3), so the "skip the compile when an
// orchestrator already built it" rule is written once.
//
// The npm scripts used to spell `tsc -p tsconfig.schema.json && node dist/...`
// inline, which no env flag can suppress. The hottest caller is
// scripts/run-ci-scan.mjs, which runs the remediation check once PER SITE and
// sets SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY expressly to prevent that
// recompile, so a full featured refresh paid for one whole schema build per
// scanned site while believing it had already skipped them.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [target, ...forwarded] = process.argv.slice(2);

// Exact names only. This runs with the repo's own privileges, so the target is
// never assembled from a caller-supplied path.
const TARGETS = {
  "aggregate-v2-shadow": ["dist", "schema", "lib", "aggregate-v2-shadow-cli.js"],
  "corpus-neutrality": ["dist", "schema", "lib", "corpus-neutrality-cli.js"],
  "corrections-ledger-history": ["dist", "schema", "lib", "corrections-ledger-history-cli.js"],
  "remediate-reports": ["dist", "schema", "lib", "remediate-reports-cli.js"],
  "toolchain-canary": ["scripts", "toolchain-canary.mjs"],
  "verify-v2-shadow": ["dist", "schema", "lib", "verify-v2-shadow-cli.js"]
};

const relative = Object.prototype.hasOwnProperty.call(TARGETS, target ?? "") ? TARGETS[target] : undefined;
if (!relative) {
  console.error(`Unknown schema CLI "${target ?? ""}". Known: ${Object.keys(TARGETS).sort().join(", ")}.`);
  process.exit(1);
}

// Surface the child's own exit code and nothing else. execFileSync throws a
// spawn object on failure, and printing that in place of the CLI's message
// turns a readable refusal into noise while still failing the job.
function runOrExit(args) {
  try {
    execFileSync(process.execPath, args, { cwd: rootDir, stdio: "inherit" });
  } catch (error) {
    process.exit(typeof error?.status === "number" ? error.status : 1);
  }
}

// An orchestrator that already built dist/schema for the whole run sets the
// env flag so repeated invocations skip the recompile.
if (process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY !== "1") {
  runOrExit([path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.schema.json"]);
}

runOrExit([path.join(rootDir, ...relative), ...forwarded]);

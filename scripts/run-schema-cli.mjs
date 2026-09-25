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
import { requireStaticReportPruningAllowed } from "./measurement-freeze-retention-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [target, ...forwarded] = process.argv.slice(2);

// Exact names only. This runs with the repo's own privileges, so the target is
// never assembled from a caller-supplied path.
const TARGETS = {
  "aggregate-v2-shadow": ["dist", "schema", "lib", "aggregate-v2-shadow-cli.js"],
  "brave-snapshot-adoption": ["dist", "schema", "lib", "brave-snapshot-adoption-cli.js"],
  "calibration-acquire": ["scripts", "calibration-study-acquire.mjs"],
  "calibration-assemble": ["scripts", "calibration-study-assemble.mjs"],
  "calibration-finalize": ["scripts", "calibration-study-finalize.mjs"],
  "calibration-preflight": ["scripts", "calibration-study-preflight.mjs"],
  "calibration-producer-test": ["scripts", "calibration-study-lib.test.mjs"],
  "calibration-scaffold": ["scripts", "calibration-study-scaffold.mjs"],
  "corpus-neutrality": ["dist", "schema", "lib", "corpus-neutrality-cli.js"],
  "corrections-ledger-history": ["dist", "schema", "lib", "corrections-ledger-history-cli.js"],
  "operator-evidence-container-licensing": [
    "scripts",
    "build-container-image-licensing-evidence.mjs"
  ],
  "operator-evidence-egress": ["scripts", "build-egress-backstop-evidence.mjs"],
  "operator-evidence-log-retention": [
    "scripts",
    "build-log-retention-evidence.mjs"
  ],
  "operator-evidence-staging-teardown": [
    "scripts",
    "capture-staging-teardown.mjs"
  ],
  "operator-evidence-verify": ["scripts", "verify-operator-evidence.mjs"],
  "operator-evidence-waf": ["scripts", "capture-waf-ceilings.mjs"],
  // The readiness evaluator re-derives the calibration-policy disposition
  // through the compiled contract, and release.yml runs it right after
  // `npm ci`, where no dist/schema exists yet.
  "release-readiness": ["scripts", "release-readiness.mjs"],
  // The operator-evidence canonicalizer (scripts/operator-evidence-common.mjs)
  // and the runner-receipt one (scripts/scanner-fidelity-study-lib.mjs) load
  // dist/schema/lib/canonical-json.js lazily and fall back to whatever tree
  // exists. The release-attestation-scaffold,
  // release-governance-verify-selection, runner-expected-environment and
  // staging-teardown-targets commands reach one of them, so they build it from
  // this checkout rather than trust an older build.
  "release-attestation-scaffold": ["scripts", "release-attestation-scaffold.mjs"],
  "release-governance-verify-selection": [
    "scripts",
    "verify-release-governance-selection.mjs"
  ],
  "release-tag-governance-capture": [
    "scripts",
    "capture-release-tag-governance.mjs"
  ],
  "runner-destruction-evidence": [
    "scripts",
    "runner-destruction-evidence.mjs"
  ],
  "runner-expected-environment": [
    "scripts",
    "controlled-runner-expected-environment.mjs"
  ],
  "staging-teardown-targets": [
    "scripts",
    "staging-teardown-target-manifest.mjs"
  ],
  "publication-transparency-log": ["dist", "schema", "lib", "publication-transparency-log-cli.js"],
  "transparency-log-anchor": ["dist", "schema", "lib", "transparency-log-anchor-cli.js"],
  "remediate-reports": ["dist", "schema", "lib", "remediate-reports-cli.js"],
  "toolchain-canary": ["scripts", "toolchain-canary.mjs"],
  "verify-published-report": ["dist", "schema", "lib", "verify-published-report-cli.js"],
  "verify-v2-shadow": ["dist", "schema", "lib", "verify-v2-shadow-cli.js"]
};

const relative = Object.prototype.hasOwnProperty.call(TARGETS, target ?? "") ? TARGETS[target] : undefined;
if (!relative) {
  console.error(`Unknown schema CLI "${target ?? ""}". Known: ${Object.keys(TARGETS).sort().join(", ")}.`);
  process.exit(1);
}

// A privacy replacement deletes a committed report pair, so it answers to the
// pruner's freeze guard, before compilation and before any report is read.
// The CLI refuses every spelling of the mode except this exact token.
if (target === "remediate-reports" && forwarded.includes("--privacy-replace")) {
  try {
    requireStaticReportPruningAllowed(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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
if (
  target === "calibration-acquire" &&
  process.env.SITE_BEHAVIOR_LAB_CALIBRATION_DIST_READY !== "1"
) {
  runOrExit([
    path.join(rootDir, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.calibration.json"
  ]);
}

runOrExit([path.join(rootDir, ...relative), ...forwarded]);

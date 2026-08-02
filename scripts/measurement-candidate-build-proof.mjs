#!/usr/bin/env node

// Trusted host precheck for Git-less Next/Docker build contexts. Stdout is
// either empty (no binding exists yet) or one base64url proof. Diagnostics and
// verification failures go to stderr/nonzero so command substitution cannot
// accidentally pass prose as build authority.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindingPath = path.join(
  rootDir,
  "research",
  "measurement-candidate-binding.json"
);

if (process.argv.length !== 2) {
  throw new Error("measurement-candidate-build-proof accepts no arguments");
}

if (!existsSync(bindingPath)) process.exit(0);

execFileSync(
  path.join(rootDir, "node_modules", "typescript", "bin", "tsc"),
  ["-p", "tsconfig.schema.json", "--pretty", "false"],
  {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "inherit"]
  }
);

const requireFromHere = createRequire(import.meta.url);
const bindingModule = requireFromHere(
  path.join(rootDir, "dist", "schema", "lib", "measurement-candidate-binding.js")
);
const binding = bindingModule.verifiedMeasurementCandidateBinding(rootDir);
if (!binding) throw new Error("measurement candidate binding disappeared during host verification");
process.stdout.write(
  bindingModule.verifiedMeasurementCandidateBuildProof(binding)
);

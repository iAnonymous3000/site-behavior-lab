#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseGovernanceSelection } from "./release-governance-selection-lib.mjs";

function usage() {
  return [
    "Usage: node scripts/verify-release-governance-selection.mjs",
    "  --commit <full-lowercase-sha>",
    "  --receipt-sha256 <lowercase-sha256>"
  ].join(" ");
}

function parseArgs(argv) {
  const allowed = new Set(["--commit", "--receipt-sha256"]);
  const values = {};
  if (argv.length !== allowed.size * 2) throw new Error(usage());
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.length < 1) {
      throw new Error(usage());
    }
    if (Object.hasOwn(values, flag)) throw new Error(`${flag} may appear once`);
    values[flag] = value;
  }
  return values;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const verified = verifyReleaseGovernanceSelection({
    rootDir,
    commit: options["--commit"],
    receiptSha256: options["--receipt-sha256"]
  });
  console.log(
    `Verified ${verified.relativePath} at ${verified.commit}; capturedAt=${verified.capturedAt}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkContainerPackageReviewLedger,
  syncContainerPackageReviewLedger
} from "./container-image-package-reviews-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let mode = null;
  let inventoryPath = null;
  let ledgerPath = path.join(rootDir, "CONTAINER_IMAGE_PACKAGE_REVIEWS.json");
  let ledgerPathProvided = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--sync" || argument === "--check") {
      if (mode !== null) throw new Error("Exactly one of --sync or --check is required");
      mode = argument;
      continue;
    }
    if (argument !== "--inventory" && argument !== "--ledger") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--inventory") {
      if (inventoryPath !== null) throw new Error("--inventory may only be provided once");
      inventoryPath = path.resolve(value);
    } else {
      if (ledgerPathProvided) throw new Error("--ledger may only be provided once");
      ledgerPath = path.resolve(value);
      ledgerPathProvided = true;
    }
    index += 1;
  }
  if (mode === null) throw new Error("Exactly one of --sync or --check is required");
  if (inventoryPath === null) throw new Error("--inventory is required");
  return { mode, inventoryPath, ledgerPath };
}

function readJson(filePath, label, { optional = false } = {}) {
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    if (optional && error && typeof error === "object" && error.code === "ENOENT") return null;
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventory = readJson(options.inventoryPath, "container package inventory");
  const ledger = readJson(options.ledgerPath, "container package review ledger", {
    optional: options.mode === "--sync"
  });

  if (options.mode === "--sync") {
    const result = syncContainerPackageReviewLedger(inventory, ledger);
    writeFileSync(options.ledgerPath, `${JSON.stringify(result.ledger, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    console.log(
      `Container package review ledger synchronized: ${result.added.length} added, ${result.reset.length} reset to unreviewed, ${result.removed.length} removed, ${result.ledger.reviews.length} total.`
    );
    return;
  }

  const verdict = checkContainerPackageReviewLedger(inventory, ledger);
  if (verdict.summary) {
    console.log(
      `Container OS-package reviews: ${verdict.summary.reviewed}/${verdict.summary.total} reviewed (${verdict.summary.unreviewed} unreviewed).`
    );
  }
  if (!verdict.ok) {
    for (const problem of verdict.problems) {
      console.log(`::error title=Container package review ledger::${problem}`);
    }
    console.log(
      "Run: npm run supply-chain:container-reviews:sync -- --inventory <canonical-inventory.json>"
    );
    process.exitCode = 1;
    return;
  }
  if (!verdict.complete) {
    console.log(
      "::warning title=Container package legal review incomplete::Every observed OS-package row is tracked, but one or more rows remain unreviewed."
    );
  }
  console.log("Container package review ledger exactly matches the observed inventory.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Container package review ledger::${message}`);
  }
  process.exitCode = 1;
}

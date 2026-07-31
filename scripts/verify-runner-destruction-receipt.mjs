#!/usr/bin/env node
// Verify controlled-runner destruction receipts. Pass one or more receipt
// JSON paths (or a directory such as research/runner-receipts/); exits 0 only
// when every receipt is complete and internally consistent. A verified
// receipt's canonical digest is printed so workflow logs can pin it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { verifyRunnerDestructionReceipt } from "./runner-receipt-lib.mjs";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/verify-runner-destruction-receipt.mjs <receipt.json|directory>...");
  process.exit(1);
}

const files = [];
for (const target of targets) {
  const stats = statSync(target);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(target).sort()) {
      if (entry.endsWith(".json")) files.push(path.join(target, entry));
    }
  } else {
    files.push(target);
  }
}
if (files.length === 0) {
  console.error("No receipt files found.");
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  const result = verifyRunnerDestructionReceipt(receipt);
  if (result.ok) {
    console.log(`PASS ${file} digest ${result.receiptDigest}`);
  } else {
    failures += 1;
    console.log(`FAIL ${file}`);
    for (const issue of result.issues) console.log(`  - ${issue}`);
  }
}
console.log(`${files.length - failures}/${files.length} receipts verified`);
process.exit(failures === 0 ? 0 : 1);

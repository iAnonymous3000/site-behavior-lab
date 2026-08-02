#!/usr/bin/env node
// Verify controlled-runner destruction receipts. Pass one or more receipt
// JSON paths (or a directory such as research/runner-receipts/); exits 0 only
// when every receipt is complete and internally consistent. A verified
// receipt's canonical digest is printed so workflow logs can pin it.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseCanonicalRunnerDestructionReceiptBytes,
  runnerDestructionReceiptSetIssues,
  verifyRunnerDestructionReceipt,
  verifyRunnerDestructionReceiptSet
} from "./runner-receipt-lib.mjs";

const MAX_RECEIPT_BYTES = 256 * 1024;
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/verify-runner-destruction-receipt.mjs <receipt.json|directory>...");
  process.exit(1);
}

const files = [];
for (const target of targets) {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    console.error(
      `FAIL ${target}: ${error instanceof Error ? error.message : "could not inspect target"}`
    );
    process.exit(1);
  }
  if (stats.isSymbolicLink()) {
    console.error(`FAIL ${target}: receipt targets must not be symbolic links.`);
    process.exit(1);
  }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(target).sort()) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(target, entry);
      if (lstatSync(file).isSymbolicLink()) {
        console.error(`FAIL ${file}: receipt files must not be symbolic links.`);
        process.exit(1);
      }
      files.push(file);
    }
  } else if (stats.isFile()) {
    files.push(target);
  } else {
    console.error(`FAIL ${target}: receipt targets must be regular files or directories.`);
    process.exit(1);
  }
}
if (files.length === 0) {
  console.error("No receipt files found.");
  process.exit(1);
}

let failures = 0;
const receipts = [];
for (const file of files) {
  let receipt;
  try {
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_RECEIPT_BYTES) {
      throw new Error(`must be a nonempty regular file no larger than ${MAX_RECEIPT_BYTES} bytes`);
    }
    receipt = parseCanonicalRunnerDestructionReceiptBytes(
      readFileSync(file),
      file
    );
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${file}`);
    console.log(`  - ${error instanceof Error ? error.message : "could not read receipt"}`);
    continue;
  }
  receipts.push(receipt);
  const result = verifyRunnerDestructionReceipt(receipt);
  if (result.ok) {
    console.log(`PASS ${file} digest ${result.receiptDigest}`);
  } else {
    failures += 1;
    console.log(`FAIL ${file}`);
    for (const issue of result.issues) console.log(`  - ${issue}`);
  }
}
const setIssues = failures === 0
  ? runnerDestructionReceiptSetIssues(receipts)
  : ["receipt set cannot verify while one or more receipt files are unreadable"];
if (setIssues.length > 0) {
  console.log("FAIL receipt set");
  for (const issue of setIssues) console.log(`  - ${issue}`);
}
console.log(
  `${files.length - failures}/${files.length} receipts individually verified` +
    (setIssues.length === 0 ? "; receipt set verified" : "; receipt set failed")
);
if (failures === 0 && setIssues.length === 0) {
  const setVerdict = verifyRunnerDestructionReceiptSet(receipts);
  console.log(`environment sha256:${setVerdict.environmentDigest}`);
}
process.exit(failures === 0 && setIssues.length === 0 ? 0 : 1);

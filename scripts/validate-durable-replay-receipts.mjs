#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import {
  durableReplayReceiptSetDigest,
  durableReplayReceiptSetIssues
} from "./durable-replay-receipt-lib.mjs";

const MAX_RECEIPT_BYTES = 256 * 1024;
const [expectedDeploymentSha, leaseExpiryPath, lostResolvePath, ...extra] = process.argv.slice(2);
if (!expectedDeploymentSha || !leaseExpiryPath || !lostResolvePath || extra.length > 0) {
  console.error(
    "Usage: node scripts/validate-durable-replay-receipts.mjs " +
      "<expected-40-character-sha> <lease-expiry-receipt.json> <lost-resolve-receipt.json>"
  );
  process.exit(1);
}

function readReceipt(receiptPath) {
  const stat = statSync(receiptPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error(`${receiptPath} must be a nonempty regular receipt no larger than ${MAX_RECEIPT_BYTES} bytes.`);
  }
  return JSON.parse(readFileSync(receiptPath, "utf8"));
}

let receipts;
try {
  receipts = [readReceipt(leaseExpiryPath), readReceipt(lostResolvePath)];
} catch (error) {
  console.error(`FAIL Could not read durable replay receipts (${error instanceof Error ? error.message : "unknown error"}).`);
  process.exit(1);
}

const issues = durableReplayReceiptSetIssues(receipts, expectedDeploymentSha);
if (issues.length > 0) {
  for (const issue of issues) console.error(`FAIL ${issue}`);
  process.exit(1);
}

console.log(
  `PASS lease-expiry and lost-resolve receipts bind the same exact staging deployment (${expectedDeploymentSha}).`
);
console.log(`receipt-set sha256:${durableReplayReceiptSetDigest(receipts, expectedDeploymentSha)}`);

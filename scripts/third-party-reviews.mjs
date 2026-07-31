#!/usr/bin/env node
// Maintain THIRD_PARTY_REVIEWS.json against THIRD_PARTY_INVENTORY.json.
//
//   --sync   create missing rows (unreviewed), drop rows whose item left the
//            inventory, preserve every reviewed row verbatim
//   --check  fail when ledger and inventory drift or a reviewed row is
//            incomplete; prints review coverage per ecosystem either way
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkReviewLedger, syncReviewLedger } from "./third-party-reviews-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(rootDir, "THIRD_PARTY_INVENTORY.json");
const ledgerPath = path.join(rootDir, "THIRD_PARTY_REVIEWS.json");

const mode = process.argv[2];
if (mode !== "--sync" && mode !== "--check") {
  console.error("Usage: node scripts/third-party-reviews.mjs --sync|--check");
  process.exit(1);
}

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
let ledger = null;
try {
  ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch {
  ledger = null;
}

if (mode === "--sync") {
  const result = syncReviewLedger(inventory, ledger);
  writeFileSync(ledgerPath, `${JSON.stringify(result.ledger, null, 2)}\n`);
  console.log(
    `Review ledger synced: ${result.added.length} row(s) added, ${result.removed.length} removed, ${result.ledger.reviews.length} total.`
  );
  process.exit(0);
}

const verdict = checkReviewLedger(inventory, ledger);
if (verdict.summary) {
  for (const [ecosystem, bucket] of Object.entries(verdict.summary)) {
    console.log(
      `${ecosystem}: ${bucket.reviewed}/${bucket.total} reviewed (${bucket.unreviewedRuntime} runtime items unreviewed)`
    );
  }
}
if (!verdict.ok) {
  for (const problem of verdict.problems) {
    console.log(`::error title=Third-party review ledger::${problem}`);
  }
  console.log("Run: node scripts/third-party-reviews.mjs --sync");
  process.exit(1);
}
console.log("Review ledger is in sync with the inventory.");

#!/usr/bin/env node

// Write research/ops-receipts/durable-enable-transition.json from an evidence
// bundle of authenticated API responses and committed bytes.
//
//   node scripts/durable-transition-receipt.mjs --evidence <bundle.json>
//
// The bundle carries the exact GitHub Actions attempt responses for the CI,
// promotion, and production-health runs, the captured production-health
// payload, and the operator's secret-presence observation. A workflow step
// authenticates and captures those; this command never holds a credential and
// makes no network call, so the derivation is auditable against an immutable
// transcript.
//
// Writes exclusively: an existing receipt is never overwritten, because a
// second write would silently replace evidence the candidate may already pin.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  TRANSITION_RECEIPT_PATH,
  buildDurableEnableTransitionReceipt,
  canonicalTransitionReceiptText,
  replayReceiptSetDigest,
  transitionReceiptSha256
} from "./durable-transition-receipt-lib.mjs";

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const rootDir = process.cwd();

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--evidence") {
  console.error("Usage: node scripts/durable-transition-receipt.mjs --evidence <bundle.json>");
  process.exit(1);
}

function readJson(file, label) {
  const bytes = readFileSync(file);
  if (bytes.length === 0 || bytes.length > MAX_BUNDLE_BYTES) {
    throw new Error(`${label} must be a nonempty file no larger than ${MAX_BUNDLE_BYTES} bytes`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

try {
  const bundle = readJson(path.resolve(args[1]), "evidence bundle");

  // The replay digest is recomputed from the committed receipt bytes rather
  // than copied from the bundle: it is the one field an operator could
  // otherwise restate incorrectly without any check noticing.
  const deploymentCommit = bundle.replay?.deploymentCommit;
  if (typeof deploymentCommit !== "string") {
    throw new Error("evidence bundle must name replay.deploymentCommit");
  }
  const receiptBytesByMode = {};
  for (const mode of ["lease-expiry", "lost-resolve"]) {
    receiptBytesByMode[mode] = readFileSync(
      path.join(rootDir, "research", "ops-receipts", "durable-replay", `${deploymentCommit}-${mode}.json`)
    );
  }
  const receiptSetDigest = replayReceiptSetDigest(receiptBytesByMode);
  if (bundle.replay?.receiptSetDigest && bundle.replay.receiptSetDigest !== receiptSetDigest) {
    throw new Error(
      `evidence bundle claims replay receipt-set digest ${bundle.replay.receiptSetDigest}, ` +
        `but the committed receipts hash to ${receiptSetDigest}`
    );
  }

  const receipt = buildDurableEnableTransitionReceipt({
    fromCommit: bundle.transition?.fromCommit,
    toCommit: bundle.transition?.toCommit,
    replay: { ...bundle.replay, receiptSetDigest },
    secrets: bundle.secrets,
    changeControl: bundle.changeControl,
    ciRun: bundle.ciRun,
    promotionRun: bundle.promotionRun,
    productionHealthRun: bundle.productionHealthRun,
    productionHealthPayload: bundle.productionHealthPayload,
    recordedAt: bundle.recordedAt
  });

  const text = canonicalTransitionReceiptText(receipt);
  const destination = path.join(rootDir, TRANSITION_RECEIPT_PATH);
  // "wx": refuse rather than replace. A transition happens once.
  writeFileSync(destination, text, { flag: "wx" });

  console.log(`Wrote ${TRANSITION_RECEIPT_PATH}`);
  console.log(`  sha256 ${transitionReceiptSha256(receipt)}`);
  console.log(`  transition ${receipt.transition.fromCommit} -> ${receipt.transition.toCommit}`);
  console.log(`  replay receipt set ${receipt.replay.receiptSetDigest}`);
  console.log(
    `  chronology ${receipt.replay.evidenceCapturedAt} .. ${receipt.recordedAt}`
  );
  console.log("");
  console.log("  Pin this sha256 in the candidate binding's durablePrerequisite.transition.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("EEXIST")) {
    console.error(
      `FAIL ${TRANSITION_RECEIPT_PATH} already exists. A transition is recorded once; ` +
        "remove it deliberately if a previous attempt was abandoned."
    );
  } else {
    console.error(`FAIL ${message}`);
  }
  process.exit(1);
}

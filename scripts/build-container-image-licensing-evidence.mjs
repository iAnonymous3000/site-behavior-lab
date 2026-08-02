#!/usr/bin/env node

import {
  buildContainerImageLicensingEvidence,
  serializeContainerImageLicensingEvidence
} from "./container-image-licensing-evidence-lib.mjs";
import {
  readBoundedNoFollowUtf8,
  writeExclusive
} from "./operator-evidence-common.mjs";

function parseArgs(argv) {
  const required = new Set([
    "--inventory",
    "--review-ledger",
    "--captured-at",
    "--repository-root",
    "--output"
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!required.has(flag)) throw new Error(`unknown argument ${flag}`);
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires one value`);
    }
    if (Object.hasOwn(options, flag)) throw new Error(`${flag} may only be supplied once`);
    options[flag] = value;
  }
  for (const flag of required) {
    if (!Object.hasOwn(options, flag)) throw new Error(`${flag} is required`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [inventoryBytes, ledgerBytes] = await Promise.all([
    readBoundedNoFollowUtf8(
      options["--inventory"],
      "--inventory",
      32 * 1024 * 1024
    ),
    readBoundedNoFollowUtf8(
      options["--review-ledger"],
      "--review-ledger",
      32 * 1024 * 1024
    )
  ]);
  let inventory;
  let ledger;
  try {
    inventory = JSON.parse(inventoryBytes);
    ledger = JSON.parse(ledgerBytes);
  } catch {
    throw new Error("inventory and review ledger must both be valid JSON");
  }
  const receipt = buildContainerImageLicensingEvidence({
    inventory,
    ledger,
    inventoryBytes,
    ledgerBytes,
    capturedAt: options["--captured-at"],
    repositoryRoot: options["--repository-root"]
  });
  await writeExclusive(
    options["--output"],
    serializeContainerImageLicensingEvidence(receipt, {
      inventory,
      ledger,
      inventoryBytes,
      ledgerBytes,
      repositoryRoot: options["--repository-root"]
    })
  );
  console.log(
    `Container licensing evidence recorded; image sha256:${receipt.containerImageDigest}, inventory sha256:${receipt.packageInventoryDigest}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node

import path from "node:path";
import {
  parseCanonicalEvidence,
  readBoundedNoFollowUtf8,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import {
  WAF_CEILING_EVIDENCE_KIND,
  validateWafCeilingEvidence
} from "./waf-ceiling-evidence-lib.mjs";
import {
  LOG_RETENTION_EVIDENCE_KIND,
  validateLogRetentionEvidence
} from "./log-retention-evidence-lib.mjs";
import {
  EGRESS_BACKSTOP_EVIDENCE_KIND,
  validateEgressBackstopEvidence
} from "./egress-backstop-evidence-lib.mjs";
import {
  STAGING_TEARDOWN_EVIDENCE_KIND,
  validateStagingTeardownEvidence
} from "./staging-teardown-evidence-lib.mjs";
import {
  CONTAINER_LICENSING_EVIDENCE_KIND,
  CONTAINER_PACKAGE_INVENTORY_PATH,
  CONTAINER_PACKAGE_REVIEW_LEDGER_PATH,
  validateContainerImageLicensingEvidence
} from "./container-image-licensing-evidence-lib.mjs";

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--evidence") {
    throw new Error(
      "Usage: node scripts/verify-operator-evidence.mjs --evidence <canonical-receipt.json>"
    );
  }
  return argv[1];
}

async function containerDependencies(rootDir) {
  const [inventoryBytes, ledgerBytes] = await Promise.all([
    readBoundedNoFollowUtf8(
      path.join(rootDir, CONTAINER_PACKAGE_INVENTORY_PATH),
      CONTAINER_PACKAGE_INVENTORY_PATH,
      32 * 1024 * 1024
    ),
    readBoundedNoFollowUtf8(
      path.join(rootDir, CONTAINER_PACKAGE_REVIEW_LEDGER_PATH),
      CONTAINER_PACKAGE_REVIEW_LEDGER_PATH,
      32 * 1024 * 1024
    )
  ]);
  return {
    inventory: JSON.parse(inventoryBytes),
    ledger: JSON.parse(ledgerBytes),
    inventoryBytes,
    ledgerBytes
  };
}

async function main() {
  const evidencePath = parseArgs(process.argv.slice(2));
  const bytes = await readBoundedNoFollowUtf8(
    evidencePath,
    "--evidence",
    32 * 1024 * 1024
  );
  const value = parseCanonicalEvidence(bytes, evidencePath);
  let verdict;
  switch (value.artifactKind) {
    case WAF_CEILING_EVIDENCE_KIND:
      verdict = validateWafCeilingEvidence(value);
      break;
    case LOG_RETENTION_EVIDENCE_KIND:
      verdict = validateLogRetentionEvidence(value);
      break;
    case EGRESS_BACKSTOP_EVIDENCE_KIND:
      verdict = validateEgressBackstopEvidence(value);
      break;
    case STAGING_TEARDOWN_EVIDENCE_KIND:
      verdict = validateStagingTeardownEvidence(value);
      break;
    case CONTAINER_LICENSING_EVIDENCE_KIND:
      verdict = validateContainerImageLicensingEvidence(
        value,
        await containerDependencies(process.cwd())
      );
      break;
    default:
      throw new Error(`unsupported operator evidence kind ${String(value.artifactKind)}`);
  }
  if (!verdict.ok) {
    throw new Error(verdict.problems.join("; "));
  }
  console.log(
    `${value.artifactKind} verified; receipt sha256:${sha256Bytes(bytes)}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

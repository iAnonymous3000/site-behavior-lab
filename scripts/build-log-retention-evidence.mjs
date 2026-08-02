#!/usr/bin/env node

import {
  buildLogRetentionEvidence,
  LOG_PROVIDER_EXPORT_MAX_BYTES,
  serializeLogRetentionEvidence
} from "./log-retention-evidence-lib.mjs";
import {
  readBoundedNoFollowUtf8,
  writeExclusive
} from "./operator-evidence-common.mjs";

function parseArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--capture" ||
    argv[2] !== "--output"
  ) {
    throw new Error(
      "Usage: node scripts/build-log-retention-evidence.mjs --capture <provider-export.json> --output <new-file>"
    );
  }
  return { capture: argv[1], output: argv[3] };
}

async function main() {
  const { capture, output } = parseArgs(process.argv.slice(2));
  const sourceBytes = await readBoundedNoFollowUtf8(
    capture,
    "--capture",
    LOG_PROVIDER_EXPORT_MAX_BYTES
  );
  const receipt = buildLogRetentionEvidence({ sourceBytes });
  await writeExclusive(output, serializeLogRetentionEvidence(receipt));
  console.log(
    `Redacted log-retention evidence recorded; policy sha256:${receipt.logPolicyDigest}; provider export ${receipt.sourceArtifact.digest}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

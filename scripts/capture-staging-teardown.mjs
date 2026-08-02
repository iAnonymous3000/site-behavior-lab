#!/usr/bin/env node

import {
  buildStagingTeardownEvidence,
  serializeStagingTeardownEvidence,
  stagingTeardownDryRunPlan,
  STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES
} from "./staging-teardown-evidence-lib.mjs";
import {
  readBoundedNoFollowUtf8,
  serializeCanonicalEvidence,
  writeExclusive
} from "./operator-evidence-common.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/capture-staging-teardown.mjs --dry-run",
    "  node scripts/capture-staging-teardown.mjs --capture <sanitized-provider-transcript.json> --output <new-file>",
    "",
    "This command is data-only. It never loads provider adapters, reads",
    "credentials, performs network operations, or deletes staging resources."
  ].join("\n");
}

function parseCaptureArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--capture" ||
    argv[2] !== "--output"
  ) {
    throw new Error(usage());
  }
  return {
    capture: argv[1],
    output: argv[3]
  };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--dry-run") {
    process.stdout.write(
      serializeCanonicalEvidence({
        destructive: false,
        operations: stagingTeardownDryRunPlan()
      })
    );
    return;
  }
  const options = parseCaptureArgs(process.argv.slice(2));
  const sourceBytes = await readBoundedNoFollowUtf8(
    options.capture,
    "--capture",
    STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES
  );
  const receipt = buildStagingTeardownEvidence({ sourceBytes });
  await writeExclusive(
    options.output,
    serializeStagingTeardownEvidence(receipt)
  );
  console.log(
    `Staging teardown transcript recorded; inventory sha256:${receipt.teardownInventoryDigest}; source ${receipt.sourceArtifact.digest}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

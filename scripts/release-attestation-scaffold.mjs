#!/usr/bin/env node
import {
  releaseAttestationScaffold,
  releaseDurableTargetDeviationApprovalScaffold
} from "./release-readiness-lib.mjs";

const args = process.argv.slice(2);
const deviationMode =
  args.length === 5 &&
  args[0] === "--gate" &&
  args[1] === "durable-soak" &&
  args[2] === "--target-deviation-approval" &&
  args[3] === "--candidate-commit";
const attestationMode =
  args.length === 2 &&
  args[0] === "--gate" &&
  typeof args[1] === "string" &&
  args[1].length > 0;
if (!attestationMode && !deviationMode) {
  console.error(
    [
      "Usage: node scripts/release-attestation-scaffold.mjs --gate <gate-id>",
      "   or: node scripts/release-attestation-scaffold.mjs --gate durable-soak --target-deviation-approval --candidate-commit <40-sha>"
    ].join("\n")
  );
  process.exit(1);
}

try {
  const scaffold = deviationMode
    ? releaseDurableTargetDeviationApprovalScaffold(args[4])
    : releaseAttestationScaffold(args[1]);
  process.stdout.write(`${JSON.stringify(scaffold, null, 2)}\n`);
} catch (error) {
  console.error(
    `Refusing to scaffold an unbound release attestation: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
}

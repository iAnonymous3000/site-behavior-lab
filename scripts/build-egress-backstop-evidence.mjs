#!/usr/bin/env node

import {
  buildEgressBackstopEvidence,
  EGRESS_POLICY_EXPORT_MAX_BYTES,
  EGRESS_PROBE_TRANSCRIPT_MAX_BYTES,
  serializeEgressBackstopEvidence
} from "./egress-backstop-evidence-lib.mjs";
import {
  exactKeys,
  readBoundedNoFollowUtf8,
  writeExclusive
} from "./operator-evidence-common.mjs";

function parseArgs(argv) {
  const required = new Set([
    "--binding",
    "--network-policy-export",
    "--failure-probe-transcript",
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
  const [bindingBytes, networkPolicySourceBytes, failureModeProbeSourceBytes] =
    await Promise.all([
      readBoundedNoFollowUtf8(options["--binding"], "--binding", 64 * 1024),
      readBoundedNoFollowUtf8(
        options["--network-policy-export"],
        "--network-policy-export",
        EGRESS_POLICY_EXPORT_MAX_BYTES
      ),
      readBoundedNoFollowUtf8(
        options["--failure-probe-transcript"],
        "--failure-probe-transcript",
        EGRESS_PROBE_TRANSCRIPT_MAX_BYTES
      )
    ]);
  let binding;
  try {
    binding = JSON.parse(bindingBytes);
  } catch {
    throw new Error("--binding must identify valid JSON candidate metadata");
  }
  const bindingProblems = [];
  if (
    !exactKeys(
      binding,
      ["candidateCommit", "deploymentCommit"],
      "--binding",
      bindingProblems
    )
  ) {
    throw new Error(bindingProblems.join("; "));
  }
  const receipt = buildEgressBackstopEvidence({
    ...binding,
    networkPolicySourceBytes,
    failureModeProbeSourceBytes
  });
  await writeExclusive(
    options["--output"],
    serializeEgressBackstopEvidence(receipt)
  );
  console.log(
    `Egress backstop evidence recorded; network policy sha256:${receipt.networkPolicyDigest}; source exports ${receipt.sourceArtifacts.networkPolicyExport.digest} and ${receipt.sourceArtifacts.failureProbeTranscript.digest}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

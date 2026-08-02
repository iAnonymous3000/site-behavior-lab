#!/usr/bin/env node

// Provider-authenticated controlled-runner destruction evidence.
//
// No controlled-runner VM provider has been selected yet. This command
// therefore exposes verification of an already canonical artifact, but its
// capture mode fails closed after checking the intended secret/configuration
// boundary. It must not gain a generic "read JSON from this URL/file" path:
// the selected provider needs a repo-owned, exact API adapter that authenticates
// the response and passes only normalized facts to the canonical library.

import {
  readBoundedNoFollowUtf8
} from "./operator-evidence-common.mjs";
import {
  parseRunnerDestructionEvidence,
  RUNNER_DESTRUCTION_PROVIDER_RESPONSE_MAX_BYTES,
  runnerDestructionEvidenceDigest
} from "./runner-destruction-evidence-lib.mjs";

const CAPTURE_ENV = [
  "RUNNER_DESTRUCTION_PROVIDER_KIND",
  "RUNNER_DESTRUCTION_PROVIDER_API_URL",
  "RUNNER_DESTRUCTION_PROVIDER_API_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "COLLECTION_RUN_ID",
  "COLLECTION_RUN_ATTEMPT"
];

function usage() {
  return [
    "Usage:",
    "  node scripts/runner-destruction-evidence.mjs --capture --output <new-file>",
    "  node scripts/runner-destruction-evidence.mjs --verify <destruction-evidence.json>",
    "",
    "Capture remains unavailable until one controlled-runner provider and its",
    "exact authenticated API client are reviewed and committed."
  ].join("\n");
}

function requiredCaptureEnvironment(env) {
  const missing = CAPTURE_ENV.filter(
    (name) =>
      typeof env[name] !== "string" ||
      env[name].length === 0 ||
      env[name].trim() !== env[name]
  );
  if (missing.length > 0) {
    throw new Error(
      `runner destruction capture requires non-empty scoped environment: ${missing.join(", ")}`
    );
  }
  if (env.GITHUB_REPOSITORY !== "iAnonymous3000/site-behavior-lab") {
    throw new Error(
      "GITHUB_REPOSITORY must be exactly iAnonymous3000/site-behavior-lab"
    );
  }
  if (!/^[1-9][0-9]{0,19}$/.test(env.COLLECTION_RUN_ID)) {
    throw new Error("COLLECTION_RUN_ID must be a positive decimal Actions run id");
  }
  const runId = Number(env.COLLECTION_RUN_ID);
  if (!Number.isSafeInteger(runId)) {
    throw new Error("COLLECTION_RUN_ID must be a positive safe integer");
  }
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(env.COLLECTION_RUN_ATTEMPT)) {
    throw new Error(
      "COLLECTION_RUN_ATTEMPT must be an integer from 1 through 100"
    );
  }
  let providerUrl;
  try {
    providerUrl = new URL(env.RUNNER_DESTRUCTION_PROVIDER_API_URL);
  } catch {
    throw new Error(
      "RUNNER_DESTRUCTION_PROVIDER_API_URL must be a canonical HTTPS API URL"
    );
  }
  if (
    providerUrl.protocol !== "https:" ||
    providerUrl.username !== "" ||
    providerUrl.password !== "" ||
    providerUrl.hash !== "" ||
    providerUrl.toString() !== env.RUNNER_DESTRUCTION_PROVIDER_API_URL
  ) {
    throw new Error(
      "RUNNER_DESTRUCTION_PROVIDER_API_URL must be a canonical HTTPS API URL without credentials or a fragment"
    );
  }
  return Object.freeze({
    providerKind: env.RUNNER_DESTRUCTION_PROVIDER_KIND,
    providerUrl: providerUrl.toString(),
    runId,
    runAttempt: Number(env.COLLECTION_RUN_ATTEMPT)
  });
}

async function verifyArtifact(inputPath) {
  const bytes = await readBoundedNoFollowUtf8(
    inputPath,
    "--verify",
    RUNNER_DESTRUCTION_PROVIDER_RESPONSE_MAX_BYTES
  );
  const evidence = parseRunnerDestructionEvidence(bytes);
  console.log(
    `verified ${evidence.collection.runId}/${evidence.collection.runAttempt} destruction evidence sha256:${runnerDestructionEvidenceDigest(evidence)}`
  );
}

function refuseUnselectedProvider(env) {
  const configuration = requiredCaptureEnvironment(env);
  throw new Error(
    `no reviewed controlled-runner provider adapter is committed for ${configuration.providerKind}; select the runner VM provider and add its exact authenticated API client before collecting release evidence`
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--verify") {
    await verifyArtifact(args[1]);
    return;
  }
  if (
    args.length === 3 &&
    args[0] === "--capture" &&
    args[1] === "--output"
  ) {
    // The output argument is intentionally not opened before the provider
    // gate. A failed/secretless dispatch cannot leave a plausible artifact.
    refuseUnselectedProvider(process.env);
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import {
  buildWafCeilingEvidence,
  executeWafCeilingProbe,
  PRODUCTION_WAF_ORIGIN,
  serializeWafCeilingEvidence,
  serializeWafProbeTranscript,
  WAF_PROBE_TRANSCRIPT_MAX_BYTES,
  WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES
} from "./waf-ceiling-evidence-lib.mjs";
import {
  isRecord,
  readBoundedNoFollowUtf8,
  resolveTrustedOutputPath,
  writeExclusive
} from "./operator-evidence-common.mjs";

const PROBE_FLAGS = new Set([
  "--base-url",
  "--candidate-commit",
  "--deployment-commit",
  "--rule-policy",
  "--output"
]);
const FINALIZE_FLAGS = new Set([
  "--probe-transcript",
  "--provider-events-export",
  "--output"
]);
const MAX_RUNTIME_REQUEST_MATERIAL_BYTES = 64 * 1024;

async function preflightCreateOnlyOutput(outputPath) {
  const trustedOutput = await resolveTrustedOutputPath(outputPath);
  try {
    await lstat(trustedOutput);
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      error.code === "ENOENT"
    ) {
      return trustedOutput;
    }
    throw error;
  }
  throw new Error(
    "--output must not already exist as a file, directory, or symbolic link"
  );
}

function parseArgs(argv) {
  const mode = argv[0];
  const flags =
    mode === "--probe"
      ? PROBE_FLAGS
      : mode === "--finalize"
        ? FINALIZE_FLAGS
        : null;
  if (flags === null) {
    throw new Error(
      "first argument must be --probe or --finalize"
    );
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flags.has(flag)) throw new Error(`unknown argument ${flag}`);
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires one value`);
    }
    if (Object.hasOwn(options, flag)) throw new Error(`${flag} may only be supplied once`);
    options[flag] = value;
  }
  for (const flag of flags) {
    if (!Object.hasOwn(options, flag)) throw new Error(`${flag} is required`);
  }
  return { mode, options };
}

function secretHeaders(name) {
  const source = process.env[name];
  if (typeof source !== "string" || source.length === 0) return {};
  if (Buffer.byteLength(source, "utf8") > MAX_RUNTIME_REQUEST_MATERIAL_BYTES) {
    throw new Error(`${name} exceeds the runtime request-material limit`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${name} must contain a JSON object`);
  }
  if (
    !isRecord(value) ||
    Object.entries(value).some(
      ([key, entry]) =>
        typeof key !== "string" ||
        key.length === 0 ||
        typeof entry !== "string"
    )
  ) {
    throw new Error(`${name} must contain only string header values`);
  }
  return value;
}

async function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));
  if (mode === "--finalize") {
    const trustedOutput = await preflightCreateOnlyOutput(options["--output"]);
    const [probeTranscriptBytes, providerEventsExportBytes] =
      await Promise.all([
        readBoundedNoFollowUtf8(
          options["--probe-transcript"],
          "--probe-transcript",
          WAF_PROBE_TRANSCRIPT_MAX_BYTES
        ),
        readBoundedNoFollowUtf8(
          options["--provider-events-export"],
          "--provider-events-export",
          WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES
        )
      ]);
    const receipt = buildWafCeilingEvidence({
      probeTranscriptBytes,
      providerEventsExportBytes
    });
    await writeExclusive(
      trustedOutput,
      serializeWafCeilingEvidence(receipt)
    );
    console.log(
      `WAF ceiling evidence finalized; rule policy sha256:${receipt.wafRulesDigest}; provider event readback sha256:${receipt.providerEventReadbackDigest}; provider export ${receipt.sourceArtifacts.providerEventsExport.digest}`
    );
    return;
  }
  if (options["--base-url"] !== PRODUCTION_WAF_ORIGIN) {
    throw new Error(
      `--base-url must be exactly ${PRODUCTION_WAF_ORIGIN}; canonical WAF evidence cannot target another origin`
    );
  }
  const trustedOutput = await preflightCreateOnlyOutput(options["--output"]);
  const policySource = await readBoundedNoFollowUtf8(
    options["--rule-policy"],
    "--rule-policy",
    64 * 1024
  );
  let rulePolicy;
  try {
    rulePolicy = JSON.parse(policySource);
  } catch {
    throw new Error("--rule-policy must identify a valid JSON file");
  }
  if (process.env.SBL_WAF_POST_BODY !== undefined) {
    throw new Error(
      "SBL_WAF_POST_BODY is not accepted; the POST probe uses the fixed invalid body bound into the receipt"
    );
  }
  const transcript = await executeWafCeilingProbe({
    baseUrl: options["--base-url"],
    candidateCommit: options["--candidate-commit"],
    deploymentCommit: options["--deployment-commit"],
    rulePolicy,
    requestMaterial: {
      get: { headers: secretHeaders("SBL_WAF_GET_HEADERS_JSON") },
      post: {
        headers: secretHeaders("SBL_WAF_POST_HEADERS_JSON")
      }
    }
  });
  await writeExclusive(
    trustedOutput,
    serializeWafProbeTranscript(transcript)
  );
  console.log(
    `WAF probe transcript recorded; rule policy sha256:${transcript.wafRulesDigest}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

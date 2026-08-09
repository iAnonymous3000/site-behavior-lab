#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { parseStrictJson } from "../lib/strict-json.ts";
import {
  isRecord,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";
import {
  STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES,
  stagingTeardownTargetManifestTemplate,
  validateStagingTeardownTargetManifest
} from "./staging-teardown-provider-adapters.mjs";
import { assertStagingTeardownProjectionNfc } from "./staging-teardown-target-projections.mjs";
import {
  captureStagingTeardownTargetManifest,
  stagingTeardownTargetCaptureCredentialsFromEnvironment
} from "./staging-teardown-target-capture-lib.mjs";
import {
  assertMode0700OutputParent,
  readMode0600SecretFile
} from "./staging-teardown-target-private-io.mjs";
import { runStagingTeardownTargetCaptureCommand } from "./staging-teardown-target-capture-command.mjs";

const MAX_BYTES = STAGING_TEARDOWN_TARGET_MANIFEST_MAX_BYTES;

function usage() {
  return [
    "Usage:",
    "  node scripts/staging-teardown-target-manifest.mjs --template --candidate-commit <sha> --account-id <id> --zone-id <id> --output <new-file>",
    "  node scripts/staging-teardown-target-manifest.mjs --capture --candidate-commit <sha> --account-id <id> --zone-id <id> --private-dir <new-directory> --output <new-file>",
    "  node scripts/staging-teardown-target-manifest.mjs --seal --candidate-commit <sha> --account-id <id> --zone-id <id> --input <draft-file> --output <new-file>",
    "  node scripts/staging-teardown-target-manifest.mjs --verify --candidate-commit <sha> --account-id <id> --zone-id <id> --input <sealed-file>"
  ].join("\n");
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function options(args, names) {
  requireValue(args.length === names.size * 2, usage());
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    requireValue(names.has(flag), `unknown argument ${String(flag)}`);
    requireValue(typeof value === "string" && value.length >= 1 && !value.startsWith("--"), `${flag} requires one value`);
    requireValue(!Object.hasOwn(result, flag), `${flag} may be supplied once`);
    result[flag] = value;
  }
  for (const name of names) requireValue(Object.hasOwn(result, name), `${name} is required`);
  return result;
}

function readStrictRegularJson(inputPath) {
  const absolute = path.resolve(inputPath);
  const info = lstatSync(absolute);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600,
    "target-manifest input must be a regular mode-0600 non-symbolic-link file"
  );
  if (typeof process.getuid === "function") {
    requireValue(info.uid === process.getuid(), "target-manifest input must be owned by the current user");
  }
  requireValue(info.size >= 2 && info.size <= MAX_BYTES, `target-manifest input must contain 2 through ${MAX_BYTES} bytes`);
  const bytes = readFileSync(absolute);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("target-manifest input must be valid UTF-8");
  }
  try {
    return parseStrictJson(text, MAX_BYTES);
  } catch {
    throw new Error("target-manifest input must be strict JSON without duplicate keys or excessive nesting");
  }
}

function normalizeDraft(value, candidateCommit, accountId, zoneId) {
  requireValue(isRecord(value), "target-manifest draft must be an object");
  assertStagingTeardownProjectionNfc(value, "staging teardown target-manifest draft");
  requireValue(isRecord(value.cloudflare), "target-manifest draft.cloudflare must be an object");
  value.schemaVersion = 1;
  value.artifactKind = "site-behavior-staging-teardown-exact-targets";
  value.stagingSourceCommit = candidateCommit;
  value.cloudflare.accountId = accountId;
  value.cloudflare.zoneId = zoneId;
  if (Array.isArray(value.cloudflare.credentialSets)) {
    for (const credential of value.cloudflare.credentialSets) {
      if (!isRecord(credential)) continue;
      if (credential.expectedPresent === true && Array.isArray(credential.expectedPolicies)) {
        credential.expectedPolicySha256 = sha256Bytes(
          serializeCanonicalEvidence(credential.expectedPolicies)
        );
      } else if (credential.expectedPresent === false) {
        credential.expectedPolicySha256 = null;
      }
    }
  }
  return validateStagingTeardownTargetManifest(value, candidateCommit);
}

function writeNew(outputPath, manifest) {
  const resolved = assertMode0700OutputParent(outputPath);
  requireValue(!existsSync(resolved), "target-manifest output must not already exist");
  const bytes = serializeCanonicalEvidence(manifest);
  requireValue(Buffer.byteLength(bytes, "utf8") <= MAX_BYTES, `sealed target manifest exceeds ${MAX_BYTES} bytes`);
  writeFileSync(resolved, bytes, { flag: "wx", mode: 0o600 });
  const info = lstatSync(resolved);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600,
    "target-manifest output was not created as a mode-0600 regular file"
  );
  return { path: resolved, sha256: sha256Bytes(bytes) };
}

function common(input) {
  const candidateCommit = input["--candidate-commit"];
  const accountId = input["--account-id"];
  const zoneId = input["--zone-id"];
  requireValue(/^[0-9a-f]{40}$/.test(candidateCommit), "--candidate-commit must be a full lowercase commit");
  requireValue(/^[0-9a-f]{32}$/.test(accountId), "--account-id must be 32 lowercase hex");
  requireValue(/^[0-9a-f]{32}$/.test(zoneId), "--zone-id must be 32 lowercase hex");
  return { candidateCommit, accountId, zoneId };
}

async function capture(input, values) {
  const credentials = stagingTeardownTargetCaptureCredentialsFromEnvironment(
    process.env,
    { readSecretFile: readMode0600SecretFile }
  );
  return runStagingTeardownTargetCaptureCommand({
    privateDirectory: input["--private-dir"],
    capture: (persistRaw) => captureStagingTeardownTargetManifest({
      stagingSourceCommit: values.candidateCommit,
      accountId: values.accountId,
      zoneId: values.zoneId,
      credentials,
      persistRaw
    }),
    writeOutput: (captured) => writeNew(input["--output"], captured.manifest)
  });
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode === "--template") {
    const input = options(args, new Set(["--candidate-commit", "--account-id", "--zone-id", "--output"]));
    const values = common(input);
    const manifest = stagingTeardownTargetManifestTemplate({
      stagingSourceCommit: values.candidateCommit,
      accountId: values.accountId,
      zoneId: values.zoneId
    });
    process.stdout.write(`${JSON.stringify(writeNew(input["--output"], manifest))}\n`);
    return;
  }
  if (mode === "--capture") {
    const input = options(args, new Set([
      "--candidate-commit", "--account-id", "--zone-id", "--private-dir", "--output"
    ]));
    const values = common(input);
    process.stdout.write(`${JSON.stringify(await capture(input, values))}\n`);
    return;
  }
  if (mode === "--seal") {
    const input = options(args, new Set(["--candidate-commit", "--account-id", "--zone-id", "--input", "--output"]));
    const values = common(input);
    const manifest = normalizeDraft(
      readStrictRegularJson(input["--input"]),
      values.candidateCommit,
      values.accountId,
      values.zoneId
    );
    process.stdout.write(`${JSON.stringify(writeNew(input["--output"], manifest))}\n`);
    return;
  }
  if (mode === "--verify") {
    const input = options(args, new Set(["--candidate-commit", "--account-id", "--zone-id", "--input"]));
    const values = common(input);
    const manifest = validateStagingTeardownTargetManifest(
      readStrictRegularJson(input["--input"]),
      values.candidateCommit
    );
    requireValue(manifest.cloudflare.accountId === values.accountId, "sealed target accountId does not match --account-id");
    requireValue(manifest.cloudflare.zoneId === values.zoneId, "sealed target zoneId does not match --zone-id");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sha256: sha256Bytes(serializeCanonicalEvidence(manifest))
    })}\n`);
    return;
  }
  throw new Error(usage());
}

const requestedMode = process.argv[2];
main().catch((error) => {
  console.error(
    requestedMode === "--capture"
      ? "staging teardown target capture failed"
      : error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});

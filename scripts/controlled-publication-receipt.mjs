#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createControlledPublicationArchive,
  verifyControlledPublicationDirectory
} from "./controlled-publication-receipt-lib.mjs";

const CREATE_KEYS = new Set([
  "--archive",
  "--artifact-digest",
  "--artifact-id",
  "--artifact-name",
  "--checkout-root",
  "--metadata",
  "--output-dir",
  "--run-id",
  "--source-commit"
]);
const VERIFY_KEYS = new Set([
  "--archive-digest",
  "--artifact-id",
  "--checkout-root",
  "--directory",
  "--run-attempt",
  "--run-id",
  "--source-commit"
]);

function usage() {
  return [
    "Usage:",
    "  controlled-publication-receipt.mjs --create --checkout-root ABS --metadata ABS --archive ABS --artifact-id ID --artifact-name NAME --artifact-digest SHA256 --run-id ID --source-commit SHA --output-dir ABS",
    "  controlled-publication-receipt.mjs --verify --checkout-root ABS --directory ABS --run-id ID --run-attempt N --source-commit SHA [--artifact-id ID] [--archive-digest SHA256]"
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.length === 0) throw new Error(usage());
  const modeTokens = argv.filter(
    (argument) => argument === "--create" || argument === "--verify"
  );
  if (modeTokens.length !== 1) {
    throw new Error("choose exactly one of --create or --verify");
  }
  const mode = modeTokens[0];
  const allowed = mode === "--create" ? CREATE_KEYS : VERIFY_KEYS;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === mode) continue;
    if (!argument.startsWith("--") || !allowed.has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return { mode, values };
}

function required(values, key) {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required argument: ${key}`);
  }
  return value;
}

function absolute(values, key) {
  const value = required(values, key);
  if (!path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return value;
}

function main() {
  const { mode, values } = parseArguments(process.argv.slice(2));
  if (mode === "--create") {
    const result = createControlledPublicationArchive({
      checkoutRoot: absolute(values, "--checkout-root"),
      metadataPath: absolute(values, "--metadata"),
      archivePath: absolute(values, "--archive"),
      artifactId: required(values, "--artifact-id"),
      artifactName: required(values, "--artifact-name"),
      artifactDigest: required(values, "--artifact-digest"),
      runId: required(values, "--run-id"),
      sourceCommit: required(values, "--source-commit"),
      outputDirectory: absolute(values, "--output-dir")
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        relativePath: result.relativePath,
        receiptSha256: result.receiptSha256,
        manifestSha256: result.manifestSha256
      })}\n`
    );
    return;
  }

  const result = verifyControlledPublicationDirectory({
    checkoutRoot: absolute(values, "--checkout-root"),
    directory: absolute(values, "--directory"),
    runId: required(values, "--run-id"),
    runAttempt: required(values, "--run-attempt"),
    sourceCommit: required(values, "--source-commit"),
    artifactId: values.get("--artifact-id"),
    archiveSha256: values.get("--archive-digest")
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      receiptSha256: result.receiptSha256,
      manifestSha256: result.manifestSha256
    })}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Controlled publication receipt failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exitCode = 1;
}

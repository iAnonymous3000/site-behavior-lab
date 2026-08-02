#!/usr/bin/env node

// Private staging-provider responses must never enter a public Actions
// artifact or evidence PR. Capture remains closed until one reviewed provider
// adapter can fetch, normalize, and destroy those bytes inside this hosted job.

import path from "node:path";
import {
  verifyStagingTeardownHostedSafeDirectory
} from "./staging-teardown-hosted-capture-lib.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/staging-teardown-hosted-capture.mjs --capture --output-dir <new-directory>",
    "  node scripts/staging-teardown-hosted-capture.mjs --verify --directory <directory>"
  ].join("\n");
}

function required(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function captureRefusal() {
  required("STAGING_TEARDOWN_PROVIDER_KIND");
  required("STAGING_TEARDOWN_PROVIDER_API_TOKEN");
  throw new Error(
    "no reviewed multi-provider staging teardown capture adapter is committed; refusing caller-authored transcripts and digests"
  );
}

function verifyDirectory(directory) {
  const verified = verifyStagingTeardownHostedSafeDirectory(directory);
  process.stdout.write(
    `${JSON.stringify(verified)}\n`
  );
}

const args = process.argv.slice(2);
try {
  if (
    args.length === 3 &&
    args[0] === "--verify" &&
    args[1] === "--directory"
  ) {
    verifyDirectory(path.resolve(args[2]));
  } else if (
    args.length === 3 &&
    args[0] === "--capture" &&
    args[1] === "--output-dir"
  ) {
    captureRefusal();
  } else {
    throw new Error(usage());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

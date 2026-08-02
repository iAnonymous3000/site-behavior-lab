#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { serializeCanonicalEvidence } from "./operator-evidence-common.mjs";
import { serializeWafCeilingEvidence } from "./waf-ceiling-evidence-lib.mjs";
import {
  captureHostedWafEvidence,
  requiredHostedWafEnvironment,
  verifyWafHostedSafeDirectory
} from "./waf-hosted-capture-lib.mjs";

const RAW_NAME = /^[a-z0-9][a-z0-9.-]{0,99}\.json$/;

function usage() {
  return [
    "Usage:",
    "  node scripts/waf-hosted-capture.mjs --capture --candidate-commit <sha> --output-dir <new-directory> --private-dir <new-directory>",
    "  node scripts/waf-hosted-capture.mjs --verify --directory <directory>"
  ].join("\n");
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePairs(args, allowed) {
  requireValue(args.length % 2 === 0, usage());
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    requireValue(allowed.has(flag), `unknown argument ${String(flag)}`);
    requireValue(
      typeof value === "string" && value.length > 0 && !value.startsWith("--"),
      `${flag} requires one value`
    );
    requireValue(!Object.hasOwn(options, flag), `${flag} may only be supplied once`);
    options[flag] = value;
  }
  for (const flag of allowed) {
    requireValue(Object.hasOwn(options, flag), `${flag} is required`);
  }
  return options;
}

function trustedNewChild(target, trustedRoot, label) {
  requireValue(
    typeof trustedRoot === "string" && path.isAbsolute(trustedRoot),
    `${label} trusted root must be absolute`
  );
  const rootReal = realpathSync(trustedRoot);
  requireValue(
    rootReal === path.resolve(trustedRoot),
    `${label} trusted root must not be reached through a symbolic link`
  );
  const requested = path.resolve(target);
  const parent = path.dirname(requested);
  const parentReal = realpathSync(parent);
  requireValue(
    parentReal === parent,
    `${label} parent must not be reached through a symbolic link`
  );
  const resolved = path.join(parentReal, path.basename(requested));
  const relative = path.relative(rootReal, resolved);
  requireValue(
    relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `${label} must be a child of RUNNER_TEMP`
  );
  requireValue(
    !existsSync(resolved),
    `${label} must not already exist as a file, directory, or symbolic link`
  );
  return resolved;
}

function createPrivateSink(privateDirectory) {
  mkdirSync(privateDirectory, { recursive: false, mode: 0o700 });
  return async (name, bytes) => {
    requireValue(RAW_NAME.test(name), "private provider response name is invalid");
    requireValue(
      Buffer.isBuffer(bytes) || bytes instanceof Uint8Array,
      "private provider response must be exact bytes"
    );
    writeFileSync(path.join(privateDirectory, name), bytes, {
      flag: "wx",
      mode: 0o600
    });
  };
}

function destroyPrivateDirectory(privateDirectory) {
  requireValue(
    existsSync(privateDirectory) && lstatSync(privateDirectory).isDirectory(),
    "private provider response directory disappeared before destruction"
  );
  rmSync(privateDirectory, { recursive: true, force: false });
  requireValue(
    !existsSync(privateDirectory),
    "private provider response bytes were not destroyed"
  );
}

function writeSafeDirectory(outputDirectory, captured) {
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(
      path.join(outputDirectory, "receipt.json"),
      serializeWafCeilingEvidence(captured.receipt),
      { flag: "wx", mode: 0o600 }
    );
    writeFileSync(
      path.join(outputDirectory, "sanitized-provider-manifest.json"),
      serializeCanonicalEvidence(captured.manifest),
      { flag: "wx", mode: 0o600 }
    );
    return verifyWafHostedSafeDirectory(outputDirectory);
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function capture(options) {
  const environment = requiredHostedWafEnvironment(process.env);
  const candidateCommit = options["--candidate-commit"];
  requireValue(
    candidateCommit === environment.githubSha,
    "--candidate-commit must equal the exact trusted workflow GITHUB_SHA"
  );
  const runnerTemp = process.env.RUNNER_TEMP;
  requireValue(
    typeof runnerTemp === "string" && runnerTemp.length > 0,
    "RUNNER_TEMP is required"
  );
  const outputDirectory = trustedNewChild(
    options["--output-dir"],
    runnerTemp,
    "--output-dir"
  );
  const privateDirectory = trustedNewChild(
    options["--private-dir"],
    runnerTemp,
    "--private-dir"
  );
  requireValue(
    outputDirectory !== privateDirectory,
    "--output-dir and --private-dir must be distinct"
  );

  const persistRaw = createPrivateSink(privateDirectory);
  let captured;
  let captureError;
  try {
    captured = await captureHostedWafEvidence({
      candidateCommit,
      zoneId: environment.zoneId,
      rulesToken: environment.rulesToken,
      analyticsToken: environment.analyticsToken,
      persistRaw
    });
  } catch (error) {
    captureError = error;
  }
  let cleanupError;
  try {
    destroyPrivateDirectory(privateDirectory);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    throw new Error(
      `private provider response destruction failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`
    );
  }
  if (captureError) throw captureError;
  const result = writeSafeDirectory(outputDirectory, captured);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode === "--capture") {
    const options = parsePairs(
      args,
      new Set(["--candidate-commit", "--output-dir", "--private-dir"])
    );
    await capture(options);
    return;
  }
  if (mode === "--verify") {
    const options = parsePairs(args, new Set(["--directory"]));
    const result = verifyWafHostedSafeDirectory(
      path.resolve(options["--directory"])
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

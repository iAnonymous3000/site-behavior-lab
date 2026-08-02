#!/usr/bin/env node

import { constants } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import {
  buildContainerImagePackageInventory,
  serializeContainerImagePackageInventory
} from "./container-image-package-inventory-lib.mjs";

const REQUIRED_FLAGS = [
  "--trivy-report",
  "--container-evidence",
  "--source-commit",
  "--output"
];

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!REQUIRED_FLAGS.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (options.has(flag)) throw new Error(`${flag} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options.set(flag, value);
    index += 1;
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!options.has(flag)) throw new Error(`${flag} is required`);
  }
  return Object.fromEntries(options);
}

async function readJson(inputPath, label) {
  let source;
  try {
    source = await readFile(inputPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function writeExclusive(outputPath, serialized) {
  let handle;
  try {
    handle = await open(
      outputPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["EEXIST", "ELOOP", "EISDIR"].includes(error.code)
    ) {
      throw new Error("--output must not already exist as a file, directory, or symbolic link");
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("--output could not be created as a regular file");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [trivyReport, containerEvidence] = await Promise.all([
    readJson(options["--trivy-report"], "Trivy license report"),
    readJson(options["--container-evidence"], "container release evidence")
  ]);
  const inventory = buildContainerImagePackageInventory({
    trivyReport,
    containerEvidence,
    sourceCommit: options["--source-commit"]
  });
  await writeExclusive(
    options["--output"],
    serializeContainerImagePackageInventory(inventory)
  );
  console.log(
    `Container OS-package inventory recorded: ${inventory.summary.packageCount} packages, package set sha256:${inventory.packageSetDigest}.`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Container package inventory::${message}`);
  }
  process.exitCode = 1;
});

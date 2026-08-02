#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PLACEHOLDER = "__SITE_BEHAVIOR_LAB_BUILD_COMMIT__";
const MEASUREMENT_PROOF_PLACEHOLDER =
  "__SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF__";
const DEFAULT_CONFIG_FILENAME = "wrangler.container.jsonc";
const SAFE_CONFIG_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.jsonc$/;
const root = process.cwd();

function parseArgs(argv) {
  let check = false;
  let configFilename = DEFAULT_CONFIG_FILENAME;
  let sawConfig = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      if (check) throw new Error("--check may only be provided once.");
      check = true;
      continue;
    }
    if (arg === "--config") {
      if (sawConfig) throw new Error("--config may only be provided once.");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--config requires a repo-root .jsonc filename.");
      }
      configFilename = validateConfigFilename(value);
      sawConfig = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { check, configFilename };
}

function validateConfigFilename(filename) {
  if (
    !SAFE_CONFIG_FILENAME.test(filename) ||
    path.isAbsolute(filename) ||
    path.posix.basename(filename) !== filename ||
    path.win32.basename(filename) !== filename
  ) {
    throw new Error("--config must be a safe .jsonc filename located directly in the repository root.");
  }
  return filename;
}

function resolveBuildCommit({ requireClean }) {
  const localCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  })
    .trim()
    .toLowerCase();
  if (!FULL_SHA.test(localCommit)) {
    throw new Error("Could not derive a full lowercase Git SHA for the container build.");
  }

  const workersCommit = process.env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  if (workersCommit) {
    if (!FULL_SHA.test(workersCommit)) {
      throw new Error("WORKERS_CI_COMMIT_SHA is present but is not a full lowercase Git SHA.");
    }
    if (workersCommit !== localCommit) {
      throw new Error("WORKERS_CI_COMMIT_SHA does not match the checked-out Git HEAD.");
    }
  }

  if (requireClean) {
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }).trim();
    if (dirty) {
      throw new Error(
        "Container deployment provenance requires a clean Git worktree; commit the exact inputs before deploying."
      );
    }
  }
  return workersCommit ?? localCommit;
}

async function main() {
  const { check, configFilename } = parseArgs(process.argv.slice(2));
  const sourcePath = path.join(root, configFilename);
  const generatedPath = path.join(root, `wrangler.container.generated.${process.pid}.jsonc`);
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Container config must be a regular repo-root file: ${configFilename}`);
  }

  const commit = resolveBuildCommit({ requireClean: !check });
  const measurementCandidateProof = execFileSync(
    process.execPath,
    [path.join(root, "scripts", "measurement-candidate-build-proof.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  ).trim();
  const source = await readFile(sourcePath, "utf8");
  const occurrences = source.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one ${PLACEHOLDER} placeholder, found ${occurrences}.`);
  }
  const measurementProofOccurrences =
    source.split(MEASUREMENT_PROOF_PLACEHOLDER).length - 1;
  if (measurementProofOccurrences !== 1) {
    throw new Error(
      `Expected exactly one ${MEASUREMENT_PROOF_PLACEHOLDER} placeholder, found ${measurementProofOccurrences}.`
    );
  }

  try {
    await writeFile(
      generatedPath,
      source
        .replace(PLACEHOLDER, commit)
        .replace(MEASUREMENT_PROOF_PLACEHOLDER, measurementCandidateProof),
      { encoding: "utf8", mode: 0o600 }
    );
    if (check) {
      const generated = await readFile(generatedPath, "utf8");
      if (
        !generated.includes(`"SITE_BEHAVIOR_LAB_BUILD_COMMIT": "${commit}"`) ||
        !generated.includes(
          `"SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF": "${measurementCandidateProof}"`
        ) ||
        generated.includes(PLACEHOLDER) ||
        generated.includes(MEASUREMENT_PROOF_PLACEHOLDER)
      ) {
        throw new Error("Generated container config did not pin the selected build revision.");
      }
      console.log(
        configFilename === DEFAULT_CONFIG_FILENAME
          ? `Container deploy config pins ${commit}.`
          : `Container deploy config ${configFilename} pins ${commit}.`
      );
      return;
    }
    console.log(
      configFilename === DEFAULT_CONFIG_FILENAME
        ? `Deploying container build for ${commit}.`
        : `Deploying ${configFilename} for container build ${commit}.`
    );
    const result = spawnSync(process.execPath, [path.join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "-c", generatedPath], {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    await rm(generatedPath, { force: true });
  }
}

await main();

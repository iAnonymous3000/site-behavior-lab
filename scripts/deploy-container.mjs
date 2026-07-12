#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PLACEHOLDER = "__SITE_BEHAVIOR_LAB_BUILD_COMMIT__";
const root = process.cwd();
const sourcePath = path.join(root, "wrangler.container.jsonc");
const generatedPath = path.join(root, `wrangler.container.generated.${process.pid}.jsonc`);

function resolveBuildCommit() {
  const workersCommit = process.env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  if (workersCommit) {
    if (!FULL_SHA.test(workersCommit)) {
      throw new Error("WORKERS_CI_COMMIT_SHA is present but is not a full lowercase Git SHA.");
    }
    return workersCommit;
  }

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
  return localCommit;
}

async function main() {
  const commit = resolveBuildCommit();
  const source = await readFile(sourcePath, "utf8");
  const occurrences = source.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one ${PLACEHOLDER} placeholder, found ${occurrences}.`);
  }

  await writeFile(generatedPath, source.replace(PLACEHOLDER, commit), { encoding: "utf8", mode: 0o600 });
  try {
    if (process.argv.includes("--check")) {
      const generated = await readFile(generatedPath, "utf8");
      if (!generated.includes(`"SITE_BEHAVIOR_LAB_BUILD_COMMIT": "${commit}"`) || generated.includes(PLACEHOLDER)) {
        throw new Error("Generated container config did not pin the selected build revision.");
      }
      console.log(`Container deploy config pins ${commit}.`);
      return;
    }
    console.log(`Deploying container build for ${commit}.`);
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

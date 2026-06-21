#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(rootDir, ".next-pages-work");
const outDir = path.join(rootDir, "out");
const workOutDir = path.join(workDir, "out");
const nodeModulesDir = path.join(rootDir, "node_modules");
const staticReportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;

const skippedNames = new Set([
  ".DS_Store",
  ".git",
  ".next",
  ".next-pages-work",
  ".site-behavior-lab",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "playwright-report",
  "test-results",
  ".unit-test-dist"
]);

const serverOnlyAppDirs = [
  path.join(rootDir, "app", "api")
];

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldCopy(sourcePath) {
  const name = path.basename(sourcePath);
  if (sourcePath === outDir) return false;
  if (skippedNames.has(name)) return false;
  if (name.startsWith(".env") && name !== ".env.example") return false;
  return !serverOnlyAppDirs.some((serverDir) => isInside(sourcePath, serverDir));
}

async function copyTree(sourcePath, destinationPath) {
  if (!shouldCopy(sourcePath)) return;

  const stats = await lstat(sourcePath);
  if (stats.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(sourcePath);
    for (const entry of entries) {
      await copyTree(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }

  if (stats.isSymbolicLink()) {
    await symlink(await readlink(sourcePath), destinationPath);
    return;
  }

  if (stats.isFile()) {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with status ${code}`));
      }
    });
  });
}

async function staticReportCount(root) {
  const reportsDir = path.join(root, "public", "reports");

  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }

  return entries.filter((entry) => entry.isFile() && staticReportFilePattern.test(entry.name)).length;
}

async function main() {
  if (!existsSync(nodeModulesDir)) {
    throw new Error("node_modules is missing. Run npm ci or npm install before npm run build:pages.");
  }

  await rm(workDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  await copyTree(rootDir, workDir);
  await symlink(nodeModulesDir, path.join(workDir, "node_modules"), "dir");

  const nextBin = path.join(workDir, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");

  await runCommand(process.execPath, ["scripts/build-static-report-manifest.mjs"], {
    cwd: workDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1"
    }
  });

  await runCommand(process.execPath, ["scripts/build-corpus-stats.mjs"], {
    cwd: workDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1"
    }
  });

  if ((await staticReportCount(workDir)) === 0) {
    await rm(path.join(workDir, "app", "reports"), { recursive: true, force: true });
  }

  await runCommand(nextBin, ["build"], {
    cwd: workDir,
    env: {
      ...process.env,
      NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      SITE_BEHAVIOR_LAB_STATIC_EXPORT: "1"
    }
  });

  await copyTree(workOutDir, outDir);
  await writeFile(path.join(outDir, ".nojekyll"), "");

  if (process.env.KEEP_GITHUB_PAGES_WORKDIR !== "1") {
    await rm(workDir, { recursive: true, force: true });
  }

  console.log("GitHub Pages artifact written to out/.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

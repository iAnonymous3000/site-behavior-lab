#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeploymentReceipt, resolveExactStaticDeploymentCommit } from "./static-deployment-provenance.mjs";

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
const runtimeReportRouteFiles = [
  path.join("app", "reports", "[id]", "page.tsx"),
  path.join("app", "reports", "[id]", "opengraph-image.tsx"),
  path.join("app", "reports", "[id]", "twitter-image.tsx")
];
const runtimeReportRouteMode = 'export const dynamic = "force-dynamic";';
const staticReportRouteMode = 'export const dynamic = "force-static";';
const staticReportRouteImplementation = `${staticReportRouteMode}

export async function generateStaticParams() {
  const { listStaticReportIds } = await import("@/lib/static-report-files");
  const ids = await listStaticReportIds();
  return ids.map((id) => ({ id }));
}`;

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

async function copyTrackedTree(sourceRoot, destinationRoot) {
  // A clean status proves tracked/untracked Git inputs, but ignored local files
  // (including secret-shaped operator files) are intentionally absent from
  // that status. Stage only the files named by Git so the build tree is exactly
  // attributable to HEAD and cannot inherit ignored local state.
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: sourceRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const relativePaths = output.toString("utf8").split("\0").filter(Boolean);
  for (const relativePath of relativePaths) {
    const sourcePath = path.resolve(sourceRoot, relativePath);
    if (!isInside(sourcePath, sourceRoot)) {
      throw new Error(`Git returned an unsafe tracked path: ${relativePath}`);
    }
    await copyTree(sourcePath, path.resolve(destinationRoot, relativePath));
  }
}

async function prepareStaticReportRouteMode(destinationRoot) {
  // Runtime shares are expiry-bound and must be request-rendered. Pages has no
  // runtime store: its isolated, exact-HEAD worktree alone converts these three
  // copied routes to static generation for the committed public corpus. The
  // runtime source intentionally lacks generateStaticParams so Next cannot
  // classify an expiry-bound route as SSG.
  for (const relativePath of runtimeReportRouteFiles) {
    const routePath = path.join(destinationRoot, relativePath);
    const source = await readFile(routePath, "utf8");
    const occurrences = source.split(runtimeReportRouteMode).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Expected exactly one runtime report route-mode declaration in ${relativePath}; found ${occurrences}.`
      );
    }
    if (source.includes("export async function generateStaticParams")) {
      throw new Error(`Runtime report route unexpectedly exports static params: ${relativePath}`);
    }
    await writeFile(routePath, source.replace(runtimeReportRouteMode, staticReportRouteImplementation));
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
  // Resolve before deleting or copying anything. A commit SHA is exact source
  // provenance only when it matches this checkout and every copied Git input is
  // clean; dirty local builds must fail instead of publishing HEAD as a lie.
  const deployment = resolveExactStaticDeploymentCommit({ cwd: rootDir });

  if (!existsSync(nodeModulesDir)) {
    throw new Error("node_modules is missing. Run npm ci or npm install before npm run build:pages.");
  }

  await rm(workDir, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  await copyTrackedTree(rootDir, workDir);
  await prepareStaticReportRouteMode(workDir);
  await symlink(nodeModulesDir, path.join(workDir, "node_modules"), "dir");

  const nextBin = path.join(workDir, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");

  // Regenerate the ScanReport v2 schema + compiled validator artifact inside
  // the worktree: the copy above excludes dist/, and the published schema must
  // never go stale relative to the types (scan-report-v2-rfc.md 10.3).
  await runCommand(process.execPath, ["scripts/build-schema.mjs"], {
    cwd: workDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1"
    }
  });

  // Publication is fail-closed: every committed report must already be the
  // current sanitizer fixed point and have a matching provenance sidecar.
  // The remediation command owns the check; this build never invents a
  // fallback when the command or a sidecar is missing.
  await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "reports:remediate", "--", "--check"], {
    cwd: workDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY: "1"
    }
  });

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

  // Static Pages has no runtime health route, so publish the same exact source
  // provenance the container exposes. Production monitoring compares this
  // file and scanner health with the CI-gated `production` branch.
  // revisionCommittedAt is the COMMIT date, never the build clock: identical
  // for every rebuild of the same SHA, so the receipt stays byte-stable for
  // exact-SHA comparison. It lets the public status page distinguish "a new
  // revision is still rolling out to the slower surface" from "a deploy is
  // stuck", which a bare SHA mismatch cannot express.
  await writeFile(
    path.join(workDir, "public", "deployment.json"),
    `${JSON.stringify(buildDeploymentReceipt(deployment, { cwd: rootDir }), null, 2)}\n`
  );

  if ((await staticReportCount(workDir)) === 0) {
    await rm(path.join(workDir, "app", "reports"), { recursive: true, force: true });
  }

  await runCommand(nextBin, ["build"], {
    cwd: workDir,
    env: {
      ...process.env,
      NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      // Feed the already verified clean-HEAD identity into Next's compile-time
      // public environment. Relying on optional CI variables would make local
      // Pages builds emit an empty PageGraph producer identity.
      SITE_BEHAVIOR_LAB_BUILD_COMMIT: deployment,
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

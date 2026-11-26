#!/usr/bin/env node
/**
 * Executable entrypoint for the Site Behavior Lab v3 CLI (`sbl`).
 *
 * Automatically checks whether compiled CLI artifacts are missing or stale
 * relative to `lib/v3` TypeScript sources and recompiles quietly to stderr
 * so piped JSON / SARIF stdout output is never corrupted.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_JS = path.join(ROOT, ".unit-test-dist", "lib", "v3", "cli", "index.js");

function newestSourceMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function needsCompile() {
  if (!existsSync(CLI_JS)) return true;
  try {
    const distMtime = statSync(CLI_JS).mtimeMs;
    const srcMtime = newestSourceMtimeMs(path.join(ROOT, "lib", "v3"));
    return srcMtime > distMtime;
  } catch {
    return true;
  }
}

if (needsCompile()) {
  const tscBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  execFileSync(tscBin, ["-p", "tsconfig.test.json"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"]
  });
}

const require = createRequire(import.meta.url);
const { runSblCli } = require(CLI_JS);

runSblCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });

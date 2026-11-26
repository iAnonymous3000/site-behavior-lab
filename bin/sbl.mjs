#!/usr/bin/env node
/**
 * Executable entrypoint for the Site Behavior Lab v3 CLI (`sbl`).
 *
 * Automatically checks whether compiled CLI artifacts are missing or stale
 * relative to `lib/v3` TypeScript sources and recompiles quietly to stderr
 * so piped JSON / SARIF stdout output is never corrupted.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_JS = path.join(ROOT, ".unit-test-dist", "lib", "v3", "cli", "index.js");
const COMPILE_LOCK = path.join(ROOT, ".unit-test-dist.sbl-lock");

function newestSourceMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "corpus-overview-suite") continue;
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
    const srcMtime = newestSourceMtimeMs(path.join(ROOT, "lib"));
    return srcMtime > distMtime;
  } catch {
    return true;
  }
}

function withCompileLock(fn) {
  const deadline = Date.now() + 60_000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(COMPILE_LOCK);
      acquired = true;
      break;
    } catch {
      try {
        // Reclaim stale lock left by a crashed process (> 2 minutes old)
        if (Date.now() - statSync(COMPILE_LOCK).mtimeMs > 120_000) {
          rmSync(COMPILE_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    fn();
  } finally {
    if (acquired) rmSync(COMPILE_LOCK, { recursive: true, force: true });
  }
}

if (needsCompile()) {
  withCompileLock(() => {
    if (!needsCompile()) return;
    const tscBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    execFileSync(tscBin, ["-p", "tsconfig.test.json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"]
    });
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

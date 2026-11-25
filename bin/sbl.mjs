#!/usr/bin/env node
/**
 * Executable entrypoint for the Site Behavior Lab v3 CLI (`sbl`).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_JS = path.join(ROOT, ".unit-test-dist", "lib", "v3", "cli", "index.js");

if (!existsSync(CLI_JS)) {
  const tscBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  execFileSync(tscBin, ["-p", "tsconfig.test.json"], {
    cwd: ROOT,
    stdio: "inherit"
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

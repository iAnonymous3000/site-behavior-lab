#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireQualification } from "./v1-qualification-acquire.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: node scripts/run-v1-qualification.mjs --output <new directory outside checkout>");
const outputDir = path.resolve(args[1]);
const parent = realpathSync(path.dirname(outputDir));
const trustedOutput = path.join(parent, path.basename(outputDir));
if (existsSync(outputDir) || trustedOutput === rootDir || trustedOutput.startsWith(rootDir + path.sep)) throw new Error("Output must be a new directory outside the checkout; captures never overwrite earlier evidence.");
const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Qualification requires committed, clean source; commit fixes before collecting candidate evidence.");
const candidate = git("rev-parse", "HEAD");
if (!/^[0-9a-f]{40}$/.test(candidate)) throw new Error("Candidate must be a full Git commit.");
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.qualification.json"], { cwd: rootDir, stdio: "inherit" });
if (git("status", "--porcelain", "--untracked-files=normal") || git("rev-parse", "HEAD") !== candidate) throw new Error("Source changed while building qualification tools.");
const require = createRequire(import.meta.url);
const dist = (name) => require(path.join(rootDir, "dist", "qualification", "lib", `${name}.js`));
const ledger = await acquireQualification({ outputDir: trustedOutput, buildCommit: candidate, progress: console.log,
  runtime: { scanner: dist("scanner"), builder: dist("scan-report-v2-runtime-builder"), store: dist("report-store"),
    view: dist("scan-report-view"), consistency: dist("report-consistency"), headline: dist("report-headline") } });
if (git("status", "--porcelain", "--untracked-files=normal") || git("rev-parse", "HEAD") !== candidate) throw new Error("Source changed during capture; retained diagnostics are not qualified candidate evidence.");
if (ledger.cases.some((entry) => entry.problems.length) || ledger.cases.length !== 5) process.exitCode = 1;
console.log(`Capture retained at ${trustedOutput}; release approval remains pending.`);

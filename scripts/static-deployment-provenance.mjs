#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const COMMIT_ENV_NAMES = ["SITE_BEHAVIOR_LAB_BUILD_COMMIT", "CF_PAGES_COMMIT_SHA", "GITHUB_SHA"];

/**
 * Resolve the only commit a static artifact may claim as exact provenance.
 * Environment metadata is advisory until it matches the checked-out HEAD, and
 * HEAD is exact only while every tracked/staged/untracked input is clean.
 */
export function resolveExactStaticDeploymentCommit({ cwd = process.cwd(), env = process.env } = {}) {
  const head = git(cwd, ["rev-parse", "--verify", "HEAD"]).trim().toLowerCase();
  if (!FULL_COMMIT_PATTERN.test(head)) {
    throw new Error("Static deployment provenance requires an exact full Git HEAD commit");
  }

  for (const name of COMMIT_ENV_NAMES) {
    const rawValue = env[name]?.trim();
    if (!rawValue) continue;
    const value = rawValue.toLowerCase();
    if (!FULL_COMMIT_PATTERN.test(value)) throw new Error(`${name} must be a full lowercase Git commit SHA`);
    if (value !== head) {
      throw new Error(`${name} does not match the checked-out Git HEAD; refusing false static provenance`);
    }
  }

  const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.trim() !== "") {
    // Name the first offending entries so a refusal in a CI annotation is
    // actionable without authenticated log access. Paths only, bounded.
    const entries = status.trimEnd().split("\n").slice(0, 8).map((line) => line.trim());
    const suffix = status.trimEnd().split("\n").length > 8 ? ", ..." : "";
    throw new Error(
      "Static deployment provenance requires a clean Git worktree; commit or remove staged, tracked, and untracked changes " +
        `before building (dirty: ${entries.join(", ")}${suffix})`
    );
  }

  return head;
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Static deployment provenance requires an accessible Git checkout");
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${resolveExactStaticDeploymentCommit()}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

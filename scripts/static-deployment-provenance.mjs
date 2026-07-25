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

/**
 * The committer date of a commit, as a UTC ISO-8601 instant.
 *
 * Deterministic for a given SHA, unlike a build clock: the same commit always
 * produces the same receipt bytes, so this cannot break exact-SHA artifact
 * comparison or attestation. Consumers use it to tell a rollout in progress
 * (a recent revision the slower surface has not reached yet) from a genuinely
 * stuck deploy, without needing Git history at read time.
 */
export function resolveCommitTimestamp(commit, { cwd = process.cwd() } = {}) {
  if (!FULL_COMMIT_PATTERN.test(commit)) {
    throw new Error("A commit timestamp requires a full lowercase Git commit SHA");
  }
  const raw = git(cwd, ["show", "--no-patch", "--format=%cI", commit]).trim();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not read a valid committer date for ${commit}`);
  }
  return new Date(parsed).toISOString();
}

/**
 * The published static deployment receipt (`out/deployment.json`).
 *
 * Built here and validated here so the producer and the release-evidence gate
 * cannot disagree about its shape. They did: the receipt gained
 * revisionCommittedAt while the gate still required an exact two-key object,
 * so every build after that change failed the gate and production stopped
 * advancing. The gate's fixtures hand-wrote the old shape, so nothing caught it.
 */
export const DEPLOYMENT_RECEIPT_SCHEMA_VERSION = 1;

export function buildDeploymentReceipt(commit, { cwd = process.cwd() } = {}) {
  return {
    schemaVersion: DEPLOYMENT_RECEIPT_SCHEMA_VERSION,
    deployment: commit,
    revisionCommittedAt: resolveCommitTimestamp(commit, { cwd })
  };
}

/**
 * Null when the receipt is exactly what this commit must publish, else the
 * reason it is not. Deliberately strict about the key set: an unexpected field
 * in a published provenance artifact is a leak, not a convenience. The
 * timestamp is checked against the commit itself rather than merely parsed,
 * because its whole value is being derivable from the SHA (a build clock would
 * make every rebuild differ and break exact-SHA comparison).
 */
export function deploymentReceiptViolation(value, commit, { cwd = process.cwd() } = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "deployment.json must be a JSON object";
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "deployment,revisionCommittedAt,schemaVersion") {
    return `deployment.json must carry exactly deployment, revisionCommittedAt, and schemaVersion (found: ${keys || "no keys"})`;
  }
  if (value.schemaVersion !== DEPLOYMENT_RECEIPT_SCHEMA_VERSION) {
    return `deployment.json schemaVersion must be ${DEPLOYMENT_RECEIPT_SCHEMA_VERSION}`;
  }
  if (value.deployment !== commit) {
    return "deployment.json must identify the exact clean source commit";
  }
  const expected = resolveCommitTimestamp(commit, { cwd });
  if (value.revisionCommittedAt !== expected) {
    return "deployment.json revisionCommittedAt must be the committer date of that exact commit";
  }
  return null;
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

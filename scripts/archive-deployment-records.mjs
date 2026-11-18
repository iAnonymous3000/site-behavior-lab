#!/usr/bin/env node
// Copies signed production deployment records out of their 90-day Actions
// artifacts into research/production-deployments/, for a reviewed proposal.
//
//   collect --runs <id,id,...> --into <repository root>
//
// For each named run of .github/workflows/deploy-container.yml it refuses
// anything but a completed, successful run on the production branch; takes
// the one record artifact of that run's attempt; holds the record to the
// run's commit, id and attempt (scripts/production-deployment-record.mjs);
// requires GitHub's attestation of the record to verify as signed by that
// workflow at that commit on refs/heads/production; and writes the record
// and its attestation bundle beside each other. It never overwrites a file
// already there. .github/workflows/archive-deployment-records.yml runs it
// and proposes what it wrote.
//
// A record says what the provider reported the application runs and what
// the live scanner reported as its commit. Keeping it here keeps those two
// readings and their signature after the artifact expires. It does not make
// them say more: a report whose build commit matches a record is consistent
// with the record's image, and nothing shows that a scan ran in it.

import { execFileSync } from "node:child_process";
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPOSITORY } from "./production-ci-lib.mjs";
import { DEPLOYMENT_RECORD_FILE, deploymentRecordProblems } from "./production-deployment-record.mjs";

export const ARCHIVE_DIRECTORY = "research/production-deployments";
export const DEPLOY_WORKFLOW = ".github/workflows/deploy-container.yml";
export const MAX_RUNS = 20;
const SHA = /^[0-9a-f]{40}$/;

/** The run ids of a dispatch, in order: 1 to MAX_RUNS distinct positive integers, comma separated. */
export function parseRunIds(text) {
  const parts = String(text ?? "").split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_RUNS) throw new Error(`name 1 to ${MAX_RUNS} deployment runs`);
  const ids = parts.map((part) => {
    if (!/^[1-9][0-9]{0,15}$/.test(part)) throw new Error(`${JSON.stringify(part)} is not a run id`);
    const id = Number(part);
    if (!Number.isSafeInteger(id)) throw new Error(`${part} is not a run id`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("a run is named twice");
  return ids;
}

/** Every way an Actions run is not a finished, successful production deployment run of this repository; empty when it is. */
export function deploymentRunProblems(run, runId) {
  const problems = [];
  if (run?.id !== runId) problems.push(`the API answered for run ${run?.id}, not ${runId}`);
  if (run?.repository?.full_name !== REPOSITORY || run?.head_repository?.full_name !== REPOSITORY) problems.push("the run is not of this repository");
  if (run?.path !== DEPLOY_WORKFLOW) problems.push(`the run is of ${run?.path}, not ${DEPLOY_WORKFLOW}`);
  if (run?.head_branch !== "production") problems.push(`the run is on ${run?.head_branch}, not production`);
  if (!["push", "workflow_dispatch"].includes(run?.event)) problems.push(`the run was started by ${run?.event}`);
  if (run?.status !== "completed" || run?.conclusion !== "success") problems.push("the run did not complete successfully");
  if (!SHA.test(run?.head_sha ?? "")) problems.push("the run names no full commit");
  if (!Number.isSafeInteger(run?.run_attempt) || run.run_attempt < 1) problems.push("the run names no attempt");
  return problems;
}

/** The name the deploy workflow gives the record artifact of a run's attempt. */
export const recordArtifactName = (run) => `production-container-readback-${run.head_sha}-${run.run_attempt}`;

/** Where a run's record and its bundle are kept, relative to the repository root. */
export function archivePaths(run) {
  const stem = `${ARCHIVE_DIRECTORY}/${run.id}-${run.run_attempt}`;
  return { record: `${stem}.json`, bundle: `${stem}.bundle.jsonl` };
}

/** The arguments that verify a record as signed by the deploy workflow at its commit on the production branch. */
export function recordAttestationArgs(file, commit) {
  return [
    "attestation", "verify", file, "--repo", REPOSITORY,
    "--signer-workflow", `${REPOSITORY}/${DEPLOY_WORKFLOW}`,
    "--source-ref", "refs/heads/production", "--source-digest", commit,
    "--signer-digest", commit, "--deny-self-hosted-runners", "--format", "json"
  ];
}

const defaultGh = (args, options = {}) => execFileSync("gh", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });

/**
 * Collects and checks the records of the named runs, then writes them under
 * `root`. Nothing is written unless every run passes. `gh` runs the GitHub
 * CLI and `verifier` the pinned one that verifies attestations.
 */
export function collectDeploymentRecords({ runIds, root, gh = defaultGh, verifier = defaultGh }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "sbl-deployment-records-"));
  try {
    const collected = runIds.map((runId) => {
      const run = JSON.parse(gh(["api", `repos/${REPOSITORY}/actions/runs/${runId}`]));
      const runProblems = deploymentRunProblems(run, runId);
      if (runProblems.length > 0) throw new Error(`run ${runId} is refused:\n- ${runProblems.join("\n- ")}`);
      const name = recordArtifactName(run);
      const artifacts = JSON.parse(gh(["api", `repos/${REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`])).artifacts ?? [];
      const matching = artifacts.filter((artifact) => artifact?.name === name);
      if (matching.length !== 1 || matching[0].expired !== false) throw new Error(`run ${runId} has no single unexpired artifact ${name}`);
      const directory = path.join(scratch, String(runId));
      mkdirSync(directory);
      gh(["run", "download", String(runId), "--repo", REPOSITORY, "--name", name, "--dir", directory]);
      const recordFile = path.join(directory, DEPLOYMENT_RECORD_FILE);
      if (!existsSync(recordFile) || readdirSync(directory).length !== 1) throw new Error(`run ${runId}'s artifact is not the one record file`);
      const bytes = readFileSync(recordFile);
      const problems = deploymentRecordProblems(JSON.parse(bytes.toString("utf8")), {
        commit: run.head_sha, deployRunId: run.id, deployRunAttempt: run.run_attempt
      });
      if (problems.length > 0) throw new Error(`run ${runId}'s record is refused:\n- ${problems.join("\n- ")}`);
      const results = JSON.parse(verifier(recordAttestationArgs(recordFile, run.head_sha)));
      if (!Array.isArray(results) || results.length === 0) throw new Error(`run ${runId}'s record has no verified attestation`);
      const bundles = path.join(scratch, `${runId}-bundle`);
      mkdirSync(bundles);
      verifier(["attestation", "download", recordFile, "--repo", REPOSITORY], { cwd: bundles });
      const downloaded = readdirSync(bundles).filter((file) => file.endsWith(".jsonl"));
      if (downloaded.length !== 1) throw new Error(`run ${runId}'s record has ${downloaded.length} attestation bundle files, not one`);
      return { run, bytes, bundle: path.join(bundles, downloaded[0]) };
    });
    const written = [];
    for (const { run } of collected) {
      for (const relative of Object.values(archivePaths(run))) {
        if (existsSync(path.join(root, relative))) throw new Error(`${relative} is already kept; nothing is overwritten`);
      }
    }
    mkdirSync(path.join(root, ARCHIVE_DIRECTORY), { recursive: true });
    for (const { run, bytes, bundle } of collected) {
      const paths = archivePaths(run);
      writeFileSync(path.join(root, paths.record), bytes, { flag: "wx" });
      // A copy, not a rename: the scratch directory may be on another file system.
      copyFileSync(bundle, path.join(root, paths.bundle), fsConstants.COPYFILE_EXCL);
      written.push(paths.record, paths.bundle);
    }
    return written;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1 || argv[at + 1] === undefined) throw new Error(`missing ${name} <value>`);
  return argv[at + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command !== "collect") throw new Error("Usage: archive-deployment-records.mjs collect --runs <id,id,...> --into <repository root>");
    const root = path.resolve(option(rest, "--into"));
    const pinnedGh = execFileSync(process.execPath, [path.join(root, "scripts/ensure-gh-attestation-verifier.mjs")], {
      cwd: root, encoding: "utf8", timeout: 120_000
    }).trim();
    const written = collectDeploymentRecords({
      runIds: parseRunIds(option(rest, "--runs")),
      root,
      verifier: (args, options = {}) => execFileSync(pinnedGh, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options })
    });
    console.log(written.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { requiredCiJobs, unmetRequiredJobs } from "./verify-required-ci-jobs.mjs";

export const REPOSITORY = "iAnonymous3000/site-behavior-lab";
export const run = (bin, args) => execFileSync(bin, args, {
  encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024
});
const api = (endpoint) => JSON.parse(run("gh", ["api", endpoint]));

export function validMainRun(run, commit) {
  return Number.isSafeInteger(run?.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
    run.head_sha === commit && run.head_branch === "main" &&
    run.path === ".github/workflows/ci.yml" &&
    ["push", "workflow_dispatch"].includes(run.event);
}

export function attestationArgs(file, commit) {
  return ["attestation", "verify", file, "--repo", REPOSITORY,
    "--signer-workflow", `${REPOSITORY}/.github/workflows/ci.yml`,
    "--source-ref", "refs/heads/main", "--source-digest", commit,
    "--signer-digest", commit, "--deny-self-hosted-runners", "--format", "json"];
}

export function resolveProductionCi(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REF, "refs/heads/production");
  assert.ok(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME));
  assert.ok(env.RUNNER_TEMP);
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  assert.equal(commit, env.GITHUB_SHA);
  assert.match(commit, /^[0-9a-f]{40}$/);
  const latest = api(`repos/${REPOSITORY}/git/ref/heads/production`).object.sha;
  if (latest !== commit) {
    console.log(`Skipping superseded production deployment ${commit}; production is ${latest}.`);
    return null;
  }
  const runs = api(`repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${commit}&branch=main&per_page=100`).workflow_runs;
  let selected;
  for (const candidate of runs ?? []) {
    if (!validMainRun(candidate, commit)) continue;
    const jobs = JSON.parse(run("gh", ["api", "--paginate", "--slurp",
      `repos/${REPOSITORY}/actions/runs/${candidate.id}/attempts/${candidate.run_attempt}/jobs?per_page=100`]));
    if (unmetRequiredJobs(jobs, requiredCiJobs()).length === 0) { selected = candidate; break; }
  }
  assert.ok(selected, "No main CI run has passed every required gate for this production revision");
  return { commit, runId: selected.id };
}

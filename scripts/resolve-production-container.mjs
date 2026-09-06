#!/usr/bin/env node
// Resolve an existing main-CI artifact. Never accept a caller-selected image,
// arbitrary run, PR artifact, cache entry, or mutable tag as deployment proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { REPOSITORY, PUBLISHED_EVIDENCE, validMainRun, validatePublishedContainer } from "./published-container-lib.mjs";
import { requiredCiJobs, unmetRequiredJobs } from "./verify-required-ci-jobs.mjs";

assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
assert.equal(process.env.GITHUB_REF, "refs/heads/production");
assert.ok(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME));
assert.ok(process.env.GITHUB_OUTPUT && process.env.RUNNER_TEMP);
const run = (bin, args) => execFileSync(bin, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
const api = (endpoint) => JSON.parse(run("gh", ["api", endpoint]));
const commit = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(commit, process.env.GITHUB_SHA);
assert.match(commit, /^[0-9a-f]{40}$/);
const latest = api(`repos/${REPOSITORY}/git/ref/heads/production`).object.sha;
if (latest !== commit) {
  console.log(`Skipping superseded production deployment ${commit}; production is ${latest}.`);
  appendFileSync(process.env.GITHUB_OUTPUT, "current=false\n");
  process.exit(0);
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
const directory = mkdtempSync(path.join(process.env.RUNNER_TEMP, "published-container-"));
run("gh", ["run", "download", String(selected.id), "--repo", REPOSITORY,
  "--name", `exact-sha-published-container-evidence-${commit}`, "--dir", directory]);
const file = path.join(directory, PUBLISHED_EVIDENCE);
const reference = validatePublishedContainer(JSON.parse(readFileSync(file)), {
  commit, tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
  configBytes: readFileSync("wrangler.container.jsonc")
});
assert.ok(!/[\r\n]/.test(file));
appendFileSync(process.env.GITHUB_OUTPUT, `current=true\nevidence=${file}\nimage=${reference}\nci_run=${selected.id}\n`);
console.log(`Resolved image from gated main CI run ${selected.id}: ${reference}. Attestation verification is required before deploy.`);

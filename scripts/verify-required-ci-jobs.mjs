#!/usr/bin/env node
// Verifies that every required CI job ran exactly once and concluded success
// for one CI run. Both the promotion gate and the release tag gate call this,
// so the required-job list is stated once (.github/required-ci-jobs.json)
// rather than restated per workflow, where the two copies could drift and
// quietly drop a gate from one path.
//
// Pure: it reads a jobs JSON file the caller already fetched, so it is
// testable without network access. Usage:
//   node scripts/verify-required-ci-jobs.mjs <jobs-json-path> [context]
//
// The jobs file is the `gh api --paginate --slurp .../actions/runs/<id>/jobs`
// shape: an array of pages, each with a `jobs` array. A single unpaginated
// object is accepted too, so a caller that fetched one page still works.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The required job names, in their declared order. */
export function requiredCiJobs(root = rootDir) {
  const raw = JSON.parse(readFileSync(path.join(root, ".github", "required-ci-jobs.json"), "utf8"));
  if (raw?.schemaVersion !== 1) throw new Error("required-ci-jobs.json must use schemaVersion 1");
  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0) {
    throw new Error("required-ci-jobs.json must list at least one required job");
  }
  for (const job of raw.jobs) {
    if (typeof job !== "string" || job.trim() === "") {
      throw new Error("required-ci-jobs.json job names must be non-empty strings");
    }
  }
  if (new Set(raw.jobs).size !== raw.jobs.length) {
    throw new Error("required-ci-jobs.json must not repeat a job name");
  }
  return raw.jobs;
}

/** Flattens the paginated jobs payload into one array. */
export function collectJobs(payload) {
  const pages = Array.isArray(payload) ? payload : [payload];
  return pages.flatMap((page) => (Array.isArray(page?.jobs) ? page.jobs : []));
}

/**
 * Returns one failure line per unmet gate; an empty array means every required
 * job ran exactly once and succeeded. A job that appears zero times is as much
 * a failure as one that failed: a skipped gate proves nothing.
 */
export function unmetRequiredJobs(payload, required) {
  const jobs = collectJobs(payload);
  const failures = [];
  for (const name of required) {
    const matches = jobs.filter((job) => job?.name === name);
    if (matches.length !== 1) {
      failures.push(`${name}: expected exactly one job, found ${matches.length}`);
    } else if (matches[0].conclusion !== "success") {
      failures.push(`${name}: ${matches[0].conclusion ?? "no conclusion"}`);
    }
  }
  return failures;
}

function main() {
  const [jobsPath, context = "CI gate not passed"] = process.argv.slice(2);
  if (!jobsPath) {
    console.error("::error title=Required-job check misconfigured::Pass the fetched jobs JSON path.");
    process.exit(1);
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(jobsPath, "utf8"));
  } catch (error) {
    console.error(`::error title=${context}::Could not read the CI jobs payload: ${error.message}`);
    process.exit(1);
  }
  const required = requiredCiJobs();
  const failures = unmetRequiredJobs(payload, required);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error title=${context}::${failure}`);
    process.exit(1);
  }
  console.log(`Every required CI job passed (${required.length}): ${required.join(", ")}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

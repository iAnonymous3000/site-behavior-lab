#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { featuredAcquisitionDateFromRun } from "../lib/featured-scan-availability.ts";
const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_SHA: sha, GITHUB_ENV: envFile } = process.env;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || !/^[1-9][0-9]*$/.test(runId || "") || !envFile) {
  throw new Error("Featured acquisition requires the trusted GitHub run identity.");
}
const metadata = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], {
  encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000
}));
const date = featuredAcquisitionDateFromRun(metadata, runId, sha);
appendFileSync(envFile, `FEATURED_ACQUISITION_DATE=${date}\n`);
console.log(`Pinned catalog eligibility to workflow creation day ${date}.`);

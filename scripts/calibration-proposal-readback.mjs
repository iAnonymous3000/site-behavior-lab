#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const OWNER = "iAnonymous3000";
const FULL_SHA = /^[0-9a-f]{40}$/;
const BRANCH =
  /^automation\/calibration-[a-z0-9][a-z0-9._-]{0,99}-[1-9][0-9]*-[1-9][0-9]{0,2}$/;

export function validateCalibrationProposalPulls(
  pulls,
  proposalBranch,
  proposalOid
) {
  if (!Array.isArray(pulls) || pulls.length !== 1) {
    throw new Error(
      "calibration proposal must resolve to exactly one open pull request"
    );
  }
  const pull = pulls[0];
  if (
    pull?.state !== "open" ||
    pull?.base?.ref !== "main" ||
    pull?.base?.repo?.full_name !== REPOSITORY ||
    pull?.head?.ref !== proposalBranch ||
    pull?.head?.sha !== proposalOid ||
    pull?.head?.repo?.full_name !== REPOSITORY ||
    pull?.user?.login !== "github-actions[bot]" ||
    !Number.isSafeInteger(pull?.number) ||
    pull.number <= 0 ||
    typeof pull?.html_url !== "string"
  ) {
    throw new Error(
      "calibration proposal PR does not bind the exact in-repository branch OID and main base"
    );
  }
  return {
    number: pull.number,
    url: pull.html_url
  };
}

export function validateCalibrationProposalRuns(
  page,
  proposalBranch,
  proposalOid
) {
  if (
    typeof page !== "object" ||
    page === null ||
    !Number.isSafeInteger(page.total_count) ||
    !Array.isArray(page.workflow_runs) ||
    page.total_count !== page.workflow_runs.length ||
    page.workflow_runs.length > 100
  ) {
    throw new Error(
      "calibration proposal CI run list is malformed or paginated"
    );
  }
  return page.workflow_runs.filter(
    (run) =>
      run?.event === "workflow_dispatch" &&
      run?.path === ".github/workflows/ci.yml" &&
      run?.head_branch === proposalBranch &&
      run?.head_sha === proposalOid &&
      run?.repository?.full_name === REPOSITORY &&
      Number.isSafeInteger(run?.id) &&
      run.id > 0
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseOptions(process.argv.slice(2));
  assertRemoteOid(options.proposalBranch, options.proposalOid);
  const pull = readExactPull(options.proposalBranch, options.proposalOid);
  const before = new Set(
    readRuns(options.proposalBranch, options.proposalOid).map((run) => run.id)
  );
  gh([
    "workflow",
    "run",
    "ci.yml",
    "--repo",
    REPOSITORY,
    "--ref",
    options.proposalBranch
  ]);

  let newRuns = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    newRuns = readRuns(options.proposalBranch, options.proposalOid).filter(
      (run) => !before.has(run.id)
    );
    if (newRuns.length > 1) {
      throw new Error(
        "calibration proposal dispatch created more than one exact CI run"
      );
    }
    if (newRuns.length === 1) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  }
  if (newRuns.length !== 1) {
    throw new Error(
      "calibration proposal dispatch did not produce one exact branch/OID CI run"
    );
  }
  assertRemoteOid(options.proposalBranch, options.proposalOid);
  const finalPull = readExactPull(
    options.proposalBranch,
    options.proposalOid
  );
  if (finalPull.number !== pull.number) {
    throw new Error("calibration proposal PR changed during CI dispatch");
  }
  const run = newRuns[0];
  process.stdout.write(
    `${JSON.stringify(
      {
        proposalBranch: options.proposalBranch,
        proposalOid: options.proposalOid,
        pullRequest: finalPull,
        ciRun: {
          id: run.id,
          url: run.html_url,
          headBranch: run.head_branch,
          headSha: run.head_sha,
          event: run.event
        }
      },
      null,
      2
    )}\n`
  );
}

function readExactPull(proposalBranch, proposalOid) {
  const query = new URLSearchParams({
    state: "open",
    head: `${OWNER}:${proposalBranch}`,
    base: "main",
    per_page: "100"
  });
  return validateCalibrationProposalPulls(
    ghJson(`repos/${REPOSITORY}/pulls?${query}`),
    proposalBranch,
    proposalOid
  );
}

function readRuns(proposalBranch, proposalOid) {
  const query = new URLSearchParams({
    event: "workflow_dispatch",
    branch: proposalBranch,
    per_page: "100"
  });
  return validateCalibrationProposalRuns(
    ghJson(`repos/${REPOSITORY}/actions/workflows/ci.yml/runs?${query}`),
    proposalBranch,
    proposalOid
  );
}

function assertRemoteOid(proposalBranch, proposalOid) {
  const output = execFileSync(
    "git",
    [
      "ls-remote",
      "--exit-code",
      "--refs",
      "origin",
      `refs/heads/${proposalBranch}`
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  ).trim();
  if (output !== `${proposalOid}\trefs/heads/${proposalBranch}`) {
    throw new Error(
      "remote calibration proposal branch does not equal the finalized local OID"
    );
  }
}

function ghJson(endpoint) {
  return JSON.parse(
    gh([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      endpoint
    ])
  );
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024
  }).trim();
}

function parseOptions(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--proposal-branch" ||
    args[2] !== "--proposal-oid" ||
    !BRANCH.test(args[1]) ||
    !FULL_SHA.test(args[3])
  ) {
    throw new Error(
      "Usage: calibration-proposal-readback --proposal-branch <automation/calibration-...> --proposal-oid <sha>"
    );
  }
  return {
    proposalBranch: args[1],
    proposalOid: args[3]
  };
}

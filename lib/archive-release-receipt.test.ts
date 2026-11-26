import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitFixtureEnv, initFixtureRepo, removeFixtureTree, runFixtureGit } from "./git-fixture";

const WORKFLOW_PATH = path.join(process.cwd(), ".github", "workflows", "archive-release-receipt.yml");
const DOWNLOAD_STEP = "- name: Download and validate the release receipt artifact";
const PUBLISH_STEP = "- name: Publish reviewed archive proposal";

function extractStepScript(workflow: string, stepHeader: string): string {
  const start = workflow.indexOf(stepHeader);
  assert.ok(start !== -1, `missing step: ${stepHeader}`);
  const run = workflow.indexOf("run: |\n", start);
  const next = workflow.indexOf("\n      - name:", start + stepHeader.length);
  const end = next === -1 ? workflow.length : next;
  assert.ok(run !== -1 && run < end, `step has no literal shell block: ${stepHeader}`);
  return workflow
    .slice(run + "run: |\n".length, end)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function writeGhShim(binDir: string): void {
  const shim = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const logFile = process.env.SHIM_GH_LOG;
if (logFile) fs.appendFileSync(logFile, JSON.stringify(args) + "\\n");

if (args[0] === "api") {
  const endpoint = args[1] || "";
  const jqIndex = args.indexOf("--jq");
  const jqExpr = jqIndex >= 0 ? args[jqIndex + 1] : "";
  if (endpoint.endsWith("/artifacts")) {
    const match = jqExpr.match(/select\\(test\\("([^"]+)"\\)\\)/);
    if (!match) {
      console.error("missing artifact regex in --jq");
      process.exit(2);
    }
    const regex = new RegExp(match[1].replace(/\\\\\\\\/g, "\\\\"));
    const artifacts = JSON.parse(process.env.SHIM_ARTIFACTS_JSON || "[]");
    const matched = artifacts.map((entry) => entry.name).filter((name) => regex.test(name));
    if (matched.length !== 1) {
      console.error("expected exactly one version-named site-behavior-lab-release artifact");
      process.exit(1);
    }
    process.stdout.write(matched[0] + "\\n");
    process.exit(0);
  }
  const run = JSON.parse(process.env.SHIM_RUN_JSON || "{}");
  if (!jqExpr.includes('.conclusion != "success"') || !jqExpr.includes(".path")) {
    console.error("unexpected run --jq expression");
    process.exit(2);
  }
  if (run.conclusion !== "success") {
    console.error("release run did not conclude successfully");
    process.exit(1);
  }
  process.stdout.write(String(run.path || "") + "\\n");
  process.exit(0);
}

if (args[0] === "run" && args[1] === "download") {
  const dirIndex = args.indexOf("--dir");
  const dir = dirIndex >= 0 ? args[dirIndex + 1] : "";
  if (!dir) process.exit(2);
  fs.mkdirSync(dir, { recursive: true });
  const body = process.env.SHIM_RECEIPT_BODY ?? "";
  fs.writeFileSync(path.join(dir, "site-behavior-lab-release.json"), body, "utf8");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://github.com/iAnonymous3000/site-behavior-lab/pull/999\\n");
  process.exit(0);
}

if (args[0] === "workflow" && args[1] === "run") {
  process.exit(0);
}

console.error("unexpected gh invocation: " + args.join(" "));
process.exit(2);
`;
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, shim, "utf8");
  chmodSync(ghPath, 0o755);
}

type FixtureScenario = {
  runId: string;
  run?: { conclusion: string; path: string };
  artifacts?: Array<{ name: string }>;
  receiptBody?: string;
  runPublish?: boolean;
};

function runArchiveWorkflow(scenario: FixtureScenario) {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const downloadScript = extractStepScript(workflow, DOWNLOAD_STEP);
  const publishScript = extractStepScript(workflow, PUBLISH_STEP);

  const root = mkdtempSync(path.join(tmpdir(), "sbl-archive-receipt-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  const runnerTemp = path.join(root, "temp");
  const githubOutput = path.join(root, "github-output.txt");
  const ghLog = path.join(root, "gh-calls.jsonl");
  mkdirSync(origin);
  mkdirSync(work);
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(githubOutput, "", "utf8");
  writeFileSync(ghLog, "", "utf8");
  writeGhShim(bin);

  const git = (cwd: string, ...args: string[]) => runFixtureGit(cwd, args).trim();
  git(origin, "init", "--quiet", "--bare");
  initFixtureRepo(work);
  git(work, "checkout", "--quiet", "-b", "main");
  writeFileSync(path.join(work, "README.md"), "# Fixture\n", "utf8");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "Initial commit");
  const mainBefore = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "origin", "main");

  const baseEnv = gitFixtureEnv({
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: "iAnonymous3000/site-behavior-lab",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_OUTPUT: githubOutput,
    RUNNER_TEMP: runnerTemp,
    RELEASE_RUN_ID: scenario.runId,
    SHIM_GH_LOG: ghLog,
    SHIM_RUN_JSON: JSON.stringify(
      scenario.run ?? { conclusion: "success", path: ".github/workflows/release.yml" }
    ),
    SHIM_ARTIFACTS_JSON: JSON.stringify(
      scenario.artifacts ?? [
        { name: "site-behavior-lab-release-987654-1.json" },
        { name: "site-behavior-lab-release-1.0.0-rc.1" }
      ]
    ),
    SHIM_RECEIPT_BODY:
      scenario.receiptBody ??
      `${JSON.stringify({ schemaVersion: 2, release: { version: "1.0.0-rc.1" } }, null, 2)}\n`
  });

  const download = spawnSync("bash", ["-c", downloadScript], {
    cwd: work,
    encoding: "utf8",
    env: baseEnv
  });
  const outputs = Object.fromEntries(
    readFileSync(githubOutput, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );

  let publish: ReturnType<typeof spawnSync> | null = null;
  let secondPublish: ReturnType<typeof spawnSync> | null = null;
  let proposalBranchExists = false;
  let mainAfter = mainBefore;
  if (scenario.runPublish && download.status === 0) {
    const publishEnv = {
      ...baseEnv,
      BASE_BRANCH: "main",
      PROPOSAL_BRANCH: `automation/release-receipt-${outputs.version}`,
      RECEIPT_VERSION: outputs.version ?? "",
      RECEIPT_DIGEST: outputs.digest ?? ""
    };
    publish = spawnSync("bash", ["-c", publishScript], {
      cwd: work,
      encoding: "utf8",
      env: publishEnv
    });
    secondPublish = spawnSync("bash", ["-c", publishScript], {
      cwd: work,
      encoding: "utf8",
      env: publishEnv
    });
    const refs = git(origin, "for-each-ref", "--format=%(refname) %(objectname)");
    proposalBranchExists = refs.includes(`refs/heads/automation/release-receipt-${outputs.version}`);
    mainAfter = git(origin, "rev-parse", "refs/heads/main");
  }

  const archivedPath = outputs.version
    ? path.join(work, "docs", "release-receipts", outputs.version, "release-receipt.json")
    : null;
  const archivedBytes = archivedPath && existsSync(archivedPath) ? readFileSync(archivedPath, "utf8") : null;
  const ghCalls = readFileSync(ghLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

  removeFixtureTree(root);
  return {
    download,
    publish,
    secondPublish,
    outputs,
    archivedBytes,
    ghCalls,
    mainBefore,
    mainAfter,
    proposalBranchExists
  };
}

test("archive-release-receipt workflow validates, archives, and proposes a PR without pushing to main", () => {
  const receiptBody = `${JSON.stringify({ schemaVersion: 2, release: { version: "1.0.0-rc.1" } }, null, 2)}\n`;
  const expectedDigest = createHash("sha256").update(receiptBody).digest("hex");

  const result = runArchiveWorkflow({
    runId: "987654",
    receiptBody,
    runPublish: true
  });

  assert.equal(result.download.status, 0, `${result.download.stdout}${result.download.stderr}`);
  assert.equal(result.outputs.version, "1.0.0-rc.1");
  assert.equal(result.outputs.digest, expectedDigest);
  assert.equal(result.archivedBytes, receiptBody);

  assert.equal(result.publish?.status, 0, `${result.publish?.stdout}${result.publish?.stderr}`);
  assert.equal(result.proposalBranchExists, true, "proposal branch must be pushed to origin");
  assert.equal(result.mainAfter, result.mainBefore, "main must never be pushed directly");
  assert.ok(
    result.ghCalls.some((args) => args[0] === "pr" && args[1] === "create"),
    "workflow must propose a reviewed pull request"
  );
  assert.ok(
    result.ghCalls.some(
      (args) =>
        args[0] === "workflow" &&
        args[1] === "run" &&
        args[2] === "ci.yml" &&
        args.includes("automation/release-receipt-1.0.0-rc.1")
    ),
    "workflow must trigger non-promoting CI validation on the proposal branch"
  );

  assert.equal(result.secondPublish?.status, 0);
  assert.match(String(result.secondPublish?.stdout ?? ""), /Receipt already archived; nothing to propose\./);
});

test("archive-release-receipt refuses non-numeric run ids before calling gh", () => {
  for (const badId of ["", "abc", "123;id", "../99"]) {
    const result = runArchiveWorkflow({ runId: badId });
    assert.notEqual(result.download.status, 0, `expected refusal for ${JSON.stringify(badId)}`);
    assert.match(`${result.download.stdout}${result.download.stderr}`, /release_run_id must be numeric/);
    assert.equal(result.ghCalls.length, 0, `gh must not be called for ${JSON.stringify(badId)}`);
  }
});

test("archive-release-receipt refuses failed runs, non-release workflows, ambiguous artifacts, and invalid receipt JSON", () => {
  const failedRun = runArchiveWorkflow({
    runId: "111",
    run: { conclusion: "failure", path: ".github/workflows/release.yml" }
  });
  assert.notEqual(failedRun.download.status, 0);
  assert.equal(failedRun.archivedBytes, null);

  const wrongWorkflow = runArchiveWorkflow({
    runId: "222",
    run: { conclusion: "success", path: ".github/workflows/ci.yml" }
  });
  assert.notEqual(wrongWorkflow.download.status, 0);
  assert.match(
    `${wrongWorkflow.download.stdout}${wrongWorkflow.download.stderr}`,
    /not \.github\/workflows\/release\.yml/
  );
  assert.equal(wrongWorkflow.archivedBytes, null);

  const missingVersionArtifact = runArchiveWorkflow({
    runId: "333",
    artifacts: [{ name: "site-behavior-lab-release-333-1.json" }]
  });
  assert.notEqual(missingVersionArtifact.download.status, 0);
  assert.equal(missingVersionArtifact.archivedBytes, null);

  const ambiguousArtifacts = runArchiveWorkflow({
    runId: "444",
    artifacts: [
      { name: "site-behavior-lab-release-1.0.0-rc.1" },
      { name: "site-behavior-lab-release-1.0.0" }
    ]
  });
  assert.notEqual(ambiguousArtifacts.download.status, 0);
  assert.equal(ambiguousArtifacts.archivedBytes, null);

  const invalidJson = runArchiveWorkflow({
    runId: "555",
    receiptBody: "not-json\n"
  });
  assert.notEqual(invalidJson.download.status, 0);
  assert.equal(invalidJson.archivedBytes, null);

  const nonObjectJson = runArchiveWorkflow({
    runId: "666",
    receiptBody: "null\n"
  });
  assert.notEqual(nonObjectJson.download.status, 0);
  assert.equal(nonObjectJson.archivedBytes, null);
});

test("archive-release-receipt pins actions/checkout and never pushes directly to main", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.doesNotMatch(workflow, /git push[^\n]*(?:refs\/heads\/main|\bmain\b)/);
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The token that can deploy the scanner and the site must never reach a
 * runner where a dependency's install script has run. A step-scoped secret
 * does not protect it: an earlier step's code shares the runner, its user and
 * its file system, and the step that holds the token then runs files that
 * code could have changed. So every job that names the token installs with
 * `--ignore-scripts` and restores no package cache a script-running job could
 * have written. setup-node restores one by default when package.json names a
 * package manager, so each such job turns it off by name: leaving out
 * `cache:` is not enough.
 *
 * Residual, by design: the jobs that hold the token still run wrangler's own
 * code with it. Only a narrower token at the provider closes that.
 */
const DEPLOY_TOKEN = "secrets.CLOUDFLARE_CONTAINER_DEPLOY_TOKEN";
const WORKFLOWS_DIR = ".github/workflows";

type Job = { file: string; id: string; text: string };

const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort()
  .map((file) => ({ file, text: readFileSync(path.join(WORKFLOWS_DIR, file), "utf8") }));

/** The jobs of a workflow, each with its own text, split at its two-space key under `jobs:`. */
function jobsOf(file: string, text: string): Job[] {
  const start = text.search(/^jobs:\s*$/m);
  if (start === -1) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const jobs: Job[] = [];
  for (const line of lines) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) jobs.push({ file, id: header[1], text: "" });
    else if (jobs.length > 0) jobs[jobs.length - 1].text += `${line}\n`;
  }
  return jobs;
}

const jobs = workflows.flatMap(({ file, text }) => jobsOf(file, text));
const holders = jobs.filter((job) => job.text.includes(DEPLOY_TOKEN));

// Every way npm installs or rebuilds packages, any of which runs lifecycle scripts.
const NPM_INSTALL = /\bnpm\s+(?:ci|i|install(?:-[a-z-]+)?|rebuild)\b[^\n]*/g;

test("every job that names the deploy token installs without lifecycle scripts", () => {
  assert.ok(holders.length > 0, "the guard finds the jobs that name the deploy token");
  for (const holder of holders) {
    const installs = holder.text.match(NPM_INSTALL) ?? [];
    for (const install of installs) {
      assert.match(
        install,
        /--ignore-scripts\b/,
        `every job that names the deploy token installs without lifecycle scripts (${holder.file} ${holder.id}: ${install.trim()})`
      );
    }
  }
});

test("the deploy token is held by exactly the docker job and the two deployers", () => {
  // A new holder is a reviewed change, not a drift: add it here only with the
  // reason it needs the token.
  assert.deepEqual(
    holders.map((holder) => `${holder.file} ${holder.id}`).sort(),
    ["ci.yml docker", "deploy-container.yml deploy", "deploy-pages.yml deploy"],
    "the deploy token is held by exactly the docker job and the two deployers"
  );
});

test("every job that names the deploy token turns the npm cache off by name", () => {
  assert.ok(holders.length > 0, "the guard finds the jobs that name the deploy token");
  for (const holder of holders) {
    // Each setup-node step, from its name line to the next step.
    const setups = holder.text.split(/\n(?= {6}- )/).filter((step) => /uses: actions\/setup-node@/.test(step));
    assert.ok(
      setups.length > 0,
      `every job that names the deploy token turns the npm cache off by name (${holder.file} ${holder.id} sets up Node)`
    );
    for (const setup of setups) {
      assert.match(
        setup,
        /^ {10}package-manager-cache: false\s*$/m,
        `every job that names the deploy token turns the npm cache off by name (${holder.file} ${holder.id})`
      );
      assert.doesNotMatch(
        setup,
        /^\s+cache:/m,
        `every job that names the deploy token turns the npm cache off by name (${holder.file} ${holder.id} names a cache)`
      );
    }
  }
});

test("the deploy token reaches no job through a composite action or inherited secrets", () => {
  // The guards above read each job's own text. A local composite action, a
  // reusable workflow or inherited secrets would carry an install or the token
  // where that text does not show it.
  for (const { file, text } of workflows) {
    assert.doesNotMatch(
      text,
      /uses:\s*\.\/|\.github\/actions\/|secrets:\s*inherit|uses:\s*[\w.-]+\/[\w.-]+\/\.github\/workflows\//,
      `the deploy token reaches no job through a composite action or inherited secrets (${file})`
    );
  }
});

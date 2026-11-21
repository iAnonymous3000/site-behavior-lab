import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Two Cloudflare tokens reach CI. The deploy token, held by the two
 * deployers, can deploy the scanner and the site. The publish token, held
 * only by the docker job's publish step, stages the tested image in the
 * registry and has no Workers Scripts or Pages permission.
 *
 * Neither token may reach a runner where a dependency's install script has
 * run. A step-scoped secret does not protect it: an earlier step's code shares
 * the runner, its user and its file system, and the step that holds the token
 * then runs files that code could have changed. So every job that names
 * either token installs with `--ignore-scripts` and restores no package cache
 * a script-running job could have written. setup-node restores one by default
 * when package.json names a package manager, so each such job turns it off by
 * name: leaving out `cache:` is not enough.
 *
 * A token is counted wherever its bare name appears, in any case, so a
 * bracketed or lower-case reference counts, and so does a comment that names
 * it. Each workflow must name the tokens only inside a job, so a workflow-level
 * `env:` cannot hand one to every job uncounted.
 *
 * Residual, by design: the jobs that hold a token still run wrangler's own
 * code with it, and a token with Containers Edit may still change the
 * container application. Only a narrower token at the provider closes that.
 */
const DEPLOY_TOKEN = "CLOUDFLARE_CONTAINER_DEPLOY_TOKEN";
const PUBLISH_TOKEN = "CLOUDFLARE_CONTAINER_PUBLISH_TOKEN";
const WORKFLOWS_DIR = ".github/workflows";

type Job = { file: string; id: string; text: string };

const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort()
  .map((file) => ({ file, text: readFileSync(path.join(WORKFLOWS_DIR, file), "utf8") }));

/** How many times a secret's bare name appears in a text, in any case. */
function mentions(text: string, name: string): number {
  return (text.match(new RegExp(`\\b${name}\\b`, "gi")) ?? []).length;
}

/**
 * The jobs of a workflow, each with its own text, split at its two-space key
 * under `jobs:`. The jobs end at the next top-level key.
 */
function jobsOf(file: string, text: string): Job[] {
  const start = text.search(/^jobs:\s*$/m);
  if (start === -1) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const jobs: Job[] = [];
  for (const line of lines) {
    if (/^[A-Za-z_][\w-]*:/.test(line)) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) jobs.push({ file, id: header[1], text: "" });
    else if (jobs.length > 0) jobs[jobs.length - 1].text += `${line}\n`;
  }
  return jobs;
}

const jobs = workflows.flatMap(({ file, text }) => jobsOf(file, text));
const holdersOf = (name: string) => jobs.filter((job) => mentions(job.text, name) > 0);
const deployHolders = holdersOf(DEPLOY_TOKEN);
const publishHolders = holdersOf(PUBLISH_TOKEN);
const holders = jobs.filter((job) => deployHolders.includes(job) || publishHolders.includes(job));
const label = (job: Job) => `${job.file} ${job.id}`;

// Every way npm installs or rebuilds packages, any of which runs lifecycle scripts.
const NPM_INSTALL = /\bnpm\s+(?:ci|i|install(?:-[a-z-]+)?|rebuild)\b[^\n]*/g;

test("the guard finds the jobs that name each token", () => {
  // A renamed secret must not let the tests below pass by matching nothing.
  assert.ok(deployHolders.length > 0, "the guard finds the jobs that name the deploy token");
  assert.ok(publishHolders.length > 0, "the guard finds the job that names the publish token");
});

test("the deploy token is held by exactly the two deployers", () => {
  // A new holder is a reviewed change, not a drift: add it here only with the
  // reason it needs the token.
  assert.deepEqual(
    deployHolders.map(label).sort(),
    ["deploy-container.yml deploy", "deploy-pages.yml deploy"],
    "the deploy token is held by exactly the two deployers"
  );
});

test("the publish token is held by exactly the docker job", () => {
  assert.deepEqual(publishHolders.map(label).sort(), ["ci.yml docker"], "the publish token is held by exactly the docker job");
});

test("every workflow names the deploy and publish tokens only inside a job", () => {
  for (const { file, text } of workflows) {
    const inJobs = jobsOf(file, text);
    for (const name of [DEPLOY_TOKEN, PUBLISH_TOKEN]) {
      assert.equal(
        mentions(text, name),
        inJobs.reduce((sum, job) => sum + mentions(job.text, name), 0),
        `every workflow names the deploy and publish tokens only inside a job (${file})`
      );
    }
  }
});

test("every job that names a deploy or publish token installs without lifecycle scripts", () => {
  assert.ok(holders.length > 0, "the guard finds the jobs that name a deploy or publish token");
  for (const holder of holders) {
    const installs = holder.text.match(NPM_INSTALL) ?? [];
    for (const install of installs) {
      assert.match(
        install,
        /--ignore-scripts\b/,
        `every job that names a deploy or publish token installs without lifecycle scripts (${label(holder)}: ${install.trim()})`
      );
    }
  }
});

test("every job that names a deploy or publish token turns the npm cache off by name", () => {
  assert.ok(holders.length > 0, "the guard finds the jobs that name a deploy or publish token");
  for (const holder of holders) {
    // Each setup-node step, from its name line to the next step.
    const setups = holder.text.split(/\n(?= {6}- )/).filter((step) => /uses: actions\/setup-node@/.test(step));
    assert.ok(
      setups.length > 0,
      `every job that names a deploy or publish token turns the npm cache off by name (${label(holder)} sets up Node)`
    );
    for (const setup of setups) {
      assert.match(
        setup,
        /^ {10}package-manager-cache: false\s*$/m,
        `every job that names a deploy or publish token turns the npm cache off by name (${label(holder)})`
      );
      assert.doesNotMatch(
        setup,
        /^\s+cache:/m,
        `every job that names a deploy or publish token turns the npm cache off by name (${label(holder)} names a cache)`
      );
    }
  }
});

test("the tokens reach no job through a composite action, inherited secrets, toJSON(secrets) or a computed secrets index", () => {
  // The guards above read each job's own text. A local composite action, a
  // reusable workflow or inherited secrets would carry an install or a token
  // where that text does not show it, and toJSON(secrets) or a computed index
  // reaches every secret without naming one. A quoted literal index names its
  // secret, so the holder tests count it.
  //
  // Each check compares the matched text, never the whole workflow: node
  // --test can stall while it reports a failed assertion whose actual is a
  // whole workflow file, so the failure this test exists for must stay small.
  const refused = [
    /uses:\s*\.\/|\.github\/actions\/|secrets:\s*inherit|uses:\s*[\w.-]+\/[\w.-]+\/\.github\/workflows\//,
    /toJSON\(\s*secrets\s*\)/i,
    /\bsecrets\s*\[(?!\s*(?:'[^'\n]*'|"[^"\n]*")\s*\])/i
  ];
  for (const { file, text } of workflows) {
    const message = `the tokens reach no job through a composite action, inherited secrets, toJSON(secrets) or a computed secrets index (${file})`;
    for (const pattern of refused) {
      assert.equal(text.match(pattern)?.[0] ?? null, null, message);
    }
  }
});

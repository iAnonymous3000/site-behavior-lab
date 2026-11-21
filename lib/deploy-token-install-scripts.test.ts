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
 * The two deployers each name the GitHub environment `production`, whose
 * branch rule admits only the branch `production`, and no other job names it.
 * The docker job and the job that signs the deployment record name no
 * environment, so the signer's OpenID Connect subject keeps its branch form.
 * An environment is read only in its bare form, `environment: NAME` at job
 * level; any other spelling of the key fails, so none can hide a declaration.
 *
 * Residual, by design: the jobs that hold a token still run wrangler's own
 * code with it, and a token with Containers Edit may still change the
 * container application. Only a narrower token at the provider closes that.
 * The environment limits who can read the deploy token only once no
 * repository secret of the same name remains: that is a setting, which these
 * tests cannot read.
 */
const DEPLOY_TOKEN = "CLOUDFLARE_CONTAINER_DEPLOY_TOKEN";
const DEPLOY_ENVIRONMENT = "production";
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

// A block scalar's header: a line whose first key has `|` or `>` as its value.
// A comment line, a quoted key or a key holding a colon is never read as one,
// so its content stays scanned, which fails closed.
const BLOCK_SCALAR_HEADER = /^\s*(?:-\s+)*[^\s#'"][^#:'"]*:\s+[|>][1-9+-]{0,2}\s*(?:#.*)?$/;

/**
 * A workflow's YAML structure: its text with each block scalar's content
 * blanked, so a line of a script cannot read as a key. The content is every
 * later line indented past the header key's own column.
 */
function structureOf(text: string): string {
  let column = -1;
  return text
    .split("\n")
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      if (column >= 0) {
        if (line.trim() === "" || indent > column) return "";
        column = -1;
      }
      if (BLOCK_SCALAR_HEADER.test(line)) column = (/^(\s*(?:-\s+)*)/.exec(line) ?? [""])[0].length;
      return line;
    })
    .join("\n");
}

const jobs = workflows.flatMap(({ file, text }) => jobsOf(file, text));
const holdersOf = (name: string) => jobs.filter((job) => mentions(job.text, name) > 0);
const deployHolders = holdersOf(DEPLOY_TOKEN);
const publishHolders = holdersOf(PUBLISH_TOKEN);
const holders = jobs.filter((job) => deployHolders.includes(job) || publishHolders.includes(job));
const label = (job: Job) => `${job.file} ${job.id}`;

// Every spelling of an environment key: bare, quoted, in any case, in a flow
// or block mapping. `runner.environment` has no colon after it, and
// `RUNNER_ENVIRONMENT:` no word boundary, so neither counts.
const ENVIRONMENT_KEY = /\benvironment["']?\s*:/gi;
// The one form the guard reads: a bare name at the job's own key level.
const BARE_ENVIRONMENT = /^ {4}environment: ([a-z0-9][a-z0-9-]*)$/gm;
const environmentKeys = (text: string) => (text.match(ENVIRONMENT_KEY) ?? []).length;
const environmentsOf = (job: Job) => [...job.text.matchAll(BARE_ENVIRONMENT)].map((match) => match[1]);

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

test("each deployer declares the environment production at job level", () => {
  assert.ok(deployHolders.length > 0, "the guard finds the jobs that name the deploy token");
  for (const holder of deployHolders) {
    const message = `each deployer declares the environment production at job level (${label(holder)})`;
    assert.equal(environmentKeys(holder.text), 1, message);
    assert.deepEqual(environmentsOf(holder), [DEPLOY_ENVIRONMENT], message);
  }
});

test("the environment production is declared by exactly the two deployers", () => {
  assert.deepEqual(
    jobs.filter((job) => environmentsOf(job).includes(DEPLOY_ENVIRONMENT)).map(label).sort(),
    ["deploy-container.yml deploy", "deploy-pages.yml deploy"],
    "the environment production is declared by exactly the two deployers"
  );
});

test("the publish token's holder declares no environment", () => {
  assert.ok(publishHolders.length > 0, "the guard finds the job that names the publish token");
  for (const holder of publishHolders) {
    assert.equal(environmentKeys(holder.text), 0, `the publish token's holder declares no environment (${label(holder)})`);
  }
});

test("the job that signs the deployment record declares no environment", () => {
  const signers = jobs.filter((job) => job.file === "deploy-container.yml" && job.id === "attest-deployment");
  assert.equal(signers.length, 1, "the guard finds the job that signs the deployment record");
  assert.equal(environmentKeys(signers[0].text), 0, "the job that signs the deployment record declares no environment");
});

test("every workflow declares an environment only by its bare name at job level", () => {
  // Each key in a file must be a bare declaration inside a job the split
  // reads, so no other spelling, workflow-level key or unread job holds one.
  for (const { file, text } of workflows) {
    assert.equal(
      environmentKeys(text),
      jobsOf(file, text).reduce((sum, job) => sum + environmentsOf(job).length, 0),
      `every workflow declares an environment only by its bare name at job level (${file})`
    );
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

test("the tokens reach no job through a composite action, inherited secrets, toJSON(secrets), a computed secrets index or a YAML indirection", () => {
  // The guards above read each job's own text. A local composite action, a
  // reusable workflow or inherited secrets would carry an install or a token
  // where that text does not show it, and toJSON(secrets) or a computed index
  // reaches every secret without naming one. A quoted literal index names its
  // secret, so the holder tests count it. An explicit YAML key, a merge key,
  // an anchor or alias, or a double-quoted key with an escape could carry a
  // token or an environment that the counts above do not see.
  //
  // The YAML patterns read the structure, so a script line is not taken for a
  // key; the others read the whole text.
  //
  // Each check compares the matched text, never the whole workflow: node
  // --test can stall while it reports a failed assertion whose actual is a
  // whole workflow file, so the failure this test exists for must stay small.
  const refused = [
    /uses:\s*\.\/|\.github\/actions\/|secrets:\s*inherit|uses:\s*[\w.-]+\/[\w.-]+\/\.github\/workflows\//,
    /toJSON\(\s*secrets\s*\)/i,
    /\bsecrets\s*\[(?!\s*(?:'[^'\n]*'|"[^"\n]*")\s*\])/i
  ];
  const refusedInStructure = [
    /^\s*\?(?:\s|$)/m,
    /^\s*<<\s*:/m,
    /:\s+[&*][A-Za-z_][\w-]*(?:\s|$)/m,
    /^\s*-\s+\*[A-Za-z_]/m,
    /^\s*(?:-\s+)?"[^"\n]*\\[^\n]*"\s*:/m
  ];
  for (const { file, text } of workflows) {
    const message = `the tokens reach no job through a composite action, inherited secrets, toJSON(secrets), a computed secrets index or a YAML indirection (${file})`;
    for (const pattern of refused) {
      assert.equal(text.match(pattern)?.[0] ?? null, null, message);
    }
    const structure = structureOf(text);
    for (const pattern of refusedInStructure) {
      assert.equal(structure.match(pattern)?.[0] ?? null, null, message);
    }
  }
});

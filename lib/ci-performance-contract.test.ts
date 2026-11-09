import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSyncBounded } from "./bounded-spawn";

const root = process.cwd();
const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1);
  const next = ci.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

test("the existing required check fails for every unsuccessful parallel dependency", () => {
  const gate = job("app");
  assert.match(gate, /name: Typecheck, Unit Tests, Build\n/);
  assert.match(gate, /needs:\n\s+- tests\n\s+- pages\n/);
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(gate, /TEST_RESULT: \$\{\{ needs\.tests\.result \}\}/);
  assert.match(gate, /BUILD_RESULT: \$\{\{ needs\.pages\.result \}\}/);
  assert.doesNotMatch(gate, /continue-on-error/);
  const script = gate.split("        run: |\n")[1]?.replace(/^ {10}/gm, "").trim();
  assert.ok(script);
  for (const tests of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const builds of ["success", "failure", "cancelled", "skipped", ""]) {
      const result = spawnSyncBounded("bash", ["-c", script], {
        env: { ...process.env, TEST_RESULT: tests, BUILD_RESULT: builds }, encoding: "utf8"
      });
      assert.equal(result.status === 0, tests === "success" && builds === "success", `${tests}/${builds}: ${result.stderr}`);
    }
  }
});

test("tests and builds execute independently while preserving every validation step", () => {
  const tests = job("tests");
  const pages = job("pages");
  for (const lane of [tests, pages]) {
    assert.doesNotMatch(lane, /\n {4}(?:needs|if):|continue-on-error/);
    assert.match(lane, /run: npm ci\n/);
  }
  // Both jobs' history is held below, through the workflow parser: the tests job by the history rule, the pages job for its release evidence.
  for (const command of ["typecheck", "cf:typecheck", "test:unit", "corrections:verify-history", "transparency:verify-history", "transparency:log:check", "verify:report", "calibration:pilot-carrier-gate"]) {
    assert.ok(tests.includes(`npm run ${command}`), command);
  }
  for (const command of ["build", "build:pages", "test:smoke:static", "release:evidence"]) {
    assert.ok(pages.includes(`npm run ${command}`), command);
  }
  assert.ok(pages.indexOf("npm run test:smoke:static") < pages.indexOf("npm run release:evidence"));
});

test("only superseded PR runs can be automatically cancelled", () => {
  const concurrency = ci.slice(ci.indexOf("\nconcurrency:"), ci.indexOf("\nenv:"));
  assert.match(concurrency, /github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id/);
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("Docker dependencies are independent of source identity while all source checks remain required", () => {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  const [, afterDeps] = dockerfile.split("FROM playwright-base AS deps\n");
  assert.ok(afterDeps, "the reusable dependency layers must form the deps stage");
  const [deps, build] = afterDeps.split("FROM deps AS build\n");
  assert.ok(build, "the build stage must start from exactly those dependency layers");
  assert.ok(deps.indexOf("COPY package.json package-lock.json ./") < deps.indexOf("RUN npm ci && npx playwright install chromium"));
  for (const sourceBound of ["ARG ", "COPY . .", "SITE_BEHAVIOR_LAB_BUILD_COMMIT", "RUN npm run check"]) {
    assert.ok(!deps.includes(sourceBound), `the cached deps stage must not depend on ${sourceBound.trim()}`);
  }
  const identity = build.indexOf("ARG SITE_BEHAVIOR_LAB_BUILD_COMMIT");
  const source = build.indexOf("COPY . .");
  const checks = build.indexOf("RUN npm run check");
  assert.ok(identity >= 0 && identity < source && source < checks);
  assert.ok(build.indexOf("ENV SITE_BEHAVIOR_LAB_BUILD_COMMIT=") < checks);
  assert.match(build, /must be a full lowercase Git SHA/);
  assert.match(dockerfile, /^COPY --from=build \/app\/node_modules \.\/node_modules$/m);
});

test("Docker cache reuse still builds and exercises the exact checkout before recording evidence", () => {
  const docker = job("docker");
  const build = docker.indexOf("- name: Build exact deployable Docker image");
  const smoke = docker.indexOf("- name: Smoke deployable Docker image");
  const evidence = docker.indexOf("- name: Record exact-SHA container build evidence");
  assert.ok(build > 0 && smoke > build && evidence > smoke);
  assert.match(docker, /test "\$commit" = "\$GITHUB_SHA"/);
  assert.match(docker, /proof=\$\(node scripts\/measurement-candidate-build-proof\.mjs\)/);
  const buildStep = docker.slice(build, docker.indexOf("- name: Finish installing host Chromium"));
  assert.ok(buildStep.length > 0 && docker.indexOf("- name: Finish installing host Chromium") < smoke);
  assert.match(buildStep, /context: \.\n/);
  assert.match(buildStep, /load: true\n\s+push: false/);
  assert.match(buildStep, /SITE_BEHAVIOR_LAB_BUILD_COMMIT=\$\{\{ steps\.container_inputs\.outputs\.commit \}\}/);
  assert.match(buildStep, /SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF=\$\{\{ steps\.container_inputs\.outputs\.proof \}\}/);
  assert.match(buildStep, /cache-from: type=gha,scope=scanner-amd64-v1,version=2\n/);
  // Every layer of this build after COPY . . is specific to one commit, so the
  // exact image never exports cache; only the deps stage refresh below does.
  assert.doesNotMatch(buildStep, /cache-to:|target:/);
  assert.doesNotMatch(buildStep, /continue-on-error|\n\s+if:/);
  const refresh = docker.slice(docker.indexOf("- name: Refresh the dependency-layer cache"), build);
  assert.ok(docker.indexOf("- name: Refresh the dependency-layer cache") > 0, "the deps cache refresh must precede the exact build");
  assert.match(refresh, /target: deps\n/);
  assert.match(refresh, /push: false\n/);
  assert.doesNotMatch(refresh, /load: true|build-args:|tags:/);
  assert.match(refresh, /cache-from: type=gha,scope=scanner-amd64-v1,version=2\n/);
  assert.match(refresh, /cache-to: type=gha,scope=scanner-amd64-v1,version=2,mode=max\n/);
  assert.doesNotMatch(refresh, /continue-on-error|\n\s+if:/);
  // The smoke step's host browser installs in the background during the
  // build; the smoke cannot start until that exact install has succeeded.
  const start = docker.slice(docker.indexOf("- name: Start installing host Chromium"), docker.indexOf("- name: Set up Docker layer caching"));
  assert.match(start, /npx playwright install --with-deps chromium > "\$RUNNER_TEMP\/host-chromium-install\.log" 2>&1; echo "\$\?" > "\$RUNNER_TEMP\/host-chromium-install\.status"/);
  const finish = docker.slice(docker.indexOf("- name: Finish installing host Chromium"), smoke);
  assert.match(finish, /exit "\$\(cat "\$RUNNER_TEMP\/host-chromium-install\.status"\)"/);
  for (const step of [start, finish]) assert.doesNotMatch(step, /continue-on-error|\n\s+if:/);
  const smokeStep = docker.slice(smoke, docker.indexOf("- name: Scan smoke-tested container image with Trivy"));
  assert.match(smokeStep, /DOCKER_SMOKE_SKIP_BUILD: "1"/);
  assert.match(smokeStep, /DOCKER_SMOKE_PUBLIC_R2: "1"/);
  assert.doesNotMatch(smokeStep, /continue-on-error|\n\s+if:/);
});

/**
 * Every workflow job that runs the unit suite checks out the whole history, and this file owns that
 * rule. lib/formal-verification-register.test.ts reads, from git, the commit each claim of
 * docs/formal-verification.md names, and refuses a shallow or partial clone rather than guess, so a
 * job that ran the suite on a default checkout would fail there. A ruling of batch F6: every job
 * whose text names `test:unit`, or runs `npm run check`, checks out with `fetch-depth: 0`, no
 * `filter:` and no sparse checkout in each checkout step's own `with:` block, and CI's tests job runs
 * the unit suite unconditionally. The refresh job's test step stays conditional on its adoption check,
 * by design. The parser reads keys and values with their quotes and trailing comments gone, and
 * fails closed: in a job it holds, a line it cannot place is a problem of its own, so a layout it was
 * not written for is refused rather than misread. The pages job is held to the same checkout through
 * the same parser, for the history its release evidence reads.
 */
type WorkflowStep = { index: number; uses: string; run: string; condition: string | null; with: Map<string, string> };
type WorkflowJob = { steps: WorkflowStep[]; text: string[]; unread: number[] };

/** A scalar as YAML reads it here: a trailing comment and one pair of surrounding quotes gone. */
function scalar(value: string): string {
  const bare = value.replace(/(?:^|\s+)#.*$/, "").trim();
  return /^(["'])(.*)\1$/.exec(bare)?.[2] ?? bare;
}

/** A `key: value` line at exactly this indentation, the key bare or quoted, or null. */
function keyLine(line: string, indent: number): { key: string; value: string } | null {
  const match = new RegExp(`^ {${indent}}(["']?)([A-Za-z0-9_-]+)\\1\\s*:(?:\\s+(.*))?$`).exec(line);
  return match ? { key: match[2], value: scalar(match[3] ?? "") } : null;
}

function workflowJobs(text: string): Map<string, WorkflowJob> {
  const lines = text.split("\n");
  const jobs = new Map<string, WorkflowJob>();
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, "a workflow with no jobs");
  // Lines before the first header a job can be read from belong to a job of their own, so a layout the parser does not read is held, not dropped.
  let job: WorkflowJob = { steps: [], text: [], unread: [] };
  jobs.set("(before the first job)", job);
  let inSteps = false;
  let step: WorkflowStep | null = null;
  let key = "";
  for (let at = start + 1; at < lines.length; at += 1) {
    const line = lines[at];
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const unread = () => {
      job.unread.push(at + 1);
      step = null;
    };
    if (line.trim() === "" || line.trim().startsWith("#")) {
      job.text.push(line);
      continue;
    }
    // A top-level key ends the jobs; a line led by a tab is no key at all, and falls to the refusal below.
    if (/^\S/.test(line)) break;
    const header = indent === 2 ? keyLine(line, 2) : null;
    if (header !== null && header.value === "") {
      job = { steps: [], text: [], unread: [] };
      jobs.set(header.key, job);
      inSteps = false;
      step = null;
      continue;
    }
    job.text.push(line);
    if (indent <= 2 || /^ *\t/.test(line)) {
      unread();
      continue;
    }
    if (indent === 4) {
      const entry = keyLine(line, 4);
      if (entry === null) unread();
      else {
        inSteps = entry.key === "steps" && entry.value === "";
        step = null;
      }
      continue;
    }
    if (!inSteps) continue;
    const item = /^ {6}- (\S.*)$/.exec(line);
    if (item) {
      step = { index: job.steps.length + 1, uses: "", run: "", condition: null, with: new Map() };
      job.steps.push(step);
    }
    const entry = item ? keyLine(`        ${item[1]}`, 8) : indent === 8 ? keyLine(line, 8) : null;
    const current = step as WorkflowStep | null;
    if (current === null || (indent < 10 && entry === null)) {
      unread();
      continue;
    }
    if (entry !== null) {
      key = entry.key;
      if (key === "uses") current.uses = entry.value;
      if (key === "run") current.run = entry.value;
      if (key === "if") current.condition = entry.value;
      continue;
    }
    if (key === "with" || key === "env") {
      const inner = indent === 10 ? keyLine(line, 10) : null;
      if (indent === 10 && inner === null) unread();
      if (key === "with" && inner !== null) current.with.set(inner.key, inner.value);
      continue;
    }
    if (key === "run") current.run += `\n${line.trim()}`;
    if (key === "if") current.condition = `${current.condition ?? ""} ${line.trim()}`;
  }
  return jobs;
}

/** A step or a job line that runs the unit suite: any mention of test:unit, or npm running check, quoted or not, by run or run-script, with any flags between. */
const RUNS_THE_SUITE = /(?<![\w:-])test:unit(?![\w:-])|\bnpm\s(?:.*\s)?run(?:-script)?\s(?:.*\s)?["']?check(?![\w:-])/;

/** Every way one job's checkouts fail to bring the whole history, as `file job: problem`. */
function checkoutProblems(file: string, name: string, job: WorkflowJob): string[] {
  const problems: string[] = [];
  if (job.unread.length > 0) problems.push(`${file} ${name}: line ${job.unread[0]} is not read`);
  if (job.text.some((line) => /sparse-checkout/.test(line))) problems.push(`${file} ${name}: checks out sparsely`);
  const checkouts = job.steps.filter((step) => step.uses.startsWith("actions/checkout@"));
  if (checkouts.length === 0) problems.push(`${file} ${name}: has no checkout`);
  for (const checkout of checkouts) {
    if (checkout.with.get("fetch-depth") !== "0") problems.push(`${file} ${name}: checkout step ${checkout.index} is not fetch-depth: 0`);
    if (checkout.with.has("filter")) problems.push(`${file} ${name}: checkout step ${checkout.index} filters objects`);
  }
  return problems;
}

/** Every way a workflow's unit-suite job can fail the history rule, as `file job: problem`. */
function historyProblems(workflows: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const running: string[] = [];
  for (const [file, text] of workflows) {
    for (const [name, job] of workflowJobs(text)) {
      if (!job.text.some((line) => RUNS_THE_SUITE.test(line))) continue;
      if (job.steps.some((step) => RUNS_THE_SUITE.test(step.run))) running.push(`${file} ${name}`);
      problems.push(...checkoutProblems(file, name, job));
      if (file === "ci.yml" && name === "tests") {
        for (const step of job.steps) if (RUNS_THE_SUITE.test(step.run) && step.condition !== null) problems.push(`${file} ${name}: step ${step.index} runs the unit suite under a condition`);
      }
    }
  }
  for (const expected of ["ci.yml tests", "update-brave-lists.yml refresh-lists"]) {
    if (!running.includes(expected)) problems.push(`${expected}: no longer runs the unit suite`);
  }
  return problems;
}

function pagesProblems(workflows: ReadonlyMap<string, string>): string[] {
  const pages = workflowJobs(workflows.get("ci.yml") ?? "jobs:").get("pages");
  return pages === undefined ? ["ci.yml pages: no longer a job"] : checkoutProblems("ci.yml", "pages", pages);
}

const workflowDirectory = path.join(root, ".github/workflows");
const WORKFLOWS: ReadonlyMap<string, string> = new Map(
  readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => [name, readFileSync(path.join(workflowDirectory, name), "utf8")])
);

/** The workflows with one file's text changed by an exact edit that must land once. */
function editedWorkflows(file: string, find: string, replace: string, base: ReadonlyMap<string, string> = WORKFLOWS): Map<string, string> {
  const text = base.get(file) ?? "";
  assert.equal(text.split(find).length - 1, 1, `the edit must land exactly once in ${file}`);
  return new Map([...base, [file, text.replace(find, () => replace)]]);
}

/** The same, with the edit landing at the first `find` after a job's header, for text a workflow repeats. */
function editedInJob(file: string, job: string, find: string, replace: string): Map<string, string> {
  const text = WORKFLOWS.get(file) ?? "";
  const header = text.indexOf(`\n  ${job}:\n`);
  const at = text.indexOf(find, header);
  assert.ok(header >= 0 && at > header, `${find} after ${job} in ${file}`);
  return new Map([...WORKFLOWS, [file, text.slice(0, at) + replace + text.slice(at + find.length)]]);
}

// Spelled without the actions' pinned digests, which lib/pinned-action-consistency.test.ts keeps to its own list of files.
const REFRESH_CHECKOUT_DEPTH = "        with:\n          fetch-depth: 0\n\n      - name: Set up Node\n";
const SECOND_CHECKOUT = "      - name: Checkout beside it\n        uses: actions/checkout@v7\n        with:\n          path: beside\n          fetch-depth: 0\n\n";
const SHALLOW_SECOND_CHECKOUT = "      - name: Checkout beside it\n        uses: actions/checkout@v7\n        with:\n          path: beside\n\n";
const CI_UNIT_STEP = "      - name: Unit tests\n        run: npm run test:unit\n";
const withWorkflow = (name: string, text: string): Map<string, string> => new Map([...WORKFLOWS, [name, text]]);
const refreshSuiteRun = (run: string) => refreshDepth("fetch-depth: 1", editedWorkflows("update-brave-lists.yml", "        run: npm run test:unit\n", `        run: ${run}\n`));
const refreshDepth = (value: string, base?: ReadonlyMap<string, string>) => editedWorkflows("update-brave-lists.yml", REFRESH_CHECKOUT_DEPTH, REFRESH_CHECKOUT_DEPTH.replace("fetch-depth: 0", value), base);

test("every job that runs the unit suite checks out the whole history, unfiltered", () => {
  assert.deepEqual(historyProblems(WORKFLOWS), []);
});

for (const [name, workflows, problems] of [
  ["the refresh job's checkout loses its depth", () => editedWorkflows("update-brave-lists.yml", REFRESH_CHECKOUT_DEPTH, "\n      - name: Set up Node\n"), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  ["the refresh job's checkout at a depth of one commit", () => refreshDepth("fetch-depth: 1"), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  [
    "a second checkout into a path holds the depth while the first is shallow",
    () => editedWorkflows("update-brave-lists.yml", REFRESH_CHECKOUT_DEPTH, `\n${SECOND_CHECKOUT}      - name: Set up Node\n`),
    ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]
  ],
  ["a shallow second checkout after a deep one", () => editedInJob("ci.yml", "tests", "      - name: Set up Node\n", `${SHALLOW_SECOND_CHECKOUT}      - name: Set up Node\n`), ["ci.yml tests: checkout step 2 is not fetch-depth: 0"]],
  ["CI's tests checkout filtered to no blobs", () => editedInJob("ci.yml", "tests", "          fetch-depth: 0\n", "          fetch-depth: 0\n          filter: blob:none\n"), ["ci.yml tests: checkout step 1 filters objects"]],
  ["CI's tests checkout filtered to no trees", () => editedInJob("ci.yml", "tests", "          fetch-depth: 0\n", "          fetch-depth: 0\n          filter: tree:0\n"), ["ci.yml tests: checkout step 1 filters objects"]],
  ["CI's tests checkout filtered under a quoted key", () => editedInJob("ci.yml", "tests", "          fetch-depth: 0\n", '          fetch-depth: 0\n          "filter": blob:none\n'), ["ci.yml tests: checkout step 1 filters objects"]],
  ["CI's tests checkout filtered with a space before the colon", () => editedInJob("ci.yml", "tests", "          fetch-depth: 0\n", "          fetch-depth: 0\n          filter : blob:none\n"), ["ci.yml tests: checkout step 1 filters objects"]],
  ["the refresh job's checkout made sparse", () => refreshDepth("fetch-depth: 0\n          sparse-checkout: lib"), ["update-brave-lists.yml refresh-lists: checks out sparsely"]],
  ["the refresh job's checkout replaced by another action", () => editedInJob("update-brave-lists.yml", "refresh-lists", "        uses: actions/checkout@", "        uses: actions/not-checkout@"), ["update-brave-lists.yml refresh-lists: has no checkout"]],
  ["CI's unit test step made conditional", () => editedWorkflows("ci.yml", CI_UNIT_STEP, "      - name: Unit tests\n        if: false\n        run: npm run test:unit\n"), ["ci.yml tests: step 16 runs the unit suite under a condition"]],
  ["CI's unit test step under an expression", () => editedWorkflows("ci.yml", CI_UNIT_STEP, "      - name: Unit tests\n        if: github.event_name == 'push'\n        run: npm run test:unit\n"), ["ci.yml tests: step 16 runs the unit suite under a condition"]],
  ["CI's tests job runs the typecheck in place of the unit suite", () => editedWorkflows("ci.yml", CI_UNIT_STEP, "      - name: Unit tests\n        run: npm run typecheck\n"), ["ci.yml tests: no longer runs the unit suite"]],
  ["the refresh job's suite run through run-script, with a shallow checkout", () => refreshSuiteRun("npm run-script test:unit"), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  ["the refresh job running check, quoted, with a shallow checkout", () => refreshSuiteRun('npm run "check"'), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  ["the refresh job running check, single-quoted, with a shallow checkout", () => refreshSuiteRun("npm run 'check'"), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  ["the refresh job running check through run-script, with a shallow checkout", () => refreshSuiteRun("npm run-script check"), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  ["the refresh job running check with a flag before run, with a shallow checkout", () => refreshSuiteRun("npm --silent run check"), ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  [
    "a workflow indented four spaces, with no checkout the parser can read",
    () => withWorkflow("four-spaces.yml", "on: push\njobs:\n    unit:\n        runs-on: ubuntu-24.04\n        steps:\n            - uses: actions/checkout@v7\n            - run: npm run test:unit\n"),
    ["four-spaces.yml (before the first job): has no checkout"]
  ],
  [
    "a first job header that carries a value, with a shallow checkout",
    () => withWorkflow("anchored.yml", "on: push\njobs:\n  unit: &unit\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v7\n      - run: npm run test:unit\n"),
    ["anchored.yml (before the first job): line 3 is not read", "anchored.yml (before the first job): checkout step 1 is not fetch-depth: 0"]
  ],
  ["a top-level key after the jobs, naming the suite", () => withWorkflow("after.yml", "on: push\njobs:\n  lint:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo lint\nenv:\n  SUITE: test:unit\n"), []],
  ["a step list indented four spaces", () => editedInJob("update-brave-lists.yml", "refresh-lists", "      - name: Set up Node\n", "    - name: Set up Node\n"), ["update-brave-lists.yml refresh-lists: line 82 is not read"]],
  ["the refresh job's depth indented nine spaces", () => editedWorkflows("update-brave-lists.yml", REFRESH_CHECKOUT_DEPTH, REFRESH_CHECKOUT_DEPTH.replace("          fetch-depth: 0", "         fetch-depth: 0")), ["update-brave-lists.yml refresh-lists: line 80 is not read", "update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0"]],
  ["a with block holding a line that is no key", () => editedInJob("ci.yml", "tests", "          fetch-depth: 0\n", "          fetch-depth: 0\n          - beside\n"), ["ci.yml tests: line 252 is not read"]],
  ["a line led by a tab inside a job", () => editedWorkflows("update-brave-lists.yml", "\n  refresh-lists:\n", "\n  refresh-lists:\n\tname: stray\n"), ["update-brave-lists.yml refresh-lists: line 59 is not read"]],
  ["a stray line at a job header's indentation, before its steps", () => editedWorkflows("update-brave-lists.yml", "\n  refresh-lists:\n", "\n  refresh-lists:\n  - stray\n"), ["update-brave-lists.yml refresh-lists: line 59 is not read"]],
  [
    "the refresh job's header given a value",
    () => editedWorkflows("update-brave-lists.yml", "\n  refresh-lists:\n", "\n  refresh-lists: ~\n"),
    ["update-brave-lists.yml measurement-freeze-notice: line 58 is not read", "update-brave-lists.yml refresh-lists: no longer runs the unit suite"]
  ],
  [
    "the refresh job's suite named only in a step's environment, with a shallow checkout",
    () => refreshDepth("fetch-depth: 1", editedWorkflows("update-brave-lists.yml", "        run: npm run test:unit\n", '        env:\n          SUITE: test:unit\n        run: npm run "$SUITE"\n')),
    ["update-brave-lists.yml refresh-lists: checkout step 1 is not fetch-depth: 0", "update-brave-lists.yml refresh-lists: no longer runs the unit suite"]
  ],
  ["the refresh job's depth quoted", () => refreshDepth('fetch-depth: "0"'), []],
  ["the refresh job's depth single-quoted, with a comment", () => refreshDepth("fetch-depth: '0' # all of it"), []],
  ["the refresh job's header with a trailing comment", () => editedWorkflows("update-brave-lists.yml", "\n  refresh-lists:\n", "\n  refresh-lists: # the weekly refresh\n"), []],
  ["the refresh job's checkout under a quoted key", () => editedInJob("update-brave-lists.yml", "refresh-lists", "        uses: actions/checkout@", '        "uses": actions/checkout@'), []],
  ["CI's unit suite run with a flag before its name", () => editedWorkflows("ci.yml", CI_UNIT_STEP, "      - name: Unit tests\n        run: npm run --silent test:unit\n"), []]
] as const) {
  test(`the history rule reads ${name}`, () => {
    assert.deepEqual(historyProblems(workflows()), problems);
  });
}

test("the pages job checks out the whole history, unfiltered, through the same parser", () => {
  assert.deepEqual(pagesProblems(WORKFLOWS), []);
  assert.deepEqual(pagesProblems(editedInJob("ci.yml", "pages", "          fetch-depth: 0\n", "          # fetch-depth: 0\n")), ["ci.yml pages: checkout step 1 is not fetch-depth: 0"]);
  assert.deepEqual(pagesProblems(editedInJob("ci.yml", "pages", "          fetch-depth: 0\n", "          fetch-depth: 0\n         stray: x\n")), ["ci.yml pages: line 385 is not read"]);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type CiJob = { name?: string; conclusion?: string | null };
type Checker = {
  requiredCiJobs: (root?: string) => string[];
  unmetRequiredJobs: (payload: unknown, required: readonly string[]) => string[];
};

const ROOT = process.cwd();
const source = (relative: string) => readFile(path.join(ROOT, relative), "utf8");

// The checker is plain ESM the workflows invoke directly; load it the way the
// runtime does rather than compiling a second copy through the test build.
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<Checker>;
const checker = nativeImport(
  pathToFileURL(path.join(ROOT, "scripts", "verify-required-ci-jobs.mjs")).href
);

test("every required job name is a job CI actually declares", async () => {
  // The gate list and the jobs that exist must agree. Renaming a CI job
  // without updating the list would otherwise leave a gate that can never be
  // satisfied, or worse, silently drop one from the required set.
  const ci = await source(".github/workflows/ci.yml");
  const declared = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((match) => match[1].trim());

  const { requiredCiJobs } = await checker;
  for (const required of requiredCiJobs(ROOT)) {
    assert.ok(
      declared.includes(required),
      `.github/required-ci-jobs.json requires "${required}", which .github/workflows/ci.yml does not declare`
    );
  }
});

test("the promotion gate and the release gate verify the same required jobs", async () => {
  // This list used to be restated inline per workflow. Both paths now call one
  // checker against one file, and neither may hard-code a job name again: two
  // copies of a gate list are how a gate quietly stops being required on one
  // path while still passing on the other.
  const { requiredCiJobs } = await checker;
  const promote = await source(".github/workflows/promote-production.yml");
  const release = await source(".github/workflows/release.yml");

  for (const workflow of [promote, release]) {
    assert.match(workflow, /node scripts\/verify-required-ci-jobs\.mjs/);
  }
  for (const job of requiredCiJobs(ROOT)) {
    assert.ok(
      !promote.includes(job) && !release.includes(job),
      `"${job}" is restated inside a workflow; the required list belongs only in .github/required-ci-jobs.json`
    );
  }

  // The checker must be on disk before either workflow runs it.
  assert.ok(
    promote.indexOf("uses: actions/checkout") < promote.indexOf("verify-required-ci-jobs.mjs"),
    "promote-production must check out the repository before invoking the checker"
  );
  assert.ok(
    release.indexOf("uses: actions/checkout") < release.indexOf("verify-required-ci-jobs.mjs"),
    "release must check out the repository before invoking the checker"
  );
});

test("a skipped or failed required job is refused, and a run-level success is not enough", async () => {
  const { requiredCiJobs, unmetRequiredJobs } = await checker;
  const required = requiredCiJobs(ROOT);
  const success: CiJob[] = required.map((name) => ({ name, conclusion: "success" }));

  assert.deepEqual(unmetRequiredJobs([{ jobs: success }], required), []);
  // Unpaginated single-object payloads are accepted too.
  assert.deepEqual(unmetRequiredJobs({ jobs: success }, required), []);

  // The exact hole this closes: a run concludes success while a required job
  // was skipped entirely, so it never appears in the jobs list.
  const missing = success.filter((job: CiJob) => job.name !== required[0]);
  assert.deepEqual(unmetRequiredJobs([{ jobs: missing }], required), [
    `${required[0]}: expected exactly one job, found 0`
  ]);

  const failed = success.map((job: CiJob) => (job.name === required[1] ? { ...job, conclusion: "failure" } : job));
  assert.deepEqual(unmetRequiredJobs([{ jobs: failed }], required), [`${required[1]}: failure`]);

  const cancelled = success.map((job: CiJob) => (job.name === required[1] ? { ...job, conclusion: null } : job));
  assert.deepEqual(unmetRequiredJobs([{ jobs: cancelled }], required), [`${required[1]}: no conclusion`]);

  // A duplicated job name is ambiguous evidence, not double proof.
  assert.deepEqual(unmetRequiredJobs([{ jobs: [...success, success[0]] }], required), [
    `${required[0]}: expected exactly one job, found 2`
  ]);
});

test("the release gate binds the CI run to this repository's main branch", async () => {
  const release = await source(".github/workflows/release.yml");

  // A head_sha-only query would accept a pull_request run or a fork run. Push
  // and explicit workflow_dispatch runs are both trusted only when they ran
  // this repository's CI on main; data workflows need the dispatch path.
  assert.match(release, /branch=main&per_page=100/);
  assert.match(release, /run\?\.head_branch === "main"/);
  assert.match(release, /run\?\.event === "push" \|\| run\?\.event === "workflow_dispatch"/);
  assert.match(release, /run\?\.head_repository\?\.full_name === process\.env\.GITHUB_REPOSITORY/);
  assert.match(release, /No successful trusted main-branch CI run recorded for/);

  // The tagged revision is named by the operator, never inferred.
  assert.match(release, /commit must be a full 40-character lowercase SHA/);
  assert.match(release, /required: true\n {8}type: string\n$|commit:[\s\S]*?required: true/);

  // The uploaded receipt expires; the tag records its digest so the receipt
  // stays identifiable after that.
  assert.match(release, /Release receipt sha256:/);
});

test("the corrections baseline is an explicit trusted revision, never a relative fallback", async () => {
  // The baseline decides what append-only is measured against. A `HEAD^`
  // fallback compared exactly one commit back, so a manual run could rewrite
  // the ledger across two commits and still pass; a first push to a new ref
  // reports the all-zero SHA, which is not a baseline either.
  const ci = await source(".github/workflows/ci.yml");
  const step = ci.slice(ci.indexOf("Resolve the trusted corrections baseline"));

  // Comments may name the old fallback to explain why it went; executable
  // lines may not reintroduce it.
  const executable = ci
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(executable, /HEAD\^/, "no relative fallback may decide the corrections baseline");
  assert.match(step, /case "\$EVENT_NAME" in/);
  assert.match(step, /pull_request\) candidate="\$PULL_REQUEST_BASE"/);
  assert.match(step, /push\) candidate="\$PUSH_BEFORE"/);
  // A dispatch carries neither, so it falls back to the last promoted state.
  assert.match(step, /git fetch --no-tags --quiet origin production/);
  assert.match(step, /zero="0{40}"/);

  // Fail closed: malformed, absent, or unrelated baselines must all refuse.
  assert.match(step, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(step, /git cat-file -e "\$\{candidate\}\^\{commit\}"/);
  assert.match(step, /git merge-base --is-ancestor "\$candidate" HEAD/);
  for (const refusal of [
    /Refusing to verify against a malformed baseline/,
    /is not a commit in this checkout/,
    /is not an ancestor of HEAD/
  ]) {
    assert.match(step, refusal);
  }

  // The verifier must consume the resolved value, not re-derive its own.
  assert.match(
    ci,
    /npm run corrections:verify-history -- "\$\{\{ steps\.corrections_baseline\.outputs\.baseline \}\}"/
  );
});

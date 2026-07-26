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

  // A head_sha-only query would accept a pull_request run, a fork run, or a
  // dispatch, none of which prove main was green at that revision.
  assert.match(release, /branch=main&event=push/);
  assert.match(release, /run\?\.head_branch === "main"/);
  assert.match(release, /run\?\.head_repository\?\.full_name === process\.env\.GITHUB_REPOSITORY/);
  assert.match(release, /No successful main-branch CI run recorded for/);

  // The tagged revision is named by the operator, never inferred.
  assert.match(release, /commit must be a full 40-character lowercase SHA/);
  assert.match(release, /required: true\n {8}type: string\n$|commit:[\s\S]*?required: true/);

  // The uploaded receipt expires; the tag records its digest so the receipt
  // stays identifiable after that.
  assert.match(release, /Release receipt sha256: \$\{RECEIPT_SHA256\}/);
});

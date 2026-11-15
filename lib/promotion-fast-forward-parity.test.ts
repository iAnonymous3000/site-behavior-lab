import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// CI promotes production directly, and promote-production.yml is the fallback
// that makes the same move when the direct push fails (it earned its place
// during a GitHub incident that refused the direct promotion). The two files
// hold one set of fast-forward rules twice. Each copy passes its own tests, so
// without this file one could be loosened while the other still looks right,
// and production would move under whichever copy ran. This test holds the
// copies equal; it does not decide what the rules should be.

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, ...relative.split("/")), "utf8");

const DIRECT = ".github/workflows/ci.yml";
const FALLBACK = ".github/workflows/promote-production.yml";
const STEP = "      - name: Fast-forward production to the tested SHA";
// Each workflow learns the tested SHA from its own event, so this is the one
// line of the step that is meant to differ. Each is pinned to its source.
const CANDIDATE_LINES: Readonly<Record<string, string>> = {
  [DIRECT]: "          CANDIDATE: ${{ github.sha }}",
  [FALLBACK]: "          CANDIDATE: ${{ github.event.workflow_run.head_sha }}"
};
const PAUSE = "vars.SITE_BEHAVIOR_LAB_PROMOTION_PAUSED != '1'";

function lines(text: string): string[] {
  return text.split("\n");
}

/** The lines of one job, from its two-space header to the next job or the end. */
function jobLines(workflow: string, label: string, job: string): string[] {
  const all = lines(workflow);
  const starts = all.flatMap((line, index) => (line === `  ${job}:` ? [index] : []));
  assert.equal(starts.length, 1, `${label} must declare exactly one ${job} job`);
  const end = all.findIndex((line, index) => index > starts[0] && /^ {0,2}\S/.test(line));
  return all.slice(starts[0], end === -1 ? all.length : end);
}

/** One step, from its name line to the next step, job or top-level key. */
function stepLines(job: string[], label: string): string[] {
  const starts = job.flatMap((line, index) => (line === STEP ? [index] : []));
  assert.equal(starts.length, 1, `${label} must have exactly one fast-forward step`);
  const end = job.findIndex((line, index) => index > starts[0] && (/^ {6}- /.test(line) || /^ {0,3}\S/.test(line)));
  return job.slice(starts[0], end === -1 ? job.length : end);
}

/** Comments and blank lines are prose, not rules; every other byte counts. */
function ruleLines(step: string[]): string[] {
  return step.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

/** The folded `if:` expression of a job, one line per term. */
function ifTerms(job: string[], label: string): string[] {
  const start = job.findIndex((line) => line === "    if: >-");
  assert.notEqual(start, -1, `${label} must gate its promote job with a folded if: expression`);
  const terms: string[] = [];
  for (const line of job.slice(start + 1)) {
    if (!line.startsWith("      ")) break;
    terms.push(line.trim());
  }
  assert.ok(terms.length > 0, `${label} has an empty promote if: expression`);
  return terms;
}

function promotion(relative: string) {
  const workflow = read(relative);
  const job = jobLines(workflow, relative, "promote");
  return { workflow, job, rules: ruleLines(stepLines(job, relative)) };
}

test("both promotion paths fast-forward production by the same rules", () => {
  const direct = promotion(DIRECT);
  const fallback = promotion(FALLBACK);

  for (const [label, rules] of [[DIRECT, direct.rules], [FALLBACK, fallback.rules]] as const) {
    // An empty or truncated slice would compare equal to another empty one.
    assert.ok(rules.includes("        run: |"), `${label}: the fast-forward step has no run script`);
    assert.ok(
      rules.some((line) => line.includes('push origin "${CANDIDATE}:refs/heads/production"')),
      `${label}: the fast-forward step has no production push`
    );
    const candidates = rules.filter((line) => /^\s+CANDIDATE:/.test(line));
    assert.deepEqual(candidates, [CANDIDATE_LINES[label]], `${label} must take the tested SHA from its own event`);
  }

  const withoutCandidate = (rules: string[]) => rules.filter((line) => !/^\s+CANDIDATE:/.test(line));
  assert.deepEqual(
    withoutCandidate(fallback.rules),
    withoutCandidate(direct.rules),
    `the fast-forward step in ${FALLBACK} must equal the one in ${DIRECT}, comments aside`
  );
});

test("both promotion paths share one serialized concurrency group", () => {
  // ci.yml's comment says the shared group is what keeps the direct push and
  // the fallback from racing one ref update. A renamed group, or one that
  // cancels in progress, lets two promotions run at once.
  const direct = promotion(DIRECT);
  assert.match(
    direct.job.join("\n"),
    /^ {4}concurrency:\n {6}group: promote-production\n {6}cancel-in-progress: false$/m,
    `${DIRECT} promote job must join the promote-production group without cancelling`
  );
  const fallback = read(FALLBACK);
  assert.match(
    fallback,
    /^concurrency:\n {2}group: promote-production\n {2}cancel-in-progress: false$/m,
    `${FALLBACK} must join the promote-production group without cancelling`
  );
  assert.doesNotMatch(
    promotion(FALLBACK).job.join("\n"),
    /^ {4}concurrency:/m,
    `${FALLBACK} must not override its workflow concurrency in the job`
  );
});

test("both promotion paths stop while promotion is paused", () => {
  for (const label of [DIRECT, FALLBACK]) {
    const terms = ifTerms(promotion(label).job, label);
    assert.equal(terms.filter((term) => term === PAUSE).length, 1, `${label} promote job must test the pause variable once`);
    // Every term but the last is joined by &&, so the pause term is a
    // conjunct: no other term can promote around it.
    for (const term of terms.slice(0, -1)) {
      assert.ok(term.endsWith(" &&"), `${label}: promote if: term "${term}" is not joined by &&`);
    }
    // && binds tighter than ||, so an unbracketed || term would let its left
    // side promote without the pause term.
    for (const term of terms) {
      const bare = term.replace(/ &&$/, "");
      if (bare.includes("||")) {
        assert.ok(bare.startsWith("(") && bare.endsWith(")"), `${label}: promote if: term "${term}" must bracket its ||`);
      }
    }
    assert.doesNotMatch(terms.join(" "), /\|\|\s*$/, `${label}: promote if: ends in ||`);
  }
});

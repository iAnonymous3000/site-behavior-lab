import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DURABLE_CONFIG_PATH,
  DURABLE_DISABLED_MARKER,
  DURABLE_ENABLED_MARKER,
  durableReplayParentIssues,
  durableTransitionPlan
} from "./durable-replay-parent-lib.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const CONFIG_DISABLED = `{\n  "vars": {\n    ${DURABLE_DISABLED_MARKER},\n    "OTHER": "x"\n  }\n}\n`;

function base(overrides = {}) {
  return {
    parentSha: SHA_A,
    childShas: [],
    onDefaultBranch: true,
    configAtParent: CONFIG_DISABLED,
    ...overrides
  };
}

test("a commit with a free first-child slot on main qualifies", () => {
  assert.deepEqual(durableReplayParentIssues(base()), []);
});

test("a commit that already has a child is refused, and the message names the child", () => {
  const issues = durableReplayParentIssues(base({ childShas: [SHA_B] }));
  assert.equal(issues.length, 1);
  assert.match(issues[0], /already has a child/);
  assert.match(issues[0], new RegExp(SHA_B.slice(0, 12)));
  // The point of the message is that it tells the operator what to do next,
  // BEFORE a staging deployment is spent on the wrong parent.
  assert.match(issues[0], /re-run this preflight before capturing replay evidence/);
});

test("this is exactly why the archived receipts became ineligible", () => {
  // PR #98 archived receipts naming 78defca0; 0cf9e1c then landed as its child.
  // Same shape, real SHAs, so the regression is described by a test rather
  // than only by a comment.
  const spentParent = "78defca09e8543c3b5b6597fe14e13e959209104";
  const childThatSpentIt = "0cf9e1c09710b3cb0d030b2cd826fc5e8d9db90b";
  const issues = durableReplayParentIssues(
    base({ parentSha: spentParent, childShas: [childThatSpentIt] })
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /DIRECT first child/);
});

test("a commit off the default branch is refused", () => {
  const issues = durableReplayParentIssues(base({ onDefaultBranch: false }));
  assert.equal(issues.length, 1);
  assert.match(issues[0], /not on the default branch/);
});

test("the parent must carry exactly one disabled flag and no enabled flag", () => {
  assert.match(
    durableReplayParentIssues(base({ configAtParent: '{"vars":{}}' }))[0],
    /must contain exactly one/
  );
  assert.match(
    durableReplayParentIssues(
      base({ configAtParent: `${CONFIG_DISABLED}${DURABLE_DISABLED_MARKER}` })
    )[0],
    /must contain exactly one/
  );
  const alreadyEnabled = CONFIG_DISABLED.replace(DURABLE_DISABLED_MARKER, DURABLE_ENABLED_MARKER);
  const issues = durableReplayParentIssues(base({ configAtParent: alreadyEnabled }));
  assert.ok(issues.some((issue) => /already contains/.test(issue)));
});

test("a malformed sha is refused before anything else is inspected", () => {
  const issues = durableReplayParentIssues(base({ parentSha: "78defca" }));
  assert.deepEqual(issues, [
    "the intended replay parent must be a full 40-character lowercase commit sha"
  ]);
});

test("an unreadable config is reported rather than silently passing", () => {
  const issues = durableReplayParentIssues(base({ configAtParent: "" }));
  assert.ok(issues.some((issue) => issue.includes(DURABLE_CONFIG_PATH)));
});

test("the transition plan is the single substitution the binding will accept", () => {
  const plan = durableTransitionPlan(SHA_A, CONFIG_DISABLED);
  assert.deepEqual(plan.changes, [DURABLE_CONFIG_PATH]);
  assert.equal(plan.substitution.from, DURABLE_DISABLED_MARKER);
  assert.equal(plan.substitution.to, DURABLE_ENABLED_MARKER);
  assert.equal(
    plan.resultingConfigSha256Input,
    CONFIG_DISABLED.replace(DURABLE_DISABLED_MARKER, DURABLE_ENABLED_MARKER)
  );
  assert.ok(!plan.resultingConfigSha256Input.includes(DURABLE_DISABLED_MARKER));
});

test("the markers match the ones the binding actually enforces", () => {
  // Two files stating one contract is this repository's top defect class, so
  // read the binding's own literals rather than trusting a copy.
  const binding = readFileSync(
    path.join(process.cwd(), "lib", "measurement-candidate-binding.ts"),
    "utf8"
  );
  assert.ok(
    binding.includes(`const enabledMarker = '${DURABLE_ENABLED_MARKER}'`),
    "enabled marker drifted from lib/measurement-candidate-binding.ts"
  );
  assert.ok(
    binding.includes(`const disabledMarker = '${DURABLE_DISABLED_MARKER}'`),
    "disabled marker drifted from lib/measurement-candidate-binding.ts"
  );
  assert.ok(binding.includes(`MEASUREMENT_DURABLE_CONFIG_PATH = "${DURABLE_CONFIG_PATH}"`));
});

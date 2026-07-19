import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const workflow = readFileSync(path.join(root, ".github", "workflows", "production-health.yml"), "utf8");
const containerConfig = readFileSync(path.join(root, "wrangler.container.jsonc"), "utf8");

test("production health derives the durable-jobs expectation from the checked-out production config", () => {
  assert.match(workflow, /with:\n\s+ref: production/);
  assert.match(
    workflow,
    /PRODUCTION_CONFIG_FILE: \$\{\{ github\.workspace \}\}\/wrangler\.container\.jsonc/
  );
  assert.equal(
    workflow.includes(
      'source.matchAll(/"SITE_BEHAVIOR_LAB_DURABLE_JOBS"\\s*:\\s*"([^\"]*)"/g)'
    ),
    true
  );
  assert.match(workflow, /EXPECTED_DURABLE_JOBS=\$\{matches\[0\]\[1\]\}/);

  const declarations = [
    ...containerConfig.matchAll(/"SITE_BEHAVIOR_LAB_DURABLE_JOBS"\s*:\s*"([^"]*)"/g)
  ];
  assert.equal(declarations.length, 1);
  assert.match(declarations[0][1], /^[01]$/);
});

test("production health requires the exact durable-jobs posture for both reviewed flag states", () => {
  const enabledStart = workflow.indexOf('if (expectedDurableJobs === "1") {');
  const disabledStart = workflow.indexOf('} else if (expectedDurableJobs === "0") {', enabledStart);
  const postureEnd = workflow.indexOf('assertPosture(schema?.$id', disabledStart);

  assert.notEqual(enabledStart, -1);
  assert.notEqual(disabledStart, -1);
  assert.notEqual(postureEnd, -1);

  const enabledBranch = workflow.slice(enabledStart, disabledStart);
  assert.match(enabledBranch, /durableJobs\?\.requested === true/);
  assert.match(enabledBranch, /durableJobs\?\.enabled === true/);
  assert.match(enabledBranch, /durableJobs\?\.readiness === "ready"/);
  assert.match(enabledBranch, /durableJobs\?\.coordinatorOrigin === "https:\/\/scan\.sitebehavior\.org"/);

  const disabledBranch = workflow.slice(disabledStart, postureEnd);
  assert.match(disabledBranch, /durableJobs\?\.requested === false/);
  assert.match(disabledBranch, /durableJobs\?\.enabled === false/);
  assert.match(disabledBranch, /durableJobs\?\.readiness === "disabled"/);

  const unconditionalPosture = workflow.slice(
    workflow.indexOf('assertPosture(health?.checks?.v2ShadowEmission'),
    enabledStart
  );
  assert.match(unconditionalPosture, /durableJobs\?\.faultInjection === undefined/);
});

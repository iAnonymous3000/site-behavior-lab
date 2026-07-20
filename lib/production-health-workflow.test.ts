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

test("production health derives the encrypted-watch expectation from the reviewed production config", () => {
  assert.equal(
    workflow.includes(
      'source.matchAll(/"SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES"\\s*:\\s*"([^\"]*)"/g)'
    ),
    true
  );
  assert.match(workflow, /EXPECTED_ENCRYPTED_WATCHES=\$\{watchMatches\[0\]\[1\]\}/);

  const declarations = [
    ...containerConfig.matchAll(/"SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES"\s*:\s*"([^"]*)"/g)
  ];
  assert.equal(declarations.length, 1);
  assert.match(declarations[0][1], /^[01]$/);
});

test("production health derives the exact container-sharding topology from the reviewed config", () => {
  assert.equal(
    workflow.includes(
      'source.matchAll(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"\\s*:\\s*"([^\"]*)"/g)'
    ),
    true
  );
  assert.equal(
    workflow.includes(
      'source.matchAll(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT"\\s*:\\s*"([^\"]*)"/g)'
    ),
    true
  );
  assert.match(workflow, /EXPECTED_CONTAINER_SHARDING=\$\{shardingFlag\}/);
  assert.match(workflow, /EXPECTED_CONTAINER_SHARD_COUNT=\$\{shardCountWire\}/);
  assert.match(workflow, /shardingFlag === "1" && \(matches\[0\]\[1\] !== "1" \|\| shardCount < 2\)/);

  const flagDeclarations = [
    ...containerConfig.matchAll(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"\s*:\s*"([^"]*)"/g)
  ];
  const countDeclarations = [
    ...containerConfig.matchAll(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT"\s*:\s*"([^"]*)"/g)
  ];
  assert.equal(flagDeclarations.length, 1);
  assert.match(flagDeclarations[0][1], /^[01]$/);
  assert.equal(countDeclarations.length, 1);
  assert.match(countDeclarations[0][1], /^[1-3]$/);
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

test("production health requires exact encrypted-watch readiness and capability posture", () => {
  const enabledStart = workflow.indexOf('if (expectedEncryptedWatches === "1") {');
  const disabledStart = workflow.indexOf('} else if (expectedEncryptedWatches === "0") {', enabledStart);
  const postureEnd = workflow.indexOf('assertPosture(schema?.$id', disabledStart);

  assert.notEqual(enabledStart, -1);
  assert.notEqual(disabledStart, -1);
  assert.notEqual(postureEnd, -1);

  const enabledBranch = workflow.slice(enabledStart, disabledStart);
  assert.match(enabledBranch, /encryptedWatches\?\.requested === true/);
  assert.match(enabledBranch, /encryptedWatches\?\.enabled === true/);
  assert.match(enabledBranch, /encryptedWatches\?\.readiness === "ready"/);
  assert.match(enabledBranch, /scheduledRescans === true/);

  const disabledBranch = workflow.slice(disabledStart, postureEnd);
  assert.match(disabledBranch, /encryptedWatches\?\.requested === false/);
  assert.match(disabledBranch, /encryptedWatches\?\.enabled === false/);
  assert.match(disabledBranch, /encryptedWatches\?\.readiness === "disabled"/);
  assert.match(disabledBranch, /scheduledRescans === false/);
});

test("production health requires the exact effective container-sharding topology", () => {
  const enabledStart = workflow.indexOf('if (expectedContainerSharding === "1") {');
  const disabledStart = workflow.indexOf('} else if (expectedContainerSharding === "0") {', enabledStart);
  const postureEnd = workflow.indexOf('if (expectedEncryptedWatches === "1") {', disabledStart);

  assert.notEqual(enabledStart, -1);
  assert.notEqual(disabledStart, -1);
  assert.notEqual(postureEnd, -1);

  const enabledBranch = workflow.slice(enabledStart, disabledStart);
  assert.match(enabledBranch, /expectedDurableJobs === "1"/);
  assert.match(enabledBranch, /containerSharding\?\.requested === true/);
  assert.match(enabledBranch, /containerSharding\?\.enabled === true/);
  assert.match(enabledBranch, /containerSharding\?\.readiness === "ready"/);
  assert.match(enabledBranch, /containerSharding\?\.shardCount === expectedContainerShardCount/);

  const disabledBranch = workflow.slice(disabledStart, postureEnd);
  assert.match(disabledBranch, /containerSharding\?\.requested === false/);
  assert.match(disabledBranch, /containerSharding\?\.enabled === false/);
  assert.match(disabledBranch, /containerSharding\?\.readiness === "disabled"/);
  assert.match(disabledBranch, /containerSharding\?\.shardCount === 1/);
});

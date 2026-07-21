import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PRODUCTION_SYNTHETIC_TARGET,
  isProductionSyntheticMonitorToken,
  isProductionSyntheticScanPayload
} from "./production-synthetic";

const root = process.cwd();
const workflow = readFileSync(path.join(root, ".github", "workflows", "production-health.yml"), "utf8");
const containerConfig = readFileSync(path.join(root, "wrangler.container.jsonc"), "utf8");
const containerWorker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
const synthetic = readFileSync(path.join(root, "scripts", "smoke-production-synthetic.mjs"), "utf8");

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

test("production health supports independent dispatch and reconciles failures into a canonical issue", () => {
  assert.match(workflow, /- cron: "7 \* \* \* \*"/);
  assert.match(workflow, /- cron: "22,37,52 \* \* \* \*"/);
  assert.match(workflow, /repository_dispatch:[\s\S]*?- production-health/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /site-behavior-lab:production-health/);
  assert.match(workflow, /MANAGED_ISSUE_LABEL: site-behavior-lab-production-health/);
  assert.match(workflow, /issue\.user\?\.login === "github-actions\[bot\]"/);
  assert.match(workflow, /issue\.user\?\.type === "Bot"/);
  assert.match(workflow, /labels\.includes\(managedLabel\)/);
  assert.match(workflow, /issue\.title === process\.env\.ISSUE_TITLE/);
  assert.match(workflow, /issue_needs_label/);
  assert.match(workflow, /--add-label "\$MANAGED_ISSUE_LABEL"/);
  assert.match(workflow, /gh api --silent --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/labels"/);
  assert.match(workflow, /gh issue create[^\n]*--label "\$MANAGED_ISSUE_LABEL"/);
  assert.match(workflow, /gh issue create/);
  assert.match(workflow, /gh issue reopen/);
  assert.match(workflow, /gh issue close/);
  assert.match(workflow, /- name: Preserve production-health failure[\s\S]*?exit 1/);
});

test("the activated production synthetic proves scan execution plus remote report readback", () => {
  assert.match(workflow, /secrets\.PRODUCTION_SYNTHETIC_MONITOR_TOKEN/);
  assert.match(workflow, /vars\.PRODUCTION_SYNTHETIC_MONITOR_REQUIRED/);
  assert.match(workflow, /npm run test:smoke:production-synthetic/);
  assert.match(synthetic, /POST/);
  assert.match(synthetic, /\/api\/scan/);
  assert.match(synthetic, /singleReportTotalRequests/);
  assert.match(synthetic, /function assertFixedSyntheticReport/);
  assert.match(synthetic, /report\.schemaVersion !== 2 \|\| report\.schemaRevision !== 2/);
  assert.match(synthetic, /report\.run\?\.subject\?\.observed/);
  assert.match(synthetic, /const \{ runId, startedAt \} = assertFixedSyntheticReport\(report, resolved\.queuedReportId\)/);
  assert.match(synthetic, /savedReportRetainsScreenshot/);
  assert.match(synthetic, /assertFixedSyntheticReport\(saved, report\.share\.id, startedAt\)/);
  assert.match(synthetic, /savedRunId !== runId/);
  assert.match(synthetic, /submissionResponse\.status/);
  assert.match(synthetic, /response\.status !== 200/);
  assert.match(synthetic, /startedAtMs < submissionStartedAt - runStartedAtClockSkewMs/);
  assert.match(synthetic, /startedAtMs > Date\.now\(\) \+ runStartedAtClockSkewMs/);
  assert.match(synthetic, /singleReportTotalRequests\(saved\)/);
  assert.match(synthetic, /report\.share\.jsonPath/);
  assert.match(synthetic, /report\.share\.path/);
  assert.match(synthetic, /redirect: "error"/);
  assert.match(synthetic, /sameOriginUrl\(payload\.statusPath/);
  assert.match(synthetic, /sameOriginUrl\(report\.share\.jsonPath/);
  assert.match(synthetic, /sameOriginUrl\(report\.share\.path/);
  assert.match(synthetic, /canonical contract gate/);
  assert.match(synthetic, /AbortSignal\.timeout\(timeout\)/);
  assert.match(synthetic, /PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS/);
  assert.match(synthetic, /PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS/);
  assert.match(workflow, /timeout-minutes: 12/);
  assert.equal(synthetic.includes("PRODUCTION_SYNTHETIC_TARGET"), false);
  assert.match(synthetic, new RegExp(PRODUCTION_SYNTHETIC_TARGET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(containerWorker, /SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/);
  assert.match(containerWorker, /constantTimeEqual\(suppliedMonitorToken, expectedMonitorToken\)/);
  assert.match(containerWorker, /isProductionSyntheticMonitorToken\(expectedMonitorToken\)/);
  assert.match(containerWorker, /isProductionSyntheticScanPayload\(payload\)/);
  assert.match(containerWorker, /forwardedHeaders\.delete\(SYNTHETIC_MONITOR_TOKEN_HEADER\)/);
  const centralForwarder = containerWorker.slice(
    containerWorker.indexOf("function forwardToContainer("),
    containerWorker.indexOf("function frontDoorOrigin(")
  );
  assert.match(centralForwarder, /headers\.delete\(SYNTHETIC_MONITOR_TOKEN_HEADER\)/);

  const exactPayload = {
    url: PRODUCTION_SYNTHETIC_TARGET,
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  };
  assert.equal(isProductionSyntheticScanPayload(exactPayload), true);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, url: "https://example.com/" }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, compareShields: true }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, device: "mobile" }), false);
  assert.equal(isProductionSyntheticMonitorToken("x".repeat(31)), false);
  assert.equal(isProductionSyntheticMonitorToken("x".repeat(32)), true);
});

test("production health keeps the public ingress preflight separate from the operator bypass", () => {
  assert.match(workflow, /https:\/\/scan\.sitebehavior\.org\/api\/health\/public-ingress/);
  assert.match(workflow, /publicIngress\?\.scope === "public-ingress-preflight"/);
  assert.match(workflow, /turnstile\?\.configuration === "verified"/);
  assert.match(workflow, /turnstile\?\.challengeSolved === false/);
  assert.match(workflow, /quota\?\.readiness === "ready"/);
  assert.match(workflow, /quota\?\.consumed === false/);
  assert.match(workflow, /monitorBypassUsed === false/);
  assert.match(workflow, /scanSubmitted === false/);

  assert.match(containerWorker, /url\.pathname === "\/api\/health\/public-ingress"/);
  const preflight = containerWorker.slice(
    containerWorker.indexOf("async function publicIngressPreflightResponse("),
    containerWorker.indexOf("/** Overlay the front Worker's gate decision")
  );
  assert.match(preflight, /scope: "public"/);
  assert.match(preflight, /peekPublicScanRateLimit/);
  assert.match(preflight, /consumed: false/);
  assert.match(preflight, /monitorBypassUsed: false/);
  assert.match(preflight, /scanSubmitted: false/);
  assert.doesNotMatch(preflight, /SYNTHETIC_MONITOR_TOKEN_HEADER|SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/);
  assert.doesNotMatch(preflight, /chargePublicScanRateLimit/);
  assert.match(preflight, /turnstileConfigurationProbeCache\.secret === secret/);
  assert.match(preflight, /result,\s*secret\s*\};/);
});

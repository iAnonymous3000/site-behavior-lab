import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PRODUCTION_SYNTHETIC_TARGET,
  PRODUCTION_SYNTHETIC_TARGETS,
  isProductionSyntheticMonitorToken,
  isProductionSyntheticScanPayload
} from "./production-synthetic";

const root = process.cwd();

/**
 * The body the monitor actually posts, produced by the real admission helper
 * rather than restated here. `scripts/smoke-production-synthetic.mjs` submits
 * `prepareScanAdmission(...).body` verbatim, so this is the exact wire the
 * Worker's synthetic allowlist has to accept.
 */
function productionSyntheticAdmissionBody(url: string): Record<string, unknown> {
  const program = `
    import { prepareScanAdmission } from "./scripts/scan-admission.mjs";
    const bytes = Uint8Array.from({ length: 32 }, (_value, index) => index);
    console.log(JSON.stringify(prepareScanAdmission({
      url: ${JSON.stringify(url)},
      device: "desktop",
      gpcEnabled: true,
      consentMode: "observe"
    }, () => bytes).body));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
const workflow = readFileSync(path.join(root, ".github", "workflows", "production-health.yml"), "utf8");
const containerConfig = readFileSync(path.join(root, "wrangler.container.jsonc"), "utf8");
const containerWorker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
const synthetic = readFileSync(path.join(root, "scripts", "smoke-production-synthetic.mjs"), "utf8");

test("production health accepts only reviewed scanner-egress configurations", () => {
  assert.match(
    workflow,
    /\["configured", "aliased"\]\.includes\(health\?\.checks\?\.scannerEgress\)/
  );
  assert.doesNotMatch(
    workflow,
    /health\?\.checks\?\.scannerEgress === "configured"/
  );
});

test("production health derives the durable-jobs expectation from the checked-out production config", () => {
  assert.match(workflow, /with:\n\s+ref: production/);
  assert.match(
    workflow,
    /uses: actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444[\s\S]*?node-version: 24\.14\.1/
  );
  assert.match(workflow, /test "\$\(node --version\)" = "v24\.14\.1"/);
  assert.match(workflow, /test "\$\(npm --version\)" = "11\.11\.0"/);
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

/**
 * Run the workflow's OWN config controller, the way the release validator
 * tests run theirs. Asserting that the invariant's text appears in the YAML
 * cannot tell a gate that always passes from one that never does, and it
 * cannot tell whether the committed config actually satisfies it.
 */
function runProductionConfigController(config: string): { status: number; stderr: string; env: string } {
  const block = workflow.match(/node <<'NODE'\n([\s\S]*?)\n *NODE\n/);
  if (!block) throw new Error("the production-health config controller could not be located");
  const controller = block[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const configFile = path.join(mkdtempSync(path.join(tmpdir(), "production-config-")), "wrangler.container.jsonc");
  const envFile = path.join(path.dirname(configFile), "github-env");
  writeFileSync(configFile, config);
  writeFileSync(envFile, "");
  const run = spawnSync(process.execPath, ["--input-type=commonjs", "-e", controller], {
    encoding: "utf8",
    env: { ...process.env, PRODUCTION_CONFIG_FILE: configFile, GITHUB_ENV: envFile }
  });
  return { status: run.status ?? -1, stderr: run.stderr, env: readFileSync(envFile, "utf8") };
}

test("the committed production config satisfies the monitor's own activation invariants", () => {
  // Sharding without durable jobs passes every CI job and then hard-fails the
  // hourly monitor with "Invalid production config", where it also folds into
  // the durable readiness check and takes durable jobs down with it. An
  // ordering violation belongs in a red build, not in production.
  const accepted = runProductionConfigController(containerConfig);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.env, /EXPECTED_DURABLE_JOBS=[01]\n/);
  assert.match(accepted.env, /EXPECTED_CONTAINER_SHARDING=[01]\n/);

  const shardWithoutDurable = containerConfig
    .replace(/"SITE_BEHAVIOR_LAB_DURABLE_JOBS"(\s*:\s*)"[01]"/, '"SITE_BEHAVIOR_LAB_DURABLE_JOBS"$1"0"')
    .replace(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"(\s*:\s*)"[01]"/, '"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"$1"1"');
  assert.notEqual(shardWithoutDurable, containerConfig, "the sharding fixture must actually differ");
  const refused = runProductionConfigController(shardWithoutDurable);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Invalid production container-sharding expectation/);

  const oneShard = containerConfig
    .replace(/"SITE_BEHAVIOR_LAB_DURABLE_JOBS"(\s*:\s*)"[01]"/, '"SITE_BEHAVIOR_LAB_DURABLE_JOBS"$1"1"')
    .replace(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"(\s*:\s*)"[01]"/, '"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"$1"1"')
    .replace(/"SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT"(\s*:\s*)"[1-3]"/, '"SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT"$1"1"');
  assert.equal(runProductionConfigController(oneShard).status, 1);
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
  assert.match(enabledBranch, /encryptedWatches\?\.creationAuthorization === "public"/);
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
  assert.match(
    synthetic,
    /const \{ runId, startedAt \} = assertFixedSyntheticReport\(report, target, submissionStartedAt, resolved\.queuedReportId\)/
  );
  assert.match(synthetic, /savedReportRetainsScreenshot/);
  assert.match(synthetic, /assertFixedSyntheticReport\(saved, target, submissionStartedAt, report\.share\.id, startedAt\)/);
  // The ordered fallback stays bounded to the fixed candidates and only a
  // target-attributable scan failure may fall through.
  assert.match(synthetic, /class TargetScanFailure extends Error/);
  assert.match(synthetic, /const syntheticTargets = \[/);
  assert.match(synthetic, /https:\/\/www\.iana\.org\/domains\/reserved/);
  assert.match(synthetic, /https:\/\/www\.w3\.org\/TR\//);
  assert.match(synthetic, /failed on every candidate target/);
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
  assert.match(synthetic, /withHttpOperationDeadline\([\s\S]*timeoutMs: timeout/);
  assert.match(synthetic, /fetch\(url,[\s\S]*redirect: "error",[\s\S]*signal/);
  assert.match(synthetic, /PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS/);
  assert.match(synthetic, /PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS/);
  assert.match(workflow, /timeout-minutes: 12/);
  assert.equal(synthetic.includes("PRODUCTION_SYNTHETIC_TARGET"), false);
  assert.match(synthetic, new RegExp(PRODUCTION_SYNTHETIC_TARGET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(containerWorker, /SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/);
  assert.match(containerWorker, /constantTimeEqual\(suppliedMonitorToken, expectedMonitorToken\)/);
  assert.match(containerWorker, /isProductionSyntheticMonitorToken\(expectedMonitorToken\)/);
  assert.match(containerWorker, /isProductionSyntheticScanPayload\(payload\)/);
  const scanHeaders = containerWorker.slice(
    containerWorker.indexOf("function scanForwardHeaders("),
    containerWorker.indexOf("function forwardToContainer(")
  );
  assert.match(scanHeaders, /headers\.delete\(SYNTHETIC_MONITOR_TOKEN_HEADER\)/);
  const centralForwarder = containerWorker.slice(
    containerWorker.indexOf("function forwardToContainer("),
    containerWorker.indexOf("function frontDoorOrigin(")
  );
  assert.match(centralForwarder, /headers\.delete\(SYNTHETIC_MONITOR_TOKEN_HEADER\)/);

  // Build the fixture with the SAME producer the monitor posts with, never by
  // hand. A hand-written payload is how this gate and its producer drifted
  // apart once already: prepareScanAdmission always writes the three
  // comparison flags, so a four-key literal agreed with the allowlist about a
  // shape nothing submits, and every activated synthetic would have been
  // refused with a 400 that no test could see.
  const exactPayload = productionSyntheticAdmissionBody(PRODUCTION_SYNTHETIC_TARGET);
  assert.deepEqual(Object.keys(exactPayload).sort(), [
    "compareConsent",
    "compareGpc",
    "compareShields",
    "consentMode",
    "device",
    "gpcEnabled",
    "url"
  ]);
  assert.equal(isProductionSyntheticScanPayload(exactPayload), true);
  // Every fixed candidate target is authorized, and nothing else: the ordered
  // fallback never widens the credential beyond the allowlisted pages.
  assert.equal(PRODUCTION_SYNTHETIC_TARGETS[0], PRODUCTION_SYNTHETIC_TARGET);
  assert.equal(PRODUCTION_SYNTHETIC_TARGETS.length >= 2, true);
  for (const url of PRODUCTION_SYNTHETIC_TARGETS) {
    // Each candidate goes through the producer too, so a target the monitor
    // could not actually canonicalize can never look authorized here.
    assert.equal(isProductionSyntheticScanPayload(productionSyntheticAdmissionBody(url)), true);
  }
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, url: "https://example.com/" }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, url: "https://www.w3.org/" }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, compareShields: true }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, compareGpc: true }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, compareConsent: true }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, device: "mobile" }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, gpcEnabled: false }), false);
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, consentMode: "accept-all" }), false);
  // This credential bypasses Turnstile, so a request carrying a Turnstile token
  // is not its fixed contract even though admission would accept the field.
  assert.equal(isProductionSyntheticScanPayload({ ...exactPayload, turnstileToken: "t" }), false);
  for (const key of Object.keys(exactPayload)) {
    const missing = { ...exactPayload };
    delete (missing as Record<string, unknown>)[key];
    assert.equal(isProductionSyntheticScanPayload(missing), false, `dropping ${key} must not pass`);
  }
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

test("production health only closes its canonical issue when it re-ran every lane the issue is waiting on", () => {
  // Three of the four hourly schedules never execute the synthetic or the R2
  // canary. Without lane scoping, one of those shallow runs retracts a deep
  // alarm fifteen minutes after it was raised and reports a recovery nothing
  // measured. Issue #13 accumulated twelve open/close comments this way.
  assert.match(workflow, /id: synthetic_run/);
  assert.match(workflow, /id: r2_delete_canary_run/);
  assert.match(workflow, /SYNTHETIC_OUTCOME: \$\{\{ steps\.synthetic_run\.outcome \}\}/);
  assert.match(workflow, /R2_DELETE_CANARY_OUTCOME: \$\{\{ steps\.r2_delete_canary_run\.outcome \}\}/);
  assert.match(workflow, /POSTURE_OUTCOME: \$\{\{ steps\.posture\.outcome \}\}/);
  assert.match(workflow, /echo "coverage=\$\{coverage\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /COVERAGE_MARKER_PREFIX: "<!-- site-behavior-lab:production-health-required-lanes: "/);
  assert.match(workflow, /covers_required_lanes\(\)/);
  assert.match(workflow, /if covers_required_lanes "\$issue_required_lanes" "\$HEALTH_COVERAGE"; then/);
  assert.match(workflow, /Production health issue kept open/);
  // A failing shallow run must not shrink an open issue's requirement set.
  assert.match(workflow, /required_lanes=\$\(printf/);
  // `grep -v` exits 1 when every lane filters out, which under `set -euo
  // pipefail` killed the step before it could file the issue. Absorbing that
  // status is what keeps a coverage-less failure reportable at all.
  assert.match(workflow, /\{ grep -v -e '\^\$' -e '\^none\$' \|\| true; \}/);
  assert.match(workflow, /\$\{required_lanes:-none\}/);
});

test("production health treats an in-flight rollout as pending, not as a production failure", () => {
  // A promoted commit takes minutes of Cloudflare build time. Failing the
  // monitor during that window files a public incident for an ordinary
  // deploy, which is what happened on every promotion in the 2026-07-24 wave.
  assert.match(workflow, /id: rollout/);
  assert.match(workflow, /fetch-depth: 0/);
  // Pages and the scanner are independent builds and cross over one at a time,
  // so a staggered rollout must be tolerated; each side is checked for
  // ancestry separately rather than requiring the two to agree.
  assert.match(workflow, /git merge-base --is-ancestor "\$scanner" HEAD/);
  assert.match(workflow, /git merge-base --is-ancestor "\$pages" HEAD/);
  assert.match(workflow, /\[\[ -n "\$scanner" && -n "\$pages" \]\]/);
  assert.match(workflow, /\(\( age_minutes < ROLLOUT_BUDGET_MINUTES \)\)/);
  assert.match(workflow, /ROLLOUT_BUDGET_MINUTES: \$\{\{ vars\.PRODUCTION_ROLLOUT_BUDGET_MINUTES \|\| '45' \}\}/);
  // The budget is a DEPLOY budget, so it must run from the promotion, not from
  // the committer date: CI promotes only after every test job passes, so the
  // commit is already 8-12 minutes old when Cloudflare starts building and a
  // quarter of the window was being spent before the rollout began.
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{EXPECTED_PRODUCTION_SHA\}/);
  assert.match(workflow, /promoted_at=\$\(gh api/);
  assert.match(workflow, /promoted_at=\$\(git log -1 --format=%ct HEAD\)/);
  assert.match(workflow, /::notice title=Rollout clock fallback::/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /^\s{2}actions: read$/m);
  assert.match(workflow, /Production rollout in progress/);
  // Past the budget, or on an unknown revision, it is still a hard failure.
  assert.match(workflow, /::error title=Production rollout stale::/);
  // Contract assertions describe the promoted revision, so they must not be
  // evaluated against the one still being replaced.
  const deferred = workflow.match(/if: steps\.rollout\.outputs\.pending != 'true'/g) ?? [];
  assert.equal(deferred.length >= 3, true);
});

test("an unactivated operator canary is a disclosed gap, never a production incident", () => {
  // The runbook requires a direct write/read/delete readback BEFORE
  // PRODUCTION_R2_DELETE_CANARY_REQUIRED is set, so the un-set state is the
  // documented starting position. Hard-failing on it made the :07 lane red
  // every hour while production itself was healthy.
  const activation = workflow.slice(
    workflow.indexOf("- name: Resolve R2 delete-canary activation"),
    workflow.indexOf("- name: Run isolated production R2 write/read/delete canary")
  );
  assert.match(activation, /if \[\[ "\$PRODUCTION_R2_DELETE_CANARY_REQUIRED" != "1" \]\]; then\n\s+echo "configured=false"/);
  assert.match(activation, /::warning title=Operator R2 delete canary not activated::/);
  assert.match(activation, /exit 0/);
  // Once required, a missing credential is still a hard failure.
  assert.match(activation, /::error title=Production R2 delete canary missing::/);
});

test("production health never cancels a delivered probe and never alerts on a cancelled run", () => {
  assert.match(workflow, /group: production-health\n(?:\s*#[^\n]*\n)*\s+cancel-in-progress: false/);
  assert.match(workflow, /if \[\[ "\$HEALTH_JOB_STATUS" == "cancelled" \]\]; then/);
  assert.match(workflow, /echo "failed=cancelled" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /if \[\[ "\$HEALTH_FAILED" == "cancelled" \]\]; then\n\s+echo "The run was cancelled; leaving the canonical issue untouched\."/);
});

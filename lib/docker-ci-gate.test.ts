import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("CI requires the deployable Docker image and public-v2/R2 smoke before promotion", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const dockerJob = workflow.slice(workflow.indexOf("\n  docker:"), workflow.indexOf("\n  promote:"));
  const promoteJob = workflow.slice(workflow.indexOf("\n  promote:"));

  assert.match(dockerJob, /npm run test:smoke:docker/);
  assert.match(dockerJob, /DOCKER_SMOKE_PUBLIC_R2: "1"/);
  assert.match(promoteJob, /needs:\n(?:\s+- [^\n]+\n)*\s+- docker\n/);
});

test("promotion fallback can repair a failed direct promotion but rechecks every CI gate", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "promote-production.yml"), "utf8");

  assert.match(workflow, /workflow_run\.conclusion == 'success' \|\| github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /actions\/runs\/\$\{CI_RUN_ID\}\/jobs\?per_page=100/);
  for (const job of [
    "Supply-chain Security",
    "Typecheck, Unit Tests, Build",
    "Chromium Smoke Test",
    "Docker Runtime and Public R2 Smoke",
    "Attest exact-SHA evidence manifests"
  ]) {
    assert.match(workflow, new RegExp(job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(workflow, /matches\[0\]\.conclusion !== "success"/);
});

test("Docker smoke preserves v1 and explicitly proves public v2/r2 bundles", () => {
  const smoke = readFileSync(path.join(root, "scripts", "smoke-docker.mjs"), "utf8");
  const seccomp = JSON.parse(
    readFileSync(path.join(root, "scripts", "playwright-seccomp-profile.json"), "utf8")
  ) as { defaultAction?: string; syscalls?: Array<{ names?: string[]; action?: string }> };

  assert.match(smoke, /await runV1ImageSmoke\(\)/);
  assert.match(smoke, /"--init"/);
  assert.match(smoke, /"--ipc=host"/);
  assert.match(smoke, /`seccomp=\$\{seccompProfile\}`/);
  assert.doesNotMatch(smoke, /seccomp=unconfined|chromiumSandbox: false/);
  assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
  const userNamespaceRule = seccomp.syscalls?.find(
    (entry) => entry.action === "SCMP_ACT_ALLOW" && ["clone", "setns", "unshare"].every((name) => entry.names?.includes(name))
  );
  assert.ok(userNamespaceRule, "Chromium sandbox user-namespace syscalls must remain explicitly allowed");
  assert.match(smoke, /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS=1/);
  assert.match(smoke, /SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2/);
  assert.match(smoke, /scripts\/smoke-deployed-scanner\.mjs/);
  assert.match(smoke, /report\.schemaVersion !== 2 \|\| report\.schemaRevision !== 2/);
  assert.match(smoke, /savedReportRetainsScreenshot\(report\)/);
  assert.match(smoke, /missing its provenance sidecar/);
  assert.match(smoke, /startSmokeR2Server\(\{ bucket, host: await dockerR2BindHost\(\) \}\)/);

  const r2SmokeServer = readFileSync(path.join(root, "scripts", "smoke-r2-server.mjs"), "utf8");
  assert.match(r2SmokeServer, /host = "127\.0\.0\.1"/);
  assert.doesNotMatch(r2SmokeServer, /server\.listen\(0, "0\.0\.0\.0"/);

  const deployedSmoke = readFileSync(path.join(root, "scripts", "smoke-deployed-scanner.mjs"), "utf8");
  // The promote gate must not hard-depend on ONE third party: an ordered
  // candidate list lets a single target's outage or bot wall fall through to
  // an independent target, while an all-candidates failure stays red.
  assert.match(deployedSmoke, /"https:\/\/www\.iana\.org\/ https:\/\/www\.w3\.org\/"/);
  assert.match(deployedSmoke, /shieldsUrlCandidates/);
  assert.match(deployedSmoke, /tolerateScanFailure: true/);
  assert.match(deployedSmoke, /failed on every candidate target/);
  assert.doesNotMatch(deployedSmoke, /SMOKE_SHIELDS_URL=https:\/\/sitebehavior\.org/);
  assert.doesNotMatch(deployedSmoke, /SMOKE_SHIELDS_URL=https:\/\/example\.com/);
});

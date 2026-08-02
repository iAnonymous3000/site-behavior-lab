import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("CI requires the deployable Docker image and public-v2/R2 smoke before promotion", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const dockerJob = workflow.slice(workflow.indexOf("\n  docker:"), workflow.indexOf("\n  attest:"));
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
  // The required-job names used to be restated here and in each workflow. They
  // now live in .github/required-ci-jobs.json, and lib/required-ci-jobs.test.ts
  // owns the stronger contract: the list matches the jobs ci.yml declares, no
  // workflow restates a name, and a skipped or failed job is refused. Here we
  // only prove the promotion fallback delegates to that one checker.
  assert.match(workflow, /node scripts\/verify-required-ci-jobs\.mjs "\$RUNNER_TEMP\/ci-jobs\.json"/);
});

test("both promotion paths reserve production writes for the dedicated App", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const direct = ci.slice(ci.indexOf("\n  promote:"));
  const fallback = readFileSync(path.join(root, ".github", "workflows", "promote-production.yml"), "utf8");
  const directCheckout = direct.slice(
    direct.indexOf("- name: Checkout main history"),
    direct.indexOf("- name: Mint promotion App token")
  );
  const fallbackCheckout = fallback.slice(
    fallback.indexOf("- name: Checkout main history"),
    fallback.indexOf("- name: Confirm every CI test gate passed")
  );
  const fallbackPush = fallback.slice(fallback.indexOf("- name: Fast-forward production to the tested SHA"));

  for (const workflow of [direct, fallback]) {
    assert.match(
      workflow,
      /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/
    );
    assert.match(workflow, /app-id: \$\{\{ vars\.PROMOTION_APP_ID \}\}/);
    // The deprecation migration: a client-id mint takes over when the
    // operator stores the App client id, and the consumer coalesces so
    // exactly one minted token is ever used.
    assert.match(workflow, /client-id: \$\{\{ vars\.PROMOTION_APP_CLIENT_ID \}\}/);
    assert.match(workflow, /if: \$\{\{ vars\.PROMOTION_APP_CLIENT_ID \}\}/);
    assert.match(workflow, /if: \$\{\{ !vars\.PROMOTION_APP_CLIENT_ID \}\}/);
    assert.match(workflow, /private-key: \$\{\{ secrets\.PROMOTION_APP_PRIVATE_KEY \}\}/);
    assert.match(workflow, /permission-contents: write/);
    assert.match(
      workflow,
      /APP_TOKEN: \$\{\{ steps\.promotion_app_token_client\.outputs\.token \|\| steps\.promotion_app_token\.outputs\.token \}\}/
    );
    assert.match(workflow, /Promotion push authenticates as the dedicated promotion App/);
    assert.match(
      workflow,
      /auth_header="AUTHORIZATION: basic \$\(printf 'x-access-token:%s' "\$\{APP_TOKEN\}" \| base64 \| tr -d '\\n'\)"/
    );
    assert.match(workflow, /git -c http\.extraheader="\$\{auth_header\}" push origin/);
    assert.doesNotMatch(workflow, /FALLBACK_TOKEN|falling back to the workflow token/);
  }

  assert.match(direct, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(direct, /^\s+contents: write$|\$\{\{ github\.token \}\}/m);
  assert.match(fallback, /permissions:\n\s+contents: read\n[\s\S]*?\s+actions: read/);
  assert.doesNotMatch(fallback, /^\s+contents: write$/m);
  assert.match(directCheckout, /persist-credentials: false/);
  assert.match(fallbackCheckout, /persist-credentials: false/);
  assert.doesNotMatch(fallbackPush, /\$\{\{ github\.token \}\}/);

  const confirmIndex = fallback.indexOf("- name: Confirm every CI test gate passed");
  const mintIndex = fallback.indexOf("- name: Mint promotion App token");
  const pushIndex = fallback.indexOf("- name: Fast-forward production to the tested SHA");
  assert.ok(confirmIndex >= 0 && confirmIndex < mintIndex, "fallback must verify CI before minting the App token");
  assert.ok(mintIndex < pushIndex, "fallback must mint the App token before the production push");
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

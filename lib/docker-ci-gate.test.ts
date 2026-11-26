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
  assert.match(workflow, /node scripts\/verify-required-ci-jobs\.mjs "\$RUNNER_TEMP\/ci-jobs\.json"/);
});

test("both promotion paths reserve production writes for one dedicated App through mutually exclusive client-ID or App-ID inputs", () => {
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
    const tokenMints = workflow.match(
      /actions\/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc/g
    );
    assert.equal(tokenMints?.length, 2, "each promotion path must carry both exclusive App-token inputs");
    assert.match(workflow, /client-id: \$\{\{ vars\.PROMOTION_APP_CLIENT_ID \}\}/);
    assert.match(workflow, /app-id: \$\{\{ vars\.PROMOTION_APP_ID \}\}/);
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
  assert.match(fallback, /permissions:\n\s+contents: read\n(?:\s+#[^\n]*\n)*\s+actions: read/);
  assert.doesNotMatch(fallback, /^\s+contents: write$/m);
  assert.doesNotMatch(fallbackPush, /\$\{\{ github\.token \}\}/);
  assert.match(directCheckout, /persist-credentials: false/);
  assert.match(fallbackCheckout, /persist-credentials: false/);
});

test("Docker smoke proves filesystem and public v3/R2 bundles plus historical printable PDF export", () => {
  const smoke = readFileSync(path.join(root, "scripts", "smoke-docker.mjs"), "utf8");
  const seccomp = JSON.parse(
    readFileSync(path.join(root, "scripts", "playwright-seccomp-profile.json"), "utf8")
  ) as { defaultAction?: string; syscalls?: Array<{ names?: string[]; action?: string }> };

  assert.match(smoke, /await runFilesystemImageSmoke\(\)/);
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
  assert.match(smoke, /v3\\\/reports\\\//);
  assert.match(smoke, /v3\\\/pdfs\\\//);
  assert.match(smoke, /report\.schemaVersion !== 3 \|\| savedReportRetainsScreenshot\(report\)/);
  assert.match(smoke, /startSmokeR2Server\(\{ bucket, host: await dockerR2BindHost\(\) \}\)/);
  assert.match(smoke, /const expectedRequestRows = historicalReportExpectedRequestRows\(report\)/);
  assert.match(smoke, /const renderedRows = renderedRequestRowCount\(html\)/);
  assert.match(smoke, /renderedRows !== expectedRequestRows/);
  assert.doesNotMatch(smoke, /renderedRows < 2/);

  const r2SmokeServer = readFileSync(path.join(root, "scripts", "smoke-r2-server.mjs"), "utf8");
  assert.match(r2SmokeServer, /host = "127\.0\.0\.1"/);
  assert.doesNotMatch(r2SmokeServer, /server\.listen\(0, "0\.0\.0\.0"/);

  const deployedSmoke = readFileSync(path.join(root, "scripts", "smoke-deployed-scanner.mjs"), "utf8");
  // The promote gate must not hard-depend on ONE third party: an ordered
  // candidate list lets a single target's outage or bot wall fall through to
  // an independent target, while an all-candidates failure stays red.
  assert.match(deployedSmoke, /\/api\/v3\/scan/);
  assert.match(deployedSmoke, /"https:\/\/www\.iana\.org\/ https:\/\/www\.w3\.org\/"/);
  assert.match(deployedSmoke, /shieldsUrlCandidates/);
  assert.match(deployedSmoke, /tolerateScanFailure: true/);
  assert.match(deployedSmoke, /failed on every candidate target/);
  assert.doesNotMatch(deployedSmoke, /SMOKE_SHIELDS_URL=https:\/\/sitebehavior\.org/);
  assert.doesNotMatch(deployedSmoke, /SMOKE_SHIELDS_URL=https:\/\/example\.com/);
});

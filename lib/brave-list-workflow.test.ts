import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const workflow = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "update-brave-lists.yml"),
  "utf8"
);
const refreshStart = workflow.indexOf("\n  refresh-lists:");
const driftStart = workflow.indexOf("\n  toolchain-drift-check:", refreshStart);
const refreshJob = workflow.slice(refreshStart, driftStart);

test("a measurement freeze quiesces the refresh and says so loudly", () => {
  // The gate lives on the refresh job itself, and the loud notice job runs
  // ONLY when frozen, so a quiesced Monday is visible rather than silent.
  assert.match(
    workflow,
    /measurement-freeze-notice:\n\s+name: Measurement freeze notice\n\s+if: vars\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE == '1'/
  );
  assert.match(workflow, /::warning title=Measurement freeze::/);
});

test("scheduled Brave-list refresh failures stay red and reconcile one isolated issue", () => {
  assert.notEqual(refreshStart, -1);
  assert.notEqual(driftStart, -1);
  assert.match(
    refreshJob,
    /permissions:\n\s+contents: write\n\s+actions: write\n\s+issues: write\n\s+pull-requests: write/
  );
  assert.match(refreshJob, /id: brave_list_alert\n\s+if: always\(\) && github\.event_name == 'schedule'/);
  assert.match(refreshJob, /BRAVE_LIST_JOB_STATUS: \$\{\{ job\.status \}\}/);
  assert.match(refreshJob, /site-behavior-lab:brave-list-refresh/);
  assert.match(refreshJob, /This public issue intentionally contains only aggregate status/);
  assert.match(refreshJob, /actions\/runs\/\$\{GITHUB_RUN_ID\}/);
  assert.match(refreshJob, /ISSUE_TITLE: Repair the scheduled Brave Shields list refresh/);
  assert.match(refreshJob, /gh issue create/);
  assert.match(refreshJob, /gh issue edit/);
  assert.match(refreshJob, /gh issue reopen/);
  assert.match(refreshJob, /gh issue close/);
  assert.match(refreshJob, /github\.event_name == 'schedule'[\s\S]*steps\.brave_list_alert\.outcome == 'success'/);
  assert.match(
    refreshJob,
    /- name: Preserve scheduled Brave-list refresh failure[\s\S]*::error title=Brave Shields list refresh failed::[\s\S]*exit 1/
  );
});

test("Brave-list refresh can publish only a reviewed proposal branch", () => {
  assert.match(
    refreshJob,
    /if: >-\n\s+github\.ref_type == 'branch' && github\.ref_name == github\.event\.repository\.default_branch &&\n\s+vars\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE != '1'/
  );
  assert.match(refreshJob, /BASE_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(refreshJob, /PROPOSAL_BRANCH: automation\/brave-list-refresh/);
  assert.match(refreshJob, /git checkout -B "\$PROPOSAL_BRANCH"/);
  assert.match(refreshJob, /HEAD:refs\/heads\/\$\{PROPOSAL_BRANCH\}/);
  assert.match(refreshJob, /gh pr create/);
  assert.match(refreshJob, /--base "\$BASE_BRANCH"/);
  assert.match(refreshJob, /gh pr edit/);
  assert.match(refreshJob, /Trigger non-promoting CI on the proposal branch/);
  assert.match(refreshJob, /gh workflow run ci\.yml --ref "\$PROPOSAL_BRANCH"/);
  assert.doesNotMatch(refreshJob, /gh workflow run ci\.yml --ref main/);
  assert.doesNotMatch(refreshJob, /git pull --rebase/);
  assert.doesNotMatch(refreshJob, /git push origin "\$\{?GITHUB_REF_NAME/);
  // New list bytes invalidate the pinned inventory digests by construction, so
  // a proposal that does not regenerate and stage THIRD_PARTY_INVENTORY.json
  // can never pass CI's required supply-chain gate and no refresh could merge.
  assert.match(refreshJob, /node scripts\/third-party-inventory\.mjs\n/);
  assert.match(refreshJob, /npm run supply-chain:third-party:check/);
  assert.match(refreshJob, /git add [^\n]*THIRD_PARTY_INVENTORY\.json/);
  assert.ok(
    refreshJob.indexOf("node scripts/third-party-inventory.mjs\n") <
      refreshJob.indexOf("npm run supply-chain:third-party:check"),
    "the inventory must be regenerated before it is verified"
  );
});

test("Playwright installation is bounded and retries exactly once", () => {
  // Run 32161287520 reached the hosted Ubuntu mirror, then emitted nothing for
  // six hours until GitHub cancelled the job. A list refresh must fail loudly
  // on that external dependency instead of consuming the platform maximum.
  const installStart = refreshJob.indexOf("- name: Install Playwright Chromium");
  const fetchStart = refreshJob.indexOf("- name: Fetch Brave default filter lists", installStart);
  const installSteps = refreshJob.slice(installStart, fetchStart);

  assert.ok(installStart >= 0 && fetchStart > installStart, "browser install must precede list fetch");
  assert.match(
    installSteps,
    /- name: Install Playwright Chromium[\s\S]*?id: install_chromium[\s\S]*?continue-on-error: true[\s\S]*?timeout-minutes: 10[\s\S]*?run: npx playwright install --with-deps chromium/
  );
  assert.match(
    installSteps,
    /- name: Retry Playwright Chromium installation once[\s\S]*?if: steps\.install_chromium\.outcome == 'failure'[\s\S]*?timeout-minutes: 10[\s\S]*?run: npx playwright install --with-deps chromium/
  );
  assert.equal(
    (installSteps.match(/run: npx playwright install --with-deps chromium/g) ?? []).length,
    2,
    "the refresh must attempt the browser install once and retry it once"
  );
});

test("a policy refusal to open the proposal PR does not discard a validated refresh", () => {
  // "Allow GitHub Actions to create and approve pull requests" is off by
  // default, so gh pr create fails with a GraphQL policy refusal AFTER the
  // branch is pushed and every gate has passed. Failing the job there threw
  // away a validated refresh, skipped the proposal CI dispatch, and reported a
  // working refresh as broken.
  assert.match(refreshJob, /not permitted to create or approve pull requests/);
  assert.match(refreshJob, /::error title=Brave-list refresh needs its pull request opened by hand::/);
  assert.match(refreshJob, /compare\/\$\{BASE_BRANCH\}\.\.\.\$\{PROPOSAL_BRANCH\}\?expand=1/);
  assert.match(refreshJob, /pr_blocked=true/);
  // Only that one refusal is tolerated; anything else still fails the job.
  assert.match(refreshJob, /if ! grep -q "not permitted to create or approve pull requests"[\s\S]*?exit 1/);
  // The proposal must still be marked published so its CI dispatch runs, which
  // is what actually validates the branch a human is about to merge.
  const publishStep = refreshJob.slice(
    refreshJob.indexOf("- name: Publish reviewed refresh proposal"),
    refreshJob.indexOf("- name: Trigger non-promoting CI on the proposal branch")
  );
  assert.ok(
    publishStep.indexOf("pr_blocked=true") < publishStep.lastIndexOf('echo "proposed=true"'),
    "a blocked PR must still reach proposed=true so CI runs on the branch"
  );
  assert.match(refreshJob, /if: steps\.commit\.outputs\.proposed == 'true'/);
});

/**
 * Asserting that `pr_blocked=true` is WRITTEN is not the contract; the contract
 * is that something acts on it. Nothing did. The branch was pushed, no pull
 * request existed, the job stayed green by design, and the alert step -- keyed
 * on job status alone -- reported the refresh completed and closed the canonical
 * repair issue. A run where the hand-off to a human failed silently closed the
 * issue that exists to say the hand-off to a human failed.
 */
test("a proposal that never became a pull request keeps the repair issue open", () => {
  const alertStep = refreshJob.slice(
    refreshJob.indexOf("- name: Prepare scheduled Brave-list refresh alert"),
    refreshJob.indexOf("- name: Reconcile the scheduled Brave-list refresh issue")
  );
  assert.ok(alertStep.length > 0, "the alert step must exist");
  assert.match(
    alertStep,
    /PR_BLOCKED: \$\{\{ steps\.commit\.outputs\.pr_blocked \}\}/,
    "the alert decision must read the blocked-PR output, not only job status"
  );
  assert.match(
    alertStep,
    /"\$BRAVE_LIST_JOB_STATUS" == "success" && "\$PR_BLOCKED" != "true"/,
    "a green job with no pull request must not report a completed refresh"
  );
  assert.match(alertStep, /failed=true\s+outcome=needs-a-pull-request-opened-by-hand/);
});

test("manual runs and the separate drift job cannot reconcile Brave-list refresh health", () => {
  const reconcileStart = refreshJob.indexOf("- name: Reconcile the scheduled Brave-list refresh issue");
  const preserveStart = refreshJob.indexOf("- name: Preserve scheduled Brave-list refresh failure", reconcileStart);
  const reconcileStep = refreshJob.slice(reconcileStart, preserveStart);

  assert.notEqual(reconcileStart, -1);
  assert.notEqual(preserveStart, -1);
  assert.match(reconcileStep, /github\.event_name == 'schedule'/);
  assert.equal(reconcileStep.includes("workflow_dispatch"), false);
  assert.equal(refreshJob.includes("steps.drift"), false);
});

test("the scheduled refresh does not queue behind the featured-scan writer group", () => {
  // GitHub keeps at most one PENDING run per concurrency group and cancels the
  // earlier one to make room. scan-featured.yml runs two long scheduled legs
  // every Monday, so while this refresh shared their group its 06:17 run queued
  // behind the first leg and was evicted by the second. A run cancelled while
  // pending starts no job, so every alert step here is guarded by `always()`
  // yet never ran: the refresh silently stopped happening.
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("env:"));
  assert.match(concurrency, /group: brave-list-refresh-/);
  assert.equal(
    concurrency.includes("site-behavior-repo-writers-${{ github.ref }}"),
    false,
    "sharing the writers group lets a featured-scan leg cancel this refresh while it is pending"
  );
  // Cancelling a refresh already in progress would abandon a pushed proposal
  // branch, so only the queueing behaviour changes.
  assert.match(concurrency, /cancel-in-progress: false/);

  const featured = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"),
    "utf8"
  );
  const schedules = [...featured.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(
    schedules.length >= 2,
    "this guard exists because scan-featured runs more than one scheduled leg"
  );
});

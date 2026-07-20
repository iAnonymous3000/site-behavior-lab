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

test("scheduled Brave-list refresh failures stay red and reconcile one isolated issue", () => {
  assert.notEqual(refreshStart, -1);
  assert.notEqual(driftStart, -1);
  assert.match(refreshJob, /permissions:\n\s+contents: write\n\s+actions: write\n\s+issues: write/);
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

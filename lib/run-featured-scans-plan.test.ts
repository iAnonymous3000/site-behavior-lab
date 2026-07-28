import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const script = path.join(root, "scripts", "run-featured-scans.mjs");

test("featured scan plan lists its bounded work without building or scanning", () => {
  const result = spawnSync(process.execPath, [script, "--plan"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FEATURED_LIMIT: "2",
      FEATURED_COMPARE_GPC: "true",
      FEATURED_COMPARE_SHIELDS: "false",
      FEATURED_COMPARE_CONSENT: "false",
      FEATURED_TRANSIENT_RETRIES: "2",
      FEATURED_DELAY_MS: "25"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.kind, "site-behavior-featured-scan-plan");
  assert.equal(plan.mutatesReports, false);
  assert.equal(plan.catalog.selected, 2);
  assert.equal(plan.conditions.comparisonMode, "gpc");
  assert.equal(plan.budget.attemptsPerTarget, 3);
  assert.equal(plan.budget.maximumSubmittedScans, 6);
  assert.equal(plan.budget.maximumPageVisits, 12);
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.targets.every((target: { domain?: unknown }) => typeof target.domain === "string"), true);
  assert.doesNotMatch(result.stdout, /https?:\/\//);
  assert.doesNotMatch(result.stderr, /Building|Scanning/);
});

test("featured scan rejects unknown command-line arguments before doing work", () => {
  const result = spawnSync(process.execPath, [script, "--unknown"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node scripts\/run-featured-scans\.mjs \[--plan\]/);
});

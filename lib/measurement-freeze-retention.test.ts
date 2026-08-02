import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScriptExports = Record<string, (...args: any[]) => any>;
const nativeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<ScriptExports>;

function script(name: string) {
  return nativeImport(
    pathToFileURL(path.join(process.cwd(), "scripts", name)).href
  );
}

function source(relative: string) {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

test("the exact freeze variable is the single fail-closed retention policy", async () => {
  const {
    measurementFreezeRetentionPolicy,
    requireStaticReportPruningAllowed
  } = await script("measurement-freeze-retention-lib.mjs");

  for (const environment of [{}, { SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "" }, {
    SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "0"
  }]) {
    assert.deepEqual(measurementFreezeRetentionPolicy(environment), {
      measurementFreeze: false,
      pruningAllowed: true,
      mode: "ordinary-retention"
    });
    assert.doesNotThrow(() => requireStaticReportPruningAllowed(environment));
  }

  const frozen = { SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "1" };
  assert.deepEqual(measurementFreezeRetentionPolicy(frozen), {
    measurementFreeze: true,
    pruningAllowed: false,
    mode: "governed-evidence-freeze"
  });
  assert.throws(
    () => requireStaticReportPruningAllowed(frozen),
    /forbids static report pruning/
  );

  for (const malformed of ["true", "yes", " 1", "2"]) {
    assert.throws(
      () =>
        measurementFreezeRetentionPolicy({
          SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: malformed
        }),
      /refusing an ambiguous retention policy/
    );
  }
});

test("the featured generator resolves freeze policy before reading or scanning", () => {
  const generator = source("scripts/run-featured-scans.mjs");
  const policy = generator.indexOf(
    "const retentionPolicy = measurementFreezeRetentionPolicy(process.env)"
  );
  const catalog = generator.indexOf("const config = await readConfig()");
  const firstScan = generator.indexOf("await runOneScanWithRetry(");
  assert.ok(policy > 0 && policy < catalog && catalog < firstScan);

  const plan = spawnSync(
    process.execPath,
    ["scripts/run-featured-scans.mjs", "--plan"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "1",
        FEATURED_LIMIT: "1"
      }
    }
  );
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).retention, {
    measurementFreeze: true,
    pruningAllowed: false,
    mode: "governed-evidence-freeze"
  });

  const malformed = spawnSync(
    process.execPath,
    ["scripts/run-featured-scans.mjs", "--plan"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "true",
        FEATURED_LIMIT: "1"
      }
    }
  );
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /refusing an ambiguous retention policy/);
  assert.doesNotMatch(malformed.stderr, /Building|Scanning/);
});

test("the standalone pruner refuses before compilation or report enumeration during a freeze", () => {
  const launcher = source("scripts/prune-static-reports.mjs");
  assert.ok(
    launcher.indexOf("requireStaticReportPruningAllowed(process.env)") <
      launcher.indexOf("SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY")
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/prune-static-reports.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: "1"
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbids static report pruning/);
  assert.doesNotMatch(result.stdout, /Pruned/);
});

test("the featured publisher skips pruning only for exact freeze and rejects deletions", () => {
  const workflow = source(".github/workflows/scan-featured.yml");
  const start = workflow.indexOf(
    "- name: Apply retention policy and rebuild trusted aggregate outputs"
  );
  const deletionGuard = workflow.indexOf(
    "- name: Refuse freeze-time deletion of governed reports"
  );
  const commit = workflow.indexOf("- name: Commit static reports", deletionGuard);
  assert.ok(start > 0 && start < deletionGuard && deletionGuard < commit);
  const retention = workflow.slice(start, deletionGuard);
  assert.match(
    retention,
    /case "\$SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE" in/
  );
  assert.match(retention, /\n\s+1\)\n[\s\S]*?pruning is disabled/);
  assert.match(retention, /\n\s+''\|0\)\n[\s\S]*?npm run reports:prune/);
  assert.match(retention, /\n\s+\*\)\n[\s\S]*?exit 1/);
  assert.equal(
    [...workflow.matchAll(/npm run reports:prune/g)].length,
    1,
    "no second workflow path may invoke the pruner"
  );

  const guard = workflow.slice(deletionGuard, commit);
  assert.match(
    guard,
    /if: env\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE == '1'/
  );
  assert.match(
    guard,
    /git diff --quiet --diff-filter=D -- public\/reports/
  );
  assert.match(
    guard,
    /git diff --cached --quiet --diff-filter=D -- public\/reports/
  );
  assert.match(
    workflow,
    /Merge this evidence-only proposal through normal checks before dispatching the next cycle/
  );
});

test("ordinary retention remains seven days and governed cycles advance only through accepted carriers", () => {
  const pruner = source("lib/prune-static-reports-cli.ts");
  assert.match(pruner, /const DEFAULT_MAX_AGE_DAYS = 7/);

  const rollout = source("docs/featured-corpus-r2-rollout.md");
  assert.match(rollout, /Outside a measurement freeze[\s\S]*ordinary\s+seven-day\/count retention policy/);
  assert.match(rollout, /Post-activation governed cycles use sequential accepted producer commits/);
  assert.match(rollout, /Run the second cycle only after `S1` is current on `main`/);
  assert.match(rollout, /runEvidence\.headSha` equal that cycle's exact accepted\s+producer commit/);
  assert.match(rollout, /no age\/count pruning or other report deletion occurs/);
  assert.match(rollout, /acceptedProducerCommits/);
  assert.match(rollout, /Calibration remains exact to `C`/);

  const activation = source("docs/measurement-freeze-activation.md");
  assert.match(activation, /Collect governed cycles through sequential evidence-only carriers/);
  assert.match(activation, /Dispatch the second cycle only\s+after `S1` is current on `main`/);
  assert.match(activation, /acceptedProducerCommits/);
  assert.match(activation, /Calibration remains bound exactly to\s+`C`/);
});

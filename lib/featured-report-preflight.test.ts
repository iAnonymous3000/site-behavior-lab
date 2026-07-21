import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { featuredReportPreflight, type FeaturedReportPreflightInput } from "./featured-report-preflight";

const COMMIT = "a".repeat(40);

function input(overrides: Partial<FeaturedReportPreflightInput> = {}): FeaturedReportPreflightInput {
  return {
    mode: "r2",
    eventCommit: COMMIT,
    checkoutCommit: COMMIT,
    worktreeClean: true,
    compareGpc: "false",
    compareShields: "false",
    compareConsent: "false",
    runnerEnvironment: "github-hosted",
    egressLabel: "github-actions-ubuntu",
    egressRegion: "",
    egressAttested: "",
    ...overrides
  };
}

test("GitHub-hosted refreshes remain v1 because their stable egress region is unprovable", () => {
  assert.throws(
    () => featuredReportPreflight(input({ egressRegion: "us-east", egressAttested: "1" })),
    /GitHub-hosted runner placement is not a truthful comparison region/
  );
});

test("r2 requires a controlled region and explicit operator attestation", () => {
  const selfHosted = { runnerEnvironment: "self-hosted", egressLabel: "controlled-egress" };
  assert.throws(
    () => featuredReportPreflight(input(selfHosted)),
    /requires SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION/
  );
  assert.throws(
    () => featuredReportPreflight(input({ ...selfHosted, egressLabel: "controlled-egress", egressRegion: "iad-egress-1" })),
    /FEATURED_R2_EGRESS_ATTESTED=1/
  );

  const plan = featuredReportPreflight(
    input({
      ...selfHosted,
      egressRegion: "iad-egress-1",
      egressAttested: "1"
    })
  );
  assert.equal(plan.comparison, false);
  assert.deepEqual(plan.environment, {
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: COMMIT,
    SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1",
    SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "1"
  });
  assert.equal(plan.summary.some((line) => line.includes("operator-attested self-hosted")), true);
  assert.equal(
    plan.summary.some((line) => line.includes("r2 scan generation does not rewrite existing report bytes")),
    true
  );
  assert.equal(plan.summary.some((line) => line.includes("retention process may delete unpinned reports")), true);
  assert.equal(plan.summary.some((line) => /untouched|immutable/i.test(line)), false);
});

test("r2 rejects malformed egress declarations before scanning", () => {
  assert.throws(
    () => featuredReportPreflight(input({ egressRegion: "unknown" })),
    /not a valid r2 egress region/
  );
  assert.throws(
    () => featuredReportPreflight(input({ egressLabel: `scanner${String.fromCharCode(0)}other` })),
    /contain no control characters/
  );
});

test("the producer fails closed on ambiguous source provenance", () => {
  assert.throws(
    () => featuredReportPreflight(input({ eventCommit: "b".repeat(40) })),
    /does not match checked-out HEAD/
  );
  assert.throws(
    () => featuredReportPreflight(input({ worktreeClean: false })),
    /checkout is dirty/
  );
  assert.throws(
    () => featuredReportPreflight(input({ eventCommit: "main" })),
    /full 40-character lowercase Git commit/
  );
});

test("v1 compatibility mode remains explicit and does not enable r2 prerequisites", () => {
  const plan = featuredReportPreflight(input({ mode: "v1", compareShields: "true" }));
  assert.deepEqual(plan.environment, {
    SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "0",
    SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "0"
  });
  assert.equal(
    plan.summary.some((line) => line.includes("v1 scan generation does not rewrite existing report bytes")),
    true
  );
  assert.equal(plan.summary.some((line) => line.includes("retention process may delete unpinned reports")), true);
  assert.equal(plan.summary.some((line) => /untouched|immutable/i.test(line)), false);
});

test("the featured workflow runs the r2 gate before building the scanner", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"), "utf8");
  const preflight = workflow.indexOf("Prepare featured report production");
  const build = workflow.indexOf("Build scanner app");
  assert.equal(preflight >= 0, true);
  assert.equal(build > preflight, true);
  assert.match(workflow, /FEATURED_REPORT_MODE:/);
  assert.match(workflow, /FEATURED_R2_EGRESS_ATTESTED:/);
  assert.match(workflow, /runs-on: \$\{\{ vars\.FEATURED_RUNNER_LABEL \|\| 'ubuntu-latest' \}\}/);
  assert.match(workflow, /featured-report-preflight-cli\.js/);
});

test("scanner workflow startup gates reject stale port owners and mismatched health", () => {
  const featured = readFileSync(path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"), "utf8");
  const single = readFileSync(path.join(process.cwd(), ".github", "workflows", "scan.yml"), "utf8");

  for (const workflow of [featured, single]) {
    assert.equal(workflow.includes("Port 3100 was already occupied before startup"), true);
    assert.equal(workflow.includes("node node_modules/next/dist/bin/next start --port 3100"), true);
    assert.equal(workflow.includes("app_pid=$!"), true);
    assert.equal(workflow.includes('kill -0 "$app_pid"'), true);
    assert.equal(workflow.includes("health?.deployment === expectedSha.toLowerCase()"), true);
    assert.equal(workflow.includes("health?.scansAvailable === true"), true);
    assert.match(workflow, /SITE_BEHAVIOR_LAB_BUILD_COMMIT: \$\{\{ github\.sha \}\}/);
  }

  assert.equal(featured.includes('"$FEATURED_REPORT_MODE"'), true);
  assert.equal(featured.includes('"$SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION"'), true);
  assert.equal(featured.includes("health?.checks?.scannerEgressRegion === expectedRegionStatus"), true);
  assert.equal(featured.includes("health?.checks?.consentVerification === expectedConsentStatus"), true);
  assert.equal(featured.includes("health?.checks?.publicR2Reports?.status === expectedR2Status"), true);

  assert.match(single, /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "0"/);
  assert.equal(single.includes('health?.checks?.publicR2Reports?.status === "disabled"'), true);
});

test("scanner publishers fail closed instead of rebasing validated generated output", () => {
  for (const file of ["scan-featured.yml", "scan.yml"]) {
    const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", file), "utf8");
    assert.equal(workflow.includes("git pull --rebase"), false);
    assert.equal(workflow.includes("for attempt in 1 2 3"), false);
    assert.equal(workflow.includes("if ! git push; then"), true);
    assert.equal(workflow.includes("refusing to rebase stale generated output"), true);
  }
});

test("embedded startup health validators accept only the requested producer contract", () => {
  const featured = readFileSync(path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"), "utf8");
  const single = readFileSync(path.join(process.cwd(), ".github", "workflows", "scan.yml"), "utf8");
  const directory = mkdtempSync(path.join(tmpdir(), "site-behavior-workflow-health-"));
  const healthPath = path.join(directory, "health.json");
  const featuredValidator = embeddedHealthValidator(featured);
  const singleValidator = embeddedHealthValidator(single);

  try {
    const r2Health = {
      ok: true,
      deployment: COMMIT,
      scansAvailable: true,
      checks: {
        publicR2Reports: { status: "enabled" },
        scannerEgressRegion: "configured",
        consentVerification: "enabled"
      }
    };
    writeFileSync(healthPath, JSON.stringify(r2Health));
    assert.equal(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    writeFileSync(healthPath, JSON.stringify({ ...r2Health, deployment: "b".repeat(40) }));
    assert.notEqual(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    writeFileSync(healthPath, JSON.stringify({ ...r2Health, checks: { ...r2Health.checks, consentVerification: "disabled" } }));
    assert.notEqual(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    const v1Health = {
      ok: true,
      deployment: COMMIT,
      scansAvailable: true,
      checks: { publicR2Reports: { status: "disabled" } }
    };
    writeFileSync(healthPath, JSON.stringify(v1Health));
    assert.equal(runHealthValidator(singleValidator, [healthPath, COMMIT]), 0);
    writeFileSync(healthPath, JSON.stringify({ ...v1Health, scansAvailable: false }));
    assert.notEqual(runHealthValidator(singleValidator, [healthPath, COMMIT]), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function embeddedHealthValidator(workflow: string): string {
  const match = workflow.match(/if node -e '\n(\s+const fs = require\("node:fs"\);[\s\S]*?)\n\s+' "\$health_path"/);
  assert.ok(match?.[1], "workflow must contain an embedded startup health validator");
  return match[1];
}

function runHealthValidator(source: string, args: string[]): number | null {
  return spawnSync(process.execPath, ["-e", source, ...args], { encoding: "utf8" }).status;
}

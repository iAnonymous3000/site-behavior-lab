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
    eventName: "schedule",
    eventCommit: COMMIT,
    checkoutCommit: COMMIT,
    worktreeClean: true,
    compareGpc: "false",
    compareShields: "false",
    compareConsent: "false",
    runnerEnvironment: "github-hosted",
    egressLabel: "controlled-self-hosted",
    egressRegion: "",
    egressAttested: "",
    chromiumSandbox: "1",
    controlledRunnerConfigured: true,
    measurementFreeze: false,
    ...overrides
  };
}

test("a measurement freeze quiesces both v1 lanes and discloses itself on the r2 lane", () => {
  // The freeze refuses the scheduled fallback AND the manual compatibility
  // lane: any v1 report minted mid-epoch would join the corpus under a
  // producer identity the epoch did not freeze.
  for (const eventName of ["schedule", "workflow_dispatch", "repository_dispatch"]) {
    for (const controlledRunnerConfigured of [true, false]) {
      assert.throws(
        () =>
          featuredReportPreflight(
            input({ mode: "v1", eventName, controlledRunnerConfigured, measurementFreeze: true })
          ),
        /measurement freeze is active/i
      );
    }
  }

  const plan = featuredReportPreflight(
    input({
      measurementFreeze: true,
      runnerEnvironment: "self-hosted",
      egressRegion: "us-east",
      egressAttested: "1"
    })
  );
  assert.equal(plan.mode, "r2");
  assert.equal(
    plan.summary.some((line) => /measurement freeze active/i.test(line)),
    true,
    "the collection lane must disclose that it ran inside a freeze"
  );
});

test("automated r2 production rejects GitHub-hosted placement instead of falling back to v1", () => {
  assert.throws(
    () => featuredReportPreflight(input({ egressRegion: "us-east", egressAttested: "1" })),
    /GitHub-hosted runner placement is not a truthful comparison region/
  );
});

test("r2 requires a controlled region and explicit operator attestation", () => {
  const selfHosted = { runnerEnvironment: "self-hosted", egressLabel: "controlled-self-hosted" };
  assert.throws(
    () => featuredReportPreflight(input(selfHosted)),
    /requires SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION/
  );
  assert.throws(
    () => featuredReportPreflight(input({ ...selfHosted, egressRegion: "iad-egress-1" })),
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
    SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "1",
    SITE_BEHAVIOR_LAB_REPORT_ACQUISITION: "ci-workflow"
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
  assert.throws(
    () =>
      featuredReportPreflight(
        input({
          runnerEnvironment: "self-hosted",
          egressLabel: "controlled-egress",
          egressRegion: "iad-egress-1",
          egressAttested: "1"
        })
      ),
    /must be controlled-self-hosted/
  );
  for (const egressLabel of ["this scanner instance", "test", "docker-smoke"]) {
    assert.throws(
      () =>
        featuredReportPreflight(
          input({
            runnerEnvironment: "self-hosted",
            egressLabel,
            egressRegion: "iad-egress-1",
            egressAttested: "1"
          })
        ),
      /must be controlled-self-hosted/,
      egressLabel
    );
  }
});

test("all committed report acquisition requires the Chromium renderer sandbox", () => {
  assert.throws(
    () => featuredReportPreflight(input({ chromiumSandbox: "0" })),
    /requires SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1/
  );
  assert.throws(
    () => featuredReportPreflight(input({ mode: "v1", eventName: "workflow_dispatch", chromiumSandbox: undefined })),
    /requires SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1/
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
  const plan = featuredReportPreflight(input({ mode: "v1", eventName: "workflow_dispatch", compareShields: "true" }));
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

test("v1 cannot be selected by automated corpus production and a missing mode never defaults to it", () => {
  for (const eventName of ["schedule", "repository_dispatch"]) {
    assert.throws(
      () => featuredReportPreflight(input({ mode: "v1", eventName })),
      /explicit manual compatibility lane.*workflow_dispatch/
    );
  }
  assert.throws(
    () => featuredReportPreflight(input({ mode: undefined, eventName: "workflow_dispatch" })),
    /must be explicitly set.*no legacy default/
  );
});

test("an unprovisioned controlled runner allows only a loudly disclosed scheduled v1 fallback", () => {
  for (const eventName of ["schedule", "repository_dispatch"]) {
    const plan = featuredReportPreflight(
      input({ mode: "v1", eventName, controlledRunnerConfigured: false })
    );
    assert.equal(plan.mode, "v1");
    assert.deepEqual(plan.environment, {
      SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "0",
      SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "0"
    });
    assert.equal(
      plan.summary.some((line) => line.includes("scheduled fallback") && line.includes("not configured")),
      true,
      eventName
    );
    assert.equal(plan.warnings.length, 1, eventName);
    assert.match(plan.warnings[0], /fell back to the frozen v1 lane/);
    assert.match(plan.warnings[0], /FEATURED_RUNNER_LABEL/);
  }
  // The manual compatibility lane is an explicit human choice, not a fallback,
  // and must stay warning-free in both runner states.
  for (const controlledRunnerConfigured of [true, false]) {
    const manual = featuredReportPreflight(
      input({ mode: "v1", eventName: "workflow_dispatch", controlledRunnerConfigured })
    );
    assert.deepEqual(manual.warnings, []);
    assert.equal(manual.summary.some((line) => line.includes("explicit manual frozen v1")), true);
  }
});

test("both committed-report workflows force automated r2 and gate before scanning", () => {
  for (const file of ["scan-featured.yml", "scan.yml"]) {
    const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", file), "utf8");
    const preflight = workflow.indexOf("featured-report-preflight-cli.js");
    const provenance = workflow.indexOf("Verify server-owned acquisition provenance");
    const chromium = workflow.indexOf("Install Chromium");
    const build = workflow.indexOf("Build scanner app");
    assert.equal(preflight >= 0, true, file);
    assert.equal(provenance > preflight, true, file);
    assert.equal(chromium > provenance, true, file);
    assert.equal(chromium > preflight, true, file);
    assert.equal(build > preflight, true, file);
    assert.match(workflow, /default: r2/, file);
    const expectedModeLine =
      file === "scan-featured.yml"
        ? "FEATURED_REPORT_MODE: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.report_mode || (vars.FEATURED_RUNNER_LABEL && 'r2' || 'v1') }}"
        : "FEATURED_REPORT_MODE: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.report_mode || 'r2' }}";
    assert.equal(workflow.includes(expectedModeLine), true, file);
    if (file === "scan-featured.yml") {
      // The fallback must be coupled to the SAME variable that routes the
      // controlled runner, so mode and placement can never disagree.
      assert.equal(
        workflow.includes("FEATURED_CONTROLLED_RUNNER_CONFIGURED: ${{ vars.FEATURED_RUNNER_LABEL && '1' || '' }}"),
        true,
        file
      );
    }
    assert.equal(workflow.includes("github.event.client_payload.report_mode"), false, file);
    assert.equal(workflow.includes("vars.FEATURED_REPORT_MODE"), false, file);
    assert.match(workflow, /FEATURED_R2_EGRESS_ATTESTED:/, file);
    // Both producers bind the freeze variable so the shared preflight can
    // refuse v1 lanes mid-freeze, and scan.yml additionally gates its
    // publish job on the same variable.
    assert.equal(
      workflow.includes(
        "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE: ${{ vars.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE || '' }}"
      ),
      true,
      file
    );
    if (file === "scan.yml") {
      assert.match(
        workflow,
        /publish:\n\s+name: Validate and Publish Static Report\n[\s\S]{0,400}?if: vars\.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE != '1'/,
        file
      );
    }
    assert.match(workflow, /SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "1"/, file);
    assert.match(workflow, /runs-on:.*github\.event_name == 'workflow_dispatch'.*FEATURED_RUNNER_LABEL.*'ubuntu-latest'/, file);
    assert.match(workflow, /git commit -m "Add manual v1 compatibility scan report/, file);
  }
});

test("the shared preflight CLI binds the event and both workflow flag namespaces", () => {
  const cli = readFileSync(path.join(process.cwd(), "lib", "featured-report-preflight-cli.ts"), "utf8");
  assert.match(cli, /eventName: process\.env\.GITHUB_EVENT_NAME/);
  for (const axis of ["GPC", "SHIELDS", "CONSENT"]) {
    assert.equal(
      cli.includes(`process.env.FEATURED_COMPARE_${axis} ?? process.env.SCAN_COMPARE_${axis}`),
      true,
      axis
    );
  }
  assert.match(cli, /controlledRunnerConfigured: .*FEATURED_CONTROLLED_RUNNER_CONFIGURED/);
  assert.match(cli, /measurementFreeze: .*SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE.* === "1"/);
  assert.match(cli, /::warning::\$\{warning\}/);
});

test("manual v1 compatibility runs cannot reconcile the authoritative r2 refresh issue", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "scan-featured.yml"), "utf8");
  // Scheduled runs stay authoritative (including the disclosed v1 fallback),
  // manual v1 dispatches never are.
  assert.match(
    workflow,
    /- name: Reconcile the featured-corpus refresh issue[\s\S]*?\(env\.FEATURED_REPORT_MODE == 'r2' \|\| github\.event_name == 'schedule'\)[\s\S]*?steps\.refresh_alert\.outputs\.authoritative == 'true'/
  );
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
    const unsetRegion = workflow.indexOf("unset SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION");
    const startScanner = workflow.indexOf("node node_modules/next/dist/bin/next start --port 3100");
    assert.equal(unsetRegion >= 0 && unsetRegion < startScanner, true);
    assert.match(workflow, /SITE_BEHAVIOR_LAB_BUILD_COMMIT: \$\{\{ github\.sha \}\}/);
  }

  assert.equal(featured.includes('"$FEATURED_REPORT_MODE"'), true);
  assert.equal(featured.includes('"$expected_egress_region"'), true);
  assert.equal(featured.includes("health?.checks?.scannerEgressRegion === expectedRegionStatus"), true);
  assert.equal(featured.includes("health?.checks?.consentVerification === expectedConsentStatus"), true);
  assert.equal(featured.includes("health?.checks?.publicR2Reports?.status === expectedR2Status"), true);
  assert.equal(single.includes('"$FEATURED_REPORT_MODE"'), true);
  assert.equal(single.includes('"$expected_egress_region"'), true);
  assert.equal(single.includes("health?.checks?.scannerEgressRegion === expectedRegionStatus"), true);
  assert.equal(single.includes("health?.checks?.consentVerification === expectedConsentStatus"), true);
  assert.equal(single.includes("health?.checks?.publicR2Reports?.status === expectedR2Status"), true);
  assert.doesNotMatch(single, /SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: "0"/);
});

test("scanner publishers fail closed instead of rebasing validated generated output", () => {
  for (const file of ["scan-featured.yml", "scan.yml"]) {
    const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", file), "utf8");
    assert.equal(workflow.includes("git pull --rebase"), false);
    assert.equal(workflow.includes("for attempt in 1 2 3"), false);
    // The publisher proposes on a unique per-attempt automation/* branch, so
    // it never rewrites its source branch and never needs a retry loop; a base
    // branch that advanced surfaces as a merge conflict on the pull request.
    // The push-target contract itself is pinned in
    // lib/report-publication-workflow.test.ts; this test keeps only the
    // fail-closed properties so the two files cannot disagree about the target.
    assert.equal(workflow.includes('git push origin "HEAD:refs/heads/$GITHUB_REF_NAME"'), false);
    assert.equal(workflow.includes("surfaces as an ordinary merge conflict"), true);
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
        consentVerification: "enabled",
        chromiumSandbox: "enabled"
      }
    };
    writeFileSync(healthPath, JSON.stringify(r2Health));
    assert.equal(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);
    assert.equal(runHealthValidator(singleValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    writeFileSync(healthPath, JSON.stringify({ ...r2Health, deployment: "b".repeat(40) }));
    assert.notEqual(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    writeFileSync(healthPath, JSON.stringify({ ...r2Health, checks: { ...r2Health.checks, consentVerification: "disabled" } }));
    assert.notEqual(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    writeFileSync(healthPath, JSON.stringify({ ...r2Health, checks: { ...r2Health.checks, chromiumSandbox: "disabled" } }));
    assert.notEqual(runHealthValidator(featuredValidator, [healthPath, COMMIT, "r2", "iad-egress-1"]), 0);

    const v1Health = {
      ok: true,
      deployment: COMMIT,
      scansAvailable: true,
      checks: {
        publicR2Reports: { status: "disabled" },
        scannerEgressRegion: "unrecorded",
        consentVerification: "disabled",
        chromiumSandbox: "enabled"
      }
    };
    writeFileSync(healthPath, JSON.stringify(v1Health));
    assert.equal(runHealthValidator(featuredValidator, [healthPath, COMMIT, "v1", ""]), 0);
    assert.equal(runHealthValidator(singleValidator, [healthPath, COMMIT, "v1", ""]), 0);
    writeFileSync(healthPath, JSON.stringify({ ...v1Health, scansAvailable: false }));
    assert.notEqual(runHealthValidator(singleValidator, [healthPath, COMMIT, "v1", ""]), 0);
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

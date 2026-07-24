import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
const supplyChainStart = workflow.indexOf("\n  supply-chain:");
const appStart = workflow.indexOf("\n  app:", supplyChainStart);
const promoteStart = workflow.indexOf("\n  promote:");
const attestStart = workflow.indexOf("\n  attest:");
const supplyChainJob = workflow.slice(supplyChainStart, appStart);
const dockerStart = workflow.indexOf("\n  docker:");
const dockerJob = workflow.slice(dockerStart, attestStart);
const attestJob = workflow.slice(attestStart, promoteStart);
const promoteJob = workflow.slice(promoteStart);

test("supply-chain CI uses a read-only job and blocks production promotion", () => {
  assert.notEqual(supplyChainStart, -1);
  assert.notEqual(appStart, -1);
  assert.match(supplyChainJob, /runs-on: ubuntu-latest\n\s+timeout-minutes: 35/);
  assert.match(supplyChainJob, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(supplyChainJob, /contents: write|pull-requests: write|security-events: write/);
  assert.match(promoteJob, /needs:\n\s+- supply-chain\n\s+- app\n\s+- docker\n\s+- smoke\n\s+- attest/);
});

test("provenance attestation is isolated, immutable, and limited to exact evidence manifests", () => {
  assert.notEqual(attestStart, -1);
  assert.ok(dockerStart < attestStart && attestStart < promoteStart);
  assert.match(
    attestJob,
    /needs:\n\s+- supply-chain\n\s+- app\n\s+- docker\n\s+- smoke/
  );
  assert.match(
    attestJob,
    /if: >-\n\s+github\.event_name != 'pull_request' &&\n\s+github\.ref == 'refs\/heads\/main'/
  );
  assert.match(
    attestJob,
    /permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write\n\s+artifact-metadata: write/
  );
  assert.doesNotMatch(attestJob, /contents: write|packages: write|pull-requests: write|security-events: write/);
  assert.doesNotMatch(attestJob, /actions\/checkout|npm (?:ci|run)|docker |site-behavior-lab:smoke/);

  assert.equal(
    (attestJob.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/g) ?? [])
      .length,
    2
  );
  assert.match(attestJob, /name: exact-sha-static-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(attestJob, /name: exact-sha-container-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(attestJob, /receipt\?\.source\?\.commit !== process\.env\.GITHUB_SHA/);

  assert.equal(
    (attestJob.match(/actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4\.2\.0/g) ?? []).length,
    2
  );
  assert.match(
    attestJob,
    /subject-path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/static\/site-behavior-lab-static-release-evidence\.json/
  );
  assert.match(
    attestJob,
    /subject-path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/container\/site-behavior-lab-container-release-evidence\.json/
  );
  assert.doesNotMatch(attestJob, /subject-path:[^\n]*(?:out|site-behavior-lab:smoke|Cloudflare)/);

  assert.match(attestJob, /steps\.attest_static\.outputs\.bundle-path/);
  assert.match(attestJob, /steps\.attest_container\.outputs\.bundle-path/);
  assert.match(attestJob, /attestation-results\.json/);
  assert.match(
    attestJob,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/
  );
  assert.match(attestJob, /name: exact-sha-provenance-attestations-\$\{\{ github\.sha \}\}/);
  assert.match(attestJob, /path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-attestations\//);
  assert.match(attestJob, /if-no-files-found: error/);
  assert.match(attestJob, /retention-days: 90/);
});

test("npm audit is online, fail-closed, and emits validated JSON", () => {
  const start = supplyChainJob.indexOf("- name: Audit npm dependencies against the live registry");
  const end = supplyChainJob.indexOf("- name: Audit Rust dependencies", start);
  const step = supplyChainJob.slice(start, end);

  assert.match(step, /id: npm_audit\n\s+continue-on-error: true/);
  assert.match(step, /NPM_CONFIG_OFFLINE: "false"/);
  assert.match(step, /NPM_CONFIG_PREFER_OFFLINE: "false"/);
  assert.match(step, /NPM_CONFIG_PREFER_ONLINE: "true"/);
  assert.match(step, /npm ping --registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(step, /npm audit \\\n[\s\S]*--json/);
  assert.match(step, /--audit-level=low/);
  assert.match(step, /--package-lock-only/);
  assert.match(step, /--ignore-scripts/);
  assert.match(step, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(step, /npm-audit\.json/);
  assert.match(step, /JSON\.parse/);
  assert.match(step, /exit "\$audit_status"/);
  assert.doesNotMatch(step, /--offline|NPM_CONFIG_OFFLINE: "true"/);
});

test("deterministic third-party and WASM integrity contracts are blocking gates", () => {
  assert.match(
    supplyChainJob,
    /- name: Install locked dependencies\n\s+id: supply_chain_npm_ci\n\s+continue-on-error: true\n\s+run: npm ci --ignore-scripts/
  );
  assert.match(
    supplyChainJob,
    /- name: Verify third-party supply-chain inventory\n\s+id: third_party_supply_chain\n\s+continue-on-error: true\n\s+run: npm run supply-chain:third-party:check/
  );
  assert.match(
    supplyChainJob,
    /status=blocked integrity\/provenance[\s\S]*- name: Verify vendored WASM static integrity contract\n\s+id: wasm_static_integrity\n\s+continue-on-error: true\n\s+run: npm run wasm:verify-reproducibility/
  );
  assert.match(supplyChainJob, /It intentionally does not claim local rebuild byte parity/);
});

test("RustSec audit uses an exact tool and a per-run fresh advisory database", () => {
  const start = supplyChainJob.indexOf("- name: Audit Rust dependencies against a fresh RustSec database");
  const end = supplyChainJob.indexOf("- name: Scan repository and container configuration", start);
  const step = supplyChainJob.slice(start, end);

  assert.match(step, /id: cargo_audit\n\s+continue-on-error: true/);
  assert.match(step, /rustsec-advisory-db-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(step, /test ! -e "\$RUSTSEC_DB"/);
  assert.match(step, /cargo install cargo-audit --locked --version 0\.22\.1 --force/);
  assert.match(step, /cargo-audit-audit 0\.22\.1/);
  assert.match(step, /--url https:\/\/github\.com\/RustSec\/advisory-db\.git/);
  assert.match(step, /--file tools\/adblock-wasm\/Cargo\.lock/);
  assert.match(step, /--deny warnings/);
  assert.match(step, /--format json/);
  assert.match(step, /cargo-audit\.json/);
  assert.match(step, /JSON\.parse/);
  assert.match(step, /exit "\$audit_status"/);
  assert.doesNotMatch(step, /--no-fetch|--stale/);
});

test("Trivy is immutable, exact-versioned, fresh, and scans deployable configuration", () => {
  const start = supplyChainJob.indexOf("- name: Scan repository and container configuration with Trivy");
  const end = supplyChainJob.indexOf("- name: Preserve supply-chain security reports", start);
  const steps = supplyChainJob.slice(start, end);

  assert.match(steps, /id: trivy_scan\n\s+continue-on-error: true/);
  assert.match(
    steps,
    /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0\.36\.0/
  );
  assert.match(steps, /version: v0\.70\.0/);
  assert.match(steps, /scan-type: fs/);
  assert.match(steps, /scan-ref: \./);
  assert.match(steps, /scanners: vuln,secret,misconfig/);
  assert.match(steps, /format: json/);
  assert.match(steps, /trivy-filesystem\.json/);
  assert.match(steps, /exit-code: "1"/);
  assert.match(steps, /severity: HIGH,CRITICAL/);
  assert.match(steps, /ignore-unfixed: "false"/);
  assert.match(steps, /cache: "false"/);
  assert.match(steps, /skip-db-update: "false"/);
  assert.match(steps, /skip-java-db-update: "false"/);
  assert.match(steps, /id: trivy_report\n\s+if: always\(\)\n\s+continue-on-error: true/);
  assert.match(steps, /test -s "\$SUPPLY_CHAIN_REPORT_DIR\/trivy-filesystem\.json"/);
  assert.match(steps, /JSON\.parse/);
});

test("all machine-readable reports upload on failure before outcomes are enforced", () => {
  const start = supplyChainJob.indexOf("- name: Preserve supply-chain security reports");
  const steps = supplyChainJob.slice(start);

  assert.match(steps, /id: supply_chain_report_upload\n\s+if: always\(\)/);
  assert.match(
    steps,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/
  );
  assert.match(steps, /path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-supply-chain\//);
  assert.match(steps, /if-no-files-found: error/);
  assert.match(steps, /retention-days: 90/);
  assert.match(steps, /- name: Enforce all supply-chain security gates\n\s+if: always\(\)/);
  for (const outcome of [
    "NPM_CI_OUTCOME",
    "THIRD_PARTY_OUTCOME",
    "WASM_STATIC_INTEGRITY_OUTCOME",
    "NPM_AUDIT_OUTCOME",
    "CARGO_AUDIT_OUTCOME",
    "TRIVY_SCAN_OUTCOME",
    "TRIVY_REPORT_OUTCOME",
    "REPORT_UPLOAD_OUTCOME"
  ]) {
    assert.match(steps, new RegExp(`${outcome}: \\$\\{\\{ steps\\.`));
    assert.match(steps, new RegExp(`\\$${outcome}`));
  }
  assert.match(steps, /if \[ "\$outcome" != "success" \]/);
  assert.match(steps, /exit "\$failed"/);
});

test("the smoke-tested container image has its own fresh blocking Trivy gate", () => {
  const smoke = dockerJob.indexOf("npm run test:smoke:docker");
  const scan = dockerJob.indexOf("- name: Scan smoke-tested container image with Trivy");
  const evidence = dockerJob.indexOf("- name: Record exact-SHA container build evidence");
  assert.ok(smoke < scan && scan < evidence);

  assert.match(dockerJob, /id: trivy_image_scan\n\s+continue-on-error: true/);
  assert.match(
    dockerJob,
    /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0\.36\.0/
  );
  assert.match(dockerJob, /version: v0\.70\.0/);
  assert.match(dockerJob, /scan-type: image/);
  assert.match(dockerJob, /image-ref: site-behavior-lab:smoke/);
  assert.match(dockerJob, /scanners: vuln/);
  assert.match(dockerJob, /format: json/);
  assert.match(dockerJob, /trivy-container-image\.json/);
  assert.match(dockerJob, /exit-code: "1"/);
  assert.match(dockerJob, /severity: HIGH,CRITICAL/);
  assert.match(dockerJob, /ignore-unfixed: "false"/);
  assert.match(dockerJob, /cache: "false"/);
  assert.match(dockerJob, /skip-db-update: "false"/);
  assert.match(dockerJob, /skip-java-db-update: "false"/);
  assert.match(dockerJob, /Both[\s\S]*fixed and unfixed HIGH\/CRITICAL findings are blocking/);
  assert.match(dockerJob, /id: trivy_image_report\n\s+if: always\(\)\n\s+continue-on-error: true/);
  assert.match(dockerJob, /id: trivy_image_report_upload\n\s+if: always\(\)/);
  assert.match(
    dockerJob,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/
  );
  assert.match(dockerJob, /if-no-files-found: error/);
  assert.match(dockerJob, /- name: Enforce container vulnerability gate\n\s+if: always\(\)/);
  for (const outcome of ["TRIVY_IMAGE_SCAN_OUTCOME", "TRIVY_IMAGE_REPORT_OUTCOME", "TRIVY_IMAGE_UPLOAD_OUTCOME"]) {
    assert.match(dockerJob, new RegExp(`${outcome}: \\$\\{\\{ steps\\.`));
    assert.match(dockerJob, new RegExp(`\\$${outcome}`));
  }
});

test("every CI Node job verifies the exact reviewed Node and npm runtime", () => {
  const setupCount = (workflow.match(/uses: actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/g) ?? []).length;
  assert.equal(setupCount, 4);
  assert.equal((workflow.match(/node-version: 24\.14\.1/g) ?? []).length, setupCount);
  assert.equal((workflow.match(/test "\$\(node --version\)" = "v24\.14\.1"/g) ?? []).length, setupCount);
  assert.equal((workflow.match(/test "\$\(npm --version\)" = "11\.11\.0"/g) ?? []).length, setupCount);
});

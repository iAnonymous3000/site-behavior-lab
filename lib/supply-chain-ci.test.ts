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
const smokeStart = workflow.indexOf("\n  smoke:");
const dockerStart = workflow.indexOf("\n  docker:");
const appJob = workflow.slice(appStart, smokeStart);
const smokeJob = workflow.slice(smokeStart, dockerStart);
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

test("every unit-suite and smoke job pins a budget below the 6-hour default", () => {
  // The refresh lane learned this on 2026-08-03: one deadlocked test inherits
  // the 360-minute default and burns the whole job budget. Every job that
  // runs the suite or a live app must pin its own ceiling, like
  // update-brave-lists.yml does for its unit-test step.
  assert.notEqual(smokeStart, -1);
  assert.match(appJob, /\n {4}timeout-minutes: 45\n/);
  assert.match(smokeJob, /\n {4}timeout-minutes: 45\n/);
  assert.match(dockerJob, /\n {4}timeout-minutes: 45\n/);
});

test("provenance attestation is isolated, immutable, and limited to exact evidence subjects", () => {
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
  assert.match(attestJob, /CONTAINER_PACKAGE_INVENTORY_PATH:/);
  assert.match(attestJob, /site-behavior-lab-container-package-inventory\.json/);
  assert.match(attestJob, /inventory\?\.source\?\.commit !== process\.env\.GITHUB_SHA/);
  assert.match(attestJob, /inventory\?\.image\?\.id !== image\.imageId/);
  assert.match(attestJob, /inventory\.packageSetDigest !== sha256\(JSON\.stringify\(inventory\.packages\)\)/);
  assert.match(attestJob, /Container package inventory is not canonical JSON/);

  assert.equal(
    (attestJob.match(/actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/g) ?? []).length,
    3
  );
  assert.match(
    attestJob,
    /subject-path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/static\/site-behavior-lab-static-release-evidence\.json/
  );
  assert.match(
    attestJob,
    /subject-path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/container\/site-behavior-lab-container-release-evidence\.json/
  );
  assert.match(
    attestJob,
    /subject-path: \$\{\{ runner\.temp \}\}\/site-behavior-lab-attestation-subjects\/container\/site-behavior-lab-container-package-inventory\.json/
  );
  assert.doesNotMatch(attestJob, /subject-path:[^\n]*(?:out|site-behavior-lab:smoke|Cloudflare)/);

  assert.match(attestJob, /steps\.attest_static\.outputs\.bundle-path/);
  assert.match(attestJob, /steps\.attest_container\.outputs\.bundle-path/);
  assert.match(attestJob, /steps\.attest_container_packages\.outputs\.bundle-path/);
  assert.match(attestJob, /container-package-inventory\.bundle\.json/);
  assert.match(attestJob, /containerPackageInventory:/);
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
    /- name: Verify third-party review ledger coverage\n\s+id: third_party_review_ledger\n\s+continue-on-error: true\n\s+run: npm run supply-chain:reviews:check/
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
  assert.match(steps, /cache-dir: \$\{\{ runner\.temp \}\}\/trivy-cache/);
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
    "REVIEW_LEDGER_OUTCOME",
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

test("the smoke-tested container image keeps its fresh blocking vulnerability gate", () => {
  const smoke = dockerJob.indexOf("npm run test:smoke:docker");
  const scanStart = dockerJob.indexOf("- name: Scan smoke-tested container image with Trivy");
  const scanEnd = dockerJob.indexOf("- name: Validate Trivy container machine-readable report", scanStart);
  const scan = dockerJob.slice(scanStart, scanEnd);
  const reportStart = scanEnd;
  const reportEnd = dockerJob.indexOf(
    "- name: Inventory smoke-tested container OS-package licenses with Trivy",
    reportStart
  );
  const report = dockerJob.slice(reportStart, reportEnd);
  const evidence = dockerJob.indexOf("- name: Record exact-SHA container build evidence");
  assert.ok(smoke < scanStart && scanStart < evidence);

  assert.match(scan, /id: trivy_image_scan\n\s+continue-on-error: true/);
  assert.match(
    scan,
    /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0\.36\.0/
  );
  assert.match(scan, /version: v0\.70\.0/);
  assert.match(scan, /scan-type: image/);
  assert.match(scan, /image-ref: site-behavior-lab:smoke/);
  assert.match(scan, /scanners: vuln/);
  assert.match(scan, /format: json/);
  assert.match(scan, /output: \$\{\{ runner\.temp \}\}\/trivy-container-image\.json/);
  assert.match(scan, /exit-code: "1"/);
  assert.match(scan, /severity: HIGH,CRITICAL/);
  assert.match(scan, /ignore-unfixed: "false"/);
  assert.match(scan, /cache: "false"/);
  assert.match(scan, /cache-dir: \$\{\{ runner\.temp \}\}\/trivy-cache/);
  assert.match(dockerJob, /Both[\s\S]*fixed and unfixed HIGH\/CRITICAL findings are blocking/);
  assert.match(report, /id: trivy_image_report\n\s+if: always\(\)\n\s+continue-on-error: true/);
});

test("exact-image OS licenses are normalized, review-bound, preserved, and independently attested", () => {
  const licenseStart = dockerJob.indexOf(
    "- name: Inventory smoke-tested container OS-package licenses with Trivy"
  );
  const licenseEnd = dockerJob.indexOf(
    "- name: Validate Trivy container license inventory report",
    licenseStart
  );
  const licenseScan = dockerJob.slice(licenseStart, licenseEnd);
  const licenseReportEnd = dockerJob.indexOf(
    "- name: Record exact-SHA container build evidence",
    licenseEnd
  );
  const licenseReport = dockerJob.slice(licenseEnd, licenseReportEnd);
  const evidence = dockerJob.indexOf("- name: Record exact-SHA container build evidence");
  const normalize = dockerJob.indexOf("- name: Normalize exact-image OS-package license inventory");
  const review = dockerJob.indexOf("- name: Verify exact-image package review coverage");
  const evidenceUpload = dockerJob.indexOf("- name: Preserve exact-SHA container build evidence");
  const rawUpload = dockerJob.indexOf("- name: Preserve raw container security reports");
  const enforce = dockerJob.indexOf("- name: Enforce container security and package-evidence gates");

  assert.ok(
    licenseStart < evidence &&
      evidence < normalize &&
      normalize < review &&
      review < evidenceUpload &&
      evidenceUpload < rawUpload &&
      rawUpload < enforce
  );
  assert.equal(
    (
      dockerJob.match(
        /uses: aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0\.36\.0/g
      ) ?? []
    ).length,
    2
  );
  assert.match(licenseScan, /id: trivy_image_license_scan\n\s+continue-on-error: true/);
  assert.match(licenseScan, /version: v0\.70\.0/);
  assert.match(licenseScan, /scan-type: image/);
  assert.match(licenseScan, /image-ref: site-behavior-lab:smoke/);
  assert.match(licenseScan, /scanners: license/);
  assert.match(licenseScan, /vuln-type: os/);
  assert.match(licenseScan, /list-all-pkgs: "true"/);
  assert.match(licenseScan, /format: json/);
  assert.match(
    licenseScan,
    /output: \$\{\{ runner\.temp \}\}\/trivy-container-image-licenses\.json/
  );
  assert.match(licenseScan, /exit-code: "0"/);
  assert.match(licenseScan, /severity: UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL/);
  assert.match(licenseScan, /cache: "false"/);
  assert.match(
    licenseScan,
    /cache-dir: \$\{\{ runner\.temp \}\}\/trivy-license-cache/
  );
  assert.match(
    licenseReport,
    /id: trivy_image_license_report\n\s+if: always\(\)\n\s+continue-on-error: true/
  );
  assert.match(
    dockerJob,
    /npm run supply-chain:container-inventory --[\s\S]*--trivy-report "\$RUNNER_TEMP\/trivy-container-image-licenses\.json"[\s\S]*--container-evidence "\$RUNNER_TEMP\/site-behavior-lab-container-release-evidence\.json"[\s\S]*--source-commit "\$GITHUB_SHA"[\s\S]*--output "\$RUNNER_TEMP\/site-behavior-lab-container-package-inventory\.json"/
  );
  assert.match(
    dockerJob,
    /npm run supply-chain:container-reviews:check --[\s\S]*--inventory "\$RUNNER_TEMP\/site-behavior-lab-container-package-inventory\.json"/
  );
  assert.match(
    dockerJob,
    /name: exact-sha-container-evidence-\$\{\{ github\.sha \}\}[\s\S]*site-behavior-lab-container-release-evidence\.json[\s\S]*site-behavior-lab-container-package-inventory\.json/
  );
  assert.match(
    dockerJob,
    /name: container-security-\$\{\{ github\.sha \}\}[\s\S]*trivy-container-image\.json[\s\S]*trivy-container-image-licenses\.json/
  );
  assert.match(dockerJob, /id: trivy_image_report_upload\n\s+if: always\(\)/);
  assert.match(
    dockerJob,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/
  );
  assert.match(dockerJob, /if-no-files-found: error/);
  assert.match(
    dockerJob,
    /- name: Enforce container security and package-evidence gates\n\s+if: always\(\)/
  );
  const outcomes = {
    TRIVY_IMAGE_SCAN_OUTCOME: "trivy_image_scan",
    TRIVY_IMAGE_REPORT_OUTCOME: "trivy_image_report",
    TRIVY_IMAGE_LICENSE_SCAN_OUTCOME: "trivy_image_license_scan",
    TRIVY_IMAGE_LICENSE_REPORT_OUTCOME: "trivy_image_license_report",
    CONTAINER_PACKAGE_INVENTORY_OUTCOME: "container_package_inventory",
    CONTAINER_PACKAGE_REVIEWS_OUTCOME: "container_package_reviews",
    CONTAINER_EVIDENCE_UPLOAD_OUTCOME: "container_evidence_upload",
    TRIVY_IMAGE_UPLOAD_OUTCOME: "trivy_image_report_upload"
  };
  for (const [variable, step] of Object.entries(outcomes)) {
    assert.match(
      dockerJob,
      new RegExp(`${variable}: \\\$\\{\\{ steps\\.${step}\\.outcome \\}\\}`)
    );
    assert.match(dockerJob, new RegExp(`\\$${variable}`));
  }
});

test("every CI Node job verifies the exact reviewed Node and npm runtime", () => {
  const setupCount = (workflow.match(/uses: actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/g) ?? []).length;
  assert.equal(setupCount, 4);
  assert.equal((workflow.match(/node-version: 24\.14\.1/g) ?? []).length, setupCount);
  assert.equal((workflow.match(/test "\$\(node --version\)" = "v24\.14\.1"/g) ?? []).length, setupCount);
  assert.equal((workflow.match(/test "\$\(npm --version\)" = "11\.11\.0"/g) ?? []).length, setupCount);
});

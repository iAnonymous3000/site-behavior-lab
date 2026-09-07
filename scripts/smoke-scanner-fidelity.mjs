#!/usr/bin/env node
// Scan real websites and assert INVARIANTS OF THE SCANNER.
//
// Every other test in this repository drives the scanner with a fixture, and a
// fixture never has a ninety-character headline in its footer. That is exactly
// how a link-label budget came to censor the detector evidence of two-thirds of
// all scans, publish "this scan was cut short" over complete request logs, and
// report a time budget that had not run out — none of which any unit test,
// audit, or adversarial review caught, because none of them ever loaded a real
// page.
//
// THE RULE THAT KEEPS THIS FROM BEING FLAKY: assert only what must hold no
// matter what the sites do. Never assert a tracker count, a policy URL, or that
// a particular site is clean; those change hourly and would make the gate lie
// in both directions. Assert instead that the scanner does not contradict
// itself, does not claim a budget it did not exhaust, and does not describe an
// instrument's limit as a fact about the site. A site redesign must never turn
// this red; a scanner regression always must.
//
// The invariants themselves live in scanner-fidelity-invariants.mjs, which is
// version-aware across both wire generations (the v1 flat summary and the r2
// run.summary.counts nesting) and also renders every report through the same
// view/headline/findings/JSON-LD modules the site uses. This script only
// drives the scans.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readScannerFidelityResponse } from "./scanner-fidelity-response.mjs";
import { ensureRenderBridge, evaluateScanBody } from "./scanner-fidelity-invariants.mjs";
import {
  boundedInteger,
  buildAttemptLedger,
  sanitizeAttemptReason,
  scannerFidelitySitesOf,
  selectShard
} from "./scanner-fidelity-study-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SCANNER_FIDELITY_BASE_URL?.trim() || "http://127.0.0.1:3000";
const SITES_FILE = process.env.SCANNER_FIDELITY_SITES?.trim() || "public/scanner-fidelity-sites.json";
const OUTPUT_FILE = process.env.SCANNER_FIDELITY_OUTPUT?.trim() || "";
const MODE = process.env.SCANNER_FIDELITY_MODE?.trim() || "single";
const DEVICE = process.env.SCANNER_FIDELITY_DEVICE?.trim() || "desktop";
const EXPECTED_BUILD_COMMIT = process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT?.trim().toLowerCase() || "";
const REPETITIONS = boundedInteger(process.env.SCANNER_FIDELITY_REPETITIONS, 1, {
  min: 1,
  max: 5,
  label: "SCANNER_FIDELITY_REPETITIONS"
});
const SHARD_COUNT = boundedInteger(process.env.SCANNER_FIDELITY_SHARD_COUNT, 1, {
  min: 1,
  max: 32,
  label: "SCANNER_FIDELITY_SHARD_COUNT"
});
const SHARD_INDEX = boundedInteger(process.env.SCANNER_FIDELITY_SHARD_INDEX, 0, {
  min: 0,
  max: SHARD_COUNT - 1,
  label: "SCANNER_FIDELITY_SHARD_INDEX"
});
const MIN_REPEATABLE_TARGETS = boundedInteger(process.env.SCANNER_FIDELITY_MIN_REPEATABLE_TARGETS, 0, {
  min: 0,
  max: 1000,
  label: "SCANNER_FIDELITY_MIN_REPEATABLE_TARGETS"
});
const SCAN_TIMEOUT_MS = 180_000;
const MODES = new Set(["single", "shields", "gpc", "consent"]);
if (!MODES.has(MODE)) {
  throw new Error("SCANNER_FIDELITY_MODE must be single, shields, gpc, or consent.");
}
if (DEVICE !== "desktop" && DEVICE !== "mobile") {
  throw new Error("SCANNER_FIDELITY_DEVICE must be desktop or mobile.");
}

let failures = 0;
let checks = 0;
const pass = (message) => {
  checks += 1;
  console.log(`PASS ${message}`);
};
const fail = (message) => {
  failures += 1;
  console.log(`FAIL ${message}`);
  console.log(`::error title=Scanner fidelity::${message}`);
};


async function scan(url) {
  const payload = {
    url,
    device: DEVICE,
    gpcEnabled: false,
    consentMode: "observe"
  };
  if (MODE === "shields") payload.compareShields = true;
  if (MODE === "gpc") payload.compareGpc = true;
  if (MODE === "consent") payload.compareConsent = true;
  const response = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS)
  });
  // Server errors and unreadable wires must fail the run, even when enough
  // other targets answered to meet the ordinary coverage threshold.
  return readScannerFidelityResponse(response, `scan ${url}`);
}

const sitesPath = path.join(rootDir, SITES_FILE);
const sitesBytes = readFileSync(sitesPath);
const sitesFileDigest = createHash("sha256").update(sitesBytes).digest("hex");
const measurementIdentityPath = path.join(
  rootDir,
  "research",
  "measurement-candidate",
  "measurement-identity.json"
);
const measurementIdentityDigest = existsSync(measurementIdentityPath)
  ? createHash("sha256").update(readFileSync(measurementIdentityPath)).digest("hex")
  : null;
const config = JSON.parse(sitesBytes.toString("utf8"));
const allSites = scannerFidelitySitesOf(config);
const sites = selectShard(allSites, SHARD_INDEX, SHARD_COUNT);
const MIN_ANSWERING_TARGETS = Math.max(1, Math.ceil(sites.length * 0.6));

console.log(
  `Scanner fidelity: ${sites.length}/${allSites.length} targets, shard ${SHARD_INDEX + 1}/${SHARD_COUNT}, ` +
  `${REPETITIONS} repetition(s), mode=${MODE}, device=${DEVICE}, via ${BASE}\n`
);
// Build the render bridge BEFORE scanning: if the site's own render modules
// will not compile, that is a red gate, not a reason to silently check less.
const bridge = ensureRenderBridge();
const answeredTargets = new Set();
const censoredFamilies = new Map();
const attempts = [];
const collectionStartedAt = new Date().toISOString();

for (const site of sites) {
  for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
    const result = await scan(site.url).catch((error) => ({
      ok: false,
      reason: `scan request failed: ${error instanceof Error ? error.message : String(error)}`
    }));
    if (!result.ok) {
      // The target refused us. Not a scanner defect, and not evidence of health.
      const reason = sanitizeAttemptReason(result.reason);
      console.log(`SKIP ${site.url} repetition ${repetition}: ${reason}`);
      attempts.push({
        url: site.url,
        shape: site.shape,
        repetition,
        outcome: "scan-failure",
        reason,
        censoredFamilies: [],
        observation: null
      });
      continue;
    }
    answeredTargets.add(site.url);
    const evaluation = evaluateScanBody(site.url, result.report, bridge);
    for (const family of evaluation.censored) {
      censoredFamilies.set(family, (censoredFamilies.get(family) ?? 0) + 1);
    }
    if (evaluation.failures.length === 0) {
      pass(`${site.url} repetition ${repetition} (${site.shape})`);
      attempts.push({
        url: site.url,
        shape: site.shape,
        repetition,
        outcome: "pass",
        reason: null,
        censoredFamilies: evaluation.censored,
        observation: evaluation.observation ?? null
      });
    } else {
      for (const message of evaluation.failures) fail(message);
      attempts.push({
        url: site.url,
        shape: site.shape,
        repetition,
        outcome: "invariant-failure",
        reason: evaluation.failures.join(" | "),
        censoredFamilies: evaluation.censored,
        observation: evaluation.observation ?? null
      });
    }
  }
}

const collectionCompletedAt = new Date().toISOString();
const ledger = buildAttemptLedger({
  createdAt: new Date().toISOString(),
  collection: {
    startedAt: collectionStartedAt,
    completedAt: collectionCompletedAt
  },
  baseOrigin: new URL(BASE).origin,
  sitesFile: SITES_FILE,
  shardIndex: SHARD_INDEX,
  shardCount: SHARD_COUNT,
  conditions: {
    mode: MODE,
    device: DEVICE,
    gpcEnabled: false,
    consentMode: "observe"
  },
  provenance: {
    expectedBuildCommit: EXPECTED_BUILD_COMMIT,
    measurementIdentityDigest,
    sitesFileDigest,
    driverRuntime: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch
    }
  },
  acceptanceThresholds: {
    minimumAnsweringTargets: MIN_ANSWERING_TARGETS,
    minimumRepeatableTargets: MIN_REPEATABLE_TARGETS
  },
  repetitions: REPETITIONS,
  selectedTargets: sites.length,
  attempts
});

console.log(
  `\n${answeredTargets.size}/${sites.length} targets answered; ${checks} invariant-clean, ` +
  `${failures} invariant failure(s); gate ${ledger.acceptance.outcome}`
);
if (censoredFamilies.size > 0) {
  console.log("censoring observed (reported, not asserted; sites differ):");
  for (const [family, count] of [...censoredFamilies].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}/${ledger.answeredRuns} ${family}`);
  }
}

if (ledger.acceptance.outcome === "fail") {
  for (const reason of ledger.acceptance.reasons) {
    console.log(`GATE FAIL ${reason}`);
    console.log(`::error title=Scanner fidelity gate::${reason}`);
  }
}
if (OUTPUT_FILE) {
  const output = path.resolve(OUTPUT_FILE);
  const publicDir = path.join(rootDir, "public");
  if (output === publicDir || output.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error("Scanner-fidelity attempt ledgers must not be written under public/.");
  }
  writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`wrote create-only attempt ledger ${output}`);
}
if (ledger.acceptance.outcome === "fail") {
  console.log("\nScanner fidelity FAILED.");
  process.exit(1);
}
console.log("\nScanner fidelity passed.");

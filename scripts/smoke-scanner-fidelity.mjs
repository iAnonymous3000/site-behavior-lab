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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readResponseTextWithinLimit } from "./http-response.mjs";
import { ensureRenderBridge, evaluateScanBody } from "./scanner-fidelity-invariants.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.SCANNER_FIDELITY_BASE_URL?.trim() || "http://127.0.0.1:3000";
const SITES_FILE = process.env.SCANNER_FIDELITY_SITES?.trim() || "public/scanner-fidelity-sites.json";
const SCAN_TIMEOUT_MS = 180_000;
const SCAN_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
// Failures the scanner cannot control: a target that blocks, rate-limits, or is
// simply down. Those runs are skipped, never asserted on, and never green-wash
// a real regression, because the run also fails if too few targets answered.
const MIN_ANSWERING_TARGETS = 6;

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
  const response = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, device: "desktop", gpcEnabled: false, consentMode: "observe" }),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS)
  });
  // Bounded, like every other first-party script here: a scan report from a
  // heavy site is large, and an unbounded read of a remote body is exactly the
  // hazard the repository's response policy exists to prevent.
  let body;
  try {
    const text = await readResponseTextWithinLimit(response, {
      maxBytes: SCAN_RESPONSE_MAX_BYTES,
      label: `scan ${url}`
    });
    body = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `unreadable response (HTTP ${response.status}): ${String(error).slice(0, 120)}` };
  }
  if (!response.ok || body.ok === false) {
    return { ok: false, reason: body.error ?? `HTTP ${response.status}` };
  }
  return { ok: true, report: body.report ?? body };
}

const config = JSON.parse(readFileSync(path.join(rootDir, SITES_FILE), "utf8"));
const sites = Array.isArray(config.sites) ? config.sites : [];
if (sites.length === 0) throw new Error(`${SITES_FILE} lists no sites.`);

console.log(`Scanner fidelity: ${sites.length} targets via ${BASE}\n`);
// Build the render bridge BEFORE scanning: if the site's own render modules
// will not compile, that is a red gate, not a reason to silently check less.
const bridge = ensureRenderBridge();
let answered = 0;
const censoredFamilies = new Map();

for (const site of sites) {
  const result = await scan(site.url);
  if (!result.ok) {
    // The target refused us. Not a scanner defect, and not evidence of health.
    console.log(`SKIP ${site.url}: ${result.reason}`);
    continue;
  }
  answered += 1;
  const evaluation = evaluateScanBody(site.url, result.report, bridge);
  for (const family of evaluation.censored) {
    censoredFamilies.set(family, (censoredFamilies.get(family) ?? 0) + 1);
  }
  if (evaluation.failures.length === 0) {
    pass(`${site.url} (${site.shape})`);
  } else {
    for (const message of evaluation.failures) fail(message);
  }
}

console.log(`\n${answered}/${sites.length} targets answered; ${checks} passed, ${failures} failed`);
if (censoredFamilies.size > 0) {
  console.log("censoring observed (reported, not asserted; sites differ):");
  for (const [family, count] of [...censoredFamilies].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}/${answered} ${family}`);
  }
}

if (answered < MIN_ANSWERING_TARGETS) {
  fail(`only ${answered} of ${sites.length} targets answered; fewer than ${MIN_ANSWERING_TARGETS} proves nothing`);
}
if (failures > 0) {
  console.log("\nScanner fidelity FAILED.");
  process.exit(1);
}
console.log("\nScanner fidelity passed.");

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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readResponseTextWithinLimit } from "./http-response.mjs";

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

function invariants(site, report) {
  const run = report.run ?? report;
  const summary = run.summary ?? {};
  const quality = run.quality ?? {};
  const byFamily = quality.byFamily ?? {};
  const losses = run.qualityFacts?.captureLoss ?? [];
  const detectors = run.detectors ?? {};
  const label = site.url;
  const censored = (family) => byFamily[family]?.outcome === "censored";

  // 1. A capture loss must name a family the schema knows, with a kind and a
  //    detail. An unnamed loss cannot be scoped, so it censors by accident.
  for (const loss of losses) {
    if (!loss.family || !loss.kind) {
      fail(`${label}: capture loss without a family or kind: ${JSON.stringify(loss)}`);
      return;
    }
    if (!byFamily[loss.family]) {
      fail(`${label}: capture loss names family "${loss.family}" that carries no quality entry`);
      return;
    }
  }

  // 2. Censoring is scoped. A family may only be censored if something was
  //    actually recorded as lost for it (or a run-wide budget was exhausted).
  const budgetExhausted = (quality.run?.reasons ?? []).some((reason) => String(reason).startsWith("budget-exhausted:"));
  for (const [family, entry] of Object.entries(byFamily)) {
    if (entry.outcome !== "censored" || budgetExhausted) continue;
    if (!losses.some((loss) => loss.family === family)) {
      fail(`${label}: ${family} is censored with no recorded capture loss to justify it`);
      return;
    }
  }

  // 3. A detector may not report a budget failure on a run that did not come
  //    close to its budget. This is the codeberg.org defect: a 5-second scan
  //    told readers it had run out of time.
  const durationMs = Number(summary.durationMs ?? 0);
  if (durationMs > 0 && durationMs < 20_000) {
    for (const [id, entry] of Object.entries(detectors)) {
      if (entry.reason === "budget-unavailable") {
        fail(`${label}: detector ${id} reported budget-unavailable after only ${durationMs}ms`);
        return;
      }
    }
  }

  // 4. Request evidence that is complete may not be described as incomplete,
  //    and counts must be self-consistent with it.
  if (!censored("requests")) {
    const total = Number(summary.totalRequests ?? 0);
    const third = Number(summary.thirdPartyRequests ?? 0);
    if (third > total) {
      fail(`${label}: ${third} third-party requests exceeds ${total} total with complete request evidence`);
      return;
    }
  }

  // 5. An instrument's limit is not a fact about the site. A detector may only
  //    report `unsupported` when nothing was found to work with — never while
  //    also publishing evidence it says it could not obtain.
  const policy = detectors["privacy-policy"];
  const policyEvidence = run.evidence?.privacyPolicy ?? run.privacyPolicy;
  if (policy?.status === "unsupported" && policyEvidence?.url) {
    fail(`${label}: privacy-policy reports unsupported while publishing ${policyEvidence.url}`);
    return;
  }

  pass(`${label} (${site.shape})`);
}

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
  const run = result.report.run ?? result.report;
  for (const [family, entry] of Object.entries(run.quality?.byFamily ?? {})) {
    if (entry.outcome === "censored") censoredFamilies.set(family, (censoredFamilies.get(family) ?? 0) + 1);
  }
  invariants(site, result.report);
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

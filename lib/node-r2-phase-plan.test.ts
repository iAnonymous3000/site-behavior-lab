import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { NODE_R2_PHASE_PLAN_CONTRACT_VERSION, nodeR2PhasePlanViolations } from "./node-r2-phase-plan";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { makePublicSingleReportV2R2, makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import type { PhaseKind } from "./scan-report-v2";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";

function phases(...kinds: PhaseKind[]): ScanRunV2R2["phases"] {
  return kinds.map((kind, phaseId) => ({ phaseId, kind, startedAtMs: phaseId * 1_000, endedAtMs: phaseId * 1_000 + 500 }));
}

function violationsOf(change: (run: ScanRunV2R2) => void): string[] {
  const run = structuredClone(makeScanRunV2R2());
  change(run);
  return nodeR2PhasePlanViolations(run.conditions, run.phases, run.detectors, run.evidence.consent);
}

test("the Node phase plan is version one, a code constant", () => {
  assert.equal(NODE_R2_PHASE_PLAN_CONTRACT_VERSION, "node-phase-plan-v1");
});

test("a plan the Node producer writes has no phase-plan violation", () => {
  assert.deepEqual(violationsOf(() => undefined), []);
});

// Each rule the producer enforces, with the producer's own message.
const RULES: Array<[string, (run: ScanRunV2R2) => void, string]> = [
  ["sequential ids", (run) => { run.phases = [{ ...run.phases[0], phaseId: 1 }]; },
    "Node measurement phases require sequential IDs and nonnegative integer spans."],
  ["passive-load first", (run) => { run.phases = phases("policy-analysis"); },
    "A Node r2 phase plan must start with passive-load."],
  ["no repeated kind", (run) => { run.phases = phases("passive-load", "passive-load"); },
    "A Node r2 phase plan cannot repeat a phase kind."],
  ["fixed order", (run) => {
    run.conditions = { ...run.conditions, probes: { keystroke: true, policyVisit: true } };
    run.detectors["keystroke-exfiltration"] = { ...run.detectors["keystroke-exfiltration"], status: "complete" };
    delete (run.detectors["keystroke-exfiltration"] as { reason?: unknown }).reason;
    run.detectors["privacy-policy"] = { ...run.detectors["privacy-policy"], status: "complete" };
    delete (run.detectors["privacy-policy"] as { reason?: unknown }).reason;
    run.phases = phases("passive-load", "policy-analysis", "active-probe");
  }, "A Node r2 phase plan is out of order."],
  ["no consent phase on an observe run", (run) => { run.phases = phases("passive-load", "consent-interaction"); },
    "Observe-mode runs cannot carry consent interaction or reload phases."],
  ["a consent run carries its phase", (run) => { run.conditions = { ...run.conditions, consent: "accept-all" }; },
    "Consent-mode runs require a consent-interaction phase."],
  ["a reload needs a consent phase", (run) => { run.phases = phases("passive-load", "post-choice-reload"); },
    "A post-choice reload requires a consent-interaction phase."],
  ["an active probe needs its condition", (run) => {
    run.detectors["keystroke-exfiltration"] = { ...run.detectors["keystroke-exfiltration"], status: "complete" };
    run.phases = phases("passive-load", "active-probe");
  }, "An active-probe phase requires the declared keystroke probe condition."],
  ["a skipped probe is explained", (run) => {
    run.conditions = { ...run.conditions, probes: { ...run.conditions.probes, keystroke: true } };
  }, "A skipped active probe requires a keystroke detector outcome that explains the omission."],
  ["an active probe has an executed or explained detector", (run) => {
    run.conditions = { ...run.conditions, probes: { ...run.conditions.probes, keystroke: true } };
    run.phases = phases("passive-load", "active-probe");
  }, "An active-probe phase requires an executed or accountably skipped keystroke detector outcome."],
  ["an executed keystroke detector has its phase", (run) => {
    run.detectors["keystroke-exfiltration"] = { ...run.detectors["keystroke-exfiltration"], status: "complete" };
  }, "An executed keystroke detector requires an active-probe phase."],
  ["a policy phase needs its condition", (run) => {
    run.detectors["privacy-policy"] = { ...run.detectors["privacy-policy"], status: "complete" };
    run.phases = phases("passive-load", "policy-analysis");
  }, "A policy-analysis phase requires the declared policy-visit condition."],
  ["a skipped policy visit is explained", (run) => {
    run.conditions = { ...run.conditions, probes: { ...run.conditions.probes, policyVisit: true } };
  }, "A skipped policy visit requires a privacy-policy detector outcome that explains the omission."],
  ["a policy phase has an executed detector", (run) => {
    run.conditions = { ...run.conditions, probes: { ...run.conditions.probes, policyVisit: true } };
    run.phases = phases("passive-load", "policy-analysis");
  }, "A policy-analysis phase requires an executed privacy-policy detector outcome."],
  ["an executed policy detector has its phase", (run) => {
    run.detectors["privacy-policy"] = { ...run.detectors["privacy-policy"], status: "complete" };
  }, "An executed privacy-policy detector requires a policy-analysis phase."],
  ["always-on detectors are not left unrequested", (run) => {
    run.detectors["pixel-events"] = { ...run.detectors["pixel-events"], status: "skipped", reason: "not-requested" };
  }, "Always-on detector pixel-events cannot remain in its default unrequested state."]
];

for (const [name, change, message] of RULES) {
  test(`the Node phase plan rule holds: ${name}`, () => {
    const violations = violationsOf(change);
    assert.ok(violations.includes(message), `the Node phase plan rule holds: ${name} (got ${JSON.stringify(violations)})`);
  });
}

test("the reader refuses a phase plan the Node producer rules out", () => {
  // The review's fixture: a single observe run whose only phase claims a
  // consent interaction, with both probes off.
  const report = structuredClone(makePublicSingleReportV2R2());
  report.run.phases = phases("consent-interaction");
  const violations = scanReportV2R2SemanticViolations(report);
  for (const message of [
    "run: A Node r2 phase plan must start with passive-load.",
    "run: Observe-mode runs cannot carry consent interaction or reload phases."
  ]) {
    assert.ok(violations.includes(message), `the reader refuses a phase plan the Node producer rules out (${message})`);
  }
});

test("a PageGraph run keeps its own phase rule, not the Node plan", () => {
  const report = structuredClone(makePublicSingleReportV2R2());
  report.run.phases = phases("consent-interaction");
  report.run.provenance = { ...report.run.provenance, observer: "pagegraph-import" };
  const nodeMessages = nodeR2PhasePlanViolations(report.run.conditions, report.run.phases, report.run.detectors, report.run.evidence.consent);
  assert.ok(nodeMessages.length > 0, "the PageGraph run breaks the Node plan, so the exemption is tested");
  const violations = scanReportV2R2SemanticViolations(report);
  assert.deepEqual(
    violations.filter((violation) => nodeMessages.some((message) => violation === `run: ${message}`)),
    [],
    "a PageGraph run keeps its own phase rule, not the Node plan"
  );
});

test("every committed Node r2 run meets the phase plan", () => {
  // The reader now refuses what the producer rules out. Every earlier Node
  // producer enforced the same rules, so no committed report may be refused.
  const directory = path.join(process.cwd(), "public", "reports");
  let runs = 0;
  const refused: string[] = [];
  for (const name of readdirSync(directory).filter((file) => /^\d{8}-[0-9a-f]{32}\.json$/.test(file)).sort()) {
    const report = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as {
      schemaVersion?: number;
      run?: ScanRunV2R2;
      baseline?: ScanRunV2R2;
      variant?: ScanRunV2R2;
    };
    if (report.schemaVersion !== 2) continue;
    for (const run of [report.run, report.baseline, report.variant]) {
      if (!run || run.provenance.observer !== "node-playwright") continue;
      runs += 1;
      const violations = nodeR2PhasePlanViolations(run.conditions, run.phases, run.detectors, run.evidence.consent);
      if (violations.length > 0) refused.push(`${name}: ${violations.join(" ")}`);
    }
  }
  assert.ok(runs > 0, "the guard finds committed Node r2 runs");
  assert.deepEqual(refused, [], "every committed Node r2 run meets the phase plan");
});

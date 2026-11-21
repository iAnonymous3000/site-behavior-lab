import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPORT_RETENTION_CONTINUATION_WARNING } from "./runtime-status";

/**
 * The production monitor's acceptance of routine retention continuation,
 * read out of the workflow it runs in (the block between its two markers)
 * and run against health responses. A backlog of more due deletions than
 * one pass makes is reported as degraded with one fixed warning while the
 * store publishes normally; it is routine, and only that state is accepted.
 */
const WORKFLOW = path.join(process.cwd(), ".github", "workflows", "production-health.yml");

type Health = Record<string, unknown>;
type Acceptance = { accepts: (health: Health) => boolean; warning: string };

function monitorAcceptance(): Acceptance {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const start = workflow.indexOf("// RETENTION_CONTINUATION_ACCEPTANCE_START");
  const end = workflow.indexOf("// RETENTION_CONTINUATION_ACCEPTANCE_END");
  assert.ok(start !== -1 && end > start, "the monitor carries its marked retention-continuation acceptance");
  const block = workflow.slice(start, end);
  return new Function(`${block}\nreturn { accepts: routineRetentionContinuation, warning: RETENTION_CONTINUATION_WARNING };`)() as Acceptance;
}

/** The state runtime-status reports for a draining backlog (lib/runtime-status.test.ts). */
function continuing(): Health {
  return {
    ok: true,
    status: "degraded",
    scansAvailable: true,
    capabilities: { savedReports: true },
    checks: {
      reportStore: { retentionContinuationPending: true, retentionHealthy: true, capacityExhausted: false }
    },
    warnings: [REPORT_RETENTION_CONTINUATION_WARNING]
  };
}

test("the monitor accepts routine retention continuation", () => {
  assert.equal(monitorAcceptance().accepts(continuing()), true, "the monitor accepts routine retention continuation");
});

test("the monitor's continuation sentence is the scanner's own", () => {
  assert.equal(
    monitorAcceptance().warning,
    REPORT_RETENTION_CONTINUATION_WARNING,
    "the monitor's continuation sentence is the scanner's own"
  );
});

test("every other degraded state still fails the monitor", () => {
  const { accepts } = monitorAcceptance();
  const variants: Array<[string, (health: Health) => void]> = [
    ["a second warning", (h) => { h.warnings = [REPORT_RETENTION_CONTINUATION_WARNING, "Brave Shields classification is unavailable; tracker labels use the curated catalog only."]; }],
    ["another single warning", (h) => { h.warnings = ["Brave Shields classification is unavailable; tracker labels use the curated catalog only."]; }],
    ["continuation not pending", (h) => { (h.checks as { reportStore: Health }).reportStore.retentionContinuationPending = false; }],
    ["retention not healthy", (h) => { (h.checks as { reportStore: Health }).reportStore.retentionHealthy = false; }],
    ["the store full", (h) => { (h.checks as { reportStore: Health }).reportStore.capacityExhausted = true; }],
    ["saved reports unavailable", (h) => { (h.capabilities as Health).savedReports = false; }],
    ["scans unavailable", (h) => { h.scansAvailable = false; }],
    ["no report store check", (h) => { h.checks = {}; }]
  ];
  for (const [what, change] of variants) {
    const health = structuredClone(continuing());
    change(health);
    assert.equal(accepts(health), false, `every other degraded state still fails the monitor (${what})`);
  }
});

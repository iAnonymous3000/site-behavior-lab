import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessKeySet } from "../core/access-token";
import { EVENT_TYPES } from "../core/case-events";
import type { LogEvent } from "../core/case-log";
import { plannedState, type AttemptState, type MachineState } from "../core/case-machine";
import { CLEANUP_EVENT_TYPES, MAX_RUNNER_ROWS_PER_ATTEMPT, RUNNER_EVENT_TYPES, tokenRefusalFor, type TokenHolder } from "../core/case-runner";
import { caseCommandsOver, caseRunnerOver, CLAIM_EVENT_TYPES, OWNER_COMMAND_EVENT_TYPES } from "../core/case-service";
import { ATTEMPT_IDS, CONTROL_RUN_ID } from "./case-fixture";
import { memoryStores } from "./memory-log-store";
import { certsFor, generateSigningKey, ISSUER, NOW_MS, ownerClaims, POLICY, signToken } from "./token-fixture";

/**
 * The runner's seam in this process: which events are a runner's, and what the seam refuses before
 * it opens a case. A stand-in answers for the object's token table. The object itself, its tokens and
 * its stops, are case-runner-workerd.test.ts.
 */

const GOOD = "a".repeat(64);
const HEAD = "0".repeat(64);

/** The events only one seam may carry. The two cleanup events are on both lists, so neither seam refuses them by type. */
const RUNNER_ONLY = RUNNER_EVENT_TYPES.filter((type) => !OWNER_COMMAND_EVENT_TYPES.includes(type));
const OWNER_ONLY = OWNER_COMMAND_EVENT_TYPES.filter((type) => !RUNNER_EVENT_TYPES.includes(type));

test("the runner's list is these nine events the log knows, shares only the two cleanup events with the owner's, and holds no claim, control, purge or destroy", () => {
  assert.deepEqual([...RUNNER_EVENT_TYPES].sort(), ["attempt-finished", "attempt-start-retried", "capture-began", "capture-finished", "cleanup-confirmed", "cleanup-unconfirmed", "evidence-recorded", "instrument-recorded", "source-recorded"]);
  for (const type of RUNNER_EVENT_TYPES) assert.ok(EVENT_TYPES.includes(type), type);
  assert.deepEqual(RUNNER_EVENT_TYPES.filter((type) => OWNER_COMMAND_EVENT_TYPES.includes(type)).sort(), ["cleanup-confirmed", "cleanup-unconfirmed"]);
  assert.deepEqual([...CLEANUP_EVENT_TYPES].sort(), ["cleanup-confirmed", "cleanup-unconfirmed"]);
  assert.deepEqual(RUNNER_EVENT_TYPES.filter((type) => CLAIM_EVENT_TYPES.includes(type)), []);
  for (const type of ["environment-destroyed", "control-recorded", "configuration-changed", "source-reconstructed", "unknown-recorded", ...EVENT_TYPES.filter((candidate) => candidate.startsWith("purge"))]) assert.ok(!RUNNER_EVENT_TYPES.includes(type), type);
  assert.ok(EVENT_TYPES.some((type) => type.startsWith("purge")));
  assert.equal(RUNNER_ONLY.length, 7);
  assert.equal(OWNER_ONLY.length, 10);
  // A default, pinned here so a change to it is a change to this line too.
  assert.equal(MAX_RUNNER_ROWS_PER_ATTEMPT, 32);
});

test("the runner's seam refuses a token it does not hold, an event that is not a runner's, and another slot's event, all before it opens a case, and each seam refuses the other's events", async () => {
  let opens = 0;
  const asked: unknown[] = [];
  const stores = memoryStores();
  const holders: Readonly<Record<string, TokenHolder>> = { [GOOD]: { slot: "B1", attemptId: ATTEMPT_IDS.B1, stopped: false, destroyed: false, requestedTwice: false } };
  const signing = await generateSigningKey("key-1");
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
  const world = {
    policy: POLICY,
    keySetFor: () => keySet,
    now: () => NOW_MS,
    storesFor: () => ((opens += 1), stores),
    holderOf: async (token: unknown) => (asked.push(token), Object.prototype.hasOwnProperty.call(holders, token as string) ? holders[token as string] : null)
  };
  const runner = caseRunnerOver(world);
  const commands = caseCommandsOver(world);
  const ownerToken = await signToken(signing, ownerClaims());

  const notRunners = [...EVENT_TYPES.filter((type) => !RUNNER_EVENT_TYPES.includes(type)), "no-such-event"];
  assert.equal(notRunners.length, EVENT_TYPES.length - RUNNER_EVENT_TYPES.length + 1);
  for (const type of notRunners) assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, { type, data: { slot: "B1" } }), { ok: false, refusal: "not-a-runner-event" }, type);
  for (const event of [null, "capture-began", { data: { slot: "B1" } }, []]) assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, event as unknown as LogEvent), { ok: false, refusal: "not-a-runner-event" });
  // Each seam refuses what only the other carries.
  assert.ok(OWNER_ONLY.length > 0 && RUNNER_ONLY.length > 0);
  assert.ok(OWNER_ONLY.includes("environment-destroyed"));
  for (const type of OWNER_ONLY) assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, { type, data: { slot: "B1" } }), { ok: false, refusal: "not-a-runner-event" }, type);
  for (const type of RUNNER_ONLY) assert.deepEqual(await commands.command(ownerToken, "case-one", HEAD, { type, data: { slot: "B1" } }), { ok: false, refusal: "not-a-command" }, type);

  const forged = [null, "", "not-a-token", "c".repeat(64), GOOD.toUpperCase(), `${GOOD} `];
  for (const token of forged) {
    for (const type of RUNNER_EVENT_TYPES) assert.deepEqual(await runner.write(token as string, "case-one", HEAD, { type, data: { slot: "B1" } }), { ok: false, refusal: "token-refused" }, `${String(token)} ${type}`);
  }
  // Another slot's event, the row's slot read from inside the row.
  for (const type of RUNNER_EVENT_TYPES.filter((candidate) => candidate !== "evidence-recorded")) assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, { type, data: { slot: "I1" } }), { ok: false, refusal: "not-this-attempt" }, type);
  assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, { type: "evidence-recorded", data: { row: { slot: "I1" } } }), { ok: false, refusal: "not-this-attempt" });
  assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, { type: "evidence-recorded", data: { slot: "B1" } }), { ok: false, refusal: "not-this-attempt" });
  assert.equal(opens, 0);
  assert.ok(asked.length > 0);

  // A runner's own event for its own slot reaches the stores, which hold no log here.
  assert.deepEqual(await runner.write(GOOD, "case-one", HEAD, { type: "capture-began", data: { slot: "B1" } }), { ok: false, refusal: "head-missing", at: null });
  assert.equal(opens, 1);
});

const HOLDER: TokenHolder = { slot: "B1", attemptId: ATTEMPT_IDS.B1, stopped: false, destroyed: false, requestedTwice: false };

function machineWith(attempt: Partial<AttemptState>, closedBy: MachineState["closedBy"] = null): Readonly<{ machine: MachineState; attempt: AttemptState }> {
  const planned = plannedState({ slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }], controlRunId: CONTROL_RUN_ID, configuration: "alder" });
  assert.ok(planned.ok);
  const merged = { ...planned.state.attempts[0], ...attempt };
  return { machine: { ...planned.state, closedBy, attempts: [merged] }, attempt: merged };
}

test("one rule says when a token may write: every runner event while the attempt runs, cleanup alone after the outcome while cleanup is pending, and nothing after a stop, a destroy record, a second request or the owner's close", () => {
  const cases: [string, Readonly<{ machine: MachineState; attempt: AttemptState }>, TokenHolder, readonly (string | null)[]][] = [];
  const each = (label: string, state: Readonly<{ machine: MachineState; attempt: AttemptState }>, holder: TokenHolder, expected: (type: string) => string | null) => cases.push([label, state, holder, RUNNER_EVENT_TYPES.map(expected)]);
  const cleanupOnly = (type: string) => (CLEANUP_EVENT_TYPES.includes(type) ? null : "attempt-ended");
  for (const phase of ["starting", "capturing", "finalizing"] as const) each(`running ${phase}`, machineWith({ phase, cleanup: "pending" }), HOLDER, () => null);
  for (const phase of ["usable", "walled", "failed", "incomplete", "timed_out", "cancelled"] as const) each(`outcome ${phase}, cleanup pending`, machineWith({ phase, cleanup: "pending" }), HOLDER, cleanupOnly);
  for (const cleanup of ["confirmed", "unconfirmed", "environment_destroyed"] as const) each(`outcome, cleanup ${cleanup}`, machineWith({ phase: "usable", cleanup }), HOLDER, () => "attempt-ended");
  // The last slot's own outcome closes the case as completed: its cleanup window stays open.
  each("closed as completed, cleanup pending", machineWith({ phase: "usable", cleanup: "pending" }, "completed"), HOLDER, cleanupOnly);
  for (const closedBy of ["cancelled", "deadline", "baseline_not_met"] as const) each(`closed by ${closedBy}`, machineWith({ phase: "failed", cleanup: "pending" }, closedBy), HOLDER, () => "token-refused");
  for (const record of ["stopped", "destroyed", "requestedTwice"] as const) {
    each(`${record} while running`, machineWith({ phase: "capturing", cleanup: "pending" }), { ...HOLDER, [record]: true }, () => "token-refused");
    each(`${record} after the outcome`, machineWith({ phase: "usable", cleanup: "pending" }), { ...HOLDER, [record]: true }, () => "token-refused");
  }
  assert.equal(cases.length, 22);
  assert.equal(RUNNER_EVENT_TYPES.length, 9);
  for (const [label, { machine, attempt }, holder, expected] of cases) {
    assert.deepEqual(RUNNER_EVENT_TYPES.map((type) => tokenRefusalFor(holder, machine, attempt, type)), expected, label);
  }
});

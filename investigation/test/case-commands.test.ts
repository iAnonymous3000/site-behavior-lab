import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessKeySet } from "../core/access-token";
import { EVENT_TYPES } from "../core/case-events";
import type { HostedCommands } from "../core/case-host";
import type { LogEvent } from "../core/case-log";
import { plannedState, step, type MachineEvent, type MachineState } from "../core/case-machine";
import { caseCommandsOver, caseServiceOver, CLAIM_EVENT_TYPES, OWNER_COMMAND_EVENT_TYPES } from "../core/case-service";
import { DEFAULT_DEADLINES, isDueMark, isWanted, wantedMarks, type DueMark } from "../core/case-supervision";
import { VIEWER_ROUTES } from "../core/viewer-routes";
import { ATTEMPT_IDS, CONTROL_RUN_ID, IDENTITY_ALDER } from "./case-fixture";
import { memoryStores } from "./memory-log-store";
import { certsFor, generateSigningKey, ISSUER, NOW_MS, ownerClaims, POLICY, signToken } from "./token-fixture";
import { headOf, VIEWER_CASE, viewerWorld } from "./viewer-fixture";

/**
 * The owner's commands in this process: which events are commands, which marks a state wants
 * watched, and what each command route sends through the commands seam. A stand-in answers where
 * a Durable Object would. The objects themselves, and their alarm, are case-commands-workerd.test.ts
 * and case-alarm-workerd.test.ts.
 */

const CASE = `/cases/${VIEWER_CASE}`;
const OWNER = { kind: "owner" } as const;

test("claims and commands are two lists with nothing in common, both of events the log knows, and neither holds a runner's event, a control, a row or a purge", () => {
  for (const type of [...CLAIM_EVENT_TYPES, ...OWNER_COMMAND_EVENT_TYPES]) assert.ok(EVENT_TYPES.includes(type), type);
  assert.deepEqual(CLAIM_EVENT_TYPES.filter((type) => OWNER_COMMAND_EVENT_TYPES.includes(type)), []);
  assert.deepEqual([...OWNER_COMMAND_EVENT_TYPES].sort(), ["attempt-deadline", "attempt-started", "baseline-rule-recorded", "case-cancelled", "case-deadline", "case-planned", "cleanup-confirmed", "cleanup-unconfirmed", "environment-destroyed", "exception-recorded", "plan-frozen", "reconcile"]);
  for (const type of ["control-recorded", "configuration-changed", "attempt-start-retried", "capture-began", "capture-finished", "attempt-finished", "evidence-recorded", "instrument-recorded", "source-recorded", "source-reconstructed", "unknown-recorded"]) {
    assert.ok(EVENT_TYPES.includes(type), type);
    assert.ok(!OWNER_COMMAND_EVENT_TYPES.includes(type) && !CLAIM_EVENT_TYPES.includes(type), type);
  }
  for (const type of EVENT_TYPES.filter((candidate) => candidate.startsWith("purge"))) assert.ok(!OWNER_COMMAND_EVENT_TYPES.includes(type), type);
  assert.ok(EVENT_TYPES.some((type) => type.startsWith("purge")));
});

test("the commands seam refuses every event that is no command before it opens a case, and each seam refuses the other's events", async () => {
  const signing = await generateSigningKey("key-1");
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
  const token = await signToken(signing, ownerClaims());
  let asked = 0;
  const stores = memoryStores();
  const world = { policy: POLICY, keySetFor: () => keySet, now: () => NOW_MS, storesFor: () => ((asked += 1), stores) };
  const commands = caseCommandsOver(world);
  const service = caseServiceOver(world);
  const head = "0".repeat(64);
  for (const type of [...EVENT_TYPES.filter((candidate) => !OWNER_COMMAND_EVENT_TYPES.includes(candidate)), "no-such-event"]) {
    assert.deepEqual(await commands.command(token, "case-one", head, { type, data: {} }), { ok: false, refusal: "not-a-command" }, type);
  }
  for (const event of [null, "case-cancelled", { data: {} }, []]) assert.deepEqual(await commands.command(token, "case-one", head, event as unknown as LogEvent), { ok: false, refusal: "not-a-command" });
  for (const type of OWNER_COMMAND_EVENT_TYPES) assert.deepEqual(await service.claim(token, "case-one", head, { type, data: {} }), { ok: false, refusal: "not-a-claim" }, type);
  assert.equal(asked, 0);
  // A command reaches the stores, and no token reaches anything.
  assert.deepEqual(await commands.command(token, "case-one", head, { type: "case-cancelled", data: {} }), { ok: false, refusal: "head-missing", at: null });
  assert.equal(asked, 1);
  assert.deepEqual(await commands.command("not.a.token", "case-one", head, { type: "case-cancelled", data: {} }), { ok: false, refusal: "access-refused" });
  assert.equal(asked, 1);
});

function after(state: MachineState, ...events: readonly Readonly<{ type: string; slot?: string; planDigest?: string }>[]): MachineState {
  let current = state;
  for (const event of events) {
    const result = step(current, { ...event, by: OWNER } as unknown as MachineEvent);
    assert.ok(result.ok, `${event.type}: ${result.ok ? "" : result.refusal}`);
    current = result.state;
  }
  return current;
}

const shape = (machine: MachineState | null): string[] => wantedMarks(machine).map(({ kind, slot }) => `${kind}:${slot}`).sort();

test("a state wants the case's deadline while open, an attempt's while it runs, and reconcile while one runs or a cleanup is pending", () => {
  const planned = plannedState({ slots: [{ slot: "B1", attemptId: ATTEMPT_IDS.B1 }, { slot: "I1", attemptId: ATTEMPT_IDS.I1 }], controlRunId: CONTROL_RUN_ID, configuration: "alder" });
  assert.ok(planned.ok);
  assert.deepEqual(shape(null), []);
  assert.deepEqual(shape(planned.state), ["case-deadline:null"]);
  const started = after(planned.state, { type: "plan-frozen", planDigest: "aa".repeat(32) }, { type: "exception-recorded", slot: "B1" }, { type: "attempt-started", slot: "B1" });
  assert.deepEqual(shape(started), ["attempt-deadline:B1", "case-deadline:null", "reconcile:null"]);
  const timedOut = after(started, { type: "attempt-deadline", slot: "B1" });
  assert.deepEqual(shape(timedOut), ["case-deadline:null", "reconcile:null"]);
  assert.deepEqual(shape(after(timedOut, { type: "cleanup-confirmed", slot: "B1" })), ["case-deadline:null"]);
  assert.deepEqual(shape(after(timedOut, { type: "reconcile" })), ["case-deadline:null"]);
  // A closed case with a cleanup still pending wants reconcile and no deadline, and a closed one with nothing pending wants nothing.
  assert.deepEqual(shape(after(timedOut, { type: "case-cancelled" })), ["reconcile:null"]);
  assert.deepEqual(shape(after(planned.state, { type: "case-cancelled" })), []);
  // Cancelling a running attempt ends it, so its own deadline is no longer wanted.
  assert.ok(!isWanted(after(started, { type: "case-cancelled" }), { kind: "attempt-deadline", slot: "B1" }));
  assert.ok(isWanted(started, { kind: "attempt-deadline", slot: "B1" }) && !isWanted(started, { kind: "attempt-deadline", slot: "I1" }));
});

test("a mark is a known kind, a slot only for an attempt's deadline, and whole times", () => {
  const mark: DueMark = { kind: "attempt-deadline", slot: "B1", dueAtMs: 10, flaggedAtMs: null };
  for (const good of [mark, { ...mark, flaggedAtMs: 12 }, { kind: "reconcile", slot: null, dueAtMs: 1, flaggedAtMs: 2 }, { kind: "case-deadline", slot: null, dueAtMs: 1, flaggedAtMs: null }]) assert.ok(isDueMark(good), JSON.stringify(good));
  for (const bad of [null, "reconcile", {}, { ...mark, kind: "purge" }, { ...mark, slot: "B9" }, { ...mark, slot: null }, { ...mark, kind: "reconcile" }, { ...mark, dueAtMs: 1.5 }, { ...mark, dueAtMs: "10" }, { ...mark, flaggedAtMs: undefined }, { ...mark, kind: "<script>" }]) {
    assert.ok(!isDueMark(bad), JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(DEFAULT_DEADLINES).sort(), ["attempt-deadline", "case-deadline", "reconcile"]);
  assert.ok(DEFAULT_DEADLINES["attempt-deadline"] < DEFAULT_DEADLINES.reconcile && DEFAULT_DEADLINES.reconcile < DEFAULT_DEADLINES["case-deadline"]);
});

type Sent = { call: string; caseId: string; head: string; payload: unknown };

function commandsRecording(): { commands: HostedCommands; sent: Sent[] } {
  const sent: Sent[] = [];
  const refused = { ok: false, refusal: "head-missing", at: null } as const;
  return {
    sent,
    commands: {
      command: async (_assertion, caseId, head, event) => (sent.push({ call: "command", caseId, head, payload: structuredClone(event) }), refused),
      plan: async (_assertion, caseId, head, plan) => (sent.push({ call: "plan", caseId, head, payload: structuredClone(plan) }), refused),
      freeze: async (_assertion, caseId, head, text) => (sent.push({ call: "freeze", caseId, head, payload: text }), refused)
    }
  };
}

const PLAN_FIELDS: readonly (readonly [string, string])[] = [
  ["slot", "B1"],
  ["commit", IDENTITY_ALDER.commit],
  ["runner-image", IDENTITY_ALDER.runnerImage],
  ["rea-release", IDENTITY_ALDER.reaRelease],
  ["rea-integrity", IDENTITY_ALDER.reaIntegrity],
  ["scanner-node", IDENTITY_ALDER.scannerNode],
  ["rea-node", IDENTITY_ALDER.reaNode],
  ["chromium", IDENTITY_ALDER.chromium],
  ["instruments", "coverage"],
  ["grammar-version", "1"],
  ["fixture", "a fixture"],
  ["criterion", "a criterion"]
];

/** Each command route, the fields its form holds, and exactly what it sends on. */
const COMMANDS: readonly (readonly [string, readonly (readonly [string, string])[], string, unknown])[] = [
  ["/plan/freeze", [["plan", "the plan\r\nline two"]], "freeze", "the plan\nline two"],
  ["/exception", [["slot", "B2"], ["reason", "Why."]], "command", { type: "exception-recorded", data: { slot: "B2", reason: "Why." } }],
  ["/baseline-rule", [["result", "met"]], "command", { type: "baseline-rule-recorded", data: { result: "met" } }],
  ["/attempts/B2/start", [], "command", { type: "attempt-started", data: { slot: "B2" } }],
  ["/attempts/B2/deadline", [], "command", { type: "attempt-deadline", data: { slot: "B2" } }],
  ["/attempts/B2/cleanup", [["cleanup", "confirmed"]], "command", { type: "cleanup-confirmed", data: { slot: "B2" } }],
  ["/attempts/B2/cleanup", [["cleanup", "unconfirmed"]], "command", { type: "cleanup-unconfirmed", data: { slot: "B2" } }],
  ["/attempts/B2/cleanup", [["cleanup", "environment-destroyed"]], "command", { type: "environment-destroyed", data: { slot: "B2" } }],
  ["/reconcile", [], "command", { type: "reconcile", data: {} }],
  ["/deadline", [], "command", { type: "case-deadline", data: {} }],
  ["/cancel", [], "command", { type: "case-cancelled", data: {} }]
];

test("each command route sends exactly its own event, at the head the form named, and the plan route sends the plan with no id in it", async () => {
  const { commands, sent } = commandsRecording();
  const world = await viewerWorld({ commands });
  const head = headOf(await (await world.send(CASE)).text());
  for (const [path, fields, call, payload] of COMMANDS) {
    const response = await world.post(`${CASE}${path}`, [["head", head], ...fields]);
    // The stand-in refuses every command as a log that will not open, which the route shows as that.
    assert.equal(response.status, 409, path);
    assert.deepEqual(sent.splice(0), [{ call, caseId: VIEWER_CASE, head, payload }], path);
  }
  assert.equal((await world.post(`${CASE}/plan`, [["head", head], ...PLAN_FIELDS])).status, 409);
  const [{ call, payload }] = sent.splice(0);
  assert.equal(call, "plan");
  assert.deepEqual(Object.keys(payload as object).sort(), ["configuration", "criterion", "fixture", "slots"]);
  // The table above is every command route there is.
  const commandPaths = VIEWER_ROUTES.filter(({ method, path }) => method === "POST" && /\/(plan|plan\/freeze|exception|baseline-rule|start|deadline|cleanup|reconcile|cancel)$/.test(path)).map(({ path }) => path.replace("/cases/:case", "").replace(":slot", "B2"));
  assert.deepEqual([...new Set([...COMMANDS.map(([path]) => path), "/plan"])].sort(), commandPaths.sort());
});

test("a command route answers 503 with no commands seam, refuses a field that is not its own, and reaches the seam for nobody but the owner on this origin", async () => {
  const absent = await viewerWorld();
  const absentHead = headOf(await (await absent.send(CASE)).text());
  for (const [path, fields] of [...COMMANDS, ["/plan", PLAN_FIELDS] as const]) {
    const response = await absent.post(`${CASE}${path}`, [["head", absentHead], ...fields]);
    assert.deepEqual([response.status, await response.text()], [503, '{"error":"unavailable"}'], path);
  }
  // With no seam a case's page shows neither commands nor a deadline, whatever the service's answer carries.
  assert.ok(!(await (await absent.send(CASE)).text()).includes("<h2>Commands</h2>"));

  const { commands, sent } = commandsRecording();
  const world = await viewerWorld({ commands });
  const head = headOf(await (await world.send(CASE)).text());
  for (const [path, fields] of COMMANDS) {
    assert.equal((await world.post(`${CASE}${path}`, [["head", head], ...fields, ["attemptId", "ab".repeat(16)]])).status, 400, `${path} with a field of another's`);
    assert.equal((await world.post(`${CASE}${path}`, fields)).status, 400, `${path} with no head`);
    assert.equal((await world.post(`${CASE}${path}`, [["head", head], ...fields], { token: world.serviceToken })).status, 401, path);
    assert.equal((await world.post(`${CASE}${path}`, [["head", head], ...fields], { token: world.forgedToken })).status, 401, path);
    assert.equal((await world.post(`${CASE}${path}`, [["head", head], ...fields], { origin: "https://elsewhere.example" })).status, 403, path);
    const read = await world.send(`${CASE}${path}`);
    assert.deepEqual([read.status, read.headers.get("allow")], [405, "POST"], path);
  }
  assert.equal((await world.post(`${CASE}/attempts/B2/cleanup`, [["head", head], ["cleanup", "constructor"]])).status, 400);
  assert.equal((await world.post(`${CASE}/plan`, [["head", head], ...PLAN_FIELDS, ["id", "my-own-case"]])).status, 400);
  assert.deepEqual(sent, []);
});

test("a hosted case's page shows a flagged deadline as due and unwritten, shows only marks of a mark's shape, and the commands that write them", async () => {
  const due = [
    { kind: "attempt-deadline", slot: "B2", dueAtMs: Date.UTC(2026, 10, 1, 12), flaggedAtMs: Date.UTC(2026, 10, 1, 12, 0, 5) },
    { kind: "reconcile", slot: null, dueAtMs: Date.UTC(2026, 10, 1, 12, 15), flaggedAtMs: Date.UTC(2026, 10, 1, 12, 15, 1) },
    { kind: "<script>window.dueRan = 1</script>", slot: null, dueAtMs: 1, flaggedAtMs: 2 },
    { kind: "case-deadline", slot: "B1", dueAtMs: 1, flaggedAtMs: 2 },
    "case-deadline"
  ];
  const withDue = (answer: unknown) => ({
    caseServiceOver: (inner: Parameters<typeof caseServiceOver>[0]) => {
      const service = caseServiceOver(inner);
      return { ...service, open: async (...args: Parameters<typeof service.open>) => { const opened = await service.open(...args); return opened.ok ? { ...opened, due: answer } : opened; } };
    }
  });
  const { commands } = commandsRecording();
  const page = await (await (await viewerWorld({ commands, serviceModule: withDue(due) })).send(CASE)).text();
  assert.ok(page.includes("A deadline is due, and nothing has been written for it."));
  assert.ok(page.includes("The attempt&#39;s deadline passed. Slot <code>B2</code>. Due 2026-11-01T12:00:00.000Z, flagged 2026-11-01T12:00:05.000Z."));
  assert.ok(page.includes("Reconcile is due. Due 2026-11-01T12:15:00.000Z, flagged 2026-11-01T12:15:01.000Z."));
  assert.equal(page.match(/<li>[^<]*(?:deadline passed|is due)\./g)?.length, 2, "the three that are no mark are not shown");
  assert.ok(!page.includes("dueRan"));
  assert.ok(page.includes("An alarm holds no token of yours, so it wrote nothing to this case's log"));
  assert.ok(page.includes("<h2>Commands</h2>") && page.includes("A command carries no key of its own"));
  // A hosted case with nothing flagged shows its commands and no banner. One that is not hosted shows neither.
  const quiet = await (await (await viewerWorld({ commands, serviceModule: withDue([]) })).send(CASE)).text();
  assert.ok(quiet.includes("<h2>Commands</h2>") && !quiet.includes("A deadline is due"));
  const notHosted = await (await (await viewerWorld({ commands })).send(CASE)).text();
  assert.ok(!notHosted.includes("<h2>Commands</h2>") && !notHosted.includes("A deadline is due"));
  const noSeam = await (await (await viewerWorld({ serviceModule: withDue(due) })).send(CASE)).text();
  assert.ok(!noSeam.includes("<h2>Commands</h2>") && !noSeam.includes("A deadline is due"));
});

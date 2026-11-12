// What the TLA+ case-machine conformance suite and its export script share: reading the
// values TLC prints, the code of a state as the specification orders it, the same code
// taken from the real machine's state, the mapping from a specification event to the
// event the real machine takes, and the digest both sides fold their transitions into.
//
// The orders below restate the ones in specs/case-machine/CaseMachineExport.tla. If the
// two files disagree the digests differ, so a drift between them fails the suite and
// cannot pass it.

import { createHash } from "node:crypto";

export const SLOT_ORDER = ["none", "B1", "B2", "B3", "I1", "I2", "I3"];
export const CONFIGURATION_ORDER = ["none", "alder", "birch"];
export const PHASE_ORDER = ["planned", "starting", "capturing", "finalizing", "usable", "walled", "failed", "incomplete", "timed_out", "cancelled", "not_started"];
export const CLEANUP_ORDER = ["none", "pending", "confirmed", "unconfirmed", "environment_destroyed"];
export const RULE_ORDER = ["pending", "met", "not_met", "not_applicable"];
export const CLOSURE_ORDER = ["none", "completed", "cancelled", "deadline", "baseline_not_met"];
export const CONTINUATION_ORDER = ["allowed", "blocked", "not_applicable"];
export const GLOBAL_FIELDS = 9;
export const ATTEMPT_FIELDS = 4;

/** The plans the specification's configurations name, by the configuration's file name. */
export const PLANS = {
  "six-slots": ["B1", "B2", "B3", "I1", "I2", "I3"],
  instrumented: ["I1", "I2", "I3"],
  baseline: ["B1", "B2", "B3"],
  "one-each": ["B1", "I1"],
  "two-each": ["B1", "B2", "I1", "I2"]
};
export const PLAN_OPERATORS = { "six-slots": "PlanSixSlots", instrumented: "PlanInstrumented", baseline: "PlanBaseline", "one-each": "PlanOneEach", "two-each": "PlanTwoEach" };
export const CAPS = { MaxControlMisses: 2, MaxStartRetries: 2, MaxConfigurationChanges: 1 };

/**
 * One value as TLC's ToString writes it: a number, a string, TRUE or FALSE, a tuple (an
 * array), a set ({ set: [...] }), or a record (an object). Anything else throws, so a
 * line this cannot read is never read as something smaller.
 */
export function parseTlaValue(text) {
  let at = 0;
  const fail = (what) => {
    throw new Error(`Cannot read a TLA+ value: ${what} at ${at} in ${text.slice(0, 200)}`);
  };
  const skip = () => {
    while (text[at] === " ") at += 1;
  };
  const expect = (token) => {
    skip();
    if (!text.startsWith(token, at)) fail(`expected ${token}`);
    at += token.length;
  };
  const list = (close) => {
    const items = [];
    skip();
    if (text.startsWith(close, at)) {
      at += close.length;
      return items;
    }
    for (;;) {
      items.push(value());
      skip();
      if (text[at] === ",") {
        at += 1;
        continue;
      }
      expect(close);
      return items;
    }
  };
  const value = () => {
    skip();
    if (text.startsWith("<<", at)) {
      at += 2;
      return list(">>");
    }
    if (text[at] === "{") {
      at += 1;
      return { set: list("}") };
    }
    if (text[at] === "[") {
      at += 1;
      const record = {};
      for (;;) {
        skip();
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
        if (name === null) fail("expected a field name");
        at += name[0].length;
        expect("|->");
        record[name[0]] = value();
        skip();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        expect("]");
        return record;
      }
    }
    if (text[at] === '"') {
      const end = text.indexOf('"', at + 1);
      if (end < 0) fail("an open string");
      const inner = text.slice(at + 1, end);
      if (inner.includes("\\")) fail("an escape in a string");
      at = end + 1;
      return inner;
    }
    if (text.startsWith("TRUE", at)) {
      at += 4;
      return true;
    }
    if (text.startsWith("FALSE", at)) {
      at += 5;
      return false;
    }
    const number = /^[0-9]+/.exec(text.slice(at));
    if (number === null) fail("an unknown value");
    at += number[0].length;
    return Number(number[0]);
  };
  const parsed = value();
  skip();
  if (at !== text.length) fail("text after the value");
  return parsed;
}

/** A line TLC printed through PrintT(ToString(...)), or null for any other line of its output. */
export function parseExportLine(line) {
  if (!line.startsWith('"<<')) return null;
  return parseTlaValue(JSON.parse(line));
}

const CODE_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A code as text, one character per number. Every number of a code is below 36. */
export function packCode(code) {
  let packed = "";
  for (const digit of code) {
    if (!Number.isInteger(digit) || digit < 0 || digit >= CODE_DIGITS.length) throw new Error(`A code holds ${String(digit)}, which no character stands for`);
    packed += CODE_DIGITS[digit];
  }
  return packed;
}

export function unpackCode(packed) {
  const code = [];
  for (const character of packed) {
    const digit = CODE_DIGITS.indexOf(character);
    if (digit < 0) throw new Error(`A packed code holds ${character}`);
    code.push(digit);
  }
  return code;
}

/** One state's line: its code, its views, and each event it accepts with the code that event leaves, in the alphabet's order. */
export function stateLine(code, views, accepted) {
  const sorted = [...accepted].sort((left, right) => left[0] - right[0]);
  return `${code}|${views}|${sorted.map(([index, next]) => `${index}>${next}`).join(";")}`;
}

const MODULUS = 1n << 256n;

/**
 * A digest of a set of lines that does not depend on their order: the sum of each line's
 * SHA-256, modulo 2^256, with how many lines went in. TLC and the real machine reach the
 * same states in different orders, so the digest must not read the order.
 */
export function relationDigest() {
  let sum = 0n;
  let states = 0;
  let edges = 0;
  return {
    add(line, acceptedCount) {
      sum = (sum + BigInt(`0x${createHash("sha256").update(line, "utf8").digest("hex")}`)) % MODULUS;
      states += 1;
      edges += acceptedCount;
    },
    result() {
      return { states, edges, digest: sum.toString(16).padStart(64, "0") };
    }
  };
}

function indexIn(order, value, what) {
  const found = order.indexOf(value === null ? "none" : value);
  if (found < 0) throw new Error(`${what} holds ${JSON.stringify(value)}, which the specification's order does not name`);
  return found;
}

const STATE_KEYS = ["planDigest", "controlRunId", "configuration", "configurationChanges", "controlMet", "controlMisses", "exceptionFor", "exploratory", "baselineRule", "closedBy", "attempts", "purge"];
const ATTEMPT_KEYS = ["slot", "arm", "attemptId", "phase", "cleanup", "configuration", "startRetries", "evidence"];

/**
 * What ties the real machine to the specification's names: the fixture the exploration
 * suite walks with, and the real module. `fixture` and `machine` are the compiled
 * investigation/test/case-fixture and investigation/core/case-machine.
 */
export function bindReal(fixture, machine, planSlots) {
  const configurationName = new Map([
    [fixture.CONFIG_A, "alder"],
    [fixture.CONFIG_B, "birch"]
  ]);
  const configurationOf = { alder: fixture.CONFIG_A, birch: fixture.CONFIG_B };
  const plan = fixture.planOf(...planSlots);

  /** The real state as the specification's code. Every field the code does not hold is held to its constant here, so nothing it leaves out can move unseen. */
  const encode = (state) => {
    const keys = Object.keys(state);
    if (keys.length !== STATE_KEYS.length || keys.some((key, at) => key !== STATE_KEYS[at])) throw new Error(`The real state's fields are ${keys.join(", ")}`);
    if (state.controlRunId !== fixture.CONTROL_RUN_ID || state.purge !== null) throw new Error("The real state left the walked domain: its control run or its manifest moved");
    if (state.planDigest !== null && state.planDigest !== fixture.PLAN_DIGEST) throw new Error("The real state holds another plan digest");
    if (state.attempts.length !== planSlots.length) throw new Error("The real state's attempts are not the plan's");
    const code = [
      state.planDigest === null ? 0 : 1,
      indexIn(CONFIGURATION_ORDER, configurationName.get(state.configuration), "configuration"),
      state.configurationChanges,
      state.controlMet === true ? 1 : state.controlMet === false ? 0 : NaN,
      state.controlMisses,
      indexIn(SLOT_ORDER, state.exceptionFor, "exceptionFor"),
      state.exploratory === true ? 1 : state.exploratory === false ? 0 : NaN,
      indexIn(RULE_ORDER, state.baselineRule, "baselineRule"),
      indexIn(CLOSURE_ORDER, state.closedBy, "closedBy")
    ];
    state.attempts.forEach((attempt, position) => {
      const attemptKeys = Object.keys(attempt);
      const slot = planSlots[position];
      if (attemptKeys.length !== ATTEMPT_KEYS.length || attemptKeys.some((key, at) => key !== ATTEMPT_KEYS[at])) throw new Error(`An attempt's fields are ${attemptKeys.join(", ")}`);
      if (attempt.slot !== slot || attempt.arm !== (slot.startsWith("B") ? "baseline" : "instrumented") || attempt.attemptId !== fixture.ATTEMPT_IDS[slot]) throw new Error(`The attempt at ${position} is not the plan's: its slot, arm or id moved`);
      if (!Array.isArray(attempt.evidence) || attempt.evidence.length !== 0) throw new Error("An attempt holds evidence, which this walk never records");
      code.push(
        indexIn(PHASE_ORDER, attempt.phase, "phase"),
        indexIn(CLEANUP_ORDER, attempt.cleanup, "cleanup"),
        indexIn(CONFIGURATION_ORDER, attempt.configuration === null ? null : configurationName.get(attempt.configuration), "attempt configuration"),
        attempt.startRetries
      );
    });
    return packCode(code);
  };

  /** The real state a code names, built from the fixture. */
  const decode = (packed) => {
    const code = unpackCode(packed);
    const attempts = planSlots.map((slot, position) => {
      const [phase, cleanup, ranUnder, retries] = code.slice(GLOBAL_FIELDS + ATTEMPT_FIELDS * position, GLOBAL_FIELDS + ATTEMPT_FIELDS * (position + 1));
      return {
        slot,
        arm: slot.startsWith("B") ? "baseline" : "instrumented",
        attemptId: fixture.ATTEMPT_IDS[slot],
        phase: PHASE_ORDER[phase],
        cleanup: cleanup === 0 ? null : CLEANUP_ORDER[cleanup],
        configuration: ranUnder === 0 ? null : configurationOf[CONFIGURATION_ORDER[ranUnder]],
        startRetries: retries,
        evidence: []
      };
    });
    return {
      planDigest: code[0] === 1 ? fixture.PLAN_DIGEST : null,
      controlRunId: fixture.CONTROL_RUN_ID,
      configuration: configurationOf[CONFIGURATION_ORDER[code[1]]],
      configurationChanges: code[2],
      controlMet: code[3] === 1,
      controlMisses: code[4],
      exceptionFor: code[5] === 0 ? null : SLOT_ORDER[code[5]],
      exploratory: code[6] === 1,
      baselineRule: RULE_ORDER[code[7]],
      closedBy: code[8] === 0 ? null : CLOSURE_ORDER[code[8]],
      attempts,
      purge: null
    };
  };

  /** The views the rules define, read from the real machine's own functions, in the specification's order. */
  const views = (state) => {
    const d = machine.denominatorOf(state);
    const continuation = machine.continuationOf(state);
    const blocked = continuation.continuation === "blocked" ? continuation.slots : [];
    if (continuation.continuation === "blocked" && (continuation.reason !== "cleanup_unresolved" || blocked.some((slot, at) => planSlots.indexOf(slot) < 0 || (at > 0 && planSlots.indexOf(slot) <= planSlots.indexOf(blocked[at - 1]))))) {
      throw new Error("A blocked continuation names its slots out of plan order, or gives another reason");
    }
    return packCode([
      d.planned,
      d.running,
      d.notStarted,
      d.waiting,
      d.usable,
      d.walled,
      d.failed,
      d.incomplete,
      d.timed_out,
      d.cancelled,
      machine.isTerminal(state) ? 1 : 0,
      indexIn(CONTINUATION_ORDER, continuation.continuation, "continuation"),
      ...planSlots.map((slot) => (blocked.includes(slot) ? 1 : 0))
    ]);
  };

  const actorOf = (by) => {
    if (by.kind === "owner" && by.of === "none") return fixture.OWNER;
    if (by.kind !== "runner") throw new Error(`No real actor for ${JSON.stringify(by)}`);
    if (by.of === "control") return fixture.CONTROL_RUNNER;
    if (by.of === "foreign") return fixture.FOREIGN_RUNNER;
    if (!(by.of in fixture.ATTEMPT_IDS)) throw new Error(`No real runner for ${JSON.stringify(by)}`);
    return fixture.runnerOf(by.of);
  };

  /** The event the real machine takes for a specification event. A field this does not know throws. */
  const eventOf = (event) => {
    const real = { type: event.type };
    for (const [field, value] of Object.entries(event)) {
      if (field === "type") continue;
      else if (field === "by") real.by = actorOf(value);
      else if (field === "configuration") real.configuration = configurationOf[value];
      else if (field === "slot" || field === "result" || field === "outcome") real[field] = value;
      else throw new Error(`No real field for ${field} of ${event.type}`);
    }
    if (real.configuration === undefined && "configuration" in event) throw new Error(`No real configuration for ${String(event.configuration)}`);
    if (event.type === "plan-frozen") real.planDigest = fixture.PLAN_DIGEST;
    return real;
  };

  return { plan, encode, decode, views, eventOf, actorOf };
}

const sortedJson = (value) => JSON.stringify(value, (_key, inner) => (inner !== null && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) : inner));

/**
 * The real machine's reachable transition relation over the specification's alphabet,
 * breadth first from the planned state: for each state its line, folded into the digest,
 * and handed to `visit` when one is given. `events` are real events, in the alphabet's
 * order. A state past `bound` throws, so a machine that grows the space stops here.
 */
export function walkReal(machine, bound, real, events, visit) {
  const first = machine.plannedState(real.plan);
  if (!first.ok) throw new Error(`The real machine refused the plan: ${first.refusal}`);
  const firstCode = real.encode(first.state);
  const seen = new Set([firstCode]);
  const queue = [firstCode];
  const digest = relationDigest();
  for (let at = 0; at < queue.length; at += 1) {
    const code = queue[at];
    const state = real.decode(code);
    if (real.encode(state) !== code) throw new Error(`The code ${code} does not rebuild the state it was taken from`);
    const accepted = [];
    for (let index = 0; index < events.length; index += 1) {
      const answer = machine.step(state, events[index]);
      if (!answer.ok) continue;
      const next = real.encode(answer.state);
      accepted.push([index + 1, next]);
      if (!seen.has(next)) {
        if (seen.size >= bound) throw new Error(`The real machine reached more than ${bound} states: its space grew past the specification's`);
        seen.add(next);
        queue.push(next);
      }
    }
    const views = real.views(state);
    digest.add(stateLine(code, views, accepted), accepted.length);
    if (visit !== undefined) visit(code, views, accepted, state);
  }
  return { ...digest.result(), first: firstCode };
}

/** Whether two event lists hold the same events, whatever their order. */
export function sameEventSet(left, right) {
  const key = (events) => events.map(sortedJson).sort();
  const ours = key(left);
  const theirs = key(right);
  return ours.length === theirs.length && ours.every((event, at) => event === theirs[at]);
}

/**
 * The class of a transition: the event's type and what it names besides the slot, the
 * slot's arm, the phase and cleanup the slot left from, the closure it left the case with,
 * and how it moved the gate. The traces the export keeps hold one transition of each
 * class the specification's reachable relation holds.
 */
export function transitionClass(planSlots, event, beforePacked, afterPacked) {
  const before = unpackCode(beforePacked);
  const after = unpackCode(afterPacked);
  const parts = [event.type];
  if ("result" in event) parts.push(`result=${event.result}`);
  if ("outcome" in event) parts.push(`outcome=${event.outcome}`);
  if ("configuration" in event) parts.push(`configuration=${CONFIGURATION_ORDER[before[1]] === event.configuration ? "in-force" : "other"}`);
  if ("slot" in event) {
    const position = planSlots.indexOf(event.slot);
    const base = GLOBAL_FIELDS + ATTEMPT_FIELDS * position;
    parts.push(`arm=${event.slot.startsWith("B") ? "baseline" : "instrumented"}`, `from=${PHASE_ORDER[before[base]]}`, `cleanup=${CLEANUP_ORDER[before[base + 1]]}`);
    if (event.type === "attempt-started") parts.push(`basis=${before[3] === 1 ? "control" : ""}${before[5] !== 0 ? "exception" : ""}`);
  }
  if (event.type === "reconcile") parts.push(before.some((digit, at) => at >= GLOBAL_FIELDS && (at - GLOBAL_FIELDS) % ATTEMPT_FIELDS === 0 && digit >= 1 && digit <= 3) ? "a-running-attempt" : "pending-cleanup");
  if (before[8] !== 0) parts.push("on-a-closed-case");
  else if (after[8] !== 0) parts.push(`closes=${CLOSURE_ORDER[after[8]]}`);
  if (after[3] !== before[3]) parts.push(after[3] === 1 ? "gate-opens" : "gate-clears");
  if (after[4] > before[4]) parts.push("miss-counted");
  else if (after[4] < before[4]) parts.push("misses-cleared");
  if (after[5] !== before[5]) parts.push(after[5] === 0 ? "exception-spent" : "exception-set");
  return parts.join(" ");
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

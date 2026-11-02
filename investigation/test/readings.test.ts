import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import type { Cleanup } from "../core/case-machine";
import * as production from "../core/readings";
import { MAX_TIME_MS, orderOf, readExecutionJoin, readObservation, stackToScriptPosition, type Completeness, type Granularity, type JoinReason, type ObservationInput, type ObservationReading, type Position, type ReportedRange, type ScriptIdentity, type SessionInventory, type StackCall, type WindowEnd } from "../core/readings";

/**
 * The two pure reading functions the plan names, walked over their closed domains. The
 * expected reading of an observation is a table written here, which RESTATES the rule and says
 * so: it shows the function and the table agree on every input. The named properties below
 * it are stated without the table, over the function's answers, so each can fail on its own.
 */

type ReadingsModule = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<ReadingsModule>(require.resolve("../core/readings"), edits);

const RECORDS = ["present", "absent"] as const;
const COUNTS = [null, -1, 0.5, 0, 1, 7] as const;
const GRANULARITIES: readonly Granularity[] = ["block", "function"];
const WINDOW_ENDS: readonly WindowEnd[] = ["window_closed", "truncated", "target_crashed", "operation_failed", "deadline", "cancelled"];
const SCOPES = ["in_scope", "out_of_scope"] as const;
const COMPLETENESS: readonly Completeness[] = ["complete", "partial", "missing", "not_recorded"];
const CLEANUPS: readonly Cleanup[] = ["pending", "confirmed", "unconfirmed", "environment_destroyed"];
const OPERATIONS = ["succeeded", "walled", "incomplete", "failed_retained"] as const;

function* everyInput(): Generator<ObservationInput> {
  for (const record of RECORDS)
    for (const count of COUNTS)
      for (const granularity of GRANULARITIES)
        for (const windowEnd of WINDOW_ENDS)
          for (const scope of SCOPES)
            for (const completeness of COMPLETENESS)
              for (const cleanup of CLEANUPS)
                for (const operation of OPERATIONS) yield { record, count: count as number | null, granularity, windowEnd, scope, completeness, cleanup, operation };
}

const INPUT_COUNT = 2 * 6 * 2 * 6 * 2 * 4 * 4 * 4;

function isWellFormedCount(count: number | null): boolean {
  return count === 0 || count === 1 || count === 7;
}

/** The rule, written out a second time as a table of what each input reads as. */
function expectedReading(input: ObservationInput): string {
  if (input.record === "absent") return input.scope === "out_of_scope" ? "unknown:out_of_scope" : "unknown:no_record";
  if (!isWellFormedCount(input.count)) return "unknown:malformed_record";
  if ((input.count as number) > 0) return "observed";
  if (input.scope === "out_of_scope") return "unknown:out_of_scope";
  if (input.windowEnd !== "window_closed") return "unknown:truncated";
  if (input.completeness === "missing") return "unknown:no_record";
  if (input.operation === "failed_retained") return "unknown:operation_failed";
  return "zero_in_window";
}

const labelOf = (reading: ObservationReading): string => (reading.reading === "unknown" ? `unknown:${reading.reason}` : reading.reading);

const checkAgainstTable = (module: ReadingsModule) => {
  let inputs = 0;
  for (const input of everyInput()) {
    inputs += 1;
    const reading = module.readObservation(input);
    holds("every observation reads as the table says", labelOf(reading) === expectedReading(input), () => ({ input, reading }));
  }
  assert.equal(inputs, INPUT_COUNT, "the domain's size is pinned");
};

const POSITIVE = "a count above 0 stays observed under every limit";

const checkPositive = (module: ReadingsModule) => {
  let seen = 0;
  for (const input of everyInput()) {
    if (input.record !== "present" || (input.count !== 1 && input.count !== 7)) continue;
    seen += 1;
    const reading = module.readObservation(input);
    holds(POSITIVE, reading.reading === "observed" && reading.count === input.count, () => ({ input, reading }));
  }
  assert.equal(seen, INPUT_COUNT / 2 / 6 * 2);
};

const NO_RECORD = "no record never reads as a count";

const checkNoRecord = (module: ReadingsModule) => {
  for (const input of everyInput()) {
    if (input.record !== "absent") continue;
    const reading = module.readObservation(input);
    holds(NO_RECORD, reading.reading === "unknown", () => ({ input, reading }));
  }
};

const NOT_ABSENT = "truncation, out of scope, a missing instrument and a failed operation never read as 0";

const checkZeroOnlyWhenItCan = (module: ReadingsModule) => {
  for (const input of everyInput()) {
    if (input.record !== "present" || input.count !== 0) continue;
    const barred = input.windowEnd !== "window_closed" || input.scope === "out_of_scope" || input.completeness === "missing" || input.operation === "failed_retained";
    const reading = module.readObservation(input);
    holds(NOT_ABSENT, barred ? reading.reading === "unknown" : reading.reading === "zero_in_window", () => ({ input, reading }));
  }
};

const MALFORMED = "a count that is no count reads unknown";

const checkMalformed = (module: ReadingsModule) => {
  for (const input of everyInput()) {
    if (input.record !== "present" || isWellFormedCount(input.count)) continue;
    const reading = module.readObservation(input);
    holds(MALFORMED, reading.reading === "unknown" && reading.reason === "malformed_record", () => ({ input, reading }));
  }
};

const GRANULARITY = "a reading keeps the granularity reported, so function-only is never branch-level";

const checkGranularity = (module: ReadingsModule) => {
  for (const input of everyInput()) {
    const reading = module.readObservation(input);
    if (reading.reading === "unknown") continue;
    holds(GRANULARITY, reading.granularity === input.granularity, () => ({ input, reading }));
    if (input.granularity === "function") holds(GRANULARITY, !reading.complete && reading.limits.includes("function_only"), () => ({ input, reading }));
  }
};

const COMPLETE = "complete is withheld unless every condition holds";

const checkComplete = (module: ReadingsModule) => {
  let complete = 0;
  for (const input of everyInput()) {
    const reading = module.readObservation(input);
    const every =
      input.record === "present" &&
      isWellFormedCount(input.count) &&
      input.granularity === "block" &&
      input.windowEnd === "window_closed" &&
      input.scope === "in_scope" &&
      input.completeness === "complete" &&
      (input.cleanup === "confirmed" || input.cleanup === "environment_destroyed") &&
      input.operation === "succeeded";
    holds(COMPLETE, reading.complete === every, () => ({ input, reading }));
    holds(COMPLETE, reading.limits.length === 0 ? every : !every, () => ({ input, reading }));
    if (every) complete += 1;
  }
  // Three counts, two resolved cleanups, and everything else as it must be.
  holds(COMPLETE, complete === 6, () => ({ complete }));
};

const LIMITS = "every unmet condition is named as a limit";

const LIMIT_OF: readonly (readonly [string, (input: ObservationInput) => boolean])[] = [
  ["no_record", (input) => input.record === "absent"],
  ["malformed_record", (input) => input.record === "present" && !isWellFormedCount(input.count)],
  ["out_of_scope", (input) => input.scope !== "in_scope"],
  ["window_not_closed", (input) => input.windowEnd !== "window_closed"],
  ["coverage_not_complete", (input) => input.completeness !== "complete"],
  ["cleanup_unresolved", (input) => input.cleanup === "pending" || input.cleanup === "unconfirmed"],
  ["function_only", (input) => input.granularity === "function"],
  ["attempt_walled", (input) => input.operation === "walled"],
  ["attempt_incomplete", (input) => input.operation === "incomplete"],
  ["operation_failed", (input) => input.operation === "failed_retained"]
];

const checkLimits = (module: ReadingsModule) => {
  for (const input of everyInput()) {
    const expected = LIMIT_OF.filter(([, applies]) => applies(input)).map(([name]) => name);
    const reading = module.readObservation(input);
    holds(LIMITS, JSON.stringify(reading.limits) === JSON.stringify(expected), () => ({ input, reading, expected }));
  }
};

test("every observation, over the full product of its axes, reads as a table spelled out here", () => {
  checkAgainstTable(production);
  checkPositive(production);
  checkNoRecord(production);
  checkZeroOnlyWhenItCan(production);
  checkMalformed(production);
  checkGranularity(production);
  checkComplete(production);
  checkLimits(production);
});

test("a record that is neither present nor absent, as an untyped caller could send, reads as no record", () => {
  for (const record of [undefined, null, "", "maybe"]) {
    const reading = readObservation({ record, count: 3, granularity: "block", windowEnd: "window_closed", scope: "in_scope", completeness: "complete", cleanup: "confirmed", operation: "succeeded" } as unknown as ObservationInput);
    assert.deepEqual(reading, { reading: "unknown", reason: "no_record", complete: false, limits: ["no_record"] });
  }
});

test("a reading's vocabulary has no word for absent, and a 0 says only what it can", () => {
  const seen = new Set<string>();
  for (const input of everyInput()) seen.add(labelOf(readObservation(input)));
  assert.deepEqual([...seen].sort(), ["observed", "unknown:malformed_record", "unknown:no_record", "unknown:operation_failed", "unknown:out_of_scope", "unknown:truncated", "zero_in_window"]);
  const zero = readObservation({ record: "present", count: 0, granularity: "function", windowEnd: "window_closed", scope: "in_scope", completeness: "partial", cleanup: "unconfirmed", operation: "succeeded" });
  assert.deepEqual(zero, { reading: "zero_in_window", granularity: "function", windowEnd: "window_closed", complete: false, limits: ["coverage_not_complete", "cleanup_unresolved", "function_only"] });
  const positive = readObservation({ record: "present", count: 7, granularity: "block", windowEnd: "truncated", scope: "in_scope", completeness: "partial", cleanup: "unconfirmed", operation: "failed_retained" });
  assert.deepEqual(positive, { reading: "observed", count: 7, granularity: "block", windowEnd: "truncated", complete: false, limits: ["window_not_closed", "coverage_not_complete", "cleanup_unresolved", "operation_failed"] });
  // A walled or incomplete attempt's 0 stays a statement about its window, with its outcome named, and complete withheld.
  const everythingElse = { record: "present", count: 0, granularity: "block", windowEnd: "window_closed", scope: "in_scope", completeness: "complete", cleanup: "confirmed" } as const;
  assert.deepEqual(readObservation({ ...everythingElse, operation: "walled" }), { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_walled"] });
  assert.deepEqual(readObservation({ ...everythingElse, operation: "incomplete" }), { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_incomplete"] });
  assert.deepEqual(readObservation({ ...everythingElse, operation: "failed_retained" }), { reading: "unknown", reason: "operation_failed", complete: false, limits: ["operation_failed"] });
  assert.deepEqual(readObservation({ ...everythingElse, operation: "succeeded" }), { reading: "zero_in_window", granularity: "block", windowEnd: "window_closed", complete: true, limits: [] });
  // A positive stays observed in all four, and only the plain one is complete.
  assert.deepEqual(readObservation({ ...everythingElse, count: 7, operation: "walled" }), { reading: "observed", count: 7, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_walled"] });
  assert.deepEqual(readObservation({ ...everythingElse, count: 7, operation: "incomplete" }), { reading: "observed", count: 7, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["attempt_incomplete"] });
  assert.deepEqual(readObservation({ ...everythingElse, count: 7, operation: "failed_retained" }), { reading: "observed", count: 7, granularity: "block", windowEnd: "window_closed", complete: false, limits: ["operation_failed"] });
  assert.deepEqual(readObservation({ ...everythingElse, count: 7, operation: "succeeded" }), { reading: "observed", count: 7, granularity: "block", windowEnd: "window_closed", complete: true, limits: [] });
});

const OBSERVED_LINE = "if (input.count > 0)\n        return { reading: \"observed\"";

for (const [name, property, check, edits] of [
  ["incompleteness erasing a positive", POSITIVE, checkPositive, [{ find: OBSERVED_LINE, replace: 'if (input.count > 0 && input.completeness === "complete")\n        return { reading: "observed"' }]],
  ["unconfirmed cleanup erasing a positive", POSITIVE, checkPositive, [{ find: OBSERVED_LINE, replace: 'if (input.count > 0 && input.cleanup !== "unconfirmed")\n        return { reading: "observed"' }]],
  ["a failed operation erasing what it retained", POSITIVE, checkPositive, [{ find: OBSERVED_LINE, replace: 'if (input.count > 0 && input.operation === "succeeded")\n        return { reading: "observed"' }]],
  ["a cut-short window erasing a positive", POSITIVE, checkPositive, [{ find: OBSERVED_LINE, replace: 'if (input.count > 0 && input.windowEnd === "window_closed")\n        return { reading: "observed"' }]],
  ["no record read as 0", NO_RECORD, checkNoRecord, [{ find: 'if (input.record !== "present")\n        return unknown(input.scope === "out_of_scope" ? "out_of_scope" : "no_record");', replace: 'if (input.record !== "present")\n        return { reading: "zero_in_window", granularity: input.granularity, windowEnd: input.windowEnd, complete: false, limits };' }]],
  ["a truncated 0 read as a 0", NOT_ABSENT, checkZeroOnlyWhenItCan, [{ find: 'if (input.windowEnd !== "window_closed")\n        return unknown("truncated");', replace: "" }]],
  ["an out-of-scope 0 read as a 0", NOT_ABSENT, checkZeroOnlyWhenItCan, [{ find: 'if (input.scope === "out_of_scope")\n        return unknown("out_of_scope");\n    if (input.windowEnd', replace: "if (input.windowEnd" }]],
  ["a missing instrument's 0 read as a 0", NOT_ABSENT, checkZeroOnlyWhenItCan, [{ find: 'if (input.completeness === "missing")\n        return unknown("no_record");', replace: "" }]],
  ["a failed operation's 0 read as a 0", NOT_ABSENT, checkZeroOnlyWhenItCan, [{ find: 'if (input.operation === "failed_retained")\n        return unknown("operation_failed");', replace: "" }]],
  ["a walled attempt's 0 read as nothing", NOT_ABSENT, checkZeroOnlyWhenItCan, [{ find: 'if (input.operation === "failed_retained")\n        return unknown("operation_failed");', replace: 'if (input.operation !== "succeeded")\n        return unknown("operation_failed");' }]],
  ["a count that is no count taken as one", MALFORMED, checkMalformed, [{ find: 'if (!isCount(input.count))\n        return unknown("malformed_record");', replace: "" }]],
  ["a negative count taken as one", MALFORMED, checkMalformed, [{ find: "return Number.isSafeInteger(value) && value >= 0;", replace: "return Number.isSafeInteger(value);" }]],
  ["a fractional count taken as one", MALFORMED, checkMalformed, [{ find: "return Number.isSafeInteger(value) && value >= 0;", replace: 'return typeof value === "number" && value >= 0;' }]],
  ["function-only read as branch-level, on a positive", GRANULARITY, checkGranularity, [{ find: 'reading: "observed", count: input.count, granularity: input.granularity,', replace: 'reading: "observed", count: input.count, granularity: "block",' }]],
  ["function-only read as branch-level, on a 0", GRANULARITY, checkGranularity, [{ find: 'reading: "zero_in_window", granularity: input.granularity,', replace: 'reading: "zero_in_window", granularity: "block",' }]],
  ["completeness inferred from counts", COMPLETE, checkComplete, [{ find: "const complete = limits.length === 0;", replace: "const complete = input.count > 0;" }]],
  ["completeness inferred from a closed window", COMPLETE, checkComplete, [{ find: "const complete = limits.length === 0;", replace: 'const complete = input.windowEnd === "window_closed";' }]],
  ["unconfirmed cleanup not withholding complete", COMPLETE, checkComplete, [{ find: 'input.cleanup !== "confirmed" && input.cleanup !== "environment_destroyed"', replace: 'input.cleanup === "pending"' }]],
  ["a destroyed environment withholding complete", COMPLETE, checkComplete, [{ find: 'input.cleanup !== "confirmed" && input.cleanup !== "environment_destroyed"', replace: 'input.cleanup !== "confirmed"' }]],
  ["partial coverage not withholding complete", COMPLETE, checkComplete, [{ find: 'if (input.completeness !== "complete")', replace: 'if (input.completeness === "missing")' }]],
  ["function-only not withholding complete", COMPLETE, checkComplete, [{ find: 'if (input.granularity !== "block")\n        limits.push("function_only");', replace: "" }]],
  ["a failed operation not withholding complete", COMPLETE, checkComplete, [{ find: 'else if (input.operation !== "succeeded")\n        limits.push("operation_failed");', replace: "" }]],
  ["a walled attempt not withholding complete", COMPLETE, checkComplete, [{ find: 'if (input.operation === "walled")\n        limits.push("attempt_walled");', replace: 'if (input.operation === "walled") {}' }]],
  ["an incomplete attempt not withholding complete", COMPLETE, checkComplete, [{ find: 'else if (input.operation === "incomplete")\n        limits.push("attempt_incomplete");', replace: 'else if (input.operation === "incomplete") {}' }]],
  ["a cut-short window not withholding complete", COMPLETE, checkComplete, [{ find: 'if (input.windowEnd !== "window_closed")\n        limits.push("window_not_closed");', replace: "" }]],
  ["out of scope not withholding complete", COMPLETE, checkComplete, [{ find: 'if (input.scope !== "in_scope")\n        limits.push("out_of_scope");', replace: "" }]],
  ["no record left off the limits", LIMITS, checkLimits, [{ find: 'if (input.record !== "present")\n        limits.push("no_record");\n    else if', replace: "if" }]],
  ["a walled attempt named as a failed one", LIMITS, checkLimits, [{ find: 'limits.push("attempt_walled");', replace: 'limits.push("operation_failed");' }]],
  ["an incomplete attempt named as a failed one", LIMITS, checkLimits, [{ find: 'limits.push("attempt_incomplete");', replace: 'limits.push("operation_failed");' }]],
  ["a malformed count left off the limits", LIMITS, checkLimits, [{ find: 'else if (!isCount(input.count))\n        limits.push("malformed_record");', replace: "" }]]
] as const) {
  test(`observations catch ${name}, as ${property}`, async () => {
    await assertCaughtBy(name, property, () => check(variant(...(edits as readonly SourceEdit[]))));
  });
}

// Joins. Every value below differs from every other, so a comparison of the wrong two fails.

const ATTEMPT = "attempt-0f3a";
const OTHER_ATTEMPT = "attempt-77c1";
const INLINE_START: Position = { line: 40, column: 12 };
const SCRIPT_URL = "https://orchard-lane.example/page.html";
const SCRIPT_DIGEST = "ab".repeat(32);
const SCRIPT: ScriptIdentity = { scriptId: "script-17", url: SCRIPT_URL, resourceStart: INLINE_START, digest: SCRIPT_DIGEST };
const NO_ID: ScriptIdentity = { ...SCRIPT, scriptId: null };

/** Stack line 43, column 9: zero-based 42 and 8. The resource's line 42 is the script's line 2, which keeps its column. */
const CALL: StackCall = { attempt: ATTEMPT, target: "target-t1", frame: "frame-f1", loader: "loader-l1", script: SCRIPT, line: 43, column: 9, time: { clock: "page", ms: 1500 } };
const RANGE: ReportedRange = {
  attempt: ATTEMPT,
  target: "target-t1",
  frame: "frame-f1",
  loader: "loader-l1",
  script: SCRIPT,
  start: { line: 2, column: 3 },
  end: { line: 5, column: 7 },
  window: { clock: "page", startMs: 1000, endMs: 2000, uncertaintyMs: null }
};
const INVENTORY: SessionInventory = { attempt: ATTEMPT, scripts: [SCRIPT, { scriptId: "script-18", url: "https://orchard-lane.example/late.js", resourceStart: { line: 0, column: 0 }, digest: "cd".repeat(32) }] };

test("positive control: a call inside a reported range, in the same session, reads position_consistent and nothing more", () => {
  assert.deepEqual(readExecutionJoin(CALL, RANGE, INVENTORY), { reading: "position_consistent" });
  assert.deepEqual(stackToScriptPosition(43, 9, INLINE_START), { line: 2, column: 8 });
  assert.doesNotMatch(JSON.stringify(readExecutionJoin(CALL, RANGE, INVENTORY)), /caus/i);
});

type Fault = readonly [name: string, reasons: readonly JoinReason[] | "ambiguous" | "consistent", call: StackCall, range: ReportedRange, inventory?: SessionInventory];

const HAS_ID_ONLY: SessionInventory = { attempt: ATTEMPT, scripts: [{ scriptId: "script-17", url: null, resourceStart: null, digest: null }] };

/** The id and nothing else. */
const ID_17_ONLY: ScriptIdentity = { scriptId: "script-17", url: null, resourceStart: null, digest: null };

/** The same id and URL, at another start with other bytes. */
const ELSEWHERE_ON_THE_URL: ScriptIdentity = { ...SCRIPT, resourceStart: { line: 900, column: 0 }, digest: "e7".repeat(32) };

const ELSEWHERE: ScriptIdentity = { scriptId: "script-17", url: "https://orchard-lane.example/other.html", resourceStart: { line: 41, column: 12 }, digest: "ef".repeat(32) };

const FAULTS: readonly Fault[] = [
  // One condition at a time, with the rest met.
  ["the range is from another attempt", ["attempt_not_same"], CALL, { ...RANGE, attempt: OTHER_ATTEMPT }],
  ["both attempts unknown", ["attempt_not_same", "inventory_of_another_session"], { ...CALL, attempt: null }, { ...RANGE, attempt: null }],
  ["both attempts empty", ["attempt_not_same", "inventory_of_another_session"], { ...CALL, attempt: "" }, { ...RANGE, attempt: "" }, { ...INVENTORY, attempt: "" }],
  ["another target", ["target_not_same"], CALL, { ...RANGE, target: "target-t2" }],
  ["both targets unknown", ["target_not_same"], { ...CALL, target: null }, { ...RANGE, target: null }],
  ["both targets empty", ["target_not_same"], { ...CALL, target: "" }, { ...RANGE, target: "" }],
  ["another frame", ["frame_not_same"], CALL, { ...RANGE, frame: "frame-f2" }],
  ["both frames unknown", ["frame_not_same"], { ...CALL, frame: null }, { ...RANGE, frame: null }],
  ["both frames empty", ["frame_not_same"], { ...CALL, frame: "" }, { ...RANGE, frame: "" }],
  ["a replaced document: same frame, new loader", ["loader_not_same"], CALL, { ...RANGE, loader: "loader-l2" }],
  ["both loaders unknown", ["loader_not_same"], { ...CALL, loader: null }, { ...RANGE, loader: null }],
  ["both loaders empty", ["loader_not_same"], { ...CALL, loader: "" }, { ...RANGE, loader: "" }],
  ["the inventory of another session", ["inventory_of_another_session"], CALL, RANGE, { ...INVENTORY, attempt: OTHER_ATTEMPT }],
  ["another script id", ["script_id_differs"], CALL, { ...RANGE, script: { ...SCRIPT, scriptId: "script-99" } }],
  // One id, but something else about the script disagrees, so it is not the one script it says it is.
  ["the same id on another URL", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, url: "https://orchard-lane.example/other.html" } }],
  ["the same id with another digest", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, digest: "ef".repeat(32) } }],
  ["the same id with another resource start", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, resourceStart: { line: 41, column: 12 } } }],
  ["the same id, and the range says nothing else", "consistent", CALL, { ...RANGE, script: { scriptId: "script-17", url: null, resourceStart: null, digest: null } }],
  ["the same id, and the range's URL and digest are empty", "consistent", CALL, { ...RANGE, script: { ...SCRIPT, url: "", digest: "" } }],
  ["an id the inventory does not hold", ["not_in_inventory"], CALL, RANGE, { ...INVENTORY, scripts: [INVENTORY.scripts[1]] }],
  ["an id the inventory holds once, with nothing else", "consistent", CALL, RANGE, HAS_ID_ONLY],
  // The inventory is a third account of the script, and an id join needs it to agree too, with both.
  ["call and range agree, and the inventory's entry for that id has another URL", ["script_identity_differs"], CALL, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, url: "https://orchard-lane.example/other.html" }] }],
  ["call and range agree, and the inventory's entry for that id has another digest", ["script_identity_differs"], CALL, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: "ef".repeat(32) }] }],
  ["call and range agree, and the inventory's entry for that id starts elsewhere", ["script_identity_differs"], CALL, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, resourceStart: { line: 41, column: 12 } }] }],
  ["the range is silent on digest, and the inventory's entry disagrees with the call", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, digest: null } }, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: "ef".repeat(32) }] }],
  ["the call is silent on digest, and the inventory's entry disagrees with the range", ["script_identity_differs"], { ...CALL, script: { ...SCRIPT, digest: null } }, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: "ef".repeat(32) }] }],
  ["the call is silent on URL, and the inventory's entry disagrees with the range", ["script_identity_differs"], { ...CALL, script: { ...SCRIPT, url: null } }, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, url: "https://orchard-lane.example/other.html" }] }],
  ["the range is silent on URL, and the inventory's entry disagrees with the call", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, url: null } }, { ...INVENTORY, scripts: [{ ...SCRIPT, url: "https://orchard-lane.example/other.html" }] }],
  ["the range is silent on start, and the inventory's entry disagrees with the call", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, resourceStart: null } }, { ...INVENTORY, scripts: [{ ...SCRIPT, resourceStart: { line: 41, column: 12 } }] }],
  ["the inventory's entry says nothing, and the call and the range disagree on a URL", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, url: "https://orchard-lane.example/other.html" } }, HAS_ID_ONLY],
  ["the inventory's entry says nothing, and the call and the range disagree on a digest", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, digest: "ef".repeat(32) } }, HAS_ID_ONLY],
  ["the inventory's entry says nothing, and the call and the range disagree on a start", ["script_identity_differs"], CALL, { ...RANGE, script: { ...SCRIPT, resourceStart: { line: 41, column: 12 } } }, HAS_ID_ONLY],
  ["the inventory's entry is silent where they agree", "consistent", CALL, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, url: "", digest: null, resourceStart: null }] }],
  ["an id the inventory holds twice", "ambiguous", CALL, RANGE, { ...INVENTORY, scripts: [SCRIPT, SCRIPT] }],
  // Held twice with neither entry a candidate is no join, and with one entry a candidate it is that one.
  ["an id twice, both entries disagreeing on everything", ["script_identity_differs"], CALL, RANGE, { ...INVENTORY, scripts: [ELSEWHERE, ELSEWHERE] }],
  ["an id twice, both disagreeing on the digest alone", ["script_identity_differs"], CALL, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: "ef".repeat(32) }, { ...SCRIPT, digest: "77".repeat(32) }] }],
  ["an id twice, one entry agreeing and the other not", "consistent", CALL, RANGE, { ...INVENTORY, scripts: [ELSEWHERE, SCRIPT] }],
  ["an id twice, one disagreeing with the call and the other with the range", ["script_identity_differs"], { ...CALL, script: { ...SCRIPT, digest: null } }, { ...RANGE, script: { ...SCRIPT, url: null } }, { ...INVENTORY, scripts: [{ ...SCRIPT, url: "https://orchard-lane.example/other.html" }, { ...SCRIPT, digest: "ef".repeat(32) }] }],
  // An id on one side only is still an id: an inventory that does not hold it confirms nothing, whatever sits at that place.
  ["the call has an id, the range none, and the entry at that place has another", ["not_in_inventory"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, scriptId: "script-99" }] }],
  ["the range has an id, the call none, and the entry at that place has another", ["not_in_inventory"], { ...CALL, script: NO_ID }, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, scriptId: "script-99" }] }],
  // Either side with no id could be either copy, so the mirror reads the same.
  ["the call has an id, the range none, and the place holds it and another", "ambiguous", CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, scriptId: "script-99" }, SCRIPT] }],
  ["the range has an id, the call none, and the place holds it and another", "ambiguous", { ...CALL, script: NO_ID }, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, scriptId: "script-99" }, SCRIPT] }],
  // Where the inventory holds a one-sided id, an entry for it must agree with the range's place, as with ids on both sides.
  ["the call has an id, the range none, and the inventory holds that id elsewhere beside an entry with no id at the range's place", ["script_identity_differs"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [ELSEWHERE_ON_THE_URL, NO_ID] }],
  ["the range has an id, the call none, and the inventory holds that id elsewhere beside an entry with no id at the range's place", ["script_identity_differs"], { ...CALL, script: NO_ID }, RANGE, { ...INVENTORY, scripts: [ELSEWHERE_ON_THE_URL, NO_ID] }],
  ["the call has an id and no digest, and the inventory's entry for it has another digest than the range", ["script_identity_differs"], { ...CALL, script: { ...SCRIPT, digest: null } }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: "ef".repeat(32) }, NO_ID] }],
  ["the call has an id the inventory holds twice, once at the range's place and once elsewhere", "consistent", CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [ELSEWHERE_ON_THE_URL, SCRIPT] }],
  // An entry holding a one-sided id must place it at the range: URL and start known and equal, the digest equal where it names one.
  ["the call has an id the inventory holds with nothing else known, beside an entry with no id at the range's place", ["not_in_inventory"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [ID_17_ONLY, NO_ID] }],
  ["the range has an id the inventory holds with nothing else known, beside an entry with no id at its place", ["not_in_inventory"], { ...CALL, script: NO_ID }, RANGE, { ...INVENTORY, scripts: [ID_17_ONLY, NO_ID] }],
  ["the range has an id the inventory holds twice with nothing else known, beside an entry with no id at its place", ["not_in_inventory"], { ...CALL, script: NO_ID }, RANGE, { ...INVENTORY, scripts: [ID_17_ONLY, ID_17_ONLY, NO_ID] }],
  ["the call has an id the inventory holds with its URL alone, beside an entry with no id at the range's place", ["not_in_inventory"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...ID_17_ONLY, url: SCRIPT_URL }, NO_ID] }],
  ["the call has an id the inventory holds at the range's start and digest with no URL, beside an entry with no id there", ["not_in_inventory"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, url: null }, NO_ID] }],
  ["the call has an id the inventory holds once elsewhere and once with nothing known, beside an entry with no id at the range's place", ["not_in_inventory"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [ELSEWHERE_ON_THE_URL, ID_17_ONLY, NO_ID] }],
  ["the call has an id the inventory places at the range with another digest, beside an entry with no id there", ["script_identity_differs"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: "e7".repeat(32) }, NO_ID] }],
  ["the call has an id the inventory places at the range without a digest, and the entry there with the digest has another id", ["script_identity_differs"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: null }, { ...SCRIPT, scriptId: "script-99" }] }],
  ["the range has an id the inventory places at its place without a digest, and the entry there with the digest has another id", ["script_identity_differs"], { ...CALL, script: NO_ID }, RANGE, { ...INVENTORY, scripts: [{ ...SCRIPT, digest: null }, { ...SCRIPT, scriptId: "script-99" }] }],
  // The reason a one-sided id's no join names, against the checks around it.
  ["the call has an id the inventory holds only elsewhere on the URL", ["script_identity_differs"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [ELSEWHERE_ON_THE_URL] }],
  ["the call has an id the inventory does not hold, and the call and the range disagree on the digest", ["script_identity_differs"], { ...CALL, script: { ...SCRIPT, digest: "cd".repeat(32) } }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID] }],
  ["the call has an id the inventory does not hold, and the range names no digest", ["no_script_identity"], CALL, { ...RANGE, script: { ...NO_ID, digest: null } }, { ...INVENTORY, scripts: [NO_ID] }],
  ["the call has an id the inventory holds only on another URL, beside an entry with no id at the range's place", ["script_identity_differs"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...SCRIPT, url: "https://orchard-lane.example/other.html", resourceStart: { line: 41, column: 12 }, digest: "ef".repeat(32) }, NO_ID] }],
  ["the call has an id the inventory does not hold, and an entry with no id at the range's place does not stand in", ["not_in_inventory"], CALL, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID] }],
  ["neither has an id, and the entry at that place has one", "consistent", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }],
  ["an empty id on both sides is no id, and the rest of the identity stands in", "consistent", { ...CALL, script: { ...SCRIPT, scriptId: "" } }, { ...RANGE, script: { ...SCRIPT, scriptId: "" } }],
  // No id on one side or both: URL, resource start and digest stand in, on both sides.
  ["no id on the call, the rest agreeing", "consistent", { ...CALL, script: NO_ID }, RANGE],
  ["no id on the range, the rest agreeing", "consistent", CALL, { ...RANGE, script: NO_ID }],
  ["no ids, the rest agreeing", "consistent", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }],
  ["no ids and another URL", ["script_identity_differs"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, url: "https://orchard-lane.example/other.html" } }],
  ["no ids and another digest", ["script_identity_differs"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, digest: "ef".repeat(32) } }],
  ["no ids and another resource start", ["script_identity_differs"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, resourceStart: { line: 41, column: 12 } } }],
  ["no ids and another resource start column", ["script_identity_differs"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, resourceStart: { line: 40, column: 13 } } }],
  ["no ids and no URL", ["no_script_identity"], { ...CALL, script: { ...NO_ID, url: null } }, { ...RANGE, script: NO_ID }],
  ["no ids and an empty URL", ["no_script_identity"], { ...CALL, script: { ...NO_ID, url: "" } }, { ...RANGE, script: NO_ID }],
  ["no ids and no URL on the range", ["no_script_identity"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, url: null } }],
  ["no ids and no digest on the range", ["no_script_identity"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, digest: null } }],
  ["no ids and an empty digest on the range", ["no_script_identity"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, digest: "" } }],
  ["no ids and no resource start on the range", ["no_script_identity"], { ...CALL, script: NO_ID }, { ...RANGE, script: { ...NO_ID, resourceStart: null } }],
  ["no ids, no start on the call, and a URL seen once", ["no_script_identity", "coordinates_unknown"], { ...CALL, script: { ...NO_ID, resourceStart: null } }, { ...RANGE, script: NO_ID }],
  ["no ids, no digest, and a URL seen once", ["no_script_identity"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: NO_ID }],
  ["no ids, an empty digest, and a URL seen once", ["no_script_identity"], { ...CALL, script: { ...NO_ID, digest: "" } }, { ...RANGE, script: NO_ID }],
  ["no ids and nothing in the inventory", ["not_in_inventory"], { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [INVENTORY.scripts[1]] }],
  // A repeated URL.
  ["a URL twice, same start and digest", "ambiguous", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, NO_ID] }],
  ["a URL twice at one start, no digest on the call to tell them apart", "ambiguous", { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  ["the same, with the other entry's digest the one the range names", "ambiguous", { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, digest: "ef".repeat(32) } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  // What the range says decides whether it is a candidate at all. These are not, however the call's URL repeats.
  ["a URL twice, told apart by start, and the call's digest missing, is no identity and not ambiguous", ["no_script_identity"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["a URL twice, no digest on the call, and a range at another start", ["script_identity_differs"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, resourceStart: { line: 90, column: 0 } } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["a URL twice, no digest on the call, and a range whose digest the inventory does not hold", ["not_in_inventory"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, digest: "77".repeat(32) } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  ["a URL twice, no digest on the call, and a range with no digest", ["no_script_identity"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, digest: null } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  ["a URL twice, no digest on the call, and a range with no start", ["no_script_identity"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, resourceStart: null } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  ["a URL twice, no start on the call to convert from, is both", ["coordinates_unknown", "url_repeated"], { ...CALL, script: { ...NO_ID, resourceStart: null } }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["no start on the call, and a range the inventory does not hold", ["not_in_inventory", "coordinates_unknown"], { ...CALL, script: { ...NO_ID, resourceStart: null } }, { ...RANGE, script: { ...NO_ID, resourceStart: { line: 70, column: 0 } } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["a URL twice, no digest on the call, and a range that names no URL", ["no_script_identity"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, url: null } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  ["a URL twice, told apart by where each starts", "consistent", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["a URL twice, told apart by digest", "consistent", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "ef".repeat(32) }] }],
  ["a URL twice, the second with its start and digest unknown, could be the same script", "ambiguous", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: null, digest: null }] }],
  ["a URL twice, the second with its digest unknown and the same start", "ambiguous", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: null }] }],
  ["a URL twice, the second with its digest empty and the same start", "ambiguous", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, digest: "" }] }],
  ["a URL twice, the second with its start unknown and the same digest", "ambiguous", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: null }] }],
  ["a URL twice, the second with its start unknown and another digest, cannot be the same script", "consistent", { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: null, digest: "ef".repeat(32) }] }],
  ["the only entry at that URL has another digest", ["not_in_inventory"], { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...NO_ID, digest: "ef".repeat(32) }] }],
  ["the only entry at that URL starts elsewhere", ["not_in_inventory"], { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["only an entry with its start and digest unknown is not this script's entry", ["not_in_inventory"], { ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [{ ...NO_ID, resourceStart: null, digest: null }] }],
  ["a repeated call URL against a range on another URL is another script", ["script_identity_differs"], { ...CALL, script: { ...NO_ID, digest: null } }, { ...RANGE, script: { ...NO_ID, url: "https://orchard-lane.example/other.html" } }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["a repeated range URL against a call on another URL is another script", ["script_identity_differs"], { ...CALL, script: { ...NO_ID, digest: null, url: "https://orchard-lane.example/other.html" } }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, { ...NO_ID, resourceStart: { line: 90, column: 0 } }] }],
  ["a URL twice, and another fault", ["target_not_same", "url_repeated"], { ...CALL, script: NO_ID }, { ...RANGE, target: "target-t2", script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, NO_ID] }],
  // Coordinates.
  ["no resource start to convert from", ["coordinates_unknown"], { ...CALL, script: { ...SCRIPT, resourceStart: null } }, RANGE],
  ["a negative range column, a refused shape and not a position", ["coordinates_invalid"], CALL, { ...RANGE, start: { line: 2, column: -7071 } }],
  ["a negative range line", ["coordinates_invalid"], CALL, { ...RANGE, start: { line: -1, column: 3 } }],
  ["a negative range end", ["coordinates_invalid"], CALL, { ...RANGE, end: { line: 5, column: -1 } }],
  ["a fractional range line", ["coordinates_invalid"], CALL, { ...RANGE, end: { line: 5.5, column: 7 } }],
  ["a fractional range column", ["coordinates_invalid"], CALL, { ...RANGE, start: { line: 2, column: 3.5 } }],
  ["an infinite range end", ["coordinates_invalid"], CALL, { ...RANGE, end: { line: Number.POSITIVE_INFINITY, column: 0 } }],
  ["a range line that is not a number", ["coordinates_invalid"], CALL, { ...RANGE, end: { line: Number.NaN, column: 7 } }],
  ["a range that ends where it starts", ["coordinates_invalid"], CALL, { ...RANGE, end: RANGE.start }],
  ["a range that ends before it starts", ["coordinates_invalid"], CALL, { ...RANGE, start: { line: 5, column: 7 }, end: { line: 2, column: 3 } }],
  ["a stack line of 0", ["coordinates_invalid"], { ...CALL, line: 0 }, RANGE],
  ["a stack column of 0", ["coordinates_invalid"], { ...CALL, column: 0 }, RANGE],
  ["a fractional stack line", ["coordinates_invalid"], { ...CALL, line: 43.5 }, RANGE],
  ["a fractional stack column", ["coordinates_invalid"], { ...CALL, column: 9.5 }, RANGE],
  ["a resource start that cannot be", ["coordinates_invalid"], { ...CALL, script: { ...SCRIPT, resourceStart: { line: -1, column: 0 } } }, { ...RANGE, script: { ...SCRIPT, resourceStart: null } }, HAS_ID_ONLY],
  ["a position before the script's first line", ["position_outside_range"], { ...CALL, line: 40 }, RANGE],
  ["a position before the script's first column", ["position_outside_range"], { ...CALL, line: 41, column: 5 }, RANGE],
  ["a position past the range", ["position_outside_range"], { ...CALL, line: 50 }, RANGE],
  // Time.
  ["before the window", ["time_outside_window"], { ...CALL, time: { clock: "page", ms: 999 } }, RANGE],
  ["after the window", ["time_outside_window"], { ...CALL, time: { clock: "page", ms: 2001 } }, RANGE],
  ["at the window's start", "consistent", { ...CALL, time: { clock: "page", ms: 1000 } }, RANGE],
  ["at the window's end", "consistent", { ...CALL, time: { clock: "page", ms: 2000 } }, RANGE],
  ["no time", ["time_unknown"], { ...CALL, time: { clock: "page", ms: null } }, RANGE],
  ["no clock on the call", ["time_unknown"], { ...CALL, time: { clock: null, ms: 1500 } }, RANGE],
  ["an empty clock on the call", ["time_unknown"], { ...CALL, time: { clock: "", ms: 1500 } }, RANGE],
  ["no clock on the window", ["time_unknown"], CALL, { ...RANGE, window: { ...RANGE.window, clock: null } }],
  ["an empty clock on both", ["time_unknown"], { ...CALL, time: { clock: "", ms: 1500 } }, { ...RANGE, window: { ...RANGE.window, clock: "" } }],
  ["a time that is not a number", ["time_invalid"], { ...CALL, time: { clock: "page", ms: Number.NaN } }, RANGE],
  ["an infinite time, with an infinite window", ["time_invalid"], { ...CALL, time: { clock: "page", ms: Number.POSITIVE_INFINITY } }, { ...RANGE, window: { ...RANGE.window, endMs: Number.POSITIVE_INFINITY } }],
  ["a negative time", ["time_invalid"], { ...CALL, time: { clock: "page", ms: -1 } }, RANGE],
  ["a time past the bound", ["time_invalid"], { ...CALL, time: { clock: "page", ms: MAX_TIME_MS + 1 } }, { ...RANGE, window: { ...RANGE.window, endMs: MAX_TIME_MS } }],
  ["a time at the bound", "consistent", { ...CALL, time: { clock: "page", ms: MAX_TIME_MS } }, { ...RANGE, window: { ...RANGE.window, endMs: MAX_TIME_MS } }],
  ["a window start past the bound", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, startMs: MAX_TIME_MS + 1, endMs: MAX_TIME_MS + 2 } }],
  ["an infinite window end, whatever the call says", ["time_invalid"], { ...CALL, time: { clock: null, ms: null } }, { ...RANGE, window: { ...RANGE.window, endMs: Number.POSITIVE_INFINITY } }],
  ["a negative window start", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, startMs: -5 } }],
  ["a window that is not a number", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, startMs: Number.NaN } }],
  ["an inverted window, on one clock", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, startMs: 2000, endMs: 1000 } }],
  ["an inverted window, with slack that would bridge it", ["time_invalid"], { ...CALL, time: { clock: "harness", ms: 1500 } }, { ...RANGE, window: { clock: "page", startMs: 2000, endMs: 1000, uncertaintyMs: 600 } }],
  ["a window of no width, with the time on it", "consistent", { ...CALL, time: { clock: "page", ms: 1500 } }, { ...RANGE, window: { ...RANGE.window, startMs: 1500, endMs: 1500 } }],
  ["another clock, nothing declared", ["clock_not_shared"], { ...CALL, time: { clock: "harness", ms: 1500 } }, RANGE],
  ["another clock, inside the declared uncertainty", "consistent", { ...CALL, time: { clock: "harness", ms: 2040 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 50 } }],
  ["another clock, at the declared uncertainty", "consistent", { ...CALL, time: { clock: "harness", ms: 950 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 50 } }],
  ["another clock, past the declared uncertainty", ["time_outside_window"], { ...CALL, time: { clock: "harness", ms: 2051 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 50 } }],
  ["another clock, before the declared uncertainty", ["time_outside_window"], { ...CALL, time: { clock: "harness", ms: 949 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 50 } }],
  // Spelled, not read off the constant: a minute, and a millisecond past it.
  ["an uncertainty at its bound", "consistent", { ...CALL, time: { clock: "harness", ms: 62_000 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 60_000 } }],
  ["an uncertainty past its bound", ["time_invalid"], { ...CALL, time: { clock: "harness", ms: 1500 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 60_001 } }],
  ["an uncertainty past its bound, on one clock too", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 60_001 } }],
  ["an uncertainty that is not a number, on one clock too", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: Number.NaN } }],
  ["an infinite uncertainty, on one clock too", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: Number.POSITIVE_INFINITY } }],
  ["a negative uncertainty, on one clock too", ["time_invalid"], CALL, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: -10 } }],
  ["an infinite uncertainty", ["time_invalid"], { ...CALL, time: { clock: "harness", ms: 1e12 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: Number.POSITIVE_INFINITY } }],
  ["a negative uncertainty", ["time_invalid"], { ...CALL, time: { clock: "harness", ms: 1500 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: -10 } }],
  ["an uncertainty that is not a number", ["time_invalid"], { ...CALL, time: { clock: "harness", ms: 1500 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: Number.NaN } }],
  ["one clock, where a declared uncertainty does not widen anything", ["time_outside_window"], { ...CALL, time: { clock: "page", ms: 2040 } }, { ...RANGE, window: { ...RANGE.window, uncertaintyMs: 50 } }]
];

const JOIN = "a join reads as the table of its conditions says";

/** The one-sided id's block of identityFinding, as the compiled module spells it, so a variant can move it whole. */
const ONE_SIDED_BLOCK = [
  "    const oneId = callId !== null && callId !== void 0 ? callId : rangeId;",
  "    if (oneId !== null) {",
  "        const byId = inventory.filter(({ scriptId }) => scriptId === oneId);",
  "        if (byId.length === 0)",
  '            return "not_in_inventory";',
  "        // An entry that places the id at the range agrees with it, so with none placed, either every entry puts it elsewhere or some says too little.",
  "        if (!byId.some((entry) => isPlacedAt(entry, range)))",
  '            return byId.every((entry) => disagree(entry, range)) ? "script_identity_differs" : "not_in_inventory";',
  "    }",
  ""
].join("\n");

const checkFaults = (module: ReadingsModule) => {
  for (const [name, expected, call, range, inventory] of FAULTS) {
    const reading = module.readExecutionJoin(call, range, inventory ?? INVENTORY);
    const want = expected === "consistent" ? { reading: "position_consistent" } : expected === "ambiguous" ? { reading: "ambiguous", reason: "url_repeated" } : { reading: "no_join", reasons: expected };
    holds(JOIN, JSON.stringify(reading) === JSON.stringify(want), () => ({ name, reading, want }));
  }
};

const FAULT_COUNT = 157;

test("each condition of a join, alone, gives no join with that reason, and the boundaries fall where stated", () => {
  checkFaults(production);
  assert.equal(FAULTS.length, FAULT_COUNT);
});

/** Each condition broken independently, so all subsets of them can be walked. */
const BREAKS: readonly (readonly [JoinReason, (range: ReportedRange) => ReportedRange])[] = [
  ["attempt_not_same", (range) => ({ ...range, attempt: OTHER_ATTEMPT })],
  ["target_not_same", (range) => ({ ...range, target: "target-t2" })],
  ["frame_not_same", (range) => ({ ...range, frame: "frame-f2" })],
  ["loader_not_same", (range) => ({ ...range, loader: "loader-l2" })],
  ["script_id_differs", (range) => ({ ...range, script: { ...range.script, scriptId: "script-99" } })],
  ["position_outside_range", (range) => ({ ...range, start: { line: 30, column: 0 }, end: { line: 31, column: 0 } })],
  ["time_outside_window", (range) => ({ ...range, window: { ...range.window, startMs: 5000, endMs: 6000 } })]
];

const ALL_CONDITIONS = "only a join with every condition met links anything, and every failure is named";

const checkSubsets = (module: ReadingsModule) => {
  let links = 0;
  for (let mask = 0; mask < 2 ** BREAKS.length; mask += 1) {
    const chosen = BREAKS.filter((_, index) => mask & (1 << index));
    const range = chosen.reduce((current, [, broken]) => broken(current), RANGE);
    const reading = module.readExecutionJoin(CALL, range, INVENTORY);
    if (chosen.length === 0) {
      holds(ALL_CONDITIONS, reading.reading === "position_consistent", () => reading);
      links += 1;
    } else {
      const expected = chosen.map(([reason]) => reason);
      holds(ALL_CONDITIONS, reading.reading === "no_join" && JSON.stringify(reading.reasons) === JSON.stringify(expected), () => ({ reading, expected }));
    }
  }
  holds(ALL_CONDITIONS, links === 1, () => links);
};

test("every subset of broken conditions names exactly those conditions, and equal attempt ids alone never link", () => {
  checkSubsets(production);
  const everythingElseBroken = BREAKS.slice(1).reduce((current, [, broken]) => broken(current), RANGE);
  assert.equal(everythingElseBroken.attempt, CALL.attempt);
  assert.equal(readExecutionJoin(CALL, everythingElseBroken, INVENTORY).reading, "no_join");
});

/**
 * Stack coordinates against a range, on a grid, read through a plain ordering of positions. The
 * arithmetic below RESTATES the conversion on purpose, as a second writing kept apart from the
 * module's: it shows the two agree on every point of the grid, not that the convention is right.
 * The test that reads positions off real text, further down, is the one that says more.
 */
const POSITION = "a position falls in a range only after the stated conversion, with an exclusive end";

const GRID_RANGES: readonly (readonly [Position, Position])[] = [
  [{ line: 0, column: 4 }, { line: 0, column: 9 }],
  [{ line: 0, column: 0 }, { line: 3, column: 0 }],
  [{ line: 1, column: 6 }, { line: 3, column: 2 }],
  [{ line: 2, column: 0 }, { line: 2, column: 1 }]
];
const GRID_STARTS: readonly Position[] = [{ line: 0, column: 0 }, { line: 7, column: 5 }, { line: 3, column: 11 }];

const GRID_INSIDE = 250;
const GRID_OUTSIDE = 1750;

const checkGrid = (module: ReadingsModule) => {
  let inside = 0;
  let outside = 0;
  for (const resourceStart of GRID_STARTS) {
    for (const [start, end] of GRID_RANGES) {
      for (let line = 1; line <= resourceStart.line + 6; line += 1) {
        for (let column = 1; column <= resourceStart.column + 12; column += 1) {
          const zeroLine = line - 1;
          const zeroColumn = column - 1;
          const scriptLine = zeroLine - resourceStart.line;
          const scriptColumn = scriptLine === 0 ? zeroColumn - resourceStart.column : zeroColumn;
          const order = (position: Position) => position.line * 1000 + position.column;
          const value = scriptLine * 1000 + scriptColumn;
          const expected = scriptLine >= 0 && scriptColumn >= 0 && value >= order(start) && value < order(end);
          const script = { ...SCRIPT, resourceStart };
          const reading = module.readExecutionJoin({ ...CALL, script, line, column }, { ...RANGE, script, start, end }, { ...INVENTORY, scripts: [script] });
          const consistent = reading.reading === "position_consistent";
          holds(POSITION, consistent === expected, () => ({ resourceStart, start, end, line, column, reading }));
          if (!consistent) holds(POSITION, reading.reading === "no_join" && JSON.stringify(reading.reasons) === '["position_outside_range"]', () => reading);
          if (expected) inside += 1;
          else outside += 1;
        }
      }
    }
  }
  holds(POSITION, inside === GRID_INSIDE && outside === GRID_OUTSIDE, () => ({ inside, outside }));
};

test("positions on a grid fall in or out of a range as a plain ordering says, on the first line of an inline script and after it", () => {
  checkGrid(production);
});

test("positions read off a real document's text, not off arithmetic: every range of an inline script, against offsets", () => {
  const document = ["<html>", "<body>  <script>var a = 1;", "var b = 2;", "  var c = 3;</script>", "</body>"].join("\n");
  const scriptStart = document.indexOf("var a");
  const scriptEnd = document.indexOf("</script>");
  const script = document.slice(scriptStart, scriptEnd);
  const lineAndColumn = (text: string, offset: number): Position => {
    const lines = text.slice(0, offset).split("\n");
    return { line: lines.length - 1, column: lines[lines.length - 1].length };
  };
  const resourceStart = lineAndColumn(document, scriptStart);
  const identity = { ...SCRIPT, resourceStart };
  let tried = 0;
  let inside = 0;
  for (let start = 0; start < script.length; start += 1) {
    for (let end = start + 1; end <= script.length; end += 1) {
      for (let offset = 0; offset < script.length; offset += 1) {
        const position = lineAndColumn(document, scriptStart + offset);
        const reading = readExecutionJoin(
          { ...CALL, script: identity, line: position.line + 1, column: position.column + 1 },
          { ...RANGE, script: identity, start: lineAndColumn(script, start), end: lineAndColumn(script, end) },
          { attempt: ATTEMPT, scripts: [identity] }
        );
        const expected = offset >= start && offset < end;
        assert.equal(reading.reading === "position_consistent", expected, JSON.stringify({ start, end, offset, reading }));
        tried += 1;
        if (expected) inside += 1;
      }
    }
  }
  assert.deepEqual([tried, inside], [REAL_TEXT_TRIED, REAL_TEXT_INSIDE]);
  // Before the script, a position converts to nothing.
  for (let offset = 0; offset < scriptStart; offset += 1) {
    const position = lineAndColumn(document, offset);
    assert.equal(stackToScriptPosition(position.line + 1, position.column + 1, resourceStart), null, String(offset));
  }
});

const REAL_TEXT_TRIED = 20230;
const REAL_TEXT_INSIDE = 7140;

test("the boundaries of a range, spelled out, on an inline script's first line", () => {
  const script = { ...SCRIPT, resourceStart: { line: 40, column: 12 } };
  const range = { ...RANGE, script, start: { line: 0, column: 4 }, end: { line: 0, column: 9 } };
  const at = (column: number) => readExecutionJoin({ ...CALL, script, line: 41, column }, range, INVENTORY).reading;
  // Resource line 40 is the script's first line, so stack column C is script column C - 1 - 12.
  assert.equal(at(16), "no_join", "script column 3, one before the start");
  assert.equal(at(17), "position_consistent", "script column 4, the start");
  assert.equal(at(21), "position_consistent", "script column 8, the last inside");
  assert.equal(at(22), "no_join", "script column 9, the exclusive end");
});

const CONVERSION = "a stack position converts to the script's coordinates as written out here, or to nothing before the script";

const checkConversion = (module: ReadingsModule) => {
  const table: readonly (readonly [number, number, Position, Position | null])[] = [
    // External script, starting at the origin.
    [1, 1, { line: 0, column: 0 }, { line: 0, column: 0 }],
    [3, 8, { line: 0, column: 0 }, { line: 2, column: 7 }],
    // Inline, on its first line: the column shifts.
    [41, 13, { line: 40, column: 12 }, { line: 0, column: 0 }],
    [41, 20, { line: 40, column: 12 }, { line: 0, column: 7 }],
    // Inline, past its first line: the column does not.
    [42, 1, { line: 40, column: 12 }, { line: 1, column: 0 }],
    [43, 9, { line: 40, column: 12 }, { line: 2, column: 8 }],
    // Before the script: above its first line, and left of its first column.
    [40, 9, { line: 40, column: 12 }, null],
    [41, 12, { line: 40, column: 12 }, null]
  ];
  for (const [line, column, resourceStart, expected] of table) {
    const answer = module.stackToScriptPosition(line, column, resourceStart);
    holds(CONVERSION, JSON.stringify(answer) === JSON.stringify(expected), () => ({ line, column, resourceStart, answer, expected }));
  }
};

test("the conversion, spelled out", async () => {
  checkConversion(production);
  await assertCaughtBy("a position before the script let through", CONVERSION, () => checkConversion(variant({ find: "return scriptLine < 0 || scriptColumn < 0 ? null : { line: scriptLine, column: scriptColumn };", replace: "return { line: scriptLine, column: scriptColumn };" })));
  await assertCaughtBy("only the line checked", CONVERSION, () => checkConversion(variant({ find: "scriptLine < 0 || scriptColumn < 0 ?", replace: "scriptLine < 0 ?" })));
  await assertCaughtBy("only the column checked", CONVERSION, () => checkConversion(variant({ find: "scriptLine < 0 || scriptColumn < 0 ?", replace: "scriptColumn < 0 ?" })));
});

const CAUSED = "a met join reads position_consistent, and ambiguous reads ambiguous";

const checkWording = (module: ReadingsModule) => {
  const met = module.readExecutionJoin(CALL, RANGE, INVENTORY);
  holds(CAUSED, JSON.stringify(met) === '{"reading":"position_consistent"}', () => met);
  const repeated = module.readExecutionJoin({ ...CALL, script: NO_ID }, { ...RANGE, script: NO_ID }, { ...INVENTORY, scripts: [NO_ID, NO_ID] });
  holds(CAUSED, JSON.stringify(repeated) === '{"reading":"ambiguous","reason":"url_repeated"}', () => repeated);
};

test("the only words a join can say", () => {
  checkWording(production);
});

const REMOVE_ATTEMPT = { find: 'if (!isSameKnown(call.attempt, range.attempt))\n        reasons.push("attempt_not_same");', replace: "" };

for (const [name, property, check, edits] of [
  ["a cross-attempt link", ALL_CONDITIONS, checkSubsets, [REMOVE_ATTEMPT]],
  ["the target left unchecked", ALL_CONDITIONS, checkSubsets, [{ find: 'if (!isSameKnown(call.target, range.target))\n        reasons.push("target_not_same");', replace: "" }]],
  ["the frame left unchecked", ALL_CONDITIONS, checkSubsets, [{ find: 'if (!isSameKnown(call.frame, range.frame))\n        reasons.push("frame_not_same");', replace: "" }]],
  ["a replaced document", ALL_CONDITIONS, checkSubsets, [{ find: 'if (!isSameKnown(call.loader, range.loader))\n        reasons.push("loader_not_same");', replace: "" }]],
  ["another script id let through", ALL_CONDITIONS, checkSubsets, [{ find: 'if (callId !== rangeId)\n            return "script_id_differs";', replace: "" }]],
  ["a position outside the range let through", ALL_CONDITIONS, checkSubsets, [{ find: 'return compare(position, range.start) >= 0 && compare(position, range.end) < 0 ? [] : ["position_outside_range"];', replace: "return [];" }]],
  ["a time outside the window let through", ALL_CONDITIONS, checkSubsets, [{ find: 'return ms >= window.startMs - slack && ms <= window.endMs + slack ? [] : ["time_outside_window"];', replace: "return [];" }]],
  ["only the first reason named", ALL_CONDITIONS, checkSubsets, [{ find: 'return { reading: "no_join", reasons: identity === "repeated"', replace: 'return { reading: "no_join", reasons: [reasons[0]], ignored: identity === "repeated"' }]],
  ["two unknowns taken as the same", JOIN, checkFaults, [{ find: "return known(left) !== null && left === right;", replace: "return left === right;" }]],
  ["an empty string taken as known", JOIN, checkFaults, [{ find: 'return value === "" ? null : value;', replace: "return value;" }]],
  ["the inventory of another session", JOIN, checkFaults, [{ find: 'if (!isSameKnown(call.attempt, inventory.attempt))\n        reasons.push("inventory_of_another_session");', replace: "" }]],
  ["a repeated URL read as a join", JOIN, checkFaults, [{ find: 'if (fitting.length > 1)\n        return "repeated";', replace: "" }]],
  ["an id held twice read as a join", JOIN, checkFaults, [{ find: 'return agreeing.length === 1 ? "same" : "repeated";', replace: 'return "same";' }]],
  ["an id held twice with no candidate read as ambiguous", JOIN, checkFaults, [{ find: 'if (agreeing.length === 0)\n            return "script_identity_differs";', replace: "" }]],
  ["an id held twice read as ambiguous before its entries are", JOIN, checkFaults, [{ find: 'if (agreeing.length === 0)\n            return "script_identity_differs";', replace: 'if (byId.length > 1)\n            return "repeated";\n        if (agreeing.length === 0)\n            return "script_identity_differs";' }]],
  ["an id the inventory does not hold taken as one", JOIN, checkFaults, [{ find: 'scriptId === callId);\n        if (byId.length === 0)\n            return "not_in_inventory";', replace: 'scriptId === callId);\n        if (byId.length === 0)\n            return "same";' }]],
  ["call and range disagreeing on an id let through", JOIN, checkFaults, [{ find: 'if (disagree(call, range))\n            return "script_identity_differs";', replace: "" }]],
  ["an id's inventory entry not read at all", JOIN, checkFaults, [{ find: "const agreeing = byId.filter((entry) => !disagree(entry, call) && !disagree(entry, range));", replace: "const agreeing = byId;" }]],
  ["an id's inventory entry read against the call alone", JOIN, checkFaults, [{ find: "!disagree(entry, call) && !disagree(entry, range)", replace: "!disagree(entry, call)" }]],
  ["an id's inventory entry read against the range alone", JOIN, checkFaults, [{ find: "!disagree(entry, call) && !disagree(entry, range)", replace: "!disagree(entry, range)" }]],
  ["two accounts' ids not compared", JOIN, checkFaults, [{ find: "return differs(a.scriptId, b.scriptId) || ", replace: "return " }]],
  ["two accounts' URLs not compared", JOIN, checkFaults, [{ find: " || differs(a.url, b.url) || ", replace: " || " }]],
  ["two accounts' digests not compared", JOIN, checkFaults, [{ find: " || differs(a.digest, b.digest) || ", replace: " || " }]],
  ["two accounts' starts not compared", JOIN, checkFaults, [{ find: " || (a.resourceStart !== null && b.resourceStart !== null && !isSamePosition(a.resourceStart, b.resourceStart))", replace: "" }]],
  ["an unknown start read as a different one", JOIN, checkFaults, [{ find: "(a.resourceStart !== null && b.resourceStart !== null && !isSamePosition(a.resourceStart, b.resourceStart))", replace: "!isSamePosition(a.resourceStart, b.resourceStart)" }]],
  ["an entry with nothing known not counted as a repeat", JOIN, checkFaults, [{ find: "const fitting = sameUrl.filter((entry) => !disagree(entry, call) || !disagree(entry, range));", replace: "const fitting = sameUrl.filter((entry) => isSamePosition(entry.resourceStart, call.resourceStart) && entry.digest === call.digest);" }]],
  ["a repeated URL ambiguous against any range", JOIN, checkFaults, [{ find: 'if (disagree(call, range))\n        return "script_identity_differs";', replace: "" }]],
  ["a URL seen once standing in for an identity", JOIN, checkFaults, [{ find: 'return call.resourceStart === null || known(call.digest) === null ? "no_script_identity" : "same";', replace: 'return "same";' }]],
  ["a call's missing start not noticed", JOIN, checkFaults, [{ find: 'return call.resourceStart === null || known(call.digest) === null ? "no_script_identity" : "same";', replace: 'return known(call.digest) === null ? "no_script_identity" : "same";' }]],
  ["an entry fitting only the range not counted", JOIN, checkFaults, [{ find: "!disagree(entry, call) || !disagree(entry, range)", replace: "!disagree(entry, call)" }]],
  ["an entry fitting only the call not counted", JOIN, checkFaults, [{ find: "!disagree(entry, call) || !disagree(entry, range)", replace: "!disagree(entry, range)" }]],
  ["only the call's id read against the inventory", JOIN, checkFaults, [{ find: "const oneId = callId !== null && callId !== void 0 ? callId : rangeId;", replace: "const oneId = callId;" }]],
  ["only the range's id read against the inventory", JOIN, checkFaults, [{ find: "const oneId = callId !== null && callId !== void 0 ? callId : rangeId;", replace: "const oneId = rangeId;" }]],
  ["a one-sided id's entry read against the call instead of the range", JOIN, checkFaults, [{ find: "byId.every((entry) => disagree(entry, range))", replace: "byId.every((entry) => disagree(entry, call))" }]],
  ["a one-sided id's entries not placed, as before", JOIN, checkFaults, [{ find: 'if (!byId.some((entry) => isPlacedAt(entry, range)))\n            return byId.every((entry) => disagree(entry, range)) ? "script_identity_differs" : "not_in_inventory";', replace: 'if (byId.every((entry) => disagree(entry, range)))\n            return "script_identity_differs";' }]],
  ["a one-sided id not read against the inventory at all", JOIN, checkFaults, [{ find: 'if (byId.length === 0)\n            return "not_in_inventory";\n        // An entry that places', replace: "// An entry that places" }, { find: 'if (!byId.some((entry) => isPlacedAt(entry, range)))\n            return byId.every((entry) => disagree(entry, range)) ? "script_identity_differs" : "not_in_inventory";', replace: "" }]],
  ["a one-sided id the inventory does not hold let an entry with no id stand in", JOIN, checkFaults, [{ find: 'if (byId.length === 0)\n            return "not_in_inventory";\n        // An entry that places', replace: "// An entry that places" }, { find: "if (!byId.some((entry) => isPlacedAt(entry, range)))", replace: "if (byId.length > 0 && !byId.some((entry) => isPlacedAt(entry, range)))" }]],
  ["unplaced entries read as differing when one does", JOIN, checkFaults, [{ find: "byId.every((entry) => disagree(entry, range))", replace: "byId.some((entry) => disagree(entry, range))" }]],
  ["unplaced entries all read as differing", JOIN, checkFaults, [{ find: 'return byId.every((entry) => disagree(entry, range)) ? "script_identity_differs" : "not_in_inventory";', replace: 'return "script_identity_differs";' }]],
  ["unplaced entries all read as not held", JOIN, checkFaults, [{ find: 'return byId.every((entry) => disagree(entry, range)) ? "script_identity_differs" : "not_in_inventory";', replace: 'return "not_in_inventory";' }]],
  ["a placed entry's URL not read", JOIN, checkFaults, [{ find: "return entry.url === range.url && isSamePosition(", replace: "return isSamePosition(" }]],
  ["a placed entry's start not read", JOIN, checkFaults, [{ find: "entry.url === range.url && isSamePosition(entry.resourceStart, range.resourceStart) && ", replace: "entry.url === range.url && " }]],
  ["a placed entry's digest not read", JOIN, checkFaults, [{ find: "(known(entry.digest) === null || entry.digest === range.digest)", replace: "true" }]],
  ["a placed entry's digest required", JOIN, checkFaults, [{ find: "(known(entry.digest) === null || entry.digest === range.digest)", replace: "entry.digest === range.digest" }]],
  ["a one-sided id read once the range's place is found", JOIN, checkFaults, [{ find: ONE_SIDED_BLOCK, replace: "" }, { find: 'if (ofRange.length === 0)\n        return "not_in_inventory";\n', replace: 'if (ofRange.length === 0)\n        return "not_in_inventory";\n' + ONE_SIDED_BLOCK }]],
  ["a one-sided id read ahead of the call and the range disagreeing", JOIN, checkFaults, [{ find: ONE_SIDED_BLOCK, replace: "" }, { find: 'if (disagree(call, range))\n        return "script_identity_differs";\n    // The range names', replace: ONE_SIDED_BLOCK + '    if (disagree(call, range))\n        return "script_identity_differs";\n    // The range names' }]],
  ["a one-sided id read ahead of the range naming its identity", JOIN, checkFaults, [{ find: ONE_SIDED_BLOCK, replace: "" }, { find: "    if (known(range.url) === null || range.resourceStart === null || known(range.digest) === null)\n", replace: ONE_SIDED_BLOCK + "    if (known(range.url) === null || range.resourceStart === null || known(range.digest) === null)\n" }]],
  ["a one-sided id's entries on another URL ignored", JOIN, checkFaults, [{ find: "const byId = inventory.filter(({ scriptId }) => scriptId === oneId);", replace: "const byId = inventory.filter((entry) => entry.scriptId === oneId && (entry.url === url || known(entry.url) === null));" }]],
  ["a place holding only another's id let through", JOIN, checkFaults, [{ find: 'if (ofRange.every((entry) => disagree(entry, call) || disagree(entry, range)))\n        return "script_identity_differs";', replace: "" }]],
  ["a place read against the call alone", JOIN, checkFaults, [{ find: "ofRange.every((entry) => disagree(entry, call) || disagree(entry, range))", replace: "ofRange.every((entry) => disagree(entry, call))" }]],
  ["a place read against the range alone", JOIN, checkFaults, [{ find: "ofRange.every((entry) => disagree(entry, call) || disagree(entry, range))", replace: "ofRange.every((entry) => disagree(entry, range))" }]],
  ["a call's missing digest not noticed", JOIN, checkFaults, [{ find: 'return call.resourceStart === null || known(call.digest) === null ? "no_script_identity" : "same";', replace: 'return call.resourceStart === null ? "no_script_identity" : "same";' }]],
  ["a range with no identity let on to the inventory, as the URL path once did", JOIN, checkFaults, [{ find: 'if (known(range.url) === null || range.resourceStart === null || known(range.digest) === null)\n        return "no_script_identity";\n    if (disagree(call, range))\n        return "script_identity_differs";', replace: 'if (disagree(call, range))\n        return "script_identity_differs";' }]],
  ["a repeated URL ambiguous even when its start tells it apart", JOIN, checkFaults, [{ find: "const fitting = sameUrl.filter((entry) => !disagree(entry, call) || !disagree(entry, range));", replace: "const fitting = sameUrl;" }]],
  ["a resource start's column ignored in the comparison", JOIN, checkFaults, [{ find: "return a !== null && b !== null && compare(a, b) === 0;", replace: "return a !== null && b !== null && a.line === b.line;" }]],
  ["an inventory entry taken for the range on its start alone", JOIN, checkFaults, [{ find: "isSamePosition(entry.resourceStart, range.resourceStart) && entry.digest === range.digest", replace: "isSamePosition(entry.resourceStart, range.resourceStart)" }]],
  ["an inventory entry taken for the range on its digest alone", JOIN, checkFaults, [{ find: "isSamePosition(entry.resourceStart, range.resourceStart) && entry.digest === range.digest", replace: "entry.digest === range.digest" }]],
  ["nothing in the inventory taken as unique", JOIN, checkFaults, [{ find: 'if (ofRange.length === 0)\n        return "not_in_inventory";', replace: "" }]],
  ["no resource start assumed to be the origin", JOIN, checkFaults, [{ find: 'if (resourceStart === null)\n        return ["coordinates_unknown"];', replace: 'if (resourceStart === null)\n        return [];' }]],
  ["a negative column let through", JOIN, checkFaults, [{ find: "Number.isSafeInteger(value.column) && value.column >= 0;", replace: "Number.isSafeInteger(value.column);" }]],
  ["a negative line let through", JOIN, checkFaults, [{ find: "Number.isSafeInteger(value.line) && value.line >= 0 && ", replace: "Number.isSafeInteger(value.line) && " }]],
  ["a zero-width range let through", JOIN, checkFaults, [{ find: "compare(range.start, range.end) >= 0", replace: "compare(range.start, range.end) > 0" }]],
  ["a stack position of 0 let through", JOIN, checkFaults, [{ find: "call.line >= 1 && Number.isSafeInteger(call.column) && call.column >= 1;", replace: "call.line >= 0 && Number.isSafeInteger(call.column) && call.column >= 0;" }]],
  ["a fractional stack position let through", JOIN, checkFaults, [{ find: "const stackOk = Number.isSafeInteger(call.line) && call.line >= 1 && Number.isSafeInteger(call.column) && call.column >= 1;", replace: "const stackOk = call.line >= 1 && call.column >= 1;" }]],
  ["no clock taken as sharing one", JOIN, checkFaults, [{ find: 'if (known(clock) === null || known(window.clock) === null || ms === null)\n        return ["time_unknown"];', replace: 'if (ms === null)\n        return ["time_unknown"];' }]],
  ["an inverted window let through", JOIN, checkFaults, [{ find: " || window.startMs > window.endMs", replace: "" }]],
  ["a bad window let through", JOIN, checkFaults, [{ find: 'if (!isTime(window.startMs) || !isTime(window.endMs) || window.startMs > window.endMs)\n        return ["time_invalid"];', replace: "" }]],
  ["a bad uncertainty let through", JOIN, checkFaults, [{ find: 'if (window.uncertaintyMs !== null && (!isTime(window.uncertaintyMs) || window.uncertaintyMs > exports.MAX_UNCERTAINTY_MS))\n        return ["time_invalid"];', replace: "" }]],
  ["no bound on an uncertainty", JOIN, checkFaults, [{ find: " || window.uncertaintyMs > exports.MAX_UNCERTAINTY_MS", replace: "" }]],
  ["a bad time let through", JOIN, checkFaults, [{ find: 'if (!isTime(ms))\n        return ["time_invalid"];', replace: "" }]],
  ["no bound on a time", JOIN, checkFaults, [{ find: "value >= 0 && value <= exports.MAX_TIME_MS;", replace: "value >= 0;" }]],
  ["a negative time let through", JOIN, checkFaults, [{ find: "value >= 0 && value <= exports.MAX_TIME_MS;", replace: "value <= exports.MAX_TIME_MS;" }]],
  ["a range's bounds let through as any number", JOIN, checkFaults, [{ find: "Number.isSafeInteger(value.line) && value.line >= 0 && Number.isSafeInteger(value.column) && value.column >= 0;", replace: "value.line >= 0 && value.column >= 0;" }]],
  ["no time taken as inside", JOIN, checkFaults, [{ find: 'if (known(clock) === null || known(window.clock) === null || ms === null)\n        return ["time_unknown"];', replace: 'if (known(clock) === null || known(window.clock) === null)\n        return ["time_unknown"];' }]],
  ["another clock with nothing declared", JOIN, checkFaults, [{ find: 'if (window.uncertaintyMs === null)\n            return ["clock_not_shared"];', replace: "" }]],
  ["a declared uncertainty widening one clock's window", JOIN, checkFaults, [{ find: "let slack = 0;", replace: "let slack = window.uncertaintyMs === null ? 0 : window.uncertaintyMs;" }]],
  ["the window's lower bound dropped", JOIN, checkFaults, [{ find: "ms >= window.startMs - slack && ", replace: "" }]],
  ["the window's upper bound dropped", JOIN, checkFaults, [{ find: " && ms <= window.endMs + slack", replace: "" }]],
  ["an exclusive window start", JOIN, checkFaults, [{ find: "ms >= window.startMs - slack", replace: "ms > window.startMs - slack" }]],
  ["an exclusive window end", JOIN, checkFaults, [{ find: "ms <= window.endMs + slack", replace: "ms < window.endMs + slack" }]],
  ["off-by-one columns on a later line", POSITION, checkGrid, [{ find: "column - 1 - resourceStart.column : column - 1;", replace: "column - 1 - resourceStart.column : column;" }]],
  ["off-by-one columns on the first line", POSITION, checkGrid, [{ find: "column - 1 - resourceStart.column : column - 1;", replace: "column - resourceStart.column : column - 1;" }]],
  ["off-by-one lines", POSITION, checkGrid, [{ find: "const scriptLine = line - 1 - resourceStart.line;", replace: "const scriptLine = line - resourceStart.line;" }]],
  ["the inline start ignored on lines", POSITION, checkGrid, [{ find: "const scriptLine = line - 1 - resourceStart.line;", replace: "const scriptLine = line - 1;" }]],
  ["the inline start ignored on columns", POSITION, checkGrid, [{ find: "column - 1 - resourceStart.column : column - 1;", replace: "column - 1 : column - 1;" }]],
  ["the inline start shifting every line", POSITION, checkGrid, [{ find: "scriptLine === 0 ? column - 1 - resourceStart.column : column - 1;", replace: "column - 1 - resourceStart.column;" }]],
  ["an inclusive range end", POSITION, checkGrid, [{ find: "compare(position, range.end) < 0", replace: "compare(position, range.end) <= 0" }]],
  ["an exclusive range start", POSITION, checkGrid, [{ find: "compare(position, range.start) >= 0", replace: "compare(position, range.start) > 0" }]],
  ["lines compared and columns not", POSITION, checkGrid, [{ find: "return a.line !== b.line ? a.line - b.line : a.column - b.column;", replace: "return a.line - b.line;" }]],
  ["columns compared and lines not", POSITION, checkGrid, [{ find: "return a.line !== b.line ? a.line - b.line : a.column - b.column;", replace: "return a.column - b.column;" }]],
  ["a met join reading as a cause", CAUSED, checkWording, [{ find: '{ reading: "position_consistent" }', replace: '{ reading: "caused" }' }]],
  ["an ambiguous join reading as met", CAUSED, checkWording, [{ find: 'return identity === "repeated" ? { reading: "ambiguous", reason: "url_repeated" } : { reading: "position_consistent" };', replace: 'return { reading: "position_consistent" };' }]]
] as const) {
  test(`joins catch ${name}, as ${property}`, async () => {
    await assertCaughtBy(name, property, () => check(variant(...(edits as readonly SourceEdit[]))));
  });
}

const ORDER = "order is established only on one named clock";

const checkOrder = (module: ReadingsModule) => {
  const table: readonly (readonly [production.ClockedTime, production.ClockedTime, -1 | 0 | 1 | "refused"])[] = [
    [{ clock: "page", ms: 1 }, { clock: "page", ms: 2 }, -1],
    [{ clock: "page", ms: 2 }, { clock: "page", ms: 1 }, 1],
    [{ clock: "page", ms: 2 }, { clock: "page", ms: 2 }, 0],
    [{ clock: "page", ms: 1 }, { clock: "wall", ms: 2 }, "refused"],
    [{ clock: "wall", ms: 2 }, { clock: "page", ms: 1 }, "refused"],
    [{ clock: null, ms: 1 }, { clock: null, ms: 2 }, "refused"],
    [{ clock: null, ms: 1 }, { clock: "page", ms: 2 }, "refused"],
    [{ clock: "page", ms: 1 }, { clock: null, ms: 2 }, "refused"],
    [{ clock: "", ms: 1 }, { clock: "", ms: 2 }, "refused"]
  ];
  for (const [a, b, expected] of table) {
    const answer = module.orderOf(a, b);
    holds(ORDER, expected === "refused" ? !answer.ok && answer.refusal === "clocks-differ" : answer.ok && answer.order === expected, () => ({ a, b, answer }));
  }
  // A time that is not one has no order, even with itself.
  for (const [left, right] of [[Number.NaN, Number.NaN], [Number.NaN, 1], [1, Number.NaN], [Number.POSITIVE_INFINITY, 1], [1, Number.POSITIVE_INFINITY], [-1, 1], [1, -1], [MAX_TIME_MS + 1, 1]] as const) {
    const answer = module.orderOf({ clock: "page", ms: left }, { clock: "page", ms: right });
    holds(ORDER, !answer.ok && answer.refusal === "time-invalid", () => ({ left, right, answer }));
  }
  const atBound = module.orderOf({ clock: "page", ms: MAX_TIME_MS }, { clock: "page", ms: 0 });
  holds(ORDER, atBound.ok && atBound.order === 1, () => atBound);
};

test("order across clocks is refused", async () => {
  checkOrder(production);
  assert.deepEqual(orderOf({ clock: "page", ms: 1 }, { clock: "wall", ms: 2 }), { ok: false, refusal: "clocks-differ" });
  await assertCaughtBy("two clocks compared anyway", ORDER, () => checkOrder(variant({ find: "if (known(a.clock) === null || a.clock !== b.clock)", replace: "if (known(a.clock) === null)" })));
  await assertCaughtBy("two unnamed clocks taken as one", ORDER, () => checkOrder(variant({ find: "if (known(a.clock) === null || a.clock !== b.clock)", replace: "if (a.clock !== b.clock)" })));
  await assertCaughtBy("a time that is not one compared anyway", ORDER, () => checkOrder(variant({ find: 'if (!isTime(a.ms) || !isTime(b.ms))\n        return { ok: false, refusal: "time-invalid" };', replace: "" })));
  await assertCaughtBy("order reversed", ORDER, () => checkOrder(variant({ find: "order: a.ms < b.ms ? -1 : 1", replace: "order: a.ms < b.ms ? 1 : -1" })));
});

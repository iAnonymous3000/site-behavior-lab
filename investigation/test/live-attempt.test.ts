import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decodeEvent } from "../core/case-events";
import { MAX_EVIDENCE_BYTES, type LogEvent } from "../core/case-log";
import type { SlotName } from "../core/case-machine";
import { MAX_RUNNER_ROWS_PER_ATTEMPT } from "../core/case-runner";
import type { EvidenceRow, InstrumentRecord, RowWindow } from "../core/evidence-model";
import { CAPTURE_RECORD_FIELDS, LIVE_INSTRUMENTS, LIVE_ROW_LIMITS, liveAttemptRows, type LiveAttemptResult, type LiveOutput } from "../core/live-attempt";
import { FAILURE_OUTCOMES } from "../core/recorder-shapes-6-8-0";

/**
 * The live attempt's rows, on S5c's recorded outputs: the final container pass's four clean attempts
 * (three instrumented reference visits and one baseline), each stored output copied byte for byte
 * with the runner's own call log beside it, and the reference set's snapshot as S5c's commit built it.
 * investigation/test/recorded/README.md names each file, its run, its size and its SHA-256. The files
 * are read as data, never executed.
 */
const ROOT = process.cwd();
const RECORDED = path.join(ROOT, "investigation/test/recorded");
const PLANS = ["ref-default", "ref-gpc", "ref-consent", "s3-page-baseline"] as const;
type Plan = (typeof PLANS)[number];
const INSTRUMENTED: readonly Plan[] = ["ref-default", "ref-gpc", "ref-consent"];

const bytesOf = (value: unknown): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const read = (plan: Plan, file: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(path.join(RECORDED, "s5c-pass5", plan, file)));
const json = (bytes: Uint8Array): any => JSON.parse(Buffer.from(bytes).toString("utf8"));

type Written = Readonly<{ type: string; data: any }>;
/** The events the runner wrote for this attempt, in its order, read from the stand-in's call log. */
function written(plan: Plan): readonly Written[] {
  return Buffer.from(read(plan, "calls.jsonl"))
    .toString("utf8")
    .split("\n")
    .filter((line: string) => line !== "")
    .map((line: string): any => JSON.parse(line))
    .filter((call: any) => call.call === "runner")
    .map((call: any) => call.event as Written);
}
const writtenRows = (plan: Plan): EvidenceRow[] => written(plan).filter((e) => e.type === "evidence-recorded").map((e) => e.data.row);
const writtenInstruments = (plan: Plan): InstrumentRecord[] => written(plan).filter((e) => e.type === "instrument-recorded").map((e) => e.data);
const slotOf = (plan: Plan): SlotName => writtenRows(plan)[0].slot;

/** What a runner hands over: each stored output, with the windows the runner measured where P-a says it gives them. */
function outputsOf(plan: Plan, replace: Partial<Record<string, Uint8Array<ArrayBuffer>>> = {}): LiveOutput[] {
  return writtenRows(plan).map((row) => {
    const given: RowWindow | null = row.instrument === "scanner" || row.instrument === "rea-inspect" ? row.window : null;
    return { instrument: row.instrument, bytes: replace[row.instrument] ?? read(plan, `${row.instrument}.json`), window: given };
  });
}
const run = (plan: Plan, replace: Partial<Record<string, Uint8Array<ArrayBuffer>>> = {}): Promise<LiveAttemptResult> => liveAttemptRows({ slot: slotOf(plan), outputs: outputsOf(plan, replace) });
/** A copy of a recorded JSON output, edited. */
const edited = (plan: Plan, instrument: string, edit: (value: any) => void): Uint8Array<ArrayBuffer> => {
  const value = json(read(plan, `${instrument}.json`));
  edit(value);
  return bytesOf(value);
};
const ok = (result: LiveAttemptResult): Extract<LiveAttemptResult, { ok: true }> => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<LiveAttemptResult, { ok: true }>;
};
const rowOf = (result: LiveAttemptResult, instrument: string): EvidenceRow => {
  const row = ok(result).rows.find((r) => r.instrument === instrument);
  assert.ok(row !== undefined, instrument);
  return row;
};

const EXPECTED_LIMITS: Readonly<Record<Plan, Readonly<Record<string, readonly string[]>>>> = {
  // Armed 449 and 439 ms after the envelope; scanner scripts labelled by containment with an excess above 0.
  "ref-default": { scanner: [], "rea-observe": ["recorder-armed-after-measurement", "script-label-by-containment"], "rea-inspect": ["recorder-armed-after-measurement", "script-label-by-containment"], runner: ["recorder-armed-after-measurement"] },
  "ref-gpc": { scanner: [], "rea-observe": ["recorder-armed-after-measurement", "script-label-by-containment"], "rea-inspect": ["recorder-armed-after-measurement", "script-label-by-containment"], runner: ["recorder-armed-after-measurement"] },
  // Armed 2,518 ms before the envelope.
  "ref-consent": { scanner: [], "rea-observe": ["script-label-by-containment"], "rea-inspect": ["script-label-by-containment"], runner: [] },
  "s3-page-baseline": { scanner: [], runner: [] }
};

test("E-1: for each recorded clean attempt the rows, the instrument records and their order equal what the runner wrote, apart from the limits", async () => {
  assert.equal(PLANS.length, 4);
  for (const plan of PLANS) {
    const result = ok(await run(plan));
    const theirs = writtenRows(plan);
    assert.ok(theirs.length > 0, plan);
    assert.deepEqual(result.rows.map((row) => ({ ...row, limits: [] })), theirs, plan);
    for (const row of result.rows) assert.deepEqual(row.limits, EXPECTED_LIMITS[plan][row.instrument], `${plan} ${row.instrument}`);
    assert.deepEqual(result.instruments, writtenInstruments(plan), plan);
    const order = written(plan).filter((e) => e.type === "evidence-recorded" || e.type === "instrument-recorded");
    assert.deepEqual(result.events.map((e) => e.type), order.map((e) => e.type), plan);
    assert.equal(result.scriptLabels, INSTRUMENTED.includes(plan) ? "settled" : "none", plan);
  }
});

test("P-a: the observation's window comes from its own bytes and a given one that differs is refused; the record's is set here", async () => {
  const slot = slotOf("ref-default");
  const outputs = outputsOf("ref-default");
  const theirs = writtenRows("ref-default");
  const observeWindow = theirs.find((r) => r.instrument === "rea-observe")?.window as RowWindow;
  assert.ok(observeWindow.clock === "wall" && observeWindow.endMs > observeWindow.startMs);
  const given = (instrument: string, window: RowWindow | null) => outputs.map((o) => (o.instrument === instrument ? { ...o, window } : o));
  // The same window given is accepted; one ms off is refused.
  ok(await liveAttemptRows({ slot, outputs: given("rea-observe", observeWindow) }));
  const off = { ...observeWindow, endMs: observeWindow.endMs + 1 };
  const refused: [string, LiveOutput[]][] = [
    ["an observation window one ms off its bytes", given("rea-observe", off)],
    ["a clock on the record's row", given("runner", observeWindow)],
    ["no scanner window", given("scanner", null)],
    ["no inspection window", given("rea-inspect", null)],
    ["a scanner window that ends before it starts", given("scanner", { clock: "wall", startMs: 10, endMs: 9 })]
  ];
  assert.ok(refused.length > 0);
  for (const [name, list] of refused) {
    const result = await liveAttemptRows({ slot, outputs: list });
    assert.equal((result as { refusal: string }).refusal, "window-refused", name);
  }
  assert.deepEqual(rowOf(await run("ref-default"), "runner").window, { clock: null, note: "the-attempt" });
});

test("the outputs are the arm's own: an unknown, repeated, missing or extra instrument, or a slot not the record's, is refused", async () => {
  const slot = slotOf("ref-default");
  const outputs = outputsOf("ref-default");
  const baseline = outputsOf("s3-page-baseline");
  const cases: [string, LiveOutput[], SlotName, string][] = [
    ["an unknown instrument", [...outputs.slice(0, 3), { ...outputs[3], instrument: "logger" }], slot, "unknown-instrument"],
    ["a repeated instrument", [...outputs, outputs[0]], slot, "duplicate-instrument"],
    ["an instrumented attempt without its inspection", outputs.filter((o) => o.instrument !== "rea-inspect"), slot, "instruments-not-of-arm"],
    ["a baseline with a recorder output", [...baseline, outputs.find((o) => o.instrument === "rea-observe") as LiveOutput], slotOf("s3-page-baseline"), "instruments-not-of-arm"],
    ["no capture record", outputs.filter((o) => o.instrument !== "runner"), slot, "instruments-not-of-arm"],
    ["a slot that is not the record's", outputs, "I2", "slot-mismatch"]
  ];
  assert.ok(cases.length > 0);
  for (const [name, list, at, refusal] of cases) {
    // A throw is caught and asserted on, so a wall that is gone fails here and not by the error it lets through.
    const result = await liveAttemptRows({ slot: at, outputs: list }).catch((error: unknown) => ({ threw: String(error) }));
    assert.deepEqual({ refusal: (result as { refusal?: string }).refusal, threw: (result as { threw?: string }).threw }, { refusal, threw: undefined }, name);
  }
});

/** The key sets of a capture record, by the paths CAPTURE_RECORD_FIELDS uses. */
function fieldsOf(value: unknown, at: string, out: Map<string, Set<string>>): void {
  if (Array.isArray(value)) {
    for (const item of value) fieldsOf(item, `${at}[]`, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  // Lists of names are values, not records: counts, labels and the domains' lists hold strings only.
  const keys = out.get(at) ?? new Set<string>();
  for (const key of Object.keys(value)) keys.add(key);
  out.set(at, keys);
  for (const [key, child] of Object.entries(value)) fieldsOf(child, at === "" ? key : `${at}.${key}`, out);
}

test("E-7: the capture record reader's field lists equal the fields of S5c's recorded capture records, each way", () => {
  const seen = new Map<string, Set<string>>();
  for (const plan of PLANS) fieldsOf(json(read(plan, "runner.json")), "", seen);
  assert.ok(seen.size > 0);
  for (const [at, keys] of seen) {
    assert.ok(CAPTURE_RECORD_FIELDS[at] !== undefined, `a recorded path the reader does not list: ${at}`);
    assert.deepEqual([...keys].sort(), [...CAPTURE_RECORD_FIELDS[at]].sort(), at);
  }
  const unrecorded = Object.keys(CAPTURE_RECORD_FIELDS).filter((at) => !seen.has(at));
  // The two variants no recorded record holds are written by the runner as the reader lists them.
  assert.deepEqual(unrecorded.sort(), ["environment.processes[] (unreadable)", "times.recorder.recorder reported armed (absent)"]);
  const core = readFileSync(path.join(ROOT, "investigation/runner/s5/runner/core.mjs"), "utf8");
  assert.ok(core.includes('{ absent: true, what: "observe printed no armed line" }'));
  assert.ok(core.includes("processes.push({ kind: proc.kind, readable: false, error:"));
  assert.ok(core.includes('export const CAPTURE_RECORD_VERSION = "s5c-capture-record@1";'));
});

test("1: an output with an unknown or missing field is refused, not read loosely, and the refusal names no planted key", async () => {
  const CANARY = "canary-field-71d3";
  const cases: [string, Partial<Record<string, Uint8Array<ArrayBuffer>>>, string][] = [
    ["an unknown top-level field", { runner: edited("ref-default", "runner", (v) => { v[CANARY] = 1; }) }, "capture-record-refused"],
    ["a missing top-level field", { runner: edited("ref-default", "runner", (v) => { delete v.logger; }) }, "capture-record-refused"],
    ["an unknown field in a script row", { runner: edited("ref-default", "runner", (v) => { v.scripts.observe.rows[0][CANARY] = null; }) }, "capture-record-refused"],
    ["a missing field in a script row", { runner: edited("ref-default", "runner", (v) => { delete v.scripts.inspect.rows[0].scope; }) }, "capture-record-refused"],
    ["an unknown version", { runner: edited("ref-default", "runner", (v) => { v.version = "s5c-capture-record@2"; }) }, "capture-record-refused"],
    ["an unknown label", { runner: edited("ref-default", "runner", (v) => { v.scripts.observe.rows[0].label = "page"; }) }, "capture-record-refused"],
    ["an observe output with a key renamed", { "rea-observe": edited("ref-default", "rea-observe", (v) => { v.normalized_result[CANARY] = v.normalized_result.excluded_requests; delete v.normalized_result.excluded_requests; }) }, "recorder-output-refused"],
    ["an inspect output with an extra envelope key", { "rea-inspect": edited("ref-default", "rea-inspect", (v) => { v[CANARY] = null; }) }, "recorder-output-refused"]
  ];
  assert.ok(cases.length > 0);
  for (const [name, replace, refusal] of cases) {
    const result = await run("ref-default", replace);
    assert.equal(result.ok, false, name);
    assert.equal((result as { refusal: string }).refusal, refusal, name);
    assert.ok(!JSON.stringify(result).includes(CANARY), name);
  }
});

/** A 6.8.0 failure object for each outcome: five recorded in S4, two made here where none was recorded. */
function failureFor(outcome: string): unknown {
  const s4 = (name: string): unknown => JSON.parse(readFileSync(path.join(RECORDED, "rea-6.8.0", name), "utf8"));
  const made = (code: string) => ({ category: "internal", code, details: { operation: "observe_web_execution" }, message: "made by the test", remediation: {}, retryable: false });
  switch (outcome) {
    case "budget-refused": return s4("failure-source-budget.json");
    case "cleanup-unconfirmed": return s4("failure-large-post.json");
    case "cancelled": return s4("failure-sigint.json");
    case "input-refused": return s4("failure-input.json");
    case "unreadable-output": return made("unreadable_output");
    case "other-failure": return made("internal_error");
    default: throw new Error(outcome);
  }
}

test("2: each failure outcome of the 6.8.0 adapter maps to its own result, none merged, in either recorder position", async () => {
  assert.ok(FAILURE_OUTCOMES.length > 0);
  for (const position of ["rea-observe", "rea-inspect"]) {
    const outcomes = new Set<string>();
    for (const outcome of FAILURE_OUTCOMES) {
      const result = await run("ref-default", { [position]: bytesOf(failureFor(outcome)) });
      assert.deepEqual(result, { ok: false, refusal: "recorder-failure", at: position === "rea-observe" ? "observe" : "inspect", outcome }, `${position} ${outcome}`);
      outcomes.add((result as { outcome: string }).outcome);
    }
    assert.equal(outcomes.size, FAILURE_OUTCOMES.length, position);
  }
});

test("3: canaries planted in query, path, storage, script and console text are absent from rows, row ids, object keys and errors", async () => {
  const CANARIES = { query: "canary-query-5a1e", path: "canary-path-2f9c", storage: "canary-storage-8b7d", script: "canary-script-c04a", console: "canary-console-e613" };
  const scanner = edited("ref-default", "scanner", (v) => {
    v.requests[0].url = `http://www.example.com/${CANARIES.path}/x.js?q=${CANARIES.query}`;
    v.storage = { [CANARIES.storage]: CANARIES.storage };
    v.warnings = [...(v.warnings ?? []), `console said ${CANARIES.console}`];
  });
  const observe = edited("ref-default", "rea-observe", (v) => {
    v.normalized_result.sources[0].source.text = `/* ${CANARIES.script} */ ${CANARIES.console}`;
  });
  const shown = JSON.stringify(ok(await run("ref-default", { scanner, "rea-observe": observe })));
  const refused = JSON.stringify(await run("ref-default", { scanner, "rea-observe": observe, runner: edited("ref-default", "runner", (v) => { v.attempt.arm = CANARIES.query; v[CANARIES.path] = 1; }) }));
  assert.ok(refused.includes("capture-record-refused"));
  const values = Object.values(CANARIES);
  assert.equal(values.length, 5);
  for (const canary of values) {
    assert.ok(!shown.includes(canary), canary);
    assert.ok(!refused.includes(canary), canary);
  }
  // The planted bytes are still what the rows name, by digest.
  assert.equal(rowOf(await run("ref-default", { scanner, "rea-observe": observe }), "scanner").digest, sha256(scanner));
});

test("4: no text of the reference set, fixed or wrapped, reaches a row field, row id, instrument record or refusal; only the stored bytes a row names", async () => {
  const set = JSON.parse(readFileSync(path.join(RECORDED, "s5c-reference-set", "reference-set.json"), "utf8")) as { references: { name: string; text: string; sha256: string }[] };
  assert.equal(set.references.length, 12);
  for (const reference of set.references) {
    assert.equal(sha256(Buffer.from(reference.text, "utf8")), reference.sha256, reference.name);
    // A fixed text is its own canary: its digest and a distinctive substring. A wrapped one also carries a planted marker.
    const marker = `canary-marker-${reference.sha256.slice(0, 8)}`;
    const middle = Math.floor(reference.text.length / 2);
    const planted = `${reference.text.slice(0, middle)}/*${marker}*/${reference.text.slice(middle)}`;
    for (const text of [reference.text, `((fn, ...args) => fn(...args))(${planted}, 1)`]) {
      const observe = edited("ref-default", "rea-observe", (v) => {
        v.normalized_result.sources[0].source.text = text;
        v.normalized_result.sources[0].source.sha256 = sha256(Buffer.from(text, "utf8"));
      });
      const result = ok(await run("ref-default", { "rea-observe": observe }));
      const refusal = await run("ref-default", { "rea-observe": observe, scanner: bytesOf({}) });
      assert.equal(refusal.ok, false);
      const substring = reference.text.slice(middle - 20, middle + 20);
      for (const shown of [JSON.stringify(result), JSON.stringify(refusal)]) {
        for (const canary of [reference.sha256, substring, marker]) assert.ok(!shown.includes(canary), `${reference.name}: ${canary.slice(0, 30)}`);
      }
      // The text is inside the bytes the observe row names, and nowhere else.
      assert.equal(rowOf(result, "rea-observe").digest, sha256(observe));
      assert.ok(Buffer.from(observe).toString("utf8").includes(JSON.stringify(reference.text.slice(0, 40)).slice(1, -1)));
    }
  }
});

/** The capture record of ref-default with one script row changed. */
const withScript = (edit: (rows: any[], inspect: any[]) => void) => edited("ref-default", "runner", (v) => edit(v.scripts.observe.rows, v.scripts.inspect.rows));
const INCONSISTENT = "script-labels-inconsistent";
async function assertInconsistent(name: string, runner: Uint8Array<ArrayBuffer>): Promise<void> {
  const result = ok(await run("ref-default", { runner }));
  assert.equal(result.scriptLabels, "inconsistent", name);
  for (const instrument of ["rea-observe", "rea-inspect", "runner"]) assert.ok(rowOf(result, instrument).limits.includes(INCONSISTENT), `${name}: ${instrument}`);
  assert.ok(!rowOf(result, "scanner").limits.includes(INCONSISTENT), name);
  // The rows are still made, one per stored output.
  assert.deepEqual(result.rows.map((r) => r.instrument), [...LIVE_INSTRUMENTS], name);
  const record = result.instruments.find((i) => i.instrument === "runner");
  assert.deepEqual(record, { slot: "I1", instrument: "runner", completeness: "partial", reason: INCONSISTENT }, name);
  for (const other of result.instruments.filter((i) => i.instrument !== "runner")) assert.equal(other.completeness, "complete", name);
}

test("5: an empty-URL script labelled the page's on input yields the limit and a partial record, never a clean result", async () => {
  const cases: [string, Uint8Array<ArrayBuffer>][] = [
    ["an empty-URL observe script labelled page-loaded", withScript((rows) => { const r = rows.find((x) => x.url === null); r.label = "page-loaded"; r.method = null; r.reference = null; r.excess = null; r.scope = "inside"; })],
    ["an empty-URL inspect script labelled page-loaded", withScript((_, inspect) => { inspect[0].url = null; })],
    ["a data: URL script labelled page-loaded", withScript((rows) => { const r = rows.find((x) => x.url === null); r.url = "data:text/javascript,1"; r.label = "page-loaded"; r.scope = "outside"; })]
  ];
  assert.ok(cases.length > 0);
  for (const [name, runner] of cases) await assertInconsistent(name, runner);
});

/** The same record on the reserved site example.test, so hosts that only end like it can be spelled with reserved names. */
const onTestSite = (edit: (rows: any[], inspect: any[]) => void) =>
  edited("ref-default", "runner", (v) => {
    v.scope.siteKey = "example.test";
    for (const row of [...v.scripts.observe.rows, ...v.scripts.inspect.rows]) if (row.url !== null) row.url = row.url.replace("//www.example.com/", "//www.example.test/");
    edit(v.scripts.observe.rows, v.scripts.inspect.rows);
  });

test("8: a script marked inside whose host is outside the site, and a page-loaded script with no mark, are never taken as consistent", async () => {
  const pageLoaded = (rows: any[]) => rows.find((x) => x.label === "page-loaded");
  // The site's own record, moved to the reserved site, still reads as consistent.
  assert.equal(ok(await run("ref-default", { runner: onTestSite(() => undefined) })).scriptLabels, "settled");
  const cases: [string, Uint8Array<ArrayBuffer>][] = [
    ["a host that only ends like the site", onTestSite((rows) => { pageLoaded(rows).url = "http://www.notexample.test/control.html"; })],
    ["a host with the site as a label", onTestSite((rows) => { pageLoaded(rows).url = "http://example.test.attacker.test/control.html"; })],
    ["an inspect script marked inside on another site", onTestSite((_, inspect) => { inspect[0].url = "https://other.test/a.js"; })],
    ["a page-loaded script with no mark", onTestSite((rows) => { pageLoaded(rows).scope = null; })],
    ["an empty-URL script marked inside", onTestSite((rows) => { rows.find((x) => x.url === null).scope = "inside"; })]
  ];
  assert.ok(cases.length > 0);
  for (const [name, runner] of cases) await assertInconsistent(name, runner);
  // A consistent record yields neither: a subdomain inside, another site outside.
  const consistent = onTestSite((rows) => { rows.push({ ...pageLoaded(rows), url: "https://cdn.other.test/a.js", scope: "outside" }); rows.push({ ...pageLoaded(rows), url: "https://a.www.example.test/b.js", scope: "inside" }); });
  const fixed = json(consistent);
  fixed.scripts.observe.sources = fixed.scripts.observe.rows.length;
  const result = ok(await run("ref-default", { runner: bytesOf(fixed) }));
  assert.equal(result.scriptLabels, "settled");
  for (const row of result.rows) assert.ok(!row.limits.includes(INCONSISTENT), row.instrument);
  assert.ok(result.instruments.every((i) => i.completeness === "complete"));
});

test("6: an output over the object bound gets no row and an instrument record that is missing with a reason; the others keep theirs", async () => {
  for (const instrument of ["scanner", "rea-observe"]) {
    const bytes = read("ref-default", `${instrument}.json`);
    // The bound is checked by length: the real bytes, reporting one byte more than the bound, with no 32 MiB buffer.
    Object.defineProperty(bytes, "length", { value: MAX_EVIDENCE_BYTES + 1 });
    const result = ok(await run("ref-default", { [instrument]: bytes }));
    assert.deepEqual(result.rows.map((r) => r.instrument), LIVE_INSTRUMENTS.filter((name) => name !== instrument), instrument);
    assert.deepEqual(result.instruments.find((i) => i.instrument === instrument), { slot: "I1", instrument, completeness: "missing", reason: "evidence-too-large" });
    assert.equal(result.instruments.length, LIVE_INSTRUMENTS.length);
    assert.ok(result.instruments.filter((i) => i.instrument !== instrument).every((i) => i.completeness === "complete"));
  }
  // At the bound itself the row is made.
  const atBound = read("ref-default", "scanner.json");
  Object.defineProperty(atBound, "length", { value: MAX_EVIDENCE_BYTES });
  assert.equal(rowOf(await run("ref-default", { scanner: atBound }), "scanner").instrument, "scanner");
});

test("7: the function takes the scan result; an envelope, or a result that carries an envelope's key, is refused", async () => {
  const result = json(read("ref-default", "scanner.json"));
  const cases: [string, unknown][] = [
    ["the measurement envelope", { result, measurement: {} }],
    ["the envelope without its measurement", { result }],
    ["a result carrying a result key", { ...result, result: null }],
    ["a result carrying a measurement key", { ...result, measurement: null }],
    ["a result without schemaVersion", (({ schemaVersion: _s, ...rest }) => rest)(result)],
    ["not an object", [result]]
  ];
  assert.ok(cases.length > 0);
  for (const [name, value] of cases) assert.deepEqual(await run("ref-default", { scanner: bytesOf(value) }), { ok: false, refusal: "scanner-not-a-result", at: "scanner", outcome: null }, name);
});

test("9: one row per stored output and one instrument record per instrument, the record's row included, never past the bound", async () => {
  for (const plan of PLANS) {
    const result = ok(await run(plan));
    const instruments = outputsOf(plan).map((o) => o.instrument);
    assert.ok(instruments.length > 0, plan);
    assert.deepEqual(result.rows.map((r) => r.instrument), instruments, plan);
    assert.deepEqual(result.instruments.map((i) => i.instrument), instruments, plan);
    assert.ok(result.rows.some((r) => r.instrument === "runner"), plan);
    assert.ok(result.rows.length <= MAX_RUNNER_ROWS_PER_ATTEMPT, plan);
  }
  // 33 outputs are refused as the bound, before any other check reads them.
  const many = Array.from({ length: MAX_RUNNER_ROWS_PER_ATTEMPT + 1 }, () => outputsOf("ref-default")[0]);
  assert.deepEqual(await liveAttemptRows({ slot: "I1", outputs: many }), { ok: false, refusal: "row-bound", at: null, outcome: null });
  assert.ok(LIVE_INSTRUMENTS.length <= MAX_RUNNER_ROWS_PER_ATTEMPT);
});

test("10: an attempt whose observation did not end cleanly gives no rows", async () => {
  const cases: [string, Uint8Array<ArrayBuffer>, string][] = [
    ["the recorded large-POST failure, cleanup incomplete", new Uint8Array(readFileSync(path.join(RECORDED, "rea-6.8.0", "failure-large-post.json"))), "recorder-failure"],
    ["the recorded page-crash failure", new Uint8Array(readFileSync(path.join(RECORDED, "rea-6.8.0", "failure-page-crash.json"))), "recorder-failure"],
    ["an observation whose cleanup is not confirmed", edited("ref-default", "rea-observe", (v) => { v.normalized_result.instrumentation.cleanup = "incomplete"; }), "observation-ended"],
    ["an observation that ended early with its cleanup confirmed", edited("ref-default", "rea-observe", (v) => { v.normalized_result.window.end_reason = "document_changed"; }), "observation-not-clean"]
  ];
  assert.ok(cases.length > 0);
  for (const [name, observe, refusal] of cases) {
    const result = await run("ref-default", { "rea-observe": observe });
    assert.equal(result.ok, false, name);
    assert.equal((result as { refusal: string }).refusal, refusal, name);
    assert.ok(!("rows" in result) && !("events" in result), name);
  }
});

const armed = (edit: (armed: any, recorder: any) => void) => edited("ref-default", "runner", (v) => edit(v.times.recorder["recorder reported armed"], v.times.recorder));
const recordLimits = async (runner: Uint8Array<ArrayBuffer>) => {
  const result = ok(await run("ref-default", { runner }));
  return [rowOf(result, "runner").limits, rowOf(result, "rea-observe").limits.filter((l) => l.startsWith("recorder-")), rowOf(result, "rea-inspect").limits.filter((l) => l.startsWith("recorder-"))];
};

test("11: the two recorder times reach the record's row as given, and its arming case reaches every recorder row and the record's as a limit", async () => {
  for (const plan of PLANS) {
    const result = ok(await run(plan));
    assert.equal(rowOf(result, "runner").digest, sha256(read(plan, "runner.json")), plan);
  }
  const cases: [string, Uint8Array<ArrayBuffer>, string[]][] = [
    ["armed 449 ms after the envelope, as recorded", read("ref-default", "runner.json"), ["recorder-armed-after-measurement"]],
    ["armed at the envelope", armed((a) => { a.fromEnvelopeMs = 0; }), ["recorder-armed-after-measurement"]],
    ["armed 1 ms before the envelope", armed((a) => { a.fromEnvelopeMs = -1; }), []],
    ["no armed line printed", armed((_, r) => { r["recorder reported armed"] = { absent: true, what: "observe printed no armed line" }; }), ["recorder-arming-not-reported"]]
  ];
  assert.ok(cases.length > 0);
  for (const [name, runner, slugs] of cases) {
    const [record, observe, inspect] = await recordLimits(runner);
    assert.deepEqual(record, slugs, name);
    assert.deepEqual(observe, slugs, name);
    assert.deepEqual(inspect, slugs, name);
  }
  assert.deepEqual(rowOf(await run("ref-consent"), "runner").limits, []);
  // A baseline runs no recorder and carries no arming limit.
  assert.ok(ok(await run("s3-page-baseline")).rows.every((r) => r.limits.length === 0));
  // An armed time with no envelope figure, and an instrumented record with no recorder times, are refused.
  for (const runner of [armed((a) => { a.fromEnvelopeMs = null; }), edited("ref-default", "runner", (v) => { v.times.recorder = null; })]) {
    const result = await run("ref-default", { runner });
    assert.equal((result as { refusal: string }).refusal, "capture-record-refused");
  }
});

test("13: the output holds rows and instrument records only, each decodes, each row names the sha256 of the bytes it was given, and nothing is stored", async () => {
  for (const plan of PLANS) {
    const result = ok(await run(plan));
    assert.ok(result.events.length > 0, plan);
    for (const event of result.events) {
      assert.ok(event.type === "evidence-recorded" || event.type === "instrument-recorded", event.type);
      assert.equal(decodeEvent(event as unknown as LogEvent).ok, true, JSON.stringify(event));
    }
    assert.ok(!result.events.some((e) => (e.type as string) === "source-recorded"));
    for (const output of outputsOf(plan)) assert.equal(rowOf(result, output.instrument).digest, sha256(output.bytes), `${plan} ${output.instrument}`);
  }
  for (const limit of LIVE_ROW_LIMITS) assert.ok(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(limit), limit);
  // It takes the attempt and nothing else: no store, no option.
  assert.equal(liveAttemptRows.length, 1);
  const source = readFileSync(path.join(ROOT, "investigation/core/live-attempt.ts"), "utf8");
  const fromLog = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/case-log"/g)].map((m) => m[1].trim());
  assert.deepEqual(fromLog, ["MAX_EVIDENCE_BYTES"]);
  for (const store of ["putEvidence", "appendCommand", "createLog", "openLog", "runCommand", "createCase", "runner-object", "source-recorded"]) assert.ok(!source.includes(store), store);
});

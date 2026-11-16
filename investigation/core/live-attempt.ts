// The one place a live attempt's evidence rows and instrument records are made (S5d, the ruling of
// 2026-11-16T03:36:06Z, E-1). A runner hands it the attempt's slot and each output it stored: the
// bytes, the instrument they came from and, for the scanner and the inspection, the window the runner
// measured (P-a, 2026-11-16T03:41:41Z). It gives back one row per stored output, each naming the
// sha256 of exactly the bytes it was given, one instrument record per instrument, and the order the
// runner writes them in. It re-encodes nothing and stores nothing: storing is the runner's
// object call (O-6), and it writes no record of the image's source (O-5).
//
// What it reads, and how:
// - The capture record (s5c-capture-record@1, the runner's own object) through a strict reader of its
//   own (E-7): an unknown version, a missing field or an unknown field refuses the attempt with no
//   rows, since nothing about it can then be trusted to be what it claims. Its field lists are
//   CAPTURE_RECORD_FIELDS, held equal by test to the fields of S5c's recorded capture records.
// - The scanner's bytes by their top level only (G-2, 03:44:04Z): one JSON object holding
//   schemaVersion, reportType and ok, and neither key of the measurement envelope. That is a check
//   of the input's top level, not a schema of the scan result.
// - The recorder's two outputs through recorder-shapes-6-8-0.ts. A 6.8.0 failure object in place of
//   an output, or an observation whose cleanup is not confirmed, is an observation that did not end
//   cleanly and leaves no rows (B-3, D-4, G-4); each failure outcome keeps its own refusal. So does an
//   observation window REA says ended early (H-2).
//
// Script ownership is never taken at anyone's word here either. The labels come from the runner
// (answer 2); this function does not compare texts. It holds three walls on what the capture record
// says of each script (P-b): an empty-URL or non-HTTP(S) script is never the page's; a script the
// page loaded is marked inside or outside the visit's origin scope; a script marked inside has a host
// that is the site key or a subdomain of it, dot-bounded. A record that breaks one keeps its rows,
// since the stored outputs are intact whatever their description says, but the recorder rows and the
// record's row carry script-labels-inconsistent, the runner instrument's record is partial for it,
// and the result's scriptLabels says the labels are not settled.
//
// Two stated limits become row limits. When the recorder reported armed at or after the scanner's
// envelope, its rows and the record's carry recorder-armed-after-measurement; when it printed no armed
// line, recorder-arming-not-reported (E-2). When the record holds any script labelled the scanner's by
// containment with characters beyond the reference, the recorder rows carry
// script-label-by-containment, since such a script may hold up to 1,024 characters that are not the
// scanner's (E-3, the ruling of 2026-11-16T01:48:17Z).
//
// A refusal names a fixed field path or kind from this file, never a key or value it was handed.

import { sha256Hex } from "./canonical-json";
import { MAX_EVIDENCE_BYTES } from "./case-log";
import { SLOT_NAMES, type SlotName } from "./case-machine";
import { MAX_RUNNER_ROWS_PER_ATTEMPT } from "./case-runner";
import type { EvidenceRow, InstrumentRecord, RowWindow } from "./evidence-model";
import { decodeJson, isPlain, isShapeRefusal } from "./recorder-shapes";
import { readInspectOutput680, readObserveOutput680, readRecorderFailure, type FailureOutcome } from "./recorder-shapes-6-8-0";

export const CAPTURE_RECORD_VERSION = "s5c-capture-record@1";

/** The instruments of a live attempt, in the order their rows and records are written. */
export const LIVE_INSTRUMENTS = ["scanner", "rea-observe", "rea-inspect", "runner"] as const;
export type LiveInstrument = (typeof LIVE_INSTRUMENTS)[number];

/** The instruments each arm stores. A baseline (and a visit with no seam at all) runs no recorder. */
const ARM_INSTRUMENTS: Readonly<Record<string, readonly LiveInstrument[]>> = {
  instrumented: ["scanner", "rea-observe", "rea-inspect", "runner"],
  baseline: ["scanner", "runner"],
  "no-seam": ["scanner", "runner"]
};

/** The limits this function puts on a row, each a slug. */
export const LIVE_ROW_LIMITS = ["recorder-armed-after-measurement", "recorder-arming-not-reported", "script-label-by-containment", "script-labels-inconsistent"] as const;
export type LiveRowLimit = (typeof LIVE_ROW_LIMITS)[number];

/** The capture record's own row has no clock: it describes the whole attempt. */
const RECORD_WINDOW: RowWindow = { clock: null, note: "the-attempt" };

/**
 * The capture record's field lists, by path, as runner/core.mjs writes s5c-capture-record@1. "[]" is
 * an item of a list. The two variants marked in parentheses are written by core.mjs and are in no
 * recorded record: an armed time the recorder never printed, and a process environment that could
 * not be read.
 */
export const CAPTURE_RECORD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "": ["version", "attempt", "recorder", "times", "scope", "scripts", "domains", "logger", "p2", "environment"],
  attempt: ["caseId", "attemptId", "slot", "arm"],
  recorder: ["release", "commands"],
  times: ["navigationStart", "envelope", "recorder"],
  "times.navigationStart": ["atMs", "what"],
  "times.envelope": ["atMs", "what"],
  "times.recorder": ["recorder started", "recorder reported armed"],
  "times.recorder.recorder started": ["fromNavigationStartMs", "fromEnvelopeMs", "what"],
  "times.recorder.recorder reported armed": ["fromNavigationStartMs", "fromEnvelopeMs", "what"],
  "times.recorder.recorder reported armed (absent)": ["absent", "what"],
  scope: ["siteKey", "rule"],
  scripts: ["referenceSetSha256", "references", "labels", "worlds", "observe", "inspect"],
  "scripts.observe": ["sources", "counts", "rows"],
  "scripts.observe.counts": ["page-loaded", "scanner", "origin-not-identified"],
  "scripts.observe.rows[]": ["scriptId", "url", "scheme", "sourceState", "length", "sha256", "label", "method", "reference", "excess", "scope"],
  "scripts.inspect": ["sources", "counts", "rows"],
  "scripts.inspect.counts": ["page-loaded", "scanner", "origin-not-identified"],
  "scripts.inspect.rows[]": ["scriptId", "url", "scheme", "sourceState", "length", "sha256", "label", "method", "reference", "excess", "scope"],
  domains: ["recorder", "release", "label", "source", "commands"],
  "domains.commands": ["observe-web-execution", "inspect-web-page"],
  "domains.commands.observe-web-execution": ["enabled", "otherDomainsCalled", "sentWithoutEnable"],
  "domains.commands.inspect-web-page": ["enabled", "otherDomainsCalled", "sentWithoutEnable"],
  logger: ["wrappedApiNames", "globalOrBindingNames", "note"],
  p2: ["method", "browserProcesses", "argvPort", "activePortFile", "fileCheck", "port", "error"],
  environment: ["processes", "recorderEnvironmentNames", "recorderCredentialNames"],
  "environment.processes[]": ["kind", "readable", "names", "tokenPresent", "credentialNames"],
  "environment.processes[] (unreadable)": ["kind", "readable", "error"]
};

/** The labels a script row may carry (runner/labels.mjs). */
const SCRIPT_LABELS = ["page-loaded", "scanner", "origin-not-identified"];

/** One stored output as the runner hands it over. The window is the runner's measure, or null where this function sets it. */
export type LiveOutput = Readonly<{ instrument: string; bytes: Uint8Array<ArrayBuffer>; window: RowWindow | null }>;
export type LiveAttemptInput = Readonly<{ slot: SlotName; outputs: readonly LiveOutput[] }>;

export type LiveEvent = Readonly<{ type: "evidence-recorded"; data: Readonly<{ row: EvidenceRow }> }> | Readonly<{ type: "instrument-recorded"; data: InstrumentRecord }>;

export type LiveAttemptRefusal =
  | "row-bound"
  | "malformed-input"
  | "unknown-instrument"
  | "duplicate-instrument"
  | "capture-record-refused"
  | "slot-mismatch"
  | "instruments-not-of-arm"
  | "scanner-not-a-result"
  | "recorder-output-refused"
  | "recorder-failure"
  | "observation-ended"
  | "observation-not-clean"
  | "window-refused";

export type LiveAttemptResult =
  | Readonly<{
      ok: true;
      rows: readonly EvidenceRow[];
      instruments: readonly InstrumentRecord[];
      /** What the runner writes, in the order it writes it: every row, then every instrument record. */
      events: readonly LiveEvent[];
      /** Whether a reader may take the attempt's script labels as the runner gave them. */
      scriptLabels: "settled" | "inconsistent" | "none";
    }>
  | Readonly<{ ok: false; refusal: LiveAttemptRefusal; at: string | null; outcome: FailureOutcome | null }>;

type Refused = Extract<LiveAttemptResult, { ok: false }>;
const refuse = (refusal: LiveAttemptRefusal, at: string | null = null, outcome: FailureOutcome | null = null): Refused => ({ ok: false, refusal, at, outcome });

function keysAre(value: unknown, path: string): value is Record<string, unknown> {
  if (!isPlain(value)) return false;
  const keys = CAPTURE_RECORD_FIELDS[path];
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isCountValue = (value: unknown): value is number => isInt(value) && value >= 0;
const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString);
const orNull = <T>(check: (value: unknown) => value is T) => (value: unknown): value is T | null => value === null || check(value);
const HEX64 = /^[0-9a-f]{64}$/;

/** What the reader keeps of a script row: only what the walls and limits need. */
type ScriptRow = Readonly<{ url: string | null; label: string; method: string | null; excess: number | null; scope: string | null }>;

/** What the reader keeps of a capture record. */
type CaptureRecord = Readonly<{
  slot: SlotName;
  arm: string;
  siteKey: string;
  /** Recorder reported armed, from the envelope, or null when the recorder printed no armed line. Instrumented only. */
  armedFromEnvelopeMs: number | null;
  scripts: readonly ScriptRow[] | null;
}>;

function readScriptTable(value: unknown, path: "scripts.observe" | "scripts.inspect"): readonly ScriptRow[] | string {
  if (!keysAre(value, path)) return path;
  if (!isCountValue(value.sources) || !Array.isArray(value.rows) || value.rows.length !== value.sources) return path;
  if (!keysAre(value.counts, `${path}.counts`) || !Object.values(value.counts).every(isCountValue)) return `${path}.counts`;
  const rows: ScriptRow[] = [];
  for (const row of value.rows) {
    if (!keysAre(row, `${path}.rows[]`)) return `${path}.rows`;
    const fine =
      isString(row.scriptId) &&
      orNull(isString)(row.url) &&
      orNull(isString)(row.scheme) &&
      orNull(isString)(row.sourceState) &&
      orNull(isCountValue)(row.length) &&
      (row.sha256 === null || (isString(row.sha256) && HEX64.test(row.sha256))) &&
      isString(row.label) &&
      SCRIPT_LABELS.includes(row.label) &&
      (row.method === null || row.method === "sha256" || row.method === "containment") &&
      orNull(isString)(row.reference) &&
      orNull(isCountValue)(row.excess) &&
      (row.scope === null || row.scope === "inside" || row.scope === "outside");
    if (!fine) return `${path}.rows`;
    rows.push({ url: row.url as string | null, label: row.label as string, method: row.method as string | null, excess: row.excess as number | null, scope: row.scope as string | null });
  }
  return rows;
}

function readTime(value: unknown, path: string, instrumented: boolean): boolean {
  if (!keysAre(value, path) || !isString(value.what)) return false;
  return instrumented ? isInt(value.atMs) : value.atMs === null || isInt(value.atMs);
}

/** The strict reader of s5c-capture-record@1. Returns the record, or the field path it refused at. */
export function readCaptureRecord(value: unknown): CaptureRecord | Readonly<{ refusedAt: string }> {
  const at = (path: string) => ({ refusedAt: path === "" ? "capture-record" : `capture-record: ${path}` });
  if (!keysAre(value, "")) return at("");
  if (value.version !== CAPTURE_RECORD_VERSION) return at("version");
  const { attempt } = value;
  if (!keysAre(attempt, "attempt") || !isString(attempt.caseId) || !isString(attempt.attemptId) || !(SLOT_NAMES as readonly unknown[]).includes(attempt.slot) || !isString(attempt.arm) || ARM_INSTRUMENTS[attempt.arm] === undefined) return at("attempt");
  const instrumented = attempt.arm === "instrumented";
  // A baseline runs no recorder, so each recorder part is null; an instrumented attempt has every one.
  const present = (part: unknown) => (instrumented ? part !== null : part === null);
  for (const part of ["recorder", "scripts", "domains", "p2"] as const) if (!present(value[part])) return at(part);

  if (value.recorder !== null && (!keysAre(value.recorder, "recorder") || !isString(value.recorder.release) || !isStrings(value.recorder.commands))) return at("recorder");

  const { times } = value;
  if (!keysAre(times, "times") || !readTime(times.navigationStart, "times.navigationStart", instrumented) || !readTime(times.envelope, "times.envelope", instrumented) || !present(times.recorder)) return at("times");
  let armedFromEnvelopeMs: number | null = null;
  if (times.recorder !== null) {
    const recorder = times.recorder;
    if (!keysAre(recorder, "times.recorder")) return at("times.recorder");
    const started = recorder["recorder started"];
    if (!keysAre(started, "times.recorder.recorder started") || !isInt(started.fromNavigationStartMs) || !isInt(started.fromEnvelopeMs) || !isString(started.what)) return at("times.recorder.recorder started");
    const armed = recorder["recorder reported armed"];
    if (keysAre(armed, "times.recorder.recorder reported armed (absent)")) {
      if (armed.absent !== true || !isString(armed.what)) return at("times.recorder.recorder reported armed");
    } else if (keysAre(armed, "times.recorder.recorder reported armed") && isInt(armed.fromNavigationStartMs) && isInt(armed.fromEnvelopeMs) && isString(armed.what)) {
      armedFromEnvelopeMs = armed.fromEnvelopeMs;
    } else return at("times.recorder.recorder reported armed");
  }

  const { scope } = value;
  if (!keysAre(scope, "scope") || !isString(scope.siteKey) || scope.siteKey === "" || !isString(scope.rule)) return at("scope");

  let scripts: ScriptRow[] | null = null;
  if (value.scripts !== null) {
    const s = value.scripts;
    if (!keysAre(s, "scripts") || !isString(s.referenceSetSha256) || !HEX64.test(s.referenceSetSha256) || !isCountValue(s.references) || !isStrings(s.labels) || s.labels.join() !== SCRIPT_LABELS.join() || !isString(s.worlds)) return at("scripts");
    const observe = readScriptTable(s.observe, "scripts.observe");
    if (isString(observe)) return at(observe);
    const inspect = readScriptTable(s.inspect, "scripts.inspect");
    if (isString(inspect)) return at(inspect);
    scripts = [...observe, ...inspect];
  }

  if (value.domains !== null) {
    const d = value.domains;
    if (!keysAre(d, "domains") || !isString(d.recorder) || !isString(d.release) || !isString(d.label) || !isString(d.source) || !keysAre(d.commands, "domains.commands")) return at("domains");
    for (const command of ["observe-web-execution", "inspect-web-page"] as const) {
      const c = d.commands[command];
      if (!keysAre(c, `domains.commands.${command}`) || !isStrings(c.enabled) || !isStrings(c.otherDomainsCalled) || !isStrings(c.sentWithoutEnable)) return at(`domains.commands.${command}`);
    }
  }

  const { logger } = value;
  if (!keysAre(logger, "logger") || !isStrings(logger.wrappedApiNames) || !isStrings(logger.globalOrBindingNames) || !isString(logger.note)) return at("logger");

  if (value.p2 !== null) {
    const p = value.p2;
    const port = orNull(isCountValue);
    if (!keysAre(p, "p2") || !isString(p.method) || !isCountValue(p.browserProcesses) || !port(p.argvPort) || !port(p.activePortFile) || !orNull(isString)(p.fileCheck) || !port(p.port) || !orNull(isString)(p.error)) return at("p2");
  }

  const { environment } = value;
  if (!keysAre(environment, "environment") || !Array.isArray(environment.processes) || !isStrings(environment.recorderEnvironmentNames) || !isStrings(environment.recorderCredentialNames)) return at("environment");
  for (const proc of environment.processes) {
    const readable = keysAre(proc, "environment.processes[]") && isString(proc.kind) && proc.readable === true && isCountValue(proc.names) && typeof proc.tokenPresent === "boolean" && isStrings(proc.credentialNames);
    const unreadable = keysAre(proc, "environment.processes[] (unreadable)") && isString(proc.kind) && proc.readable === false && isString(proc.error);
    if (!readable && !unreadable) return at("environment.processes");
  }

  return { slot: attempt.slot as SlotName, arm: attempt.arm, siteKey: scope.siteKey.toLowerCase(), armedFromEnvelopeMs, scripts };
}

const isRecord = (value: CaptureRecord | Readonly<{ refusedAt: string }>): value is CaptureRecord => !("refusedAt" in value);

/** The host of an HTTP(S) URL, or null for any other URL. */
function httpHost(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
}

/** P-b's three walls. True when the record describes a script in a way that contradicts itself. */
export function scriptLabelsInconsistent(scripts: readonly ScriptRow[], siteKey: string): boolean {
  return scripts.some((script) => {
    const host = httpHost(script.url);
    // An empty-URL or non-HTTP(S) script is never the page's, whatever label arrives.
    if (script.label === "page-loaded" && host === null) return true;
    // A script the page loaded is marked inside or outside the visit's origin scope.
    if (script.label === "page-loaded" && script.scope !== "inside" && script.scope !== "outside") return true;
    // Inside means the site key or a subdomain of it, dot-bounded, so a host that only ends like it is outside.
    if (script.scope === "inside" && (host === null || (host !== siteKey && !host.endsWith(`.${siteKey}`)))) return true;
    return false;
  });
}

const isWallWindow = (value: unknown): value is RowWindow =>
  isPlain(value) && Object.keys(value).length === 3 && value.clock === "wall" && isCountValue(value.startMs) && isCountValue(value.endMs) && value.endMs >= value.startMs;

const sameWindow = (left: RowWindow, right: RowWindow): boolean => JSON.stringify(left) === JSON.stringify(right) || (left.clock !== null && right.clock !== null && left.clock === right.clock && left.startMs === right.startMs && left.endMs === right.endMs);

/** The recorder's two outputs, each as 6.8.0 shapes read it, or the refusal that leaves the attempt with no rows. */
function readRecorder(bytes: Uint8Array, file: "observe" | "inspect"): Readonly<{ window: RowWindow | null }> | Refused {
  const value = decodeJson(file, bytes);
  if (isShapeRefusal(value)) return refuse("recorder-output-refused", file);
  // A failure object in place of an output: the observation did not end cleanly (G-4). Each outcome stays its own.
  const failure = readRecorderFailure(file, value);
  if (!isShapeRefusal(failure)) return refuse("recorder-failure", file, failure.outcome);
  if (file === "observe") {
    const view = readObserveOutput680(file, value);
    if (isShapeRefusal(view)) return refuse("recorder-output-refused", view.at);
    // An observation whose cleanup REA could not confirm is one the page ended (D-4).
    if (view.cleanup !== "confirmed") return refuse("observation-ended", file);
    // A window REA says ended early, with its cleanup confirmed, is still not a clean observation (H-2, 2026-11-16T04:33:22Z).
    if (view.endReason !== "window_elapsed") return refuse("observation-not-clean", file);
    if (!isCountValue(view.armedAtMs) || !isCountValue(view.endedAtMs) || view.endedAtMs < view.armedAtMs) return refuse("window-refused", file);
    return { window: { clock: "wall", startMs: view.armedAtMs, endMs: view.endedAtMs } };
  }
  const view = readInspectOutput680(file, value);
  if (isShapeRefusal(view)) return refuse("recorder-output-refused", view.at);
  return { window: null };
}

/** G-2: the scan result the scan returns, by its top level, never the measurement envelope. */
function isScanResultTop(bytes: Uint8Array): boolean {
  const value = decodeJson("scanner", bytes);
  if (!isPlain(value)) return false;
  if ("result" in value || "measurement" in value) return false;
  return "schemaVersion" in value && "reportType" in value && "ok" in value;
}

/**
 * One live attempt's rows and instrument records, from what the runner stored. Pure apart from the
 * digest, which goes through WebCrypto. Nothing here is written anywhere.
 */
export async function liveAttemptRows(input: LiveAttemptInput): Promise<LiveAttemptResult> {
  if (!isPlain(input) || !Array.isArray(input.outputs)) return refuse("malformed-input");
  // The object bounds an attempt's rows (G-4, C-2); this is the same bound, before anything else is read.
  if (input.outputs.length > MAX_RUNNER_ROWS_PER_ATTEMPT) return refuse("row-bound");
  if (!(SLOT_NAMES as readonly unknown[]).includes(input.slot)) return refuse("malformed-input", "slot");
  const byInstrument = new Map<LiveInstrument, LiveOutput>();
  for (const output of input.outputs) {
    if (!isPlain(output) || !((output as { bytes?: unknown }).bytes instanceof Uint8Array)) return refuse("malformed-input", "outputs");
    const instrument = LIVE_INSTRUMENTS.find((name) => name === output.instrument);
    if (instrument === undefined) return refuse("unknown-instrument", "outputs");
    if (byInstrument.has(instrument)) return refuse("duplicate-instrument", "outputs");
    byInstrument.set(instrument, output as LiveOutput);
  }

  const recordOutput = byInstrument.get("runner");
  if (recordOutput === undefined) return refuse("instruments-not-of-arm", "runner");
  const record = readCaptureRecord(decodeJson("capture-record", recordOutput.bytes));
  if (!isRecord(record)) return refuse("capture-record-refused", record.refusedAt);
  if (record.slot !== input.slot) return refuse("slot-mismatch", "capture-record: attempt");
  const expected = ARM_INSTRUMENTS[record.arm];
  if (expected.length !== byInstrument.size || !expected.every((name) => byInstrument.has(name))) return refuse("instruments-not-of-arm", "outputs");
  const instrumented = record.arm === "instrumented";

  // Windows (P-a): the scanner's and the inspection's are the runner's; the observation's comes from its own bytes, and the record's is set here.
  const windows = new Map<LiveInstrument, RowWindow>();
  const scanner = byInstrument.get("scanner") as LiveOutput;
  if (!isScanResultTop(scanner.bytes)) return refuse("scanner-not-a-result", "scanner");
  if (!isWallWindow(scanner.window)) return refuse("window-refused", "scanner");
  windows.set("scanner", scanner.window);
  if (recordOutput.window !== null && !sameWindow(recordOutput.window, RECORD_WINDOW)) return refuse("window-refused", "runner");
  windows.set("runner", RECORD_WINDOW);
  if (instrumented) {
    const observe = byInstrument.get("rea-observe") as LiveOutput;
    const inspect = byInstrument.get("rea-inspect") as LiveOutput;
    const observed = readRecorder(observe.bytes, "observe");
    if ("ok" in observed) return observed;
    const inspected = readRecorder(inspect.bytes, "inspect");
    if ("ok" in inspected) return inspected;
    const derived = observed.window as RowWindow;
    if (observe.window !== null && !sameWindow(observe.window, derived)) return refuse("window-refused", "rea-observe");
    windows.set("rea-observe", derived);
    if (!isWallWindow(inspect.window)) return refuse("window-refused", "rea-inspect");
    windows.set("rea-inspect", inspect.window);
  }

  // The limits, from the capture record alone.
  const inconsistent = record.scripts !== null && scriptLabelsInconsistent(record.scripts, record.siteKey);
  const arming: LiveRowLimit[] = [];
  if (instrumented) {
    if (record.armedFromEnvelopeMs === null) arming.push("recorder-arming-not-reported");
    else if (record.armedFromEnvelopeMs >= 0) arming.push("recorder-armed-after-measurement");
  }
  const containment = record.scripts !== null && record.scripts.some((script) => script.label === "scanner" && script.method === "containment" && script.excess !== null && script.excess > 0);
  const limitsOf = (instrument: LiveInstrument): string[] => {
    if (instrument === "scanner") return [];
    const limits: string[] = [...arming];
    if (instrument !== "runner" && containment) limits.push("script-label-by-containment");
    if (inconsistent) limits.push("script-labels-inconsistent");
    return limits;
  };

  const rows: EvidenceRow[] = [];
  const instruments: InstrumentRecord[] = [];
  for (const instrument of expected) {
    const output = byInstrument.get(instrument) as LiveOutput;
    // G-1: an output over the object bound cannot be stored, so it has no row; the others keep theirs.
    if (output.bytes.length > MAX_EVIDENCE_BYTES) {
      instruments.push({ slot: input.slot, instrument, completeness: "missing", reason: "evidence-too-large" });
      continue;
    }
    rows.push({
      id: `${input.slot.toLowerCase()}-${instrument}`,
      slot: input.slot,
      instrument,
      state: "present",
      window: windows.get(instrument) as RowWindow,
      limits: limitsOf(instrument),
      digest: await sha256Hex(output.bytes),
      observation: null
    });
    instruments.push(
      instrument === "runner" && inconsistent
        ? { slot: input.slot, instrument, completeness: "partial", reason: "script-labels-inconsistent" }
        : { slot: input.slot, instrument, completeness: "complete", reason: null }
    );
  }
  const events: LiveEvent[] = [...rows.map((row) => ({ type: "evidence-recorded" as const, data: { row } })), ...instruments.map((data) => ({ type: "instrument-recorded" as const, data }))];
  return { ok: true, rows, instruments, events, scriptLabels: record.scripts === null ? "none" : inconsistent ? "inconsistent" : "settled" };
}

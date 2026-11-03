// The adapter for one recorded layout: a run folder whose attempts each sit in runs/<run>/, holding
// a harness row (row.json), and, as its recipe ran them, REA's observe-web-execution output
// (observe.json), its inspect-web-page output (inspect.json) with the scripts it saved (exported/),
// and a logger's frames (witness.json). It reads capture files only, never a harness's derived files,
// and script text is read as data to find positions and digests. It is never run.
//
// It is versioned and strict. CAPTURE_ADAPTER names each shape it accepts, the recorder's release,
// commit and package digest among them, and is recorded on every case it makes with the basis its
// recorder identity rests on and what that basis means (recorderIdentityOf in recorder-shapes.ts).
// Two failures stay apart, as M1 kept them. A shape this does not know, a digest that does not match
// its bytes, or an REA output file a row records a call for that is not there (missing-file) refuses
// the whole import. An instrument the recipe names whose output is missing records an incomplete
// attempt with a reason that says so: the row records no call for it, its logger frames file is not
// there, or its one inspection field is empty. So does an observation window REA says ended early,
// and the attempt keeps what it holds.
//
// What it makes is an imported case's run: attempts, rows and the objects read, by digest. A row
// keeps what imported-case.ts says a row keeps. Script and request URLs are read in memory, to match
// the seed's path suffixes and to join a logger frame to a script, and leave as an origin and digests.
// A row's id is built from the attempt, the row's topic and the seed's own label for the script or
// request it is about, or a digest's prefix where the seed names none, so no capture text is in it. A
// second row that would take the same id, as when one URL is evaluated twice or one beacon is sent
// twice, takes the id with -2, -3 and on after it, so the first keeps its id.
//
// A row made from one of REA's outputs carries, as its limits, the limitations REA stated for that
// output, by identifier; a logger row and a connection inspection carry none, and a report read that
// did not read every frame and worker realm says so.
//
// The seed is the owner's data and names the run's attempts, recipes, labeled scripts and requests,
// the source identity it claims and the control run. Nothing here names a site.
//
// The survey for the sufficiency assessment is built from this same reading: each attempt is adapted,
// and what it held, or the refusal it met, is what the survey states. readCaptureRun hands both over
// from one reading, and the import (importCase in imported-case.ts) takes them from there itself.
//
// Pure: it takes bytes already read, keyed by their path inside the run folder, and says which paths
// it still needs, so the local reader opens only those.

import { sha256Hex } from "./canonical-json";
import type { AdaptedRun, AdapterIdentity, ControlRead, ImportedAttempt, ImportedAttemptId, ImportedControl, ImportedInstrument, ImportedObject, ImportedRow, ImportedSource, RequestRef, ScriptRef } from "./imported-case";
import { importedAttemptId, runDigestOf } from "./imported-ids";
import type { WindowEnd } from "./readings";
import {
  checkEvidenceId,
  decodeJson,
  isCount,
  isInsidePath,
  isPlain,
  isShapeRefusal,
  PROVENANCE_PATH,
  readInspectOutput,
  readObserveOutput,
  readProvenance,
  readScriptManifest,
  RECORDER,
  RECORDER_SHAPES,
  recorderIdentityOf,
  shapeRefusal,
  type CoveredFunction,
  type EndReason,
  type ObserveView,
  type RecorderIdentity,
  type ShapeRefusal
} from "./recorder-shapes";
import type { EvidenceKind, KindStatus, Survey } from "./sufficiency";

/** The methods the logger's version 1 wraps. An entry naming any other is a shape this does not know. */
export const LOGGER_APIS = ["canvas.measureText", "audio.createOscillator", "audio.createDynamicsCompressor", "audio.createAnalyser", "webgl.getParameter", "webgl2.getParameter"] as const;

/** The statuses a main document answers a refused visitor with. An attempt whose page answered one of these is walled. */
export const WALL_STATUSES = [401, 403, 429] as const;

export const CAPTURE_ADAPTER: AdapterIdentity = {
  name: "harness-runs",
  version: 1,
  recorder: RECORDER,
  shapes: {
    "runs/<run>/row.json": "harness row 1: startedAt, ms, reportRead with frame and worker counts, readKinds, reportKinds, rea calls by label, error, inspection, mainDocumentStatus",
    "runs/<run>/witness.json": `logger frames 1: isMain, url, value of timeOrigin, overflow and entries of api, frames, count of at least 1, firstMs, lastMs; apis ${LOGGER_APIS.join(", ")}`,
    "runs/<run>/observe.json": RECORDER_SHAPES.observe,
    "runs/<run>/inspect.json": RECORDER_SHAPES.inspect,
    "runs/<run>/exported/manifest.json": RECORDER_SHAPES.scriptManifest,
    limitations: RECORDER_SHAPES.limitations,
    provenance: RECORDER_SHAPES.provenance,
    anchors: "fingerprint anchors 1: canvas-font at measureText with four font names, audio at three node constructors with an offline context, webgl at three debug names with getParameter, at most 500 positions each"
  }
};

const INSTRUMENTS = ["sbl-hooks", "rea-coverage", "rea-inspect", "logger", "sbl-inspect"] as const;
type InstrumentName = (typeof INSTRUMENTS)[number];

const LABEL = /^[a-z][a-z0-9]{0,15}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PLAN_KEYS = ["recorderRelease", "provenancePath", "recipes", "attempts", "identityScripts", "requestTargets", "source", "control"];
const HISTORICAL_KEYS = ["criterionAsWritten", "result", "observed", "gate", "deviation", "preserved"];

export type Matcher = Readonly<{ label: string; pathSuffix: string }>;

/** What the owner's seed says of the run itself. Claims are not here: see ImportSeed. */
export type CapturePlan = Readonly<{
  /** The recorder release the seed says ran. It must be the one this adapter pins, on either basis. */
  recorderRelease: string;
  /** Whether the run holds a provenance record: null, or the one path every layout pins for it (PROVENANCE_PATH). */
  provenancePath: typeof PROVENANCE_PATH | null;
  recipes: readonly Readonly<{ id: string; instruments: readonly string[] }>[];
  attempts: readonly Readonly<{ run: string; recipe: string; sourceIdentity: "not_recorded" | "reconstructed" }>[];
  identityScripts: readonly Matcher[];
  requestTargets: readonly Matcher[];
  source: Readonly<{ baseCommit: string; patch: Readonly<{ path: string; sha256: string }>; identity: string; appliesTo: readonly string[] }> | null;
  control: Readonly<{
    stage0Run: string;
    fixturePath: string;
    fixturePathSuffix: string;
    called: readonly string[];
    uncalled: readonly string[];
    historical: ImportedControl["historical"];
    current: Readonly<{ text: string; note: string }>;
  }> | null;
}>;

/**
 * The bytes read: each path the adapter asked for, mapped to its bytes, or to null where the reader
 * found nothing there. A path that is not a key was never read; where a missing file would be accepted
 * (the pinned provenance path on the declared basis, a recipe logger's frames), such a path is refused
 * instead, so "found nothing" always means the path was read.
 */
export type Files = ReadonlyMap<string, Uint8Array | null>;

export type CaptureRefusal =
  | ShapeRefusal
  | Readonly<{
      ok: false;
      refusal: "plan-malformed" | "recorder-not-pinned" | "matcher-ambiguous" | "instrument-not-run" | "source-mismatch" | "control-script-missing";
      at: string;
    }>;

export type CaptureResult = Readonly<{ ok: true; run: AdaptedRun; digestsRecomputed: number; sourcesNotRead: number }> | CaptureRefusal;

function planRefusal(at: string): CaptureRefusal {
  return { ok: false, refusal: "plan-malformed", at };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isSegment(value: unknown): value is string {
  return isInsidePath(value) && !value.includes("/");
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

function isMatchers(value: unknown): value is readonly Matcher[] {
  return Array.isArray(value) && value.every((entry) => isPlain(entry) && typeof entry.label === "string" && LABEL.test(entry.label) && isText(entry.pathSuffix)) && new Set(value.map(({ label }: Matcher) => label)).size === value.length;
}

/** How a folder name compares on a filesystem that may fold case or composition: two runs that fold to one name are one folder. */
function foldedName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** The plan's own shape, field by field, with exactly the keys CapturePlan names. What fails is named, and what it held is not. */
function planProblem(plan: CapturePlan): string | null {
  if (!isPlain(plan)) return "plan";
  const keys = Object.keys(plan);
  if (keys.length !== PLAN_KEYS.length || !keys.every((key) => PLAN_KEYS.includes(key))) return "plan keys";
  if (typeof plan.recorderRelease !== "string") return "recorderRelease";
  if (plan.provenancePath !== null && plan.provenancePath !== PROVENANCE_PATH) return "provenancePath";
  if (!Array.isArray(plan.recipes) || !plan.recipes.every((recipe) => isPlain(recipe) && isText(recipe.id) && isTextList(recipe.instruments) && recipe.instruments.every((name) => (INSTRUMENTS as readonly string[]).includes(name)))) return "recipes";
  if (!Array.isArray(plan.attempts) || plan.attempts.length === 0 || plan.attempts.length > 9999) return "attempts";
  for (const attempt of plan.attempts) {
    if (!isPlain(attempt) || !isSegment(attempt.run) || !isText(attempt.recipe) || (attempt.sourceIdentity !== "not_recorded" && attempt.sourceIdentity !== "reconstructed")) return "attempts";
    if (!plan.recipes.some(({ id }) => id === attempt.recipe)) return "attempts.recipe";
  }
  if (new Set(plan.attempts.map(({ run }) => foldedName(run))).size !== plan.attempts.length) return "attempts.run";
  if (!isMatchers(plan.identityScripts)) return "identityScripts";
  if (!isMatchers(plan.requestTargets)) return "requestTargets";
  const { source, control } = plan;
  if (source !== null) {
    if (!isPlain(source) || !isText(source.baseCommit) || !isText(source.identity) || !isPlain(source.patch) || !isInsidePath(source.patch.path) || typeof source.patch.sha256 !== "string" || !DIGEST.test(source.patch.sha256) || !isTextList(source.appliesTo)) return "source";
  }
  if (control !== null) {
    if (!isPlain(control) || !isSegment(control.stage0Run) || !isInsidePath(control.fixturePath) || !isText(control.fixturePathSuffix) || !isTextList(control.called) || !isTextList(control.uncalled)) return "control";
    const { historical, current } = control;
    if (!isPlain(historical) || Object.keys(historical).length !== HISTORICAL_KEYS.length || !Object.keys(historical).every((key) => HISTORICAL_KEYS.includes(key)) || !isText(historical.criterionAsWritten) || (historical.result !== "met" && historical.result !== "not_met") || !isPlain(historical.observed) || !Object.values(historical.observed).every((value) => typeof value === "string") || typeof historical.gate !== "string" || typeof historical.deviation !== "string" || typeof historical.preserved !== "boolean") return "control.historical";
    if (!isPlain(current) || typeof current.text !== "string" || typeof current.note !== "string") return "control.current";
  }
  return null;
}

function runPath(run: string, file: string): string {
  return `runs/${run}/${file}`;
}

type CallLabels = ReadonlySet<string>;

/** The labels of the recorder calls a row says its attempt made, or null when the row cannot say. */
function callLabelsOf(row: unknown): CallLabels | null {
  if (!isPlain(row) || !Array.isArray(row.rea)) return null;
  const labels = new Set<string>();
  for (const call of row.rea) {
    if (!isPlain(call) || typeof call.label !== "string") return null;
    labels.add(call.label);
  }
  return labels;
}

/**
 * The paths this run still needs read, given what has been read so far: each attempt's row first,
 * then what its row and recipe say it holds, then the scripts a manifest names. Ask again with what
 * came back until this is empty. A path is only ever one inside the run folder.
 */
export function capturePathsNeeded(plan: CapturePlan, files: Files): readonly string[] {
  if (planProblem(plan) !== null) return [];
  const wanted: string[] = [];
  const want = (file: string): void => {
    if (!files.has(file) && !wanted.includes(file)) wanted.push(file);
  };
  // The pinned path is always asked for, so a run the seed calls declared is seen to hold no record there.
  want(PROVENANCE_PATH);
  if (plan.source !== null) want(plan.source.patch.path);
  if (plan.control !== null) {
    want(runPath(plan.control.stage0Run, "observe.json"));
    want(plan.control.fixturePath);
  }
  for (const attempt of plan.attempts) {
    const rowFile = runPath(attempt.run, "row.json");
    want(rowFile);
    const labels = callLabelsOf(decodeJson(rowFile, files.get(rowFile)));
    if (labels === null) continue;
    const instruments = plan.recipes.find(({ id }) => id === attempt.recipe)?.instruments ?? [];
    if (instruments.includes("logger")) want(runPath(attempt.run, "witness.json"));
    if (labels.has("observe")) {
      want(runPath(attempt.run, "observe.json"));
      continue;
    }
    if (!labels.has("inspect")) continue;
    want(runPath(attempt.run, "inspect.json"));
    const manifestFile = runPath(attempt.run, "exported/manifest.json");
    want(manifestFile);
    const manifest = readScriptManifest(manifestFile, decodeJson(manifestFile, files.get(manifestFile)));
    if (isShapeRefusal(manifest)) continue;
    for (const { relativePath } of manifest) want(runPath(attempt.run, `exported/files/${relativePath}`));
  }
  return wanted;
}

const FP_KINDS = ["canvas-font-fingerprinting", "audio-fingerprinting", "webgl-fingerprinting", "canvas-fingerprinting", "webrtc-fingerprinting"];
const FONT_MARKERS = ["monospace", "sans-serif", "serif", "Arial", "Courier", "Times", "Helvetica", "Georgia", "Verdana"];
const ANCHOR_SETS: readonly Readonly<{ kind: string; anchors: readonly string[]; requires: (text: string) => boolean }>[] = [
  { kind: "canvas-font", anchors: ["measureText"], requires: (text) => FONT_MARKERS.filter((marker) => text.includes(marker)).length >= 4 },
  { kind: "audio", anchors: ["createDynamicsCompressor", "createOscillator", "createAnalyser"], requires: (text) => text.includes("OfflineAudioContext") || text.includes("webkitOfflineAudioContext") },
  { kind: "webgl", anchors: ["WEBGL_debug_renderer_info", "UNMASKED_RENDERER_WEBGL", "UNMASKED_VENDOR_WEBGL"], requires: (text) => text.includes("getParameter") }
];
const MAX_POSITIONS = 500;

/** The scanner's fingerprinting kinds a list names, each once, in order. A list that is not one of strings is a shape this does not know. */
function fpKinds(kinds: readonly string[]): readonly string[] {
  return [...new Set(kinds)].filter((kind) => FP_KINDS.includes(kind)).sort();
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function positions(text: string, needle: string): number[] {
  const out: number[] = [];
  let at = text.indexOf(needle);
  while (at !== -1 && out.length < MAX_POSITIONS) {
    out.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

type Covering = Readonly<{ functionStart: number; functionEnd: number; functionCount: number; blockCount: number }>;

/** The smallest function whose first range holds the offset, and the smallest of its ranges holding it. */
function innermost(functions: readonly CoveredFunction[], offset: number): Covering | null {
  let best: { fn: CoveredFunction; size: number } | null = null;
  for (const fn of functions) {
    const span = fn.ranges[0];
    if (span.start > offset || span.end <= offset) continue;
    const size = span.end - span.start;
    if (best === null || size < best.size) best = { fn, size };
  }
  if (best === null) return null;
  let block = best.fn.ranges[0];
  for (const range of best.fn.ranges) {
    if (range.start <= offset && offset < range.end && range.end - range.start <= block.end - block.start) block = range;
  }
  return { functionStart: best.fn.ranges[0].start, functionEnd: best.fn.ranges[0].end, functionCount: best.fn.ranges[0].count, blockCount: block.count };
}

/** A one-based line and column in text, as a zero-based offset, or null past the last line. */
function offsetOf(text: string, line1: number, column1: number): number | null {
  let at = 0;
  for (let line = 1; line < line1; line += 1) {
    const next = text.indexOf("\n", at);
    if (next === -1) return null;
    at = next + 1;
  }
  return at + column1 - 1;
}

function noQuery(url: string): string {
  return url.split("?")[0];
}

const ORIGIN = /^(?:https?|wss?):\/\/(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/;

function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Scheme, host and port as a URL parser spells them, by the summary tier's rule, or null. */
export function originOfUrl(url: string): string | null {
  const value = parsed(url);
  if (value === null || value.origin === "null") return null;
  return ORIGIN.test(value.origin) ? value.origin : null;
}

async function textDigest(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

async function pathDigestOf(url: string): Promise<string | null> {
  const value = parsed(url);
  return value === null ? null : textDigest(value.pathname);
}

function pathOf(url: string): string | null {
  return parsed(url)?.pathname ?? null;
}

async function scriptRef(url: string, digest: string | null): Promise<ScriptRef> {
  return { origin: originOfUrl(url), pathDigest: await pathDigestOf(url), textDigest: digest };
}

/** The first matcher whose suffix ends the URL's path, or null. */
function matcherFor(matchers: readonly Matcher[], url: string): Matcher | null {
  const path = pathOf(url);
  return path === null ? null : (matchers.find(({ pathSuffix }) => path.endsWith(pathSuffix)) ?? null);
}

/** The seed's label for a script, or p and twelve digits of its path's digest. */
async function labelFor(plan: CapturePlan, url: string): Promise<string> {
  const matcher = matcherFor(plan.identityScripts, url);
  if (matcher !== null) return matcher.label;
  const digest = await pathDigestOf(url);
  return digest === null ? "unparsed" : `p${digest.slice(0, 12)}`;
}

type Script = Readonly<{ url: string; sha: string | null; text: string | null; coverage: readonly CoveredFunction[] | null; start: Readonly<{ line: number; column: number }> | null }>;

type LoggerEntry = Readonly<{ api: string; frames: readonly Readonly<{ origin: string; path: string; line: number; column: number; viaEval: boolean }>[]; count: number; firstMs: number; lastMs: number }>;

function loggerEntries(file: string, value: unknown): readonly LoggerEntry[] | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!Array.isArray(value)) return shapeRefusal(file, "frames");
  let main = 0;
  const entries: LoggerEntry[] = [];
  for (const frame of value) {
    if (!isPlain(frame) || typeof frame.isMain !== "boolean" || (frame.value !== null && typeof frame.value !== "string")) return shapeRefusal(file, "frames");
    if (frame.value === null || frame.value === "") {
      if (frame.isMain) return shapeRefusal(file, "the main frame's value");
      continue;
    }
    const data = decodeJson(file, new TextEncoder().encode(frame.value));
    if (isShapeRefusal(data)) return shapeRefusal(file, "frames.value");
    if (!isPlain(data) || typeof data.timeOrigin !== "number" || !Array.isArray(data.entries)) return shapeRefusal(file, "frames.value");
    if (frame.isMain) main += 1;
    for (const entry of data.entries) {
      // An entry is a call the logger saw, so it counts at least one.
      if (!isPlain(entry) || !(LOGGER_APIS as readonly unknown[]).includes(entry.api) || !isCount(entry.count) || entry.count < 1 || !isCount(entry.firstMs) || !isCount(entry.lastMs) || !Array.isArray(entry.frames)) return shapeRefusal(file, "entries");
      const frames: LoggerEntry["frames"][number][] = [];
      for (const call of entry.frames) {
        if (!isPlain(call) || typeof call.origin !== "string" || typeof call.path !== "string" || !isCount(call.line) || !isCount(call.column) || typeof call.viaEval !== "boolean") return shapeRefusal(file, "entries.frames");
        frames.push({ origin: call.origin, path: call.path, line: call.line, column: call.column, viaEval: call.viaEval });
      }
      entries.push({ api: entry.api as string, frames, count: entry.count, firstMs: entry.firstMs, lastMs: entry.lastMs });
    }
  }
  return main === 1 ? entries : shapeRefusal(file, "the main frame");
}

type LoggerGroup = { api: string; url: string | null; count: number; first: number; last: number; inside: number; ranges: Map<string, readonly [number, number, number]> };

/**
 * Attribution is the nearest stack frame with an http(s) address, as the logger kept it. A call is
 * inside an executed range when its position falls in a function REA counted above 0 and in a block of
 * it REA counted above 0, in this attempt.
 */
function joinLogger(entries: readonly LoggerEntry[], scripts: readonly Script[]): readonly LoggerGroup[] {
  const byUrl = new Map<string, Script[]>();
  for (const script of scripts) {
    if (script.text === null) continue;
    byUrl.set(script.url, [...(byUrl.get(script.url) ?? []), script]);
  }
  const groups = new Map<string, LoggerGroup>();
  for (const entry of entries) {
    const [top] = entry.frames;
    const url = top === undefined ? null : `${top.origin}${top.path}`;
    const key = `${entry.api}|${url ?? ""}`;
    const group = groups.get(key) ?? { api: entry.api, url, count: 0, first: entry.firstMs, last: entry.lastMs, inside: 0, ranges: new Map() };
    groups.set(key, group);
    group.count += entry.count;
    group.first = Math.min(group.first, entry.firstMs);
    group.last = Math.max(group.last, entry.lastMs);
    if (top === undefined || top.viaEval || url === null) continue;
    for (const candidate of byUrl.get(url) ?? []) {
      // A script whose start REA did not state has no position to place a frame at, so it cannot hold one.
      if (candidate.start === null) continue;
      const line = top.line - candidate.start.line;
      const column = line === 1 ? top.column - candidate.start.column : top.column;
      const offset = line >= 1 && column >= 1 ? offsetOf(candidate.text as string, line, column) : null;
      if (offset === null || candidate.coverage === null) continue;
      const same = innermost(candidate.coverage, offset);
      if (same === null) continue;
      if (same.functionCount > 0 && same.blockCount > 0) {
        group.inside += entry.count;
        const range = [same.functionStart, same.functionEnd, same.blockCount] as const;
        group.ranges.set(range.join(","), range);
      }
      break;
    }
  }
  return [...groups.values()];
}

type RowFile = Readonly<{
  startedAt: string;
  ms: number;
  error: boolean;
  reportKinds: readonly string[];
  laterKinds: readonly string[];
  /** Whether the report read reached every frame and worker realm it tried, with nothing withheld. */
  readComplete: boolean;
  calls: CallLabels;
  inspection: Readonly<{ address: string; counts: Readonly<Record<string, number>> }> | null | undefined;
  mainDocumentStatus: number | null;
}>;

const INSPECTION_COUNTS = ["matched", "withoutStack", "withoutNamedScript", "notListed", "unobserved", "redirected"] as const;
const READ_COUNTS = ["summaryWithheldFrames", "attemptedFrames", "readableFrames", "attemptedWorkerRealms", "readableWorkerRealms"] as const;

function readRowFile(file: string, value: unknown): RowFile | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value)) return shapeRefusal(file, "row");
  const startedMs = typeof value.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN;
  if (!Number.isSafeInteger(startedMs) || !isCount(value.ms)) return shapeRefusal(file, "startedAt or ms");
  if (!isPlain(value.reportRead) || !Array.isArray(value.readKinds)) return shapeRefusal(file, "reportRead or readKinds");
  for (const name of READ_COUNTS) {
    if (!isCount(value.reportRead[name])) return shapeRefusal(file, `reportRead.${name}`);
  }
  if (!isStringList(value.reportKinds)) return shapeRefusal(file, "reportKinds");
  const calls = callLabelsOf(value);
  if (calls === null) return shapeRefusal(file, "rea");
  if (value.error !== undefined && value.error !== null && typeof value.error !== "string") return shapeRefusal(file, "error");
  const later: string[] = [];
  for (const read of value.readKinds) {
    if (!isPlain(read) || !isStringList(read.main) || !isStringList(read.frames) || !isStringList(read.workers)) return shapeRefusal(file, "readKinds");
    later.push(...read.main, ...read.frames, ...read.workers);
  }
  const report = fpKinds(value.reportKinds);
  let inspection: RowFile["inspection"];
  if (value.inspection === undefined || value.inspection === null) inspection = value.inspection as null | undefined;
  else {
    const raw = value.inspection;
    if (!isPlain(raw) || typeof raw.address !== "string" || !Array.isArray(raw.groups)) return shapeRefusal(file, "inspection");
    const counts: Record<string, number> = { groups: raw.groups.length };
    for (const name of INSPECTION_COUNTS) {
      if (!isCount(raw[name])) return shapeRefusal(file, `inspection.${name}`);
      counts[name] = raw[name] as number;
    }
    inspection = { address: raw.address, counts };
  }
  const status = value.mainDocumentStatus;
  const read = value.reportRead as Record<(typeof READ_COUNTS)[number], number>;
  return {
    // The parser's own spelling of the time, never the row's: a date string can carry a comment.
    startedAt: new Date(startedMs).toISOString(),
    ms: value.ms,
    error: typeof value.error === "string" && value.error !== "",
    reportKinds: report,
    laterKinds: fpKinds(later).filter((kind) => !report.includes(kind)),
    readComplete: read.summaryWithheldFrames === 0 && read.readableFrames === read.attemptedFrames && read.readableWorkerRealms === read.attemptedWorkerRealms,
    calls,
    inspection,
    mainDocumentStatus: isCount(status) ? status : null
  };
}

type Builder = { rows: ImportedRow[]; ids: Set<string> };

/** A row, under its id or, when that id is taken in this attempt, under its id with the first free -2, -3 and on. */
function add(builder: Builder, row: ImportedRow): void {
  let id = row.id;
  for (let n = 2; builder.ids.has(id); n += 1) id = `${row.id}-${n}`;
  builder.ids.add(id);
  builder.rows.push(id === row.id ? row : { ...row, id });
}

/**
 * A saved script's file mirrors its URL's path, so it is never named by that path: it is the
 * manifest's entry for its script key, which is REA's own id. The case's objects, every refusal and the
 * local reader's refusals use this name.
 */
function savedName(manifestFile: string, scriptKey: string): string {
  return `${manifestFile}#${scriptKey}`;
}

type Saved = Readonly<{ url: string; sha: string; file: string }>;

/** The scripts a source-identity capture saved, each digest recomputed from the saved bytes, each saved for the script inspected under its key. */
async function passiveScripts(run: string, files: Files, digests: ReadonlyMap<string, string>): Promise<Readonly<{ scripts: readonly Saved[]; limitations: readonly string[] }> | ShapeRefusal> {
  const inspectFile = runPath(run, "inspect.json");
  const decoded = decodeJson(inspectFile, files.get(inspectFile));
  const inspect = readInspectOutput(inspectFile, decoded);
  if (isShapeRefusal(inspect)) return inspect;
  const named = await checkEvidenceId(inspectFile, decoded);
  if (named !== null) return named;
  const manifestFile = runPath(run, "exported/manifest.json");
  const manifest = readScriptManifest(manifestFile, decodeJson(manifestFile, files.get(manifestFile)));
  if (isShapeRefusal(manifest)) return manifest;
  const byKey = new Map(manifest.map((entry) => [entry.scriptKey, entry]));
  const out: Saved[] = [];
  for (const item of inspect.scripts) {
    const saved = byKey.get(item.scriptKey);
    if (saved === undefined) return shapeRefusal(manifestFile, "no saved file for an inspected script");
    // The file saved under a key must be the script inspected under it, by its address.
    if (noQuery(saved.url) !== noQuery(item.url)) return shapeRefusal(savedName(manifestFile, item.scriptKey), "the saved script's address");
    const file = runPath(run, `exported/files/${saved.relativePath}`);
    const digest = digests.get(file);
    if (digest === undefined) return shapeRefusal(savedName(manifestFile, item.scriptKey), "the saved script", "missing-file");
    if (digest !== saved.sha256) return shapeRefusal(savedName(manifestFile, item.scriptKey), "the saved script's digest", "digest-mismatch");
    out.push({ url: noQuery(item.url), sha: saved.sha256, file });
  }
  return { scripts: out, limitations: inspect.limitations };
}

/** Each saved script's file, by the name the case gives it: the manifest's entry for its key. The local reader names a file by this in a refusal. */
export function capturePathNames(plan: CapturePlan, files: Files): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  if (planProblem(plan) !== null) return names;
  for (const { run } of plan.attempts) {
    const manifestFile = runPath(run, "exported/manifest.json");
    if (!files.has(manifestFile)) continue;
    const manifest = readScriptManifest(manifestFile, decodeJson(manifestFile, files.get(manifestFile)));
    if (isShapeRefusal(manifest)) continue;
    for (const { relativePath, scriptKey } of manifest) names.set(runPath(run, `exported/files/${relativePath}`), savedName(manifestFile, scriptKey));
  }
  return names;
}

function observedScripts(view: ObserveView): readonly Script[] {
  return view.sources.map((source) => ({
    url: noQuery(source.url),
    sha: source.state === "captured" ? source.sha256 : null,
    text: source.state === "captured" ? source.text : null,
    coverage: view.coverage.get(source.scriptId) ?? null,
    start: source.resourceStart
  }));
}

async function checkSources(file: string, view: ObserveView): Promise<ShapeRefusal | number> {
  let checked = 0;
  for (const source of view.sources) {
    if (source.state !== "captured") continue;
    if ((await textDigest(source.text)) !== source.sha256) return shapeRefusal(file, "a captured source's digest", "digest-mismatch");
    checked += 1;
  }
  return checked;
}

/** How a window REA says ended reads in W2's words: elapsed is closed, a changed document cut it short, a terminated target crashed. */
function windowEndOf(reason: EndReason): WindowEnd {
  if (reason === "window_elapsed") return "window_closed";
  return reason === "document_changed" ? "truncated" : "target_crashed";
}

/** What one attempt held, for the survey: whose evidence is there to read, counted. */
type Held = Readonly<{ capturedScripts: number; coveredScripts: number; observed: boolean; requestsKept: boolean; framesWithAddress: number }>;

type AttemptOut = Readonly<{ attempt: ImportedAttempt; rows: readonly ImportedRow[]; digestsRecomputed: number; notRead: number; recorderOutputs: number; held: Held }>;

/** One attempt, read as its recipe says it ran. */
async function adaptAttempt(plan: CapturePlan, index: number, files: Files, digests: ReadonlyMap<string, string>): Promise<AttemptOut | CaptureRefusal> {
  const builder: Builder = { rows: [], ids: new Set() };
  const planned = plan.attempts[index];
  const id: ImportedAttemptId = importedAttemptId(index);
  const rowFile = runPath(planned.run, "row.json");
  const row = readRowFile(rowFile, decodeJson(rowFile, files.get(rowFile)));
  if (isShapeRefusal(row)) return row;
  const recipeInstruments = (plan.recipes.find(({ id: recipe }) => recipe === planned.recipe) as CapturePlan["recipes"][number]).instruments;
  const instruments = new Map<InstrumentName, ImportedInstrument>([["sbl-hooks", { name: "sbl-hooks", completeness: "complete", reason: null, cleanup: null, recorderLimitations: null }]]);
  const walled = row.mainDocumentStatus !== null && (WALL_STATUSES as readonly number[]).includes(row.mainDocumentStatus);
  let acquisition: ImportedAttempt["acquisition"] = row.error ? "failed" : walled ? "walled" : "usable";
  let acquisitionReason: string | null = row.error ? "the recorded row holds an error" : walled ? `the main document answered ${row.mainDocumentStatus}` : null;
  const incomplete = (reason: string): void => {
    if (acquisition !== "usable") return;
    acquisition = "incomplete";
    acquisitionReason = reason;
  };
  let digestsRecomputed = 0;
  let notRead = 0;
  let recorderOutputs = 0;
  const rowDigest = digests.get(rowFile) as string;

  let observed: ObserveView | null = null;
  const observeFile = runPath(planned.run, "observe.json");
  if (row.calls.has("observe")) {
    const decoded = decodeJson(observeFile, files.get(observeFile));
    const view = readObserveOutput(observeFile, decoded);
    if (isShapeRefusal(view)) return view;
    const named = await checkEvidenceId(observeFile, decoded);
    if (named !== null) return named;
    const checked = await checkSources(observeFile, view);
    if (typeof checked !== "number") return checked;
    digestsRecomputed += checked;
    recorderOutputs += 1;
    notRead += view.sources.filter(({ state }) => state === "excluded").length;
    observed = view;
    instruments.set("rea-coverage", {
      name: "rea-coverage",
      completeness: "partial",
      reason: `excluded ${view.excludedScripts} scripts and ${view.excludedRequests} requests; ${view.notReported} scripts without a coverage record; the selected main frame and origins only; nothing before arming`,
      cleanup: view.cleanup,
      recorderLimitations: view.limitations
    });
    if (view.endReason !== "window_elapsed") incomplete(`REA's observation window ended early: ${view.endReason}`);
  }
  if (row.calls.has("inspect")) instruments.set("rea-inspect", { name: "rea-inspect", completeness: "partial", reason: "the selected origins only, as attaching allowed; WebAssembly bytecode excluded", cleanup: null, recorderLimitations: null });

  let loggerEntriesRead: readonly LoggerEntry[] | null = null;
  const witnessFile = runPath(planned.run, "witness.json");
  if (recipeInstruments.includes("logger")) {
    const witness = files.get(witnessFile);
    const entries = witness === undefined ? shapeRefusal(witnessFile, "the file, which was never read") : loggerEntries(witnessFile, decodeJson(witnessFile, witness));
    if (isShapeRefusal(entries) && entries.refusal === "missing-file") {
      // The recipe names the logger and its frames are not there: its output is missing, which records an incomplete attempt.
      const reason = "the recipe names logger, and its frames file is missing, so its output is missing";
      incomplete(reason);
      instruments.set("logger", { name: "logger", completeness: "missing", reason, cleanup: null, recorderLimitations: null });
    } else if (isShapeRefusal(entries)) return entries;
    else {
      loggerEntriesRead = entries;
      instruments.set("logger", { name: "logger", completeness: "partial", reason: "the wrapped methods only; frames without a URL discarded, and not counted", cleanup: null, recorderLimitations: null });
    }
  }
  if (recipeInstruments.includes("sbl-inspect")) {
    if (row.inspection === null || row.inspection === undefined) {
      // A known shape with its output missing: no row, and the attempt says why.
      const reason = "the recorded row holds no output for an instrument its recipe names";
      incomplete(reason);
      instruments.set("sbl-inspect", { name: "sbl-inspect", completeness: "missing", reason, cleanup: null, recorderLimitations: null });
    } else {
      instruments.set("sbl-inspect", { name: "sbl-inspect", completeness: "complete", reason: null, cleanup: null, recorderLimitations: null });
      add(builder, {
        id: `E-${id}-inspect`,
        attempt: id,
        topic: "connection-inspection",
        instrument: "sbl-inspect",
        state: "present",
        window: { clock: null, note: "stops at the request log's freeze, whose time was not recorded" },
        limits: [],
        digest: rowDigest,
        observation: null,
        address: { origin: originOfUrl(row.inspection.address), pathDigest: await pathDigestOf(row.inspection.address) },
        counts: row.inspection.counts
      });
    }
  }
  for (const name of recipeInstruments) {
    if (instruments.has(name as InstrumentName)) continue;
    // The recipe names it and the row records no call for it: its output is missing, which records an incomplete attempt, as M1 kept it.
    const reason = `the recipe names ${name}, and the row records no call for it, so its output is missing`;
    incomplete(reason);
    instruments.set(name as InstrumentName, { name, completeness: "missing", reason, cleanup: null, recorderLimitations: null });
  }

  add(builder, {
    id: `E-${id}-read`,
    attempt: id,
    topic: "report-read",
    instrument: "sbl-hooks",
    state: "present",
    window: { clock: "harness", startMs: 0, endMs: row.ms },
    limits: row.readComplete ? [] : ["read_incomplete"],
    digest: rowDigest,
    observation: null,
    reportKinds: row.reportKinds,
    laterKinds: row.laterKinds
  });

  // Script identity, from whichever capture this attempt holds: what coverage captured, or else what an inspection saved.
  let captured: readonly Readonly<{ url: string; sha: string; digest: string }>[] = [];
  let identityInstrument: InstrumentName = "rea-coverage";
  let identityLimits: readonly string[] = [];
  if (observed !== null) {
    const observeDigest = digests.get(observeFile) as string;
    captured = observed.sources.flatMap((source) => (source.state === "captured" ? [{ url: noQuery(source.url), sha: source.sha256, digest: observeDigest }] : []));
    identityLimits = observed.limitations;
  } else if (row.calls.has("inspect")) {
    const passive = await passiveScripts(planned.run, files, digests);
    if (isShapeRefusal(passive)) return passive;
    digestsRecomputed += passive.scripts.length;
    recorderOutputs += 1;
    captured = passive.scripts.map(({ url, sha, file }) => ({ url, sha, digest: digests.get(file) as string }));
    identityInstrument = "rea-inspect";
    identityLimits = passive.limitations;
    instruments.set("rea-inspect", { ...(instruments.get("rea-inspect") as ImportedInstrument), recorderLimitations: passive.limitations });
  }
  const named = new Map<string, Readonly<{ url: string; sha: string; digest: string }>>();
  for (const script of captured) {
    for (const matcher of plan.identityScripts) {
      const path = pathOf(script.url);
      if (path === null || !path.endsWith(matcher.pathSuffix)) continue;
      const already = named.get(matcher.label);
      if (already !== undefined && (already.url !== script.url || already.sha !== script.sha)) return { ok: false, refusal: "matcher-ambiguous", at: `identityScripts ${matcher.label}, attempt ${id}` };
      named.set(matcher.label, script);
    }
  }
  for (const [label, script] of named) {
    add(builder, {
      id: `E-${id}-identity-${label}`,
      attempt: id,
      topic: "script-identity",
      instrument: identityInstrument,
      state: "present",
      window: { clock: null, note: "captured by this attempt's recorder call" },
      limits: identityLimits,
      digest: script.digest,
      observation: null,
      script: await scriptRef(script.url, script.sha)
    });
  }

  let framesWithAddress = 0;
  if (observed !== null) {
    const observeDigest = digests.get(observeFile) as string;
    const window = { clock: "wall", startMs: observed.armedAtMs, endMs: observed.endedAtMs } as const;
    const windowEnd = windowEndOf(observed.endReason);
    const limits = observed.limitations;
    const scripts = observedScripts(observed);
    for (const script of scripts) {
      if (script.text === null) continue;
      const text = script.text;
      for (const { kind, anchors, requires } of ANCHOR_SETS) {
        if (!requires(text)) continue;
        for (const anchor of anchors) {
          for (const offset of positions(text, anchor)) {
            const covering = script.coverage === null ? null : innermost(script.coverage, offset);
            add(builder, {
              id: `E-${id}-cov-${await labelFor(plan, script.url)}-${kind}-${offset}`,
              attempt: id,
              topic: "anchor-coverage",
              instrument: "rea-coverage",
              // Missing coverage is not zero: no covering function is no record.
              state: covering === null ? "no_record" : "present",
              window,
              limits,
              digest: covering === null ? null : observeDigest,
              observation: covering === null ? null : { subject: "anchor-executions", count: covering.functionCount > 0 ? covering.blockCount : 0, granularity: "block", windowEnd, scope: "in_scope" },
              script: await scriptRef(script.url, script.sha),
              anchor,
              offset
            });
          }
        }
      }
    }
    for (const request of observed.requests) {
      const target = matcherFor(plan.requestTargets, noQuery(request.url));
      if (target === null) continue;
      const requestRef: RequestRef = { method: request.method, origin: originOfUrl(request.url), pathDigest: await pathDigestOf(noQuery(request.url)) };
      add(builder, {
        id: `E-${id}-req-${target.label}`,
        attempt: id,
        topic: "request",
        instrument: "rea-coverage",
        state: "present",
        window,
        limits,
        digest: observeDigest,
        observation: null,
        request: requestRef,
        callsite: request.callsiteUrl === null ? null : await scriptRef(noQuery(request.callsiteUrl), null),
        causalAttribution: request.causalAttribution
      });
    }
    if (loggerEntriesRead !== null) {
      const witnessDigest = digests.get(witnessFile) as string;
      framesWithAddress = loggerEntriesRead.filter(({ frames }) => frames.length > 0).length;
      for (const group of joinLogger(loggerEntriesRead, scripts)) {
        const label = group.url === null ? "none" : await labelFor(plan, group.url);
        const script = group.url === null ? null : await scriptRef(group.url, null);
        add(builder, {
          id: `E-${id}-logger-${label}-${group.api}`,
          attempt: id,
          topic: "attributed-calls",
          instrument: "logger",
          state: "present",
          window: { clock: "page", startMs: group.first, endMs: group.last },
          limits: [],
          digest: witnessDigest,
          observation: null,
          api: group.api,
          script,
          calls: group.count
        });
        const ranges = [...group.ranges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        add(builder, {
          id: `E-${id}-link-${label}-${group.api}`,
          attempt: id,
          topic: "calls-in-executed-ranges",
          instrument: "logger+rea-coverage",
          // Every call inside a range REA reported executed in this attempt, or no record: across two clocks nothing says when the rest ran.
          state: group.inside === group.count ? "present" : "no_record",
          window: { clock: null, note: "the same attempt only" },
          limits,
          digest: null,
          observation: null,
          api: group.api,
          script,
          calls: group.count,
          inside: group.inside,
          ranges,
          joined: [witnessDigest, observeDigest]
        });
      }
    }
  }
  for (const row of builder.rows) {
    for (const part of row.instrument.split("+")) {
      if (!recipeInstruments.includes(part)) return { ok: false, refusal: "instrument-not-run", at: `attempt ${row.attempt}` };
    }
  }
  return {
    attempt: {
      id,
      run: planned.run,
      recipe: planned.recipe,
      startedAt: row.startedAt,
      durationMs: row.ms,
      acquisition,
      acquisitionReason,
      page: { status: row.mainDocumentStatus },
      instruments: INSTRUMENTS.flatMap((name) => {
        const instrument = instruments.get(name);
        return instrument === undefined ? [] : [instrument];
      }),
      sourceIdentity: planned.sourceIdentity
    },
    rows: builder.rows,
    digestsRecomputed,
    notRead,
    recorderOutputs,
    held: {
      capturedScripts: captured.length,
      coveredScripts: observed === null ? 0 : observed.coverage.size,
      observed: observed !== null,
      requestsKept: observed !== null,
      framesWithAddress
    }
  };
}

function readsAsCalled(functions: readonly CoveredFunction[], name: string): ControlRead {
  return { name, readsAs: functions.some((fn) => fn.name === name && fn.ranges[0].count > 0) ? "executed" : "not executed" };
}

function readsAsUncalled(functions: readonly CoveredFunction[], text: string, name: string): ControlRead {
  const at = text.indexOf(`function ${name}`);
  const hit = at === -1 ? null : innermost(functions, at);
  const named = functions.find((fn) => fn.name === name);
  const count = named !== undefined ? named.ranges[0].count : hit !== null ? hit.functionCount : null;
  return { name, readsAs: count === null ? "no record" : count === 0 ? "count 0" : "false execution claim" };
}

/**
 * The current control criterion, read from the control run's own capture: known executed routines
 * reported executed, an uncalled one with a count above 0 a false execution claim, missing coverage
 * for an uncalled one unknown, and the fixture's digest matching what was captured.
 */
async function controlOf(plan: CapturePlan, files: Files, digests: ReadonlyMap<string, string>): Promise<ImportedControl | CaptureRefusal | null> {
  const { control } = plan;
  if (control === null) return null;
  const file = runPath(control.stage0Run, "observe.json");
  const decoded = decodeJson(file, files.get(file));
  const view = readObserveOutput(file, decoded);
  if (isShapeRefusal(view)) return view;
  const named = await checkEvidenceId(file, decoded);
  if (named !== null) return named;
  const fixture = view.sources.find((source) => source.state === "captured" && noQuery(source.url).endsWith(control.fixturePathSuffix));
  const coverage = fixture === undefined ? undefined : view.coverage.get(fixture.scriptId);
  if (fixture === undefined || fixture.state !== "captured" || coverage === undefined) return { ok: false, refusal: "control-script-missing", at: file };
  const fixtureDigest = digests.get(control.fixturePath);
  if (fixtureDigest === undefined) return shapeRefusal(control.fixturePath, "the fixture", "missing-file");
  const digestMatches = fixtureDigest === fixture.sha256;
  const called = control.called.map((name) => readsAsCalled(coverage, name));
  const uncalled = control.uncalled.map((name) => readsAsUncalled(coverage, fixture.text, name));
  const met = digestMatches && called.every(({ readsAs }) => readsAs === "executed") && uncalled.every(({ readsAs }) => readsAs !== "false execution claim");
  // The historical record is rebuilt field by field, so the case holds none of the caller's objects.
  const { criterionAsWritten, result, observed, gate, deviation, preserved } = control.historical;
  return { historical: { criterionAsWritten, result, observed: { ...observed }, gate, deviation, preserved }, current: { text: control.current.text, note: control.current.note, sameOutputWouldRead: met ? "met" : "not_met", digestMatches, called, uncalled }, recorderLimitations: view.limitations };
}

/** A reconstructed identity covers exactly the attempts marked reconstructed, and the patch it rests on is the one the seed names, byte for byte. */
function sourceOf(plan: CapturePlan, attempts: readonly ImportedAttempt[], digests: ReadonlyMap<string, string>): ImportedSource | CaptureRefusal | null {
  const reconstructed = attempts.filter(({ sourceIdentity }) => sourceIdentity === "reconstructed").map(({ id }) => id);
  const { source } = plan;
  if (source === null) return reconstructed.length === 0 ? null : { ok: false, refusal: "source-mismatch", at: "attempts.sourceIdentity" };
  const digest = digests.get(source.patch.path);
  if (digest === undefined) return shapeRefusal(source.patch.path, "the patch", "missing-file");
  if (digest !== source.patch.sha256) return { ok: false, refusal: "source-mismatch", at: "source.patch.sha256" };
  if (source.appliesTo.length !== reconstructed.length || !source.appliesTo.every((id, index) => id === reconstructed[index])) return { ok: false, refusal: "source-mismatch", at: "source.appliesTo" };
  return { state: "reconstructed", baseCommit: source.baseCommit, patch: { path: source.patch.path, sha256: source.patch.sha256 }, identity: source.identity, appliesTo: reconstructed };
}

/**
 * Every file read, by its name, digest and size, in name order. A file asked for and absent is not
 * here. A saved script is named by its manifest entry, never by the path that mirrors its URL, and a
 * file under exported/files that no manifest names is named only as unlisted.
 */
async function objectsOf(plan: CapturePlan, files: Files): Promise<Readonly<{ objects: readonly ImportedObject[]; digests: ReadonlyMap<string, string> }>> {
  const names = capturePathNames(plan, files);
  const objects: ImportedObject[] = [];
  const digests = new Map<string, string>();
  for (const path of files.keys()) {
    const bytes = files.get(path);
    if (bytes === null || bytes === undefined) continue;
    const digest = await sha256Hex(new Uint8Array(bytes));
    digests.set(path, digest);
    const saved = /^(runs\/[^/]+\/exported)\/files\//.exec(path);
    objects.push({ path: names.get(path) ?? (saved === null ? path : `${saved[1]}/files#unlisted`), digest, bytes: bytes.length });
  }
  objects.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.digest < b.digest ? -1 : 1));
  return { objects, digests };
}

/** A refusal that came from reading a recorder output rather than a harness file. */
function isRecorderRefusal(refusal: CaptureRefusal): refusal is ShapeRefusal {
  return isShapeRefusal(refusal) && /(?:observe|inspect)\.json(?:#[^:]*)?: /.test(refusal.at);
}

type RunReading = Readonly<{
  objects: readonly ImportedObject[];
  runDigest: string;
  outcomes: readonly (AttemptOut | CaptureRefusal)[];
  identity: RecorderIdentity;
  result: CaptureResult;
}>;

/** The whole run as this adapter reads it: each attempt on its own, then what holds across them. The import and the survey both rest on this one reading. */
async function readRun(plan: CapturePlan, files: Files): Promise<RunReading> {
  const { objects, digests } = await objectsOf(plan, files);
  const runDigest = await runDigestOf(objects);
  const outcomes: (AttemptOut | CaptureRefusal)[] = [];
  for (const index of plan.attempts.keys()) outcomes.push(await adaptAttempt(plan, index, files, digests));
  const recorderOutputs = outcomes.reduce((sum, outcome) => sum + ("ok" in outcome ? 0 : outcome.recorderOutputs), 0);
  const outputRefusal = outcomes.find((outcome): outcome is ShapeRefusal => "ok" in outcome && isRecorderRefusal(outcome)) ?? null;
  // A record at the pinned path is read where the seed names it; where the seed names none, a record there is refused, and so is a pinned path never read, so declared means the path was read and nothing is there.
  const pinned = files.get(PROVENANCE_PATH);
  const provenance =
    plan.provenancePath !== null
      ? readProvenance(PROVENANCE_PATH, decodeJson(PROVENANCE_PATH, pinned))
      : pinned === undefined
        ? shapeRefusal(PROVENANCE_PATH, "the file, which was never read")
        : pinned === null
          ? null
          : shapeRefusal(PROVENANCE_PATH, "a provenance record the seed does not name");
  const identity = recorderIdentityOf({ provenance, declaredRelease: plan.recorderRelease, outputsRead: recorderOutputs, outputRefusal });
  const finish = async (): Promise<CaptureResult> => {
    const refused = outcomes.find((outcome): outcome is CaptureRefusal => "ok" in outcome);
    if (refused !== undefined) return refused;
    if (identity.status !== "present") return { ok: false, refusal: "recorder-not-pinned", at: identity.reason };
    const out = outcomes as readonly AttemptOut[];
    const attempts = out.map(({ attempt }) => attempt);
    const source = sourceOf(plan, attempts, digests);
    if (source !== null && "ok" in source) return source;
    const control = await controlOf(plan, files, digests);
    if (control !== null && "ok" in control) return control;
    return {
      ok: true,
      run: { adapter: CAPTURE_ADAPTER, recorderBasis: identity.basis, recorderStatement: identity.reason, objects, attempts, rows: out.flatMap(({ rows }) => rows), source, control },
      digestsRecomputed: out.reduce((sum, { digestsRecomputed }) => sum + digestsRecomputed, 0),
      sourcesNotRead: out.reduce((sum, { notRead }) => sum + notRead, 0)
    };
  };
  return { objects, runDigest, outcomes, identity, result: await finish() };
}

/** The run, as this adapter reads it. A refusal refuses the whole import. */
export async function adaptCaptureRun(plan: CapturePlan, files: Files): Promise<CaptureResult> {
  return (await readCaptureRun(plan, files)).result;
}

function status(state: KindStatus["status"], reason: string): KindStatus {
  return { status: state, reason };
}

function refusedStatus(refusal: CaptureRefusal): KindStatus {
  return status(refusal.refusal === "missing-file" ? "missing" : "incompatible", `${refusal.refusal}: ${refusal.at}`);
}

const ATTEMPT_KINDS: readonly EvidenceKind[] = ["attempt-identity", "scanner-reads", "main-document", "window", "script-inventory", "script-execution", "requests", "call-frames"];

/** What an adapted attempt held, kind by kind. Nothing is stated present that the adapter did not read. */
function heldKinds(out: AttemptOut): Partial<Record<EvidenceKind, KindStatus>> {
  const { attempt, held } = out;
  return {
    "attempt-identity": status("present", "the row states its start and duration, and the seed its recipe"),
    "scanner-reads": status("present", "the row holds the scanner's report read and its later reads"),
    "main-document": attempt.page.status === null ? status("missing", "the row states no main document status") : status("present", "the row states the main document's status"),
    window: held.observed ? status("present", "REA's window, on the wall clock") : status("present", "the harness's visit, on its own clock"),
    "script-inventory": held.capturedScripts > 0 ? status("present", `${held.capturedScripts} captured scripts, each digest recomputed from its bytes`) : status("missing", "no captured script with a digest was read in this attempt"),
    "script-execution": held.coveredScripts > 0 ? status("present", "REA's coverage of the observed scripts") : status("missing", "no coverage was read in this attempt"),
    requests: held.requestsKept ? status("present", "REA's requests, with their callsites") : status("missing", "no coverage ran in this attempt"),
    "call-frames": held.framesWithAddress > 0 ? status("present", "the logger's frames, each with a URL, a line and a column") : status("missing", "no logger frame with an address was read in this attempt"),
    "listener-registrations": status("missing", "this layout records no listener registrations"),
    "observer-outcome": status("missing", "this layout keeps the scanner's reads, not its observer's outcome per item")
  };
}

/**
 * What evidence each attempt of this run holds, by kind, from the same reading the import makes,
 * before anything is imported. An attempt the adapter refuses states its refusal for every kind it
 * would hold, and the survey says why the adapter would refuse the run, if it would, so no assessment
 * supports importing a run the import would refuse.
 */
export async function surveyCaptureRun(plan: CapturePlan, files: Files): Promise<Survey> {
  return (await readCaptureRun(plan, files)).survey;
}

/** One reading of the run, as the survey and as the adapted run, so the two cannot rest on different readings. importCase takes both from here. */
export async function readCaptureRun(plan: CapturePlan, files: Files): Promise<Readonly<{ survey: Survey; result: CaptureResult }>> {
  const problem = planProblem(plan);
  if (problem !== null) return { survey: { runDigest: await runDigestOf([]), refusal: `plan-malformed: ${problem}`, run: { "recorder-identity": status("incompatible", `plan-malformed: ${problem}`) }, attempts: [] }, result: planRefusal(problem) };
  const reading = await readRun(plan, files);
  const attempts = reading.outcomes.map((outcome, index) => ({ attempt: importedAttemptId(index), kinds: "ok" in outcome ? Object.fromEntries(ATTEMPT_KINDS.map((kind) => [kind, refusedStatus(outcome)])) : heldKinds(outcome) }));
  const survey: Survey = {
    runDigest: reading.runDigest,
    refusal: reading.result.ok ? null : `${reading.result.refusal}: ${reading.result.at}`,
    run: { "recorder-identity": status(reading.identity.status, reading.identity.reason) },
    attempts
  };
  return { survey, result: reading.result };
}

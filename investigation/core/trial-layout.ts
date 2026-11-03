// The adapter's read side for a second recorded layout: a trial folder whose attempts each sit in
// out/<label>/, holding a harness's record of its visits (harness.json), the raw reads of each visit
// (harness-raw.json, then harness-raw-extra-<n>.json for each later visit), and, for the first visit,
// REA 6.5.0 outputs named rea-main-<NN>-<command>.json, each with the harness's record of the call
// beside it (.meta.json). The recorder's provenance sits in provenance-check/.
//
// What this reads is held to the shapes TRIAL_LAYOUT names, through the same recorder shapes the
// first layout uses, and a shape it does not know is incompatible, never guessed at. It reads only
// the files the survey needs, so a large analysis output beside them is never opened.
//
// It gives a survey for the sufficiency assessment, and nothing more yet. A harness.json holds two
// kinds of field: what the visit recorded, and what the harness's own classifier derived from it
// (a frame's predicted loss, whether the prediction agreed, and each registration's classification).
// The survey reads only the first kind, and says so where the second would stand in for evidence.
// Mapping this layout's rows into an imported case waits on an assessment that supports importing
// it.
//
// A trial's folders are named for what was visited, so nothing here names one: each visit is an
// attempt named A01, A02 and on, in the listing's order, and a file is named by its folder's place in
// that order, in the survey and, through trialPathNames, in the local reader's refusals (which name
// any path given no name by its place in the request). A harness record the listing met as a link is
// an attempt too, refused for that reason, never dropped, and any other file the survey wants that the
// listing met as a link, or below a folder it met as a link, is stated incompatible for that reason,
// never missing. A link at out itself hides every attempt folder, so the survey states the run refused
// for that reason rather than a run of no attempts.
//
// Pure: it takes the folder's listing and bytes already read. A refusal names a file and a field.

import { sha256Hex } from "./canonical-json";
import { importedAttemptId, runDigestOf } from "./imported-ids";
import {
  checkEvidenceId,
  decodeJson,
  isCount,
  isInsidePath,
  isPlain,
  isShapeRefusal,
  mirroredFolder,
  PROVENANCE_PATH,
  readCallRecord,
  readInspectOutput,
  readProvenance,
  readScriptManifest,
  RECORDER,
  RECORDER_SHAPES,
  recorderIdentityOf,
  shapeRefusal,
  type ShapeRefusal
} from "./recorder-shapes";
import type { EvidenceKind, KindStatus, Survey } from "./sufficiency";

export const TRIAL_LAYOUT = {
  name: "harness-trial",
  version: 1,
  recorder: RECORDER,
  shapes: {
    "out/<label>/harness.json": "trial harness 1: label, a parseable startedAt, visits of a parseable startedAt, status, finalUrl, a finite readAtMs of at least 0, frames of url, parentUrl, observerSnapshot",
    "out/<label>/harness-raw.json": "trial raw reads 1: rawReads of url, parentUrl, observer of detections, events and listenerAttributionLost, log of a finite installedAt of at least 0, records and stacks",
    "out/<label>/rea-main-02-inspect-web-page.json": RECORDER_SHAPES.inspect,
    "out/<label>/rea-main-03-scripts/manifest.json": RECORDER_SHAPES.scriptManifest,
    "out/<label>/rea-main-NN-<command>.json.meta.json": RECORDER_SHAPES.callRecord,
    [PROVENANCE_PATH]: RECORDER_SHAPES.provenance
  }
} as const;

const HARNESS = /^out\/([^/]+)\/harness\.json$/;
const FOLDER_LINK = /^out\/([^/]+)$/;
/** The folder every attempt folder sits in: a link there hides them all. */
const ATTEMPTS_FOLDER = "out";
const INSPECT = "rea-main-02-inspect-web-page.json";
const MANIFEST = "rea-main-03-scripts/manifest.json";
const ATTESTATIONS = PROVENANCE_PATH;
const OBSERVER_KEYS = ["detections", "events", "listenerAttributionLost"];
/** A frame of a captured stack that names an http(s) URL with a line and a column. */
const HTTP_FRAME = /^\s*at (?:.*\()?https?:\/\/[^\s)]+:\d+:\d+\)?$/;

/** What the local reader's listing found: the regular files, and each link it met without following it. */
export type Listing = Readonly<{ files: readonly string[]; links: readonly string[] }>;
export type Files = ReadonlyMap<string, Uint8Array | null>;

/** Each attempt folder in the listing's order: a folder with a harness record, or one whose record or folder is a link. */
function foldersOf(listing: Listing): readonly Readonly<{ label: string; link: boolean }>[] {
  const labels = new Map<string, boolean>();
  for (const path of listing.files) {
    const match = HARNESS.exec(path);
    if (match !== null && isInsidePath(path)) labels.set(match[1], false);
  }
  for (const path of listing.links) {
    const match = HARNESS.exec(path) ?? FOLDER_LINK.exec(path);
    if (match !== null && isInsidePath(path) && !labels.has(match[1])) labels.set(match[1], true);
  }
  return [...labels.keys()].sort().map((label) => ({ label, link: labels.get(label) as boolean }));
}

function rawFile(label: string, visit: number): string {
  return visit === 0 ? `out/${label}/harness-raw.json` : `out/${label}/harness-raw-extra-${visit - 1}.json`;
}

/** The files the survey reads, of those the listing holds as regular files. Nothing else is opened. */
export function trialPathsNeeded(listing: Listing): readonly string[] {
  const listed = new Set(listing.files);
  const wanted: string[] = [];
  const want = (path: string): void => {
    if (listed.has(path) && !wanted.includes(path)) wanted.push(path);
  };
  want(ATTESTATIONS);
  for (const { label, link } of foldersOf(listing)) {
    if (link) continue;
    want(`out/${label}/harness.json`);
    for (const path of listing.files) {
      if (path.startsWith(`out/${label}/harness-raw`) && /harness-raw(?:-extra-\d+)?\.json$/.test(path)) want(path);
    }
    want(`out/${label}/${INSPECT}`);
    want(`out/${label}/${INSPECT}.meta.json`);
    want(`out/${label}/${MANIFEST}`);
  }
  return wanted;
}

/**
 * Each path under a trial folder that the survey wants or the listing holds, by the name a refusal
 * gives it: its folder's place, never its label. A path below a folder of saved script files mirrors a
 * URL, so it gets no name here and the reader names it by its place in the request.
 */
export function trialPathNames(listing: Listing): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const places = new Map(foldersOf(listing).map(({ label }, place) => [label, `folder ${place + 1}`] as const));
  for (const path of [...listing.files, ...listing.links]) {
    if (mirroredFolder(path) !== null) continue;
    const match = /^out\/([^/]+)(\/.*)?$/.exec(path);
    const place = match === null ? undefined : places.get(match[1]);
    if (match !== null) names.set(path, `${place ?? "folder ?"}${match[2] ?? ""}`);
  }
  return names;
}

type Frame = Readonly<{ url: string; parentUrl: string | null; observerFlag: boolean | null }>;
type Visit = Readonly<{ startedAt: string; status: number | null; finalUrl: string | null; readAtMs: number | null; frames: readonly Frame[] }>;
type Harness = Readonly<{ startedAt: string; visits: readonly Visit[] }>;

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isSafeInteger(Date.parse(value));
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readHarness(file: string, value: unknown): Harness | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value) || typeof value.label !== "string" || !isTime(value.startedAt) || !Array.isArray(value.visits)) return shapeRefusal(file, "label, startedAt or visits");
  const visits: Visit[] = [];
  for (const visit of value.visits) {
    if (!isPlain(visit) || !isTime(visit.startedAt) || !Array.isArray(visit.frames)) return shapeRefusal(file, "visits");
    if (visit.status !== null && visit.status !== undefined && !isCount(visit.status)) return shapeRefusal(file, "visits.status");
    if (visit.finalUrl !== null && visit.finalUrl !== undefined && typeof visit.finalUrl !== "string") return shapeRefusal(file, "visits.finalUrl");
    if (visit.readAtMs !== null && visit.readAtMs !== undefined && !isNonNegative(visit.readAtMs)) return shapeRefusal(file, "visits.readAtMs");
    const frames: Frame[] = [];
    for (const frame of visit.frames) {
      if (!isPlain(frame) || typeof frame.url !== "string" || (frame.parentUrl !== null && typeof frame.parentUrl !== "string")) return shapeRefusal(file, "visits.frames");
      const snapshot = frame.observerSnapshot;
      if (snapshot !== null && snapshot !== undefined && (!isPlain(snapshot) || typeof snapshot.listenerAttributionLost !== "boolean")) return shapeRefusal(file, "visits.frames.observerSnapshot");
      frames.push({ url: frame.url, parentUrl: frame.parentUrl as string | null, observerFlag: isPlain(snapshot) ? (snapshot.listenerAttributionLost as boolean) : null });
    }
    visits.push({
      startedAt: visit.startedAt,
      status: isCount(visit.status) ? visit.status : null,
      finalUrl: typeof visit.finalUrl === "string" ? visit.finalUrl : null,
      readAtMs: isNonNegative(visit.readAtMs) ? visit.readAtMs : null,
      frames
    });
  }
  return { startedAt: value.startedAt, visits };
}

type RawFrame = Readonly<{ url: string; observer: Readonly<{ keys: readonly string[] }> | null; log: Readonly<{ installedAt: number | null; records: number; stacks: readonly string[] }> | null }>;

function readRaw(file: string, value: unknown): readonly RawFrame[] | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value) || !Array.isArray(value.rawReads)) return shapeRefusal(file, "rawReads");
  const frames: RawFrame[] = [];
  for (const read of value.rawReads) {
    if (!isPlain(read) || typeof read.url !== "string") return shapeRefusal(file, "rawReads.url");
    const { observer, log } = read;
    if (observer !== null && observer !== undefined && (!isPlain(observer) || !Object.keys(observer).every((key) => OBSERVER_KEYS.includes(key)) || !Array.isArray(observer.detections))) return shapeRefusal(file, "rawReads.observer");
    if (log !== null && log !== undefined && (!isPlain(log) || !Array.isArray(log.records) || !Array.isArray(log.stacks) || !log.stacks.every((stack) => typeof stack === "string"))) return shapeRefusal(file, "rawReads.log");
    if (isPlain(log) && log.installedAt !== undefined && log.installedAt !== null && !isNonNegative(log.installedAt)) return shapeRefusal(file, "rawReads.log.installedAt");
    for (const record of isPlain(log) ? (log.records as unknown[]) : []) {
      if (!isPlain(record) || typeof record.type !== "string" || typeof record.target !== "string") return shapeRefusal(file, "rawReads.log.records");
    }
    frames.push({
      url: read.url,
      observer: isPlain(observer) ? { keys: Object.keys(observer) } : null,
      log: isPlain(log) ? { installedAt: isNonNegative(log.installedAt) ? log.installedAt : null, records: (log.records as unknown[]).length, stacks: log.stacks as string[] } : null
    });
  }
  return frames;
}

function status(state: KindStatus["status"], reason: string): KindStatus {
  return { status: state, reason };
}

function refused(refusal: ShapeRefusal): KindStatus {
  return status(refusal.refusal === "missing-file" ? "missing" : "incompatible", `${refusal.refusal}: ${refusal.at}`);
}

/** A file the survey wants that the listing met as a link: incompatible, since the local reader does not follow one, never missing. */
function linkedStatus(shown: string): KindStatus {
  return status("incompatible", `link-in-path: ${shown}, which the local reader does not follow`);
}

function addressOf(url: string): string {
  return url.split("#")[0].split("?")[0];
}

function isHttpFrameLine(line: string): boolean {
  return HTTP_FRAME.test(line);
}

/** Whether the listing met this path, or a folder on its way, as a link: either way the local reader does not follow it. */
function isLinked(links: readonly string[], path: string): boolean {
  return links.some((link) => path === link || path.startsWith(`${link}/`));
}

type Outputs = { read: number; refusal: ShapeRefusal | null; links: readonly string[] };

/** A folder's name in what this hands back: its place in the listing, never its label. */
type Folder = Readonly<{ label: string; name: string }>;

/**
 * Whether the recorder's inspection lists scripts, each saved with a digest, in every frame the
 * observer flagged. A flagged top frame is the inspection's root frame. A flagged child frame is the
 * inspection's frame at the same address, matched without either's query or fragment, since the
 * harness keeps an address without its query and REA with it.
 */
async function inventoryOf(folder: Folder, visit: Visit, files: Files, outputs: Outputs): Promise<KindStatus> {
  const file = `out/${folder.label}/${INSPECT}`;
  const shown = `${folder.name}/${INSPECT}`;
  for (const [wanted, name] of [[file, shown], [`${file}.meta.json`, `${shown}.meta.json`], [`out/${folder.label}/${MANIFEST}`, `${folder.name}/${MANIFEST}`]] as const) {
    if (isLinked(outputs.links, wanted)) return linkedStatus(name);
  }
  if (!files.has(file)) return status("missing", "no inspection ran in this attempt");
  if (files.has(`${file}.meta.json`)) {
    const call = readCallRecord(`${shown}.meta.json`, decodeJson(`${shown}.meta.json`, files.get(`${file}.meta.json`)));
    if (isShapeRefusal(call)) return refused(call);
    if (call.exit !== 0) return status("missing", `the inspection call exited ${String(call.exit)}, so it left no output to read`);
  }
  const decoded = decodeJson(shown, files.get(file));
  const view = readInspectOutput(shown, decoded);
  const misnamed = isShapeRefusal(view) ? null : await checkEvidenceId(shown, decoded);
  const refusal = isShapeRefusal(view) ? view : misnamed;
  if (refusal !== null) {
    outputs.refusal ??= refusal;
    return refused(refusal);
  }
  if (isShapeRefusal(view)) return refused(view);
  outputs.read += 1;
  const manifest = readScriptManifest(`${folder.name}/${MANIFEST}`, decodeJson(`${folder.name}/${MANIFEST}`, files.get(`out/${folder.label}/${MANIFEST}`)));
  if (isShapeRefusal(manifest)) return refused(manifest);
  const saved = new Set(manifest.map(({ scriptKey }) => scriptKey));
  const flagged = visit.frames.filter(({ observerFlag }) => observerFlag === true);
  const uncovered = flagged.filter((frame) => {
    const ids = view.frames.filter((candidate) => (frame.parentUrl === null ? candidate.parentFrameId === null : candidate.parentFrameId !== null && addressOf(candidate.url) === addressOf(frame.url))).map(({ frameId }) => frameId);
    const scripts = view.scripts.filter(({ frameId }) => frameId !== null && ids.includes(frameId));
    return scripts.length === 0 || !scripts.every(({ scriptKey }) => saved.has(scriptKey));
  });
  if (uncovered.length > 0) return status("missing", `REA's inspection lists no saved script for ${uncovered.length} of the ${flagged.length} frames the observer flagged, which its scope left out`);
  return status("present", flagged.length === 0 ? "REA's inspection, in an attempt where the observer flagged no frame" : `REA's inspection lists saved scripts in each of the ${flagged.length} frames the observer flagged`);
}

async function visitKinds(folder: Folder, index: number, visit: Visit, files: Files, outputs: Outputs): Promise<Partial<Record<EvidenceKind, KindStatus>>> {
  const kinds: Partial<Record<EvidenceKind, KindStatus>> = {
    "attempt-identity": status("present", "the harness names the visit's start"),
    "main-document":
      visit.finalUrl !== null && visit.status !== null && visit.frames.some(({ parentUrl }) => parentUrl === null)
        ? status("present", "the visit states its final address, status and top frame")
        : status("missing", "the visit states no final address, status or top frame"),
    "script-execution": status("missing", "this survey does not read REA's observation in this layout"),
    "scanner-reads": status("missing", "this layout holds the observer's own record, not the scanner's reads"),
    requests: status("missing", "this survey does not read requests in this layout")
  };
  const file = rawFile(folder.label, index);
  const shownRaw = index === 0 ? `${folder.name}/harness-raw.json` : `${folder.name}/harness-raw-extra-${index - 1}.json`;
  const raw = isLinked(outputs.links, file) ? shapeRefusal(shownRaw, "the file, which the local reader does not follow", "link-in-path") : readRaw(shownRaw, decodeJson(shownRaw, files.get(file)));
  if (isShapeRefusal(raw)) {
    kinds["listener-registrations"] = kinds["call-frames"] = kinds.window = kinds["observer-outcome"] = refused(raw);
  } else {
    const observed = raw.filter(({ observer }) => observer !== null);
    const unlogged = observed.filter(({ log }) => log === null);
    const logged = raw.filter(({ log }) => log !== null);
    kinds["listener-registrations"] =
      logged.length === 0 ? status("missing", "no frame holds the logger's records") : unlogged.length > 0 ? status("missing", `${unlogged.length} frames the observer read hold no logger records`) : status("present", "the logger's records of each registration, with a stack for each");
    const unframed = logged.filter(({ log }) => log !== null && log.records > 0 && !log.stacks.some((stack) => stack.split("\n").some(isHttpFrameLine)));
    kinds["call-frames"] = logged.length === 0 ? status("missing", "no logger stacks were kept") : unframed.length > 0 ? status("missing", `${unframed.length} logged frames keep no stack frame with a URL and a position`) : status("present", "the logger's stacks, whose frames carry a URL, a line and a column");
    kinds.window =
      logged.length > 0 && logged.every(({ log }) => log !== null && log.installedAt !== null) && visit.readAtMs !== null
        ? status("present", "the logger's records from its install to the read, on the page's clock")
        : status("missing", "the logger's install time or the read time was not kept");
    kinds["observer-outcome"] =
      observed.length === 0
        ? status("missing", "no frame holds the observer's own record")
        : status("incompatible", "the observer's record holds per-kind detections, API counts and a frame-level flag, and no outcome per registration; the per-registration status in harness.json is the harness classifier's derived output");
  }
  kinds["script-inventory"] = index === 0 ? await inventoryOf(folder, visit, files, outputs) : status("missing", "no recorder call was made in this visit");
  return kinds;
}

/** The run as the survey read it, by the same digest an imported case would carry. */
async function digestOfRead(files: Files): Promise<string> {
  const objects = [];
  for (const [path, bytes] of files) {
    if (bytes === null || bytes === undefined) continue;
    objects.push({ path, digest: await sha256Hex(new Uint8Array(bytes)), bytes: bytes.length });
  }
  return runDigestOf(objects);
}

/**
 * What evidence each visit of this trial holds, by kind. Each visit is an attempt, A01, A02 and on,
 * in the listing's order. Only the first visit of a folder made recorder calls. The recorder's
 * identity follows the one rule every layout uses.
 */
export async function surveyTrialRun(listing: Listing, files: Files): Promise<Survey> {
  const outputs: Outputs = { read: 0, refusal: null, links: listing.links };
  const attempts: { attempt: string; kinds: Partial<Record<EvidenceKind, KindStatus>> }[] = [];
  const next = () => importedAttemptId(attempts.length);
  for (const [place, { label, link }] of foldersOf(listing).entries()) {
    const folder: Folder = { label, name: `folder ${place + 1}` };
    if (link) {
      attempts.push({ attempt: next(), kinds: { "attempt-identity": status("incompatible", `link-in-path: ${folder.name}/harness.json, which the local reader does not follow`) } });
      continue;
    }
    const shown = `${folder.name}/harness.json`;
    const harness = readHarness(shown, decodeJson(shown, files.get(`out/${label}/harness.json`)));
    if (isShapeRefusal(harness)) {
      attempts.push({ attempt: next(), kinds: { "attempt-identity": refused(harness) } });
      continue;
    }
    for (const [index, visit] of harness.visits.entries()) {
      const id = next();
      attempts.push({ attempt: id, kinds: await visitKinds(folder, index, visit, files, outputs) });
    }
  }
  const provenance = isLinked(listing.links, ATTESTATIONS)
    ? shapeRefusal(ATTESTATIONS, "the file, which the local reader does not follow", "link-in-path")
    : listing.files.includes(ATTESTATIONS)
      ? readProvenance(ATTESTATIONS, decodeJson(ATTESTATIONS, files.get(ATTESTATIONS)))
      : null;
  const identity = recorderIdentityOf({ provenance, declaredRelease: null, outputsRead: outputs.read, outputRefusal: outputs.refusal });
  const hidden = isLinked(listing.links, ATTEMPTS_FOLDER) ? `link-in-path: ${ATTEMPTS_FOLDER}, which the local reader does not follow` : null;
  return { runDigest: await digestOfRead(files), refusal: hidden, run: { "recorder-identity": status(identity.status, identity.reason) }, attempts };
}

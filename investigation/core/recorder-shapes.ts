// What REA 6.5.0 writes, read strictly, as both recorded layouts hold it. 6.5.0 is the release
// pinned for historical cases. Its identity below is the release, the commit REA's signed build
// provenance names for it, and the sha512 of the package that provenance covers. Each output shape is
// pinned by its envelope's exact key set, provider and predicate, so output from another release that
// changed any of them is refused rather than read as this one.
//
// Parsing takes bytes already read and gives a typed view or a refusal. Nothing here touches a file,
// runs a recorder or depends on one. A field this reads is checked for its type and its vocabulary,
// and nothing more is assumed of it: a value of a shape not listed here refuses the whole import,
// which is the first of the two failures an adapter keeps apart. The second, a known shape with
// output missing, is the adapter's to record.
//
// Each reader takes what decodeJson gave, and a refusal from it passes through unchanged, so bytes
// that are not JSON are never read as an object that lacks a field. A refusal names the file and the
// field, never a value the file held.
//
// REA states each output's limits as fixed sentences in its envelope's `limitations`. Every sentence
// 6.5.0 wrote into the two recorded layouts is a literal in its package, and RECORDER_LIMITATIONS maps
// each to an identifier. A view carries the identifiers, never the sentence, and a sentence outside
// this list is a shape this does not know.
// The package's MIT notice for these quoted sentences is in docs/third-party/rea-agents-6.5.0-notice.md.
//
// REA names each output by `ev_` and a sha256 over its own canonical JSON of the envelope's semantic
// fields (6.5.0's dist/mcp/nativeValueTrace-DR9UE62L.js, lines 1125 to 1146, and
// dist/domain/canonicalDigest.js). checkEvidenceId recomputes it the same way, so an output whose
// fields were changed after REA wrote it no longer carries its own name, unless the id was
// recomputed, which needs no key: it catches an edit, not a forger. Of the subject 6.5.0 hashes only
// its digest, format and architecture, so the envelope's nested objects (provider, subject and
// environment) are held to 6.5.0's own strict schemas key for key (the same file, lines 985 to 989,
// 1020 to 1031 and 1062 to 1072), and a key added to any of them is a shape this does not know.
//
// The recorder's identity is decided by one rule, recorderIdentityOf, for every layout, on one of two
// bases a case records. Attested: a provenance statement at the one pinned path (PROVENANCE_PATH)
// names this release, its commit and its package sha512, all in the build provenance statement, and
// the record holds exactly the two statements 6.5.0's attestation carries, one of each type and no
// other entry. Its signatures are not verified: that needs trust roots this core does not carry, so
// "attested" says what the statement names, not who signed it. Declared: the seed names the pinned
// release and the run holds no provenance record, which an adapter checks by asking for the pinned
// path. On either basis a release the seed names must be the pinned one, and every output read must
// carry the provider and predicate 6.5.0 writes.

import { sha256Hex } from "./canonical-json";

export const RECORDER = {
  name: "REA",
  release: "6.5.0",
  commit: "3b79af28e80785afce9f5998d8f03289402a1847",
  integrity: "sha512:0ba046ecbcab01d47be264a37abb4ce8faf126470d6766df40d389a2b9cfa3d7ab0c4a76b723d15583e757962876bfb546a7b009095aebc5ae9579559ef783f8"
} as const;

const PROVIDER = { id: "rea-cdp-browser", version: "2" } as const;

/** Where a provenance record for the recorder sits inside a run folder, in every layout: the one path read for it. */
export const PROVENANCE_PATH = "provenance-check/rea-agents-6.5.0.attestations.json";

/** The two statement types 6.5.0's npm attestation carries: the registry's publish statement and the build provenance. */
const PUBLISH_PREDICATE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/** 6.5.0's strict schemas for the envelope's nested objects (nativeValueTrace-DR9UE62L.js): the keys each must hold, exactly. */
const PROVIDER_KEYS = ["id", "name", "version"];
const SUBJECT_KEYS = ["name", "digest", "local_path", "format", "architecture"];
const ENVIRONMENT_KEYS = ["id", "platform", "architecture", "isolation"];

/** Every key a 6.5.0 envelope holds, and nothing else. */
const ENVELOPE_KEYS = [
  "analysis_profile",
  "authority",
  "confidence",
  "environment",
  "evidence_id",
  "evidence_links",
  "limitations",
  "locations",
  "normalized_result",
  "operation",
  "parameters",
  "predicate_type",
  "provider",
  "raw_result",
  "relationship_coverage",
  "subject"
];

/** One word of REA's own vocabulary, such as a cleanup or an attribution. Anything longer could carry what a page said, so it is a shape this does not know. */
const WORD = /^[a-z][a-z_-]{0,31}$/;
/** The request methods HTTP defines. A page may send any token, and anything else is kept as one word. */
const STANDARD_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"];
export const NONSTANDARD_METHOD = "nonstandard";
/** A script key as 6.5.0's own schema spells one (dist/domain/browserObservationSchemas.js, line 83). */
const SCRIPT_KEY = /^scr_[a-f0-9]{64}(?:_[0-9]+)?$/;
/** Why 6.5.0 ends an observation window (dist/domain/webExecution.js, lines 28 to 32). */
export const END_REASONS = ["window_elapsed", "document_changed", "target_terminated"] as const;
export type EndReason = (typeof END_REASONS)[number];

export const RECORDER_SHAPES = {
  observe: "rea.observe-web-execution, operation observe_web_execution, provider rea-cdp-browser 2, the sixteen 6.5.0 envelope keys with provider, subject and environment held to 6.5.0's keys and no analysis profile, end reasons window_elapsed, document_changed and target_terminated",
  inspect: "rea.web-page-inspection, operation inspect_web_page, provider rea-cdp-browser 2, the sixteen 6.5.0 envelope keys with provider, subject and environment held to 6.5.0's keys and no analysis profile",
  scriptManifest: "web script manifest: scripts of source.script_key, url, content.relative_path and content.sha256, each relative path once",
  callRecord: "call record: args, exit, signal, ms, stdoutBytes, stderrTail",
  limitations: "the nineteen limitation sentences 6.5.0 writes into these two outputs, each once, by identifier",
  provenance: `npm attestations at ${PROVENANCE_PATH}: exactly one publish statement and one build provenance statement and no other entry, the latter naming the pinned package by sha512 and the pinned commit; signatures not verified`
} as const;

/** The limitation sentences 6.5.0 writes into these outputs, each a literal in its package, by identifier. */
export const RECORDER_LIMITATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "rea.observe-web-execution": {
    "A detailed-coverage request does not guarantee block granularity for already compiled functions. When is_block_coverage is false, branch execution is unknown; REA preserves the function-only producer ranges.": "block-granularity-not-guaranteed",
    "Artifact identity is unavailable for this observation.": "artifact-identity-unavailable",
    "Metadata has an 8 MiB script budget and 8 MiB request budget; complete retained sources have a 32 MiB budget. Resource failures return no partial success. The externally owned browser's CPU and memory are not controlled by REA.": "metadata-budgets",
    "Only the selected main document's proven frame/context scripts are attributed. Child frames, workers, service workers, WebAssembly and scripts without ownership metadata remain outside this operation.": "main-document-scripts-only",
    "Precise coverage resets counters, retains execution records and prevents optimized execution until stopped. Timing and JIT behavior are affected.": "precise-coverage-affects-timing",
    "Previously parsed scripts may be absent from a precise sample. Their source inventory is retained, but missing coverage never means zero execution or an unexecuted function.": "previously-parsed-scripts-may-be-absent",
    "Producer hashes and UTF-8 digests of retained text are distinct identities. Inline script locations use reported resource offsets; anonymous/eval/sourceURL names are declarations.": "producer-hash-not-text-digest",
    "Request callsites are producer-reported initiators associated by session script ID; they do not establish UI causality. Unresolved asynchronous parent IDs are retained without fetching their stacks.": "callsites-are-reported-initiators",
    "Source metadata is collected through the final resetting sample, then frozen for source joins. Known identities remain checked during asynchronous source completion; newly parsed scripts after that cutoff are outside this evidence.": "sources-frozen-after-final-sample",
    "The local armed/end clock and backend coverage timestamps are distinct clocks. Counters start when the backend accepts instrumentation, before the armed receipt, and end at the resetting sample after the requested window. Counts may include execution during those command intervals; requests are restricted to the locally armed window.": "local-and-backend-clocks-differ",
    "V8 reports nested function/block ranges and counts, not a chronological trace. Counts must not be summed across overlapping ranges; zero counts concern this instrumented window only.": "counts-not-chronological",
    "Website source ownership requires the selected main frame and a proven default execution world. Isolated, worker and unknown worlds are excluded from coverage/source joins; referenced producer context metadata is retained.": "default-world-only"
  },
  "rea.web-page-inspection": {
    "Artifact identity is unavailable for this observation.": "artifact-identity-unavailable",
    "Browser host platform and architecture were not observed.": "host-platform-not-observed",
    "CDP discovery omitted the target attachment state; attached is reported as unknown.": "attachment-state-unknown",
    "Observation starts when REA attaches; prior network and console activity is unavailable.": "observation-starts-at-attach",
    "Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; explicitly requested primitive console text is retained verbatim, while payload captures retain value-free shapes.": "payloads-not-retained",
    "Source maps are reported only as declarative URLs and are not fetched.": "source-maps-not-fetched",
    "URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.": "url-less-scripts-excluded"
  }
};

export type ShapeRefusal = Readonly<{ ok: false; refusal: "unknown-shape" | "missing-file" | "digest-mismatch" | "path-outside" | "link-in-path"; at: string }>;

export function shapeRefusal(file: string, field: string, refusal: ShapeRefusal["refusal"] = "unknown-shape"): ShapeRefusal {
  return { ok: false, refusal, at: `${file}: ${field}` };
}

export function isShapeRefusal(value: unknown): value is ShapeRefusal {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false && typeof (value as { refusal?: unknown }).refusal === "string";
}

export function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The JSON these bytes hold, or a refusal. Invalid UTF-8 is refused, not repaired. */
export function decodeJson(file: string, bytes: Uint8Array | null | undefined): unknown {
  if (bytes === null || bytes === undefined) return shapeRefusal(file, "the file", "missing-file");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return shapeRefusal(file, "not UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return shapeRefusal(file, "not JSON");
  }
}

/**
 * A path a file inside the recorded folder may give for another: relative, with forward slashes,
 * no empty, dot or dot-dot segment, no backslash and no NUL. Anything else would leave the folder
 * or could, so it is refused.
 */
export function isInsidePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A saved script's file sits below a folder named files whose own path mirrors the script's URL, so
 * nothing past that folder may be shown. This gives the path up to and including the first such
 * folder, or null for a path not below one. The local reader and the trial layout both name paths by it.
 */
export function mirroredFolder(path: string): string | null {
  const mirrored = /^(.*?\/files)\/./.exec(path);
  return mirrored === null ? null : mirrored[1];
}

/** The limitation identifiers an envelope's sentences stand for, or the refusal for one this does not know. */
function limitationsOf(file: string, predicate: string, value: unknown): readonly string[] | ShapeRefusal {
  const known = RECORDER_LIMITATIONS[predicate];
  if (!Array.isArray(value) || known === undefined) return shapeRefusal(file, "limitations");
  const ids: string[] = [];
  for (const sentence of value) {
    const id = typeof sentence === "string" && Object.prototype.hasOwnProperty.call(known, sentence) ? known[sentence] : undefined;
    // 6.5.0 states each limitation once, so a sentence given twice is a shape it does not write.
    if (id === undefined || ids.includes(id)) return shapeRefusal(file, "limitations");
    ids.push(id);
  }
  return ids;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

/** Null, or a subject of exactly 6.5.0's keys: a name, a digest of exactly a sha256, a local path, a format, and an architecture or null. */
function isSubject(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlain(value) || !hasExactKeys(value, SUBJECT_KEYS) || typeof value.name !== "string" || typeof value.local_path !== "string" || typeof value.format !== "string") return false;
  if (value.architecture !== null && typeof value.architecture !== "string") return false;
  return isPlain(value.digest) && hasExactKeys(value.digest, ["sha256"]) && typeof value.digest.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.digest.sha256);
}

/** Null, or an environment of exactly 6.5.0's keys, each a string. */
function isEnvironment(value: unknown): boolean {
  if (value === null) return true;
  return isPlain(value) && hasExactKeys(value, ENVIRONMENT_KEYS) && ENVIRONMENT_KEYS.every((key) => typeof value[key] === "string");
}

type Envelope = Readonly<{ result: Record<string, unknown>; limitations: readonly string[] }>;

function envelope(file: string, value: unknown, predicate: string, operation: string): Envelope | ShapeRefusal {
  if (!isPlain(value)) return shapeRefusal(file, "envelope");
  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_KEYS.length || !keys.every((key) => ENVELOPE_KEYS.includes(key))) return shapeRefusal(file, "envelope keys");
  const provider = value.provider;
  if (!isPlain(provider) || !hasExactKeys(provider, PROVIDER_KEYS) || provider.id !== PROVIDER.id || provider.version !== PROVIDER.version || typeof provider.name !== "string") return shapeRefusal(file, "provider");
  if (!isSubject(value.subject)) return shapeRefusal(file, "subject");
  if (!isEnvironment(value.environment)) return shapeRefusal(file, "environment");
  if (value.analysis_profile !== null) return shapeRefusal(file, "analysis_profile");
  if (value.predicate_type !== predicate) return shapeRefusal(file, "predicate_type");
  if (value.operation !== operation) return shapeRefusal(file, "operation");
  if (typeof value.evidence_id !== "string" || !/^ev_[0-9a-f]{64}$/.test(value.evidence_id)) return shapeRefusal(file, "evidence_id");
  if (!isPlain(value.normalized_result)) return shapeRefusal(file, "normalized_result");
  const limitations = limitationsOf(file, predicate, value.limitations);
  if (isShapeRefusal(limitations)) return limitations;
  return { result: value.normalized_result, limitations };
}

/** REA's canonical JSON: keys sorted by code unit, values as JSON writes them, undefined left out. */
function reaCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : reaCanonical(item))).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${reaCanonical(record[key])}`)
    .join(",")}}`;
}

/**
 * Whether an output still carries its own name: `ev_` and the sha256 of REA's canonical JSON of the
 * envelope's semantic fields, as 6.5.0 computes it. A mismatch is a digest that does not match its
 * bytes, which refuses the whole import. It expects an envelope the readers here already held to
 * 6.5.0's sixteen keys and its nested shapes; given anything else it still answers by 6.5.0's recipe,
 * in which a member that is undefined is left out. A value nested too deeply to spell has no id to
 * match, and is a shape this does not know, not a thrown error.
 */
export async function checkEvidenceId(file: string, value: unknown): Promise<ShapeRefusal | null> {
  if (!isPlain(value)) return shapeRefusal(file, "envelope");
  const subject = value.subject;
  const projection = {
    subject: subject === null ? null : isPlain(subject) ? { digest: subject.digest, format: subject.format, architecture: subject.architecture } : subject,
    provider: value.provider,
    analysis_profile: value.analysis_profile,
    predicate_type: value.predicate_type,
    operation: value.operation,
    parameters: value.parameters,
    raw_result: value.raw_result,
    normalized_result: value.normalized_result,
    confidence: value.confidence,
    authority: value.authority,
    environment: value.environment,
    limitations: value.limitations,
    ...(value.relationship_coverage === null ? {} : { relationship_coverage: value.relationship_coverage }),
    locations: value.locations,
    evidence_links: value.evidence_links
  };
  let spelled: string;
  try {
    spelled = reaCanonical(projection);
  } catch {
    return shapeRefusal(file, "evidence_id");
  }
  const digest = await sha256Hex(new TextEncoder().encode(spelled));
  return value.evidence_id === `ev_${digest}` ? null : shapeRefusal(file, "evidence_id", "digest-mismatch");
}

export type Position = Readonly<{ line: number; column: number }>;

/** Where a script starts in its resource. REA writes null where it states no start, and null stays null: nothing here assumes 0, 0. */
export type ObservedSource =
  | Readonly<{ scriptId: string; url: string; state: "captured"; text: string; sha256: string; resourceStart: Position | null }>
  | Readonly<{ scriptId: string; url: string; state: "excluded"; resourceStart: Position | null }>;

export type CoveredRange = Readonly<{ start: number; end: number; count: number }>;
export type CoveredFunction = Readonly<{ name: string; ranges: readonly CoveredRange[] }>;

export type ObservedRequest = Readonly<{ method: string; url: string; callsiteUrl: string | null; causalAttribution: string }>;

export type ObserveView = Readonly<{
  armedAtMs: number;
  endedAtMs: number;
  /** REA's own word for why the window ended. Only window_elapsed is a window that ran as armed. */
  endReason: EndReason;
  cleanup: string;
  limitations: readonly string[];
  sources: readonly ObservedSource[];
  coverage: ReadonlyMap<string, readonly CoveredFunction[]>;
  excludedScripts: number;
  excludedRequests: number;
  notReported: number;
  requests: readonly ObservedRequest[];
}>;

function isPosition(value: unknown): value is Readonly<{ line_number: number; column_number: number }> {
  return isPlain(value) && isCount(value.line_number) && isCount(value.column_number);
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

function coveredFunctions(file: string, functions: unknown): readonly CoveredFunction[] | ShapeRefusal {
  if (!Array.isArray(functions)) return shapeRefusal(file, "coverage.scripts.functions");
  const out: CoveredFunction[] = [];
  for (const fn of functions) {
    if (!isPlain(fn) || typeof fn.name !== "string" || !Array.isArray(fn.ranges) || fn.ranges.length === 0) return shapeRefusal(file, "coverage.scripts.functions");
    const ranges: CoveredRange[] = [];
    for (const range of fn.ranges) {
      if (!isPlain(range) || !isCount(range.start_offset) || !isCount(range.end_offset) || !isCount(range.count)) return shapeRefusal(file, "coverage.scripts.functions.ranges");
      ranges.push({ start: range.start_offset, end: range.end_offset, count: range.count });
    }
    out.push({ name: fn.name, ranges });
  }
  return out;
}

/** An observe-web-execution output. */
export function readObserveOutput(file: string, value: unknown): ObserveView | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  const read = envelope(file, value, "rea.observe-web-execution", "observe_web_execution");
  if (isShapeRefusal(read)) return read;
  const { result } = read;
  const { window, coverage, instrumentation, script_inventory: inventory } = result;
  if (!isPlain(window)) return shapeRefusal(file, "window");
  const armedAtMs = timeOf(window.armed_at);
  const endedAtMs = timeOf(window.ended_at);
  if (armedAtMs === null || endedAtMs === null || endedAtMs < armedAtMs) return shapeRefusal(file, "window");
  if (!(END_REASONS as readonly unknown[]).includes(window.end_reason)) return shapeRefusal(file, "window.end_reason");
  if (!isPlain(instrumentation) || typeof instrumentation.cleanup !== "string" || !WORD.test(instrumentation.cleanup)) return shapeRefusal(file, "instrumentation.cleanup");
  if (!isPlain(coverage) || !Array.isArray(coverage.scripts) || !isCount(coverage.excluded_scripts)) return shapeRefusal(file, "coverage");
  if (!isCount(result.excluded_requests)) return shapeRefusal(file, "excluded_requests");
  if (!isPlain(inventory) || !Array.isArray(inventory.not_reported_script_ids)) return shapeRefusal(file, "script_inventory");
  if (!Array.isArray(result.sources)) return shapeRefusal(file, "sources");
  if (!Array.isArray(result.requests)) return shapeRefusal(file, "requests");

  const covered = new Map<string, readonly CoveredFunction[]>();
  for (const script of coverage.scripts) {
    if (!isPlain(script) || typeof script.script_id !== "string") return shapeRefusal(file, "coverage.scripts.script_id");
    const functions = coveredFunctions(file, script.functions);
    if (isShapeRefusal(functions)) return functions;
    if (covered.has(script.script_id)) return shapeRefusal(file, "coverage.scripts.script_id");
    covered.set(script.script_id, functions);
  }
  const sources: ObservedSource[] = [];
  const sourceIds = new Set<string>();
  for (const source of result.sources) {
    if (!isPlain(source) || typeof source.script_id !== "string" || typeof source.url !== "string") return shapeRefusal(file, "sources.script_id");
    // One id names one script: a second source under it would take the first one's coverage.
    if (sourceIds.has(source.script_id)) return shapeRefusal(file, "sources.script_id");
    sourceIds.add(source.script_id);
    const start = source.resource_start;
    if (start !== null && !isPosition(start)) return shapeRefusal(file, "sources.resource_start");
    const resourceStart = start === null ? null : { line: start.line_number, column: start.column_number };
    const body = source.source;
    if (!isPlain(body)) return shapeRefusal(file, "sources.source");
    if (body.state === "excluded") {
      sources.push({ scriptId: source.script_id, url: source.url, state: "excluded", resourceStart });
      continue;
    }
    if (body.state !== "captured") return shapeRefusal(file, "sources.source.state");
    if (typeof body.text !== "string") return shapeRefusal(file, "sources.source.text");
    if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) return shapeRefusal(file, "sources.source.sha256");
    sources.push({ scriptId: source.script_id, url: source.url, state: "captured", text: body.text, sha256: body.sha256, resourceStart });
  }
  const requests: ObservedRequest[] = [];
  for (const request of result.requests) {
    if (!isPlain(request) || typeof request.url !== "string" || typeof request.method !== "string" || typeof request.causal_attribution !== "string" || !WORD.test(request.causal_attribution) || !Array.isArray(request.callsites)) return shapeRefusal(file, "requests");
    const [site] = request.callsites as unknown[];
    if (site !== undefined && (!isPlain(site) || (site.url !== undefined && site.url !== null && typeof site.url !== "string"))) return shapeRefusal(file, "requests.callsites");
    const callsiteUrl = isPlain(site) && typeof site.url === "string" && site.url !== "" ? site.url : null;
    const method = STANDARD_METHODS.includes(request.method) ? request.method : NONSTANDARD_METHOD;
    requests.push({ method, url: request.url, callsiteUrl, causalAttribution: request.causal_attribution });
  }
  return {
    armedAtMs,
    endedAtMs,
    endReason: window.end_reason as EndReason,
    cleanup: instrumentation.cleanup,
    limitations: read.limitations,
    sources,
    coverage: covered,
    excludedScripts: coverage.excluded_scripts,
    excludedRequests: result.excluded_requests,
    notReported: inventory.not_reported_script_ids.length,
    requests
  };
}

export type InspectView = Readonly<{
  scripts: readonly Readonly<{ scriptKey: string; url: string; frameId: string | null }>[];
  frames: readonly Readonly<{ frameId: string; parentFrameId: string | null; url: string }>[];
  /** What the inspection says it left out, by section and reason. */
  excluded: readonly Readonly<{ section: string; reason: string; count: number | null }>[];
  limitations: readonly string[];
}>;

/** An inspect-web-page output. */
export function readInspectOutput(file: string, value: unknown): InspectView | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  const read = envelope(file, value, "rea.web-page-inspection", "inspect_web_page");
  if (isShapeRefusal(read)) return read;
  const { scripts, frames, completeness } = read.result;
  if (!isPlain(scripts) || !Array.isArray(scripts.items)) return shapeRefusal(file, "scripts.items");
  if (!Array.isArray(frames)) return shapeRefusal(file, "frames");
  if (!isPlain(completeness) || !Array.isArray(completeness.excluded)) return shapeRefusal(file, "completeness.excluded");
  const items: { scriptKey: string; url: string; frameId: string | null }[] = [];
  for (const item of scripts.items) {
    if (!isPlain(item) || typeof item.script_key !== "string" || !SCRIPT_KEY.test(item.script_key) || typeof item.url !== "string" || (item.frame_id !== null && typeof item.frame_id !== "string")) return shapeRefusal(file, "scripts.items");
    items.push({ scriptKey: item.script_key, url: item.url, frameId: item.frame_id as string | null });
  }
  const frameList: { frameId: string; parentFrameId: string | null; url: string }[] = [];
  for (const frame of frames) {
    if (!isPlain(frame) || typeof frame.frame_id !== "string" || typeof frame.url !== "string" || (frame.parent_frame_id !== null && typeof frame.parent_frame_id !== "string")) return shapeRefusal(file, "frames");
    frameList.push({ frameId: frame.frame_id, parentFrameId: frame.parent_frame_id as string | null, url: frame.url });
  }
  const excluded: { section: string; reason: string; count: number | null }[] = [];
  for (const entry of completeness.excluded) {
    if (!isPlain(entry) || typeof entry.section !== "string" || typeof entry.reason !== "string" || (entry.count !== null && !isCount(entry.count))) return shapeRefusal(file, "completeness.excluded");
    excluded.push({ section: entry.section, reason: entry.reason, count: entry.count as number | null });
  }
  return { scripts: items, frames: frameList, excluded, limitations: read.limitations };
}

export type ManifestScript = Readonly<{ scriptKey: string; url: string; relativePath: string; sha256: string }>;

/** The manifest REA writes beside the script files it saved. Every path it names must stay inside the folder it sits in, and name one script only. */
export function readScriptManifest(file: string, value: unknown): readonly ManifestScript[] | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value) || !Array.isArray(value.scripts)) return shapeRefusal(file, "scripts");
  const out: ManifestScript[] = [];
  const paths = new Set<string>();
  for (const entry of value.scripts) {
    if (!isPlain(entry) || !isPlain(entry.source) || typeof entry.source.script_key !== "string" || !SCRIPT_KEY.test(entry.source.script_key) || typeof entry.url !== "string" || !isPlain(entry.content)) return shapeRefusal(file, "scripts");
    const { relative_path: relativePath, sha256 } = entry.content;
    if (relativePath === undefined || relativePath === null) continue;
    if (!isInsidePath(relativePath)) return shapeRefusal(file, "scripts.content.relative_path", "path-outside");
    // One file holds one script's bytes: two keys sharing it would let one digest stand for both.
    if (paths.has(relativePath)) return shapeRefusal(file, "scripts.content.relative_path");
    paths.add(relativePath);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return shapeRefusal(file, "scripts.content.sha256");
    out.push({ scriptKey: entry.source.script_key, url: entry.url, relativePath, sha256 });
  }
  return out;
}

export type CallRecord = Readonly<{ args: readonly string[]; exit: number | null; signal: string | null; ms: number; stdoutBytes: number }>;

/** The record a harness kept of one recorder call. */
export function readCallRecord(file: string, value: unknown): CallRecord | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value) || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")) return shapeRefusal(file, "args");
  if (value.exit !== null && !Number.isSafeInteger(value.exit)) return shapeRefusal(file, "exit");
  if (value.signal !== null && typeof value.signal !== "string") return shapeRefusal(file, "signal");
  if (!isCount(value.ms) || !isCount(value.stdoutBytes)) return shapeRefusal(file, "ms");
  return { args: value.args as string[], exit: value.exit as number | null, signal: value.signal as string | null, ms: value.ms, stdoutBytes: value.stdoutBytes };
}

function decodedBase64(text: string): Uint8Array | null {
  try {
    // Base64 decodes to bytes, one per character here, so they are read back as bytes before UTF-8.
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * What a provenance record says of the recorder: whether it holds exactly the two statements 6.5.0's
 * attestation carries, one of each type and nothing else, and whether its build provenance statement
 * names the pinned package by its sha512 and the pinned commit, both in that one statement.
 * Signatures are not verified.
 */
export type Provenance = Readonly<{ exactStatements: boolean; namesPackage: boolean; namesCommit: boolean }>;

export function readProvenance(file: string, value: unknown): Provenance | ShapeRefusal {
  if (isShapeRefusal(value)) return value;
  if (!isPlain(value) || !Array.isArray(value.attestations)) return shapeRefusal(file, "attestations");
  const expectedDigest = RECORDER.integrity.replace(/^sha512:/, "");
  const types: string[] = [];
  let unreadable = 0;
  let namesPackage = false;
  let namesCommit = false;
  for (const attestation of value.attestations) {
    const signed = isPlain(attestation) && isPlain(attestation.bundle) ? attestation.bundle.dsseEnvelope : null;
    const bytes = isPlain(signed) && typeof signed.payload === "string" ? decodedBase64(signed.payload) : null;
    const payload = bytes === null ? null : decodeJson(file, bytes);
    // An entry that holds no statement is an entry 6.5.0's attestation does not carry.
    if (!isPlain(payload) || typeof payload.predicateType !== "string") {
      unreadable += 1;
      continue;
    }
    types.push(payload.predicateType);
    if (payload.predicateType !== PROVENANCE_PREDICATE || !Array.isArray(payload.subject)) continue;
    const subjectNames = payload.subject.some((subject) => isPlain(subject) && subject.name === `pkg:npm/rea-agents@${RECORDER.release}` && isPlain(subject.digest) && subject.digest.sha512 === expectedDigest);
    const definition = isPlain(payload.predicate) && isPlain(payload.predicate.buildDefinition) ? payload.predicate.buildDefinition : null;
    const dependencies = isPlain(definition) && Array.isArray(definition.resolvedDependencies) ? definition.resolvedDependencies : [];
    const commitNamed = dependencies.some((dependency) => isPlain(dependency) && isPlain(dependency.digest) && dependency.digest.gitCommit === RECORDER.commit);
    // The commit and the package digest are taken from the same statement, never one from each.
    if (subjectNames) namesPackage = true;
    if (subjectNames && commitNamed) namesCommit = true;
  }
  const exactStatements = unreadable === 0 && types.length === 2 && types.filter((type) => type === PUBLISH_PREDICATE).length === 1 && types.filter((type) => type === PROVENANCE_PREDICATE).length === 1;
  return { exactStatements, namesPackage, namesCommit };
}

export type RecorderBasis = "attested" | "declared";

export type RecorderIdentity =
  | Readonly<{ status: "present"; basis: RecorderBasis; reason: string }>
  | Readonly<{ status: "missing" | "incompatible"; basis: null; reason: string }>;

/**
 * The one rule for the recorder's identity, in every layout. A release the seed names must be the
 * pinned one, on either basis. Attested: a provenance record at the pinned path holds exactly one
 * statement of each of 6.5.0's two types and no other entry, and its build provenance statement names
 * the pinned package by its sha512 and the pinned commit; its signatures are not verified. Declared:
 * there is no provenance record (the adapter asked for the pinned path and found nothing there),
 * and the seed names the pinned release. Either way at least one output was read and every output
 * read carried the provider and predicate 6.5.0 writes; a refused output makes the identity
 * incompatible. The reason says which basis, and on the attested basis that nothing was verified.
 */
export function recorderIdentityOf(input: Readonly<{ provenance: Provenance | ShapeRefusal | null; declaredRelease: string | null; outputsRead: number; outputRefusal: ShapeRefusal | null }>): RecorderIdentity {
  const { provenance, declaredRelease, outputsRead, outputRefusal } = input;
  if (outputRefusal !== null) return { status: "incompatible", basis: null, reason: `${outputRefusal.refusal}: ${outputRefusal.at}` };
  if (declaredRelease !== null && declaredRelease !== RECORDER.release) return { status: "incompatible", basis: null, reason: "the seed names a recorder release this adapter does not pin" };
  if (provenance !== null && isShapeRefusal(provenance)) return { status: provenance.refusal === "missing-file" ? "missing" : "incompatible", basis: null, reason: `${provenance.refusal}: ${provenance.at}` };
  if (provenance !== null && !provenance.exactStatements) return { status: "incompatible", basis: null, reason: "the provenance record does not hold exactly one statement of each type 6.5.0's attestation carries" };
  if (provenance !== null && !provenance.namesPackage) return { status: "incompatible", basis: null, reason: "the provenance statement does not name the pinned package by its digest" };
  if (provenance !== null && !provenance.namesCommit) return { status: "incompatible", basis: null, reason: "the provenance statement that names the package does not name the pinned commit" };
  if (provenance === null && declaredRelease === null) return { status: "missing", basis: null, reason: "no provenance record is in the run and the seed names no recorder release" };
  if (outputsRead === 0) return { status: "missing", basis: null, reason: "no recorder output was read" };
  const each = `each of the ${outputsRead} recorder outputs read carries the provider and predicate that release writes`;
  return provenance === null
    ? { status: "present", basis: "declared", reason: `declared: the seed names REA ${RECORDER.release} and no provenance record is in the run, and ${each}` }
    : { status: "present", basis: "attested", reason: `attested: a provenance statement at ${PROVENANCE_PATH} names REA ${RECORDER.release}, its commit and its sha512, and its signatures are not verified; and ${each}` };
}

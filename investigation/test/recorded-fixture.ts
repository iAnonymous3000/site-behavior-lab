import { createHash } from "node:crypto";
import type { CapturePlan } from "../core/capture-adapter";
import type { ImportSeed } from "../core/imported-case";
import { RECORDER, RECORDER_LIMITATIONS } from "../core/recorder-shapes";

/**
 * A synthetic recorded run in the harness-runs layout, and a seed for it, with invented names on
 * reserved suffixes only. Every URL, script, request, time, count and id here is made up. Three
 * canaries sit where a capture would hold text no record may keep: in a URL path, in a query and in a
 * script's text. REA's envelope is built as 6.5.0 builds one, its evidence id included, with the
 * limitation sentences 6.5.0 writes, which are the recorder's own public text.
 */

export const PATH_CANARY = "PATHCANARY";
export const QUERY_CANARY = "QUERYCANARY";
export const TEXT_CANARY = "TEXTCANARY";

export const PAGE = "https://www.lantern.example";
export const THIRD = "https://cdn.orchard.test";

export const LAMP_URL = `${PAGE}/js/${PATH_CANARY}/lamp.js`;
export const WICK_URL = `${THIRD}/kit/wick.js`;
export const COLLECT_URL = `${PAGE}/collect?q=${QUERY_CANARY}`;

export const LAMP_TEXT = `function draw(c){var f=['monospace','serif','Arial','Courier'];c.measureText('a');c.measureText('b');}\nfunction gl(g){var d=g.getExtension('WEBGL_debug_renderer_info');return g.getParameter(d.UNMASKED_RENDERER_WEBGL);}\n// ${TEXT_CANARY}`;
export const WICK_TEXT = "var o=new OfflineAudioContext(1,22500,22500);o.createOscillator();o.createDynamicsCompressor();";
export const PROBE_TEXT = "function lampProbe(){return 1}\nfunction idleRoutine(){return 2}\nlampProbe();";
export const PATCH_BYTES = new TextEncoder().encode("--- a/hooks\n+++ b/hooks\n@@ synthetic @@\n");

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(typeof bytes === "string" ? utf8(bytes) : bytes).digest("hex");
const json = (value: unknown): Uint8Array => utf8(JSON.stringify(value));
export const scriptKey = (name: string): string => `scr_${sha(name)}`;

const drawStart = LAMP_TEXT.indexOf("function draw");
const drawEnd = LAMP_TEXT.indexOf("}\n") + 1;
const glStart = LAMP_TEXT.indexOf("function gl");
const glEnd = LAMP_TEXT.lastIndexOf("}") + 1;
export const MEASURE_OFFSETS = [LAMP_TEXT.indexOf("measureText"), LAMP_TEXT.lastIndexOf("measureText")];

/** REA 6.5.0's canonical JSON, restated here as an oracle the adapter's check is held to. */
export function reaCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(reaCanonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${reaCanonical(record[key])}`)
    .join(",")}}`;
}

/**
 * The evidence id 6.5.0 gives an envelope, restated from 6.5.0's own recipe (semanticProjection and
 * computeEvidenceId in the package's dist/mcp/nativeValueTrace-DR9UE62L.js), not from the module
 * under test: ev_ and the sha256 of the canonical JSON of the semantic fields, taking of the subject
 * only its digest, format and architecture, and relationship_coverage only when it is not null.
 */
export function evidenceIdOf(e: Readonly<Record<string, unknown>>): string {
  const subject = e.subject as Readonly<Record<string, unknown>> | null;
  const coverage = e.relationship_coverage;
  const projection = {
    subject: subject === null ? null : { digest: subject.digest, format: subject.format, architecture: subject.architecture },
    provider: e.provider,
    analysis_profile: e.analysis_profile,
    predicate_type: e.predicate_type,
    operation: e.operation,
    parameters: e.parameters,
    raw_result: e.raw_result,
    normalized_result: e.normalized_result,
    confidence: e.confidence,
    authority: e.authority,
    environment: e.environment,
    limitations: e.limitations,
    ...(coverage === null ? {} : { relationship_coverage: coverage }),
    locations: e.locations,
    evidence_links: e.evidence_links
  };
  return `ev_${sha(reaCanonical(projection))}`;
}

/** A subject as 6.5.0's schema spells one, every key present, for an output that names one. */
export const SUBJECT = { name: "lamp bundle", digest: { sha256: sha("synthetic subject") }, local_path: "/synthetic/lamp.js", format: "javascript", architecture: null };

/** REA's envelope around a normalized result, as 6.5.0 writes it, every key present and its evidence id computed. */
export const envelope = (predicate: string, operation: string, result: unknown, provider: Readonly<{ id: string; version: string } & Record<string, unknown>> = { id: "rea-cdp-browser", version: "2" }, extra: Readonly<Record<string, unknown>> = {}) => {
  const body: Record<string, unknown> = {
    subject: null,
    provider: { name: "synthetic provider", ...provider },
    analysis_profile: null,
    predicate_type: predicate,
    operation,
    parameters: { target_id: "SYNTHETICTARGET" },
    raw_result: null,
    normalized_result: result,
    confidence: "observed",
    authority: "external-service",
    environment: null,
    limitations: Object.keys(RECORDER_LIMITATIONS[predicate] ?? {}).slice(0, 3),
    relationship_coverage: null,
    locations: [],
    evidence_links: [],
    ...extra
  };
  return { evidence_id: evidenceIdOf(body), ...body };
};

type Source = Readonly<{ id: string; url: string; text: string | null; sha?: string; start?: Readonly<{ line_number: number; column_number: number }> | null }>;

export const observeResult = (sources: readonly Source[], coverage: readonly Readonly<{ id: string; functions: unknown[] }>[], requests: unknown[] = [], endReason = "window_elapsed") => ({
  window: { armed_at: "2025-06-07T08:09:10.000Z", ended_at: "2025-06-07T08:09:39.000Z", requested_ms: 29000, end_reason: endReason },
  coverage: { state: "captured", scripts: coverage.map(({ id, functions }) => ({ script_id: id, reported_url: "", functions })), excluded_scripts: 6 },
  requests,
  excluded_requests: 4,
  script_inventory: { main_document_scripts: sources.length, not_reported_script_ids: ["71", "72"], coverage_absence: "unknown" },
  sources: sources.map(({ id, url, text, sha: given, start }) => ({
    script_id: id,
    url,
    resource_start: start === undefined ? { line_number: 0, column_number: 0 } : start,
    source: text === null ? { state: "excluded", reason: "policy" } : { state: "captured", text, sha256: given ?? sha(text) }
  })),
  instrumentation: { cleanup: "confirmed" }
});

const range = (start: number, end: number, count: number) => ({ start_offset: start, end_offset: end, count });

/** Coverage of the lamp script: the page ran draw, and gl never ran. Nothing covers the wick script. */
export const LAMP_COVERAGE = [
  { name: "", ranges: [range(0, LAMP_TEXT.length, 1)] },
  { name: "draw", ranges: [range(drawStart, drawEnd, 2), range(LAMP_TEXT.lastIndexOf("c.measureText"), drawEnd - 1, 1)] },
  { name: "gl", ranges: [range(glStart, glEnd, 0)] }
];

const observeFile = (extra: Partial<Readonly<{ provider: Readonly<{ id: string; version: string }>; lampSha: string; endReason: string }>> = {}) =>
  json(
    envelope(
      "rea.observe-web-execution",
      "observe_web_execution",
      observeResult(
        [
          { id: "31", url: `${LAMP_URL}?v=${QUERY_CANARY}`, text: LAMP_TEXT, sha: extra.lampSha },
          { id: "32", url: WICK_URL, text: WICK_TEXT },
          { id: "33", url: `${THIRD}/kit/held.js`, text: null }
        ],
        [{ id: "31", functions: LAMP_COVERAGE }],
        [
          { request_id: "1", url: COLLECT_URL, method: "POST", callsites: [{ url: `${LAMP_URL}?v=${QUERY_CANARY}` }], causal_attribution: "unknown" },
          { request_id: "2", url: `${PAGE}/style.css`, method: "GET", callsites: [], causal_attribution: "unknown" }
        ],
        extra.endReason
      ),
      extra.provider
    )
  );

const rowFile = (calls: readonly string[], over: Readonly<Record<string, unknown>> = {}) =>
  json({
    startedAt: "2025-06-07T08:09:00.000Z",
    ms: 49000,
    reportRead: { atMs: 6100, attemptedFrames: 3, readableFrames: 3, summaryWithheldFrames: 0, attemptedWorkerRealms: 1, readableWorkerRealms: 1 },
    readKinds: [{ target: "first", atMs: 6100, main: ["audio-fingerprinting"], frames: [], workers: [] }, { target: 13500, atMs: 13500, main: ["audio-fingerprinting", "canvas-font-fingerprinting"], frames: [], workers: [] }],
    reportKinds: ["audio-fingerprinting", "some-other-kind"],
    rea: calls.map((label) => ({ label, code: 0, wallMs: 1000, stdoutBytes: 10 })),
    mainDocumentStatus: 200,
    landing: { path: "/", title: "Lantern" },
    ...over
  });

/** A logger frame list: one call inside a range coverage reported executed, one in a script coverage holds nothing of, and one with no http frame. */
export const witnessFile = (entries?: unknown[]) =>
  json([
    {
      isMain: true,
      url: `${PAGE}/`,
      value: JSON.stringify({
        timeOrigin: 1749283740000.25,
        overflow: 0,
        entries: entries ?? [
          { api: "canvas.measureText", frames: [{ origin: PAGE, path: `/js/${PATH_CANARY}/lamp.js`, line: 1, column: MEASURE_OFFSETS[1] + 1, viaEval: false }], count: 2, firstMs: 1700, lastMs: 1800 },
          { api: "audio.createOscillator", frames: [{ origin: THIRD, path: "/kit/wick.js", line: 1, column: WICK_TEXT.indexOf("createOscillator") + 1, viaEval: false }], count: 1, firstMs: 1100, lastMs: 1100 },
          { api: "webgl.getParameter", frames: [], count: 1, firstMs: 2100, lastMs: 2100 }
        ]
      })
    },
    { isMain: false, url: "about:blank", value: null }
  ]);

const SAVED = [
  { key: scriptKey("lamp"), url: `${LAMP_URL}?v=${QUERY_CANARY}`, path: `origins/0a/js/${PATH_CANARY}/lamp.js`, text: LAMP_TEXT },
  { key: scriptKey("wick"), url: WICK_URL, path: "origins/0b/kit/wick.js", text: WICK_TEXT }
];
export const LAMP_KEY = SAVED[0].key;

export const inspectFile = (items = SAVED.map(({ key, url }) => ({ script_key: key, url, frame_id: "F7" }))) =>
  json(envelope("rea.web-page-inspection", "inspect_web_page", { scripts: { total: items.length, items }, frames: [{ frame_id: "F7", parent_frame_id: null, url: `${PAGE}/` }], completeness: { excluded: [{ section: "scripts", reason: "disallowed_origin", count: 9 }] } }));

export const manifestFile = (entries = SAVED.map(({ key, url, path, text }) => ({ source: { kind: "page-script", script_key: key }, url, content: { state: "exported", relative_path: path, sha256: sha(text) } }))) => json({ scripts: entries });

const controlObserve = () =>
  json(
    envelope(
      "rea.observe-web-execution",
      "observe_web_execution",
      observeResult(
        [{ id: "7", url: "http://127.0.0.1:5000/probe.js", text: PROBE_TEXT }],
        [{ id: "7", functions: [{ name: "", ranges: [range(0, PROBE_TEXT.length, 1)] }, { name: "lampProbe", ranges: [range(0, 29, 1)] }, { name: "idleRoutine", ranges: [range(30, 63, 0)] }] }]
      )
    )
  );

export const ATTEMPT_RUNS = ["plain-1", "probed-1", "saved-1", "cover-1", "logged-1", "probed-2"] as const;

export const plan = (over: Partial<CapturePlan> = {}): CapturePlan => ({
  recorderRelease: RECORDER.release,
  provenancePath: null,
  recipes: [
    { id: "plain", instruments: ["sbl-hooks"] },
    { id: "saved", instruments: ["sbl-hooks", "rea-inspect"] },
    { id: "covered", instruments: ["sbl-hooks", "rea-coverage", "rea-inspect"] },
    { id: "logged", instruments: ["sbl-hooks", "logger", "rea-coverage", "rea-inspect"] },
    { id: "probed", instruments: ["sbl-hooks", "sbl-inspect"] }
  ],
  attempts: [
    { run: "plain-1", recipe: "plain", sourceIdentity: "reconstructed" },
    { run: "probed-1", recipe: "probed", sourceIdentity: "not_recorded" },
    { run: "saved-1", recipe: "saved", sourceIdentity: "reconstructed" },
    { run: "cover-1", recipe: "covered", sourceIdentity: "not_recorded" },
    { run: "logged-1", recipe: "logged", sourceIdentity: "reconstructed" },
    { run: "probed-2", recipe: "probed", sourceIdentity: "reconstructed" }
  ],
  identityScripts: [
    { label: "lamp", pathSuffix: "/lamp.js" },
    { label: "wick", pathSuffix: "/kit/wick.js" }
  ],
  requestTargets: [{ label: "collect", pathSuffix: "/collect" }],
  source: { baseCommit: "c0ffee", patch: { path: "harness/hooks.diff", sha256: sha(PATCH_BYTES) }, identity: "f".repeat(64), appliesTo: ["A01", "A03", "A05", "A06"] },
  control: {
    stage0Run: "control-0",
    fixturePath: "fixture/probe.js",
    fixturePathSuffix: "/probe.js",
    called: ["lampProbe"],
    uncalled: ["idleRoutine"],
    historical: { criterionAsWritten: "The probe ran and the other did not.", result: "met", observed: { probe: "ran" }, gate: "None.", deviation: "none", preserved: true },
    current: { text: "Known routines ran; an uncalled one above 0 fails.", note: "Synthetic." }
  },
  ...over
});

/** Every file the synthetic run holds, by its path inside the run folder. */
export const runFiles = (over: Readonly<Record<string, Uint8Array | null>> = {}): Map<string, Uint8Array | null> => {
  const files = new Map<string, Uint8Array | null>([
    ["harness/hooks.diff", PATCH_BYTES],
    ["fixture/probe.js", utf8(PROBE_TEXT)],
    ["runs/control-0/observe.json", controlObserve()],
    ["runs/plain-1/row.json", rowFile([])],
    ["runs/probed-1/row.json", rowFile([], { inspection: { address: `${PAGE}/{seg}/{seg}`, groups: [{}, {}, {}], matched: 2, withoutStack: 1, withoutNamedScript: 1, notListed: 0, unobserved: 0, redirected: 0 } })],
    ["runs/saved-1/row.json", rowFile(["inspect"])],
    ["runs/saved-1/inspect.json", inspectFile()],
    ["runs/saved-1/exported/manifest.json", manifestFile()],
    ...SAVED.map(({ path, text }) => [`runs/saved-1/exported/files/${path}`, utf8(text)] as const),
    ["runs/cover-1/row.json", rowFile(["observe", "inspect"])],
    ["runs/cover-1/observe.json", observeFile()],
    ["runs/logged-1/row.json", rowFile(["observe", "inspect"])],
    ["runs/logged-1/observe.json", observeFile()],
    ["runs/logged-1/witness.json", witnessFile()],
    ["runs/probed-2/row.json", rowFile([], { inspection: null })]
  ]);
  for (const [path, bytes] of Object.entries(over)) files.set(path, bytes);
  return files;
};

export { observeFile, rowFile, json, utf8 };

const PUBLISH_STATEMENT = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const PROVENANCE_STATEMENT = "https://slsa.dev/provenance/v1";

/**
 * A provenance record as npm writes 6.5.0's attestations: a publish statement and a build provenance
 * statement, each an in-toto statement in a DSSE envelope, unsigned here. Options take one statement
 * away or add a statement of another type or an entry that holds none (statements), name another
 * commit, digest or package, split the commit from the package into a second build provenance
 * statement (commitApart), give the publish statement another type (publishType), or put the package
 * and the commit on the publish statement instead of the build provenance one (namedOnPublish).
 */
export const PROVENANCE_RECORD = (over: Partial<Readonly<{ commit: string; digest: string; name: string; statements: readonly ("publish" | "provenance" | "other" | "junk")[]; commitApart: boolean; publishType: string; namedOnPublish: boolean }>> = {}): Uint8Array => {
  const name = over.name ?? `pkg:npm/rea-agents@${RECORDER.release}`;
  const digest = over.digest ?? RECORDER.integrity.replace(/^sha512:/, "");
  const commit = over.commit ?? RECORDER.commit;
  const statement = (predicateType: string, subject: unknown[], predicate: unknown) => ({ predicateType, bundle: { dsseEnvelope: { payload: btoa(JSON.stringify({ subject, predicateType, predicate })), signatures: [] } } });
  const named = [{ name, digest: { sha512: digest } }];
  const built = { buildDefinition: { resolvedDependencies: [{ uri: "git+https://forge.example/rea.git", digest: { gitCommit: commit } }] } };
  const provenance = over.commitApart
    ? [statement(PROVENANCE_STATEMENT, named, { buildDefinition: { resolvedDependencies: [] } }), statement(PROVENANCE_STATEMENT, [], built)]
    : over.namedOnPublish
      ? [statement(PROVENANCE_STATEMENT, [], { buildDefinition: { resolvedDependencies: [] } })]
      : [statement(PROVENANCE_STATEMENT, named, built)];
  const publish = statement(over.publishType ?? PUBLISH_STATEMENT, named, over.namedOnPublish ? { name: "rea-agents", version: RECORDER.release, ...built } : { name: "rea-agents", version: RECORDER.release });
  const parts = { publish: [publish], provenance, other: [statement("https://attestation.example/other/v1", [], {})], junk: [{ predicateType: "unreadable", bundle: { dsseEnvelope: { payload: "not base64 !" } } }] };
  return json({ attestations: (over.statements ?? ["publish", "provenance"]).flatMap((part) => parts[part]) });
};

/** A seed whose claims rest on the synthetic rows. */
export const seed = (over: Partial<ImportSeed> = {}): ImportSeed => ({
  question: "Which synthetic script ran the measuring calls?",
  provenanceGaps: ["The second attempt's source identity was not recorded."],
  deviations: [{ id: "dev-one", summary: "Synthetic deviation." }],
  independentReproduction: { state: "none", note: "One synthetic run." },
  facts: [
    { id: "fact-reads", statement: "Every attempt read audio.", evidence: ["E-A01-read", "E-A02-read", "E-A03-read", "E-A04-read", "E-A05-read", "E-A06-read"] },
    { id: "fact-lamp-digest", statement: "The lamp script had one digest.", evidence: ["E-A03-identity-lamp", "E-A04-identity-lamp", "E-A05-identity-lamp"] }
  ],
  assertions: [{ id: "said-cache", statement: "Someone said the wick script is cached." }],
  interpretations: [{ id: "reading-lamp", statement: "The lamp script measures text.", cites: [{ fact: "fact-lamp-digest", version: 1 }] }],
  unknowns: [{ id: "unknown-cadence", question: "How often does the lamp script load?", reason: "not_observed", detail: null, wouldResolve: null }],
  ...over
});

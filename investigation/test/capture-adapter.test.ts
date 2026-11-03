import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as production from "../core/capture-adapter";
import type { CapturePlan, CaptureResult, Files } from "../core/capture-adapter";
import { importCase, readImportedRow, type ImportedCase, type ImportedRow } from "../core/imported-case";
import { checkEvidenceId, PROVENANCE_PATH, readProvenance, RECORDER, RECORDER_LIMITATIONS } from "../core/recorder-shapes";
import { assessSufficiency, type Question } from "../core/sufficiency";
import { projectAttemptSummary } from "../core/summary-tier";
import {
  COLLECT_URL,
  envelope,
  inspectFile,
  json,
  LAMP_COVERAGE,
  LAMP_KEY,
  LAMP_TEXT,
  LAMP_URL,
  manifestFile,
  MEASURE_OFFSETS,
  observeFile,
  observeResult,
  PAGE,
  PATH_CANARY,
  evidenceIdOf,
  plan,
  PROVENANCE_RECORD,
  reaCanonical,
  QUERY_CANARY,
  rowFile,
  runFiles,
  scriptKey,
  seed,
  sha,
  SUBJECT,
  TEXT_CANARY,
  THIRD,
  utf8,
  WICK_TEXT,
  WICK_URL,
  witnessFile
} from "./recorded-fixture";

/**
 * The adapter for the harness-runs layout, on a synthetic run. It maps what each attempt recorded,
 * keeps M1's two failures apart, refuses what it does not know, lets no capture text into what it
 * makes, and surveys a run from the same reading it imports from.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/capture-adapter"), edits);

/** Read the run the way the local reader would: ask, hand over what was asked, ask again. */
function asked(module: Module, thePlan: CapturePlan, all: Files): Map<string, Uint8Array | null> {
  const files = new Map<string, Uint8Array | null>();
  for (let round = 0; round < 10; round += 1) {
    const wanted = module.capturePathsNeeded(thePlan, files);
    if (wanted.length === 0) return files;
    for (const path of wanted) files.set(path, all.get(path) ?? null);
  }
  throw new Error("the paths never settled");
}

async function adapted(module: Module = production, thePlan: CapturePlan = plan(), all: Files = runFiles()): Promise<CaptureResult> {
  return module.adaptCaptureRun(thePlan, asked(module, thePlan, all));
}

async function okRun(module: Module = production, thePlan: CapturePlan = plan(), all: Files = runFiles()) {
  const result = await adapted(module, thePlan, all);
  assert.ok(result.ok, `the adapter read the run: ${JSON.stringify(result)}`);
  return result;
}

const QUESTION: Question = { id: "synthetic", text: "Which synthetic script made each call?", requirements: [{ kinds: ["script-inventory", "script-execution"], within: "one-attempt", atLeast: 1 }, { kinds: ["recorder-identity"], within: "the-run" }] };

/** Import, as the private run does: the plan, the bytes read, the seed and the question, and the import reads and assesses them itself. */
async function imported(thePlan: CapturePlan = plan(), all: Files = runFiles()): Promise<ImportedCase> {
  const made = await importCase({ plan: thePlan, files: asked(production, thePlan, all), seed: seed(), question: QUESTION });
  assert.ok(made.ok, `the import read and assessed this run: ${JSON.stringify(made)}`);
  return made.case;
}

test("each attempt maps as its recipe and its files say, and the case records the adapter that read it and the basis of its recorder identity", async () => {
  const { run, digestsRecomputed, sourcesNotRead } = await okRun();
  assert.deepEqual(run.adapter, production.CAPTURE_ADAPTER);
  assert.deepEqual(run.adapter.recorder, RECORDER);
  assert.equal(run.recorderBasis, "declared");
  assert.deepEqual(
    run.attempts.map(({ id, run: folder, acquisition, instruments }) => [id, folder, acquisition, instruments.map(({ name, completeness }) => `${name}:${completeness}`)]),
    [
      ["A01", "plain-1", "usable", ["sbl-hooks:complete"]],
      ["A02", "probed-1", "usable", ["sbl-hooks:complete", "sbl-inspect:complete"]],
      ["A03", "saved-1", "usable", ["sbl-hooks:complete", "rea-inspect:partial"]],
      ["A04", "cover-1", "usable", ["sbl-hooks:complete", "rea-coverage:partial", "rea-inspect:partial"]],
      ["A05", "logged-1", "usable", ["sbl-hooks:complete", "rea-coverage:partial", "rea-inspect:partial", "logger:partial"]],
      ["A06", "probed-2", "incomplete", ["sbl-hooks:complete", "sbl-inspect:missing"]]
    ]
  );
  assert.equal(run.attempts[5].acquisitionReason, "the recorded row holds no output for an instrument its recipe names");
  assert.equal(run.attempts[3].instruments[1].cleanup, "confirmed");
  assert.equal(run.attempts[3].instruments[1].reason, "excluded 6 scripts and 4 requests; 2 scripts without a coverage record; the selected main frame and origins only; nothing before arming");
  assert.deepEqual(run.attempts[0].page, { status: 200 });
  assert.deepEqual([run.attempts[0].startedAt, run.attempts[0].durationMs], ["2025-06-07T08:09:00.000Z", 49000]);
  assert.equal(digestsRecomputed, 6);
  assert.equal(sourcesNotRead, 2);
  const ids = run.rows.map(({ id }) => id);
  assert.deepEqual(
    ids.filter((id) => id.startsWith("E-A05")),
    [
      "E-A05-read",
      "E-A05-identity-lamp",
      "E-A05-identity-wick",
      `E-A05-cov-lamp-canvas-font-${MEASURE_OFFSETS[0]}`,
      `E-A05-cov-lamp-canvas-font-${MEASURE_OFFSETS[1]}`,
      `E-A05-cov-lamp-webgl-${LAMP_TEXT.indexOf("WEBGL_debug_renderer_info")}`,
      `E-A05-cov-lamp-webgl-${LAMP_TEXT.indexOf("UNMASKED_RENDERER_WEBGL")}`,
      `E-A05-cov-wick-audio-${WICK_TEXT.indexOf("createDynamicsCompressor")}`,
      `E-A05-cov-wick-audio-${WICK_TEXT.indexOf("createOscillator")}`,
      "E-A05-req-collect",
      "E-A05-logger-lamp-canvas.measureText",
      "E-A05-link-lamp-canvas.measureText",
      "E-A05-logger-wick-audio.createOscillator",
      "E-A05-link-wick-audio.createOscillator",
      "E-A05-logger-none-webgl.getParameter",
      "E-A05-link-none-webgl.getParameter"
    ]
  );
  assert.equal(ids.length, 33);
  assert.deepEqual(ids.filter((id) => id.startsWith("E-A06")), ["E-A06-read"], "an instrument that left nothing leaves no row");
  assert.deepEqual(ids.filter((id) => id.startsWith("E-A02")), ["E-A02-inspect", "E-A02-read"]);
  assert.deepEqual(ids.filter((id) => id.startsWith("E-A03")), ["E-A03-read", "E-A03-identity-lamp", "E-A03-identity-wick"]);
});

const row = (rows: readonly ImportedRow[], id: string): ImportedRow => {
  const found = rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

test("rows keep states and counts as the capture gave them: missing coverage is no record, never a 0", async () => {
  const { run } = await okRun();
  const states = (prefix: string) => run.rows.filter(({ id }) => id.startsWith(prefix)).map(({ state }) => state);
  assert.deepEqual(states("E-A04-cov-lamp-canvas-font"), ["present", "present"]);
  assert.deepEqual(states("E-A04-cov-wick-audio"), ["no_record", "no_record"]);
  const ran = row(run.rows, `E-A04-cov-lamp-canvas-font-${MEASURE_OFFSETS[1]}`);
  assert.deepEqual(ran.observation, { subject: "anchor-executions", count: 1, granularity: "block", windowEnd: "window_closed", scope: "in_scope" });
  const idle = row(run.rows, `E-A04-cov-lamp-webgl-${LAMP_TEXT.indexOf("UNMASKED_RENDERER_WEBGL")}`);
  assert.equal(idle.observation?.count, 0);
  const missing = row(run.rows, `E-A04-cov-wick-audio-${WICK_TEXT.indexOf("createOscillator")}`);
  assert.deepEqual([missing.digest, missing.observation], [null, null]);
  assert.equal(row(run.rows, "E-A05-link-lamp-canvas.measureText").state, "present");
  assert.equal(row(run.rows, "E-A05-link-wick-audio.createOscillator").state, "no_record");
  assert.equal(row(run.rows, "E-A05-link-none-webgl.getParameter").state, "no_record");
  const link = row(run.rows, "E-A05-link-lamp-canvas.measureText");
  assert.ok(link.topic === "calls-in-executed-ranges");
  assert.deepEqual([link.calls, link.inside], [2, 2]);
  const read = row(run.rows, "E-A01-read");
  assert.ok(read.topic === "report-read");
  assert.deepEqual([read.reportKinds, read.laterKinds, read.limits], [["audio-fingerprinting"], ["canvas-font-fingerprinting"], []]);
  const c = await imported();
  assert.equal(readImportedRow(c, idle).reading, "zero_in_window");
  assert.equal(readImportedRow(c, ran).reading, "observed");
  assert.equal(readImportedRow(c, missing).reading, "unknown");
});

const NO_TEXT = "no URL path, query, request method, date comment or script text from a capture reaches what the adapter makes";

const checkNoText = (made: unknown) => {
  const text = JSON.stringify(made);
  for (const canary of [PATH_CANARY, QUERY_CANARY, TEXT_CANARY, "/kit/wick.js", "measureText('a')", "CANARYMETHOD"]) holds(NO_TEXT, !text.includes(canary), () => canary);
};

test("no URL path, query, request method, date comment or script text from a capture reaches the run, the rows, the objects or a case made from them", async () => {
  const { run } = await okRun();
  const files = asked(production, plan(), runFiles());
  const raw = [...files.values()].map((bytes) => (bytes === null ? "" : new TextDecoder().decode(bytes))).join("\n");
  for (const canary of [PATH_CANARY, QUERY_CANARY, TEXT_CANARY]) assert.ok(raw.includes(canary), canary);
  assert.ok([...files.keys()].some((path) => path.includes(PATH_CANARY)), "a saved script's file mirrors its URL's path");
  checkNoText(run);
  checkNoText(await imported());
  const leaking = variant({ find: "objects.push({ path: (_a = names.get(path)) !== null && _a !== void 0 ? _a : (saved === null ? path : `${saved[1]}/files#unlisted`), digest, bytes: bytes.length });", replace: "objects.push({ path, digest, bytes: bytes.length });" });
  await assertCaughtBy("objects named by the saved files' paths", NO_TEXT, async () => checkNoText((await okRun(leaking)).run.objects));
  const withPath = variant({ find: "return { origin: originOfUrl(url), pathDigest: await pathDigestOf(url), textDigest: digest };", replace: "return { origin: originOfUrl(url), pathDigest: url, textDigest: digest };" });
  await assertCaughtBy("a script kept by its URL", NO_TEXT, async () => checkNoText((await okRun(withPath)).run.rows));
  const oddMethod = runFiles({ "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], [], [{ url: COLLECT_URL, method: "CANARYMETHOD", callsites: [], causal_attribution: "unknown" }]))) });
  const odd = await okRun(production, plan(), oddMethod);
  const request = row(odd.run.rows, "E-A04-req-collect");
  assert.ok(request.topic === "request");
  assert.equal(request.request.method, "nonstandard");
  checkNoText(odd.run);
  const commented = await okRun(production, plan(), runFiles({ "runs/plain-1/row.json": rowFile([], { startedAt: `Sat, 07 Jun 2025 08:09:00 GMT (${PATH_CANARY})` }) }));
  assert.equal(commented.run.attempts[0].startedAt, "2025-06-07T08:09:00.000Z");
  checkNoText(commented.run);
  const probe = await okRun(production, plan(), runFiles({ "runs/probed-1/row.json": rowFile([], { inspection: { address: `${PAGE}/${PATH_CANARY}/x?q=${QUERY_CANARY}`, groups: [], matched: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 0, unobserved: 0, redirected: 0 } }) }));
  checkNoText(probe.run);
  const inspectRow = row(probe.run.rows, "E-A02-inspect");
  assert.ok(inspectRow.topic === "connection-inspection");
  assert.deepEqual(inspectRow.address, { origin: PAGE, pathDigest: sha(`/${PATH_CANARY}/x`) });
  const identity = row(run.rows, "E-A04-identity-lamp");
  assert.ok(identity.topic === "script-identity");
  assert.deepEqual(identity.script, { origin: PAGE, pathDigest: sha(new URL(LAMP_URL).pathname), textDigest: sha(LAMP_TEXT) });
  const kept = row(run.rows, "E-A04-req-collect");
  assert.ok(kept.topic === "request");
  assert.deepEqual(kept.request, { method: "POST", origin: PAGE, pathDigest: sha(new URL(COLLECT_URL).pathname) });
});

test("a saved file no manifest names is named in the objects only as unlisted", async () => {
  const files = asked(production, plan(), runFiles());
  files.set(`runs/saved-1/exported/files/origins/0c/${PATH_CANARY}/extra.js`, utf8("var extra;"));
  const result = await production.adaptCaptureRun(plan(), files);
  assert.ok(result.ok);
  const names = result.run.objects.map(({ path }) => path);
  assert.ok(names.includes("runs/saved-1/exported/files#unlisted"), JSON.stringify(names));
  assert.ok(!names.some((name) => name.includes(PATH_CANARY)), JSON.stringify(names));
});

test("the adapter's origin is the summary tier's, for every URL here", async () => {
  const urls = [LAMP_URL, `${LAMP_URL}?v=${QUERY_CANARY}`, WICK_URL, COLLECT_URL, "data:text/javascript,1", "blob:https://www.lantern.example/abc", "https://user:pw@www.lantern.example:8443/x", "HTTPS://WWW.LANTERN.EXAMPLE/Y", "wss://socket.orchard.test/z", "not a url", "https://[::1]:9/q", "https://xn--fiq228c.example/"];
  const summary = await projectAttemptSummary({ attemptId: "a".repeat(32), slot: "B1", arm: "baseline", phase: "usable" }, { scripts: urls.map((url) => ({ url, text: "x", ranges: [] })), requests: [], storage: [], console: [] });
  assert.ok(summary.ok);
  assert.deepEqual(
    urls.map((url) => production.originOfUrl(url)),
    summary.summary.scripts.map(({ origin }) => origin)
  );
});

test("a shape the adapter does not know refuses the whole import, and names the file and field only", async () => {
  const cases: readonly (readonly [string, Readonly<Record<string, Uint8Array | null>>, string])[] = [
    ["an observe output from another provider version", { "runs/cover-1/observe.json": observeFile({ provider: { id: "rea-cdp-browser", version: "3" } }) }, "runs/cover-1/observe.json: provider"],
    ["an observe output that is not JSON", { "runs/cover-1/observe.json": utf8("{ not json") }, "runs/cover-1/observe.json: not JSON"],
    ["a row with no duration", { "runs/plain-1/row.json": json({ startedAt: "2025-06-07T08:09:00.000Z", reportRead: {}, readKinds: [], rea: [] }) }, "runs/plain-1/row.json: startedAt or ms"],
    ["a row with no report kinds", { "runs/plain-1/row.json": rowFile([], { reportKinds: undefined }) }, "runs/plain-1/row.json: reportKinds"],
    ["a row whose report kinds are not text", { "runs/plain-1/row.json": rowFile([], { reportKinds: ["audio-fingerprinting", 7] }) }, "runs/plain-1/row.json: reportKinds"],
    ["a row whose report read counts no frames", { "runs/plain-1/row.json": rowFile([], { reportRead: { atMs: 1 } }) }, "runs/plain-1/row.json: reportRead.summaryWithheldFrames"],
    ["a logger entry naming a method the logger does not wrap", { "runs/logged-1/witness.json": witnessFile([{ api: "canvas.toDataURL", frames: [], count: 1, firstMs: 1, lastMs: 1 }]) }, "runs/logged-1/witness.json: entries"],
    ["a logger entry counting no call", { "runs/logged-1/witness.json": witnessFile([{ api: "canvas.measureText", frames: [], count: 0, firstMs: 1, lastMs: 1 }]) }, "runs/logged-1/witness.json: entries"],
    ["a window that ended in a way 6.5.0 never writes", { "runs/cover-1/observe.json": observeFile({ endReason: "target_closed" }) }, "runs/cover-1/observe.json: window.end_reason"],
    ["a request attribution longer than one word", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], [], [{ url: COLLECT_URL, method: "POST", callsites: [], causal_attribution: `the page said ${QUERY_CANARY}` }]))) }, "runs/cover-1/observe.json: requests"],
    ["a cleanup longer than one word", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", { ...observeResult([], []), instrumentation: { cleanup: "Confirmed by the page" } })) }, "runs/cover-1/observe.json: instrumentation.cleanup"],
    ["two sources under one script id", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([{ id: "31", url: LAMP_URL, text: LAMP_TEXT }, { id: "31", url: WICK_URL, text: WICK_TEXT }], [{ id: "31", functions: LAMP_COVERAGE }]))) }, "runs/cover-1/observe.json: sources.script_id"],
    ["an envelope key 6.5.0 does not write", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], []), undefined, { release: "6.6.0" })) }, "runs/cover-1/observe.json: envelope keys"],
    ["a limitation sentence 6.5.0 does not write", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], []), undefined, { limitations: ["Everything was seen."] })) }, "runs/cover-1/observe.json: limitations"],
    ["a script key not spelled as REA spells one", { "runs/saved-1/inspect.json": json(envelope("rea.web-page-inspection", "inspect_web_page", { scripts: { items: [{ script_key: `scr_${PATH_CANARY}`, url: LAMP_URL, frame_id: "F7" }] }, frames: [], completeness: { excluded: [] } })) }, "runs/saved-1/inspect.json: scripts.items"],
    ["two saved scripts sharing one file", { "runs/saved-1/exported/manifest.json": manifestFile([0, 1].map((n) => ({ source: { kind: "page-script", script_key: scriptKey(`k${n}`) }, url: LAMP_URL, content: { state: "exported", relative_path: "origins/0a/same.js", sha256: sha(LAMP_TEXT) } }))) }, "runs/saved-1/exported/manifest.json: scripts.content.relative_path"],
    ["a logger record with no main frame", { "runs/logged-1/witness.json": json([{ isMain: false, url: "about:blank", value: JSON.stringify({ timeOrigin: 1, overflow: 0, entries: [] }) }]) }, "runs/logged-1/witness.json: the main frame"],
    ["a logger record with two main frames", { "runs/logged-1/witness.json": json([0, 1].map(() => ({ isMain: true, url: `${PAGE}/`, value: JSON.stringify({ timeOrigin: 1, overflow: 0, entries: [] }) }))) }, "runs/logged-1/witness.json: the main frame"],
    ["a main logger frame with no value", { "runs/logged-1/witness.json": json([{ isMain: true, url: `${PAGE}/`, value: null }]) }, "runs/logged-1/witness.json: the main frame's value"]
  ];
  for (const [name, over, at] of cases) {
    const result = await adapted(production, plan(), runFiles(over));
    assert.deepEqual(result, { ok: false, refusal: "unknown-shape", at }, name);
  }
  // An REA output a row records a call for, and not there, refuses; the logger's frames file is the recipe's own instrument output, and its absence records an incomplete attempt (below).
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": null })), { ok: false, refusal: "missing-file", at: "runs/cover-1/observe.json: the file" });
});

test("each field the readers keep is held to its shape, and an output under another predicate, operation or provider is refused", async () => {
  const lamp = observeResult([{ id: "31", url: LAMP_URL, text: LAMP_TEXT }], []);
  const observed = (result: unknown, provider?: Readonly<{ id: string; version: string }>) => json(envelope("rea.observe-web-execution", "observe_web_execution", result, provider));
  const withSource = (body: unknown, start: unknown = { line_number: 0, column_number: 0 }) => ({ ...observeResult([], []), sources: [{ script_id: "31", url: LAMP_URL, resource_start: start, source: body }] });
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile())) as { scripts: { content: { sha256: string } }[] };
  manifest.scripts[0].content.sha256 = manifest.scripts[0].content.sha256.toUpperCase();
  const inspectedThree = inspectFile([
    { script_key: LAMP_KEY, url: `${LAMP_URL}?v=${QUERY_CANARY}`, frame_id: "F7" },
    { script_key: scriptKey("wick"), url: WICK_URL, frame_id: "F7" },
    { script_key: scriptKey("ember"), url: `${PAGE}/ember.js`, frame_id: "F7" }
  ]);
  const cases: readonly (readonly [string, Readonly<Record<string, Uint8Array | null>>, string])[] = [
    ["an observe output that is not UTF-8", { "runs/cover-1/observe.json": new Uint8Array([0x7b, 0xff, 0x7d]) }, "runs/cover-1/observe.json: not UTF-8"],
    ["an observe output under the inspection's predicate", { "runs/cover-1/observe.json": json(envelope("rea.web-page-inspection", "observe_web_execution", lamp)) }, "runs/cover-1/observe.json: predicate_type"],
    ["an observe output under the inspection's operation", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "inspect_web_page", lamp)) }, "runs/cover-1/observe.json: operation"],
    ["an observe output from another provider of the same version", { "runs/cover-1/observe.json": observed(lamp, { id: "another-provider", version: "2" }) }, "runs/cover-1/observe.json: provider"],
    ["a window that ended before it was armed", { "runs/cover-1/observe.json": observed({ ...lamp, window: { armed_at: "2025-06-07T08:09:39.000Z", ended_at: "2025-06-07T08:09:10.000Z", requested_ms: 29000, end_reason: "window_elapsed" } }) }, "runs/cover-1/observe.json: window"],
    ["two coverage records under one script id", { "runs/cover-1/observe.json": observed(observeResult([], [{ id: "99", functions: LAMP_COVERAGE }, { id: "99", functions: LAMP_COVERAGE }])) }, "runs/cover-1/observe.json: coverage.scripts.script_id"],
    ["a covered function with no ranges", { "runs/cover-1/observe.json": observed(observeResult([], [{ id: "99", functions: [{ name: "draw", ranges: [] }] }])) }, "runs/cover-1/observe.json: coverage.scripts.functions"],
    ["a source in a state 6.5.0 does not write", { "runs/cover-1/observe.json": observed(withSource({ state: "partial", text: LAMP_TEXT, sha256: sha(LAMP_TEXT) })) }, "runs/cover-1/observe.json: sources.source.state"],
    ["a captured source's digest in capitals", { "runs/cover-1/observe.json": observed(withSource({ state: "captured", text: LAMP_TEXT, sha256: sha(LAMP_TEXT).toUpperCase() })) }, "runs/cover-1/observe.json: sources.source.sha256"],
    ["a start with a line and no column", { "runs/cover-1/observe.json": observed(withSource({ state: "excluded", reason: "policy" }, { line_number: 1, column_number: -1 })) }, "runs/cover-1/observe.json: sources.resource_start"],
    ["a callsite whose address is not text", { "runs/cover-1/observe.json": observed(observeResult([], [], [{ url: COLLECT_URL, method: "POST", callsites: [{ url: 7 }], causal_attribution: "unknown" }])) }, "runs/cover-1/observe.json: requests.callsites"],
    ["an inspection output that is not JSON", { "runs/saved-1/inspect.json": utf8("{ not json") }, "runs/saved-1/inspect.json: not JSON"],
    ["a manifest that is not JSON", { "runs/saved-1/exported/manifest.json": utf8("{ not json") }, "runs/saved-1/exported/manifest.json: not JSON"],
    ["a saved script's digest in capitals", { "runs/saved-1/exported/manifest.json": json(manifest) }, "runs/saved-1/exported/manifest.json: scripts.content.sha256"],
    ["an inspected script with no saved file", { "runs/saved-1/inspect.json": inspectedThree }, "runs/saved-1/exported/manifest.json: no saved file for an inspected script"],
    ["limitations that are not a list", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], []), undefined, { limitations: "none stated" })) }, "runs/cover-1/observe.json: limitations"],
    ["an observation carrying an inspection's limitation", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], []), undefined, { limitations: [Object.keys(RECORDER_LIMITATIONS["rea.web-page-inspection"])[1]] })) }, "runs/cover-1/observe.json: limitations"],
    ["an evidence id not spelled as REA spells one", { "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], []), undefined, { evidence_id: "EV_SYNTHETIC" })) }, "runs/cover-1/observe.json: evidence_id"]
  ];
  for (const [name, over, at] of cases) {
    assert.deepEqual(await adapted(production, plan(), runFiles(over)), { ok: false, refusal: "unknown-shape", at }, name);
  }
});

test("every field of the plan is held to its shape: four digits of attempts, a recipe each attempt names, instruments by name, one label each, and a control and patch of their own shapes", async () => {
  const many = Array.from({ length: 10000 }, (_, index) => ({ run: `spare-${index}`, recipe: "plain", sourceIdentity: "not_recorded" as const }));
  const base = plan();
  const control = base.control as NonNullable<CapturePlan["control"]>;
  const source = base.source as NonNullable<CapturePlan["source"]>;
  for (const [name, bad, at] of [
    ["ten thousand attempts, past A9999", plan({ attempts: many, source: null }), "attempts"],
    ["a run named twice", plan({ attempts: [base.attempts[0], base.attempts[0]] }), "attempts.run"],
    ["an attempt naming no recipe", plan({ attempts: [{ run: "spare-1", recipe: "absent", sourceIdentity: "not_recorded" }], source: null }), "attempts.recipe"],
    ["a recipe naming an instrument no layout has", plan({ recipes: [...base.recipes, { id: "odd", instruments: ["sbl-hooks", "telescope"] }] }), "recipes"],
    ["one label for two scripts", plan({ identityScripts: [{ label: "lamp", pathSuffix: "/lamp.js" }, { label: "lamp", pathSuffix: "/kit/wick.js" }] }), "identityScripts"],
    ["a control run that is a path", plan({ control: { ...control, stage0Run: "runs/control-0" } }), "control"],
    ["a patch digest in capitals", plan({ source: { ...source, patch: { ...source.patch, sha256: source.patch.sha256.toUpperCase() } } }), "source"]
  ] as const) {
    assert.deepEqual(await production.adaptCaptureRun(bad, new Map()), { ok: false, refusal: "plan-malformed", at }, name);
  }
  assert.deepEqual(await adapted(production, plan(), runFiles({ "fixture/probe.js": null })), { ok: false, refusal: "missing-file", at: "fixture/probe.js: the fixture" });
});

test("the envelope's nested objects are held to 6.5.0's own keys, and of the subject only what 6.5.0 hashes is in the id", async () => {
  const lamp = observeResult([{ id: "31", url: LAMP_URL, text: LAMP_TEXT }], []);
  const at = (extra: Readonly<Record<string, unknown>>) => adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", lamp, undefined, extra)) }));
  // A subject 6.5.0 spells in full reads, and its name and local path are not in the id, by 6.5.0's design.
  assert.equal((await at({ subject: SUBJECT })).ok, true);
  const named = JSON.parse(new TextDecoder().decode(json(envelope("rea.observe-web-execution", "observe_web_execution", lamp, undefined, { subject: SUBJECT })))) as { subject: { name: string; digest: { sha256: string } } };
  named.subject.name = "renamed after the id";
  assert.equal((await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(named) }))).ok, true);
  named.subject.digest.sha256 = "0".repeat(64);
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(named) })), { ok: false, refusal: "digest-mismatch", at: "runs/cover-1/observe.json: evidence_id" });
  for (const [name, extra, field] of [
    ["a subject with a key 6.5.0 does not write", { subject: { ...SUBJECT, release: "6.6.0" } }, "subject"],
    ["a subject missing its local path", { subject: { name: SUBJECT.name, digest: SUBJECT.digest, format: SUBJECT.format, architecture: null } }, "subject"],
    ["a subject digest of another kind", { subject: { ...SUBJECT, digest: { sha512: "0".repeat(128) } } }, "subject"],
    ["a subject digest with a second kind beside its sha256", { subject: { ...SUBJECT, digest: { ...SUBJECT.digest, sha512: "0".repeat(128) } } }, "subject"],
    ["a provider with a release", { provider: { id: "rea-cdp-browser", name: "synthetic provider", version: "2", release: "6.6.0" } }, "provider"],
    ["a provider with no name", { provider: { id: "rea-cdp-browser", version: "2" } }, "provider"],
    ["an environment with a release", { environment: { id: "synthetic browser", platform: "unknown", architecture: "unknown", isolation: "none", release: "6.6.0" } }, "environment"],
    ["an environment that is text", { environment: "6.6.0" }, "environment"],
    ["an analysis profile", { analysis_profile: { provider: { id: "rea-cdp-browser", name: "synthetic provider", version: "2" } } }, "analysis_profile"],
    ["a subject name that is not text", { subject: { ...SUBJECT, name: 7 } }, "subject"],
    ["a subject sha256 that is not hex", { subject: { ...SUBJECT, digest: { sha256: "not hex" } } }, "subject"],
    ["an environment platform that is not text", { environment: { id: "synthetic browser", platform: 7, architecture: "unknown", isolation: "none" } }, "environment"],
    ["a provider name that is not text", { provider: { id: "rea-cdp-browser", name: 7, version: "2" } }, "provider"]
  ] as const) {
    assert.deepEqual(await at(extra), { ok: false, refusal: "unknown-shape", at: `runs/cover-1/observe.json: ${field}` }, name);
  }
  assert.equal((await at({ environment: { id: "synthetic browser", platform: "unknown", architecture: "unknown", isolation: "none" } })).ok, true);
  // The fixture's own builder keeps a key the provider is given beyond its id and version, so this refusal is of the output, not of a test that never wrote the key.
  const extraKey = json(envelope("rea.observe-web-execution", "observe_web_execution", lamp, { id: "rea-cdp-browser", version: "2", release: "6.6.0" }));
  assert.ok(new TextDecoder().decode(extraKey).includes('"release":"6.6.0"'));
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": extraKey })), { ok: false, refusal: "unknown-shape", at: "runs/cover-1/observe.json: provider" });
});

test("the envelope's keys are 6.5.0's sixteen, by count and by name, and its limitations are its vocabulary's, each once", async () => {
  const written = JSON.parse(new TextDecoder().decode(observeFile())) as Record<string, unknown>;
  const withoutLocations = Object.fromEntries(Object.entries(written).filter(([key]) => key !== "locations"));
  const swapped = { ...withoutLocations, release: [] };
  for (const [name, body] of [
    ["fifteen keys, locations missing", withoutLocations],
    ["sixteen keys, locations swapped for release", swapped]
  ] as const) {
    assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(body) })), { ok: false, refusal: "unknown-shape", at: "runs/cover-1/observe.json: envelope keys" }, name);
  }
  const sentence = Object.keys(RECORDER_LIMITATIONS["rea.observe-web-execution"])[0];
  for (const [name, limitations] of [
    ["an inherited name", ["constructor"]],
    ["a prototype name", ["__proto__"]],
    ["one sentence twice", [sentence, sentence]]
  ] as const) {
    assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], []), undefined, { limitations })) })), { ok: false, refusal: "unknown-shape", at: "runs/cover-1/observe.json: limitations" }, name);
  }
});

/** The nineteen pairs, sha256 of each sentence to its identifier, computed once from 6.5.0's own dist, where every sentence is a literal. The text itself is written only in recorder-shapes.ts. */
const LIMITATION_PINS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "rea.observe-web-execution": {
    "0e804c2cdd7d1c808494ab8cc937d87f8e1c023b7c657f47ff867a32954d8c97": "block-granularity-not-guaranteed",
    "64658854befb1f6b5c502076764f91e26d2690ed408e6fb84cd2196b8e3b33f9": "artifact-identity-unavailable",
    "94d53ae668c32c2c6641402efc44ec889d427b7c368b3a13c9f031a122ab6627": "metadata-budgets",
    "9a02efb59082eb57001ffb112c58fdabb1b5f8116e75216b1eea1881f91d7a6b": "main-document-scripts-only",
    c54419b4f733dc2bc51e1b147f3b87ff0317285f64ecaf2401033269e4f260cf: "precise-coverage-affects-timing",
    "84b1745da6e79894cfa4a670a0e2e4ddf1a2c14229a08b20856dc58abebec3fb": "previously-parsed-scripts-may-be-absent",
    "3b0284d10fdcaf96b9ad5183cd25d8ed4ee240d145882f437e299186d32aecdd": "producer-hash-not-text-digest",
    b8bbc776cd662e4682aa9c5c2b435240b2e35507c0c74642790ca4ef67c90989: "callsites-are-reported-initiators",
    d170de384b618c37f6fda7898890a1de29bf6e85376b9fd4f23fb93153ad0afe: "sources-frozen-after-final-sample",
    "38378bb7f787474d87c3bc126ff29ef577b0fa5d213b1571fd2352416521eba6": "local-and-backend-clocks-differ",
    "2254946f20993935b7e6de302d25b644f7641b8e5bca4cd9652fd2756aab1fc3": "counts-not-chronological",
    "4392c70fce5f783e4fe9bab9e22ef1a311120f4385db391580c7234f30c3468e": "default-world-only"
  },
  "rea.web-page-inspection": {
    "64658854befb1f6b5c502076764f91e26d2690ed408e6fb84cd2196b8e3b33f9": "artifact-identity-unavailable",
    "2c2f62e6db29f6866a30cba473c7647a1a8baf29c355373397c9794bbf4731cf": "host-platform-not-observed",
    db518cec16395c1fc385c45a43ff6f903f6a2efd581aa5ee8e09cd6d2f4c2e14: "attachment-state-unknown",
    "776f9b0a278cd7df412c2ff94bc8942f9e3eaa5b792f051672f50b66911b069c": "observation-starts-at-attach",
    "5d50cedfdd4177d65191a1b65c339c03cd5d05acd90ce236dcca1d935a9595cf": "payloads-not-retained",
    b7965bd684ccfd7bb4e587ab7fb128091b21436f4dd84681ec3ad0a060cec9ea: "source-maps-not-fetched",
    c068ec8f2371fdb8fbadf9e4a00d82145c9d3c7e6a95395608b445d269565b02: "url-less-scripts-excluded"
  }
};

test("the limitation vocabulary is 6.5.0's nineteen sentences, each to its identifier, as pinned from 6.5.0's own dist", () => {
  const hashed = Object.fromEntries(Object.entries(RECORDER_LIMITATIONS).map(([predicate, map]) => [predicate, Object.fromEntries(Object.entries(map).map(([text, id]) => [sha(text), id]))]));
  assert.deepEqual(hashed, LIMITATION_PINS);
});

test("the evidence id leaves a null relationship_coverage out, as 6.5.0 does, and keeps one that is not null", async () => {
  const body = JSON.parse(new TextDecoder().decode(observeFile())) as Record<string, unknown>;
  const { evidence_id: _written, ...fields } = body;
  assert.equal(fields.relationship_coverage, null);
  // Every field hashed, the null coverage included: the id a recipe that kept a null coverage would give, which 6.5.0's does not.
  const nullHashed = `ev_${sha(reaCanonical(fields))}`;
  assert.notEqual(nullHashed, evidenceIdOf(fields));
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json({ ...body, evidence_id: nullHashed }) })), { ok: false, refusal: "digest-mismatch", at: "runs/cover-1/observe.json: evidence_id" });
  const covered = { ...fields, relationship_coverage: { state: "complete" } };
  assert.equal((await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json({ ...covered, evidence_id: evidenceIdOf(covered) }) }))).ok, true);
});

test("an output nested too deeply to spell has no id to match: refused as a shape, never thrown", async () => {
  const written = new TextDecoder().decode(observeFile());
  // Deeper than any stack spells, however warm the code that spells it: a shallower nesting stops
  // overflowing once the spelling has been run often enough to be optimized.
  const deep = `${'{"d":'.repeat(200000)}1${"}".repeat(200000)}`;
  const nested = written.replace('"parameters":{"target_id":"SYNTHETICTARGET"}', `"parameters":${deep}`);
  assert.notEqual(nested, written);
  let result: unknown;
  await assert.doesNotReject(async () => {
    result = await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": utf8(nested) }));
  });
  assert.deepEqual(result, { ok: false, refusal: "unknown-shape", at: "runs/cover-1/observe.json: evidence_id" });
});

test("the evidence id leaves an undefined member out, as 6.5.0's recipe does, for an envelope given to it directly", async () => {
  const { raw_result: _raw, evidence_id: _id, ...fields } = JSON.parse(new TextDecoder().decode(observeFile())) as Record<string, unknown>;
  assert.equal(await checkEvidenceId("direct.json", { ...fields, evidence_id: evidenceIdOf(fields) }), null);
  assert.deepEqual(await checkEvidenceId("direct.json", { ...fields, evidence_id: `ev_${sha(reaCanonical({ ...fields, raw_result: "undefined" }))}` }), { ok: false, refusal: "digest-mismatch", at: "direct.json: evidence_id" });
});

test("a logger the recipe names whose frames file is not there records an incomplete attempt, and nothing of the logger", async () => {
  const { run } = await okRun(production, plan(), runFiles({ "runs/logged-1/witness.json": null }));
  const logged = run.attempts[4];
  const reason = "the recipe names logger, and its frames file is missing, so its output is missing";
  assert.deepEqual([logged.acquisition, logged.acquisitionReason, logged.instruments.find(({ name }) => name === "logger")], ["incomplete", reason, { name: "logger", completeness: "missing", reason, cleanup: null, recorderLimitations: null }]);
  assert.deepEqual(run.rows.filter((row) => row.attempt === "A05" && (row.topic === "attributed-calls" || row.topic === "calls-in-executed-ranges")), []);
  // A frames file that is there and not of the logger's shape still refuses the whole import.
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/logged-1/witness.json": utf8("{ not json") })), { ok: false, refusal: "unknown-shape", at: "runs/logged-1/witness.json: not JSON" });
  // Frames never read, a path the map does not hold at all, are refused: missing means the path was read and nothing was there.
  const unread = asked(production, plan(), runFiles());
  unread.delete("runs/logged-1/witness.json");
  assert.deepEqual(await production.adaptCaptureRun(plan(), unread), { ok: false, refusal: "unknown-shape", at: "runs/logged-1/witness.json: the file, which was never read" });
});

test("the control's historical record is held to its six keys and rebuilt, so the case holds none of the plan's objects", async () => {
  const base = plan();
  const control = base.control as NonNullable<CapturePlan["control"]>;
  assert.deepEqual(await production.adaptCaptureRun({ ...base, control: { ...control, historical: { ...control.historical, note: "an extra key" } as never } }, new Map()), { ok: false, refusal: "plan-malformed", at: "control.historical" });
  const { run } = await okRun(production, base);
  assert.deepEqual(run.control?.historical, control.historical);
  assert.notEqual(run.control?.historical, control.historical);
  assert.notEqual(run.control?.historical.observed, control.historical.observed);
});

test("a digest that does not match its bytes refuses the whole import: a captured source, a saved script, and an output's own evidence id", async () => {
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": observeFile({ lampSha: "0".repeat(64) }) })), { ok: false, refusal: "digest-mismatch", at: "runs/cover-1/observe.json: a captured source's digest" });
  const tampered = runFiles({ [`runs/saved-1/exported/files/origins/0a/js/${PATH_CANARY}/lamp.js`]: utf8(`${LAMP_TEXT} `) });
  assert.deepEqual(await adapted(production, plan(), tampered), { ok: false, refusal: "digest-mismatch", at: `runs/saved-1/exported/manifest.json#${LAMP_KEY}: the saved script's digest` });
  assert.deepEqual(await adapted(production, plan(), runFiles({ [`runs/saved-1/exported/files/origins/0a/js/${PATH_CANARY}/lamp.js`]: null })), { ok: false, refusal: "missing-file", at: `runs/saved-1/exported/manifest.json#${LAMP_KEY}: the saved script` });
  const written = JSON.parse(new TextDecoder().decode(observeFile())) as { normalized_result: { excluded_requests: number } };
  written.normalized_result.excluded_requests = 99;
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(written) })), { ok: false, refusal: "digest-mismatch", at: "runs/cover-1/observe.json: evidence_id" });
  const inspected = JSON.parse(new TextDecoder().decode(runFiles().get("runs/saved-1/inspect.json") as Uint8Array)) as { confidence: string };
  inspected.confidence = "derived";
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/saved-1/inspect.json": json(inspected) })), { ok: false, refusal: "digest-mismatch", at: "runs/saved-1/inspect.json: evidence_id" });
  const stage0 = JSON.parse(new TextDecoder().decode(runFiles().get("runs/control-0/observe.json") as Uint8Array)) as { authority: string };
  stage0.authority = "local";
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/control-0/observe.json": json(stage0) })), { ok: false, refusal: "digest-mismatch", at: "runs/control-0/observe.json: evidence_id" });
});

test("a saved script must be the one inspected under its key, by its address", async () => {
  const swapped = runFiles({
    "runs/saved-1/exported/manifest.json": manifestFile([
      { source: { kind: "page-script", script_key: LAMP_KEY }, url: WICK_URL, content: { state: "exported", relative_path: `origins/0a/js/${PATH_CANARY}/lamp.js`, sha256: sha(LAMP_TEXT) } },
      { source: { kind: "page-script", script_key: scriptKey("wick") }, url: WICK_URL, content: { state: "exported", relative_path: "origins/0b/kit/wick.js", sha256: sha(WICK_TEXT) } }
    ])
  });
  assert.deepEqual(await adapted(production, plan(), swapped), { ok: false, refusal: "unknown-shape", at: `runs/saved-1/exported/manifest.json#${LAMP_KEY}: the saved script's address` });
  // The address is compared without its query, which the two outputs may spell apart.
  const requeried = runFiles({ "runs/saved-1/inspect.json": inspectFile([{ script_key: LAMP_KEY, url: `${LAMP_URL}?v=another`, frame_id: "F7" }, { script_key: scriptKey("wick"), url: WICK_URL, frame_id: "F7" }]) });
  assert.equal((await adapted(production, plan(), requeried)).ok, true);
});

test("a manifest path that would leave the folder is refused, and never asked for", async () => {
  for (const bad of ["../escape.js", "/etc/hosts", "origins/../../x.js", "origins/./x.js", "origins//x.js", "origins\\x.js", "origins/x\0.js"]) {
    const files = runFiles({ "runs/saved-1/exported/manifest.json": manifestFile([{ source: { kind: "page-script", script_key: LAMP_KEY }, url: LAMP_URL, content: { state: "exported", relative_path: bad, sha256: sha(LAMP_TEXT) } }]) });
    const wanted = production.capturePathsNeeded(plan(), files);
    assert.ok(!wanted.some((path) => path.includes("escape") || path.includes("hosts") || path.includes("x.js") || path.includes("x\0")), bad);
    assert.deepEqual(await production.adaptCaptureRun(plan(), files), { ok: false, refusal: "path-outside", at: "runs/saved-1/exported/manifest.json: scripts.content.relative_path" }, bad);
  }
});

test("a known shape that says its own output was lost or cut short records an incomplete attempt, and a missing output a recipe names refuses", async () => {
  const { run } = await okRun();
  const probe = run.attempts.find(({ run: folder }) => folder === "probed-2");
  assert.equal(probe?.acquisition, "incomplete");
  assert.deepEqual([probe?.acquisitionReason, probe?.instruments.find(({ name }) => name === "sbl-inspect")], ["the recorded row holds no output for an instrument its recipe names", { name: "sbl-inspect", completeness: "missing", reason: "the recorded row holds no output for an instrument its recipe names", cleanup: null, recorderLimitations: null }]);
  for (const [reason, windowEnd] of [
    ["document_changed", "truncated"],
    ["target_terminated", "target_crashed"]
  ] as const) {
    const early = await okRun(production, plan(), runFiles({ "runs/cover-1/observe.json": observeFile({ endReason: reason }) }));
    const cover = early.run.attempts[3];
    assert.deepEqual([cover.acquisition, cover.acquisitionReason], ["incomplete", `REA's observation window ended early: ${reason}`]);
    assert.equal(row(early.run.rows, `E-A04-cov-lamp-canvas-font-${MEASURE_OFFSETS[1]}`).observation?.windowEnd, windowEnd);
  }
  // A recipe that names an instrument the row records no call for: its output is missing, which records an incomplete attempt and says so.
  const noOutput = await okRun(production, plan({ recipes: plan().recipes.map((recipe) => (recipe.id === "plain" ? { ...recipe, instruments: ["sbl-hooks", "rea-inspect"] } : recipe)) }));
  const missingReason = "the recipe names rea-inspect, and the row records no call for it, so its output is missing";
  assert.deepEqual([noOutput.run.attempts[0].acquisition, noOutput.run.attempts[0].acquisitionReason, noOutput.run.attempts[0].instruments.find(({ name }) => name === "rea-inspect")], ["incomplete", missingReason, { name: "rea-inspect", completeness: "missing", reason: missingReason, cleanup: null, recorderLimitations: null }]);
  // A row holding an error is a failed attempt, and an error wins over a wall.
  const failed = await okRun(production, plan(), runFiles({ "runs/plain-1/row.json": rowFile([], { error: "net down", mainDocumentStatus: 403 }) }));
  assert.deepEqual([failed.run.attempts[0].acquisition, failed.run.attempts[0].acquisitionReason], ["failed", "the recorded row holds an error"]);
  const blank = await okRun(production, plan(), runFiles({ "runs/plain-1/row.json": rowFile([], { error: "" }) }));
  assert.equal(blank.run.attempts[0].acquisition, "usable");
});

test("a page that answered 401, 403 or 429 is a walled attempt, and the status is kept", async () => {
  for (const status of [401, 403, 429]) {
    const walled = await okRun(production, plan(), runFiles({ "runs/cover-1/row.json": rowFile(["observe", "inspect"], { mainDocumentStatus: status }) }));
    const cover = walled.run.attempts[3];
    assert.deepEqual([cover.acquisition, cover.acquisitionReason, cover.page.status], ["walled", `the main document answered ${status}`, status]);
  }
  const fine = await okRun(production, plan(), runFiles({ "runs/cover-1/row.json": rowFile(["observe", "inspect"], { mainDocumentStatus: 404 }) }));
  assert.equal(fine.run.attempts[3].acquisition, "usable");
  const none = await okRun(production, plan(), runFiles({ "runs/cover-1/row.json": rowFile(["observe", "inspect"], { mainDocumentStatus: "200" }) }));
  assert.deepEqual(none.run.attempts[3].page, { status: null });
});

test("a report read that missed a frame or a worker realm says so on its row", async () => {
  for (const reportRead of [
    { atMs: 1, attemptedFrames: 3, readableFrames: 2, summaryWithheldFrames: 0, attemptedWorkerRealms: 0, readableWorkerRealms: 0 },
    { atMs: 1, attemptedFrames: 3, readableFrames: 3, summaryWithheldFrames: 1, attemptedWorkerRealms: 0, readableWorkerRealms: 0 },
    { atMs: 1, attemptedFrames: 3, readableFrames: 3, summaryWithheldFrames: 0, attemptedWorkerRealms: 2, readableWorkerRealms: 1 }
  ]) {
    const partial = await okRun(production, plan(), runFiles({ "runs/plain-1/row.json": rowFile([], { reportRead }) }));
    assert.deepEqual(row(partial.run.rows, "E-A01-read").limits, ["read_incomplete"], JSON.stringify(reportRead));
  }
});

test("each row carries the recorder's own stated limitations of the output it came from, by identifier", async () => {
  const { run } = await okRun();
  const ids = (predicate: string) => Object.keys(RECORDER_LIMITATIONS[predicate]).slice(0, 3).map((sentence) => RECORDER_LIMITATIONS[predicate][sentence]);
  const observeIds = ids("rea.observe-web-execution");
  const inspectIds = ids("rea.web-page-inspection");
  for (const id of [`E-A04-cov-lamp-canvas-font-${MEASURE_OFFSETS[0]}`, "E-A04-req-collect", "E-A04-identity-lamp", "E-A05-link-lamp-canvas.measureText"]) assert.deepEqual(row(run.rows, id).limits, observeIds, id);
  assert.deepEqual(row(run.rows, "E-A03-identity-lamp").limits, inspectIds);
  assert.deepEqual(row(run.rows, "E-A05-logger-lamp-canvas.measureText").limits, []);
  assert.deepEqual(run.attempts[3].instruments.find(({ name }) => name === "rea-coverage")?.recorderLimitations, observeIds);
  assert.deepEqual(run.attempts[2].instruments.find(({ name }) => name === "rea-inspect")?.recorderLimitations, inspectIds);
  assert.equal(run.attempts[3].instruments.find(({ name }) => name === "rea-inspect")?.recorderLimitations, null, "an inspection whose output was not read states nothing");
});

test("the plan is held to its shape and keys, one folder per run however a filesystem folds case, one script per label, and instruments its recipe ran", async () => {
  assert.deepEqual(await adapted(production, plan({ recorderRelease: "6.6.0" })), { ok: false, refusal: "recorder-not-pinned", at: "the seed names a recorder release this adapter does not pin" });
  assert.deepEqual(await production.adaptCaptureRun({ ...plan(), unexpected: true } as never, new Map()), { ok: false, refusal: "plan-malformed", at: "plan keys" });
  assert.deepEqual(await production.adaptCaptureRun(plan({ attempts: [{ run: "../up", recipe: "plain", sourceIdentity: "not_recorded" }] }), new Map()), { ok: false, refusal: "plan-malformed", at: "attempts" });
  assert.deepEqual(await production.adaptCaptureRun(plan({ attempts: [{ run: "Plain-1", recipe: "plain", sourceIdentity: "not_recorded" }, { run: "plain-1", recipe: "plain", sourceIdentity: "not_recorded" }] }), new Map()), { ok: false, refusal: "plan-malformed", at: "attempts.run" });
  // One name in its two Unicode compositions is one folder on a volume that normalizes.
  assert.deepEqual(await production.adaptCaptureRun(plan({ attempts: [{ run: "caf\u00e9-1", recipe: "plain", sourceIdentity: "not_recorded" }, { run: "cafe\u0301-1", recipe: "plain", sourceIdentity: "not_recorded" }], source: null }), new Map()), { ok: false, refusal: "plan-malformed", at: "attempts.run" });
  assert.deepEqual(await production.adaptCaptureRun(plan({ identityScripts: [{ label: "Lamp!", pathSuffix: "/lamp.js" }] }), new Map()), { ok: false, refusal: "plan-malformed", at: "identityScripts" });
  const base = plan();
  assert.deepEqual(await production.adaptCaptureRun({ ...base, source: { ...(base.source as NonNullable<CapturePlan["source"]>), patch: { path: "../hooks.diff", sha256: "0".repeat(64) } } }, new Map()), { ok: false, refusal: "plan-malformed", at: "source" });
  assert.deepEqual(await production.adaptCaptureRun({ ...base, control: { ...(base.control as NonNullable<CapturePlan["control"]>), fixturePath: "/etc/probe.js" } }, new Map()), { ok: false, refusal: "plan-malformed", at: "control" });
  assert.deepEqual(await production.adaptCaptureRun(plan({ provenancePath: "../attestations.json" as never }), new Map()), { ok: false, refusal: "plan-malformed", at: "provenancePath" });
  assert.deepEqual(await production.adaptCaptureRun(plan({ provenancePath: "provenance/attestations.json" as never }), new Map()), { ok: false, refusal: "plan-malformed", at: "provenancePath" });
  assert.deepEqual(await adapted(production, plan({ identityScripts: [{ label: "any", pathSuffix: ".js" }] })), { ok: false, refusal: "matcher-ambiguous", at: "identityScripts any, attempt A03" });
  const noCoverage = plan({ recipes: plan().recipes.map((recipe) => (recipe.id === "covered" ? { ...recipe, instruments: ["sbl-hooks", "rea-inspect"] } : recipe)) });
  assert.deepEqual(await adapted(production, noCoverage), { ok: false, refusal: "instrument-not-run", at: "attempt A04" });
});

test("a second row that would take an id takes it with -2, and the first keeps its id", async () => {
  const twice = runFiles({ "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], [], [{ url: COLLECT_URL, method: "POST", callsites: [], causal_attribution: "unknown" }, { url: COLLECT_URL, method: "GET", callsites: [], causal_attribution: "unknown" }, { url: COLLECT_URL, method: "PUT", callsites: [], causal_attribution: "unknown" }]))) });
  const { run } = await okRun(production, plan(), twice);
  assert.deepEqual(
    run.rows.filter(({ id }) => id.startsWith("E-A04-req-")).map((r) => [r.id, r.topic === "request" ? r.request.method : null]),
    [
      ["E-A04-req-collect", "POST"],
      ["E-A04-req-collect-2", "GET"],
      ["E-A04-req-collect-3", "PUT"]
    ]
  );
});

test("a call in a block REA counted 0 is not inside an executed range, though its function ran", async () => {
  const blockZero = LAMP_COVERAGE.map((fn) => (fn.name === "draw" ? { ...fn, ranges: [fn.ranges[0], { ...fn.ranges[1], count: 0 }] } : fn));
  const files = runFiles({ "runs/logged-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([{ id: "31", url: LAMP_URL, text: LAMP_TEXT }], [{ id: "31", functions: blockZero }]))) });
  const { run } = await okRun(production, plan(), files);
  const link = row(run.rows, "E-A05-link-lamp-canvas.measureText");
  assert.ok(link.topic === "calls-in-executed-ranges");
  assert.deepEqual([link.state, link.inside, link.ranges], ["no_record", 0, []]);
});

test("a frame is placed by its script's stated start, on the script's first line and after it, and only a call inside counted code, every call of a group, makes a link present", async () => {
  const glStart = LAMP_TEXT.indexOf("function gl");
  const glEnd = LAMP_TEXT.lastIndexOf("}") + 1;
  const glRan = LAMP_COVERAGE.map((fn) => (fn.name === "gl" ? { ...fn, ranges: [{ ...fn.ranges[0], count: 1 }] } : fn));
  const glBlockOnly = LAMP_COVERAGE.map((fn) => (fn.name === "gl" ? { ...fn, ranges: [fn.ranges[0], { start_offset: glStart + 10, end_offset: glEnd - 1, count: 1 }] } : fn));
  const lampAt = (start: Readonly<{ line_number: number; column_number: number }>, coverage: readonly unknown[] = LAMP_COVERAGE) =>
    json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([{ id: "31", url: LAMP_URL, text: LAMP_TEXT, start }], [{ id: "31", functions: [...coverage] }])));
  const lampPath = new URL(LAMP_URL).pathname;
  const call = (api: string, line: number, column: number, count: number, viaEval = false) => ({ api, frames: [{ origin: PAGE, path: lampPath, line, column, viaEval }], count, firstMs: 1, lastMs: 2 });
  const link = async (observe: Uint8Array, entries: unknown[], api: string) => {
    const { run } = await okRun(production, plan(), runFiles({ "runs/logged-1/observe.json": observe, "runs/logged-1/witness.json": witnessFile(entries) }));
    const linked = row(run.rows, `E-A05-link-lamp-${api}`);
    assert.ok(linked.topic === "calls-in-executed-ranges");
    return [linked.state, linked.inside];
  };
  // The script starts at zero-based line 3, column 40 of its resource: a frame on its first line is offset by both.
  assert.deepEqual(await link(lampAt({ line_number: 3, column_number: 40 }), [call("canvas.measureText", 4, MEASURE_OFFSETS[1] + 41, 2)], "canvas.measureText"), ["present", 2]);
  // On its second line only the line is offset: column 20 there is inside gl, which ran in this capture.
  assert.deepEqual(await link(lampAt({ line_number: 3, column_number: 40 }, glRan), [call("webgl.getParameter", 5, 20, 1)], "webgl.getParameter"), ["present", 1]);
  const atZero = { line_number: 0, column_number: 0 };
  // A frame the logger saw through eval is not placed in the script, whatever its position says.
  assert.deepEqual(await link(lampAt(atZero), [call("canvas.measureText", 1, MEASURE_OFFSETS[1] + 1, 2, true)], "canvas.measureText"), ["no_record", 0]);
  // A block counted above 0 inside a function counted 0 is not executed code.
  assert.deepEqual(await link(lampAt(atZero, glBlockOnly), [call("webgl.getParameter", 2, 20, 1)], "webgl.getParameter"), ["no_record", 0]);
  // Some calls of a group inside and some not: nothing says when the rest ran, so the link is no record.
  assert.deepEqual(await link(lampAt(atZero), [call("canvas.measureText", 1, MEASURE_OFFSETS[1] + 1, 2), call("canvas.measureText", 2, 20, 1)], "canvas.measureText"), ["no_record", 2]);
});

test("a joined row is held to every instrument it joins, not only the first", async () => {
  const noCoverage = plan({ recipes: plan().recipes.map((recipe) => (recipe.id === "logged" ? { ...recipe, instruments: ["sbl-hooks", "logger", "rea-inspect"] } : recipe)) });
  const quiet = json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([], [])));
  assert.deepEqual(await adapted(production, noCoverage, runFiles({ "runs/logged-1/observe.json": quiet })), { ok: false, refusal: "instrument-not-run", at: "attempt A05" });
});

test("a reconstructed identity covers exactly the attempts marked so, on the patch the seed names byte for byte", async () => {
  const { run } = await okRun();
  assert.deepEqual(run.source, { state: "reconstructed", baseCommit: "c0ffee", patch: { path: "harness/hooks.diff", sha256: plan().source?.patch.sha256 }, identity: "f".repeat(64), appliesTo: ["A01", "A03", "A05", "A06"] });
  assert.deepEqual(await adapted(production, plan(), runFiles({ "harness/hooks.diff": utf8("another patch") })), { ok: false, refusal: "source-mismatch", at: "source.patch.sha256" });
  const fewer = plan();
  assert.deepEqual(await adapted(production, { ...fewer, source: { ...(fewer.source as NonNullable<CapturePlan["source"]>), appliesTo: ["A03", "A05", "A06"] } }), { ok: false, refusal: "source-mismatch", at: "source.appliesTo" });
  assert.deepEqual(await adapted(production, { ...fewer, source: { ...(fewer.source as NonNullable<CapturePlan["source"]>), appliesTo: ["A03", "A01", "A05", "A06"] } }), { ok: false, refusal: "source-mismatch", at: "source.appliesTo" });
  assert.deepEqual(await adapted(production, plan({ source: null })), { ok: false, refusal: "source-mismatch", at: "attempts.sourceIdentity" });
});

test("the control reads met from the control run's own capture, and a count above 0 on an uncalled routine fails it", async () => {
  const { run } = await okRun();
  assert.equal(run.control?.current.sameOutputWouldRead, "met");
  assert.deepEqual(run.control?.current.called, [{ name: "lampProbe", readsAs: "executed" }]);
  assert.deepEqual(run.control?.current.uncalled, [{ name: "idleRoutine", readsAs: "count 0" }]);
  assert.deepEqual([run.control?.current.text, run.control?.current.note, run.control?.historical], [plan().control?.current.text, plan().control?.current.note, plan().control?.historical]);
  // The control run's own observation states its limitations too, and the case keeps them on the control.
  assert.deepEqual(run.control?.recorderLimitations, Object.values(RECORDER_LIMITATIONS["rea.observe-web-execution"]).slice(0, 3));
  const falseClaim = runFiles({
    "runs/control-0/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([{ id: "7", url: "http://127.0.0.1:5000/probe.js", text: "function lampProbe(){return 1}\nfunction idleRoutine(){return 2}\nlampProbe();" }], [{ id: "7", functions: [{ name: "lampProbe", ranges: [{ start_offset: 0, end_offset: 29, count: 1 }] }, { name: "idleRoutine", ranges: [{ start_offset: 30, end_offset: 63, count: 4 }] }] }])))
  });
  const failed = await okRun(production, plan(), falseClaim);
  assert.equal(failed.run.control?.current.sameOutputWouldRead, "not_met");
  assert.deepEqual(failed.run.control?.current.uncalled, [{ name: "idleRoutine", readsAs: "false execution claim" }]);
  const uncalledRoutine = runFiles({
    "runs/control-0/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([{ id: "7", url: "http://127.0.0.1:5000/probe.js", text: "function lampProbe(){return 1}\nfunction idleRoutine(){return 2}\nlampProbe();" }], [{ id: "7", functions: [{ name: "lampProbe", ranges: [{ start_offset: 0, end_offset: 29, count: 0 }] }] }])))
  });
  const notRun = await okRun(production, plan(), uncalledRoutine);
  assert.deepEqual([notRun.run.control?.current.called, notRun.run.control?.current.uncalled, notRun.run.control?.current.sameOutputWouldRead], [[{ name: "lampProbe", readsAs: "not executed" }], [{ name: "idleRoutine", readsAs: "no record" }], "not_met"]);
  const otherFixture = await okRun(production, plan(), runFiles({ "fixture/probe.js": utf8("function other(){}") }));
  assert.deepEqual([otherFixture.run.control?.current.digestMatches, otherFixture.run.control?.current.sameOutputWouldRead], [false, "not_met"]);
  assert.deepEqual(await adapted(production, plan({ control: { ...(plan().control as NonNullable<CapturePlan["control"]>), fixturePathSuffix: "/absent.js" } })), { ok: false, refusal: "control-script-missing", at: "runs/control-0/observe.json" });
});

test("the paths asked for settle in rounds and never include a file no recipe reads", () => {
  const first = production.capturePathsNeeded(plan(), new Map());
  assert.deepEqual(first, [PROVENANCE_PATH, "harness/hooks.diff", "runs/control-0/observe.json", "fixture/probe.js", "runs/plain-1/row.json", "runs/probed-1/row.json", "runs/saved-1/row.json", "runs/cover-1/row.json", "runs/logged-1/row.json", "runs/probed-2/row.json"]);
  const files = asked(production, plan(), runFiles());
  assert.ok(!files.has("runs/cover-1/inspect.json"), "an attempt that observed is read from its observation, not its inspection");
  assert.ok(!files.has("runs/plain-1/observe.json"));
  // Every file the run holds, and the pinned provenance path, asked for though the seed names no record, and not there.
  assert.equal(files.size, runFiles().size + 1);
  assert.equal(files.get(PROVENANCE_PATH), null);
  assert.deepEqual(production.capturePathsNeeded({ ...plan(), recipes: "no" } as never, new Map()), []);
  const names = production.capturePathNames(plan(), files);
  assert.equal(names.get(`runs/saved-1/exported/files/origins/0a/js/${PATH_CANARY}/lamp.js`), `runs/saved-1/exported/manifest.json#${LAMP_KEY}`);
  assert.deepEqual(production.capturePathsNeeded(plan({ provenancePath: PROVENANCE_PATH }), new Map())[0], PROVENANCE_PATH);
});

test("the survey is the adapter's own reading: what each attempt held, and every refusal the import would meet", async () => {
  const survey = await production.surveyCaptureRun(plan(), asked(production, plan(), runFiles()));
  const kinds = (s: typeof survey, index: number) => Object.fromEntries(Object.entries(s.attempts[index].kinds).map(([kind, value]) => [kind, value?.status]));
  assert.equal(survey.refusal, null);
  assert.equal(survey.run["recorder-identity"]?.status, "present");
  assert.match(survey.run["recorder-identity"]?.reason ?? "", /^declared: /);
  assert.deepEqual(kinds(survey, 0), { "attempt-identity": "present", "scanner-reads": "present", "main-document": "present", window: "present", "script-inventory": "missing", "script-execution": "missing", requests: "missing", "call-frames": "missing", "listener-registrations": "missing", "observer-outcome": "missing" });
  assert.equal(kinds(survey, 2)["script-inventory"], "present");
  assert.deepEqual([kinds(survey, 4)["call-frames"], kinds(survey, 4)["script-execution"], kinds(survey, 4)["script-inventory"], kinds(survey, 4).requests], ["present", "present", "present", "present"]);
  const noStatus = await production.surveyCaptureRun(plan(), runFiles({ "runs/plain-1/row.json": rowFile([], { mainDocumentStatus: null }) }));
  assert.equal(kinds(noStatus, 0)["main-document"], "missing");
  const excluded = runFiles({ "runs/cover-1/observe.json": json(envelope("rea.observe-web-execution", "observe_web_execution", observeResult([{ id: "31", url: LAMP_URL, text: null }], []))) });
  const none = await production.surveyCaptureRun(plan(), excluded);
  assert.deepEqual([kinds(none, 3)["script-inventory"], kinds(none, 3)["script-execution"]], ["missing", "missing"]);
  const noFrames = await production.surveyCaptureRun(plan(), runFiles({ "runs/logged-1/witness.json": witnessFile([{ api: "canvas.measureText", frames: [], count: 1, firstMs: 1, lastMs: 1 }]) }));
  assert.equal(kinds(noFrames, 4)["call-frames"], "missing");
  const refusing: readonly Readonly<Record<string, Uint8Array | null>>[] = [{ "runs/saved-1/exported/manifest.json": null }, { "runs/cover-1/observe.json": observeFile({ lampSha: "0".repeat(64) }) }];
  for (const over of refusing) {
    const files = runFiles(over);
    const refused = await production.surveyCaptureRun(plan(), asked(production, plan(), files));
    const result = await production.adaptCaptureRun(plan(), asked(production, plan(), files));
    assert.equal(result.ok, false);
    assert.equal(refused.refusal, result.ok ? null : `${result.refusal}: ${result.at}`);
    const assessed = assessSufficiency(QUESTION, refused);
    assert.ok(assessed.ok);
    assert.equal(assessed.assessment.verdict, "does-not-support-import");
  }
  const missingRow = await production.surveyCaptureRun(plan(), runFiles({ "runs/plain-1/row.json": null }));
  assert.equal(kinds(missingRow, 0)["attempt-identity"], "missing");
  // A refused attempt states its refusal for every kind this layout would hold, and only those.
  assert.deepEqual(Object.keys(missingRow.attempts[0].kinds), ["attempt-identity", "scanner-reads", "main-document", "window", "script-inventory", "script-execution", "requests", "call-frames"]);
  const broken = await production.surveyCaptureRun(plan(), runFiles({ "runs/cover-1/observe.json": observeFile({ provider: { id: "rea-cdp-browser", version: "3" } }) }));
  assert.equal(broken.attempts[3].kinds["script-execution"]?.status, "incompatible");
  assert.equal(broken.run["recorder-identity"]?.status, "incompatible");
  // An inspection output the reader refuses is a recorder output refused, as an observation would be.
  const brokenInspection = await production.surveyCaptureRun(plan(), runFiles({ "runs/saved-1/inspect.json": utf8("{ not json") }));
  assert.deepEqual(brokenInspection.run["recorder-identity"], { status: "incompatible", reason: "unknown-shape: runs/saved-1/inspect.json: not JSON" });
  assert.equal((await production.surveyCaptureRun(plan({ recorderRelease: "6.6.0" }), runFiles())).run["recorder-identity"]?.status, "incompatible");
  const malformed = await production.surveyCaptureRun({ ...plan(), recipes: "no" } as never, runFiles());
  assert.deepEqual([malformed.refusal, malformed.attempts], ["plan-malformed: recipes", []]);
  // The survey and the import name the same run.
  const files = asked(production, plan(), runFiles());
  const assessed = assessSufficiency(QUESTION, await production.surveyCaptureRun(plan(), files));
  assert.ok(assessed.ok);
  assert.equal(assessed.assessment.verdict, "supports-import");
  const c = await imported();
  assert.equal(c.runDigest, assessed.assessment.runDigest);
  // The case carries the run as the adapter read it.
  const { run } = await okRun();
  assert.deepEqual([c.adapter, c.objects, c.source, c.control, c.recorderBasis], [run.adapter, run.objects, run.source, run.control, run.recorderBasis]);
});

test("the recorder's identity is attested by a provenance statement at the pinned path, or declared by the seed where there is none, and the case says which", async () => {
  const attestedPlan = plan({ provenancePath: PROVENANCE_PATH });
  const attested = await okRun(production, attestedPlan, runFiles({ [PROVENANCE_PATH]: PROVENANCE_RECORD() }));
  assert.deepEqual([attested.run.recorderBasis, attested.run.recorderStatement], ["attested", `attested: a provenance statement at ${PROVENANCE_PATH} names REA 6.5.0, its commit and its sha512, and its signatures are not verified; and each of the 3 recorder outputs read carries the provider and predicate that release writes`]);
  const survey = await production.surveyCaptureRun(attestedPlan, asked(production, attestedPlan, runFiles({ [PROVENANCE_PATH]: PROVENANCE_RECORD() })));
  assert.match(survey.run["recorder-identity"]?.reason ?? "", /^attested: .*signatures are not verified/);
  const refusedBy = async (record: Uint8Array) => adapted(production, attestedPlan, runFiles({ [PROVENANCE_PATH]: record }));
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ commit: "1".repeat(40) })), { ok: false, refusal: "recorder-not-pinned", at: "the provenance statement that names the package does not name the pinned commit" });
  // The record holds exactly one statement of each type: a second build provenance statement, a third type or an entry that holds no statement is refused.
  const notExact = { ok: false, refusal: "recorder-not-pinned", at: "the provenance record does not hold exactly one statement of each type 6.5.0's attestation carries" };
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ commitApart: true })), notExact);
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ statements: ["publish", "provenance", "junk"] })), notExact);
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ statements: ["publish", "provenance", "other"] })), notExact);
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ statements: ["publish", "provenance", "provenance"] })), notExact);
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ publishType: "https://attestation.example/other/v1" })), notExact);
  // The package and its commit are taken from the build provenance statement, never from the publish statement.
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ namedOnPublish: true })), { ok: false, refusal: "recorder-not-pinned", at: "the provenance statement does not name the pinned package by its digest" });
  assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ digest: "0".repeat(128) })), { ok: false, refusal: "recorder-not-pinned", at: "the provenance statement does not name the pinned package by its digest" });
  for (const statements of [["publish"], ["provenance"]] as const) {
    assert.deepEqual(await refusedBy(PROVENANCE_RECORD({ statements })), { ok: false, refusal: "recorder-not-pinned", at: "the provenance record does not hold exactly one statement of each type 6.5.0's attestation carries" }, statements[0]);
  }
  assert.deepEqual(await adapted(production, attestedPlan, runFiles()), { ok: false, refusal: "recorder-not-pinned", at: `missing-file: ${PROVENANCE_PATH}: the file` });
  const declared = await okRun();
  assert.deepEqual([declared.run.recorderBasis, declared.run.recorderStatement.startsWith("declared: the seed names REA 6.5.0")], ["declared", true]);
  // Declared means no record is there: the pinned path is always asked for, and a record found where the seed names none is refused.
  assert.deepEqual(await adapted(production, plan(), runFiles({ [PROVENANCE_PATH]: PROVENANCE_RECORD() })), { ok: false, refusal: "recorder-not-pinned", at: `unknown-shape: ${PROVENANCE_PATH}: a provenance record the seed does not name` });
  // And the pinned path must have been read: a map that does not hold it at all is refused, never read as no record.
  const unread = asked(production, plan(), runFiles());
  unread.delete(PROVENANCE_PATH);
  assert.deepEqual(await production.adaptCaptureRun(plan(), unread), { ok: false, refusal: "recorder-not-pinned", at: `unknown-shape: ${PROVENANCE_PATH}: the file, which was never read` });
  // On either basis, a release the seed names must be the pinned one.
  assert.deepEqual(await adapted(production, plan({ provenancePath: PROVENANCE_PATH, recorderRelease: "6.6.0" }), runFiles({ [PROVENANCE_PATH]: PROVENANCE_RECORD() })), { ok: false, refusal: "recorder-not-pinned", at: "the seed names a recorder release this adapter does not pin" });
});

test("the provenance reader, called directly, takes the package and its commit from one build provenance statement, whatever comes before it", () => {
  const decoded = (record: Uint8Array): { attestations: unknown[] } => JSON.parse(new TextDecoder().decode(record));
  // One statement of each type, the build provenance one naming the pinned commit for another package: neither is named.
  assert.deepEqual(readProvenance(PROVENANCE_PATH, decoded(PROVENANCE_RECORD({ name: "pkg:npm/another-package@1.0.0" }))), { exactStatements: true, namesPackage: false, namesCommit: false });
  // A commit in a statement before the one that names the package does not count for that package.
  const apart = decoded(PROVENANCE_RECORD({ commitApart: true }));
  assert.deepEqual(readProvenance(PROVENANCE_PATH, { attestations: [...apart.attestations].reverse() }), { exactStatements: false, namesPackage: true, namesCommit: false });
});

const ROW_IDS = "a row's id holds the attempt, its topic and the seed's label, never text from the capture";

const checkIds = (rows: readonly ImportedRow[]) => {
  for (const { id } of rows) holds(ROW_IDS, /^E-A[0-9]{2,4}-(read|inspect|identity-[a-z0-9]+|cov-[a-z0-9]+-[a-z-]+-[0-9]+|req-[a-z0-9]+|(logger|link)-[a-z0-9]+-[a-z0-9]+\.[A-Za-z]+)(-[0-9]+)?$/.test(id), () => id);
};

test("every row id is built from the attempt, the topic and a label, and a label falls back to a digest's prefix", async () => {
  const { run } = await okRun();
  checkIds(run.rows);
  const unlabeled = await okRun(production, plan({ identityScripts: [] }));
  const fallback = unlabeled.run.rows.filter(({ id }) => id.startsWith("E-A04-cov-"));
  assert.ok(fallback.length > 0 && fallback.every(({ id }) => /^E-A04-cov-p[0-9a-f]{12}-/.test(id)));
  checkIds(unlabeled.run.rows);
  const sliced = variant({ find: "if (matcher !== null)\n        return matcher.label;", replace: 'if (matcher !== null)\n        return url.split("/").at(-1).slice(0, 10);' });
  await assertCaughtBy("a label sliced from the URL, as M1 spelled it", ROW_IDS, async () => checkIds((await okRun(sliced)).run.rows));
});

test("what the adapter makes holds only values W2's canonicalization accepts", async () => {
  const { canonicalBytes } = await import("../core/canonical-json");
  const { run } = await okRun();
  assert.notEqual(canonicalBytes(run), null);
  assert.notEqual(canonicalBytes(await imported()), null);
  void THIRD;
});

test("a source whose start REA wrote as null is read, and never placed at 0, 0", async () => {
  const unstated = json(
    envelope(
      "rea.observe-web-execution",
      "observe_web_execution",
      observeResult(
        [
          { id: "31", url: `${LAMP_URL}?v=${QUERY_CANARY}`, text: LAMP_TEXT, start: null },
          { id: "45", url: `${THIRD}/kit/later.js`, text: null, start: null }
        ],
        [{ id: "31", functions: [{ name: "", ranges: [{ start_offset: 0, end_offset: LAMP_TEXT.length, count: 1 }] }] }]
      )
    )
  );
  const { run } = await okRun(production, plan(), runFiles({ "runs/logged-1/observe.json": unstated }));
  assert.equal(row(run.rows, "E-A05-link-lamp-canvas.measureText").state, "no_record");
  assert.equal(row((await okRun()).run.rows, "E-A05-link-lamp-canvas.measureText").state, "present");
  const missingKey = JSON.parse(new TextDecoder().decode(observeFile())) as { normalized_result: { sources: Record<string, unknown>[] } };
  delete missingKey.normalized_result.sources[2].resource_start;
  const rebuilt = envelope("rea.observe-web-execution", "observe_web_execution", missingKey.normalized_result);
  assert.deepEqual(await adapted(production, plan(), runFiles({ "runs/cover-1/observe.json": json(rebuilt) })), { ok: false, refusal: "unknown-shape", at: "runs/cover-1/observe.json: sources.resource_start" });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { assessSufficiency, type Question } from "../core/sufficiency";
import * as production from "../core/trial-layout";
import { envelope, json, PROVENANCE_RECORD, scriptKey, utf8 } from "./recorded-fixture";

/**
 * The trial layout's survey, on a synthetic trial folder with invented names on reserved suffixes.
 * One attempt lost its top frame, and the recorder's inspection covers it; the other lost a child
 * frame the inspection's scope left out, and made a second visit with no recorder call. The
 * observer's own record holds a frame-level flag in both, which is not an outcome per registration.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/trial-layout"), edits);

const TOP = "https://www.alpha.test/";
const CHILD = "https://embed.orchard.test/frame";
const STACK = "Error\n    at wrapped (<anonymous>:1:1)\n    at deep (https://www.alpha.test/app.js:1:200)\n    at https://www.alpha.test/app.js:1:300";

type FrameSpec = Readonly<{ url: string; parentUrl: string | null; lost: boolean }>;

const harness = (label: string, visits: readonly Readonly<{ frames: readonly FrameSpec[]; over?: Readonly<Record<string, unknown>> }>[]) =>
  json({
    label,
    url: TOP,
    startedAt: "2025-04-05T06:07:00.000Z",
    visits: visits.map(({ frames, over }) => ({
      tag: "main",
      startedAt: "2025-04-05T06:07:01.000Z",
      status: 200,
      readAtMs: 7300,
      finalUrl: TOP,
      frames: frames.map(({ url, parentUrl, lost }) => ({ url, parentUrl, observerSnapshot: { listenerAttributionLost: lost, detections: [] }, predictedLost: lost, agrees: true, saturated: [{ rec: { i: 0, type: "scroll", target: "window" }, cls: { status: "saturated", thirdParty: [] } }] })),
      ...over
    }))
  });

type RawSpec = Readonly<{ url: string; lost?: boolean; observer?: Record<string, unknown> | null; log?: Record<string, unknown> | null }>;

const raw = (frames: readonly RawSpec[]) =>
  json({
    rawReads: frames.map(({ url, lost, observer, log }) => ({
      url,
      parentUrl: null,
      observer: observer === undefined ? { detections: [], events: {}, ...(lost ? { listenerAttributionLost: true } : {}) } : observer,
      log: log === undefined ? { href: url, installedAt: 412.5, records: [{ i: 0, t: 640, type: "scroll", target: "window", sid: 0 }], stacks: [STACK], droppedRecords: 0 } : log
    }))
  });

const ROOT_KEY = scriptKey("app");
const EMBED_KEY = scriptKey("embed");

const inspection = (frames: readonly Readonly<{ id: string; url: string; parent?: string | null }>[], scripts: readonly Readonly<{ key: string; frame: string }>[]) =>
  json(envelope("rea.web-page-inspection", "inspect_web_page", { scripts: { total: scripts.length, items: scripts.map(({ key, frame }) => ({ script_key: key, url: `${TOP}app.js`, frame_id: frame })) }, frames: frames.map(({ id, url, parent }) => ({ frame_id: id, parent_frame_id: parent ?? null, url })), completeness: { excluded: [{ section: "scripts", reason: "disallowed_origin", count: 9 }] } }));

const saved = (keys: readonly string[]) => json({ scripts: keys.map((key, n) => ({ source: { script_key: key }, url: `${TOP}app.js`, content: { state: "exported", relative_path: `origins/0a/${n}.js`, sha256: "ab".repeat(32) } })) });

const call = (exit: number | null, signal: string | null = null) => json({ args: ["inspect-web-page"], exit, signal, ms: 1000, stdoutBytes: 10, stderrTail: "" });

const attestations = (over: Parameters<typeof PROVENANCE_RECORD>[0] = {}) => PROVENANCE_RECORD(over);

const FILES = [
  "out/alpha.test/harness.json",
  "out/alpha.test/harness-raw.json",
  "out/alpha.test/rea-main-02-inspect-web-page.json",
  "out/alpha.test/rea-main-02-inspect-web-page.json.meta.json",
  "out/alpha.test/rea-main-03-scripts/manifest.json",
  "out/alpha.test/rea-main-06-analyze-javascript-application.json",
  "out/beta.test/harness.json",
  "out/beta.test/harness-raw.json",
  "out/beta.test/harness-raw-extra-0.json",
  "out/beta.test/rea-main-02-inspect-web-page.json",
  "out/beta.test/rea-main-03-scripts/manifest.json",
  "provenance-check/rea-agents-6.5.0.attestations.json",
  "provenance-check/node_modules/rea-agents/package.json"
];
const LISTING: production.Listing = { files: FILES, links: ["provenance-check/node_modules/.bin/rea"] };

const files = (over: Readonly<Record<string, Uint8Array | null>> = {}): Map<string, Uint8Array | null> => {
  const all = new Map<string, Uint8Array | null>([
    ["out/alpha.test/harness.json", harness("alpha.test", [{ frames: [{ url: TOP, parentUrl: null, lost: true }] }])],
    ["out/alpha.test/harness-raw.json", raw([{ url: TOP, lost: true }])],
    ["out/alpha.test/rea-main-02-inspect-web-page.json", inspection([{ id: "ROOTFRAME", url: TOP }], [{ key: ROOT_KEY, frame: "ROOTFRAME" }])],
    ["out/alpha.test/rea-main-02-inspect-web-page.json.meta.json", call(0)],
    ["out/alpha.test/rea-main-03-scripts/manifest.json", saved([ROOT_KEY])],
    ["out/beta.test/harness.json", harness("beta.test", [{ frames: [{ url: TOP, parentUrl: null, lost: false }, { url: CHILD, parentUrl: TOP, lost: true }] }, { frames: [{ url: TOP, parentUrl: null, lost: false }] }])],
    ["out/beta.test/harness-raw.json", raw([{ url: TOP }, { url: CHILD, lost: true }])],
    ["out/beta.test/harness-raw-extra-0.json", raw([{ url: TOP }])],
    ["out/beta.test/rea-main-02-inspect-web-page.json", inspection([{ id: "ROOTFRAME", url: TOP }], [{ key: ROOT_KEY, frame: "ROOTFRAME" }])],
    ["out/beta.test/rea-main-03-scripts/manifest.json", saved([ROOT_KEY])],
    ["provenance-check/rea-agents-6.5.0.attestations.json", attestations()]
  ]);
  for (const [path, bytes] of Object.entries(over)) all.set(path, bytes);
  return all;
};

const QUESTION: Question = {
  id: "synthetic",
  text: "Which script made each synthetic call?",
  requirements: [
    { kinds: ["attempt-identity", "main-document", "listener-registrations", "observer-outcome", "call-frames", "script-inventory", "window"], within: "one-attempt", atLeast: 1 },
    { kinds: ["recorder-identity"], within: "the-run" }
  ]
};

type SurveyResult = Awaited<ReturnType<Module["surveyTrialRun"]>>;
const statuses = (survey: SurveyResult) => Object.fromEntries(survey.attempts.map(({ attempt, kinds }) => [attempt, Object.fromEntries(Object.entries(kinds).map(([kind, value]) => [kind, value?.status]))]));
/** The bytes the local reader would hand over for this listing: only what the survey asks for. */
const filesFor = (listing: production.Listing, over: Readonly<Record<string, Uint8Array | null>> = {}) => {
  const all = files(over);
  return new Map(production.trialPathsNeeded(listing).map((path) => [path, all.get(path) ?? null] as const));
};
const kind = async (over: Readonly<Record<string, Uint8Array | null>>, index: number, name: string, listing: production.Listing = LISTING) => (await production.surveyTrialRun(listing, filesFor(listing, over))).attempts[index].kinds[name as keyof SurveyResult["attempts"][number]["kinds"]];

test("each visit is an attempt named by its place, and the survey states what its files hold, the observer's frame-level flag as not an outcome per registration", async () => {
  const survey = await production.surveyTrialRun(LISTING, files());
  assert.equal(survey.run["recorder-identity"]?.status, "present");
  assert.match(survey.run["recorder-identity"]?.reason ?? "", /^attested: /);
  assert.equal(survey.refusal, null);
  assert.match(survey.runDigest, /^[0-9a-f]{64}$/);
  const common = { "attempt-identity": "present", "main-document": "present", "script-execution": "missing", "scanner-reads": "missing", requests: "missing", "listener-registrations": "present", "call-frames": "present", window: "present", "observer-outcome": "incompatible" };
  assert.deepEqual(statuses(survey), { A01: { ...common, "script-inventory": "present" }, A02: { ...common, "script-inventory": "missing" }, A03: { ...common, "script-inventory": "missing" } });
  assert.match(survey.attempts[0].kinds["observer-outcome"]?.reason ?? "", /classifier's derived output/);
  assert.equal(survey.attempts[1].kinds["script-inventory"]?.reason, "REA's inspection lists no saved script for 1 of the 1 frames the observer flagged, which its scope left out");
  const text = JSON.stringify(survey);
  assert.ok(!text.includes("alpha") && !text.includes("beta"), "no folder label reaches the survey");
  const assessment = assessSufficiency(QUESTION, survey);
  assert.ok(assessment.ok);
  assert.equal(assessment.assessment.verdict, "does-not-support-import");
});

const DERIVED = "the survey never counts the harness classifier's derived output as the observer's outcome";

const checkDerived = async (module: Module) => {
  const survey = await module.surveyTrialRun(LISTING, files());
  for (const { attempt, kinds } of survey.attempts) holds(DERIVED, kinds["observer-outcome"]?.status !== "present", () => attempt);
};

test("a variant that reads the classifier's per-registration status as the observer's outcome is caught", async () => {
  await checkDerived(production);
  await assertCaughtBy("the classifier's output taken for the observer's", DERIVED, () =>
    checkDerived(variant({ find: 'status("incompatible", "the observer\'s record holds per-kind detections, API counts and a frame-level flag, and no outcome per registration; the per-registration status in harness.json is the harness classifier\'s derived output")', replace: 'status("present", "the harness classified each registration")' }))
  );
});

test("an observer record of a shape this does not know is incompatible, and so is a harness file that is not JSON, both named by place", async () => {
  assert.deepEqual(await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, observer: { detections: [], events: {}, perRegistration: [] } }]) }, 0, "observer-outcome"), { status: "incompatible", reason: "unknown-shape: folder 1/harness-raw.json: rawReads.observer" });
  assert.deepEqual(await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, observer: { events: {} } }]) }, 0, "observer-outcome"), { status: "incompatible", reason: "unknown-shape: folder 1/harness-raw.json: rawReads.observer" });
  const garbled = await production.surveyTrialRun(LISTING, files({ "out/alpha.test/harness.json": utf8("{") }));
  assert.deepEqual(garbled.attempts[0], { attempt: "A01", kinds: { "attempt-identity": { status: "incompatible", reason: "unknown-shape: folder 1/harness.json: not JSON" } } });
});

test("a harness record or folder the listing met as a link is an attempt refused for it, never dropped", async () => {
  const linked: production.Listing = { files: FILES.filter((path) => !path.startsWith("out/beta.test/")), links: ["out/beta.test", ...LISTING.links] };
  const survey = await production.surveyTrialRun(linked, files());
  assert.equal(survey.attempts.length, 2);
  assert.deepEqual(survey.attempts[1], { attempt: "A02", kinds: { "attempt-identity": { status: "incompatible", reason: "link-in-path: folder 2/harness.json, which the local reader does not follow" } } });
  const leaf: production.Listing = { files: FILES.filter((path) => path !== "out/beta.test/harness.json"), links: ["out/beta.test/harness.json"] };
  assert.equal((await production.surveyTrialRun(leaf, files())).attempts[1].kinds["attempt-identity"]?.status, "incompatible");
  assert.ok(!production.trialPathsNeeded(leaf).some((path) => path.startsWith("out/beta.test/")), "nothing in a refused folder is opened");
  // A link at out itself hides every attempt folder: the run is refused for that reason, never read as a run of no attempts.
  const outLinked: production.Listing = { files: FILES.filter((path) => !path.startsWith("out/")), links: ["out", ...LISTING.links] };
  const hidden = await production.surveyTrialRun(outLinked, filesFor(outLinked));
  assert.deepEqual([hidden.refusal, hidden.attempts.length], ["link-in-path: out, which the local reader does not follow", 0]);
  const assessed = assessSufficiency(QUESTION, hidden);
  assert.ok(assessed.ok);
  assert.deepEqual([assessed.assessment.verdict, assessed.assessment.reasons[0]], ["does-not-support-import", "the survey's reading refuses this run: link-in-path: out, which the local reader does not follow"]);
  assert.equal((await production.surveyTrialRun(LISTING, files())).refusal, null);
});

test("an inspection call that exited non-zero or was stopped by a signal leaves no inventory, and an output from another provider is incompatible and taints the recorder's identity", async () => {
  assert.deepEqual(await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json.meta.json": call(1) }, 0, "script-inventory"), { status: "missing", reason: "the inspection call exited 1, so it left no output to read" });
  assert.deepEqual(await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json.meta.json": call(null, "SIGTERM") }, 0, "script-inventory"), { status: "missing", reason: "the inspection call exited null, so it left no output to read" });
  // A call record whose exit is not a number is a shape the survey does not know, not a call that exited.
  assert.deepEqual(await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json.meta.json": utf8(JSON.stringify({ args: [], exit: "0", signal: null, ms: 1, stdoutBytes: 1 })) }, 0, "script-inventory"), { status: "incompatible", reason: "unknown-shape: folder 1/rea-main-02-inspect-web-page.json.meta.json: exit" });
  const foreign = json(envelope("rea.web-page-inspection", "inspect_web_page", { scripts: { items: [] }, frames: [], completeness: { excluded: [] } }, { id: "rea-cdp-browser", version: "3" }));
  const other = await production.surveyTrialRun(LISTING, files({ "out/beta.test/rea-main-02-inspect-web-page.json": foreign }));
  assert.equal(other.attempts[1].kinds["script-inventory"]?.status, "incompatible");
  assert.equal(other.run["recorder-identity"]?.status, "incompatible");
  const renamed = JSON.parse(new TextDecoder().decode(files().get("out/alpha.test/rea-main-02-inspect-web-page.json") as Uint8Array)) as { confidence: string };
  renamed.confidence = "derived";
  assert.deepEqual(await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json": json(renamed) }, 0, "script-inventory"), { status: "incompatible", reason: "digest-mismatch: folder 1/rea-main-02-inspect-web-page.json: evidence_id" });
});

test("the recorder's identity is attested only by a provenance statement at the pinned path naming the package, its digest and the commit together, with an output read, and its signatures are not verified", async () => {
  const identity = async (over: Readonly<Record<string, Uint8Array | null>>, listing: production.Listing = LISTING) => (await production.surveyTrialRun(listing, filesFor(listing, over))).run["recorder-identity"];
  const at = "provenance-check/rea-agents-6.5.0.attestations.json";
  assert.match((await identity({}))?.reason ?? "", /^attested: a provenance statement at provenance-check\/rea-agents-6\.5\.0\.attestations\.json names REA 6\.5\.0, its commit and its sha512, and its signatures are not verified; /);
  assert.equal((await identity({ [at]: attestations({ commit: "1".repeat(40) }) }))?.reason, "the provenance statement that names the package does not name the pinned commit");
  assert.equal((await identity({ [at]: attestations({ commitApart: true }) }))?.reason, "the provenance record does not hold exactly one statement of each type 6.5.0's attestation carries");
  assert.equal((await identity({ [at]: attestations({ digest: "00" }) }))?.reason, "the provenance statement does not name the pinned package by its digest");
  assert.equal((await identity({ [at]: attestations({ name: "pkg:npm/another@6.5.0" }) }))?.reason, "the provenance statement does not name the pinned package by its digest");
  assert.equal((await identity({ [at]: attestations({ statements: ["provenance"] }) }))?.reason, "the provenance record does not hold exactly one statement of each type 6.5.0's attestation carries");
  assert.equal((await identity({ [at]: null }))?.status, "missing");
  const noOutputs: production.Listing = { files: FILES.filter((path) => !path.includes("rea-main-02")), links: [] };
  assert.deepEqual(await identity({}, noOutputs), { status: "missing", reason: "no recorder output was read" });
  const noProvenance: production.Listing = { files: FILES.filter((path) => !path.startsWith("provenance-check/")), links: [] };
  assert.equal((await identity({}, noProvenance))?.status, "missing");
  // A provenance record the listing met as a link is refused for that, never missing.
  const linked: production.Listing = { files: FILES.filter((path) => path !== at), links: [at] };
  assert.deepEqual(await identity({}, linked), { status: "incompatible", reason: `link-in-path: ${at}: the file, which the local reader does not follow` });
});

test("a file the survey wants that the listing met as a link is incompatible for that reason, never missing", async () => {
  for (const [path, kindName, shown] of [
    ["out/alpha.test/harness-raw.json", "window", "folder 1/harness-raw.json: the file, which the local reader does not follow"],
    ["out/alpha.test/rea-main-02-inspect-web-page.json", "script-inventory", "folder 1/rea-main-02-inspect-web-page.json, which the local reader does not follow"],
    ["out/alpha.test/rea-main-02-inspect-web-page.json.meta.json", "script-inventory", "folder 1/rea-main-02-inspect-web-page.json.meta.json, which the local reader does not follow"],
    ["out/alpha.test/rea-main-03-scripts/manifest.json", "script-inventory", "folder 1/rea-main-03-scripts/manifest.json, which the local reader does not follow"]
  ] as const) {
    const listing: production.Listing = { files: FILES.filter((file) => file !== path), links: [...LISTING.links, path] };
    assert.deepEqual(await kind({}, 0, kindName, listing), { status: "incompatible", reason: `link-in-path: ${shown}` }, path);
  }
});

test("a file below a folder the listing met as a link is incompatible for that reason, never missing", async () => {
  const scripts = "out/alpha.test/rea-main-03-scripts";
  const underLink: production.Listing = { files: FILES.filter((file) => !file.startsWith(`${scripts}/`)), links: [...LISTING.links, scripts] };
  assert.deepEqual(await kind({}, 0, "script-inventory", underLink), { status: "incompatible", reason: "link-in-path: folder 1/rea-main-03-scripts/manifest.json, which the local reader does not follow" });
  const provenanceFolder: production.Listing = { files: FILES.filter((file) => !file.startsWith("provenance-check/")), links: ["provenance-check"] };
  const survey = await production.surveyTrialRun(provenanceFolder, filesFor(provenanceFolder));
  assert.deepEqual(survey.run["recorder-identity"], { status: "incompatible", reason: "link-in-path: provenance-check/rea-agents-6.5.0.attestations.json: the file, which the local reader does not follow" });
});

test("an inspection nested too deeply to spell is a shape the survey does not know, never thrown", async () => {
  const written = new TextDecoder().decode(files().get("out/alpha.test/rea-main-02-inspect-web-page.json") as Uint8Array);
  // Deeper than any stack spells, however warm the code that spells it.
  const nested = written.replace(/"parameters":\{[^}]*\}/, `"parameters":${'{"d":'.repeat(200000)}1${"}".repeat(200000)}`);
  assert.notEqual(nested, written);
  let found: unknown;
  await assert.doesNotReject(async () => {
    found = await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json": utf8(nested) }, 0, "script-inventory");
  });
  assert.deepEqual(found, { status: "incompatible", reason: "unknown-shape: folder 1/rea-main-02-inspect-web-page.json: evidence_id" });
});

test("a trial path is named by its folder's place for every refusal the local reader gives, never by its label", () => {
  const names = production.trialPathNames({ files: FILES, links: ["out/beta.test/harness-raw.json", ...LISTING.links] });
  assert.equal(names.get("out/alpha.test/harness.json"), "folder 1/harness.json");
  assert.equal(names.get("out/beta.test/rea-main-03-scripts/manifest.json"), "folder 2/rea-main-03-scripts/manifest.json");
  assert.equal(names.get("out/beta.test/harness-raw.json"), "folder 2/harness-raw.json");
  assert.ok(![...names.values()].some((name) => /alpha|beta/.test(name)), JSON.stringify([...names.values()]));
  assert.equal(names.has("provenance-check/rea-agents-6.5.0.attestations.json"), false);
  // A path below a folder of saved script files mirrors a URL: it gets no name, so the reader names it by its place.
  const mirrored = "out/alpha.test/rea-main-03-scripts/files/origins/cdn.orchard.test/app.js";
  assert.equal(production.trialPathNames({ files: [...FILES, mirrored], links: [] }).has(mirrored), false);
});

test("a visit missing what a kind needs reads missing, kind by kind", async () => {
  const alphaVisit = (over: Readonly<Record<string, unknown>>, frames: readonly FrameSpec[] = [{ url: TOP, parentUrl: null, lost: true }]) => ({ "out/alpha.test/harness.json": harness("alpha.test", [{ frames, over }]) });
  assert.equal((await kind(alphaVisit({ status: null }), 0, "main-document"))?.status, "missing");
  assert.equal((await kind(alphaVisit({ finalUrl: null }), 0, "main-document"))?.status, "missing");
  assert.equal((await kind(alphaVisit({}, [{ url: TOP, parentUrl: "https://www.alpha.test/up", lost: true }]), 0, "main-document"))?.status, "missing");
  assert.equal((await kind(alphaVisit({ readAtMs: null }), 0, "window"))?.status, "missing");
  assert.equal((await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, lost: true, log: { installedAt: null, records: [], stacks: [STACK] } }]) }, 0, "window"))?.status, "missing");
  assert.equal((await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, lost: true }, { url: CHILD, log: null }]) }, 0, "listener-registrations"))?.status, "missing");
  assert.equal((await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, lost: true, observer: null, log: null }]) }, 0, "listener-registrations"))?.status, "missing");
  assert.equal((await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, lost: true, observer: null, log: null }]) }, 0, "observer-outcome"))?.status, "missing");
  for (const stacks of [["Error\n    at wrapped (<anonymous>:1:1)"], ["Error\n    at deep (https://www.alpha.test/app.js)"]]) {
    assert.equal((await kind({ "out/alpha.test/harness-raw.json": raw([{ url: TOP, lost: true, log: { installedAt: 1, records: [{ type: "scroll", target: "window" }], stacks } }]) }, 0, "call-frames"))?.status, "missing", stacks[0]);
  }
});

test("numbers and times a visit holds must be finite, non-negative and parseable", async () => {
  const cases: readonly (readonly [Readonly<Record<string, Uint8Array | null>>, string])[] = [
    [{ "out/alpha.test/harness.json": utf8(new TextDecoder().decode(harness("alpha.test", [{ frames: [] }])).replace('"readAtMs":7300', '"readAtMs":1e999')) }, "unknown-shape: folder 1/harness.json: visits.readAtMs"],
    [{ "out/alpha.test/harness.json": harness("alpha.test", [{ frames: [], over: { readAtMs: -1 } }]) }, "unknown-shape: folder 1/harness.json: visits.readAtMs"],
    [{ "out/alpha.test/harness.json": harness("alpha.test", [{ frames: [], over: { startedAt: "x" } }]) }, "unknown-shape: folder 1/harness.json: visits"]
  ];
  for (const [over, reason] of cases) assert.deepEqual((await production.surveyTrialRun(LISTING, files(over))).attempts[0].kinds["attempt-identity"], { status: "incompatible", reason });
  const negative = new TextDecoder().decode(raw([{ url: TOP, lost: true }])).replace('"installedAt":412.5', '"installedAt":-1e999');
  assert.deepEqual(await kind({ "out/alpha.test/harness-raw.json": utf8(negative) }, 0, "window"), { status: "incompatible", reason: "unknown-shape: folder 1/harness-raw.json: rawReads.log.installedAt" });
});

test("a flagged top frame is the inspection's root frame, and a flagged child frame the inspection's frame at its address without query or fragment", async () => {
  // A top frame whose inspected address differs is still the root frame.
  assert.equal((await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json": inspection([{ id: "ROOTFRAME", url: `${TOP}?after=redirect` }], [{ key: ROOT_KEY, frame: "ROOTFRAME" }]) }, 0, "script-inventory"))?.status, "present");
  // A child frame at the top frame's address does not stand in for the root frame.
  assert.equal((await kind({ "out/alpha.test/rea-main-02-inspect-web-page.json": inspection([{ id: "ROOTFRAME", url: TOP }, { id: "CHILDFRAME", url: TOP, parent: "ROOTFRAME" }], [{ key: ROOT_KEY, frame: "CHILDFRAME" }]) }, 0, "script-inventory"))?.status, "missing");
  const withQuery = inspection([{ id: "ROOTFRAME", url: TOP }, { id: "EMBED", url: `${CHILD}?si=token#start`, parent: "ROOTFRAME" }], [{ key: ROOT_KEY, frame: "ROOTFRAME" }, { key: EMBED_KEY, frame: "EMBED" }]);
  assert.equal((await kind({ "out/beta.test/rea-main-02-inspect-web-page.json": withQuery, "out/beta.test/rea-main-03-scripts/manifest.json": saved([ROOT_KEY, EMBED_KEY]) }, 1, "script-inventory"))?.status, "present");
  assert.equal((await kind({ "out/beta.test/rea-main-02-inspect-web-page.json": withQuery }, 1, "script-inventory"))?.status, "missing", "a script in that frame REA did not save leaves it uncovered");
  const fragment = inspection([{ id: "ROOTFRAME", url: TOP }, { id: "EMBED", url: `${CHILD}#start`, parent: "ROOTFRAME" }], [{ key: ROOT_KEY, frame: "ROOTFRAME" }, { key: EMBED_KEY, frame: "EMBED" }]);
  assert.equal((await kind({ "out/beta.test/rea-main-02-inspect-web-page.json": fragment, "out/beta.test/rea-main-03-scripts/manifest.json": saved([ROOT_KEY, EMBED_KEY]) }, 1, "script-inventory"))?.status, "present");
});

test("only the files the survey reads are asked for, never an analysis output, and never one the listing lacks", () => {
  assert.deepEqual(production.trialPathsNeeded(LISTING), [
    "provenance-check/rea-agents-6.5.0.attestations.json",
    "out/alpha.test/harness.json",
    "out/alpha.test/harness-raw.json",
    "out/alpha.test/rea-main-02-inspect-web-page.json",
    "out/alpha.test/rea-main-02-inspect-web-page.json.meta.json",
    "out/alpha.test/rea-main-03-scripts/manifest.json",
    "out/beta.test/harness.json",
    "out/beta.test/harness-raw.json",
    "out/beta.test/harness-raw-extra-0.json",
    "out/beta.test/rea-main-02-inspect-web-page.json",
    "out/beta.test/rea-main-03-scripts/manifest.json"
  ]);
  assert.deepEqual(production.trialPathsNeeded({ files: ["out/../x/harness.json", "out/a/b/harness.json", "out/../harness.json", "out/./harness.json"], links: [] }), []);
});

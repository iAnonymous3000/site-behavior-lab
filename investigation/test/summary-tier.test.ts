import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { seededRandom } from "../../lib/seeded-property";
import * as production from "../core/summary-tier";
import { projectAttemptSummary, type AttemptSummary, type RawCapture, type SummaryAttempt } from "../core/summary-tier";
import { ATTEMPT_IDS, CANARIES, CANARY_CONSOLE, CANARY_PATH, CANARY_QUERY, CANARY_SCRIPT, CANARY_STORAGE } from "./case-fixture";

/**
 * The summary tier: what is kept once raw is gone. Canaries are planted in query, path,
 * storage value, script text and console text, plus a fragment and URL credentials, and then
 * looked for in everything the projection gives back, refusals included. Each projection is
 * compared with a summary written out here, with digests from node:crypto, so no oracle reads
 * the module's own hashing. What this shows is that these canaries and shapes did not
 * reach these places, not that nothing sensitive could.
 */

type Module = typeof production;
const variant = (...edits: SourceEdit[]) => loadVariant<Module>(require.resolve("../core/summary-tier"), edits);

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const CANARY_FRAGMENT = "CANARY-FRAGMENT-5a2c";
const CANARY_USER = "canary-user-3b1d";
const CANARY_PASSWORD = "canary-password-8e4f";
const CANARY_KEY = "CANARY-STORAGE-KEY-6d90";
const EVERY_CANARY = [...CANARIES, CANARY_FRAGMENT, CANARY_USER, CANARY_PASSWORD, CANARY_KEY];

const ATTEMPT: SummaryAttempt = { attemptId: ATTEMPT_IDS.I1, slot: "I1", arm: "instrumented", phase: "usable" };

const RAW: RawCapture = {
  scripts: [
    {
      url: `https://${CANARY_USER}:${CANARY_PASSWORD}@cdn.orchard-lane.example:8443/${CANARY_PATH}/lantern.js?token=${CANARY_QUERY}#${CANARY_FRAGMENT}`,
      text: `function lantern() { /* ${CANARY_SCRIPT} */ }`,
      ranges: [{ startOffset: 0, endOffset: 40, count: 3 }, { startOffset: 9, endOffset: 20, count: 0 }]
    },
    { url: "https://orchard-lane.example/plain.js", text: "plain();", ranges: [] },
    { url: `data:text/javascript,${CANARY_SCRIPT}`, text: `/* ${CANARY_SCRIPT} */`, ranges: [] },
    { url: `not a url ${CANARY_QUERY}`, text: "untraceable();", ranges: [] }
  ],
  requests: [
    { url: `https://orchard-lane.example/beacon?id=${CANARY_QUERY}` },
    { url: "https://orchard-lane.example/other" },
    { url: `https://cdn.orchard-lane.example:8443/${CANARY_PATH}` },
    { url: `data:text/plain,${CANARY_QUERY}` },
    { url: `wss://${CANARY_USER}@stream.orchard-lane.example/${CANARY_PATH}` }
  ],
  storage: [
    { key: CANARY_KEY, value: CANARY_STORAGE },
    { key: "second-key", value: CANARY_STORAGE }
  ],
  console: [{ text: CANARY_CONSOLE }, { text: `again ${CANARY_CONSOLE}` }, { text: "third" }]
};

const EXPECTED: AttemptSummary = {
  v: 1,
  attemptId: ATTEMPT_IDS.I1,
  slot: "I1",
  arm: "instrumented",
  phase: "usable",
  scripts: [
    {
      origin: "https://cdn.orchard-lane.example:8443",
      pathDigest: sha(`/${CANARY_PATH}/lantern.js`),
      textDigest: sha(`function lantern() { /* ${CANARY_SCRIPT} */ }`),
      length: `function lantern() { /* ${CANARY_SCRIPT} */ }`.length,
      ranges: [{ startOffset: 0, endOffset: 40, count: 3 }, { startOffset: 9, endOffset: 20, count: 0 }]
    },
    { origin: "https://orchard-lane.example", pathDigest: sha("/plain.js"), textDigest: sha("plain();"), length: 8, ranges: [] },
    { origin: null, pathDigest: sha(`text/javascript,${CANARY_SCRIPT}`), textDigest: sha(`/* ${CANARY_SCRIPT} */`), length: `/* ${CANARY_SCRIPT} */`.length, ranges: [] },
    { origin: null, pathDigest: null, textDigest: sha("untraceable();"), length: 14, ranges: [] }
  ],
  requestCount: 5,
  requestOrigins: [
    { origin: "https://cdn.orchard-lane.example:8443", count: 1 },
    { origin: "https://orchard-lane.example", count: 2 },
    { origin: "wss://stream.orchard-lane.example", count: 1 }
  ],
  storageKeyCount: 2,
  consoleMessageCount: 3
};

const PROJECTS = "a well-formed capture projects to exactly the summary written out here";

const checkProjection = async (module: Module) => {
  const result = await module.projectAttemptSummary(ATTEMPT, RAW);
  holds(PROJECTS, result.ok, () => result);
  const { summary } = result as Extract<production.SummaryResult, { ok: true }>;
  holds(PROJECTS, JSON.stringify(summary) === JSON.stringify(EXPECTED), () => summary);
};

const NO_CANARY = "no canary reaches a summary";

const checkCanaries = async (module: Module) => {
  const result = await module.projectAttemptSummary(ATTEMPT, RAW);
  const text = JSON.stringify(result);
  for (const canary of EVERY_CANARY) holds(NO_CANARY, !text.toLowerCase().includes(canary.toLowerCase()), () => ({ canary, text }));
};

test("a capture projects to exactly the allow-list, and no canary comes with it", async () => {
  await checkProjection(production);
  await checkCanaries(production);
  // The canaries are really in what it was given, or their absence would mean nothing.
  const given = JSON.stringify(RAW);
  for (const canary of EVERY_CANARY) assert.ok(given.includes(canary), canary);
});

const SHAPE = "the validator holds every field to its shape, at every level";

const checkValidator = (module: Module) => {
  holds(SHAPE, module.isAttemptSummary(EXPECTED), () => "the good summary");
  const bad: readonly (readonly [string, unknown])[] = [
    ["an extra top-level field", { ...EXPECTED, scriptText: "x" }],
    // What aggregates carry stays out of a summary on purpose: one attempt's summary has no group, label or reading to hold them.
    ["a group's limits", { ...EXPECTED, limits: { observed: { late: 1 }, zero_in_window: {}, unknown: {} } }],
    ["a visit's basis", { ...EXPECTED, basis: "not_visited" }],
    ["a reading of an attempt", { ...EXPECTED, readings: { "subject-one": { reading: "observed", limits: ["late"] } } }],
    ["a missing top-level field", (() => { const { requestCount: _gone, ...rest } = EXPECTED; return rest; })()],
    ["no version", { ...EXPECTED, v: 2 }],
    ["an attempt id with prose", { ...EXPECTED, attemptId: "the second attempt" }],
    ["an unknown slot", { ...EXPECTED, slot: "X1" }],
    ["an unknown arm", { ...EXPECTED, arm: "control" }],
    ["an unknown phase", { ...EXPECTED, phase: "published" }],
    ["scripts not a list", { ...EXPECTED, scripts: "many" }],
    ["an extra script field", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], text: "x" }] }],
    ["a bad range after a good one", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], ranges: [{ startOffset: 0, endOffset: 1, count: 1 }, { startOffset: 0, endOffset: 1, count: 1, text: "x" }] }] }],
    ["a bad request origin after a good one", { ...EXPECTED, requestOrigins: [{ origin: "https://orchard-lane.example", count: 1 }, { origin: "https://orchard-lane.example/x", count: 1 }] }],
    ["an extra script field on the second script only", { ...EXPECTED, scripts: [EXPECTED.scripts[0], { ...EXPECTED.scripts[1], query: "x" }] }],
    ["an origin with a path", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "https://orchard-lane.example/secret" }] }],
    ["an origin with a query", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "https://orchard-lane.example?a=b" }] }],
    ["an origin with a user", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "https://user@orchard-lane.example" }] }],
    ["an origin of prose", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "the first party" }] }],
    ["an origin with a fragment", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "https://orchard-lane.example#canary" }] }],
    ["an origin with a fragment in its host", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "https://a#canary" }] }],
    ["an origin with a percent sign in its host", { ...EXPECTED, requestOrigins: [{ origin: "https://a%20b.example", count: 1 }] }],
    ["an origin in upper case, which no parser spells", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], origin: "https://ORCHARD.example" }] }],
    ["an origin of another scheme", { ...EXPECTED, requestOrigins: [{ origin: "ftp://orchard-lane.example", count: 1 }] }],
    ["a path digest that is a path", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], pathDigest: "/users/alice" }] }],
    ["a text digest that is text", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], textDigest: "function lantern() {}" }] }],
    ["no text digest", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], textDigest: null }] }],
    ["a negative length", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], length: -1 }] }],
    ["a range with an extra field", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], ranges: [{ startOffset: 0, endOffset: 1, count: 1, text: "x" }] }] }],
    ["a range with a string offset", { ...EXPECTED, scripts: [{ ...EXPECTED.scripts[0], ranges: [{ startOffset: "0", endOffset: 1, count: 1 }] }] }],
    ["a fractional request count", { ...EXPECTED, requestCount: 1.5 }],
    ["request origins not a list", { ...EXPECTED, requestOrigins: {} }],
    ["a request origin with a path", { ...EXPECTED, requestOrigins: [{ origin: "https://orchard-lane.example/x", count: 1 }] }],
    ["a request origin with an extra field", { ...EXPECTED, requestOrigins: [{ origin: "https://orchard-lane.example", count: 1, url: "x" }] }],
    ["a negative storage count", { ...EXPECTED, storageKeyCount: -1 }],
    ["storage values", { ...EXPECTED, storageKeyCount: ["value"] }],
    ["console text", { ...EXPECTED, consoleMessageCount: "words" }],
    ["not an object", "a summary"],
    ["null", null],
    ["a list", []]
  ];
  for (const [name, value] of bad) holds(SHAPE, !module.isAttemptSummary(value), () => name);
  // Every host shape a parser spells passes: an underscore, an address and an IPv6 address.
  for (const origin of ["https://a_b.orchard-lane.example", "http://192.0.2.7:8080", "wss://[::1]:9000"]) {
    holds(SHAPE, module.isAttemptSummary({ ...EXPECTED, requestOrigins: [{ origin, count: 1 }] }), () => origin);
  }
};

test("the shape validator refuses every shape but this one", async () => {
  checkValidator(production);
  for (const [name, find, replace] of [
    ["extra top-level fields allowed", "isPlain(value) &&\n        (0, canonical_json_1.hasExactly)(value, SUMMARY_KEYS) &&", "isPlain(value) &&"],
    ["extra script fields allowed", "isPlain(value) &&\n        (0, canonical_json_1.hasExactly)(value, SCRIPT_KEYS) &&", "isPlain(value) &&"],
    ["extra range fields allowed", "isPlain(value) && (0, canonical_json_1.hasExactly)(value, RANGE_KEYS) &&", "isPlain(value) &&"],
    ["extra request-origin fields allowed", "isPlain(entry) && (0, canonical_json_1.hasExactly)(entry, ORIGIN_COUNT_KEYS) &&", "isPlain(entry) &&"],
    ["an origin of any shape", 'return typeof value === "string" && ORIGIN.test(value);', 'return typeof value === "string";'],
    ["a fragment or a percent sign in an origin's host", "(?:[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*|", "(?:[a-z0-9_#%-]+(?:\\.[a-z0-9_#%-]+)*|"],
    ["an underscore refused in a host", "(?:[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*|", "(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*|"],
    ["only the first script checked", "value.scripts.every(isSummaryScript)", "(value.scripts.length === 0 || isSummaryScript(value.scripts[0]))"],
    ["a path digest of any shape", "(value.pathDigest === null || (0, case_log_1.isDigest)(value.pathDigest)) &&", ""],
    ["a text digest of any shape", "(0, case_log_1.isDigest)(value.textDigest) &&", ""],
    ["a version of any kind", "value.v === 1 &&", ""],
    ["an attempt id of any shape", 'typeof value.attemptId === "string" &&\n        ATTEMPT_ID.test(value.attemptId) &&', ""],
    ["a phase of any name", "PHASES.includes(value.phase) &&", ""],
    ["a negative count allowed", "Number.isSafeInteger(value) && value >= 0;", "Number.isSafeInteger(value);"]
  ] as const) {
    await assertCaughtBy(name, SHAPE, () => checkValidator(variant({ find, replace })));
  }
});

/** A leak added to what the projection builds, in the compiled object it returns. */
const LEAKS: readonly (readonly [string, string])[] = [
  ["script text", 'scriptText: raw.scripts[0].text,'],
  ["a query value", 'query: new URL(raw.scripts[0].url).search,'],
  ["a path", 'path: new URL(raw.scripts[0].url).pathname,'],
  ["a storage value", 'storageValue: raw.storage[0].value,'],
  ["a storage key", 'storageKey: raw.storage[0].key,'],
  ["console text", 'consoleText: raw.console[0].text,']
];

const REMOVE_VALIDATOR = { find: 'return isAttemptSummary(summary) ? { ok: true, summary } : { ok: false, refusal: "summary-shape", at: "summary" };', replace: "return { ok: true, summary };" };

for (const [name, field] of LEAKS) {
  const leak = { find: "const summary = {\n        v: 1,", replace: `const summary = {\n        ${field}\n        v: 1,` };
  test(`${name} added to the projection is refused by the validator, and caught by the canaries once the validator is gone too`, async () => {
    // With the validator in place the projection refuses, so a leak cannot reach anyone.
    await assertCaughtBy(`${name} leaked`, PROJECTS, () => checkProjection(variant(leak)));
    // Without it only the canary scan stands between the leak and a reader.
    await assertCaughtBy(`${name} leaked past the validator`, NO_CANARY, () => checkCanaries(variant(leak, REMOVE_VALIDATOR)));
  });
}

for (const [name, find, replace] of [
  ["an origin that keeps the whole URL", "return isOrigin(parsed.origin) ? parsed.origin : null;", "return parsed.href;"],
  ["a path digest of the whole URL", "await digestOfText(parsed.pathname)", "await digestOfText(parsed.href)"],
  ["a text digest of the URL", "await digestOfText(script.text)", "await digestOfText(script.url)"]
] as const) {
  test(`the projection catches ${name}`, async () => {
    await assertCaughtBy(name, PROJECTS, () => checkProjection(variant({ find, replace }, REMOVE_VALIDATOR)));
  });
}

const FIELDS = "what the projection keeps of each field is what is written out here, on text a plain test would miss";

/** One script or request at a time, with everything else empty, compared with a summary written out here. */
const projected = async (module: Module, raw: Partial<RawCapture>) => {
  const result = await module.projectAttemptSummary(ATTEMPT, { scripts: [], requests: [], storage: [], console: [], ...raw });
  holds(FIELDS, result.ok, () => ({ raw, result }));
  return (result as Extract<production.SummaryResult, { ok: true }>).summary;
};

const checkFields = async (module: Module) => {
  // A range keeps its three fields, and nothing else a capture hung on it.
  const ranged = await projected(module, { scripts: [{ url: "https://orchard-lane.example/plain.js", text: "plain();", ranges: [{ startOffset: 1, endOffset: 5, count: 2, text: CANARY_SCRIPT } as never] }] });
  holds(FIELDS, JSON.stringify(ranged.scripts[0].ranges) === '[{"startOffset":1,"endOffset":5,"count":2}]', () => ranged);

  // Another scheme: counted as a request, and no origin of it is kept. A script on one keeps its path digest.
  const other = await projected(module, { scripts: [{ url: "ftp://files.orchard-lane.example/lantern.js", text: "x", ranges: [] }], requests: [{ url: "ftp://files.orchard-lane.example/lantern.js" }, { url: "https://orchard-lane.example/" }, { url: "file:///etc/hosts" }, { url: "blob:https://orchard-lane.example/id" }] });
  holds(FIELDS, other.requestCount === 4, () => other);
  // A blob's origin is the page's, by the URL standard, so it counts as that page's request.
  holds(FIELDS, JSON.stringify(other.requestOrigins) === '[{"origin":"https://orchard-lane.example","count":2}]', () => other);
  holds(FIELDS, JSON.stringify(other.scripts[0]) === JSON.stringify({ origin: null, pathDigest: sha("/lantern.js"), textDigest: sha("x"), length: 1, ranges: [] }), () => other);

  // Edge whitespace is part of what ran: the digest and the length are of the text exactly as given.
  const edged = await projected(module, { scripts: [{ url: "https://orchard-lane.example/a.js", text: "  run();\n\t ", ranges: [] }] });
  holds(FIELDS, JSON.stringify(edged.scripts[0]) === JSON.stringify({ origin: "https://orchard-lane.example", pathDigest: sha("/a.js"), textDigest: sha("  run();\n\t "), length: 11, ranges: [] }), () => edged);

  // Non-ASCII: the length is in the units a range's offsets use, and the digest is of UTF-8.
  const text = "caf\u00e9\u{1f600};";
  const wide = await projected(module, { scripts: [{ url: "https://orchard-lane.example/caf%C3%A9.js", text, ranges: [] }] });
  holds(FIELDS, wide.scripts[0].length === 7 && wide.scripts[0].textDigest === sha(text) && wide.scripts[0].pathDigest === sha("/caf%C3%A9.js"), () => wide);
  // An empty text is a text, with a digest.
  const empty = await projected(module, { scripts: [{ url: "https://orchard-lane.example/empty.js", text: "", ranges: [] }] });
  holds(FIELDS, empty.scripts[0].length === 0 && empty.scripts[0].textDigest === sha(""), () => empty);
};

test("what a summary keeps of ranges, schemes, whitespace and non-ASCII text", async () => {
  await checkFields(production);
  const REMOVE = REMOVE_VALIDATOR;
  for (const [name, find, replace] of [
    ["ranges passed through whole", "ranges: script.ranges.map(({ startOffset, endOffset, count }) => ({ startOffset, endOffset, count }))", "ranges: script.ranges"],
    ["any scheme's origin let through", "return isOrigin(parsed.origin) ? parsed.origin : null;", "return parsed.origin;"],
    ["a request with no origin left out of the count", "requestCount: raw.requests.length,", "requestCount: [...originCounts.values()].reduce((sum, count) => sum + count, 0),"],
    ["the digest of trimmed text", "textDigest: await digestOfText(script.text),", "textDigest: await digestOfText(script.text.trim()),"],
    ["the length of trimmed text", "length: script.text.length,", "length: script.text.trim().length,"],
    ["a length in UTF-8 bytes", "length: script.text.length,", "length: new TextEncoder().encode(script.text).length,"],
    ["a length in code points", "length: script.text.length,", "length: [...script.text].length,"]
  ] as const) {
    await assertCaughtBy(name, FIELDS, () => checkFields(variant({ find, replace })));
    await assertCaughtBy(`${name}, with no validator`, FIELDS, () => checkFields(variant({ find, replace }, REMOVE)));
  }
});

test("open (a stated limit): a 0 in a summary's ranges is told apart by the phase for how an attempt ended, and by nothing else", async () => {
  const capture = { scripts: [{ url: "https://orchard-lane.example/plain.js", text: "plain();", ranges: [{ startOffset: 0, endOffset: 8, count: 0 }] }], requests: [], storage: [], console: [] };
  const summaryAt = async (phase: SummaryAttempt["phase"], extra: object = {}) => {
    const result = await projectAttemptSummary({ ...ATTEMPT, phase, ...extra }, capture);
    assert.ok(result.ok);
    return result.summary;
  };
  // What the phase does tell apart: a walled 0, an incomplete 0 and a 0 from an operation that failed, timed out or was cancelled.
  const phases = ["usable", "walled", "incomplete", "failed", "timed_out", "cancelled"] as const;
  for (const phase of phases) {
    const summary = await summaryAt(phase);
    assert.equal(summary.phase, phase);
    assert.deepEqual(summary.scripts[0].ranges, [{ startOffset: 0, endOffset: 8, count: 0 }]);
  }
  // What it does not: partial coverage, unresolved cleanup, function-only granularity, a window that did not close, scope and lateness have no field, and handing them in changes no byte.
  const plain = JSON.stringify(await summaryAt("usable"));
  for (const extra of [{ completeness: "partial" }, { cleanup: "unconfirmed" }, { granularity: "function" }, { windowEnd: "truncated" }, { scope: "out_of_scope" }, { state: "late" }]) {
    assert.equal(JSON.stringify(await summaryAt("usable", extra)), plain, JSON.stringify(extra));
  }
});

test("open (a stated limit): a value a site put in its host reaches a summary, because an origin is kept", async () => {
  // An origin has to be kept for a summary to say who was talked to, and a site chooses its own
  // hosts, so what is planted in one comes through. No hostname filter is claimed or wanted.
  const planted = "canary-in-a-host-7d1e";
  const result = await projectAttemptSummary(ATTEMPT, {
    scripts: [{ url: `https://${planted}.orchard-lane.example/${CANARY_PATH}?q=${CANARY_QUERY}`, text: "x", ranges: [] }],
    requests: [{ url: `https://${planted.toUpperCase()}.orchard-lane.example/` }],
    storage: [],
    console: []
  });
  assert.ok(result.ok);
  assert.equal(result.summary.scripts[0].origin, `https://${planted}.orchard-lane.example`);
  assert.deepEqual(result.summary.requestOrigins, [{ origin: `https://${planted}.orchard-lane.example`, count: 1 }]);
  // The rest of that URL still does not come through.
  const text = JSON.stringify(result);
  assert.equal(text.includes(CANARY_PATH), false);
  assert.equal(text.includes(CANARY_QUERY), false);
});

const REFUSALS = "a malformed capture is refused by naming a field, never by repeating what it held";

const checkRefusals = async (module: Module) => {
  const table: readonly (readonly [string, unknown, string])[] = [
    ["no capture at all", null, "capture"],
    ["a capture that is a string", CANARY_SCRIPT, "capture"],
    ["a capture that is a list", [CANARY_SCRIPT], "capture"],
    ["a capture that is undefined", undefined, "capture"],
    ["scripts not a list", { ...RAW, scripts: CANARY_SCRIPT }, "scripts"],
    ["a script that is no object", { ...RAW, scripts: [CANARY_SCRIPT] }, "scripts"],
    ["a script that is no object, after one that is", { ...RAW, scripts: [RAW.scripts[1], CANARY_SCRIPT] }, "scripts"],
    ["a request that is no object, after one that is", { ...RAW, requests: [RAW.requests[1], CANARY_QUERY] }, "requests"],
    ["a script whose URL is no string", { ...RAW, scripts: [{ url: { value: CANARY_QUERY }, text: "x", ranges: [] }] }, "scripts.url"],
    ["a script whose text is no string", { ...RAW, scripts: [{ url: "https://orchard-lane.example/", text: [CANARY_SCRIPT], ranges: [] }] }, "scripts.text"],
    ["a script whose ranges are no list", { ...RAW, scripts: [{ url: "https://orchard-lane.example/", text: "x", ranges: CANARY_SCRIPT }] }, "scripts.ranges"],
    ["a null range", { ...RAW, scripts: [{ url: "https://orchard-lane.example/", text: "x", ranges: [null] }] }, "scripts.ranges"],
    ["a null range after a good one", { ...RAW, scripts: [{ url: "https://orchard-lane.example/", text: "x", ranges: [{ startOffset: 0, endOffset: 1, count: 1 }, null] }] }, "scripts.ranges"],
    ["a range that is a string", { ...RAW, scripts: [{ url: "https://orchard-lane.example/", text: "x", ranges: [CANARY_SCRIPT] }] }, "scripts.ranges"],
    ["null scripts", { ...RAW, scripts: null }, "scripts"],
    ["a null script", { ...RAW, scripts: [null] }, "scripts"],
    ["null requests", { ...RAW, requests: null }, "requests"],
    ["a null request", { ...RAW, requests: [null] }, "requests"],
    ["null storage", { ...RAW, storage: null }, "storage"],
    ["null console", { ...RAW, console: null }, "console"],
    ["the second script malformed", { ...RAW, scripts: [RAW.scripts[1], { url: 7, text: "x", ranges: [] }] }, "scripts.url"],
    ["requests not a list", { ...RAW, requests: CANARY_QUERY }, "requests"],
    ["a request whose URL is no string", { ...RAW, requests: [{ url: [CANARY_QUERY] }] }, "requests.url"],
    ["storage not a list", { ...RAW, storage: CANARY_STORAGE }, "storage"],
    ["console not a list", { ...RAW, console: CANARY_CONSOLE }, "console"]
  ];
  for (const [name, raw, at] of table) {
    // A throw is no typed refusal either, whatever it says.
    const result = await module.projectAttemptSummary(ATTEMPT, raw as RawCapture).catch((error: unknown) => ({ ok: true as const, summary: String(error) }));
    holds(REFUSALS, !result.ok && result.refusal === "capture-malformed" && result.at === at, () => ({ name, result }));
    const text = JSON.stringify(result);
    for (const canary of EVERY_CANARY) holds(REFUSALS, !text.includes(canary), () => ({ name, text }));
  }
  // No attempt at all is refused by name too, before anything is read of it.
  for (const attempt of [null, undefined, CANARY_PATH, []]) {
    const noAttempt = await module.projectAttemptSummary(attempt as unknown as SummaryAttempt, RAW).catch((error: unknown) => ({ ok: true as const, summary: String(error) }));
    holds(REFUSALS, !noAttempt.ok && noAttempt.refusal === "capture-malformed" && noAttempt.at === "attempt" && !JSON.stringify(noAttempt).includes(CANARY_PATH), () => noAttempt);
  }
  // What the attempt says is held to the shape too. An offset that is not a count takes the same road.
  const notAnId = await module.projectAttemptSummary({ ...ATTEMPT, attemptId: CANARY_PATH }, RAW);
  holds(REFUSALS, !notAnId.ok && notAnId.refusal === "summary-shape" && !JSON.stringify(notAnId).includes(CANARY_PATH), () => notAnId);
  const badRange = await module.projectAttemptSummary(ATTEMPT, { ...RAW, scripts: [{ ...RAW.scripts[1], ranges: [{ startOffset: -7071, endOffset: 1, count: 1 }] }] });
  holds(REFUSALS, !badRange.ok && badRange.refusal === "summary-shape", () => badRange);
};

test("a refusal names a field and repeats nothing", async () => {
  await checkRefusals(production);
  await assertCaughtBy("a refusal that repeats the value", REFUSALS, () => checkRefusals(variant({ find: 'return { ok: false, refusal: "capture-malformed", at: problem };', replace: 'return { ok: false, refusal: "capture-malformed", at: problem + JSON.stringify(raw) };' })));
  await assertCaughtBy("an unchecked URL", REFUSALS, () => checkRefusals(variant({ find: 'if (typeof script.url !== "string")\n            return "scripts.url";', replace: "" })));
  await assertCaughtBy("an unchecked text", REFUSALS, () => checkRefusals(variant({ find: 'if (typeof script.text !== "string")\n            return "scripts.text";', replace: "" })));
  await assertCaughtBy("an unchecked ranges list", REFUSALS, () => checkRefusals(variant({ find: 'if (!isCaptureList(script.ranges))\n            return "scripts.ranges";', replace: "" })));
  await assertCaughtBy("a null range read anyway", REFUSALS, () => checkRefusals(variant({ find: "return Array.isArray(value) && value.every(isPlain);", replace: "return Array.isArray(value);" })));
  await assertCaughtBy("a null capture read anyway", REFUSALS, () => checkRefusals(variant({ find: 'if (!isPlain(raw))\n        return "capture";', replace: "" })));
  await assertCaughtBy("a null attempt read anyway", REFUSALS, () => checkRefusals(variant({ find: 'if (!isPlain(attempt))\n        return { ok: false, refusal: "capture-malformed", at: "attempt" };', replace: "" })));
  await assertCaughtBy("a list taken as a capture", REFUSALS, () => checkRefusals(variant({ find: 'return typeof value === "object" && value !== null && !Array.isArray(value);', replace: 'return typeof value === "object" && value !== null;' })));
  await assertCaughtBy("an unchecked request URL", REFUSALS, () => checkRefusals(variant({ find: 'if (typeof request.url !== "string")\n            return "requests.url";', replace: "" })));
  await assertCaughtBy("an unchecked storage list", REFUSALS, () => checkRefusals(variant({ find: 'if (!Array.isArray(raw.storage))\n        return "storage";', replace: "" })));
  await assertCaughtBy("an unchecked console list", REFUSALS, () => checkRefusals(variant({ find: 'if (!Array.isArray(raw.console))\n        return "console";', replace: "" })));
});

test("sampled, not exhaustive: seeded URLs carrying canaries in every part leave none in the summary", async () => {
  // Open strings have no closed domain, so this is draws from one seed. It shows these draws, and no more.
  const random = seededRandom(0x5eed_0002);
  const pieces = EVERY_CANARY;
  const hosts = ["orchard-lane.example", "cdn.orchard-lane.example", "[::1]", "192.0.2.7", "xn--bcher-kva.example"];
  const seenOrigins = new Set<string>();
  let draws = 0;
  for (let index = 0; index < 400; index += 1) {
    const scheme = random.pick(["https", "http", "wss", "ws"]);
    const host = random.pick(hosts);
    const port = random.chance(0.3) ? ":8443" : "";
    const url = `${scheme}://${random.chance(0.3) ? `${encodeURIComponent(random.pick(pieces))}@` : ""}${host}${port}/${encodeURIComponent(random.pick(pieces))}/${random.int(100)}?${encodeURIComponent(random.pick(pieces))}=${encodeURIComponent(random.pick(pieces))}#${encodeURIComponent(random.pick(pieces))}`;
    const raw: RawCapture = { scripts: [{ url, text: random.pick(pieces), ranges: [] }], requests: [{ url }], storage: [{ key: random.pick(pieces), value: random.pick(pieces) }], console: [{ text: random.pick(pieces) }] };
    const result = await projectAttemptSummary(ATTEMPT, raw);
    assert.ok(result.ok, url);
    // What this draw must keep, written from the parts it was built of.
    const origin = `${scheme}://${host}${port}`;
    assert.equal(result.summary.scripts[0].origin, origin);
    assert.deepEqual(result.summary.requestOrigins, [{ origin, count: 1 }]);
    seenOrigins.add(origin);
    const text = JSON.stringify(result.summary).toLowerCase();
    for (const canary of pieces) assert.equal(text.includes(canary.toLowerCase()), false, `${canary} from ${url}`);
    draws += 1;
  }
  assert.equal(draws, 400);
  // Every scheme, host and port this draw could make, at this seed, so a single host did not stand in for them all.
  assert.equal(seenOrigins.size, SAMPLED_ORIGINS);
});

const SAMPLED_ORIGINS = 40;

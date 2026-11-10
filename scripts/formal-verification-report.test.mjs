// The formal verification execution report: its one rule, its canonical
// bytes, and the producer that runs suites to make it.
//
// The rule and the bytes are held on written-out reports. The producer is
// held on small fixture suites, run for real through the lane, in a throwaway
// repository: a fixture that skips, fails, stops early or dirties the tree
// must leave no report behind. The fixtures use the real harness, compiled by
// test:unit before this stage runs, so the catch log is read end to end.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FORMAL_VERIFICATION_CATCH_LOG_ENV,
  FORMAL_VERIFICATION_REPORT_KIND,
  buildFormalVerificationReport,
  compiledSuitePath,
  formalVerificationReportProblems,
  formalVerificationReportTotals,
  formalVerificationRequiredSuitesProblems,
  parseFormalVerificationReport,
  serializeFormalVerificationReport
} from "./formal-verification-report-lib.mjs";
import { TEST_BOUND_FLAGS, laneArguments } from "./unit-test-lanes.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(repository, ".unit-test-dist", "lib", "finite-check.js");
const PRODUCER = path.join(repository, "scripts", "formal-verification-report.mjs");
const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
// The Node package.json pins is the one CI's tests job writes the report on,
// and the one the reporter's reading of node's events was derived on. This
// file also runs inside the container image build, on the image's own Node.
const PINNED_NODE = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")).engines.node;
const ON_PINNED_NODE = process.versions.node === PINNED_NODE;

// ---------------------------------------------------------------------------
// The rule, on written-out reports.
// ---------------------------------------------------------------------------

const REQUIRED = [
  { id: "lib/fv-alpha.test.ts", minimumTests: 3, minimumVariants: 2 },
  { id: "lib/fv-beta.test.ts", minimumTests: 1, minimumVariants: 0 }
];

const passing = (count) => Array.from({ length: count }, (_, index) => ({ name: `test ${index + 1}`, outcome: "passed" }));
const counts = (over = {}) => ({ tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, expectedFailures: 0, skippedSuites: 0, todoSuites: 0, failedSuites: 0, ...over });
const caught = (variant, property = "the property", caughtBy = property) => ({ variant, property, caughtBy });

/** A report that meets REQUIRED, as plain records a test may then break. */
function records() {
  return {
    commit: COMMIT,
    tree: TREE,
    suites: [
      { id: "lib/fv-alpha.test.ts", counts: counts({ tests: 3, passed: 3 }), tests: passing(3), variants: [caught("a first variant"), caught("a second variant")] },
      { id: "lib/fv-beta.test.ts", counts: counts({ tests: 1, passed: 1 }), tests: passing(1), variants: [] }
    ]
  };
}

const problemsOf = (change, source = { commit: COMMIT, tree: TREE }) => {
  const input = records();
  change(input);
  return formalVerificationReportProblems(buildFormalVerificationReport(input), REQUIRED, source);
};

test("a report that meets every required suite has no problem, and says what it holds", () => {
  const report = buildFormalVerificationReport(records());
  assert.deepEqual(formalVerificationReportProblems(report, REQUIRED, { commit: COMMIT, tree: TREE }), []);
  assert.deepEqual(formalVerificationReportProblems(report, REQUIRED), [], "with no source to hold it to, the content alone is judged");
  assert.deepEqual(formalVerificationReportTotals(report), { suites: 2, tests: 4, variants: 2 });
  assert.equal(report.artifactKind, FORMAL_VERIFICATION_REPORT_KIND);
  // A test that failed as expected is among node's passes and is no pass in the totals.
  const excused = records();
  excused.suites[0].tests[0].outcome = "expected-failure";
  excused.suites[0].counts.expectedFailures = 1;
  assert.deepEqual(formalVerificationReportTotals(buildFormalVerificationReport(excused)), { suites: 2, tests: 3, variants: 2 });
});

// Each refusal the release gate must make, with the reason it gives.
for (const [name, change, expected] of [
  [
    "a report for another commit",
    (input) => { input.commit = "3".repeat(40); },
    [`the report is for commit ${"3".repeat(40)}, not ${COMMIT}`]
  ],
  [
    "a report for another tree",
    (input) => { input.tree = "4".repeat(40); },
    [`the report is for tree ${"4".repeat(40)}, not ${TREE}`]
  ],
  [
    "a required suite absent from the report",
    (input) => { input.suites.pop(); },
    ["required suite lib/fv-beta.test.ts is absent from the report"]
  ],
  [
    "a suite that is not required",
    (input) => { input.suites.push({ id: "lib/fv-gamma.test.ts", counts: counts({ tests: 1, passed: 1 }), tests: passing(1), variants: [] }); },
    ["the report names lib/fv-gamma.test.ts, which is not a required suite"]
  ],
  [
    "a suite with a skipped test",
    (input) => {
      input.suites[0].tests.push({ name: "a test left out", outcome: "skipped" });
      input.suites[0].counts = counts({ tests: 4, passed: 3, skipped: 1 });
    },
    ['lib/fv-alpha.test.ts: 1 test skipped, the first by name "a test left out"']
  ],
  [
    "a suite with a skipped describe block",
    (input) => { input.suites[0].counts.skippedSuites = 1; },
    ["lib/fv-alpha.test.ts: 1 describe block skipped"]
  ],
  [
    "a suite with a describe block left todo",
    (input) => { input.suites[1].counts.todoSuites = 2; },
    ["lib/fv-beta.test.ts: 2 describe blocks left todo"]
  ],
  [
    // node counts no failure for it, and the pinned Node exits 0 on it: there, only this count holds it.
    "a suite with a describe block that failed as a block",
    (input) => { input.suites[0].counts.failedSuites = 1; },
    ["lib/fv-alpha.test.ts: 1 describe block failed as a block"]
  ],
  [
    // node counts it among its passes. One more test passed, so the minimum is still met.
    "a suite with a test that failed as expected",
    (input) => {
      input.suites[0].tests.push({ name: "a property marked as expected to fail", outcome: "expected-failure" });
      input.suites[0].counts = counts({ tests: 4, passed: 4, expectedFailures: 1 });
    },
    ['lib/fv-alpha.test.ts: 1 test failed as expected, which is no pass, the first by name "a property marked as expected to fail"']
  ],
  [
    "a test that failed as expected counted toward a minimum",
    (input) => {
      input.suites[0].tests[2] = { name: "test 3", outcome: "expected-failure" };
      input.suites[0].counts = counts({ tests: 3, passed: 3, expectedFailures: 1 });
    },
    [
      'lib/fv-alpha.test.ts: 1 test failed as expected, which is no pass, the first by name "test 3"',
      "lib/fv-alpha.test.ts: 2 tests passed, below its pinned minimum of 3"
    ]
  ],
  [
    "a suite with a test left todo",
    (input) => {
      input.suites[1].tests.push({ name: "to be written", outcome: "todo" });
      input.suites[1].counts = counts({ tests: 2, passed: 1, todo: 1 });
    },
    ['lib/fv-beta.test.ts: 1 test left todo, the first by name "to be written"']
  ],
  [
    "a suite with a failed test",
    (input) => {
      input.suites[0].tests.push({ name: "a property that broke", outcome: "failed" });
      input.suites[0].counts = counts({ tests: 4, passed: 3, failed: 1 });
    },
    ['lib/fv-alpha.test.ts: 1 test failed or cancelled, the first by name "a property that broke"']
  ],
  [
    "a suite with a cancelled test",
    (input) => {
      input.suites[0].tests.push({ name: "a test cut short", outcome: "failed" });
      input.suites[0].counts = counts({ tests: 4, passed: 3, cancelled: 1 });
    },
    ['lib/fv-alpha.test.ts: 1 test failed or cancelled, the first by name "a test cut short"']
  ],
  [
    "a cardinality below its pin",
    (input) => {
      input.suites[0].tests.pop();
      input.suites[0].counts = counts({ tests: 2, passed: 2 });
    },
    ["lib/fv-alpha.test.ts: 2 tests passed, below its pinned minimum of 3"]
  ],
  [
    "a variant that was not caught, so the suite caught fewer than its pin",
    (input) => { input.suites[0].variants.pop(); },
    ["lib/fv-alpha.test.ts: 1 catch recorded for the property its suite named, below its pinned minimum of 2"]
  ],
  [
    "a variant caught without its reason",
    (input) => { input.suites[0].variants[1] = caught("a second variant", "the property", "another property"); },
    [
      'lib/fv-alpha.test.ts: variant "a second variant" is recorded as caught by "another property", not by the property its suite named, "the property"',
      "lib/fv-alpha.test.ts: 1 catch recorded for the property its suite named, below its pinned minimum of 2"
    ]
  ]
]) {
  test(`the rule refuses ${name}`, () => {
    assert.deepEqual(problemsOf(change), expected);
  });
}

test("a variant caught without its reason is refused even above the suite's minimum", () => {
  const reasons = problemsOf((input) => {
    input.suites[0].variants.push(caught("a third variant"), caught("a fourth variant", "p", "q"));
  });
  assert.deepEqual(reasons, ['lib/fv-alpha.test.ts: variant "a fourth variant" is recorded as caught by "q", not by the property its suite named, "p"']);
});

test("the rule judges nothing by a list that is not a list of required suites", () => {
  const report = buildFormalVerificationReport(records());
  for (const [list, reason] of [
    [undefined, "requiredSuites must name every required suite"],
    [[], "requiredSuites must name every required suite"],
    [[{ id: "lib/fv-alpha.test.ts", minimumTests: 3 }], "requiredSuites entry 1 must hold exactly id, minimumTests and minimumVariants, in that order"],
    [[{ id: "lib/fv-alpha.test.ts", minimumTests: 3, minimumVariants: 2, note: "x" }], "requiredSuites entry 1 must hold exactly id, minimumTests and minimumVariants, in that order"],
    [[{ id: "../outside.test.ts", minimumTests: 3, minimumVariants: 2 }], "requiredSuites entry 1 does not name a suite file under lib or investigation/test"],
    [[{ id: "scripts/x.test.mjs", minimumTests: 3, minimumVariants: 2 }], "requiredSuites entry 1 does not name a suite file under lib or investigation/test"],
    [[REQUIRED[0], REQUIRED[0]], "requiredSuites names lib/fv-alpha.test.ts twice"],
    [[{ id: "lib/fv-alpha.test.ts", minimumTests: 0, minimumVariants: 0 }], "lib/fv-alpha.test.ts: minimumTests must be a whole number of at least 1"],
    [[{ id: "lib/fv-alpha.test.ts", minimumTests: 1.5, minimumVariants: 0 }], "lib/fv-alpha.test.ts: minimumTests must be a whole number of at least 1"],
    [[{ id: "lib/fv-alpha.test.ts", minimumTests: 1, minimumVariants: -1 }], "lib/fv-alpha.test.ts: minimumVariants must be a whole number, 0 or more"],
    [[{ id: "lib/fv-alpha.test.ts", minimumTests: "3", minimumVariants: 0 }], "lib/fv-alpha.test.ts: minimumTests must be a whole number of at least 1"]
  ]) {
    assert.deepEqual(formalVerificationRequiredSuitesProblems(list), [reason]);
    assert.deepEqual(formalVerificationReportProblems(report, list, { commit: COMMIT, tree: TREE }), [reason]);
  }
  assert.deepEqual(formalVerificationRequiredSuitesProblems(REQUIRED), []);
});

test("a suite id maps to the compiled file its own stage of test:unit runs", () => {
  assert.equal(compiledSuitePath("lib/fv-alpha.test.ts"), ".unit-test-dist/lib/fv-alpha.test.js");
  assert.equal(compiledSuitePath("investigation/test/case-exploration.test.ts"), ".investigation-test-dist/investigation/test/case-exploration.test.js");
  for (const id of ["lib/../fv.test.ts", "lib/nested/fv.test.ts", "scripts/x.test.mjs", "lib/fv.ts", "/lib/fv.test.ts", 7]) {
    assert.throws(() => compiledSuitePath(id), /not a suite id/);
  }
});

// ---------------------------------------------------------------------------
// The bytes.
// ---------------------------------------------------------------------------

test("the same results give the same bytes, whatever order they arrived in", () => {
  const forward = records();
  const reversed = records();
  reversed.suites.reverse();
  for (const suite of reversed.suites) {
    suite.tests.reverse();
    suite.variants.reverse();
    suite.counts = Object.fromEntries(Object.entries(suite.counts).reverse());
  }
  const bytes = serializeFormalVerificationReport(buildFormalVerificationReport(forward));
  assert.equal(serializeFormalVerificationReport(buildFormalVerificationReport(reversed)), bytes);
  assert.ok(bytes.endsWith("}\n"));
  // Nothing a run could vary but its results: no time, no duration, no path.
  assert.deepEqual(Object.keys(JSON.parse(bytes)), ["schemaVersion", "artifactKind", "source", "suites"]);
  assert.deepEqual(Object.keys(JSON.parse(bytes).suites[0]), ["id", "counts", "tests", "variants"]);
  // What node's summary holds beyond the fields the report states is left out.
  const extra = records();
  extra.suites[0].counts = { ...extra.suites[0].counts, topLevel: 3, suites: 0 };
  extra.suites[0].tests = extra.suites[0].tests.map((entry) => ({ ...entry, durationMs: 7 }));
  assert.equal(serializeFormalVerificationReport(buildFormalVerificationReport(extra)), bytes);
});

test("a report is read back from its canonical bytes and from nothing else", () => {
  const report = buildFormalVerificationReport(records());
  const bytes = serializeFormalVerificationReport(report);
  assert.deepEqual(parseFormalVerificationReport(Buffer.from(bytes)), { report, problems: [] });

  const refused = (text, reason) => {
    const parsed = parseFormalVerificationReport(Buffer.isBuffer(text) ? text : Buffer.from(text));
    assert.equal(parsed.report, null);
    assert.deepEqual(parsed.problems, [reason]);
  };
  refused(Buffer.from([0xff, 0xfe, 0x7b]), "the report is not UTF-8");
  refused("{", "the report is not JSON");
  refused(JSON.stringify(report), "the report is not in its canonical serialization");
  refused(`${bytes}\n`, "the report is not in its canonical serialization");
  // A byte order mark before the canonical text: a decoder drops it, so the text is the same and the bytes are not.
  const marked = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bytes)]);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(marked), bytes, "the mark must be one a decoder drops, or this case shows nothing");
  refused(marked, "the report is not in its canonical serialization");
  // The same bytes held as a plain byte array, not a Buffer, are read as the same report.
  assert.deepEqual(parseFormalVerificationReport(new Uint8Array(Buffer.from(bytes))), { report, problems: [] });
  // Anything that is not bytes is refused with a reason, and nothing is thrown.
  const exact = new Uint8Array(Buffer.from(bytes));
  for (const notBytes of [exact.buffer, new DataView(exact.buffer), bytes, report, null, undefined]) {
    assert.deepEqual(parseFormalVerificationReport(notBytes), { report: null, problems: ["the report was not given as bytes"] });
  }

  const edited = (change) => {
    const copy = JSON.parse(bytes);
    change(copy);
    return serializeFormalVerificationReport(copy);
  };
  for (const [change, reason] of [
    [(copy) => { copy.note = "x"; }, "malformed report: the report must hold exactly schemaVersion, artifactKind, source and suites, in that order"],
    [(copy) => { copy.schemaVersion = 3; }, "malformed report: schemaVersion must be 2"],
    // The earlier shape, which listed a test that failed as expected as passed, is not read.
    [(copy) => { copy.schemaVersion = 1; }, "malformed report: schemaVersion must be 2"],
    [(copy) => { copy.artifactKind = "exact-source-and-tested-artifact-manifest"; }, `malformed report: artifactKind must be ${FORMAL_VERIFICATION_REPORT_KIND}`],
    [(copy) => { copy.source.commit = "abc"; }, "malformed report: source must hold exactly a full commit id and a full tree id"],
    [(copy) => { copy.source.branch = "main"; }, "malformed report: source must hold exactly a full commit id and a full tree id"],
    [(copy) => { copy.suites = {}; }, "malformed report: suites must be a list"],
    [(copy) => { copy.suites[0].method = "exhaustive"; }, "malformed report: lib/fv-alpha.test.ts must hold exactly id, counts, tests and variants, in that order"],
    [(copy) => { copy.suites[0].id = "lib/elsewhere/x.test.ts"; }, "malformed report: lib/elsewhere/x.test.ts does not name a suite file under lib or investigation/test"],
    [(copy) => { copy.suites[0].counts.durationMs = 3; }, "malformed report: lib/fv-alpha.test.ts: counts must hold exactly tests, passed, failed, cancelled, skipped, todo, expectedFailures, skippedSuites, todoSuites, failedSuites, each a whole number"],
    [(copy) => { delete copy.suites[0].counts.failedSuites; }, "malformed report: lib/fv-alpha.test.ts: counts must hold exactly tests, passed, failed, cancelled, skipped, todo, expectedFailures, skippedSuites, todoSuites, failedSuites, each a whole number"],
    [(copy) => { copy.suites[0].counts.passed = -1; }, "malformed report: lib/fv-alpha.test.ts: counts must hold exactly tests, passed, failed, cancelled, skipped, todo, expectedFailures, skippedSuites, todoSuites, failedSuites, each a whole number"],
    [(copy) => { copy.suites[0].tests[0].outcome = "flaky"; }, "malformed report: lib/fv-alpha.test.ts: each test must hold exactly a name and an outcome of passed, failed, skipped, todo, expected-failure"],
    [(copy) => { copy.suites[0].tests[0].name = ""; }, "malformed report: lib/fv-alpha.test.ts: each test must hold exactly a name and an outcome of passed, failed, skipped, todo, expected-failure"],
    [(copy) => { delete copy.suites[0].variants[0].caughtBy; }, "malformed report: lib/fv-alpha.test.ts: each variant must hold exactly variant, property and caughtBy"],
    [(copy) => { copy.suites[0].variants[0].property = 7; }, "malformed report: lib/fv-alpha.test.ts: each variant must hold exactly variant, property and caughtBy"],
    [(copy) => { copy.suites[0].tests.reverse(); }, "malformed report: lib/fv-alpha.test.ts: tests and variants must be in canonical order"],
    [(copy) => { copy.suites[0].variants.reverse(); }, "malformed report: lib/fv-alpha.test.ts: tests and variants must be in canonical order"],
    [(copy) => { copy.suites.reverse(); }, "malformed report: suites must be in canonical order"],
    [(copy) => { copy.suites[1] = copy.suites[0]; }, "malformed report: the report names a suite twice"],
    // The listed tests and node's own counts are two readings of one run.
    [(copy) => { copy.suites[0].tests.pop(); }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"],
    [(copy) => { copy.suites[0].counts.tests = 4; }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"],
    [(copy) => { copy.suites[0].counts.passed = 2; copy.suites[0].counts.failed = 1; }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"],
    [(copy) => { copy.suites[0].tests[0].outcome = "skipped"; }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"],
    // One listed test more than the counts hold, of each outcome in turn: each
    // outcome is held to its own count, so none can hide a test the summary lacks.
    ...["passed", "failed", "skipped", "todo", "expected-failure"].map((outcome) => [
      (copy) => { copy.suites[0].tests.push({ name: "zz one more than the counts hold", outcome }); },
      "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"
    ]),
    // A test listed as failed as expected that the counts do not hold, and one the counts hold that is listed as passed.
    [(copy) => { copy.suites[0].tests[0].outcome = "expected-failure"; }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"],
    [(copy) => { copy.suites[0].counts.expectedFailures = 1; }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"],
    // A cancelled test is listed as failed, so the two counts are read together.
    [(copy) => { copy.suites[0].counts.tests = 4; copy.suites[0].counts.cancelled = 1; }, "malformed report: lib/fv-alpha.test.ts: the listed tests do not add up to its counts"]
  ]) {
    refused(edited(change), reason);
    // The rule refuses the same value when it is handed one that was never parsed.
    const copy = JSON.parse(bytes);
    change(copy);
    assert.deepEqual(formalVerificationReportProblems(copy, REQUIRED, { commit: COMMIT, tree: TREE }), [reason]);
  }
});

test("a long list of problems is cut, and says how many it left out", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ id: `lib/fv-${String(index).padStart(2, "0")}.test.ts`, minimumTests: 1, minimumVariants: 0 }));
  const reasons = formalVerificationReportProblems(buildFormalVerificationReport({ commit: COMMIT, tree: TREE, suites: [] }), many);
  assert.equal(reasons.length, 41);
  assert.equal(reasons[0], "required suite lib/fv-00.test.ts is absent from the report");
  assert.equal(reasons.at(-1), "and 20 more");
});

// ---------------------------------------------------------------------------
// The producer, on fixture suites run for real.
// ---------------------------------------------------------------------------

test("a run for the report goes through the lane's own arguments, with its bounds, and adds only a reporter", () => {
  const flags = ["--test-reporter=file:///reporter.mjs", "--test-reporter-destination=/tmp/events"];
  const plain = laneArguments(["a.test.js"], 1, "/tmp/summaries");
  const reported = laneArguments(["a.test.js"], 1, "/tmp/summaries", flags);
  assert.deepEqual(reported, [...plain.slice(0, -1), ...flags, "a.test.js"]);
  for (const flag of TEST_BOUND_FLAGS) assert.ok(reported.includes(flag), flag);
  const producer = readFileSync(PRODUCER, "utf8");
  assert.match(producer, /runLane\(\[compiled\], 1, \{\s*requireRealTests: true,\s*reporterFlags:/);
  assert.equal(producer.split("runLane(").length - 1, 1, "every suite must run through the one guarded lane call");
});

const FIXTURE_HEAD = `import { createRequire } from "node:module";
import { describe, test } from "node:test";
const { assertCaughtBy, holds } = createRequire(import.meta.url)(${JSON.stringify(HARNESS)});
`;
const FIXTURES = {
  "lib/fv-whole.test.ts": `${FIXTURE_HEAD}
test("a property holds", () => { holds("p", true, () => null); });
test("the check catches a variant: one", async () => { await assertCaughtBy("one", "p", () => holds("p", false, () => 1)); });
test("the check catches a variant: two, with a subtest", async (t) => {
  await t.test("inside", async () => { await assertCaughtBy("two", "q", () => holds("q", false, () => 2)); });
});
`,
  "lib/fv-plain.test.ts": `${FIXTURE_HEAD}
test("no variant here", () => {});
`,
  "lib/fv-skips.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
test("left out", { skip: "not today" }, () => {});
`,
  "lib/fv-todo.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
test("to be written", { todo: true }, () => {});
`,
  "lib/fv-skipped-block.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
describe.skip("a block left out", () => { test("never runs", () => {}); });
`,
  // node lists this block under failing tests and counts no failure. The pinned Node then exits 0.
  "lib/fv-block-after-hook.test.ts": `${FIXTURE_HEAD}
import { after } from "node:test";
describe("a block whose after hook throws", () => { after(() => { throw new Error("after hook broke"); }); test("inside, passes", () => {}); });
test("runs", () => {});
`,
  "lib/fv-block-before-hook.test.ts": `${FIXTURE_HEAD}
import { before } from "node:test";
describe("a block whose before hook throws", () => { before(() => { throw new Error("before hook broke"); }); test("inside, never runs", () => {}); });
test("runs", () => {});
`,
  // The same, excused: a block marked as expected to fail whose hook throws arrives as a pass.
  // The pinned Node leaves the test inside alone and exits 0.
  "lib/fv-block-expected-failure.test.ts": `${FIXTURE_HEAD}
import { after } from "node:test";
describe("a block excused for failing", { expectFailure: true }, () => { after(() => { throw new Error("after hook broke"); }); test("inside, passes", () => {}); });
test("runs", () => {});
`,
  // node reports this test as a pass and counts it as one.
  "lib/fv-expected-failure.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
test("a property that is violated, marked as expected to fail", { expectFailure: true }, () => { holds("p", false, () => 1); });
test("outer", async (t) => { await t.test("a subtest that is violated, marked the same", { expectFailure: true }, () => { throw new Error("violated"); }); });
`,
  "lib/fv-todo-block.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
describe.todo("a block to be written", () => { test("inside a todo block", () => {}); });
`,
  // With no test inside, a todo block changes none of node's counts.
  "lib/fv-todo-empty-block.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
describe.todo("a block with nothing in it yet");
`,
  // node's verdict on the file itself, in its two forms: a hook at the file's top level that
  // throws, and a process that ends with a failing status after its tests passed.
  "lib/fv-file-hook.test.ts": `${FIXTURE_HEAD}
import { after } from "node:test";
after(() => { throw new Error("a hook at the top level broke"); });
test("runs", () => {});
`,
  "lib/fv-exit-status.test.ts": `${FIXTURE_HEAD}
test("passes, and leaves a failing exit status behind", () => { process.exitCode = 3; });
`,
  "lib/fv-fails.test.ts": `${FIXTURE_HEAD}
test("runs", () => {});
test("the check catches a variant: it does not", async () => { await assertCaughtBy("survivor", "p", () => undefined); });
`,
  "lib/fv-wrong-reason.test.ts": `${FIXTURE_HEAD}
test("the check catches a variant: for another reason", async () => { await assertCaughtBy("misread", "p", () => holds("q", false, () => 1)); });
`,
  "lib/fv-stops-early.test.ts": `${FIXTURE_HEAD}
test("first", () => { process.exit(0); });
test("never reported", () => {});
`,
  "lib/fv-dirties.test.ts": `${FIXTURE_HEAD}
import { writeFileSync } from "node:fs";
test("leaves a file behind", () => { writeFileSync("left-behind.txt", "x"); });
`,
  // The tree stays clean, and the commit under it is no longer the one the run began at.
  "lib/fv-moves-head.test.ts": `${FIXTURE_HEAD}
import { execFileSync } from "node:child_process";
test("commits while it runs", () => { execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "Moved while the suites ran"], { stdio: "ignore" }); });
`,
  "lib/fv-empty.test.ts": `${FIXTURE_HEAD}
`,
  // Something other than the harness writes to the catch log.
  "lib/fv-foreign-line.test.ts": `${FIXTURE_HEAD}
import { appendFileSync } from "node:fs";
test("writes a line the harness would not", () => { appendFileSync(process.env.${FORMAL_VERIFICATION_CATCH_LOG_ENV}, JSON.stringify({ variant: "invented", property: "p" }) + "\\n"); });
`,
  "lib/fv-broken-line.test.ts": `${FIXTURE_HEAD}
import { appendFileSync } from "node:fs";
test("writes a line that is not JSON", () => { appendFileSync(process.env.${FORMAL_VERIFICATION_CATCH_LOG_ENV}, "caught: everything\\n"); });
`
};

/** A throwaway repository holding the fixture suites, already "compiled" as plain modules. */
function fixture(t) {
  assert.ok(existsSync(HARNESS), `${HARNESS} is missing: compile the lib tests first (npx tsc -p tsconfig.test.json)`);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fv-report-fixture-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fv-report-output-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  // Neither the host's git configuration nor a detached maintenance run may
  // reach a fixture: lib/git-fixture.ts says why, for the lib tests.
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
    GIT_CONFIG_KEY_2: "commit.gpgsign",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.hooksPath",
    GIT_CONFIG_VALUE_3: ""
  };
  for (const name of ["GITHUB_SHA", "SITE_BEHAVIOR_LAB_BUILD_COMMIT", "CF_PAGES_COMMIT_SHA", "NODE_TEST_CONTEXT", FORMAL_VERIFICATION_CATCH_LOG_ENV]) delete gitEnv[name];
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const compiled = {};
  mkdirSync(path.join(root, "compiled"));
  for (const [id, source] of Object.entries(FIXTURES)) {
    compiled[id] = `compiled/${path.basename(id, ".ts")}.mjs`;
    writeFileSync(path.join(root, compiled[id]), source);
  }
  writeFileSync(
    path.join(root, "driver.mjs"),
    `import { produceFormalVerificationReport } from ${JSON.stringify(PRODUCER)};
const result = await produceFormalVerificationReport({ compile: false, ...JSON.parse(process.argv[2]) });
process.stdout.write("\\nRESULT " + JSON.stringify({ ok: result.ok, problems: result.problems, totals: result.totals }) + "\\n");
`
  );
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Fixture Maintainer");
  git("config", "user.email", "fixture@example.test");
  git("add", ".");
  git("commit", "--quiet", "-m", "Fixture suites");
  const suite = (id, minimumTests = 1, minimumVariants = 0) => ({ id, minimumTests, minimumVariants });
  /** Run the producer in its own process: a child of this test would otherwise inherit its test context. */
  const produce = (requiredSuites, { output, env = {}, compile = false } = {}) => {
    const result = spawnSync(process.execPath, ["driver.mjs", JSON.stringify({ requiredSuites, output, compile, compiledFiles: compiled })], {
      cwd: root,
      encoding: "utf8",
      env: { ...gitEnv, ...env },
      maxBuffer: 64 * 1024 * 1024
    });
    const line = result.stdout.split("\n").findLast((candidate) => candidate.startsWith("RESULT "));
    assert.ok(line, `the producer printed no result:\n${result.stdout}\n${result.stderr}`);
    return { ...JSON.parse(line.slice("RESULT ".length)), log: `${result.stdout}${result.stderr}` };
  };
  return { root, outside, git, suite, produce, head: () => git("rev-parse", "HEAD"), tree: () => git("rev-parse", "HEAD^{tree}") };
}

test("a passing run is written whole for the exact commit: node's counts, each test by name, each accepted catch", (t) => {
  const f = fixture(t);
  const required = [f.suite("lib/fv-whole.test.ts", 4, 2), f.suite("lib/fv-plain.test.ts")];
  const output = path.join(f.outside, "report.json");
  const result = f.produce(required, { output });
  assert.equal(result.ok, true, result.log);
  assert.deepEqual(result.totals, { suites: 2, tests: 5, variants: 2 });

  const bytes = readFileSync(output);
  const { report, problems } = parseFormalVerificationReport(bytes);
  assert.deepEqual(problems, []);
  assert.deepEqual(report, {
    schemaVersion: 2,
    artifactKind: FORMAL_VERIFICATION_REPORT_KIND,
    source: { commit: f.head(), tree: f.tree() },
    suites: [
      { id: "lib/fv-plain.test.ts", counts: counts({ tests: 1, passed: 1 }), tests: [{ name: "no variant here", outcome: "passed" }], variants: [] },
      {
        id: "lib/fv-whole.test.ts",
        counts: counts({ tests: 4, passed: 4 }),
        tests: [
          { name: "a property holds", outcome: "passed" },
          { name: "inside", outcome: "passed" },
          { name: "the check catches a variant: one", outcome: "passed" },
          { name: "the check catches a variant: two, with a subtest", outcome: "passed" }
        ],
        variants: [
          { variant: "one", property: "p", caughtBy: "p" },
          { variant: "two", property: "q", caughtBy: "q" }
        ]
      }
    ]
  });
  assert.deepEqual(formalVerificationReportProblems(report, required, { commit: f.head(), tree: f.tree() }), []);
  assert.equal(f.git("status", "--porcelain", "--untracked-files=all"), "", "the run must leave the checkout clean");

  // A second run of the same commit gives the same bytes, and the suites
  // named in another order give them too.
  const again = path.join(f.outside, "again.json");
  assert.equal(f.produce([...required].reverse(), { output: again }).ok, true);
  assert.ok(readFileSync(again).equals(bytes));
});

// Two rows below are held exactly on the pinned Node only, because what node does with their
// fixtures differs by version, in two ways this file has run on both sides of:
//
// - A describe block that fails as a block. 24.14.1 (pinned) counts no failure and exits 0,
//   so the lane passes and the block's own event is all that refuses the run. 24.22.1 (the
//   image's until its v1.65.0-noble base) counts no failure either and exits 1, so the lane's
//   verdict joins the reasons.
// - A describe block marked expectFailure. 24.14.1 leaves the test inside it alone. 24.22.1
//   passes the mark down, so the test inside, which passes, arrives as a failure, node exits
//   1, and node adds a failure for the file itself.
//
// 26.13.0, the image's Node from the v1.65.0-noble base, does in both what 24.22.1 does (the
// same exit status, counts and failing lines for these two fixtures, 2026-11-10), and this file
// passes whole on it.
//
// On every Node the run is refused and no report is written. On the pinned Node the reasons
// are these exactly. On any other, each row says what must still hold of them: for the first,
// the same reasons once the lane's verdict is set aside; for the second, the block named and
// the rule's own count of it, among whatever else that Node adds.
const exactButForTheLane = (problems, reasons, id) => assert.deepEqual(problems.filter((line) => line !== `${id}: its run did not pass`), reasons);
const eachAmongThem = (problems, reasons, id) => {
  for (const reason of reasons) assert.ok(problems.includes(reason), `${reason}\nis not among:\n${problems.join("\n")}`);
  for (const line of problems) assert.ok(line.startsWith(`${id}: `), `a reason that is not this suite's: ${line}`);
};

for (const [name, id, minimums, reasons, onAnotherNode] of [
  ["a skipped test", "lib/fv-skips.test.ts", [1, 0], ["lib/fv-skips.test.ts: its run did not pass", 'lib/fv-skips.test.ts: 1 test skipped, the first by name "left out"']],
  ["a test left todo", "lib/fv-todo.test.ts", [1, 0], ["lib/fv-todo.test.ts: its run did not pass", 'lib/fv-todo.test.ts: 1 test left todo, the first by name "to be written"']],
  [
    "a skipped describe block",
    "lib/fv-skipped-block.test.ts",
    [1, 0],
    ["lib/fv-skipped-block.test.ts: its run did not pass", 'lib/fv-skipped-block.test.ts: describe block "a block left out" was skipped', "lib/fv-skipped-block.test.ts: 1 describe block skipped"]
  ],
  [
    "a describe block whose after hook throws",
    "lib/fv-block-after-hook.test.ts",
    [2, 0],
    ['lib/fv-block-after-hook.test.ts: describe block "a block whose after hook throws" failed as a block', "lib/fv-block-after-hook.test.ts: 1 describe block failed as a block"],
    exactButForTheLane
  ],
  [
    "a describe block whose before hook throws",
    "lib/fv-block-before-hook.test.ts",
    [1, 0],
    [
      "lib/fv-block-before-hook.test.ts: its run did not pass",
      'lib/fv-block-before-hook.test.ts: describe block "a block whose before hook throws" failed as a block',
      'lib/fv-block-before-hook.test.ts: 1 test failed or cancelled, the first by name "inside, never runs"',
      "lib/fv-block-before-hook.test.ts: 1 describe block failed as a block"
    ]
  ],
  [
    "a describe block excused for failing",
    "lib/fv-block-expected-failure.test.ts",
    [2, 0],
    ['lib/fv-block-expected-failure.test.ts: describe block "a block excused for failing" failed as a block', "lib/fv-block-expected-failure.test.ts: 1 describe block failed as a block"],
    eachAmongThem
  ],
  [
    // Four tests "pass" by node's count. Two of them threw.
    "a test and a subtest that failed as expected, which node counts as passed",
    "lib/fv-expected-failure.test.ts",
    [2, 0],
    ['lib/fv-expected-failure.test.ts: 2 tests failed as expected, which is no pass, the first by name "a property that is violated, marked as expected to fail"']
  ],
  [
    "a test that failed as expected counted toward its minimum",
    "lib/fv-expected-failure.test.ts",
    [3, 0],
    [
      'lib/fv-expected-failure.test.ts: 2 tests failed as expected, which is no pass, the first by name "a property that is violated, marked as expected to fail"',
      "lib/fv-expected-failure.test.ts: 2 tests passed, below its pinned minimum of 3"
    ]
  ],
  [
    "a todo describe block",
    "lib/fv-todo-block.test.ts",
    [1, 0],
    [
      "lib/fv-todo-block.test.ts: its run did not pass",
      'lib/fv-todo-block.test.ts: describe block "a block to be written" is left todo',
      'lib/fv-todo-block.test.ts: 1 test left todo, the first by name "inside a todo block"',
      "lib/fv-todo-block.test.ts: 1 describe block left todo"
    ]
  ],
  [
    "a todo describe block with no test in it, which moves none of node's counts",
    "lib/fv-todo-empty-block.test.ts",
    [1, 0],
    ['lib/fv-todo-empty-block.test.ts: describe block "a block with nothing in it yet" is left todo', "lib/fv-todo-empty-block.test.ts: 1 describe block left todo"]
  ],
  [
    // Not a test of the file, and in none of the file's counts: listed as one, it would
    // make the list disagree with the counts and hide every other reason.
    "a hook at the top level of the file that throws",
    "lib/fv-file-hook.test.ts",
    [1, 0],
    ["lib/fv-file-hook.test.ts: its run did not pass", "lib/fv-file-hook.test.ts: node reported its file as failed, apart from its tests"]
  ],
  [
    "a process that ends with a failing status after its tests passed",
    "lib/fv-exit-status.test.ts",
    [1, 0],
    ["lib/fv-exit-status.test.ts: its run did not pass", "lib/fv-exit-status.test.ts: node reported its file as failed, apart from its tests"]
  ],
  [
    "a variant its check does not catch",
    "lib/fv-fails.test.ts",
    [1, 1],
    [
      "lib/fv-fails.test.ts: its run did not pass",
      'lib/fv-fails.test.ts: 1 test failed or cancelled, the first by name "the check catches a variant: it does not"',
      "lib/fv-fails.test.ts: 0 catches recorded for the property its suite named, below its pinned minimum of 1"
    ]
  ],
  [
    "a variant caught for another property",
    "lib/fv-wrong-reason.test.ts",
    [1, 1],
    [
      "lib/fv-wrong-reason.test.ts: its run did not pass",
      'lib/fv-wrong-reason.test.ts: 1 test failed or cancelled, the first by name "the check catches a variant: for another reason"',
      "lib/fv-wrong-reason.test.ts: 0 tests passed, below its pinned minimum of 1",
      "lib/fv-wrong-reason.test.ts: 0 catches recorded for the property its suite named, below its pinned minimum of 1"
    ]
  ],
  ["fewer tests than its minimum", "lib/fv-plain.test.ts", [2, 0], ["lib/fv-plain.test.ts: 1 test passed, below its pinned minimum of 2"]],
  ["fewer variants than its minimum", "lib/fv-whole.test.ts", [4, 3], ["lib/fv-whole.test.ts: 2 catches recorded for the property its suite named, below its pinned minimum of 3"]],
  [
    "a suite that ends its process before its tests finish",
    "lib/fv-stops-early.test.ts",
    [1, 0],
    ["lib/fv-stops-early.test.ts: its run did not pass", "lib/fv-stops-early.test.ts: its run left 0 summaries, so its results are not whole", "required suite lib/fv-stops-early.test.ts is absent from the report"]
  ],
  [
    "a suite that runs no test",
    "lib/fv-empty.test.ts",
    [1, 0],
    // node writes no summary for a file that registered no test, so it is refused as a run that is not whole.
    ["lib/fv-empty.test.ts: its run did not pass", "lib/fv-empty.test.ts: its run left 0 summaries, so its results are not whole", "required suite lib/fv-empty.test.ts is absent from the report"]
  ],
  [
    "a catch log line the harness would not write",
    "lib/fv-foreign-line.test.ts",
    [1, 0],
    ["lib/fv-foreign-line.test.ts: its catch log holds a line that is not a catch", "required suite lib/fv-foreign-line.test.ts is absent from the report"]
  ],
  [
    "a catch log line that is not JSON",
    "lib/fv-broken-line.test.ts",
    [1, 0],
    ["lib/fv-broken-line.test.ts: its catch log holds a line that is not a catch", "required suite lib/fv-broken-line.test.ts is absent from the report"]
  ],
  [
    "a suite whose compiled file is missing",
    "lib/fv-missing.test.ts",
    [1, 0],
    ["lib/fv-missing.test.ts: its run did not pass", "lib/fv-missing.test.ts: its run left 0 summaries, so its results are not whole", "required suite lib/fv-missing.test.ts is absent from the report"]
  ]
]) {
  test(`no report is written for ${name}, and the reason names it`, (t) => {
    const f = fixture(t);
    const output = path.join(f.outside, "report.json");
    // A suite that passes stands beside it, so one bad suite is enough to refuse.
    const beside = id === "lib/fv-plain.test.ts" ? f.suite("lib/fv-whole.test.ts", 4, 2) : f.suite("lib/fv-plain.test.ts");
    const result = f.produce([beside, f.suite(id, ...minimums)], { output });
    assert.equal(result.ok, false, result.log);
    if (onAnotherNode === undefined || ON_PINNED_NODE) assert.deepEqual(result.problems, reasons);
    else onAnotherNode(result.problems, reasons, id);
    assert.equal(existsSync(output), false, "a refused run must leave no report");
  });
}

test("the rows held exactly on the pinned Node alone are the two this file names", () => {
  // Such a row says less on every other Node, so there must be no more of them than the two
  // whose fixtures node is known to treat differently by version.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(source.split("    exactButForTheLane\n").length - 1, 1);
  assert.equal(source.split("    eachAmongThem\n").length - 1, 1);
  assert.equal(source.split("onAnotherNode(").length - 1, 2, "one call, and this line");
  assert.match(PINNED_NODE, /^\d+\.\d+\.\d+$/);
});

test("the checkout must be clean and exact, before the run and after it", (t) => {
  const f = fixture(t);
  const required = [f.suite("lib/fv-plain.test.ts")];
  const output = path.join(f.outside, "report.json");

  // An output inside the worktree would dirty the source it names.
  const inside = f.produce(required, { output: "report.json" });
  assert.deepEqual(inside.problems, ["--output must be outside the Git worktree, so that writing the report cannot dirty the source it names"]);
  assert.doesNotMatch(inside.log, /no variant here/, "nothing may run once the output is refused");
  assert.deepEqual(f.produce(required, { output: path.join(f.outside, "no-such-directory", "report.json") }).problems, ["--output must be in a directory that exists"]);

  // A commit the environment names must be the one checked out.
  const elsewhere = f.produce(required, { output, env: { GITHUB_SHA: "5".repeat(40) } });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.problems[0], /GITHUB_SHA does not match the checked-out Git HEAD/);
  assert.equal(existsSync(output), false);

  // A tree dirtied by the run itself is refused after the run.
  const dirtied = f.produce([f.suite("lib/fv-dirties.test.ts")], { output });
  assert.equal(dirtied.ok, false, dirtied.log);
  assert.equal(dirtied.problems.length, 1);
  assert.match(dirtied.problems[0], /^the checkout changed while the suites ran: .*clean Git worktree.*left-behind\.txt/);
  assert.equal(existsSync(output), false);

  // That left the tree dirty, which is now refused before anything runs.
  const dirty = f.produce(required, { output });
  assert.equal(dirty.ok, false);
  assert.match(dirty.problems[0], /requires a clean Git worktree/);
  assert.doesNotMatch(dirty.log, /no variant here/, "nothing may run on a dirty tree");
  assert.equal(existsSync(output), false);

  rmSync(path.join(f.root, "left-behind.txt"));

  // A run that moves the checkout to another commit leaves the tree clean. The report
  // would name the commit the run began at, which is no longer what is checked out.
  const began = f.head();
  const moved = f.produce([f.suite("lib/fv-moves-head.test.ts")], { output });
  assert.notEqual(f.head(), began, "the fixture must have moved the checkout");
  assert.equal(f.git("status", "--porcelain", "--untracked-files=all"), "", "and left it clean");
  assert.equal(moved.ok, false, moved.log);
  assert.deepEqual(moved.problems, ["the checked-out commit changed while the suites ran"]);
  assert.equal(existsSync(output), false);

  assert.equal(f.produce(required, { output, env: { GITHUB_SHA: f.head() } }).ok, true);
  // A report is never overwritten.
  const second = f.produce(required, { output });
  assert.deepEqual(second.problems, ["--output must not already exist"]);
});

test("each tree a required suite is in is compiled from nothing before it runs, and no other", (t) => {
  // Every other test here runs suites already "compiled". This one compiles: two small
  // TypeScript projects under the names the command line compiles, with the repository's
  // own compiler, each a fraction of a second.
  const f = fixture(t);
  const project = (outDir, include) => JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", outDir, rootDir: ".", types: [], strict: true }, include: [include] });
  const source = (name) => `declare const require: (id: string) => { test: (name: string, body: () => void) => void };
const { test } = require("node:test");
test(${JSON.stringify(name)}, () => {});
`;
  mkdirSync(path.join(f.root, "lib"));
  mkdirSync(path.join(f.root, "investigation", "test"), { recursive: true });
  mkdirSync(path.join(f.root, "node_modules"));
  writeFileSync(path.join(f.root, ".gitignore"), "node_modules/\n.unit-test-dist/\n.investigation-test-dist/\n");
  writeFileSync(path.join(f.root, "tsconfig.test.json"), project(".unit-test-dist", "lib/**/*.ts"));
  writeFileSync(path.join(f.root, "tsconfig.investigation-test.json"), project(".investigation-test-dist", "investigation/**/*.ts"));
  writeFileSync(path.join(f.root, "lib", "fv-tiny.test.ts"), source("compiled from the lib source today"));
  writeFileSync(path.join(f.root, "investigation", "test", "tiny-walk.test.ts"), source("compiled from the investigation source today"));
  symlinkSync(path.join(repository, "node_modules", "typescript"), path.join(f.root, "node_modules", "typescript"), "dir");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "Two small projects");
  assert.equal(f.git("status", "--porcelain", "--untracked-files=all"), "");

  // What an earlier compile left behind: a suite that says something else, and a file the source no longer has.
  const stale = (tree, file, name) => {
    mkdirSync(path.dirname(path.join(f.root, tree, file)), { recursive: true });
    writeFileSync(path.join(f.root, tree, file), `require("node:test").test(${JSON.stringify(name)}, () => {});\n`);
  };
  const plant = () => {
    stale(".unit-test-dist", "lib/fv-tiny.test.js", "left by an earlier compile of lib");
    stale(".unit-test-dist", "lib/removed-since.test.js", "a suite the source no longer has");
    stale(".investigation-test-dist", "investigation/test/tiny-walk.test.js", "left by an earlier compile of investigation");
    stale(".investigation-test-dist", "investigation/test/removed-since.test.js", "a suite the source no longer has");
  };
  const lib = f.suite("lib/fv-tiny.test.ts");
  const walk = f.suite("investigation/test/tiny-walk.test.ts");
  const testsOf = (file) => parseFormalVerificationReport(readFileSync(file)).report.suites.map((suite) => [suite.id, suite.tests.map((entry) => entry.name)]);

  // Without a compile the stale suites are what runs, which is what this test must be able to tell.
  plant();
  const uncompiled = path.join(f.outside, "uncompiled.json");
  assert.equal(f.produce([walk, lib], { output: uncompiled }).ok, true);
  assert.deepEqual(testsOf(uncompiled), [[walk.id, ["left by an earlier compile of investigation"]], [lib.id, ["left by an earlier compile of lib"]]]);

  // Compiled: both trees are emptied and built from the source.
  const compiled = path.join(f.outside, "compiled.json");
  const both = f.produce([walk, lib], { output: compiled, compile: true });
  assert.equal(both.ok, true, both.log);
  assert.deepEqual(testsOf(compiled), [[walk.id, ["compiled from the investigation source today"]], [lib.id, ["compiled from the lib source today"]]]);
  assert.equal(existsSync(path.join(f.root, ".unit-test-dist", "lib", "removed-since.test.js")), false, "the lib tree must be emptied before its compile");
  assert.equal(existsSync(path.join(f.root, ".investigation-test-dist", "investigation", "test", "removed-since.test.js")), false, "the investigation tree must be emptied before its compile");

  // Only the tree a required suite is in: with lib alone, the investigation tree is left as it was.
  plant();
  const one = path.join(f.outside, "lib-only.json");
  assert.equal(f.produce([lib], { output: one, compile: true }).ok, true);
  assert.deepEqual(testsOf(one), [[lib.id, ["compiled from the lib source today"]]]);
  assert.equal(existsSync(path.join(f.root, ".unit-test-dist", "lib", "removed-since.test.js")), false);
  assert.equal(existsSync(path.join(f.root, ".investigation-test-dist", "investigation", "test", "removed-since.test.js")), true);
  // The command line always compiles: it passes no option that could turn the compile off.
  const producer = readFileSync(PRODUCER, "utf8");
  assert.match(producer, /export async function produceFormalVerificationReport\(\{ requiredSuites, output, env = process\.env, compile = true, compiledFiles = null \}\)/);
  assert.match(producer, /await produceFormalVerificationReport\(\{ requiredSuites: requiredSuitesOfManifest\(process\.cwd\(\)\), output \}\)/);
});

test("a dry run judges the same suites on a dirty tree, writes nothing, and names no commit", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "uncommitted.txt"), "work in progress\n");
  const passes = f.produce([f.suite("lib/fv-whole.test.ts", 4, 2)]);
  assert.equal(passes.ok, true, passes.log);
  assert.deepEqual(passes.totals, { suites: 1, tests: 4, variants: 2 });
  const fails = f.produce([f.suite("lib/fv-whole.test.ts", 5, 2)]);
  assert.deepEqual(fails.problems, ["lib/fv-whole.test.ts: 4 tests passed, below its pinned minimum of 5"]);
});

test("the command line takes one mode and no list of suites", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
  for (const args of [[], ["--output"], ["--dry-run", "--output", "x"], ["--suites", "lib/x.test.ts"], ["--output", "a", "b"]]) {
    const result = spawnSync(process.execPath, [PRODUCER, ...args], { cwd: os.tmpdir(), encoding: "utf8", env });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /^Usage: node scripts\/formal-verification-report\.mjs --output <file outside the worktree> \| --dry-run\n$/);
  }
});

test("the command line's suites are the manifest's gate's, and only while the manifest holds its release profile", async (t) => {
  const { requiredSuitesOfManifest } = await import("./formal-verification-report.mjs");
  const { V1_REQUIRED_SUITES } = await import("./v1-release-contract.mjs");
  assert.deepEqual(requiredSuitesOfManifest(repository), V1_REQUIRED_SUITES);
  assert.deepEqual(formalVerificationRequiredSuitesProblems(V1_REQUIRED_SUITES), []);
  // Each required suite is a file in this checkout, in a tree the producer compiles.
  for (const { id } of V1_REQUIRED_SUITES) {
    assert.ok(existsSync(path.join(repository, id)), `${id} does not exist`);
    assert.match(compiledSuitePath(id), /^\.(?:unit|investigation)-test-dist\//);
  }

  const root = mkdtempSync(path.join(os.tmpdir(), "fv-report-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const committed = JSON.parse(readFileSync(path.join(repository, "RELEASE_READINESS.json"), "utf8"));
  const write = (manifest) => writeFileSync(path.join(root, "RELEASE_READINESS.json"), JSON.stringify(manifest));

  // A manifest edited to ask a suite for less is not the reviewed list, so nothing runs by it.
  const lowered = structuredClone(committed);
  lowered.gates["formal-verification"].requiredSuites[0].minimumTests = 1;
  write(lowered);
  assert.throws(() => requiredSuitesOfManifest(root), /does not hold its release profile.*formal-verification must keep the pinned minimums of /);
  const dropped = structuredClone(committed);
  dropped.gates["formal-verification"].requiredSuites.pop();
  write(dropped);
  assert.throws(() => requiredSuitesOfManifest(root), /does not hold its release profile.*formal-verification must retain required suite /);
  // A manifest of another profile has no such gate.
  const historical = structuredClone(committed);
  delete historical.releaseProfile;
  delete historical.gates["formal-verification"];
  write(historical);
  assert.throws(() => requiredSuitesOfManifest(root), /names no formal-verification gate, so no suite is required/);
  write(committed);
  assert.deepEqual(requiredSuitesOfManifest(root), V1_REQUIRED_SUITES);
});

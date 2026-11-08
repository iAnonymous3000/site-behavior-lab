import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { spawnSyncBounded } from "./bounded-spawn";
import { assertCaughtBy, Counterexample, holds } from "./finite-check";
import { gitFixtureEnv, initFixtureRepo, removeFixtureTree, runFixtureGit } from "./git-fixture";

/**
 * Batch F6 of the bounded formal verification: docs/formal-verification.md, the public
 * claims register, held to the suites it restates, in both directions.
 *
 * The register restates claims the suites already state, which is the defect class of one
 * contract written in two files that both pass while they disagree. So this reads both
 * sides. From the register to the suites: every cited test exists now, by its exact name
 * as the source spells it, in its file, and so does every test a cited family matches, and
 * none of them is flagged (a modifier, options other than a plain object literal, a place
 * under anything but the source file, blocks, loops and the callbacks of tests, no function
 * literal, or a context's skip or todo; an empty loop, a test in a loop's incrementor, or a
 * `continue`, `break`, `return` or `throw` before a test is not refused, since the guard
 * reads no control flow);
 * every variant family has catch in its prefix and matches a templated test in its file;
 * every member a row names is an entry of a table its family runs over; every file a row
 * names exists, and every name it puts in code or in quotes is in one of its files; every
 * number a row states sits inside a phrase anchored to source text that holds it, stated
 * once; every named commit is a commit, an ancestor of the checkout, holds the row's tests
 * and families, and its first parent holds none of them. From the suites to the register:
 * every suite file and module is named, every test-like call in a suite file is cited,
 * every open test is cited as an open finding and never as a claim, and a table-driven open
 * test's cases are exactly its table's names, one table to a row, as far as the table reader
 * reads them: it takes a name only from an object literal in the array literal the test loops
 * over, written as a plain string literal, and leaves any other entry out with no refusal (the
 * register's Limits name this). Beside those, the wording
 * rules: closed field and method lists, plain ASCII with no HTML, a list of refused words
 * and stems, quantifiers tied to a domain, and the release gate still only proposed. The CI
 * history rule is not restated here: lib/ci-performance-contract.test.ts owns it, and this
 * holds the register to citing that test by its title.
 *
 * Each refusal is one named property, raised through `holds`, and each has a planted
 * variant below, or a test on a git fixture, that it catches first (`assertCaughtBy` returns on
 * the first counterexample, so "first" is what is checked). The test that holds every refusal to
 * having one reads the variant tables, and for the fixture tests FIXTURE_PROPERTIES, a list
 * written by hand: it does not read the fixture tests, so deleting one leaves it passing, and
 * P.gitFailure, which no variant table plants, is caught by fixture tests alone. A planted edit
 * to the register must land exactly once, so an edit that drifts fails instead of passing.
 *
 * Git. A row's Commit is a commit that holds its tests and whose first parent holds none of
 * them, never the commit that holds the register, so no row names itself. Git is read
 * through spawnSyncBounded with its default bound, SPAWN_SYNC_TIMEOUT_MS in
 * lib/bounded-spawn.ts, with GIT_NO_LAZY_FETCH=1 and GIT_NO_REPLACE_OBJECTS=1 in its
 * environment; a partial clone is refused before any object is read, so no read here can
 * fetch even on a git older than that variable, and grafts are refused, since they rewrite
 * the parents every read relies on. A git that fails, prints nothing or is killed fails once
 * under its own property, and that failure is kept, so the file pays one bound and not one
 * per test; a question git refused by its status is not asked again. A shallow or partial
 * clone, or a commit this checkout does not have, fails closed with a message that says so;
 * a missing or stranded commit names a rebase of unpushed history as the likely cause and
 * says how to regenerate the Commit fields. A checkout with no repository at all (the
 * container image build, whose context leaves .git out by design) skips the tests that
 * read the checkout's history, by name, and runs every text check and the fixture tests, as
 * lib/operator-evidence-producers.test.ts does for the repository head.
 *
 * The suites under investigation/test are read as text and never imported: an import would
 * pull the private workspace into this compile and into the public boundary walks.
 *
 * Lane. This file runs in the parallel lane: it sets no timer and reads no clock, it reads
 * the checkout's git read-only, its fixtures go through lib/git-fixture.ts, and its one
 * bound is the spawn bound above, which only a stuck child reaches.
 *
 * What this cannot see. It reads names, numbers and words, not meaning: a Property that
 * misstates what its tests hold passes if the names, numbers and words are in order. It
 * holds the register against honest drift and accidental edits by a maintainer, not
 * against a suite or register rewritten to evade it; the register's Limits name the
 * spellings it does not follow. A test may change after its Commit; the row speaks of the
 * test as it stands.
 */

const ROOT = process.cwd();
const REGISTER = "docs/formal-verification.md";

const P = {
  shape: "every row has its fields, in order, each in the grammar the register states",
  ids: "every row has a unique id of letters, digits, dots and hyphens, under a claims section or the open findings",
  methodList: "the register's method list is the guard's",
  wordList: "the register's list of refused words is the guard's",
  method: "every Method names distinct terms from the closed list, at least one of them not restatement",
  plainText: "the register is plain ASCII, with no HTML entity, and no HTML tag or comment outside code spans",
  refusedWord: "no refused word or phrase appears outside the register's list of them",
  quantifier: "no quantifier ranges over an open domain, or over inputs without naming the row's domain or bounds",
  citedWording: "no cited test title, family, title a family matches, case or member uses a refused word or an open quantifier",
  number: "every number the register states sits inside a phrase anchored in the source",
  anchor: "every anchor's phrase holds its number, and its source text is in its file and holds that number",
  staleAnchor: "every anchor names a row that states its phrase exactly once",
  citedFile: "every cited or discovered suite file exists",
  citedTest: "every cited test exists, by its exact name, in its file",
  skipped:
    "no cited or family-matched test carries skip, todo, only or expectFailure, takes options other than a plain object literal, sits under anything but blocks, loops and test callbacks, runs no function literal, or skips itself through its context",
  duplicate: "no suite file holds the same literal test title twice",
  family: "every variant family has catch in its prefix and matches a templated test in its file",
  members: "every member a row names is an entry of a table its cited family runs over",
  quoted: "every path a row names exists, its Code names a file, and every name it puts in code or quotes is in a file it names",
  cases: "a table-driven open test's cases are exactly its table's names, on the one row that cites it with them",
  openPlace: "open tests are cited only as open findings, and open findings cite only open tests",
  discovery: "the suite discovery finds every known suite file and module",
  suiteNamed: "every suite file and module is named in the register",
  covered: "every test-like call in a suite file is cited by a row",
  wiring: "every cited file runs in a stage of test:unit the register names",
  ciRule: "the register cites the contract test that owns the CI history rule, by its exact title",
  commands: "every npm command the register publishes is a package script",
  release: "the release gate is still only proposed, as the register says",
  commitShape: "every Commit is a full lowercase commit id",
  gitFailure: "git answers as git does: a failing, silent or broken git cannot show where a test landed",
  history: "the checkout has the whole history: a shallow or partial clone, or grafts, cannot show where a test landed",
  commitFound: "every named commit is in this checkout",
  commitType: "every named commit id names a commit object",
  ancestor: "every named commit is an ancestor of the checked-out commit",
  object: "every file a named commit lists can be read: a missing object cannot show where a test landed",
  atCommit: "every cited test and family is in its file at the named commit",
  firstLanded: "no cited test or family is in its file at the named commit's first parent"
} as const;

/** The closed list, as the register's Methods section states it. */
const METHODS = ["exhaustive", "bounded", "reachable states", "trace conformance", "sampled", "restatement"] as const;

/**
 * Refused anywhere in the register but in its own list, each group with one reason there. A
 * space matches any run of spaces, hyphens or slashes, and a trailing star any ending, so a
 * stem refuses every form of its word.
 */
const REFUSED_WORDS: readonly (readonly string[])[] = [
  ["proof", "proofs", "prove", "proves", "proved", "proven", "proving", "provable", "provably"],
  ["theorem", "theorems"],
  ["guarant*", "bulletproof"],
  ["formally verif*"],
  ["verified", "verifies", "certified", "certifies"],
  ["sound*"],
  ["correct", "correctly", "correctness", "incorrect", "incorrectly"],
  ["ensur*", "assur*"]
];

/** An input quantifier stands only when it names the row's domain or bounds at once, and not a domain or bounds of something else. */
const INPUT_QUANTIFIER = /\b(?:any|every|all|each|arbitrary)\s+(?:(?:and|all|of|the|possible|given|single|other)\s+)*inputs?\b/gi;
const INPUT_SCOPE = /^\s+(?:in\s+a\s+domain\s+D\b|in\s+(?:the|its)\s+(?:row's\s+)?domain\b(?!\s+of\b)|within\s+(?:the|its)\s+(?:row's\s+)?(?:stated\s+)?bounds\b(?!\s+of\b))/;
/** Domains no check walks: sites, pages, origins and browsers of the world. */
const OPEN_DOMAINS = [
  /\b(?:any|every|all|each|arbitrary)\s+(?:(?:and|all|of|the|single|other|possible|given|real|real-world|live|web)\s+)*(?:sites?|websites?|web\s*pages?|pages?|urls?|domains?|origins?|user\s+agents?|browsers?|chrome|chromium|firefox|safari|edge|brave|webkit)\b/i,
  /\breal[\s-]+world\s+(?:pages?|sites?|websites?|browsers?)\b/i,
  /\bthe\s+(?:entire|whole)\s+(?:web|internet)\b/i,
  /\b(?:universally|in\s+all\s+cases|in\s+every\s+case|without\s+exception)\b/i
];

/**
 * Spelled numbers, ordinals from the third on and multipliers. "one" counts only where it
 * states a bound (after "up to", "at most", "at least", "exactly" or "plus", or before
 * "past" or "more"); elsewhere it is an article. "zero", "first" and "second" are left out:
 * here they name a convention (zero-based), an order or a unit of time, never a count.
 */
const SPELLED_NUMBERS: Readonly<Record<string, number>> = {
  twice: 2,
  thrice: 3,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
  hundredth: 100,
  thousandth: 1000,
  millionth: 1000000,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
  million: 1000000,
  dozen: 12
};

type Anchor = Readonly<{ row: string; phrase: string; number: string; file: string; source: string }>;

/**
 * Every number a row states, by the phrase that states it and the suite source that holds
 * it: the code that sets or pins it where there is such code, and otherwise the suite's own
 * words for it, in a comment, a docblock, a test name or a property name. A phrase holds a whole clause from its lead, so a swap of two numbers, or of two
 * clauses, fails; it must appear in the row exactly once; every number in a row must sit
 * inside one of its anchored phrases; the source must be in its file and hold the number.
 * Where a phrase holds the same number twice, one anchor covers both. Numbers inside cited
 * test names are the suites' own.
 */
const ANCHORS: readonly Anchor[] = [
  { row: "EB1", phrase: "refuses one past it", number: "one", file: "lib/fv-producer-identity.test.ts", source: "new Array(row.publicLimits.requests + 1)" },
  { row: "EB1", phrase: "limit and one past it", number: "one", file: "lib/fv-producer-identity.test.ts", source: "new Array(row.publicLimits.requests + 1)" },
  { row: "CL1.2", phrase: "subsets of up to 3 details", number: "3", file: "lib/fv-coverage-loss.test.ts", source: "walkSubsets(3, (subset, added) => {" },
  { row: "CL1.3", phrase: "a subset of at most 1 detail", number: "1", file: "lib/fv-coverage-loss.test.ts", source: "walkSubsets(1, (subset, added) => {" },
  { row: "CL1.3", phrase: "status of 200, 404 or none", number: "200", file: "lib/fv-coverage-loss.test.ts", source: "[200, 404, null].flatMap((status) =>" },
  { row: "CL1.3", phrase: "status of 200, 404 or none", number: "404", file: "lib/fv-coverage-loss.test.ts", source: "[200, 404, null].flatMap((status) =>" },
  { row: "RA1.RA2", phrase: "lands in exactly one bucket", number: "one", file: "lib/fv-request-accounting.test.ts", source: "// RA1: every counted request lands in exactly one bucket, uncounted ones in none." },
  { row: "RA1.RA2", phrase: "up to 5 page requests, 5 observations and 5 dropped observations", number: "5", file: "lib/fv-request-accounting.test.ts", source: "const MAX_REQUESTS = 5;" },
  { row: "RA1.RA2", phrase: "up to 5 page requests, 5 observations and 5 dropped observations", number: "5", file: "lib/fv-request-accounting.test.ts", source: "const MAX_OBSERVATIONS = 5;" },
  { row: "RA1.RA2", phrase: "up to 5 page requests, 5 observations and 5 dropped observations", number: "5", file: "lib/fv-request-accounting.test.ts", source: "const MAX_DROPPED = 5;" },
  { row: "RA1.RA2", phrase: "for pairs of joins, up to 2 requests, 2 observations and 1 dropped observation", number: "2", file: "lib/fv-request-accounting.test.ts", source: "for (let requests = 0; requests <= 2; requests += 1) {" },
  { row: "RA1.RA2", phrase: "for pairs of joins, up to 2 requests, 2 observations and 1 dropped observation", number: "2", file: "lib/fv-request-accounting.test.ts", source: "SEQUENCES.filter((sequence) => sequence.length <= 2)" },
  { row: "RA1.RA2", phrase: "for pairs of joins, up to 2 requests, 2 observations and 1 dropped observation", number: "1", file: "lib/fv-request-accounting.test.ts", source: "for (let droppedObservations = 0; droppedObservations <= 1; droppedObservations += 1) {" },
  { row: "RA3", phrase: "at most four", number: "four", file: "lib/fv-published-stacks.test.ts", source: "assert.equal(MAX_INSPECTION_GROUP_HOSTS, 4);" },
  { row: "RA3", phrase: "stacks of up to 6 frames over 9 symbols", number: "6", file: "lib/fv-published-stacks.test.ts", source: "return eachStack(SYMBOLS, 6, (frames) => {" },
  { row: "RA3", phrase: "stacks of up to 6 frames over 9 symbols", number: "9", file: "lib/fv-published-stacks.test.ts", source: "sequencesOf(9, 6)" },
  { row: "RA3", phrase: "for the host cache, up to 4 frames", number: "4", file: "lib/fv-published-stacks.test.ts", source: '""], 4, (frames) => {' },
  { row: "RA3-S", phrase: "first eight scripts", number: "eight", file: "lib/fv-published-stacks.test.ts", source: "assert.equal(MAX_INSPECTION_GROUP_SCRIPTS, 8);" },
  { row: "RA7", phrase: "up to 5 requests, 5 dropped observations and 5 observations", number: "5", file: "lib/fv-request-accounting.test.ts", source: "const MAX_REQUESTS = 5;" },
  { row: "RA7", phrase: "up to 5 requests, 5 dropped observations and 5 observations", number: "5", file: "lib/fv-request-accounting.test.ts", source: "const MAX_DROPPED = 5;" },
  { row: "RA7", phrase: "up to 5 requests, 5 dropped observations and 5 observations", number: "5", file: "lib/fv-request-accounting.test.ts", source: "const MAX_OBSERVATIONS = 5;" },
  { row: "RA7", phrase: "through the recorder, up to 3 requests and 3 observations", number: "3", file: "lib/fv-request-accounting.test.ts", source: "for (let requests = 0; requests <= 3; requests += 1) {" },
  { row: "RA7", phrase: "through the recorder, up to 3 requests and 3 observations", number: "3", file: "lib/fv-request-accounting.test.ts", source: "for (let length = 1; length <= 3; length += 1) {" },
  { row: "RA8", phrase: "orders of up to 5 events", number: "5", file: "lib/fv-initiator-claims.test.ts", source: "return eachOrder(5, (events) => {" },
  { row: "RA8", phrase: "at most one outcome", number: "one", file: "lib/fv-initiator-claims.test.ts", source: "attributed + ambiguous + refused <= 1" },
  { row: "CL6", phrase: "counts 1, 2 and 1000", number: "1", file: "lib/fv-warning-fragments.test.ts", source: "[form(1), form(2), form(LARGE_COUNT)]" },
  { row: "CL6", phrase: "counts 1, 2 and 1000", number: "2", file: "lib/fv-warning-fragments.test.ts", source: "[form(1), form(2), form(LARGE_COUNT)]" },
  { row: "CL6", phrase: "counts 1, 2 and 1000", number: "1000", file: "lib/fv-warning-fragments.test.ts", source: "const LARGE_COUNT = 1000;" },
  { row: "RA6", phrase: "at least one counted", number: "one", file: "lib/fv-request-accounting.test.ts", source: "with up to 2 requests in the window, at least one counted" },
  { row: "CL8a", phrase: "at it and one past it", number: "one", file: "lib/fv-worker-readout.test.ts", source: "[null, UNDER_THE_BOUND, BOUND, BOUND + 1]" },
  { row: "CL7", phrase: "lands in exactly one term", number: "one", file: "lib/fv-worker-readout.test.ts", source: "sumOf(readout.diagnostics, DEDICATED_WORKER_TERMS) === 1" },
  { row: "F4-TERM", phrase: "lands in exactly one term", number: "one", file: "lib/fv-worker-model.ts", source: '"every-worker-the-readout-heard-of-lands-in-one-term",' },
  { row: "F5-M", phrase: "caps of 2 control misses, 2 start retries and 1 configuration change", number: "2", file: "investigation/test/case-exploration-walk.ts", source: "controlMisses: 2" },
  { row: "F5-M", phrase: "caps of 2 control misses, 2 start retries and 1 configuration change", number: "2", file: "investigation/test/case-exploration-walk.ts", source: "startRetries: 2" },
  { row: "F5-M", phrase: "caps of 2 control misses, 2 start retries and 1 configuration change", number: "1", file: "investigation/test/case-exploration-walk.ts", source: "configurationChanges: 1" },
  { row: "F5-M", phrase: "at twice its pinned state count", number: "twice", file: "investigation/test/case-exploration.test.ts", source: 'assert.equal(MACHINE_STATE_BOUND, 2 * SIX_SLOT.states, "twice the six-slot plan\'s pinned count");' },
  { row: "F5-U", phrase: "Positions in UTF-16 columns", number: "16", file: "investigation/test/case-exploration.test.ts", source: 'test("UTF-16 columns:' },
  { row: "F5-U", phrase: "in UTF-16 code units", number: "16", file: "investigation/test/case-exploration.test.ts", source: 'test("UTF-16 columns:' }
];

/** Suite files and modules that must exist, so a discovery that matched nothing fails. */
const KNOWN_SUITE_FILES = [
  "lib/finite-check.test.ts",
  "lib/fv-producer-identity.test.ts",
  "lib/fv-coverage-loss.test.ts",
  "lib/fv-request-accounting.test.ts",
  "lib/fv-published-stacks.test.ts",
  "lib/fv-initiator-claims.test.ts",
  "lib/fv-warning-fragments.test.ts",
  "lib/fv-worker-readout.test.ts",
  "lib/fv-scroll-producer.test.ts",
  "lib/fv-worker-model.test.ts",
  "investigation/test/case-exploration.test.ts"
];
const KNOWN_MODULES = [
  "lib/finite-check.ts",
  "lib/fv-worker-model.ts",
  "lib/fv-worker-model-replay.ts",
  "investigation/test/case-exploration-walk.ts",
  "investigation/test/case-exploration-worker.ts",
  "investigation/test/case-exploration-plant-worker.ts"
];

/** The one owner of the CI history rule, which the register cites. */
const CI_HISTORY_TEST = { file: "lib/ci-performance-contract.test.ts", title: "every job that runs the unit suite checks out the whole history, unfiltered" } as const;

const RELEASE_SENTENCE = "The release gate `formal-verification` is proposed and not yet in code.";

const CLAIM_FIELDS = ["Property", "Code", "Domain", "Bounds", "Axioms", "Method", "Not claimed", "Tests", "Variants", "Members", "Commit"] as const;
const OPTIONAL_CLAIM_FIELDS = new Set(["Not claimed", "Members"]);
const OPEN_FIELDS = ["Finding", "Tests", "Cases", "Commit"] as const;
const OPTIONAL_OPEN_FIELDS = new Set(["Cases"]);
const LIST_FIELDS = new Set(["Tests", "Variants", "Members", "Cases"]);

// ---------------------------------------------------------------------------------------
// Reading the register.
// ---------------------------------------------------------------------------------------

type Citation = Readonly<{ file: string; title: string }>;
type Family = Readonly<{ file: string; prefix: string }>;

type Row = {
  id: string;
  kind: "claim" | "open";
  heading: string;
  fields: Map<string, { value: string; items: string[] }>;
  order: string[];
  /** Exact citations, from Tests and from Variants. */
  tests: Citation[];
  families: Family[];
  members: string[];
  cases: string[];
  commit: string;
  /** The heading and every field's own words, without citations or the commit. */
  prose: string;
};

type Register = { rows: Row[]; prose: string; methodList: string[]; wordList: string[][]; wordListLines: Set<number>; citationLines: Set<number> };

const FIELD_LINE = /^- \*\*([A-Za-z ]+):\*\*(?: (.*))?$/;
const ITEM_LINE = /^ {2}- (.*)$/;
const TEST_ITEM = /^`([^`\s]+)`: "([^"]*)"$/;
const TEMPLATE_ITEM = /^`([^`\s]+)`: `([^`]*)`$/;
const FAMILY_ITEM = /^`([^`\s]+)`: names beginning "([^"]*)"$/;
const NAME_ITEM = /^"([^"]*)"$/;

function sectionLines(lines: readonly string[], title: string): { text: string; line: number }[] {
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start < 0) return [];
  const out: { text: string; line: number }[] = [];
  for (let index = start + 1; index < lines.length && !lines[index].startsWith("## "); index += 1) out.push({ text: lines[index], line: index });
  return out;
}

function readRegister(doc: string): Register {
  const lines = doc.split("\n");
  const methodList: string[] = [];
  for (const { text } of sectionLines(lines, "Methods")) {
    const match = /^- `([^`]+)`: \S/.exec(text);
    if (match) methodList.push(match[1]);
  }
  const wordList: string[][] = [];
  const wordListLines = new Set<number>();
  for (const { text, line } of sectionLines(lines, "Wording")) {
    const match = /^- ((?:`[^`]+`, )*`[^`]+`): (\S.*)$/.exec(text);
    if (!match) continue;
    wordList.push([...match[1].matchAll(/`([^`]+)`/g)].map((found) => found[1]));
    wordListLines.add(line);
  }

  const rows: Row[] = [];
  const proseLines: string[] = [];
  const citationLines = new Set<number>();
  let section = "";
  let row: Row | null = null;
  let field: string | null = null;
  const finish = () => {
    if (row) rows.push(row);
    row = null;
    field = null;
  };
  lines.forEach((text, index) => {
    if (text.startsWith("## ")) {
      finish();
      section = text.slice(3);
      proseLines.push(text);
      return;
    }
    if (text.startsWith("### ")) {
      finish();
      const heading = text.slice(4);
      const cut = heading.indexOf(". ");
      const id = cut > 0 ? heading.slice(0, cut) : "";
      holds(P.ids, /^[A-Za-z][A-Za-z0-9.-]*$/.test(id), () => ({ heading }));
      holds(P.ids, section.startsWith("Claims") || section === "Open findings", () => ({ heading, section }));
      row = { id, kind: section === "Open findings" ? "open" : "claim", heading, fields: new Map(), order: [], tests: [], families: [], members: [], cases: [], commit: "", prose: heading };
      return;
    }
    if (!row) {
      proseLines.push(text);
      return;
    }
    const current: Row = row;
    if (text.trim() === "") return;
    const fieldMatch = FIELD_LINE.exec(text);
    if (fieldMatch) {
      const name = fieldMatch[1];
      field = name;
      // A repeated field leaves the order check below a name twice, which it refuses.
      if (!current.fields.has(name)) current.fields.set(name, { value: (fieldMatch[2] ?? "").trim(), items: [] });
      current.order.push(name);
      return;
    }
    const itemMatch = ITEM_LINE.exec(text);
    holds(P.shape, itemMatch !== null && field !== null && LIST_FIELDS.has(field), () => ({ row: current.id, line: index + 1, unread: text }));
    if (field !== null) current.fields.get(field)?.items.push(itemMatch?.[1] ?? text);
    citationLines.add(index);
  });
  finish();

  for (const parsed of rows) shapeRow(parsed);
  return { rows, prose: proseLines.join("\n"), methodList, wordList, wordListLines, citationLines };
}

function shapeRow(row: Row): void {
  const expected = row.kind === "claim" ? CLAIM_FIELDS : OPEN_FIELDS;
  const optional = row.kind === "claim" ? OPTIONAL_CLAIM_FIELDS : OPTIONAL_OPEN_FIELDS;
  const wanted = expected.filter((name) => !optional.has(name) || row.fields.has(name));
  holds(P.shape, JSON.stringify(row.order) === JSON.stringify(wanted), () => ({ row: row.id, fields: row.order, expected: wanted }));
  const prose: string[] = [row.heading];
  for (const [name, { value, items }] of row.fields) {
    if (name === "Variants") {
      const none = /^none: \S/.test(value);
      holds(P.shape, value === "" || none, () => ({ row: row.id, field: name, value }));
      holds(P.shape, none ? items.length === 0 : items.length > 0, () => ({ row: row.id, field: name, value, items: items.length }));
      if (none) prose.push(value);
    } else if (LIST_FIELDS.has(name)) {
      holds(P.shape, value === "", () => ({ row: row.id, field: name, value }));
      holds(P.shape, items.length > 0, () => ({ row: row.id, field: name, items: 0 }));
    } else {
      // A scalar field holds no items: readRegister refuses an item line under any field but a list.
      holds(P.shape, value !== "", () => ({ row: row.id, field: name, empty: true }));
      if (name !== "Commit") prose.push(value);
      continue;
    }
    for (const item of items) {
      if (name === "Cases" || name === "Members") {
        const match = NAME_ITEM.exec(item);
        holds(P.shape, match !== null, () => ({ row: row.id, field: name, item }));
        (name === "Cases" ? row.cases : row.members).push(match?.[1] ?? item);
        continue;
      }
      const family = name === "Variants" ? FAMILY_ITEM.exec(item) : null;
      if (family) {
        row.families.push({ file: family[1], prefix: family[2] });
        continue;
      }
      const match = FAMILY_ITEM.test(item) ? null : (TEST_ITEM.exec(item) ?? TEMPLATE_ITEM.exec(item));
      holds(P.shape, match !== null, () => ({ row: row.id, field: name, item }));
      row.tests.push({ file: match?.[1] ?? "", title: match?.[2] ?? item });
    }
  }
  row.commit = row.fields.get("Commit")?.value ?? "";
  row.prose = prose.join("\n");
}

// ---------------------------------------------------------------------------------------
// Reading the suites, as text.
// ---------------------------------------------------------------------------------------

/** A test as its suite spells it, and why it may not run as the source reads, or null. */
type SuiteTest = Readonly<{ title: string; template: boolean; flagged: string | null }>;
type SuiteFile = { tests: SuiteTest[]; titles: string[]; tables: Map<string, string[]> };
const parsed = new Map<string, SuiteFile>();

const MODIFIERS = new Set(["skip", "todo", "only", "expectFailure"]);
const LOOPS = new Set([ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement]);
/** Marks a title the guard could not read. The register is plain ASCII, so no row can cite one. */
const UNREADABLE = "\u0000";

/**
 * Every test-like call as the source spells its title: `test` and `it` and any name bound to
 * them by an import from node:test, an assignment or a destructuring, their modifier forms
 * by property or by string element access, the `test` and `it` of those names and of a
 * node:test namespace, and a test context's `test` (a subtest). A string's text, or a
 * template's raw text with its placeholders; any
 * other title is marked unreadable and can be cited by nothing. A test is flagged when it
 * carries a modifier by its method or its options; when an argument between its title and
 * its function is anything but a plain object literal with identifier or string keys; when
 * anything but the source file, blocks, loops and the callbacks of unflagged tests encloses
 * it, so an if, a try, a switch, a conditional, a function or a skipped parent leaves it to
 * run or not; when it has no
 * function literal to run; or when its body calls its context's skip or todo. For a
 * templated test inside `for (... of TABLE)`, the `name` of each entry of TABLE's array,
 * which is how Cases and Members are held.
 */
function readSuite(file: string, source: string): SuiteFile {
  const key = `${file}\n${source}`;
  const known = parsed.get(key);
  if (known) return known;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const testNames = new Set(["test", "it"]);
  const namespaces = new Set<string>();
  const arrays = new Map<string, ts.ArrayLiteralExpression>();
  const unwrap = (node: ts.Expression): ts.Expression => (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "node:test") continue;
    const clause = statement.importClause;
    if (clause?.name) testNames.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) if (["test", "it"].includes((element.propertyName ?? element.name).text)) testNames.add(element.name.text);
    }
  }
  // A name bound to a test name, or to the `test` or `it` of one or of a namespace, by assignment or by destructuring.
  const aliases: [string, string, string | null][] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(node.name) && ts.isArrayLiteralExpression(initializer)) arrays.set(node.name.text, initializer);
      if (ts.isIdentifier(node.name) && ts.isIdentifier(initializer)) aliases.push([node.name.text, initializer.text, null]);
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.expression)) aliases.push([node.name.text, initializer.expression.text, initializer.name.text]);
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(initializer)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (ts.isIdentifier(element.name) && ts.isIdentifier(property)) aliases.push([element.name.text, initializer.text, property.text]);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [alias, target, member] of aliases) {
      const bound = member === null ? testNames.has(target) : (testNames.has(target) || namespaces.has(target)) && ["test", "it"].includes(member);
      if (bound && !testNames.has(alias)) {
        testNames.add(alias);
        grew = true;
      }
    }
  }
  const tests: SuiteTest[] = [];
  const tables = new Map<string, string[]>();
  const titleOf = (first: ts.Expression | undefined): { title: string; template: boolean } => {
    if (first === undefined) return { title: `${UNREADABLE}no title`, template: false };
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return { title: first.text, template: false };
    if (ts.isTemplateExpression(first)) return { title: first.getText(sourceFile).slice(1, -1), template: true };
    return { title: `${UNREADABLE}unreadable title ${first.getText(sourceFile)}`, template: false };
  };
  /** `owner.member` or `owner["member"]`, as names. */
  const memberCall = (callee: ts.Expression): { owner: string; member: string } | null => {
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return { owner: callee.expression.text, member: callee.name.text };
    if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isStringLiteralLike(callee.argumentExpression)) return { owner: callee.expression.text, member: callee.argumentExpression.text };
    return null;
  };
  const callbacks = new Set<ts.Node>();
  /** The first node around a test that could keep it from running as the source reads, or null. */
  const placementOf = (call: ts.CallExpression): string | null => {
    let child: ts.Node = call;
    for (let at = call.parent; !ts.isSourceFile(at); child = at, at = at.parent) {
      const enclosing = ts.isBlock(at) || ts.isExpressionStatement(at) || LOOPS.has(at.kind) || callbacks.has(at) || (ts.isCallExpression(at) && callbacks.has(child));
      if (!enclosing && !(ts.isAwaitExpression(at) && at.expression === child)) return `under ${ts.SyntaxKind[at.kind]}`;
    }
    return null;
  };
  /** Why a test's arguments may keep it from running as the source reads, or null. */
  const argumentsOf = (call: ts.CallExpression, modifier: string | null): string | null => {
    const rest = call.arguments.slice(1);
    const last = rest[rest.length - 1];
    const body = last !== undefined && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) ? last : null;
    for (const options of body === null ? rest : rest.slice(0, -1)) {
      if (!ts.isObjectLiteralExpression(options)) return "options that are not an object literal";
      for (const property of options.properties) {
        if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return "an option that is not a plain key";
        if (MODIFIERS.has(property.name.text)) return property.name.text;
      }
    }
    if (modifier !== null) return modifier;
    if (body === null) return "no function literal to run";
    const context = body?.parameters[0]?.name;
    let skips: string | null = null;
    const look = (node: ts.Node): void => {
      const named = ts.isCallExpression(node) ? memberCall(node.expression) : null;
      if (context && ts.isIdentifier(context) && named?.owner === context.text && (named.member === "skip" || named.member === "todo")) skips ??= `calls ${named.owner}.${named.member}()`;
      ts.forEachChild(node, look);
    };
    if (body !== null) look(body.body);
    return skips;
  };
  const visit = (node: ts.Node, loopTable: string | null, contexts: ReadonlySet<string>): void => {
    if (ts.isForOfStatement(node) && ts.isIdentifier(node.expression)) {
      const table = node.expression.text;
      ts.forEachChild(node, (child) => visit(child, table, contexts));
      return;
    }
    let inner = contexts;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const named = memberCall(callee);
      let modifier: string | null = null;
      let isTest = ts.isIdentifier(callee) && testNames.has(callee.text);
      if (named !== null && testNames.has(named.owner) && MODIFIERS.has(named.member)) {
        isTest = true;
        modifier = named.member;
      }
      if (named !== null && (((namespaces.has(named.owner) || testNames.has(named.owner)) && ["test", "it"].includes(named.member)) || (contexts.has(named.owner) && named.member === "test"))) isTest = true;
      if (isTest) {
        const { title, template } = titleOf(node.arguments[0]);
        const flagged = argumentsOf(node, modifier) ?? placementOf(node);
        tests.push({ title, template, flagged });
        if (template && loopTable !== null && arrays.has(loopTable)) {
          const names: string[] = [];
          for (const element of (arrays.get(loopTable) as ts.ArrayLiteralExpression).elements) {
            if (!ts.isObjectLiteralExpression(element)) continue;
            for (const property of element.properties) {
              if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "name" && ts.isStringLiteral(property.initializer)) names.push(property.initializer.text);
            }
          }
          if (names.length > 0) tables.set(title, names);
        }
        const callback = node.arguments[node.arguments.length - 1];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          // Only a test that runs as the source reads places its subtests: a skipped parent's are skipped too.
          if (flagged === null) callbacks.add(callback);
          if (callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)) inner = new Set([...contexts, callback.parameters[0].name.text]);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, loopTable, inner));
  };
  visit(sourceFile, null, new Set());
  const suite = { tests, titles: tests.map((found) => found.title), tables };
  parsed.set(key, suite);
  return suite;
}

const isOpen = (title: string) => title.startsWith("open (");
const catches = (prefix: string) => /\bcatch(?:es)?\b/.test(prefix);

// ---------------------------------------------------------------------------------------
// Git, read-only and bounded.
// ---------------------------------------------------------------------------------------

type Git = {
  checkHistory(): void;
  isCommit(commit: string): "commit" | "missing" | string;
  isAncestor(commit: string): boolean;
  firstParent(commit: string): string | null;
  show(commit: string, file: string): string | null;
  subject(commit: string): string;
};

const REGENERATE =
  "the likely cause is a rebase of unpushed history, which gives every commit a new id: for each row, find in git log the commit whose subject matches the batch that landed its tests, and put that commit's full id in the row's Commit";

function realGit(root: string, env: NodeJS.ProcessEnv = process.env): Git {
  const cache = new Map<string, { value: unknown } | { error: Counterexample }>();
  let broken: string | null = null;
  const spawnEnv = { ...env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
  const run = (args: readonly string[]) => {
    holds(P.gitFailure, broken === null, () => ({ git: args.join(" "), earlierFailure: broken }));
    try {
      return spawnSyncBounded("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26, env: spawnEnv });
    } catch (error) {
      broken = error instanceof Error ? error.message : String(error);
      throw new Counterexample(P.gitFailure, { git: args.join(" "), failure: broken });
    }
  };
  // An answer is asked for once, and so is a refusal: a git that failed by its status is not run again for the same question.
  const remember = <T>(key: string, read: () => T): T => {
    if (!cache.has(key)) {
      try {
        cache.set(key, { value: read() });
      } catch (error) {
        if (!(error instanceof Counterexample)) throw error;
        cache.set(key, { error });
      }
    }
    const entry = cache.get(key) as { value: unknown } | { error: Counterexample };
    if ("error" in entry) throw entry.error;
    return entry.value as T;
  };
  const failed = (args: readonly string[], result: { status: number | null; stdout: string; stderr: string }) => () => ({ git: args.join(" "), status: result.status, stdout: result.stdout.trim().slice(0, 200), stderr: result.stderr.trim().slice(0, 400) });
  return {
    checkHistory: () =>
      remember("history", () => {
        const inside = ["rev-parse", "--is-inside-work-tree"];
        const tree = run(inside);
        holds(P.gitFailure, tree.status === 0 && tree.stdout.trim() === "true", failed(inside, tree));
        const shallowArgs = ["rev-parse", "--is-shallow-repository"];
        const shallow = run(shallowArgs);
        holds(P.gitFailure, shallow.status === 0 && ["true", "false"].includes(shallow.stdout.trim()), failed(shallowArgs, shallow));
        holds(P.history, shallow.stdout.trim() === "false", () => ({ shallow: true, fix: "fetch the whole history, as actions/checkout does with fetch-depth: 0" }));
        const extensionArgs = ["config", "--get", "extensions.partialclone"];
        const extension = run(extensionArgs);
        holds(P.gitFailure, extension.status === 0 || extension.status === 1, failed(extensionArgs, extension));
        const promisorArgs = ["config", "--get-regexp", "^remote\\..*\\.promisor$"];
        const promisor = run(promisorArgs);
        holds(P.gitFailure, promisor.status === 0 || promisor.status === 1, failed(promisorArgs, promisor));
        holds(P.history, extension.stdout.trim() === "" && promisor.stdout.trim() === "", () => ({ partialClone: true, extension: extension.stdout.trim(), promisor: promisor.stdout.trim(), fix: "clone without --filter" }));
        // A partial clone whose remote was removed keeps no promisor setting, but its packs still say so.
        const packArgs = ["rev-parse", "--git-path", "objects/pack"];
        const pack = run(packArgs);
        holds(P.gitFailure, pack.status === 0 && pack.stdout.trim() !== "", failed(packArgs, pack));
        const packs = path.resolve(root, pack.stdout.trim());
        const promisorPacks = existsSync(packs) ? readdirSync(packs).filter((name) => name.endsWith(".promisor")) : [];
        holds(P.history, promisorPacks.length === 0, () => ({ partialClone: true, promisorPacks: promisorPacks.length, fix: "clone without --filter" }));
        // Grafts rewrite a commit's parents for every read; replacement objects are read past, by GIT_NO_REPLACE_OBJECTS.
        const graftArgs = ["rev-parse", "--git-path", "info/grafts"];
        const graft = run(graftArgs);
        holds(P.gitFailure, graft.status === 0 && graft.stdout.trim() !== "", failed(graftArgs, graft));
        holds(P.history, !existsSync(path.resolve(root, graft.stdout.trim())), () => ({ grafts: graft.stdout.trim(), fix: "remove the grafts file, which rewrites the parents every read here relies on" }));
        return true;
      }),
    isCommit: (commit) =>
      remember(`type ${commit}`, () => {
        const result = run(["cat-file", "-t", commit]);
        if (result.status !== 0) return "missing";
        holds(P.gitFailure, result.stdout.trim() !== "", failed(["cat-file", "-t", commit], result));
        return result.stdout.trim();
      }),
    isAncestor: (commit) =>
      remember(`ancestor ${commit}`, () => {
        const args = ["merge-base", "--is-ancestor", commit, "HEAD"];
        const result = run(args);
        holds(P.gitFailure, result.status === 0 || result.status === 1, failed(args, result));
        return result.status === 0;
      }),
    firstParent: (commit) =>
      remember(`parent ${commit}`, () => {
        const args = ["rev-list", "--parents", "-n", "1", commit];
        const result = run(args);
        const ids = result.stdout.trim().split(/\s+/);
        holds(P.gitFailure, result.status === 0 && ids[0] === commit, failed(args, result));
        return ids[1] ?? null;
      }),
    show: (commit, file) =>
      remember(`show ${commit}:${file}`, () => {
        const listArgs = ["ls-tree", "--full-tree", commit, "--", file];
        const listed = run(listArgs);
        holds(P.gitFailure, listed.status === 0, failed(listArgs, listed));
        if (listed.stdout.trim() === "") return null;
        const readArgs = ["cat-file", "-p", `${commit}:${file}`];
        const read = run(readArgs);
        holds(P.object, read.status === 0, failed(readArgs, read));
        return read.stdout;
      }),
    subject: (commit) => {
      const result = run(["log", "-1", "--format=%s", commit]);
      return result.status === 0 ? result.stdout.trim() : "(no subject readable)";
    }
  };
}

// ---------------------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------------------

type Inputs = Readonly<{
  doc: string;
  /** A file's text in the working tree, or null when it does not exist. */
  read: (file: string) => string | null;
  suiteFiles: readonly string[];
  modules: readonly string[];
  anchors: readonly Anchor[];
  packageJson: string;
  readiness: string;
  releaseContract: string;
}>;

const flat = (text: string) => text.replace(/\s+/g, " ");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Found = { text: string; at: number };

/**
 * Every number a text states, with where it stands: any run of digits whatever follows it,
 * a decimal with a leading dot, and the spelled numbers above. A run of digits joined to a
 * letter before it (A1, v2, @12) is a name.
 */
function numbersAt(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(/(?<![\w@.])(?:\d+(?:[.,]\d+)*|\.\d+)\w*/g)) found.push({ text: /^(?:\d+(?:[.,]\d+)*|\.\d+)/.exec(match[0])?.[0] ?? match[0], at: match.index });
  for (const match of text.matchAll(new RegExp(`\\b(?:${Object.keys(SPELLED_NUMBERS).join("|")})\\b`, "gi"))) {
    const word = match[0].toLowerCase();
    if (word === "one") {
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      const after = text.slice(match.index + 3, match.index + 9);
      if (!/(?:up to|at most|at least|exactly|plus)\s+$/i.test(before) && !/^\s+(?:past|more)\b/i.test(after)) continue;
    }
    found.push({ text: word, at: match.index });
  }
  return found;
}

function holdsNumber(source: string, number: string): boolean {
  const value = SPELLED_NUMBERS[number];
  if (value !== undefined && new RegExp(`\\b${number}\\b`, "i").test(source)) return true;
  const digits = value === undefined ? number : String(value);
  return new RegExp(`(?<![\\w.])${escaped(digits)}(?!\\w)`).test(source);
}

/** Markdown read as words: links to their text, emphasis and code marks gone. */
function plainWords(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*~`]/g, "")
    .replace(/_+/g, " ");
}

/**
 * The text numbers are read in: Markdown read through, but an underscore inside a word, which
 * Markdown leaves as it is, stays, so `TWO_WORKER_WORLD` is a name. In a row, a quote of at
 * least three words is a suite's own text, which the quote check holds verbatim in a file the
 * row names, and is blanked; a shorter quote is read like any other words.
 */
function numberText(text: string, quotes: boolean): string {
  const unquoted = quotes ? text.replace(/"([^"\n]*)"/g, (quote, inner: string) => (inner.trim().split(/\s+/).length >= 3 ? " ".repeat(quote.length) : quote)) : text;
  return unquoted
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*~`]/g, "")
    .replace(/(?<!\w)_+|_+(?!\w)/g, " ");
}

function refusedIn(text: string): { word: string; at: string } | null {
  for (const group of REFUSED_WORDS) {
    for (const word of group) {
      const stem = word.endsWith("*");
      const found = new RegExp(`\\b${word.replace(/\*$/, "").split(" ").map(escaped).join("[\\s\\-/]+")}${stem ? "\\w*" : ""}\\b`, "i").exec(text);
      if (found) return { word, at: text.slice(Math.max(0, found.index - 60), found.index + 60) };
    }
  }
  return null;
}

function openQuantifierIn(text: string): string | null {
  for (const pattern of OPEN_DOMAINS) {
    const found = pattern.exec(text);
    if (found) return text.slice(Math.max(0, found.index - 60), found.index + 60);
  }
  for (const found of text.matchAll(INPUT_QUANTIFIER)) {
    if (!INPUT_SCOPE.test(text.slice(found.index + found[0].length))) return text.slice(Math.max(0, found.index - 60), found.index + 60);
  }
  return null;
}

/** Everything the register says that can be read without git. Returns the parsed register for the git checks. */
function checkText(inputs: Inputs): Register {
  holds(P.plainText, /^[\x09\x0a\x0d\x20-\x7e]*$/.test(inputs.doc), () => ({ at: /[^\x09\x0a\x0d\x20-\x7e]/.exec(inputs.doc)?.index }));
  holds(P.plainText, !/&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);/.test(inputs.doc), () => ({ entity: /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);/.exec(inputs.doc)?.[0] }));
  // A tag or a comment can split a word in two for a reader of the source and join it for a reader of the page.
  const outsideCode = inputs.doc.replace(/`[^`\n]*`/g, "");
  holds(P.plainText, !/<[A-Za-z!/?]/.test(outsideCode), () => ({ tag: /<[A-Za-z!/?].{0,40}/.exec(outsideCode)?.[0] }));

  const register = readRegister(inputs.doc);
  const { rows } = register;

  const ids = rows.map((row) => row.id);
  for (const id of ids) holds(P.ids, ids.indexOf(id) === ids.lastIndexOf(id), () => ({ duplicate: id }));

  holds(P.methodList, JSON.stringify(register.methodList) === JSON.stringify(METHODS), () => ({ register: register.methodList, guard: METHODS }));
  holds(P.wordList, JSON.stringify(register.wordList) === JSON.stringify(REFUSED_WORDS), () => ({ register: register.wordList, guard: REFUSED_WORDS }));

  for (const row of rows.filter((candidate) => candidate.kind === "claim")) {
    const terms = (row.fields.get("Method")?.value ?? "").split(", ");
    holds(P.method, terms.every((term) => (METHODS as readonly string[]).includes(term)), () => ({ row: row.id, method: terms }));
    holds(P.method, new Set(terms).size === terms.length, () => ({ row: row.id, repeated: terms }));
    holds(P.method, terms.some((term) => term !== "restatement"), () => ({ row: row.id, alone: terms }));
  }

  // Words, over the whole file as words, but the cited titles (held below under their own
  // property) and the code spans that name each refused word in its own list.
  const scanned = plainWords(
    inputs.doc
      .split("\n")
      .map((line, index) => (register.citationLines.has(index) ? "" : register.wordListLines.has(index) ? line.replace(/^- ((?:`[^`]+`, )*`[^`]+`):/, "- :") : line))
      .join("\n")
  );
  const refused = refusedIn(scanned);
  holds(P.refusedWord, refused === null, () => refused);
  const open = openQuantifierIn(scanned);
  holds(P.quantifier, open === null, () => ({ at: open }));

  // Numbers: none in prose, and each a row states inside one of its anchored phrases, read
  // through Markdown. A quote of at least three of a suite's own words, held verbatim below,
  // is the suite's, like a cited test name.
  for (const { text } of numbersAt(numberText(register.prose, false))) holds(P.number, false, () => ({ where: "outside any row", number: text }));
  for (const row of rows) {
    const words = numberText(row.prose, true);
    const covered = new Set<number>();
    for (const anchor of inputs.anchors.filter((candidate) => candidate.row === row.id)) {
      for (let at = words.indexOf(anchor.phrase); at >= 0; at = words.indexOf(anchor.phrase, at + 1)) {
        for (const found of numbersAt(anchor.phrase)) if (found.text === anchor.number) covered.add(at + found.at);
      }
    }
    for (const found of numbersAt(words)) holds(P.number, covered.has(found.at), () => ({ row: row.id, number: found.text, near: words.slice(Math.max(0, found.at - 30), found.at + 30) }));
  }
  for (const anchor of inputs.anchors) {
    holds(P.anchor, numbersAt(anchor.phrase).some((found) => found.text === anchor.number), () => ({ anchor, phraseLacksNumber: true }));
    const source = inputs.read(anchor.file);
    holds(P.anchor, source !== null && source.includes(anchor.source), () => ({ anchor, sourceNotInFile: true }));
    holds(P.anchor, holdsNumber(anchor.source, anchor.number), () => ({ anchor, sourceLacksNumber: true }));
    const row = rows.find((candidate) => candidate.id === anchor.row);
    const times = row === undefined ? 0 : numberText(row.prose, true).split(anchor.phrase).length - 1;
    holds(P.staleAnchor, times === 1, () => ({ anchor, times }));
  }

  // From the register to the suites.
  const suiteOf = (file: string): SuiteFile | null => {
    const source = inputs.read(file);
    return source === null ? null : readSuite(file, source);
  };
  const matchedBy = ({ file, prefix }: Family): SuiteTest[] => (suiteOf(file)?.tests ?? []).filter((found) => found.template && found.title.startsWith(prefix));
  for (const row of rows) {
    const cited = [...row.tests.map(({ file, title }) => ({ file, text: title })), ...row.families.flatMap((family) => [family.prefix, ...matchedBy(family).map((found) => found.title)].map((text) => ({ file: family.file, text })))];
    for (const { file, text } of [...cited, ...[...row.cases, ...row.members].map((text) => ({ file: "", text }))]) {
      const words = plainWords(text);
      const bad = refusedIn(words);
      holds(P.citedWording, bad === null && openQuantifierIn(words) === null, () => ({ row: row.id, file, text, refused: bad }));
    }
    for (const where of [...row.tests, ...row.families]) holds(P.citedFile, suiteOf(where.file) !== null, () => ({ row: row.id, file: where.file }));
    for (const { file, title } of row.tests) {
      const suite = suiteOf(file);
      holds(P.citedTest, suite?.titles.includes(title) === true, () => ({ row: row.id, file, title }));
      for (const found of (suite?.tests ?? []).filter((candidate) => candidate.title === title)) holds(P.skipped, found.flagged === null, () => ({ row: row.id, file, title, flagged: found.flagged }));
    }
    for (const family of row.families) {
      const { file, prefix } = family;
      holds(P.family, catches(prefix), () => ({ row: row.id, file, prefix, noCatch: true }));
      holds(P.family, matchedBy(family).length > 0, () => ({ row: row.id, file, prefix }));
      for (const found of matchedBy(family)) holds(P.skipped, found.flagged === null, () => ({ row: row.id, file, family: prefix, title: found.title, flagged: found.flagged }));
    }
    const memberTables = row.families.flatMap(({ file, prefix }) => [...(suiteOf(file)?.tables ?? [])].filter(([title]) => title.startsWith(prefix)).flatMap(([, names]) => names));
    for (const member of row.members) holds(P.members, memberTables.includes(member), () => ({ row: row.id, member }));
  }
  for (const file of new Set([...inputs.suiteFiles, ...rows.flatMap((row) => row.tests.map((cited) => cited.file))])) {
    const suite = suiteOf(file);
    if (suite === null) continue;
    const literal = suite.tests.filter((found) => !found.template).map((found) => found.title);
    for (const title of literal) holds(P.duplicate, literal.indexOf(title) === literal.lastIndexOf(title), () => ({ file, title }));
  }

  // Paths, code and quotes: a claim's Code names a file, and every name in code or quotes is in a file the row names.
  for (const row of rows) {
    const spans = [...row.prose.matchAll(/`([^`]+)`/g)].map((found) => found[1]);
    const quotes = [...row.prose.replace(/`[^`]*`/g, "").matchAll(/"([^"]+)"/g)].map((found) => found[1]);
    const paths = spans.filter((span) => span.includes("/"));
    for (const file of paths) holds(P.quoted, inputs.read(file) !== null, () => ({ row: row.id, missing: file }));
    if (row.kind === "claim") holds(P.quoted, [...(row.fields.get("Code")?.value ?? "").matchAll(/`([^`]*\/[^`]*)`/g)].length > 0, () => ({ row: row.id, code: "names no file" }));
    const texts = [...new Set([...paths, ...row.tests.map((cited) => cited.file), ...row.families.map((cited) => cited.file)])].map((file) => inputs.read(file) ?? "");
    for (const name of spans.filter((span) => !span.includes("/"))) {
      const pattern = new RegExp(`(?<![\\w$])${escaped(name)}(?![\\w$])`);
      holds(P.quoted, texts.some((text) => pattern.test(text)), () => ({ row: row.id, name }));
    }
    for (const quote of quotes) holds(P.quoted, texts.some((text) => text.includes(quote)), () => ({ row: row.id, quote }));
  }

  // Cases: each table-driven open test's names, on the one open row that cites it with them.
  // A row that cites the table-driven test twice lists its cases twice in the union, which the equality refuses.
  const tableOf = (file: string, title: string) => (isOpen(title) ? suiteOf(file)?.tables.get(title) : undefined);
  const casesByTest = new Map<string, string[]>();
  for (const row of rows) {
    const tabled = row.tests.filter(({ file, title }) => tableOf(file, title) !== undefined);
    holds(P.cases, (tabled.length > 0) === (row.cases.length > 0), () => ({ row: row.id, tabled, cases: row.cases.length }));
    // One table per row: Cases name no test, so two tables on one row could share them.
    holds(P.cases, tabled.length <= 1, () => ({ row: row.id, tabled }));
    for (const { file, title } of tabled) {
      const key = `${file}\n${title}`;
      casesByTest.set(key, [...(casesByTest.get(key) ?? []), ...row.cases]);
    }
  }
  for (const file of new Set(rows.flatMap((row) => row.tests.map((cited) => cited.file)))) {
    for (const [title, names] of suiteOf(file)?.tables ?? []) {
      if (!isOpen(title)) continue;
      const listed = casesByTest.get(`${file}\n${title}`) ?? [];
      holds(P.cases, JSON.stringify([...listed].sort()) === JSON.stringify([...names].sort()), () => ({ file, title, listed, table: names }));
    }
  }

  for (const row of rows) {
    for (const { file, title } of row.tests) holds(P.openPlace, isOpen(title) === (row.kind === "open"), () => ({ row: row.id, file, title }));
  }

  // From the suites to the register.
  for (const file of KNOWN_SUITE_FILES) holds(P.discovery, inputs.suiteFiles.includes(file), () => ({ undiscovered: file }));
  for (const file of KNOWN_MODULES) holds(P.discovery, inputs.modules.includes(file), () => ({ undiscovered: file }));
  const named = new Set([...inputs.doc.matchAll(/`([^`\s]+)`/g)].map((found) => found[1]));
  for (const file of [...inputs.suiteFiles, ...inputs.modules]) holds(P.suiteNamed, named.has(file), () => ({ file }));
  for (const file of inputs.suiteFiles) {
    const suite = suiteOf(file);
    holds(P.citedFile, suite !== null, () => ({ file }));
    for (const { title, template } of suite?.tests ?? []) {
      const exact = rows.filter((row) => row.tests.some((cited) => cited.file === file && cited.title === title));
      const family = template && rows.some((row) => row.families.some((cited) => cited.file === file && title.startsWith(cited.prefix)));
      holds(P.covered, exact.length > 0 || family, () => ({ file, title }));
      holds(P.openPlace, !isOpen(title) || exact.some((row) => row.kind === "open"), () => ({ file, title }));
    }
  }

  // Wiring: where each cited file runs, as the register says.
  const scripts = (JSON.parse(inputs.packageJson) as { scripts: Record<string, string> }).scripts;
  const unit = (scripts["test:unit"] ?? "").split(" && ");
  const lanes = unit.some((step) => step.startsWith("node scripts/unit-test-lanes.mjs ") && step.endsWith(" .unit-test-dist/lib/*.test.js"));
  // The lanes over .unit-test-dist/lib/*.test.js are held through the lib files below, which they must run.
  holds(P.wiring, unit.includes("npm run test:investigation"), () => ({ "test:unit": scripts["test:unit"], missing: "npm run test:investigation" }));
  holds(P.wiring, unit.includes("npm run test:investigation-exploration"), () => ({ "test:unit": scripts["test:unit"], missing: "npm run test:investigation-exploration" }));
  const investigationStages = `${scripts["test:investigation"] ?? ""} ${scripts["test:investigation-exploration"] ?? ""}`.split(/\s+/);
  for (const file of new Set([...rows.flatMap((row) => [...row.tests, ...row.families].map((cited) => cited.file)), ...inputs.suiteFiles])) {
    const runs = /^lib\/[A-Za-z0-9._-]+\.test\.ts$/.test(file)
      ? lanes
      : /^investigation\/test\/[A-Za-z0-9._-]+\.test\.ts$/.test(file) && investigationStages.includes(`.investigation-test-dist/${file.replace(/\.ts$/, ".js")}`);
    holds(P.wiring, runs, () => ({ file }));
  }

  const ciSuite = suiteOf(CI_HISTORY_TEST.file);
  holds(P.ciRule, flat(inputs.doc).includes(`\`${CI_HISTORY_TEST.file}\`, "${CI_HISTORY_TEST.title}"`), () => ({ missing: CI_HISTORY_TEST }));
  holds(P.ciRule, ciSuite !== null && ciSuite.titles.includes(CI_HISTORY_TEST.title), () => ({ absentFromItsFile: CI_HISTORY_TEST }));

  for (const [, script] of inputs.doc.matchAll(/`npm run ([^`\s]+)`/g)) holds(P.commands, Object.hasOwn(scripts, script), () => ({ script }));

  holds(P.release, flat(inputs.doc).includes(RELEASE_SENTENCE), () => ({ missing: RELEASE_SENTENCE }));
  holds(P.release, !inputs.readiness.includes('"requiredSuites"'), () => ({ file: "RELEASE_READINESS.json", names: "requiredSuites" }));
  holds(P.release, !inputs.readiness.includes("formal-verification"), () => ({ file: "RELEASE_READINESS.json", names: "formal-verification" }));
  holds(P.release, !inputs.releaseContract.includes("formal-verification"), () => ({ file: "scripts/v1-release-contract.mjs", names: "formal-verification" }));

  for (const row of rows) holds(P.commitShape, /^[0-9a-f]{40}$/.test(row.commit), () => ({ row: row.id, commit: row.commit }));
  return register;
}

/** Each row's commit, read from git: a commit, present, an ancestor, holding the row's tests and families, and its first parent holding none. */
function checkCommits(register: Register, git: Git): void {
  git.checkHistory();
  for (const row of register.rows) {
    const kind = git.isCommit(row.commit);
    holds(P.commitFound, kind !== "missing", () => ({ row: row.id, commit: row.commit, regenerate: REGENERATE }));
    holds(P.commitType, kind === "commit", () => ({ row: row.id, commit: row.commit, type: kind }));
    holds(P.ancestor, git.isAncestor(row.commit), () => ({ row: row.id, commit: row.commit, subject: git.subject(row.commit), regenerate: REGENERATE }));
    const parent = git.firstParent(row.commit);
    const testsAt = (commit: string | null, file: string): SuiteTest[] => {
      if (commit === null) return [];
      const source = git.show(commit, file);
      return source === null ? [] : readSuite(file, source).tests;
    };
    for (const { file, title } of row.tests) {
      holds(P.atCommit, testsAt(row.commit, file).some((found) => found.title === title), () => ({ row: row.id, commit: row.commit, file, title }));
      holds(P.firstLanded, !testsAt(parent, file).some((found) => found.title === title), () => ({ row: row.id, commit: row.commit, parent, file, title }));
    }
    for (const { file, prefix } of row.families) {
      holds(P.atCommit, testsAt(row.commit, file).some((found) => found.template && found.title.startsWith(prefix)), () => ({ row: row.id, commit: row.commit, file, family: prefix }));
      holds(P.firstLanded, !testsAt(parent, file).some((found) => found.template && found.title.startsWith(prefix)), () => ({ row: row.id, commit: row.commit, parent, file, family: prefix }));
    }
  }
}

function checkRegister(inputs: Inputs, git: Git | null): void {
  const register = checkText(inputs);
  if (git !== null) checkCommits(register, git);
}

// ---------------------------------------------------------------------------------------
// The real inputs.
// ---------------------------------------------------------------------------------------

const readText = (file: string): string | null => {
  const full = path.join(ROOT, file);
  return file !== "" && existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
};

function discover(directory: string, pattern: RegExp): string[] {
  return readdirSync(path.join(ROOT, directory))
    .filter((name) => pattern.test(name))
    .map((name) => `${directory}/${name}`)
    .sort();
}

const SUITE_FILES = [
  ...discover("lib", /^fv-[A-Za-z0-9._-]+\.test\.ts$/),
  "lib/finite-check.test.ts",
  ...discover("investigation/test", /^case-exploration[A-Za-z0-9._-]*\.test\.ts$/)
];
const MODULES = [
  ...discover("lib", /^fv-[A-Za-z0-9._-]+\.ts$/).filter((file) => !file.endsWith(".test.ts")),
  "lib/finite-check.ts",
  ...discover("investigation/test", /^case-exploration[A-Za-z0-9._-]*\.ts$/).filter((file) => !file.endsWith(".test.ts"))
];

const REAL: Inputs = {
  doc: readFileSync(path.join(ROOT, REGISTER), "utf8"),
  read: readText,
  suiteFiles: SUITE_FILES,
  modules: MODULES,
  anchors: ANCHORS,
  packageJson: readFileSync(path.join(ROOT, "package.json"), "utf8"),
  readiness: readFileSync(path.join(ROOT, "RELEASE_READINESS.json"), "utf8"),
  releaseContract: readFileSync(path.join(ROOT, "scripts/v1-release-contract.mjs"), "utf8")
};

const NO_REPOSITORY = existsSync(path.join(ROOT, ".git"))
  ? false
  : "this checkout has no .git, as the container image build's context leaves it out by design, so no commit can be read; CI's tests job runs this with the whole history";
let git: Git | null = null;
const theGit = (): Git => (git ??= realGit(ROOT));

/** The register with one exact edit, which must land exactly once. */
function planted(find: string, replace: string): string {
  const occurrences = REAL.doc.split(find).length - 1;
  if (occurrences !== 1) throw new Error(`A planted edit must land exactly once in ${REGISTER}, but "${find}" occurs ${occurrences} times.`);
  return REAL.doc.replace(find, () => replace);
}

/** A file read with one exact edit, which must land exactly once. */
function editedRead(file: string, find: string, replace: string): (candidate: string) => string | null {
  return (candidate) => {
    const text = readText(candidate);
    if (candidate !== file || text === null) return text;
    if (text.split(find).length - 1 !== 1) throw new Error(`An edit to ${file} must land exactly once, but "${find}" does not.`);
    return text.replace(find, () => replace);
  };
}

/** A git that answers as the real one, but for what a variant overrides. */
const gitWith = (overrides: Partial<Git>): Git => ({ ...theGit(), ...overrides });

/** Real-git variants judge their own path only on a whole history; on a shallow one they fail with the history message itself. */
function wholeHistory(): void {
  theGit().checkHistory();
}

// ---------------------------------------------------------------------------------------
// The positive controls.
// ---------------------------------------------------------------------------------------

test("the register holds to the suites, by text", () => {
  checkRegister(REAL, null);
});

test("every named commit is a commit in this checkout's history, holds its row's tests and families, and its first parent holds none", { skip: NO_REPOSITORY }, () => {
  checkRegister(REAL, theGit());
});

// ---------------------------------------------------------------------------------------
// Each refusal, caught first by its own property.
// ---------------------------------------------------------------------------------------

const F1 = "af6c9568efe3f9cbf2503a8d9b3086fd8b240167";
const EB2_BOUNDS = "- **Bounds:** none beyond those tables.\n";
const EB2_PROPERTY_END = "; every target epoch of the obligation contracts is named by a row.";
const EB2_TESTS = "  - `lib/fv-producer-identity.test.ts`: \"EB2: every target epoch of the obligation contracts is named by a row\"\n";
const EB3_FAMILY = '  - `lib/fv-producer-identity.test.ts`: names beginning "EB3 catches a variant"\n- **Commit:** af6c9568efe3f9cbf2503a8d9b3086fd8b240167';
const PROSE_SPOT = "## What this register does not claim\n";
const PINS_CASE = '  - "the same, frozen as reaching, with only its attach heard at the freeze"\n';
const RA4_LAST = '  - `lib/fv-scroll-producer.test.ts`: "RA4: each ending validates and keeps what it earned"\n';
const F4_HAND_CODE = "- **Code:** `sharedWorkerAttacherThread` in `lib/shared-worker-attacher.ts`.";
const RA7P_VARIANTS = "- **Variants:** none: the test pins where the recorders part, which RA7's bounded check leaves to arrival order.\n";
const EB2_METHOD = "- **Axioms:** none\n- **Method:** exhaustive\n- **Tests:**\n  - `lib/fv-producer-identity.test.ts`: \"EB2:";

const PI = "lib/fv-producer-identity.test.ts";
const IC = "lib/fv-initiator-claims.test.ts";
const IMPORT_TEST = 'import { test } from "node:test";';
const EB2_CALL = 'test("EB2: every target epoch of the obligation contracts is named by a row", () => {';
const EB3_CALL = "test(`EB3 catches a variant: ${name}`, ";
const RA8_TESTS_LAST = '  - `lib/fv-initiator-claims.test.ts`: "RA8: nothing past a table\'s bound is claimed, and the loss is counted"\n';
const PLANT = 'test("RA8: a planted property", () => {})';
const added = (words: string): Partial<Inputs> => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} ${words}`) });
const bounded = (words: string): Partial<Inputs> => ({ doc: planted(EB2_BOUNDS, `- **Bounds:** none beyond those tables, ${words}.\n`) });
const withEB2 = (edit: (call: string) => string): Partial<Inputs> => ({ read: editedRead(PI, EB2_CALL, edit(EB2_CALL)) });
const plantedIn = (file: string, code: string): Partial<Inputs> => ({ read: editedRead(file, IMPORT_TEST, `${IMPORT_TEST}\n${code}\n`) });
/** Code planted in RA8's suite, with RA8 citing the planted property by name. */
const citedPlant = (code: string, cited = "RA8: a planted property"): Partial<Inputs> => ({
  ...plantedIn(IC, code),
  doc: planted(RA8_TESTS_LAST, `${RA8_TESTS_LAST}  - \`lib/fv-initiator-claims.test.ts\`: "${cited}"\n`)
});
const PINS_LOOP = "for (const { name, kind, rests, closedBy, assumptions, labels, term, broken } of PINS) {";
const F43_ENVIRONMENT = '  - `lib/fv-worker-model.test.ts`: "open (F4, environment axiom): with the page\'s channel lost at the freeze, a worker that ran, with its attach on the port, lands in no term"\n';

const TEXT_VARIANTS: ReadonlyArray<readonly [string, string, () => Partial<Inputs>]> = [
  ["a row missing its Bounds", P.shape, () => ({ doc: planted(EB2_BOUNDS, "") })],
  ["a row with a field written twice", P.shape, () => ({ doc: planted(EB2_BOUNDS, `${EB2_BOUNDS}${EB2_BOUNDS}`) })],
  ["a line before a row's first field", P.shape, () => ({ doc: planted("### EB2. A row's obligations are the contract its registry is held to\n\n", "### EB2. A row's obligations are the contract its registry is held to\n\n  - a stray item\n") })],
  ["a row with a line its grammar does not read", P.shape, () => ({ doc: planted(EB2_BOUNDS, `${EB2_BOUNDS}Some loose words.\n`) })],
  ["a citation written without its list marker", P.shape, () => ({ doc: planted(EB2_TESTS, `${EB2_TESTS}${EB2_TESTS.slice(4)}`) })],
  ["a scalar field holding an item", P.shape, () => ({ doc: planted(EB2_BOUNDS, `${EB2_BOUNDS}${EB2_TESTS}`) })],
  ["a Variants field with a value beside its items", P.shape, () => ({ doc: planted(`- **Variants:**\n${EB3_FAMILY}`, `- **Variants:** see below\n${EB3_FAMILY}`) })],
  ["Variants none with items beside it", P.shape, () => ({ doc: planted(RA7P_VARIANTS, `${RA7P_VARIANTS}  - \`lib/call-stack-publisher.test.ts\`: "Inspect and the check part when a URL is observed more often than it was requested, with differing categories"\n`) })],
  ["an empty Members list", P.shape, () => ({ doc: planted('- **Members:**\n  - "a running worker\'s last word at the call is its state, with no barrier"\n', "- **Members:**\n") })],
  ["a row with an empty Axioms", P.shape, () => ({ doc: planted("- **Bounds:** none beyond those tables.\n- **Axioms:** none\n", "- **Bounds:** none beyond those tables.\n- **Axioms:**\n") })],
  ["a Tests field with a value of its own", P.shape, () => ({ doc: planted(EB2_METHOD, EB2_METHOD.replace("- **Tests:**", "- **Tests:** see below")) })],
  ["Variants none with no reason", P.shape, () => ({ doc: planted("- **Variants:** none: the test pins where the recorders part", "- **Variants:** none") })],
  ["a malformed Tests item", P.shape, () => ({ doc: planted(EB2_TESTS, "  - lib/fv-producer-identity.test.ts EB2: every target epoch of the obligation contracts is named by a row\n") })],
  ["a malformed Variants item", P.shape, () => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace('names beginning "EB3 catches a variant"', "names beginning EB3 catches a variant")) })],
  ["a malformed Cases item", P.shape, () => ({ doc: planted(PINS_CASE, "  - the same, frozen as reaching, with only its attach heard at the freeze\n") })],
  ["a malformed Members item", P.shape, () => ({ doc: planted('  - "a running worker\'s last word at the call is its state, with no barrier"\n', "  - a running worker's last word at the call is its state, with no barrier\n") })],
  ["a duplicated row id", P.ids, () => ({ doc: planted("### EB2. ", "### EB1. ") })],
  ["an id with a space in it", P.ids, () => ({ doc: planted("### EB2. ", "### E B2. ") })],
  ["a row outside any claims section", P.ids, () => ({ doc: planted("## Claims from F2: published stacks", "## More from F2: published stacks") })],
  ["a method list that differs from the guard's", P.methodList, () => ({ doc: planted("- `sampled`: written-out cases", "- `spot-checked`: written-out cases") })],
  ["a list of refused words with a group gone", P.wordList, () => ({ doc: planted(/^- `ensur\*`.*\n/m.exec(REAL.doc)?.[0] ?? "(absent)", "") })],
  ["a method outside the closed list", P.method, () => ({ doc: planted(EB2_METHOD, EB2_METHOD.replace("exhaustive", "model checked")) })],
  ["a method named twice", P.method, () => ({ doc: planted(EB2_METHOD, EB2_METHOD.replace("exhaustive", "exhaustive, exhaustive")) })],
  ["restatement standing alone", P.method, () => ({ doc: planted(EB2_METHOD, EB2_METHOD.replace("exhaustive", "restatement")) })],
  ["a character outside ASCII", P.plainText, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds here.`) })],
  ["an HTML entity", P.plainText, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} Rows &amp; registries.`) })],
  ["an HTML tag inside a word", P.plainText, () => added("It is pro<b></b>ved.")],
  ["an HTML comment inside a word", P.plainText, () => added("It is pro<!-- -->ved.")],
  ["a lone closing tag inside a word", P.plainText, () => added("It is pro</b>ved.")],
  ["a processing instruction inside a word", P.plainText, () => added("It is pro<?x?>ved.")],
  ["a tag between backticks on different lines", P.plainText, () => ({ doc: planted(PROSE_SPOT, `${PROSE_SPOT}\nA backtick \` opens here.\nIt is pro<b></b>ved, and a backtick \` closes here.\n`) })],
  ["proved, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} This is proved.`) })],
  ["Proved, capitalized", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} Proved for every row.`) })],
  ["a refused word split by emphasis", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It is **pro**ved.`) })],
  ["a refused word inside a link", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} See [the proof](https://example.invalid/).`) })],
  ["a guarantee, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It is guaranteed.`) })],
  ["formally verified, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} The rows are formally verified.`) })],
  ["formally-verified, hyphenated", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} The rows are formally-verified.`) })],
  ["a theorem, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It is a theorem.`) })],
  ["verified as a verdict, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It is verified.`) })],
  ["sound as a verdict, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} The check is sound.`) })],
  ["a refused word joined by an underscore", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It is formally_verified.`) })],
  ["correct as a verdict, in a row", P.refusedWord, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} The table is correct.`) })],
  ["ensures, in prose", P.refusedWord, () => ({ doc: planted(PROSE_SPOT, `${PROSE_SPOT}\nThe guard ensures every row.\n`) })],
  ["a form of ensure", P.refusedWord, () => added("The table is ensuring it.")],
  ["a form of assure", P.refusedWord, () => added("It gives assurance.")],
  ["a form of guarantee", P.refusedWord, () => added("The table is guaranteeing it.")],
  ["a form of sound", P.refusedWord, () => added("It holds soundly.")],
  ["formally verifying", P.refusedWord, () => added("The suite is formally verifying it.")],
  ["a refused word in a justification of the list itself", P.refusedWord, () => ({ doc: planted("which no check here walks.", "which no proof here walks.") })],
  ["a quantifier over sites", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds on any site.`) })],
  ["every single site", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds for every single site.`) })],
  ["a quantifier over URLs", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds for all URLs.`) })],
  ["a named browser, quantified", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds on every Chromium.`) })],
  ["real-world pages", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds on real-world pages.`) })],
  ["any given site", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds on any given site.`) })],
  ["every page", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds on every page.`) })],
  ["a scope with no domain", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds universally.`) })],
  ["each input, with no domain", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds for each input.`) })],
  ["all of the inputs, with no domain", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds for all of the inputs.`) })],
  ["a quantifier over inputs with no domain", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds for all inputs.`) })],
  ["a quantifier over inputs in an open domain", P.quantifier, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} It holds for every input in production.`) })],
  ["each site", P.quantifier, () => added("It holds on each site.")],
  ["every web site", P.quantifier, () => added("It holds on every web site.")],
  ["every live site", P.quantifier, () => added("It holds on every live site.")],
  ["every origin", P.quantifier, () => added("It holds for every origin.")],
  ["the entire web", P.quantifier, () => added("It holds across the entire web.")],
  ["every input in a domain it does not name", P.quantifier, () => added("It holds for every input in a domain.")],
  ["every input within the bounds of something else", P.quantifier, () => added("It holds for every input within the bounds of production.")],
  ["every input in the domain of something else", P.quantifier, () => added("It holds for every input in the domain of the internet.")],
  ["a member with a refused word", P.citedWording, () => ({ doc: planted('  - "a worker gone with no pause, past the bound, is read as ended at once"\n', '  - "a worker gone with no pause, past the bound, is proved ended at once"\n') })],
  [
    "a cited title with a refused word",
    P.citedWording,
    () => ({ doc: planted(EB2_TESTS, EB2_TESTS.replace("is named by a row", "is proved by a row")), read: editedRead("lib/fv-producer-identity.test.ts", 'test("EB2: every target epoch of the obligation contracts is named by a row"', 'test("EB2: every target epoch of the obligation contracts is proved by a row"') })
  ],
  ["a refused word in a family's prefix", P.citedWording, () => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace("EB3 catches a variant", "EB3 catches a proved variant")), read: editedRead(PI, EB3_CALL, "test(`EB3 catches a proved variant: ${name}`, ") })],
  [
    "a cited title with an open quantifier",
    P.citedWording,
    () => ({ doc: planted(EB2_TESTS, EB2_TESTS.replace("is named by a row", "is named by a row on any site")), read: editedRead(PI, EB2_CALL, EB2_CALL.replace("is named by a row", "is named by a row on any site")) })
  ],
  ["a refused word in a title its family matches", P.citedWording, () => ({ read: editedRead(PI, EB3_CALL, "test(`EB3 catches a variant, proved: ${name}`, ") })],
  ["a number with no anchor", P.number, () => ({ doc: planted(EB2_BOUNDS, "- **Bounds:** none beyond those tables, at most 7 rows.\n") })],
  ["a spelled number with no anchor", P.number, () => ({ doc: planted(EB2_BOUNDS, "- **Bounds:** none beyond those tables, at most seventeen rows.\n") })],
  ["a number in exponent form", P.number, () => ({ doc: planted(EB2_BOUNDS, "- **Bounds:** none beyond 1e3 tables.\n") })],
  ["a number with a unit", P.number, () => ({ doc: planted(EB2_BOUNDS, "- **Bounds:** none beyond those tables, within 60s.\n") })],
  ["a number after a hyphen", P.number, () => ({ doc: planted(EB2_BOUNDS, "- **Bounds:** none beyond those tables, rows-7.\n") })],
  ["one, stating a bound", P.number, () => ({ doc: planted(EB2_BOUNDS, "- **Bounds:** none beyond those tables, and up to one more.\n") })],
  ["a number in prose", P.number, () => ({ doc: planted(PROSE_SPOT, `${PROSE_SPOT}\nIt has 3 parts.\n`) })],
  ["a number in underscore emphasis", P.number, () => bounded("at most _7_ rows")],
  ["one in emphasis, stating a bound", P.number, () => bounded("and up to *one* more")],
  ["a number with any letters after it", P.number, () => bounded("at most 10k rows")],
  ["a decimal with a leading dot", P.number, () => bounded("a share of .5")],
  ["a spelled ordinal", P.number, () => bounded("up to the third row")],
  ["a spelled multiplier", P.number, () => bounded("each read at most twice")],
  ["at least one, stating a bound", P.number, () => bounded("with at least one row")],
  ["exactly one, stating a bound", P.number, () => bounded("in exactly one table")],
  ["a number in a quote too short to be a suite's words", P.number, () => bounded('at most "7" rows')],
  ["a number in a quote of two words", P.number, () => bounded('at most "7 rows"')],
  ["one before more, stating a bound", P.number, () => bounded("and one more row")],
  [
    "anchored clauses swapped between bounds",
    P.number,
    () => ({ doc: planted("up to 5 page requests, 5 observations and 5 dropped observations; for pairs of joins, up to 2 requests, 2 observations and 1 dropped observation each.", "up to 2 requests, 2 observations and 1 dropped observation; for pairs of joins, up to 5 page requests, 5 observations and 5 dropped observations each.") })
  ],
  ["anchored clauses swapped between bounds, through the recorder", P.number, () => ({ doc: planted("up to 5 requests, 5 dropped observations and 5 observations; through the recorder, up to 3 requests and 3 observations.", "up to 3 requests and 3 observations; through the recorder, up to 5 requests, 5 dropped observations and 5 observations.") })],
  ["swapped numbers in anchored phrases", P.number, () => ({ doc: planted("stacks of up to 6 frames over 9 symbols", "stacks of up to 9 frames over 6 symbols") })],
  ["an anchor whose phrase lacks its number", P.anchor, () => ({ anchors: [...ANCHORS, { row: "RA8", phrase: "orders of", number: "5", file: "lib/fv-initiator-claims.test.ts", source: "return eachOrder(5, (events) => {" }] })],
  ["an anchor whose source moved", P.anchor, () => ({ read: editedRead("lib/fv-request-accounting.test.ts", "const MAX_REQUESTS = 5;", "const MAX_REQUESTS = 6;") })],
  ["an anchor whose source lacks its number", P.anchor, () => ({ anchors: [...ANCHORS, { row: "RA8", phrase: "up to 5 events", number: "5", file: "lib/fv-initiator-claims.test.ts", source: "return eachOrder(" }] })],
  ["a spelled anchor matched only inside another word", P.anchor, () => ({ anchors: [...ANCHORS, { row: "RA3", phrase: "at most four", number: "four", file: "lib/fv-published-stacks.test.ts", source: "fourth" }], read: editedRead("lib/fv-published-stacks.test.ts", "import assert", "// fourth\nimport assert") })],
  ["an anchored phrase stated twice", P.staleAnchor, () => ({ doc: planted("- **Bounds:** orders of up to 5 events.", "- **Bounds:** orders of up to 5 events, and orders of up to 5 events again.") })],
  ["a row that stopped stating its anchored phrase", P.staleAnchor, () => ({ doc: planted("orders of up to 5 events", "orders of events up to the suite's bound") })],
  ["a cited file that does not exist", P.citedFile, () => ({ doc: planted("  - `lib/fv-producer-identity.test.ts`: \"EB3: status-v1", "  - `lib/fv-producer-identities.test.ts`: \"EB3: status-v1") })],
  ["a discovered suite file that cannot be read", P.citedFile, () => ({ suiteFiles: [...REAL.suiteFiles, "lib/fv-ghost.test.ts"], doc: planted("## Files\n", "## Files\n\nThe ghost is `lib/fv-ghost.test.ts`.\n") })],
  ["an unreadable title cited by the guard's stand-in for it", P.citedTest, () => citedPlant('const PLANTED = "RA8: a planted property";\ntest(PLANTED, () => {});', "unreadable title PLANTED")],
  ["a cited test whose name drifted", P.citedTest, () => ({ doc: planted(EB2_TESTS, EB2_TESTS.replace("is named by a row", "is named by every row")) })],
  ["a cited test marked skip", P.skipped, () => ({ read: editedRead("lib/fv-producer-identity.test.ts", 'test("EB2: every target epoch of the obligation contracts is named by a row", () => {', 'test("EB2: every target epoch of the obligation contracts is named by a row", { skip: true }, () => {') })],
  ["a cited test run as test.only", P.skipped, () => ({ read: editedRead("lib/fv-producer-identity.test.ts", 'test("EB2: every target epoch of the obligation contracts is named by a row", () => {', 'test.only("EB2: every target epoch of the obligation contracts is named by a row", () => {') })],
  [
    "a cited test called only from inside a function",
    P.skipped,
    () => ({ read: editedRead("lib/fv-producer-identity.test.ts", 'test("EB2: every target epoch of the obligation contracts is named by a row", () => {', 'function never(): void {}\nnever();\nfunction notCalled(): void { test("EB2: every target epoch of the obligation contracts is named by a row", () => {}); }\nvoid notCalled;\nnoop("EB2: gone", () => {') })
  ],
  ["a family's tests written as test.skip", P.skipped, () => ({ read: editedRead(PI, EB3_CALL, "test.skip(`EB3 catches a variant: ${name}`, ") })],
  ["a family's tests given a todo option", P.skipped, () => ({ read: editedRead(PI, EB3_CALL, `${EB3_CALL}{ todo: true }, `) })],
  ["a cited test expected to fail", P.skipped, () => withEB2((call) => call.replace("() => {", "{ expectFailure: true }, () => {"))],
  ["a cited test run as an alias's only", P.skipped, () => withEB2((call) => `const check = test;\n${call.replace('test("EB2', 'check.only("EB2')}`)],
  ["a cited test given a shorthand skip option", P.skipped, () => withEB2((call) => `const skip = true;\n${call.replace("() => {", "{ skip }, () => {")}`)],
  ["a cited subtest of a skipped parent", P.skipped, () => citedPlant('test.skip("RA8: a planted parent", async (t) => {\n  await t.test("RA8: a planted property", () => {});\n});')],
  ["a cited test whose options are a name", P.skipped, () => withEB2((call) => `const OPTIONS = {};\n${call.replace("() => {", "OPTIONS, () => {")}`)],
  ["a cited test whose options spread another object", P.skipped, () => withEB2((call) => call.replace("() => {", "{ ...{} }, () => {"))],
  ["a cited test whose option key is computed", P.skipped, () => withEB2((call) => call.replace("() => {", '{ ["plan"]: 1 }, () => {'))],
  ["a cited test under an if", P.skipped, () => citedPlant(`if (process.env.FV_PLANTED) ${PLANT};`)],
  ["a cited test inside a try", P.skipped, () => citedPlant(`try {\n  ${PLANT};\n} catch {}`)],
  ["a cited test behind a conditional", P.skipped, () => citedPlant(`process.env.FV_PLANTED ? ${PLANT} : null;`)],
  ["a cited test inside a class method", P.skipped, () => citedPlant(`class Planted {\n  run(): void {\n    ${PLANT};\n  }\n}\nvoid Planted;`)],
  ["a cited test with no function to run", P.skipped, () => citedPlant('test("RA8: a planted property");')],
  ["a cited test that calls its context's skip", P.skipped, () => citedPlant('test("RA8: a planted property", (t) => {\n  t.skip();\n});')],
  ["a cited test that calls its context's todo", P.skipped, () => citedPlant('test("RA8: a planted property", (t) => {\n  t.todo();\n});')],
  ["a literal title written twice in a suite file", P.duplicate, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'test("RA8: nothing past a table\'s bound is claimed, and the loss is counted", () => {', 'test("RA8: nothing past a table\'s bound is claimed, and the loss is counted", () => {});\ntest("RA8: nothing past a table\'s bound is claimed, and the loss is counted", () => {') })],
  ["a variant family that matches nothing", P.family, () => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace("EB3 catches a variant", "EB3 catches a varient")) })],
  ["a variant family that catches nothing", P.family, () => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace('"EB3 catches a variant"', '"EB3"')) })],
  [
    "a variant family covering only a plain title",
    P.family,
    () => ({ doc: planted('  - `lib/fv-producer-identity.test.ts`: "EB2 catches a variant: every registry reads as a target epoch"\n', '  - `lib/fv-producer-identity.test.ts`: names beginning "EB2 catches a variant: every registry"\n') })
  ],
  ["a family whose prefix is found only inside its titles", P.family, () => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace('"EB3 catches a variant"', '"catches a variant"')) })],
  ["a member from another table in its family's file", P.members, () => ({ doc: planted('  - "a running worker\'s last word at the call is its state, with no barrier"\n', '  - "the same, frozen as reaching, with only its attach heard at the freeze"\n') })],
  ["a member its family's table does not hold", P.members, () => ({ doc: planted('  - "a running worker\'s last word at the call is its state, with no barrier"\n', '  - "a running worker\'s first word at the call is its state"\n') })],
  ["a Code path that does not exist", P.quoted, () => ({ doc: planted("the attribution refusal rule in `lib/request-initiator.ts`.", "the attribution refusal rule in `lib/request-initiators.ts`.") })],
  ["a Code field that names no file", P.quoted, () => ({ doc: planted(F4_HAND_CODE, "- **Code:** the thread's program.") })],
  ["a name in code that its files do not hold", P.quoted, () => ({ doc: planted("with `detectorObligationContractVersion` and", "with `detectorObligationContractVersions` and") })],
  ["a quote its files do not hold", P.quoted, () => ({ doc: planted(EB2_PROPERTY_END, `${EB2_PROPERTY_END} The suite says "every row is held".`) })],
  ["Cases on a row whose test is not table-driven", P.cases, () => ({ doc: planted("with another worker's drain open\"\n", "with another worker's drain open\"\n- **Cases:**\n  - \"an ordinary hold\"\n") })],
  [
    "a row citing the table-driven open test twice",
    P.cases,
    () => ({ doc: planted("- **Cases:**\n  - \"held at the freeze and at the bound, with its late on the port", "  - `lib/fv-worker-model.test.ts`: `open (F4, ${kind}): ${name}, which rests on ${rests}`\n- **Cases:**\n  - \"held at the freeze and at the bound, with its late on the port") })
  ],
  [
    "a second table-driven open test on one row, over that row's cases",
    P.cases,
    () => ({
      read: editedRead(
        "lib/fv-worker-model.test.ts",
        PINS_LOOP,
        `const TWIN = [{ name: "a worker that ran, whose attach is on the port when the frame tree answers, lands in no term" }, { name: "a worker whose attach went down with the connection, which ran when Chromium let it, lands in no term" }];\nfor (const { name } of TWIN) test(\`open (F4, twin): \${name}\`, () => {});\n${PINS_LOOP}`
      ),
      doc: planted(F43_ENVIRONMENT, `${F43_ENVIRONMENT}  - \`lib/fv-worker-model.test.ts\`: \`open (F4, twin): \${name}\`\n`)
    })
  ],
  ["a table-driven open test with a case gone", P.cases, () => ({ doc: planted(PINS_CASE, "") })],
  ["a table-driven open test with a case listed twice", P.cases, () => ({ doc: planted(PINS_CASE, `${PINS_CASE}${PINS_CASE}`) })],
  ["an open test cited as a claim", P.openPlace, () => ({ doc: planted(RA4_LAST, `${RA4_LAST}  - \`lib/fv-scroll-producer.test.ts\`: "open (RA4): one frame on a host with a leading dot costs the whole check its stacks"\n`) })],
  [
    "an open test covered only by a family",
    P.openPlace,
    () => ({
      read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test } from "node:test";\nfor (const name of ["a"]) test(`open (RA8): catches ${name}`, () => {});'),
      doc: planted('  - `lib/fv-initiator-claims.test.ts`: names beginning "RA8 catches a variant"\n', '  - `lib/fv-initiator-claims.test.ts`: names beginning "RA8 catches a variant"\n  - `lib/fv-initiator-claims.test.ts`: names beginning "open (RA8): catches"\n')
    })
  ],
  ["a known suite file the discovery missed", P.discovery, () => ({ suiteFiles: REAL.suiteFiles.filter((file) => file !== "lib/fv-worker-model.test.ts") })],
  ["a known module the discovery missed", P.discovery, () => ({ modules: REAL.modules.filter((file) => file !== "lib/fv-worker-model-replay.ts") })],
  ["a suite file the register does not name", P.suiteNamed, () => ({ suiteFiles: [...REAL.suiteFiles, "lib/fv-planted.test.ts"], read: (file) => (file === "lib/fv-planted.test.ts" ? 'test("planted", () => {});\n' : readText(file)) })],
  ["a module the register does not name", P.suiteNamed, () => ({ modules: [...REAL.modules, "lib/fv-planted.ts"] })],
  ["a test in a suite file no row cites", P.covered, () => ({ doc: planted('  - `lib/fv-producer-identity.test.ts`: "EB1: no PageGraph row accepts a misshapen methodology"\n', "") })],
  ["a plainly named variant test left to a family", P.covered, () => ({ doc: planted('  - `lib/fv-producer-identity.test.ts`: "EB1 catches a variant: a refetch retires the row"\n', "") })],
  ["a new test planted in a suite file", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test } from "node:test";\ntest("RA8: a planted property no row cites", () => {});') })],
  ["a test called through it", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { it, test } from "node:test";\nit("RA8: a planted property no row cites", () => {});') })],
  ["a test called through a renamed import", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test, test as check } from "node:test";\ncheck("RA8: a planted property no row cites", () => {});') })],
  ["a test called through a default import", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test } from "node:test";\nimport check from "node:test";\ncheck("RA8: a planted property no row cites", () => {});') })],
  ["a test called through a namespace import", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test } from "node:test";\nimport * as nodeTest from "node:test";\nnodeTest.test("RA8: a planted property no row cites", () => {});') })],
  ["a test called through an alias", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test } from "node:test";\nconst check = test;\ncheck("RA8: a planted property no row cites", () => {});') })],
  [
    "a subtest",
    P.covered,
    () => ({
      read: editedRead(
        "lib/fv-initiator-claims.test.ts",
        'test("RA8: nothing past a table\'s bound is claimed, and the loss is counted", () => {',
        'test("RA8: nothing past a table\'s bound is claimed, and the loss is counted", async (t) => {\n  await t.test("RA8: a planted subtest no row cites", () => {});'
      )
    })
  ],
  [
    "a test called through an alias of an alias declared before it",
    P.covered,
    () => plantedIn(IC, 'function plant(): void {\n  const second = first;\n  second("RA8: a planted property no row cites", () => {});\n}\nconst first = test;\nplant();')
  ],
  ["a test called through a parenthesized alias", P.covered, () => plantedIn(IC, 'const check = (test);\ncheck("RA8: a planted property no row cites", () => {});')],
  ["a test called through a default import's test", P.covered, () => plantedIn(IC, 'import check from "node:test";\ncheck.test("RA8: a planted property no row cites", () => {});')],
  ["a test called through an alias of a namespace's test", P.covered, () => plantedIn(IC, 'import * as nodeTest from "node:test";\nconst check = nodeTest.test;\ncheck("RA8: a planted property no row cites", () => {});')],
  ["a test called through a destructured name", P.covered, () => plantedIn(IC, 'import * as nodeTest from "node:test";\nconst { test: check } = nodeTest;\ncheck("RA8: a planted property no row cites", () => {});')],
  ["a test called through string element access", P.covered, () => plantedIn(IC, 'test["skip"]("RA8: a planted property no row cites", () => {});')],
  ["a backtick title with no placeholder left to a family", P.covered, () => plantedIn(IC, "test(`RA8 catches a variant: plain`, () => {});")],
  ["a test written as test.skip", P.covered, () => ({ read: editedRead("lib/fv-initiator-claims.test.ts", 'import { test } from "node:test";', 'import { test } from "node:test";\ntest.skip("RA8: a planted property no row cites", () => {});') })],
  ["the investigation stage dropped from test:unit", P.wiring, () => ({ packageJson: REAL.packageJson.replace(" && npm run test:investigation && ", " && ") })],
  ["the exploration stage dropped from test:unit", P.wiring, () => ({ packageJson: REAL.packageJson.replace(" && npm run test:investigation-exploration", "") })],
  ["the lanes step narrowed in test:unit", P.wiring, () => ({ packageJson: REAL.packageJson.replace("'npm run test:corpus-overview' .unit-test-dist/lib/*.test.js", "'npm run test:corpus-overview' .unit-test-dist/lib/fv-*.test.js") })],
  ["a cited workspace suite no stage runs", P.wiring, () => ({ packageJson: REAL.packageJson.replace(" .investigation-test-dist/investigation/test/readings.test.js", "") })],
  ["the contract test renamed", P.ciRule, () => ({ read: editedRead(CI_HISTORY_TEST.file, `test("${CI_HISTORY_TEST.title}"`, 'test("every job that runs the unit suite checks out enough history"') })],
  ["the register no longer citing the contract test", P.ciRule, () => ({ doc: planted(`\`${CI_HISTORY_TEST.file}\`, "${CI_HISTORY_TEST.title}"`, `\`${CI_HISTORY_TEST.file}\``) })],
  ["a published command that is no package script", P.commands, () => ({ doc: planted("## Release status\n", "## Release status\n\nRun `npm run test:formal-register` alone.\n") })],
  ["a release gate that landed while the register says proposed", P.release, () => ({ readiness: REAL.readiness.replace("{", '{\n  "requiredSuites": [],') })],
  ["the readiness manifest naming the gate", P.release, () => ({ readiness: REAL.readiness.replace("{", '{\n  "gate": "formal-verification",') })],
  ["the release contract naming the gate", P.release, () => ({ releaseContract: `${REAL.releaseContract}\n// formal-verification\n` })],
  ["the register no longer saying the gate is proposed", P.release, () => ({ doc: planted("is proposed and not yet in code.", "is in code.") })],
  ["a short commit", P.commitShape, () => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace(F1, "af6c9568")) })]
];

for (const [name, property, change] of TEXT_VARIANTS) {
  test(`the guard refuses ${name}, as "${property}"`, async () => {
    await assertCaughtBy(name, property, () => checkRegister({ ...REAL, ...change() }, null));
  });
}

const EB3_TITLE = 'test("EB3: status-v1 rows admit the current status and reason table less the cap reason, and status-v2 rows all of it"';
const EB3_TEMPLATE = "test(`EB3 catches a variant: ${name}`";
const F1H_TITLE = 'test("loadVariant resolves the variant\'s own imports"';

/** A git whose reads of one file at the commits a test picks are edited, for a variant that hides or plants titles on one path only. */
const showEdited = (at: (commit: string) => boolean, file: string, edit: (text: string) => string): Partial<Git> => ({
  show: (commit, candidate) => {
    const text = theGit().show(commit, candidate);
    return at(commit) && candidate === file ? edit(text ?? "") : text;
  }
});
const atF1 = (commit: string) => commit === F1;
const atParentOfF1 = (commit: string) => commit === theGit().firstParent(F1);
const commitOf = (commit: string) => ({ doc: planted(EB3_FAMILY, EB3_FAMILY.replace(F1, commit)) });
const replaced = (find: string, replace: string) => (text: string) => {
  if (text.split(find).length - 1 !== 1) throw new Error(`An edit must land exactly once, but "${find}" does not.`);
  return text.replace(find, () => replace);
};

const GIT_VARIANTS: ReadonlyArray<readonly [string, string, () => [Partial<Inputs>, Git]]> = [
  ["a shallow clone", P.history, () => [{}, gitWith({ checkHistory: () => holds(P.history, false, () => ({ shallow: true })) })]],
  ["a commit this checkout does not have", P.commitFound, () => [commitOf("0123456789abcdef0123456789abcdef01234567"), theGit()]],
  ["an id that names no commit", P.commitType, () => [{}, gitWith({ isCommit: (commit) => (commit === F1 ? "tag" : theGit().isCommit(commit)) })]],
  ["a commit that is not an ancestor", P.ancestor, () => [{}, gitWith({ isAncestor: (commit) => commit !== F1 })]],
  [
    "a file listed at a commit whose object is missing",
    P.object,
    () => [{}, gitWith({ show: (commit, file) => (commit === F1 ? (holds(P.object, false, () => ({ commit, file })) as never) : theGit().show(commit, file)) })]
  ],
  ["a commit before the tests landed", P.atCommit, () => [commitOf("302bab04a62a639e94902599052714c442661c64"), theGit()]],
  ["a row's cited title absent at its commit", P.atCommit, () => [{}, gitWith(showEdited(atF1, "lib/fv-producer-identity.test.ts", replaced(EB3_TITLE, 'test("EB3: renamed"')))]],
  ["a row's family absent at its commit", P.atCommit, () => [{}, gitWith(showEdited(atF1, "lib/fv-producer-identity.test.ts", replaced(EB3_TEMPLATE, "test(`EB3 renamed: ${name}`")))]],
  ["a row's family present at its commit only as a plain title", P.atCommit, () => [{}, gitWith(showEdited(atF1, "lib/fv-producer-identity.test.ts", replaced(EB3_TEMPLATE, 'test("EB3 catches a variant: plain"')))]],
  ["a familyless row's title absent at its commit", P.atCommit, () => [{}, gitWith(showEdited(atF1, "lib/finite-check.test.ts", replaced(F1H_TITLE, 'test("renamed"')))]],
  ["a commit after the tests landed", P.firstLanded, () => [commitOf("8cd96197eb96efc3dcd38efbb7dbf18876ec0093"), theGit()]],
  ["a row's cited title already in its commit's parent", P.firstLanded, () => [{}, gitWith(showEdited(atParentOfF1, "lib/fv-producer-identity.test.ts", (text) => `${text}\n${EB3_TITLE}, () => {});\n`))]],
  ["a row's family already in its commit's parent", P.firstLanded, () => [{}, gitWith(showEdited(atParentOfF1, "lib/fv-producer-identity.test.ts", (text) => `${text}\nfor (const name of ["x"]) ${EB3_TEMPLATE}, () => {});\n`))]]
];

for (const [name, property, change] of GIT_VARIANTS) {
  test(`the guard refuses ${name}, as "${property}"`, { skip: NO_REPOSITORY }, async () => {
    wholeHistory();
    const [inputs, variantGit] = change();
    await assertCaughtBy(name, property, () => checkRegister({ ...REAL, ...inputs }, variantGit));
  });
}

test("a plain title that starts like a family, in the commit's parent, is not that family", { skip: NO_REPOSITORY }, () => {
  wholeHistory();
  checkRegister(REAL, gitWith(showEdited(atParentOfF1, "lib/fv-producer-identity.test.ts", (text) => `${text}\ntest("EB3 catches a variant: plain", () => {});\n`)));
});

const RA8_CALL = 'test("RA8: nothing past a table\'s bound is claimed, and the loss is counted", () => {';

test("a cited subtest sits in its parent test's callback, which holds it as placed", () => {
  checkRegister(
    {
      ...REAL,
      read: editedRead(IC, RA8_CALL, RA8_CALL.replace("() => {", 'async (t) => {\n  await t.test("RA8: a planted property", () => {});')),
      doc: planted(RA8_TESTS_LAST, `${RA8_TESTS_LAST}  - \`${IC}\`: "RA8: a planted property"\n`)
    },
    null
  );
});

test("a refused phrase joined by a hyphen is read as the phrase, not as its last word", async () => {
  const caught = await assertCaughtBy("formally-verified", P.refusedWord, () => checkRegister({ ...REAL, ...added("The rows are formally-verified.") }, null));
  assert.equal((caught.input as { word: string }).word, "formally verif*");
});

// ---------------------------------------------------------------------------------------
// Real git, on fixture repositories: the paths no checkout here can show.
// ---------------------------------------------------------------------------------------

// Written by hand, not read off the fixture tests below: a fixture test deleted leaves this list, and the test after it, as they are.
const FIXTURE_PROPERTIES: readonly string[] = [P.gitFailure, P.history, P.commitType, P.ancestor, P.object];

test("every refusal has a planted variant of its own, or is on the hand-written list of those the git fixture tests catch", () => {
  const plantedFor = new Set([...TEXT_VARIANTS.map(([, property]) => property), ...GIT_VARIANTS.map(([, property]) => property), ...FIXTURE_PROPERTIES]);
  for (const property of Object.values(P)) holds("every refusal is planted", plantedFor.has(property), () => ({ property }));
});

type Fixture = { root: string; first: string; second: string; tag: string; blob: string; side: string };

/** A repository whose first commit lands one test and whose second lands another and a family, with an annotated tag on the second. */
function fixtureRepository(root: string): Fixture {
  mkdirSync(path.join(root, "lib"), { recursive: true });
  initFixtureRepo(root);
  const at = (date: string) => ({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  writeFileSync(path.join(root, "lib/a.test.ts"), 'test("alpha", () => {});\n');
  runFixtureGit(root, ["add", "lib/a.test.ts"]);
  runFixtureGit(root, ["commit", "-q", "-m", "First"], at("2026-11-02T10:00:00Z"));
  const first = runFixtureGit(root, ["rev-parse", "HEAD"]).trim();
  const blob = runFixtureGit(root, ["rev-parse", "HEAD:lib/a.test.ts"]).trim();
  writeFileSync(path.join(root, "lib/a.test.ts"), 'test("alpha", () => {});\ntest("beta", () => {});\nfor (const name of ["x"]) test(`gamma catches ${name}`, () => {});\n');
  runFixtureGit(root, ["add", "lib/a.test.ts"]);
  runFixtureGit(root, ["commit", "-q", "-m", "Second"], at("2026-11-02T11:00:00Z"));
  const second = runFixtureGit(root, ["rev-parse", "HEAD"]).trim();
  runFixtureGit(root, ["tag", "-a", "landed", "-m", "Landed", second], at("2026-11-02T11:00:00Z"));
  const tag = runFixtureGit(root, ["rev-parse", "landed"]).trim();
  runFixtureGit(root, ["checkout", "-q", "-b", "side", first]);
  writeFileSync(path.join(root, "lib/a.test.ts"), 'test("alpha", () => {});\ntest("delta", () => {});\n');
  runFixtureGit(root, ["commit", "-q", "-a", "-m", "Side"], at("2026-11-02T12:00:00Z"));
  const side = runFixtureGit(root, ["rev-parse", "HEAD"]).trim();
  runFixtureGit(root, ["checkout", "-q", "main"]);
  runFixtureGit(root, ["config", "uploadpack.allowFilter", "true"]);
  return { root, first, second, tag, blob, side };
}

function fixtureRow(id: string, title: string, family: string | null, commit: string): string {
  return [
    `### ${id}. A fixture row`,
    "",
    "- **Property:** p",
    "- **Code:** `lib/a.test.ts`",
    "- **Domain:** d",
    "- **Bounds:** b",
    "- **Axioms:** none",
    "- **Method:** sampled",
    "- **Tests:**",
    `  - \`lib/a.test.ts\`: "${title}"`,
    family === null ? "- **Variants:** none: a fixture." : `- **Variants:**\n  - \`lib/a.test.ts\`: names beginning "${family}"`,
    `- **Commit:** ${commit}`,
    ""
  ].join("\n");
}

function fixtureRegister(rows: readonly string[]): Register {
  return readRegister(`## Claims from a fixture\n\n${rows.join("\n")}`);
}

let fixtureRoot: string | null = null;
let fixture: Fixture | null = null;
function theFixture(): Fixture {
  if (fixture === null) {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "fv-register-"));
    fixture = fixtureRepository(path.join(fixtureRoot, "origin"));
  }
  return fixture;
}
const scratch = (name: string): string => {
  theFixture();
  return mkdtempSync(path.join(fixtureRoot as string, `${name}-`));
};
const fixtureGit = (root: string, overrides: Record<string, string> = {}) => realGit(root, gitFixtureEnv(overrides));

process.on("exit", () => {
  if (fixtureRoot !== null) removeFixtureTree(fixtureRoot);
});

test("on a fixture, a root commit is told from a failing git, and rows at both commits pass", () => {
  const { root, first, second } = theFixture();
  checkCommits(fixtureRegister([fixtureRow("FX1", "alpha", null, first), fixtureRow("FX2", "beta", "gamma catches", second)]), fixtureGit(root));
});

test("on a fixture, a commit on a branch the checkout does not reach is refused as no ancestor", async () => {
  const { root, side } = theFixture();
  await assertCaughtBy("a side branch", P.ancestor, () => checkCommits(fixtureRegister([fixtureRow("FXS", "delta", null, side)]), fixtureGit(root)));
});

test("on a fixture, an annotated tag's id is refused as no commit", async () => {
  const { root, tag } = theFixture();
  await assertCaughtBy("an annotated tag", P.commitType, () => checkCommits(fixtureRegister([fixtureRow("FX2", "beta", "gamma catches", tag)]), fixtureGit(root)));
});

test("on a fixture, a real shallow clone is refused as shallow", async () => {
  const { root, second } = theFixture();
  const shallow = path.join(scratch("shallow"), "clone");
  runFixtureGit(fixtureRoot as string, ["clone", "-q", "--depth", "1", `file://${root}`, shallow]);
  await assertCaughtBy("a shallow clone", P.history, () => checkCommits(fixtureRegister([fixtureRow("FX2", "beta", "gamma catches", second)]), fixtureGit(shallow)));
});

test("on a fixture, a real blob-less partial clone with its origin gone is refused as partial, before any object is read", async () => {
  const { root, first } = theFixture();
  const partial = path.join(scratch("partial"), "clone");
  runFixtureGit(fixtureRoot as string, ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${root}`, partial]);
  const register = fixtureRegister([fixtureRow("FX1", "alpha", null, first)]);
  runFixtureGit(partial, ["remote", "set-url", "origin", "file:///nonexistent/fv-register"]);
  await assertCaughtBy("a partial clone whose origin is unreachable", P.history, () => checkCommits(register, fixtureGit(partial)));
  runFixtureGit(partial, ["remote", "remove", "origin"]);
  await assertCaughtBy("a partial clone whose origin was removed", P.history, () => checkCommits(register, fixtureGit(partial)));
});

test("on a fixture, a clone with grafts is refused as rewritten history", async () => {
  const { root, second } = theFixture();
  const grafted = path.join(scratch("grafts"), "clone");
  runFixtureGit(fixtureRoot as string, ["clone", "-q", `file://${root}`, grafted]);
  mkdirSync(path.join(grafted, ".git", "info"), { recursive: true });
  writeFileSync(path.join(grafted, ".git", "info", "grafts"), `${second}\n`);
  await assertCaughtBy("a grafted clone", P.history, () => checkCommits(fixtureRegister([fixtureRow("FX2", "beta", "gamma catches", second)]), fixtureGit(grafted)));
});

test("on a fixture, a replacement object is read past, so a commit shows its own tree", () => {
  const { root, second, side } = theFixture();
  const replaced = path.join(scratch("replace"), "clone");
  runFixtureGit(fixtureRoot as string, ["clone", "-q", `file://${root}`, replaced]);
  runFixtureGit(replaced, ["replace", second, side]);
  // Read through the replacement, the second commit would show the side branch's tree, which holds neither beta nor gamma.
  checkCommits(fixtureRegister([fixtureRow("FX2", "beta", "gamma catches", second)]), fixtureGit(replaced));
});

test("on a fixture, a blob-less clone with its origin kept refuses an object it lacks, even with the history check skipped", async (t) => {
  const { root, first } = theFixture();
  const version = /git version (\d+)\.(\d+)/.exec(runFixtureGit(root, ["version"]));
  if (version === null) {
    t.skip("could not read git's version");
    return;
  }
  const [major, minor] = [Number(version[1]), Number(version[2])];
  if (!(major > 2 || (major === 2 && minor >= 44))) {
    t.skip("GIT_NO_LAZY_FETCH needs git 2.44 or later; an older git fetches the object, and the history check is what refuses this clone");
    return;
  }
  const partial = path.join(scratch("lazy"), "clone");
  runFixtureGit(fixtureRoot as string, ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${root}`, partial]);
  await assertCaughtBy("a blob it would have to fetch", P.object, () => fixtureGit(partial).show(first, "lib/a.test.ts"));
});

test("on a fixture, a listed file whose object is missing is refused, never read as absent", async () => {
  const broken = fixtureRepository(path.join(scratch("missing"), "repo"));
  rmSync(path.join(broken.root, ".git", "objects", broken.blob.slice(0, 2), broken.blob.slice(2)));
  await assertCaughtBy("a missing blob", P.object, () => checkCommits(fixtureRegister([fixtureRow("FX1", "alpha", null, broken.first)]), fixtureGit(broken.root)));
});

/** A directory holding one executable script named git. */
function fakeGit(script: string): string {
  const directory = scratch("fake-git");
  writeFileSync(path.join(directory, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(path.join(directory, "git"), 0o755);
  return directory;
}

test("a git that exits 0 and prints nothing fails as a failing git, never as a shallow clone", async () => {
  const { root } = theFixture();
  const silent = fakeGit("exit 0");
  await assertCaughtBy("a silent git", P.gitFailure, () => realGit(root, { ...process.env, PATH: `${silent}${path.delimiter}${process.env.PATH ?? ""}` }).checkHistory());
});

test("a dangling .git fails as a failing git, never as a shallow clone", async () => {
  const dangling = scratch("dangling");
  writeFileSync(path.join(dangling, ".git"), "gitdir: /nonexistent/fv-register\n");
  await assertCaughtBy("a dangling .git", P.gitFailure, () => fixtureGit(dangling, { GIT_CEILING_DIRECTORIES: path.dirname(dangling) }).checkHistory());
});

/** A git that answers each call the guard makes as git would, but for the one step it is told to get wrong. */
const SCRIPTED_GIT = [
  'case "$1 $2" in',
  '  "rev-parse --is-inside-work-tree") [ "$FAIL" = tree ] && exit 0; echo true ;;',
  '  "rev-parse --is-shallow-repository") [ "$FAIL" = shallow ] && { echo perhaps; exit 0; }; echo false ;;',
  '  "config --get") [ "$FAIL" = extension ] && exit 2; [ "$FAIL" = partial ] && { echo origin; exit 0; }; exit 1 ;;',
  '  "config --get-regexp") [ "$FAIL" = promisor ] && exit 2; [ "$FAIL" = promisor-only ] && { echo "remote.origin.promisor true"; exit 0; }; exit 1 ;;',
  '  "rev-parse --git-path") [ "$FAIL" = packs ] && [ "$3" = objects/pack ] && exit 128; [ "$FAIL" = grafts ] && [ "$3" = info/grafts ] && exit 128; echo ".git/$3" ;;',
  '  "cat-file -t") [ "$FAIL" = type ] && exit 0; echo commit ;;',
  '  "merge-base --is-ancestor") [ "$FAIL" = ancestor ] && exit 2; exit 0 ;;',
  '  "rev-list --parents") [ "$FAIL" = parents ] && { echo someone-else; exit 0; }; echo "$5" ;;',
  '  "ls-tree --full-tree") [ "$FAIL" = list ] && exit 128; exit 0 ;;',
  '  *) exit 3 ;;',
  "esac"
].join("\n");
const SOME_COMMIT = "0123456789abcdef0123456789abcdef01234567";

for (const [step, call] of [
  ["tree", (broken: Git) => broken.checkHistory()],
  ["shallow", (broken: Git) => broken.checkHistory()],
  ["extension", (broken: Git) => broken.checkHistory()],
  ["promisor", (broken: Git) => broken.checkHistory()],
  ["packs", (broken: Git) => broken.checkHistory()],
  ["grafts", (broken: Git) => broken.checkHistory()],
  ["type", (broken: Git) => broken.isCommit(SOME_COMMIT)],
  ["ancestor", (broken: Git) => broken.isAncestor(SOME_COMMIT)],
  ["parents", (broken: Git) => broken.firstParent(SOME_COMMIT)],
  ["list", (broken: Git) => broken.show(SOME_COMMIT, "lib/a.test.ts")]
] as const) {
  test(`a git that answers the ${step} step wrongly fails as a failing git`, async () => {
    const scripted = fakeGit(SCRIPTED_GIT);
    const broken = realGit(scratch("scripted"), { ...process.env, FAIL: step, PATH: `${scripted}${path.delimiter}${process.env.PATH ?? ""}` });
    await assertCaughtBy(`a git wrong at ${step}`, P.gitFailure, () => call(broken));
  });
}

for (const [setting, step] of [
  ["its partialclone extension", "partial"],
  ["a promisor remote alone", "promisor-only"]
] as const) {
  test(`a git whose configuration names ${setting}, with no promisor pack yet, is refused as partial`, async () => {
    const scripted = fakeGit(SCRIPTED_GIT);
    const partial = realGit(scratch("scripted"), { ...process.env, FAIL: step, PATH: `${scripted}${path.delimiter}${process.env.PATH ?? ""}` });
    await assertCaughtBy(`a partial configuration by ${setting}`, P.history, () => partial.checkHistory());
  });
}

test("a git that fails by its status is asked once: the refusal is kept and raised again", async () => {
  const { root } = theFixture();
  const count = path.join(scratch("status"), "count");
  const failing = fakeGit(`echo run >> "${count}"\nexit 128`);
  const broken = realGit(root, { ...process.env, PATH: `${failing}${path.delimiter}${process.env.PATH ?? ""}` });
  await assertCaughtBy("a git that exits 128", P.gitFailure, () => broken.checkHistory());
  await assertCaughtBy("the same question again", P.gitFailure, () => broken.checkHistory());
  assert.equal(readFileSync(count, "utf8"), "run\n");
});

test("a git that is killed fails once, and every later call fails at once without running git again", async () => {
  const { root } = theFixture();
  const count = path.join(scratch("killed"), "count");
  const killed = fakeGit(`echo run >> "${count}"\nkill -9 $$`);
  const broken = realGit(root, { ...process.env, PATH: `${killed}${path.delimiter}${process.env.PATH ?? ""}` });
  await assertCaughtBy("a killed git", P.gitFailure, () => broken.checkHistory());
  await assertCaughtBy("the same git again", P.gitFailure, () => broken.isAncestor("0123456789abcdef0123456789abcdef01234567"));
  assert.equal(readFileSync(count, "utf8"), "run\n");
});

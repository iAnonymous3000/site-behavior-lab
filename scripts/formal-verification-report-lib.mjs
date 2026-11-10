// The formal verification execution report: one canonical record of a run of
// the bounded suites at one commit, and the one rule that judges it.
//
// A green test job does not show that a suite ran. A suite a stage stopped
// naming, a skipped test and an empty loop all leave the job green. This
// report says what ran: for each suite file, node's own counts, every test by
// name with its outcome, and every catch lib/finite-check.ts accepted, with
// the property the suite named and the property the counterexample carried.
//
// What it does not hold. A count a suite pins inside a test (states,
// transitions, cases) never leaves that test, so it is not here: a test that
// passed is the only evidence that its pinned count held. A method (exhaustive,
// bounded and so on) is a statement of a register row, not something a run can
// observe, so it is not here either. The report shows that named tests ran and
// passed at a commit. It adds nothing to what any test claims.
//
// One rule, two callers. scripts/formal-verification-report.mjs writes a
// report only if formalVerificationReportProblems finds nothing, and the
// release gate reads a report with the same function against the same list.
// A report the producer wrote therefore meets the gate's content rule, and a
// change to the rule changes both at once.
//
// This module's default export is the reporter node --test loads to collect a
// run's events, as scripts/unit-test-lanes.mjs does for its summaries.

export const FORMAL_VERIFICATION_REPORT_KIND = "site-behavior-formal-verification-execution-report";
export const FORMAL_VERIFICATION_REPORT_VERSION = 1;
// lib/finite-check.ts reads this name. lib/finite-check-catch-log.test.ts
// holds the two spellings equal.
export const FORMAL_VERIFICATION_CATCH_LOG_ENV = "SITE_BEHAVIOR_LAB_FV_CATCH_LOG";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SUITE_ID = /^(?:lib|investigation\/test)\/[A-Za-z0-9._-]+\.test\.ts$/;
const OUTCOMES = ["passed", "failed", "skipped", "todo"];
const COUNT_FIELDS = ["tests", "passed", "failed", "cancelled", "skipped", "todo", "skippedSuites"];
// Test titles and variant names are the suites' own words. The bound keeps a
// report readable and refuses a runaway string, nothing more.
const MAX_NAME = 4096;
const MAX_REASONS = 40;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, expected) =>
  isRecord(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isName = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_NAME;
// Code unit order, the same on every machine. localeCompare is not.
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const byFields = (fields) => (left, right) => {
  for (const field of fields) {
    const order = byText(left[field], right[field]);
    if (order !== 0) return order;
  }
  return 0;
};
const sortedBy = (list, compare) => list.every((entry, index) => index === 0 || compare(list[index - 1], entry) <= 0);

/** Where a suite's compiled file is, by the two compiles test:unit runs. */
export function compiledSuitePath(id) {
  if (typeof id !== "string" || !SUITE_ID.test(id)) throw new Error(`not a suite id: ${JSON.stringify(id)}`);
  const compiled = `${id.slice(0, -".ts".length)}.js`;
  return id.startsWith("lib/") ? `.unit-test-dist/${compiled}` : `.investigation-test-dist/${compiled}`;
}

/**
 * Every way a gate's requiredSuites is not a list this module can judge by.
 * Each entry names one suite file and the least it must show: tests that
 * passed, and variants caught. A minimum is a change detector, never evidence:
 * it refuses a suite that lost tests, and says nothing of the tests it keeps.
 */
export function formalVerificationRequiredSuitesProblems(requiredSuites) {
  if (!Array.isArray(requiredSuites) || requiredSuites.length === 0) {
    return ["requiredSuites must name every required suite"];
  }
  const problems = [];
  const seen = new Set();
  for (const [index, entry] of requiredSuites.entries()) {
    if (!hasExactKeys(entry, ["id", "minimumTests", "minimumVariants"])) {
      problems.push(`requiredSuites entry ${index + 1} must hold exactly id, minimumTests and minimumVariants, in that order`);
      continue;
    }
    if (typeof entry.id !== "string" || !SUITE_ID.test(entry.id)) {
      problems.push(`requiredSuites entry ${index + 1} does not name a suite file under lib or investigation/test`);
      continue;
    }
    if (seen.has(entry.id)) problems.push(`requiredSuites names ${entry.id} twice`);
    seen.add(entry.id);
    // A suite that need not run a single test would be required in name only.
    if (!Number.isSafeInteger(entry.minimumTests) || entry.minimumTests < 1) {
      problems.push(`${entry.id}: minimumTests must be a whole number of at least 1`);
    }
    if (!isCount(entry.minimumVariants)) problems.push(`${entry.id}: minimumVariants must be a whole number, 0 or more`);
  }
  return problems;
}

/**
 * Build the canonical report from a run's records. The order of suites, tests
 * and variants is fixed here, so the same results give the same bytes whatever
 * order they arrived in. Nothing a clock, a host or a path could vary is
 * taken: no duration, no time, no absolute file name.
 */
export function buildFormalVerificationReport({ commit, tree, suites }) {
  return {
    schemaVersion: FORMAL_VERIFICATION_REPORT_VERSION,
    artifactKind: FORMAL_VERIFICATION_REPORT_KIND,
    source: { commit, tree },
    suites: [...suites]
      .map((suite) => ({
        id: suite.id,
        counts: Object.fromEntries(COUNT_FIELDS.map((field) => [field, suite.counts[field]])),
        tests: suite.tests.map(({ name, outcome }) => ({ name, outcome })).sort(byFields(["name", "outcome"])),
        variants: suite.variants
          .map(({ variant, property, caughtBy }) => ({ variant, property, caughtBy }))
          .sort(byFields(["variant", "property", "caughtBy"]))
      }))
      .sort(byFields(["id"]))
  };
}

export function serializeFormalVerificationReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Every way a value is not a well-formed report, before anything is judged by it. */
function shapeProblems(report) {
  if (!hasExactKeys(report, ["schemaVersion", "artifactKind", "source", "suites"])) {
    return ["the report must hold exactly schemaVersion, artifactKind, source and suites, in that order"];
  }
  const problems = [];
  if (report.schemaVersion !== FORMAL_VERIFICATION_REPORT_VERSION) problems.push(`schemaVersion must be ${FORMAL_VERIFICATION_REPORT_VERSION}`);
  if (report.artifactKind !== FORMAL_VERIFICATION_REPORT_KIND) problems.push(`artifactKind must be ${FORMAL_VERIFICATION_REPORT_KIND}`);
  if (!hasExactKeys(report.source, ["commit", "tree"]) || !FULL_SHA.test(report.source.commit) || !FULL_SHA.test(report.source.tree)) {
    problems.push("source must hold exactly a full commit id and a full tree id");
  }
  if (!Array.isArray(report.suites)) return [...problems, "suites must be a list"];
  const ids = [];
  for (const [index, suite] of report.suites.entries()) {
    const label = isRecord(suite) && typeof suite.id === "string" ? suite.id : `suite ${index + 1}`;
    if (!hasExactKeys(suite, ["id", "counts", "tests", "variants"])) {
      problems.push(`${label} must hold exactly id, counts, tests and variants, in that order`);
      continue;
    }
    if (typeof suite.id !== "string" || !SUITE_ID.test(suite.id)) {
      problems.push(`${label} does not name a suite file under lib or investigation/test`);
      continue;
    }
    ids.push(suite.id);
    if (!hasExactKeys(suite.counts, COUNT_FIELDS) || !COUNT_FIELDS.every((field) => isCount(suite.counts[field]))) {
      problems.push(`${label}: counts must hold exactly ${COUNT_FIELDS.join(", ")}, each a whole number`);
      continue;
    }
    if (!Array.isArray(suite.tests) || !suite.tests.every((test) => hasExactKeys(test, ["name", "outcome"]) && isName(test.name) && OUTCOMES.includes(test.outcome))) {
      problems.push(`${label}: each test must hold exactly a name and an outcome of ${OUTCOMES.join(", ")}`);
      continue;
    }
    if (
      !Array.isArray(suite.variants) ||
      !suite.variants.every((caught) => hasExactKeys(caught, ["variant", "property", "caughtBy"]) && isName(caught.variant) && isName(caught.property) && isName(caught.caughtBy))
    ) {
      problems.push(`${label}: each variant must hold exactly variant, property and caughtBy`);
      continue;
    }
    if (!sortedBy(suite.tests, byFields(["name", "outcome"])) || !sortedBy(suite.variants, byFields(["variant", "property", "caughtBy"]))) {
      problems.push(`${label}: tests and variants must be in canonical order`);
    }
    // node's summary and the listed tests are two readings of one run. Where
    // they disagree, part of the run did not reach the report. Each outcome is
    // held to its own count, which also holds the list's length to the total.
    const { counts } = suite;
    const listed = (outcome) => suite.tests.filter((test) => test.outcome === outcome).length;
    if (
      counts.tests !== counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo ||
      listed("passed") !== counts.passed ||
      listed("skipped") !== counts.skipped ||
      listed("todo") !== counts.todo ||
      listed("failed") !== counts.failed + counts.cancelled
    ) {
      problems.push(`${label}: the listed tests do not add up to its counts`);
    }
  }
  if (new Set(ids).size !== ids.length) problems.push("the report names a suite twice");
  if (!sortedBy(ids, byText)) problems.push("suites must be in canonical order");
  return problems;
}

/**
 * Read a report from its bytes. Returns the report, or the reasons the bytes
 * are not one: not UTF-8, not JSON, not the canonical serialization, or not
 * the shape above. An unknown field is a refusal, never ignored.
 */
export function parseFormalVerificationReport(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { report: null, problems: ["the report is not UTF-8"] };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { report: null, problems: ["the report is not JSON"] };
  }
  const problems = shapeProblems(value);
  if (problems.length > 0) return { report: null, problems: bounded(problems.map((problem) => `malformed report: ${problem}`)) };
  if (serializeFormalVerificationReport(value) !== text) {
    return { report: null, problems: ["the report is not in its canonical serialization"] };
  }
  return { report: value, problems: [] };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const bounded = (problems) =>
  problems.length <= MAX_REASONS ? problems : [...problems.slice(0, MAX_REASONS), `and ${problems.length - MAX_REASONS} more`];

/**
 * Every way a report fails the closure rule for these required suites: each
 * one present and no other, no test skipped, left todo, failed or cancelled,
 * each minimum met, and every variant caught by the property its suite named.
 * With `source`, the report must also name that commit and tree.
 *
 * A variant that is not caught, or is caught for another property, makes
 * assertCaughtBy throw, so in a real run it is a failed test and the suite's
 * variant count falls. Both are refused here by name. A caught variant whose
 * two properties differ can only come from a changed harness, and is refused
 * as well.
 */
export function formalVerificationReportProblems(report, requiredSuites, source = {}) {
  const configuration = formalVerificationRequiredSuitesProblems(requiredSuites);
  if (configuration.length > 0) return bounded(configuration);
  const shape = shapeProblems(report);
  if (shape.length > 0) return bounded(shape.map((problem) => `malformed report: ${problem}`));

  const problems = [];
  if (source.commit !== undefined && report.source.commit !== source.commit) {
    problems.push(`the report is for commit ${report.source.commit}, not ${source.commit}`);
  }
  if (source.tree !== undefined && report.source.tree !== source.tree) {
    problems.push(`the report is for tree ${report.source.tree}, not ${source.tree}`);
  }
  const reported = new Map(report.suites.map((suite) => [suite.id, suite]));
  const required = new Set(requiredSuites.map((entry) => entry.id));
  for (const id of reported.keys()) {
    if (!required.has(id)) problems.push(`the report names ${id}, which is not a required suite`);
  }
  for (const { id, minimumTests, minimumVariants } of requiredSuites) {
    const suite = reported.get(id);
    if (suite === undefined) {
      problems.push(`required suite ${id} is absent from the report`);
      continue;
    }
    const { counts } = suite;
    const first = (outcome) => JSON.stringify(suite.tests.find((test) => test.outcome === outcome)?.name ?? "(not listed)");
    if (counts.skipped > 0) problems.push(`${id}: ${plural(counts.skipped, "test")} skipped, the first by name ${first("skipped")}`);
    if (counts.skippedSuites > 0) problems.push(`${id}: ${plural(counts.skippedSuites, "describe block")} skipped`);
    if (counts.todo > 0) problems.push(`${id}: ${plural(counts.todo, "test")} left todo, the first by name ${first("todo")}`);
    if (counts.failed + counts.cancelled > 0) {
      problems.push(`${id}: ${plural(counts.failed + counts.cancelled, "test")} failed or cancelled, the first by name ${first("failed")}`);
    }
    if (counts.passed < minimumTests) {
      problems.push(`${id}: ${plural(counts.passed, "test")} passed, below its pinned minimum of ${minimumTests}`);
    }
    for (const caught of suite.variants) {
      if (caught.caughtBy !== caught.property) {
        problems.push(`${id}: variant ${JSON.stringify(caught.variant)} was caught by ${JSON.stringify(caught.caughtBy)}, not by its reason ${JSON.stringify(caught.property)}`);
      }
    }
    const caughtForItsReason = suite.variants.filter((caught) => caught.caughtBy === caught.property).length;
    if (caughtForItsReason < minimumVariants) {
      problems.push(`${id}: ${plural(caughtForItsReason, "variant")} caught for its reason, below its pinned minimum of ${minimumVariants}`);
    }
  }
  return bounded(problems);
}

/** The totals a passing report states, for the line a gate or a producer prints. */
export function formalVerificationReportTotals(report) {
  return {
    suites: report.suites.length,
    tests: report.suites.reduce((sum, suite) => sum + suite.counts.passed, 0),
    variants: report.suites.reduce((sum, suite) => sum + suite.variants.length, 0)
  };
}

/**
 * One test's outcome as node counts it: skip first, then todo, then failure.
 * node counts a cancelled test apart from a failed one. An event does not say
 * which it was, so both read "failed" here and the counts keep node's split.
 */
function outcomeOf(event) {
  if (event.data.skip !== undefined) return "skipped";
  if (event.data.todo !== undefined) return "todo";
  return event.type === "test:fail" ? "failed" : "passed";
}

/**
 * The reporter. One JSON line for each test a file ran, one for each describe
 * block it skipped, and one for the summary the file's process writes last.
 * The summary's arrival means everything before it arrived, which is what
 * scripts/unit-test-lanes.mjs rests on too.
 */
export default async function* formalVerificationEvents(source) {
  for await (const event of source) {
    const file = event.data?.file;
    if (typeof file !== "string") continue;
    if (event.type === "test:pass" || event.type === "test:fail") {
      if (event.data.details?.type === "suite") {
        if (event.data.skip !== undefined) yield `${JSON.stringify({ kind: "skipped-suite", file })}\n`;
        continue;
      }
      yield `${JSON.stringify({ kind: "test", file, name: event.data.name, outcome: outcomeOf(event) })}\n`;
    } else if (event.type === "test:summary") {
      yield `${JSON.stringify({ kind: "summary", file, counts: event.data.counts })}\n`;
    }
  }
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  COVERAGE_BOUNDARY_ENTRIES,
  coverageBoundaryViolations,
  COVERAGE_BOUNDARY_REASON_COPY,
  COVERAGE_BOUNDARY_SOURCES,
  coverageBoundaryMetadata,
  validateCoverageBoundary,
  type CoverageBoundaryEntry
} from "./detector-coverage-boundary";

const root = process.cwd();

function scannerSources(): string {
  return COVERAGE_BOUNDARY_SOURCES.map((relative) =>
    readFileSync(path.join(root, relative), "utf8")
  ).join("\n");
}

test("the committed coverage boundary is structurally valid", () => {
  assert.deepEqual(validateCoverageBoundary(COVERAGE_BOUNDARY_ENTRIES), []);
  assert.ok(COVERAGE_BOUNDARY_ENTRIES.length > 0);
  assert.equal(coverageBoundaryMetadata.entries, COVERAGE_BOUNDARY_ENTRIES.length);
});

/**
 * The load-bearing test. A published "we do not measure X" is a claim about
 * this code, so it is checked against this code. Adding instrumentation for a
 * surface still listed here fails until the boundary is corrected, which is
 * what keeps the negative space from going quietly stale.
 */
test("every mechanically checkable no-coverage claim is true of the scanner source", () => {
  const violations = coverageBoundaryViolations(COVERAGE_BOUNDARY_ENTRIES, scannerSources());
  assert.deepEqual(
    violations,
    [],
    `A published blind spot is stale, or instrumentation landed without updating the boundary:\n${violations.join("\n")}`
  );
  const checked = COVERAGE_BOUNDARY_ENTRIES.reduce(
    (total, entry) => total + (entry.absentIdentifiers?.length ?? 0),
    0
  );
  assert.ok(checked > 0, "no claim was actually checked");
});

test("the published checked-claim count matches what the test can enforce", () => {
  const enforceable = COVERAGE_BOUNDARY_ENTRIES.filter(
    (entry) => (entry.absentIdentifiers?.length ?? 0) > 0
  ).length;
  assert.equal(coverageBoundaryMetadata.checkedClaims, enforceable);
  // The page reports this as a subset, never as the whole boundary, so an
  // unverifiable claim can never be presented as an enforced one.
  assert.ok(
    coverageBoundaryMetadata.checkedClaims < coverageBoundaryMetadata.entries,
    "if every claim were checkable the copy distinguishing them should be revisited"
  );
});

test("the guard actually fails when a claimed blind spot becomes instrumented", () => {
  // Mutation coverage: run the real check against a source that DOES hook a
  // surface the boundary claims is unmeasured. A guard never shown to fail is
  // not evidence, and this one is the whole basis of the published claim.
  const instrumented = "const level = await navigator.getBattery();";
  const violations = coverageBoundaryViolations(COVERAGE_BOUNDARY_ENTRIES, instrumented);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^battery-status: /);
  assert.match(violations[0], /getBattery appears in the scanner source/);

  // And it stays silent on source that instruments nothing it claims to miss.
  assert.deepEqual(
    coverageBoundaryViolations(COVERAGE_BOUNDARY_ENTRIES, "const canvas = ctx.getImageData();"),
    []
  );
});

test("each reason stays distinguishable, so a non-goal never reads as an oversight", () => {
  const reasons = new Set(COVERAGE_BOUNDARY_ENTRIES.map((entry) => entry.reason));
  assert.deepEqual([...reasons].sort(), ["declined", "not-instrumented", "unobservable"]);
  for (const reason of reasons) {
    const copy = COVERAGE_BOUNDARY_REASON_COPY[reason];
    assert.ok(copy.label.trim().length > 0, `${reason} needs a label`);
    assert.ok(copy.meaning.trim().length > 40, `${reason} needs to say what it means for a reader`);
  }
});

test("validation rejects hollow, duplicated, and mislabeled entries", () => {
  const base: CoverageBoundaryEntry = {
    id: "example-gap",
    label: "Example",
    reason: "not-instrumented",
    explanation: "A sufficiently long explanation of what a reader cannot conclude from this gap.",
    absentIdentifiers: ["someApi"]
  };

  assert.deepEqual(validateCoverageBoundary([base, { ...base }]).length > 0, true);
  assert.match(validateCoverageBoundary([base, { ...base }])[0], /duplicate id/);
  assert.match(
    validateCoverageBoundary([{ ...base, id: "Not A Slug" }])[0],
    /lowercase slug/
  );
  assert.match(
    validateCoverageBoundary([{ ...base, explanation: "too short" }])[0],
    /explanation must say/
  );
  assert.match(
    validateCoverageBoundary([{ ...base, absentIdentifiers: [] }])[0],
    /never an empty promise/
  );
  assert.match(
    validateCoverageBoundary([{ ...base, reason: "declined" }])[0],
    /only a not-instrumented claim may name absent identifiers/
  );
  // A boundary that lost a whole reason category is refused, so the three
  // kinds of "no" cannot quietly collapse into one.
  assert.match(
    validateCoverageBoundary([base]).join(" "),
    /must distinguish declined/
  );
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  COVERAGE_BOUNDARY_ENTRIES,
  coverageBoundaryViolations,
  COVERAGE_BOUNDARY_REASON_COPY,
  COVERAGE_BOUNDARY_PATH,
  COVERAGE_BOUNDARY_SOURCES,
  COVERAGE_BOUNDARY_URL,
  coverageBoundaryMetadata,
  coverageBoundarySentence,
  coverageBoundarySummary,
  injectedModuleSpecifiers,
  PAGE_INJECTION_PATTERN,
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

/**
 * Mutation coverage for every entry that claims a mechanically checkable
 * blind spot, not just the one the original test sampled. An entry whose
 * guard has never been shown to fire is indistinguishable from a decorative
 * string, and the boundary page counts these as enforced claims.
 */
test("every checked entry's guard fires when its own surface becomes instrumented", () => {
  const checked = COVERAGE_BOUNDARY_ENTRIES.filter(
    (entry) => (entry.absentIdentifiers?.length ?? 0) > 0
  );
  assert.ok(checked.length > 0);

  for (const entry of checked) {
    for (const identifier of entry.absentIdentifiers ?? []) {
      const violations = coverageBoundaryViolations(
        COVERAGE_BOUNDARY_ENTRIES,
        `const probe = ${identifier};`
      );
      const matching = violations.filter((violation) => violation.startsWith(`${entry.id}: `));
      assert.equal(
        matching.length,
        1,
        `${entry.id} claims ${identifier} is absent, but instrumenting it raised no violation`
      );
      assert.match(matching[0], new RegExp(`${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  }
});

/**
 * The guard is only as complete as the surface it reads. This derives the set
 * of modules that can inject page code from disk and refuses any that the
 * boundary does not read, so a new injecting module cannot land outside every
 * published claim the way three of them already had.
 */
test("every module that can inject page code is a source the boundary reads", () => {
  const libDir = path.join(root, "lib");
  // The module that DEFINES the pattern necessarily contains it as source
  // text, so it matches itself and is not an injecting module. Excluding it by
  // name rather than weakening the pattern keeps the pattern honest.
  const patternHome = "detector-coverage-boundary.ts";
  const injecting = readdirSync(libDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => name !== patternHome)
    .filter((name) =>
      PAGE_INJECTION_PATTERN.test(readFileSync(path.join(libDir, name), "utf8"))
    )
    .map((name) => `lib/${name}`)
    .sort();

  assert.ok(injecting.length > 0, "the injection pattern matched nothing, so it is not testing anything");

  const declared = new Set(COVERAGE_BOUNDARY_SOURCES);
  const unread = injecting.filter((relative) => !declared.has(relative));
  assert.deepEqual(
    unread,
    [],
    `These modules can run code in the page but the coverage boundary never reads them, so instrumentation added there would not fail a single claim:\n${unread.join("\n")}`
  );
});

/**
 * The shape scan above is blind to this repo's dominant injection idiom: a
 * module exports a page-context function and scanner.ts hands it to
 * addInitScript. Three of the declared sources are exactly that shape and
 * match the pattern zero times. This follows the injected argument back to its
 * defining module, which is what actually keeps the list complete.
 */
test("every module whose function is injected into the page is a source the boundary reads", () => {
  const declared = new Set(COVERAGE_BOUNDARY_SOURCES);
  const resolved = new Set<string>();
  for (const relative of COVERAGE_BOUNDARY_SOURCES) {
    for (const injected of injectedModuleSpecifiers(
      readFileSync(path.join(root, relative), "utf8")
    )) {
      resolved.add(injected);
    }
  }

  assert.ok(
    resolved.size > 0,
    "the resolver found no injected module, so it is asserting nothing"
  );
  // The module the shape pattern cannot see. If this stops resolving, the
  // resolver has regressed to the blindness it was written to cover.
  assert.ok(
    resolved.has("lib/gpc-injection.ts"),
    `resolver missed the known page-context module it exists to catch; found ${[...resolved].join(", ")}`
  );

  const unread = [...resolved].filter((relative) => !declared.has(relative)).sort();
  assert.deepEqual(
    unread,
    [],
    `These modules have a function injected into the page but the boundary never reads them:\n${unread.join("\n")}`
  );
});

test("the injection resolver follows real call shapes and refuses to guess", () => {
  // Multi-line import block and multi-line call, which is how scanner.ts is written.
  const realistic = `
import {
  installMotionObserver,
  type MotionKey
} from "./motion-observer";
import { helper as aliased } from "@/lib/aliased-module";

await withScanTimeout(
  context.addInitScript(
    installMotionObserver,
    key
  ),
  started
);
await page.evaluate(aliased, args);
`;
  assert.deepEqual(injectedModuleSpecifiers(realistic), [
    "lib/aliased-module.ts",
    "lib/motion-observer.ts"
  ]);

  // Mutation coverage: the guard must FAIL for an undeclared module. This is
  // the exact defect it exists to catch, so it is exercised rather than assumed.
  const declared = new Set(COVERAGE_BOUNDARY_SOURCES);
  assert.ok(!declared.has("lib/motion-observer.ts"));
  assert.ok(injectedModuleSpecifiers(realistic).some((m) => !declared.has(m)));

  // And it must not invent modules. Inline functions, locally defined
  // functions, and non-lib specifiers resolve to nothing.
  assert.deepEqual(
    injectedModuleSpecifiers(`
import { chromium } from "playwright";
function localOnly() {}
await page.addInitScript(localOnly);
await page.addInitScript(() => { window.x = 1; });
await page.evaluate(chromium, args);
`),
    []
  );
});

test("every declared boundary source exists, so a rename cannot silently shrink the guard", () => {
  for (const relative of COVERAGE_BOUNDARY_SOURCES) {
    assert.ok(
      existsSync(path.join(root, relative)),
      `${relative} is declared as a coverage-boundary source but does not exist`
    );
  }
  assert.equal(new Set(COVERAGE_BOUNDARY_SOURCES).size, COVERAGE_BOUNDARY_SOURCES.length);
});

/**
 * The report artifact carries a summary, not the list. A summary is a second
 * copy of a contract, which is where this codebase's worst defects live, so it
 * is derived from the entries and asserted to move with them.
 */
test("the report-artifact summary is derived from the entries, not restated", () => {
  const summary = coverageBoundarySummary();
  assert.deepEqual(
    [...summary["not-instrumented"], ...summary.declined, ...summary.unobservable].sort(),
    COVERAGE_BOUNDARY_ENTRIES.map((entry) => entry.label).sort(),
    "every entry must appear in exactly one summary group"
  );

  const sentence = coverageBoundarySentence();
  assert.match(sentence, new RegExp(`\\b${summary["not-instrumented"].length} browser surfaces are`));
  assert.match(sentence, new RegExp(`\\b${summary.declined.length} capabilities are declined`));
  assert.match(sentence, new RegExp(`\\b${summary.unobservable.length} are outside`));

  // Entry labels carry their own commas, so the list separator must not be a
  // comma or the enumeration becomes unparseable to a reader.
  const listed = sentence.slice(sentence.indexOf("(") + 1, sentence.indexOf(")"));
  assert.ok(
    listed.includes(";"),
    `surface list must be semicolon-separated because labels contain commas: ${listed}`
  );

  // The distinction the whole boundary exists to protect: a reader must never
  // read silence as proof of absence.
  assert.match(sentence, /not evidence that they did not occur/);
  assert.doesNotMatch(sentence, /\bno .* (?:were|was) (?:present|found|detected)\b/i);
});

test("the summary tracks a changed boundary instead of going stale", () => {
  const shorter: CoverageBoundaryEntry[] = [
    {
      id: "only-gap",
      label: "Only gap",
      reason: "not-instrumented",
      explanation: "A sufficiently long explanation of what a reader cannot conclude from this gap.",
      absentIdentifiers: ["someApi"]
    },
    {
      id: "only-declined",
      label: "Only declined",
      reason: "declined",
      explanation: "A sufficiently long explanation of what a reader cannot conclude from this refusal."
    },
    {
      id: "only-unobservable",
      label: "Only unobservable",
      reason: "unobservable",
      explanation: "A sufficiently long explanation of what a reader cannot conclude from this limit."
    }
  ];
  const sentence = coverageBoundarySentence(shorter);
  // Singular counts must read as singular. The production boundary is plural
  // everywhere, so only a shrunk boundary can catch this.
  assert.match(sentence, /1 browser surface is not instrumented at all \(Only gap\)/);
  assert.match(sentence, /1 capability is declined by policy/);
  assert.match(sentence, /1 is outside what any single visit can see/);
  assert.doesNotMatch(sentence, /surfaces are not instrumented/);
  assert.doesNotMatch(sentence, /capabilities are declined/);
  // Under four surfaces there is no overflow tail to append.
  assert.doesNotMatch(sentence, /other(s)?\)/);
});

test("the surface list names an overflow count once it cannot list them all", () => {
  const many: CoverageBoundaryEntry[] = Array.from({ length: 5 }, (_, index) => ({
    id: `gap-${index}`,
    label: `Gap ${index}`,
    reason: "not-instrumented" as const,
    explanation: "A sufficiently long explanation of what a reader cannot conclude from this gap."
  }));
  const sentence = coverageBoundarySentence(many);
  assert.match(sentence, /Gap 0; Gap 1; Gap 2; and 2 others/);

  const four = coverageBoundarySentence(many.slice(0, 4));
  assert.match(four, /Gap 0; Gap 1; Gap 2; and 1 other\)/);
});

test("the deep link the artifact prints resolves to a real anchor on the catalog page", () => {
  assert.match(COVERAGE_BOUNDARY_URL, /^https:\/\/sitebehavior\.org\/catalog\/#(.+)$/);
  // The absolute form is derived from the routable one, so print and screen
  // can never point at different anchors.
  assert.ok(COVERAGE_BOUNDARY_URL.endsWith(COVERAGE_BOUNDARY_PATH));
  assert.match(COVERAGE_BOUNDARY_PATH, /^\//, "the on-screen link must be routable, not absolute");
  const anchor = COVERAGE_BOUNDARY_URL.split("#")[1];
  const catalog = readFileSync(path.join(root, "app/catalog/page.tsx"), "utf8");
  assert.ok(
    catalog.includes(`id="${anchor}"`),
    `the boundary link points at #${anchor} but the catalog page renders no such id`
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

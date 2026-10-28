import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import { NODE_SCANNER_METHODOLOGY_VERSION } from "./legacy-methodology";
import { NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION } from "./scan-report-v2-r2-producer-contract";
import { DETECTOR_VERSIONS } from "./measurement-kernel";
import { RequestInitiatorIndex } from "./request-initiator";
import { MAX_INSPECTION_GROUP_HOSTS } from "./connection-inspection-evidence";
import { MAX_SCROLL_CHECK_SCREENS } from "./scroll-check-evidence";
import { ANALYTICS_FORMATS } from "./analytics-event-vocabulary";
import { SHARED_WORKER_ENDED_AT_ONCE_MS } from "./shared-worker-ended-at-once";
import { fingerprintSharedWorkersEndedAtOnceWarning } from "./scan-runtime";

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

test("the causality boundary states what the scanner actually records", () => {
  // The initiator join landed as a pure, unwired module, and this entry then
  // described a capability no code path provides: RequestInitiatorIndex has no
  // production caller and the scan opens no CDP session, so no live report has
  // ever carried an initiator. A published boundary that overstates the
  // instrument is precisely the defect this surface exists to prevent, so the
  // wording and the wiring are pinned to each other in both directions.
  // Reachability from the LIVE PRODUCER, not import presence in the repo.
  // Presence is the wrong question: the selective calibration CLI already
  // opens a CDP session of its own, so importing the index there would force
  // this sentence to be withdrawn while live scans still recorded nothing.
  // What makes the sentence false is the capture becoming reachable from the
  // module that produces a live report.
  const liveProducer = path.join(root, "lib", "scanner.ts");
  const initiatorModule = path.join(root, "lib", "request-initiator.ts");

  const resolveRepoSpecifier = (specifier: string, fromFile: string): string | null => {
    const base = specifier.startsWith("@/")
      ? path.join(root, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(fromFile), specifier)
        : null;
    if (base === null) return null;
    const stripped = base.replace(/\.(js|jsx|mjs)$/, "");
    for (const candidate of [stripped, `${stripped}.ts`, `${stripped}.tsx`, path.join(stripped, "index.ts")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  const reachable = new Set<string>();
  const queue = [liveProducer];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g
    )) {
      const resolved = resolveRepoSpecifier(match[1], file);
      if (resolved !== null && !reachable.has(resolved)) queue.push(resolved);
    }
  }
  const productionImporters = reachable.has(initiatorModule)
    ? [path.relative(root, initiatorModule)]
    : [];

  const entry = COVERAGE_BOUNDARY_ENTRIES.find(
    (candidate) => candidate.id === "script-to-request-causality"
  );
  assert.ok(entry, "the causality boundary entry must exist");

  assert.equal(
    entry.explanation.includes("A live scan records no initiator at all"),
    productionImporters.length === 0,
    productionImporters.length === 0
      ? "nothing wires the initiator index, so the boundary must say a live scan records no initiator"
      : `the live producer now reaches ${productionImporters.join(", ")}, so this boundary text must be rewritten to describe what a live scan records`
  );
});

/**
 * Every report links to this catalog, and none measured before
 * node-detectors-v11 observed OffscreenCanvas 2D work in the page, or any
 * canvas, font or WebGL work inside a worker. The entry that says both realms
 * are observed must say, in its sentence about older reports, which reports
 * that is true of for each realm, with markers a reader can find on a report:
 * an observer version older than the current one, a component the current v1
 * base carries, and a component the current r2 methodology carries. It must
 * also say which page-realm routes it traces, and that no other is.
 */
test("the cross-realm canvas entry tells a reader which reports observed OffscreenCanvas work in the page and work in workers", () => {
  const entry = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "cross-realm-canvas");
  assert.ok(entry, "the cross-realm canvas boundary entry must exist");
  const olderReports = /Reports measured before node-detectors-v\d+[^.]*(?:\.\d[^.]*)*\./.exec(entry.explanation)?.[0];
  assert.ok(olderReports, "the entry must have a sentence about reports measured before the change");
  assert.match(olderReports, /\bOffscreenCanvas 2D work in the page\b/);
  assert.match(
    olderReports,
    /\bcanvas, font or WebGL work inside a worker\b/,
    "the older-report sentence must cover the worker realm, which no older report observed either"
  );

  const olderObserver = /\bfingerprint-observer@(\d+) or earlier\b/.exec(olderReports);
  assert.ok(olderObserver, "the entry must name the last observer version that did not observe it");
  const currentObserver = /^fingerprint-observer@(\d+)$/.exec(DETECTOR_VERSIONS["fingerprint-heuristics"]);
  assert.ok(currentObserver);
  assert.ok(Number(olderObserver[1]) < Number(currentObserver[1]));

  const component = /\+fingerprint-surface-v\d+\b/.exec(olderReports);
  assert.ok(component, "the entry must name the v1 methodology component that marks the change");
  assert.ok(
    NODE_SCANNER_METHODOLOGY_VERSION.split("+").includes(component[0].slice(1)),
    `${component[0]} is not a component of the current base methodology`
  );
  const workerComponent = /\+worker-fingerprint-v\d+\b/.exec(olderReports);
  assert.ok(workerComponent, "the entry must name the r2 methodology component that marks the worker realm");
  assert.ok(
    NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION.split("+").includes(workerComponent[0].slice(1)),
    `${workerComponent[0]} is not a component of the current r2 methodology`
  );
  assert.match(olderReports, /does not rule that work out/);

  // The traced routes are a rule, not a count of known gaps: a list of gaps
  // read as closed while createPattern and VideoFrame routes were missed too.
  assert.match(entry.explanation, /\bonly through drawImage\b/);
  assert.match(entry.explanation, /any other route[^.]*is not traced, for either kind of canvas/);
  assert.match(entry.explanation, /still pending when the visit's evidence is collected/);
});

/**
 * fingerprint-observer@10 reads shared workers, but not every one. The
 * cross-realm entry must say which it reads, that one reached late (a worker
 * that started before the hold could land, a module worker with a static
 * import) is still unread, that one which ended at once is named apart, and
 * which reports read none. Each is a claim about code, so each is pinned to
 * the code that makes it true: the observer version the entry names, the
 * bound the scanner uses, the thread's late classes and the readout's rule
 * that a late shared worker is unread, never excluded or credited.
 */
test("the cross-realm canvas entry says which shared workers the scanner reads, which stay unread and which ended at once", () => {
  const entry = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "cross-realm-canvas");
  assert.ok(entry, "the cross-realm canvas boundary entry must exist");
  const currentObserver = Number(/^fingerprint-observer@(\d+)$/.exec(DETECTOR_VERSIONS["fingerprint-heuristics"])?.[1]);
  assert.ok(currentObserver >= 10);

  const held = /\bFrom fingerprint-observer@(\d+) the scanner observes the same work inside each shared worker\b[^.]*\./.exec(
    entry.explanation
  );
  assert.ok(held, "the entry must say from which observer version shared workers are read");
  assert.equal(Number(held[1]), 10);
  assert.match(held[0], /\bholds the shared worker at its main script, before its first statement\b/);
  assert.match(
    held[0],
    /\bcredits it only when it started under the main document still current at the read and its script is of that document's origin\b/
  );
  assert.ok(COVERAGE_BOUNDARY_SOURCES.includes("lib/shared-worker-attacher.ts"), "the module that holds them is a boundary source");

  const late = /\bA shared worker the scanner reached only after the worker began to run\b[^.]*\./.exec(entry.explanation)?.[0];
  assert.ok(late, "the entry must say that a shared worker reached late is unread");
  assert.match(late, /\bstarted before the hold could land\b/);
  assert.match(late, /\bone another DevTools client let run while the scanner held it\b/);
  assert.match(late, /\bmodule shared worker with a static import\b/);
  assert.match(late, /\bis never read, and marks the visit's fingerprinting evidence incomplete rather than clean\b/);
  const attacher = readFileSync(path.join(root, "lib", "shared-worker-attacher.ts"), "utf8");
  // The late classes the sentence names, the broken hold among them: a
  // resume of a held worker before its install answered.
  for (const reason of ["ran-before-breakpoint", "other-script", "running-at-attach", "resumed-while-held"]) {
    assert.ok(attacher.includes(`"${reason}"`), `the thread no longer classifies ${reason} as late`);
  }
  assert.match(
    attacher,
    /if \(method === "Debugger\.resumed"\) \{[^}]*breakHold\(worker\);/,
    "the thread must treat a resume of a held worker as a broken hold"
  );
  const realm = readFileSync(path.join(root, "lib", "worker-fingerprint-realm.ts"), "utf8");
  assert.match(
    realm,
    /if \(worker\.hold === "late"\) return \{ record, state: "unread", reason: "attachedLate" \};/,
    "the readout must count a shared worker reached late as unread"
  );

  const ended = /\bSo does a shared worker the scanner never reached that ended within (\d+) ms of starting\b[^.]*\./.exec(
    entry.explanation
  );
  assert.ok(ended, "the entry must say that a shared worker which ended at once still marks the evidence incomplete");
  assert.equal(Number(ended[1]), SHARED_WORKER_ENDED_AT_ONCE_MS, "the entry must name the scanner's own bound");
  assert.match(ended[0], /\bnames in a sentence of its own, since whether it ran any code is not known\b/);

  const before = /\bA report whose fingerprint detector is fingerprint-observer@(\d+) or earlier observed nothing inside a shared worker\b[^.]*\./.exec(
    entry.explanation
  );
  assert.ok(before, "the entry must say which reports read no shared worker");
  assert.equal(Number(before[1]), Number(held[1]) - 1);
  assert.match(entry.explanation, /\bWorklets are not instrumented\b/);
  assert.doesNotMatch(entry.explanation, /\bShared workers and worklets are not instrumented\b/);
});

/**
 * The same claims where readers meet them outside the catalog: the
 * limitations page, which every fresh result and every saved, shared or
 * exported report links to, and the methodology page. Both said, through
 * fingerprint-observer@9, that shared-worker code goes unobserved; the
 * traffic lines stay, since a shared worker's own requests are still not
 * recorded. Each claim is pinned to the code that makes it true.
 */
test("the limitations and methodology pages say which shared workers the scanner reads, in the scanner's own words", () => {
  const limitations = readFileSync(path.join(root, "docs", "limitations.md"), "utf8").replace(/\s+/g, " ");
  const methodology = readFileSync(path.join(root, "app", "methodology", "page.tsx"), "utf8")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");

  // Read, held at the main script, credited by the ownership rule.
  assert.match(limitations, /\bCanvas, font and WebGL use inside each shared worker the page starts is recorded by the same observer too\b/);
  assert.match(limitations, /\bholds each shared worker at its main script, before its first statement, while the observer is installed\b/);
  assert.match(
    limitations,
    /\bcredited to the page only when it started under the main document that is still the current one when the evidence is read, and its script is of that document's origin\b/
  );
  // Unread when reached late or let run while held, the broken hold included.
  assert.match(limitations, /\bone that started before the hold could land, or one the automation layer's own DevTools session let run while the attacher held it\b/);
  assert.match(limitations, /\bA module shared worker with a static import is always reached that late\b/);
  // The ended-at-once line, word for word, at the scanner's bound.
  assert.ok(
    limitations.includes(`("${fingerprintSharedWorkersEndedAtOnceWarning(1)}")`),
    "the limitations page must quote the line the scanner writes"
  );
  assert.match(limitations, new RegExp(`\\bended within ${SHARED_WORKER_ENDED_AT_ONCE_MS} ms of starting cannot be shown to have run any code or none\\b`));
  // Which reports read none, and what stays unobserved.
  const observer = Number(/^fingerprint-observer@(\d+)$/.exec(DETECTOR_VERSIONS["fingerprint-heuristics"])?.[1]);
  assert.match(limitations, new RegExp(`\`fingerprint-observer@${observer - 1}\` or earlier did not instrument shared workers at all`));
  assert.match(limitations, /\bChromium gives a shared worker no Worker constructor\b/);
  assert.match(limitations, /\bWorklets are not instrumented\b/);
  assert.doesNotMatch(limitations, /\bShared workers and worklets are not instrumented\b/);
  assert.doesNotMatch(limitations, /\bSharedWorker and WebSocket coverage is absent\b/);
  assert.match(limitations, /\bSharedWorker traffic and WebSocket activity are not recorded\b/);
  // The hold's own cost, in every arm, and GPC kept out of it.
  assert.match(limitations, /\bno arm installs the signal into a shared worker\b/);
  assert.match(limitations, /\blets a worker it held that way run with the debugger off\b/);
  // The debugger window: every late shared worker but one already running
  // when reached runs with the debugger on until the disable lands. A held
  // worker whose install never answered is let run by that disable, so it
  // is not among them.
  const which = /\bThree kinds of shared worker run with the debugger on for a few milliseconds, until the attacher's `Debugger\.disable` reaches them: one whose first pause was at another script or was not the breakpoint's, one whose main script ran before the breakpoint took effect, and one the automation layer's own DevTools session let run while the attacher held it\./.test(
    limitations
  );
  assert.ok(which, "the limitations page must name every late shared worker that has the debugger on, and for how long");
  const debuggerWindow = /\bA `debugger;` statement such a worker reaches in that window pauses it until then\b/.test(limitations);
  assert.ok(debuggerWindow, "the limitations page must say a debugger statement in that window pauses the worker");
  assert.match(limitations, /\bA shared worker already running when the attacher reached it is sent nothing, the debugger included\./);

  assert.match(methodology, /\balso holds each shared worker the page starts at its main script\b/);
  assert.match(methodology, /\bno visit installs the signal in a shared worker\b/);
  assert.match(methodology, /\bor let run by another DevTools client, such as the automation layer's own, while it was held, is never read\b/);
  assert.match(
    methodology,
    /\bunless it was already running when reached, it also runs with the debugger on for a few milliseconds, until the attacher turns it off\b/
  );
  // The traffic sentence stays true: a shared worker's own requests are not recorded.
  assert.match(methodology, /\ba SharedWorker's own traffic beyond the script that starts it is not recorded\b/);

  // And the code. Each late class the pages name sends the debugger off
  // (markLate's `debuggerOn`, and the broken hold's own disable), so it was
  // on until then; the one sent nothing is the worker running at attach.
  const attacher = readFileSync(path.join(root, "lib", "shared-worker-attacher.ts"), "utf8");
  assert.match(attacher, /markLate\(worker, "ran-before-breakpoint", true\)/);
  assert.match(attacher, /markLate\(worker, params\.reason === "instrumentation" \? "other-script" : "other-pause", true\)/);
  assert.match(attacher, /markLate\(worker, "running-at-attach", false\)/);
  assert.match(
    attacher,
    /const breakHold = \(worker: HeldWorker\): void => \{[^}]*reason: "resumed-while-held" \}\);\s*void turnDebuggerOff\(worker\);/,
    "a broken hold sends the debugger off"
  );
  assert.equal((attacher.match(/markLate\(worker, /g) ?? []).length, 3, "every late classification is one the pages account for");
  // The GPC installer names dedicated workers as its only kind.
  const gpc = readFileSync(path.join(root, "lib", "gpc-worker-verification.ts"), "utf8");
  assert.match(gpc, /workerKinds[^;\n]*\["dedicated"\]/);
});

/**
 * Every report links to this catalog, including the reports made before the
 * initiator join counted requests. The causality entry must say what
 * lib/request-initiator-fixture.test.ts observed in the scan browser: a fetch
 * wrapper is credited with what it relays, a script can name itself, and a
 * dedicated worker's requests are never observed. It must name the rows the
 * join refuses for that last reason, and say that earlier reports carry no
 * marker of the rule. Each of those is a claim about code, so each is pinned
 * to the code that makes it true.
 */
test("the causality entry discloses wrappers, self-naming and unobserved workers, and which reports refuse a worker's URL", () => {
  const entry = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "script-to-request-causality");
  assert.ok(entry, "the causality boundary entry must exist");
  assert.match(
    entry.explanation,
    /\bwraps fetch or XMLHttpRequest\b[^.]*\bis credited with every request it relays\b/,
    "the entry must say a wrapper is credited with the requests it relays (fixture case 4)"
  );
  assert.match(
    entry.explanation,
    /\bany name with a sourceURL comment\b/,
    "the entry must say a script can choose the name it is credited under (fixture case 7)"
  );
  assert.match(
    entry.explanation,
    /\bRequests made by a dedicated worker are not observed\b/,
    "the entry must say a dedicated worker's requests are not observed (fixture cases 9 and 11)"
  );

  const kinds = /\bThree kinds of row carry no attribution\b[^.]*\./.exec(entry.explanation)?.[0];
  assert.ok(kinds, "the entry must name every kind of row that carries no attribution");
  assert.match(kinds, /\bno usable initiator\b/);
  assert.match(kinds, /\bmore than one initiator\b/);
  assert.match(kinds, /\brequested more times than the scan received an initiator for it\b/);
  assert.match(kinds, /\bdedicated worker\b/);

  // The third kind is a claim about the join: a URL requested twice and
  // observed once must be refused.
  const index = new RequestInitiatorIndex();
  index.record({ requestUrl: "https://t.example/shared", initiatorUrl: "https://s.example/main.js" });
  index.noteRequest("https://t.example/shared");
  index.noteRequest("https://t.example/shared");
  assert.equal(
    index.claim("https://t.example/shared"),
    null,
    "the entry says a URL requested more times than it was observed carries no attribution, so the join must refuse it"
  );
  // And a claim about the live producer: the count must come from the page's
  // own request listener, registered before the visit navigates. A count of
  // the recorded rows, or one that starts late, misses requests the session
  // observed and lets one of them stand in for a worker's row
  // (lib/scanner.test.ts pins the behavior in a real scan).
  const scanner = readFileSync(path.join(root, "lib", "scanner.ts"), "utf8");
  const registration = scanner.indexOf('page.on("request", noteInitiatorRequest)');
  const navigation = scanner.indexOf(".goto(targetUrl.toString()");
  assert.ok(registration >= 0, "the live producer must count every request the page reports, or the third kind overstates");
  assert.ok(navigation >= 0, "the scanner's navigation was not found");
  assert.ok(registration < navigation, "the live producer must start counting before the visit navigates");

  // Option (i) of the 2026-10-20 attribution design note: no methodology
  // component marks the rule. If one ever does, the entry must name it, as
  // the cross-realm canvas entry names its markers, instead of saying that
  // nothing marks it.
  const earlier = /\bBefore the scan compared those two counts\b[^.]*\./.exec(entry.explanation)?.[0];
  assert.ok(earlier, "the entry must say what reports made before the rule can show");
  assert.match(earlier, /\bthe page's initiator on every row, the worker's included\b/);
  const components = [NODE_SCANNER_METHODOLOGY_VERSION, NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION].flatMap((version) =>
    version.split("+")
  );
  const marker = components.find((component) => /initiator/i.test(component));
  assert.equal(
    /\bnothing in a report's methodology says which rule it was made under\b/.test(earlier),
    marker === undefined,
    marker === undefined
      ? "no methodology component marks the rule, so the entry must say a report's methodology does not say which rule it was made under"
      : `${marker} now marks the initiator rule, so the entry must name it instead of saying nothing marks it`
  );
});

/**
 * "Check after scrolling" shows first-contacted hosts, and only in a check
 * visit's immediate result. The below-the-fold entry keeps its own claim,
 * still true of every report, and scopes the check beside it, each clause
 * pinned to the code that makes it true: a separate visit, scrolled by
 * script up to the scanner's screen limit only after its report is built,
 * and never saved.
 */
test("the below-the-fold entry says a check after scrolling shows first-contacted hosts in its immediate result only", () => {
  const entry = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "below-fold-and-lazy-loaded");
  assert.ok(entry, "the below-the-fold boundary entry must exist");
  assert.match(entry.explanation, /^The visit does not scroll, hover, or click, apart from the two disclosed bounded interactions\./);
  const sentence = /\bAn on-demand check after scrolling\b[^.]*\./.exec(entry.explanation)?.[0];
  assert.ok(sentence, "the entry must describe the check");
  assert.match(sentence, /\bis a separate visit that scrolls its page by script, up to 8 screens, only once its own report is built\b/);
  assert.match(sentence, /\bthe third-party hosts its page first contacted after scrolling began\b/);
  assert.match(sentence, /\bin its immediate result only: never in a report, an export or a printed copy\b/);
  assert.equal(MAX_SCROLL_CHECK_SCREENS, 8, "the entry says 8 screens");
  // The evidence travels only in the ephemeral block, which persistence
  // drops, and the scan API saves nothing from a check visit.
  const runtimeBuilder = readFileSync(path.join(root, "lib", "scan-report-v2-runtime-builder.ts"), "utf8");
  assert.match(runtimeBuilder, /\.\.\.\(scrollCheck === undefined \? \{\} : \{ scrollCheck: structuredClone\(scrollCheck\)/);
  const projection = readFileSync(path.join(root, "lib", "scan-report-v2-r2-projection.ts"), "utf8");
  assert.ok(!/scrollCheck|scroll-check/.test(projection), "the public projection must name no check");
  const api = readFileSync(path.join(root, "lib", "scan-api.ts"), "utf8");
  assert.match(api, /return buildRuntimeScanReportV2R2\(envelope, acquisition\);/, "a check's result is the unsaved immediate shell");
  // The scanner runs the check only after the envelope is built.
  const scanner = readFileSync(path.join(root, "lib", "scanner.ts"), "utf8");
  const built = scanner.indexOf("const envelope = createNodeScanMeasurementEnvelope(");
  const checked = scanner.indexOf("await runScrollCheckPhase(");
  assert.ok(built > 0 && checked > built, "the check must follow the envelope");
});

/**
 * "Inspect this connection" shows call-stack hosts, and only in an
 * inspection visit's immediate result. The causality entry must say so and
 * scope it, each clause pinned to the code that makes it true: at most four
 * hosts, of scripts that visit requested, never saved, and a request with no
 * stack not shown to have been started without a script.
 */
test("the causality entry says an inspection visit shows stack hosts in its immediate result only", () => {
  const entry = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "script-to-request-causality");
  assert.ok(entry, "the causality boundary entry must exist");
  const sentence = /\bAn on-demand inspection visit\b[^.]*\./.exec(entry.explanation)?.[0];
  assert.ok(sentence, "the entry must describe the inspection visit");
  assert.match(sentence, /\bat most four hosts of scripts that visit requested\b/);
  assert.match(sentence, /\bin its immediate result only: never in a report, an export or a printed copy\b/);
  assert.equal(MAX_INSPECTION_GROUP_HOSTS, 4, "the entry says four hosts");
  // The evidence travels only in the ephemeral block, which persistence drops.
  const runtimeBuilder = readFileSync(path.join(root, "lib", "scan-report-v2-runtime-builder.ts"), "utf8");
  assert.match(
    runtimeBuilder,
    /ephemeral: \{\s*\.\.\.report\.ephemeral,\s*\.\.\.\(inspection === undefined \? \{\} : \{ inspection: structuredClone\(inspection\)/
  );
  const projection = readFileSync(path.join(root, "lib", "scan-report-v2-r2-projection.ts"), "utf8");
  assert.ok(!/inspection/.test(projection), "the public projection must name no inspection");
  assert.match(
    entry.explanation,
    /\bA request it shows with no call stack is not shown to have been started without a script\b/,
    "the entry must not let a stackless request read as one no script started (lib/connection-inspection-fixture.test.ts pins why)"
  );
});

/**
 * A check after scrolling can show call-stack hosts for the hosts it first
 * contacted while scrolling, and only in its immediate result. The causality
 * entry and the below-the-fold entry each say so, each clause pinned to the
 * code that makes it true: at most four hosts of scripts the visit requested,
 * carried only by the check's scroll window, which no saved report holds.
 */
test("both entries say a check after scrolling can show call-stack hosts for the hosts it first contacted while scrolling, in its immediate result only", () => {
  const causality = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "script-to-request-causality");
  assert.ok(causality, "the causality boundary entry must exist");
  const sentence = /\bAn on-demand check after scrolling\b[^.]*\./.exec(causality.explanation)?.[0];
  assert.ok(sentence, "the causality entry must describe the check's call-stack hosts");
  assert.match(sentence, /\bfor the hosts it first contacted while scrolling\b/);
  assert.match(sentence, /\bat most four hosts of scripts that visit requested\b/);
  assert.match(sentence, /\bin its immediate result only: never in a report, an export or a printed copy\b/);
  assert.equal(MAX_INSPECTION_GROUP_HOSTS, 4, "the entry says four hosts");
  const belowFold = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "below-fold-and-lazy-loaded");
  assert.ok(belowFold, "the below-the-fold boundary entry must exist");
  const stacks = /\bFor the hosts it first contacted while scrolling\b[^.]*\./.exec(belowFold.explanation)?.[0];
  assert.ok(stacks, "the below-the-fold entry must say the check can show call-stack hosts");
  assert.match(stacks, /\bcall-stack hosts\b/);
  assert.match(stacks, /\bin that immediate result only\b/);
  // The stacks attach to the scroll window alone, inside the check's own
  // evidence, and the check's validator caps a stack at the inspection's
  // four hosts; the check's evidence never reaches a saved report (the
  // below-the-fold test above pins that).
  const check = readFileSync(path.join(root, "lib", "scroll-check.ts"), "utf8");
  assert.match(check, /\{ \.\.\.evidence, scroll: \{ \.\.\.evidence\.scroll, stacks: entries \} \}/);
  const evidence = readFileSync(path.join(root, "lib", "scroll-check-evidence.ts"), "utf8");
  assert.match(evidence, /hosts\.length > MAX_INSPECTION_GROUP_HOSTS/);
});

/**
 * A check after scrolling can show the GA4 and Adobe Analytics events it saw
 * its page send, those sent to the site's own collection addresses included,
 * and only in its immediate result. The below-the-fold entry says so, each
 * clause pinned to the code that makes it true: the decoder recognizes those
 * two formats alone, by path and format parameters, never by host; and the
 * events ride the check's own evidence, which no saved report holds (the
 * below-the-fold test above pins that).
 */
test("the below-the-fold entry says a check after scrolling can show the GA4 and Adobe Analytics events it saw sent, in its immediate result only", () => {
  const belowFold = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "below-fold-and-lazy-loaded");
  assert.ok(belowFold, "the below-the-fold boundary entry must exist");
  const sentence = /\bIt can also show the GA4 and Adobe Analytics events\b[^.]*\./.exec(belowFold.explanation)?.[0];
  assert.ok(sentence, "the below-the-fold entry must say the check can show analytics events");
  assert.match(sentence, /\bit saw the page send in each window\b/);
  assert.match(sentence, /\bincluding those sent to collection addresses on the site itself\b/);
  assert.match(sentence, /\bin that immediate result only\b/);
  assert.match(sentence, /\bonly events in GA4's standard collection format and Adobe Analytics' classic beacons are read, and other analytics tools and formats are not\b/);
  assert.deepEqual([...ANALYTICS_FORMATS], ["GA4", "Adobe Analytics"], "the entry names the two formats the decoder reads");
  const decoder = readFileSync(path.join(root, "lib", "analytics-events.ts"), "utf8");
  assert.match(decoder, /parsed\.pathname\.endsWith\("\/g\/collect"\) && params\.get\("v"\) === "2"/);
  assert.match(decoder, /parsed\.pathname\.includes\("\/b\/ss\/"\)/);
  assert.doesNotMatch(decoder, /\.hostname\b/, "the formats are recognized by path, never by host");
  const check = readFileSync(path.join(root, "lib", "scroll-check.ts"), "utf8");
  assert.match(check, /\{ \.\.\.evidence, events: \{ control, scroll \} \}/);
});

/**
 * A check after scrolling counts only the requests that got an answer, and
 * can show, for each host it lists and each analytics destination, whether
 * its counted requests matched the default filter lists of Brave Shields in
 * the same visit (build brief 2026-10-25). The below-the-fold entry says so,
 * each clause pinned to the code that makes it true: a request counts only
 * once a response arrived for it, fed from the page's own response events;
 * the labels read the page route's own records, never a new engine run; and
 * the words "not a measured block" are the report's own for a match.
 */
test("the below-the-fold entry says a check after scrolling counts only answered requests and can show the same visit's list matches", () => {
  const belowFold = COVERAGE_BOUNDARY_ENTRIES.find((candidate) => candidate.id === "below-fold-and-lazy-loaded");
  assert.ok(belowFold, "the below-the-fold boundary entry must exist");
  const answers = /\bIt counts only the requests that got an answer\b[^.]*\./.exec(belowFold.explanation)?.[0];
  assert.ok(answers, "the below-the-fold entry must say the check counts only answered requests");
  assert.match(answers, /\bsays how many it did not count for want of one\b/);
  const labels = /\bFor each host it lists and each analytics destination\b[^.]*\./.exec(belowFold.explanation)?.[0];
  assert.ok(labels, "the below-the-fold entry must say the check can show the same visit's list matches");
  assert.match(labels, /\bmatched the default filter lists of Brave Shields in that same visit\b/);
  assert.match(labels, /\ba match computed while the page loads normally, not a measured block\b/);
  assert.match(labels, /\bin that immediate result only\b/);
  const check = readFileSync(path.join(root, "lib", "scroll-check.ts"), "utf8");
  assert.match(check, /const counted = countable && answered;/);
  const scanner = readFileSync(path.join(root, "lib", "scanner.ts"), "utf8");
  assert.match(scanner, /page\.on\("response", noteResponse\);/);
  assert.match(scanner, /filterLists: routeListFacts\(adblockEngine !== null, shieldsClassifiedRequests, shieldsMatches\)/);
});

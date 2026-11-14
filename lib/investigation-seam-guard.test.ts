import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * The investigation seam's promise to every visit that does not set it: the
 * scanner and the check run the statements they always ran. This holds the
 * shape of the source that makes it so, in three ways.
 *
 * By use. Every place the scanner or the check reads the seam sits inside a
 * condition that tests the seam's presence, on the side of that condition a
 * visit without a seam never takes. A condition counts only where it adds
 * nothing for such a visit: an `if`, the value a `const` is declared with,
 * or an object spread. One handed to a call as an argument, or used as a
 * property's value, still makes that call or that key for every visit, so
 * it is no guard. A name reached through a string, as in run["boundary"],
 * is a use like any other.
 *
 * By count. A name-based check cannot see a value copied out of a condition
 * and awaited later, or a helper whose body is guarded and whose call is
 * not. So three things are counted where they are written OUTSIDE the seam's
 * conditions in the text of each of the four functions held, and each number
 * is pinned under that function's name:
 *
 * - await expressions, and `for await` loops;
 * - direct calls of a listener method: on, once, addListener,
 *   prependListener, addEventListener;
 * - direct calls of a page-script method: addInitScript, exposeBinding,
 *   exposeFunction.
 *
 * That is all the count is. It is not a count of what a visit does. It does
 * not see a turn added to an existing await's operand (a `.then` on it), a
 * call of any other method (a route, say), or a registration made by a
 * helper that is declared outside the four functions. What a visit does
 * register on its context, its page and its DevTools session, through any
 * helper, is observed in a real browser by lib/visit-setup-calls.test.ts.
 * Neither test observes a listener put on another object, such as the
 * caller's signal, through a helper outside the four functions.
 *
 * By list. The awaits a seam visit adds are listed as source text.
 *
 * It reads the parsed source, so it shows where the seam's statements are,
 * not how long a visit takes. A visit without a seam still evaluates the
 * conditions themselves: one property read and a handful of comparisons.
 *
 * The counts are a change detector for these four functions. A deliberate
 * change to one of them that adds or removes one of the counted things for
 * every visit updates its number in the same commit. The failure says which
 * function and which number, and what to do.
 *
 * The checker is run against planted variants below. Each moves one use of
 * the seam out from behind its condition, or adds one counted thing to
 * every visit in a way the names alone would not show.
 */

const root = process.cwd();
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

type Counts = { awaits: number; listeners: number; pageScripts: number };

type GuardRules = {
  /** The functions held, each with what it does outside the seam's conditions. */
  functions: Readonly<Record<string, Counts>>;
  /** Helpers that only ever run for a seam visit: their bodies are free, their callers are held. */
  seamOnlyFunctions: readonly string[];
  /** A name used as a value, a property read by this name, or the same name as a string key, is a use of the seam. */
  names: ReadonlySet<string>;
  /** Tests whose true side only a seam visit takes. */
  whenTrue: ReadonlySet<string>;
  /** Tests whose false side only a seam visit takes. */
  whenFalse: ReadonlySet<string>;
};

const SCANNER_RULES: GuardRules = {
  functions: {
    scanSiteWithMeasurementOnLeasedBrowser: { awaits: 64, listeners: 10, pageScripts: 4 },
    runScrollCheckPhase: { awaits: 3, listeners: 3, pageScripts: 0 }
  },
  seamOnlyFunctions: ["seamScrollCheckRun"],
  names: new Set(["seam", "seamReads", "seamFingerprintRead", "seamScrollCheckRun", "investigationSeam", "openInvestigationSeam", "investigationSeamReadings"]),
  whenTrue: new Set([
    "seam !== null",
    "seam !== null && seamReads !== null",
    "input.seam !== undefined && input.seamFingerprintRead !== undefined"
  ]),
  whenFalse: new Set(["options.investigationSeam === undefined"])
};

const CHECK_RULES: GuardRules = {
  functions: {
    runScrollCheck: { awaits: 2, listeners: 0, pageScripts: 0 },
    sequence: { awaits: 14, listeners: 0, pageScripts: 0 }
  },
  seamOnlyFunctions: ["awaitBoundary"],
  names: new Set(["boundary", "deadlineMarginMs", "awaitBoundary"]),
  whenTrue: new Set(["run.boundary"]),
  whenFalse: new Set(["run.deadlineMarginMs === undefined"])
};

const LISTENER_METHODS: ReadonlySet<string> = new Set(["on", "once", "addListener", "prependListener", "addEventListener"]);
const PAGE_SCRIPT_METHODS: ReadonlySet<string> = new Set(["addInitScript", "exposeBinding", "exposeFunction"]);
/** What each count is a count of, for the failure message. */
const COUNTED: Readonly<Record<keyof Counts, string>> = {
  awaits: "await expressions and for await loops",
  listeners: `direct calls of ${[...LISTENER_METHODS].join(", ")}`,
  pageScripts: `direct calls of ${[...PAGE_SCRIPT_METHODS].join(", ")}`
};

const text = (node: ts.Node, source: ts.SourceFile): string => node.getText(source).replace(/\s+/g, " ");

/** Whether `inner` is `outer` or inside it. */
function within(inner: ts.Node, outer: ts.Node | undefined): boolean {
  for (let node: ts.Node | undefined = inner; node; node = node.parent) if (node === outer) return true;
  return false;
}

/**
 * Whether a conditional expression adds nothing for a visit on its other
 * side: it is what a `const` is declared with, or what an object spread
 * spreads. Anywhere else (an argument, a property's value, an operand) the
 * thing around it still happens for every visit.
 */
function conditionalStandsAlone(conditional: ts.ConditionalExpression): boolean {
  let node: ts.Node = conditional;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isSpreadAssignment(parent)) return true;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isVariableDeclarationList(parent.parent) &&
    (parent.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Whether a node sits where only a seam visit goes: inside the test, or on
 * the seam's side, of an enclosing condition the rules name.
 */
function onSeamSide(node: ts.Node, source: ts.SourceFile, rules: GuardRules): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const test = ts.isIfStatement(current) ? current.expression : ts.isConditionalExpression(current) ? current.condition : undefined;
    if (!test) continue;
    if (ts.isConditionalExpression(current) && !conditionalStandsAlone(current)) continue;
    const seamSideTrue = ts.isIfStatement(current) ? current.thenStatement : (current as ts.ConditionalExpression).whenTrue;
    const seamSideFalse = ts.isIfStatement(current) ? current.elseStatement : (current as ts.ConditionalExpression).whenFalse;
    const condition = text(test, source);
    if (rules.whenTrue.has(condition) && (within(node, test) || within(node, seamSideTrue))) return true;
    if (rules.whenFalse.has(condition) && (within(node, test) || within(node, seamSideFalse))) return true;
  }
  return false;
}

/** The top-level function a node is declared in, if any. */
function owningFunction(node: ts.Node): string | null {
  let outermost: string | null = null;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) outermost = current.name.text;
  }
  return outermost;
}

/**
 * Everything in `file` that a visit without a seam could reach and should
 * not: a use of the seam outside the held functions, or inside them with no
 * enclosing condition on whose seam side it sits; and, for each held
 * function, a count of the await expressions or of the direct calls of the
 * listed methods written outside the seam's conditions that is not the
 * pinned one.
 */
function seamProblems(fileName: string, sourceText: string, rules: GuardRules): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const counts = new Map<string, Counts>(Object.keys(rules.functions).map((name) => [name, { awaits: 0, listeners: 0, pageScripts: 0 }]));
  let uses = 0;
  const isUse = (node: ts.Node): boolean => {
    const parent = node.parent;
    // A name as a string: run["boundary"], { "boundary": callback }.
    if (ts.isStringLiteralLike(node)) {
      if (!rules.names.has(node.text)) return false;
      return (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) || (ts.isPropertyAssignment(parent) && parent.name === node) || ts.isComputedPropertyName(parent);
    }
    if (!ts.isIdentifier(node) || !rules.names.has(node.text)) return false;
    // A type, an import and a declared name read nothing at run time.
    for (let current: ts.Node | undefined = parent; current; current = current.parent) {
      if (ts.isTypeNode(current) || ts.isImportDeclaration(current) || ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current)) return false;
    }
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
    if (ts.isParameter(parent) && parent.name === node) return false;
    if (ts.isPropertySignature(parent)) return false;
    return true;
  };
  const visit = (node: ts.Node): void => {
    const owner = owningFunction(node);
    const where = (): string => `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${text(node.parent, source).slice(0, 90)}`;
    if (isUse(node)) {
      if (owner !== null && rules.seamOnlyFunctions.includes(owner)) {
        // Free inside; its callers are uses of its own name, held like any other.
      } else if (owner === null || !(owner in rules.functions)) {
        problems.push(`outside the held functions: ${where()}`);
      } else {
        uses += 1;
        if (!onSeamSide(node, source, rules)) problems.push(`not behind the seam's presence: ${where()}`);
      }
    }
    const held = owner === null ? undefined : counts.get(owner);
    if (held && !onSeamSide(node, source, rules)) {
      if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) held.awaits += 1;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (LISTENER_METHODS.has(node.expression.name.text)) held.listeners += 1;
        if (PAGE_SCRIPT_METHODS.has(node.expression.name.text)) held.pageScripts += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (uses < 4) problems.push(`${fileName}: only ${uses} uses of the seam were found, so the walk did not see the code it holds`);
  for (const [name, pinned] of Object.entries(rules.functions)) {
    const found = counts.get(name) as Counts;
    for (const kind of ["awaits", "listeners", "pageScripts"] as const) {
      if (found[kind] !== pinned[kind]) {
        problems.push(
          `${fileName} ${name}: ${found[kind]} ${kind} outside the seam's conditions, where ${pinned[kind]} are pinned (${COUNTED[kind]}, as written in ${name}). ` +
            "If this statement is meant for every visit, update the pinned count; if it belongs to the seam, put it behind the seam's condition."
        );
      }
    }
  }
  return problems;
}

/** Each await only a seam visit reaches: one on the seam's side of a condition, as source text. */
function seamAwaits(fileName: string, sourceText: string, rules: GuardRules): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && onSeamSide(node, source, rules)) found.push(text(node, source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function replaceOnce(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length - 1, 1, `expected exactly one occurrence of: ${from}`);
  return source.replace(from, to);
}

test("every use of the seam in the scanner and in the check sits behind the seam's presence, and the awaits and listed calls written outside it in the four held functions are the pinned number", () => {
  const scanner = read("lib/scanner.ts");
  const check = read("lib/scroll-check.ts");
  assert.deepEqual(seamProblems("lib/scanner.ts", scanner, SCANNER_RULES), []);
  assert.deepEqual(seamProblems("lib/scroll-check.ts", check, CHECK_RULES), []);

  // The awaits a seam adds, all of them, each behind its condition. None is
  // written as an optional call, which would yield to the event loop on a
  // visit that has no seam.
  assert.deepEqual(seamAwaits("lib/scanner.ts", scanner, SCANNER_RULES), [
    "await withSetupTimeout(seam.pageReady(page, options.signal), started)",
    "await withSetupTimeout(page.addInitScript({ content: seam.initScript }), started)",
    "await seam.afterEnvelope(seamReads.readings, options.signal)"
  ]);
  assert.deepEqual(seamAwaits("lib/scroll-check.ts", check, CHECK_RULES), [
    'await awaitBoundary(run.boundary, "check-start", withinDeadline)',
    'await awaitBoundary(run.boundary, "control-start", withinDeadline)',
    'await awaitBoundary(run.boundary, "control-end", withinDeadline)',
    'await awaitBoundary(run.boundary, "scroll-end", withinDeadline)'
  ]);
  assert.equal(/\bseam\?\./.test(scanner), false, "the scanner reads its seam through an optional chain");
  assert.equal(/run\.boundary\?\./.test(check), false, "the check calls its boundary through an optional chain");

  // The option is read in one place, and the one init script a seam adds is
  // the only one the scanner adds from a value.
  assert.equal(scanner.split("options.investigationSeam").length - 1, 2, "the option is read once: its test and its use, in one expression");
  assert.equal(scanner.split("page.addInitScript({ content: seam.initScript })").length - 1, 1);
  assert.equal(scanner.split("addInitScript({").length - 1, 1);

  // The check's margin: the constant is what it was, the deadline adds
  // whichever margin it is handed, and a run that names none makes the call
  // it always made.
  assert.match(check, /^export const SCROLL_CHECK_DEADLINE_MARGIN_MS = 2_000;$/m);
  assert.match(check, /marginMs: number = SCROLL_CHECK_DEADLINE_MARGIN_MS\n\): number \{/);
  assert.match(check, /sequenceEnd \+ marginMs\);/);
  assert.match(
    check,
    /run\.deadlineMarginMs === undefined\s+\? scrollCheckDeadline\(run\.timing, run\.navigationStartedAt, run\.startedAt\)\s+: scrollCheckDeadline\(run\.timing, run\.navigationStartedAt, run\.startedAt, run\.deadlineMarginMs\);/
  );
});

test("the checker refuses each planted way a use of the seam leaves its condition, or an await or a listed call is added for every visit, and says what to do", () => {
  const scanner = read("lib/scanner.ts");
  const check = read("lib/scroll-check.ts");
  const RELEASE = "    if (seam !== null) seam.release();";
  const MARK = "    if (seam !== null) seam.markVisit(envelope);";
  const INIT = "      if (seam.initScript !== null) {\n        await withSetupTimeout(page.addInitScript({ content: seam.initScript }), started);\n      }\n    }";
  const scannerVariants: [string, string, string, RegExp][] = [
    [
      "a hook called through an optional chain, with no condition",
      "if (seam !== null) seam.finalFingerprintRead(tentativeFingerprintCollection);",
      "seam?.finalFingerprintRead(tentativeFingerprintCollection);",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ seam\?\.finalFingerprintRead/
    ],
    ["the release called through an optional chain", RELEASE, "    seam?.release();", /not behind the seam's presence: lib\/scanner\.ts:\d+ seam\?\.release/],
    [
      "a condition of the wrong sense",
      "if (seam !== null) seam.markVisit(envelope);",
      "if (seam === null) seam!.markVisit(envelope);",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ seam === null/
    ],
    [
      "an awaited hook with no condition",
      "await seam.afterEnvelope(seamReads.readings, options.signal);\n    }",
      "}\n    await seam?.afterEnvelope(seamReads!.readings, options.signal);",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ seam\?\.afterEnvelope/
    ],
    [
      "a key set on every check's input",
      "...(seam !== null && seamReads !== null ? { seam, seamFingerprintRead: seamReads.readFingerprint } : {})",
      "seam: seam ?? undefined",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ seam: seam \?\? undefined/
    ],
    [
      "a key set on every check's input, its value behind a condition",
      "...(seam !== null && seamReads !== null ? { seam, seamFingerprintRead: seamReads.readFingerprint } : {})",
      "seam: seam !== null ? seam : undefined",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ /
    ],
    [
      "the check's seam fields built for every check",
      "...(input.seam !== undefined && input.seamFingerprintRead !== undefined\n        ? seamScrollCheckRun(input.seam, input.seamFingerprintRead)\n        : {})",
      "...seamScrollCheckRun(input.seam!, input.seamFingerprintRead!)",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ seamScrollCheckRun\(/
    ],
    [
      "the option read a second time, in another function",
      "function proxyCaptureLossCount(diagnostics: PublicScanProxyDiagnostics): number {",
      "function proxyCaptureLossCount(diagnostics: PublicScanProxyDiagnostics, options: ScanSiteOptions = {}): number {\n  void options.investigationSeam;",
      /outside the held functions: lib\/scanner\.ts:\d+ options\.investigationSeam/
    ],
    // The variants a check by name alone passes. Each adds an await, a
    // listener or a page script to every visit.
    [
      "a promise set inside the condition and awaited outside it, for every visit",
      MARK,
      `${MARK}\n    let marked: Promise<void> | null = null;\n    if (seam !== null) marked = Promise.resolve();\n    await marked;`,
      /lib\/scanner\.ts scanSiteWithMeasurementOnLeasedBrowser: \d+ awaits outside the seam's conditions, where \d+ are pinned/
    ],
    [
      "a helper awaited for every visit, its body behind the condition",
      RELEASE,
      "    const releaseSeam = async (): Promise<void> => {\n      if (seam !== null) seam.release();\n    };\n    await releaseSeam();",
      /lib\/scanner\.ts scanSiteWithMeasurementOnLeasedBrowser: \d+ awaits outside the seam's conditions, where \d+ are pinned/
    ],
    [
      "a listener added for every visit, its body behind the condition",
      MARK,
      `${MARK}\n    options.signal?.addEventListener("abort", () => {\n      if (seam !== null) seam.release();\n    });`,
      /lib\/scanner\.ts scanSiteWithMeasurementOnLeasedBrowser: \d+ listeners outside the seam's conditions, where \d+ are pinned/
    ],
    [
      "an init script added for every visit, its text behind a condition",
      INIT,
      `${INIT}\n    await page.addInitScript(seam !== null ? seam.description.version : "0;");`,
      /lib\/scanner\.ts scanSiteWithMeasurementOnLeasedBrowser: \d+ pageScripts outside the seam's conditions, where \d+ are pinned/
    ],
    [
      "an init script added for every visit and not awaited",
      INIT,
      `${INIT}\n    void page.addInitScript("0;");`,
      /lib\/scanner\.ts scanSiteWithMeasurementOnLeasedBrowser: 5 pageScripts outside the seam's conditions, where 4 are pinned/
    ],
    [
      "a listener added for every visit and its registration discarded",
      MARK,
      `${MARK}\n    void page.once("close", () => undefined);`,
      /lib\/scanner\.ts scanSiteWithMeasurementOnLeasedBrowser: 11 listeners outside the seam's conditions, where 10 are pinned/
    ]
  ];
  for (const [what, from, to, problem] of scannerVariants) {
    const problems = seamProblems("lib/scanner.ts", replaceOnce(scanner, from, to), SCANNER_RULES);
    assert.ok(problems.some((line) => problem.test(line)), `${what} was not refused: ${JSON.stringify(problems)}`);
  }
  // The last of those is refused three ways: by the count of page scripts
  // above, by the count of awaits, and because a condition handed to a call
  // as its argument is no guard for what it holds.
  const everyVisit = seamProblems("lib/scanner.ts", replaceOnce(scanner, INIT, `${INIT}\n    await page.addInitScript(seam !== null ? seam.description.version : "0;");`), SCANNER_RULES);
  assert.ok(everyVisit.some((line) => /\d+ awaits outside the seam's conditions/.test(line)), JSON.stringify(everyVisit));
  assert.ok(everyVisit.some((line) => /not behind the seam's presence: lib\/scanner\.ts:\d+ seam\.description/.test(line)), JSON.stringify(everyVisit));

  const CHECK_START = 'if (run.boundary) await awaitBoundary(run.boundary, "check-start", withinDeadline);';
  const checkVariants: [string, string, string, RegExp][] = [
    [
      "a boundary awaited through an optional call",
      CHECK_START,
      'await run.boundary?.("check-start", new AbortController().signal);',
      /not behind the seam's presence: lib\/scroll-check\.ts:\d+ run\.boundary/
    ],
    [
      "the callback read through a string and awaited for every run",
      CHECK_START,
      `${CHECK_START}\n  const callback = run["boundary"];\n  await callback?.("check-start", new AbortController().signal);`,
      /not behind the seam's presence: lib\/scroll-check\.ts:\d+ run\["boundary"\]/
    ],
    [
      "the callback read through a string and awaited for every run, by count",
      CHECK_START,
      `${CHECK_START}\n  const callback = run["boundary"];\n  await callback?.("check-start", new AbortController().signal);`,
      /lib\/scroll-check\.ts sequence: \d+ awaits outside the seam's conditions, where \d+ are pinned/
    ],
    [
      "the margin handed to every deadline",
      "run.deadlineMarginMs === undefined\n      ? scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt)\n      : scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt, run.deadlineMarginMs);",
      "scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt, run.deadlineMarginMs);",
      /not behind the seam's presence: lib\/scroll-check\.ts:\d+ run\.deadlineMarginMs/
    ],
    [
      "the helper that makes the call, awaited for every run",
      CHECK_START,
      `${CHECK_START}\n  await awaitBoundary(async () => undefined, "check-start", withinDeadline);`,
      /not behind the seam's presence: lib\/scroll-check\.ts:\d+ awaitBoundary\(/
    ],
    [
      "a turn for every run through a for await loop, fed from behind the condition",
      CHECK_START,
      `${CHECK_START}\n  let boundaryDone: Promise<void> | null = null;\n  if (run.boundary) boundaryDone = Promise.resolve();\n  for await (const _ of [boundaryDone]) void _;`,
      /lib\/scroll-check\.ts sequence: 15 awaits outside the seam's conditions, where 14 are pinned/
    ]
  ];
  for (const [what, from, to, problem] of checkVariants) {
    const problems = seamProblems("lib/scroll-check.ts", replaceOnce(check, from, to), CHECK_RULES);
    assert.ok(problems.some((line) => problem.test(line)), `${what} was not refused: ${JSON.stringify(problems)}`);
  }
  // A count that moved says which function, both numbers, what is counted
  // and what a maintainer does about it.
  const moved = seamProblems("lib/scroll-check.ts", replaceOnce(check, CHECK_START, `${CHECK_START}\n  await Promise.resolve();`), CHECK_RULES);
  assert.deepEqual(moved, [
    "lib/scroll-check.ts sequence: 15 awaits outside the seam's conditions, where 14 are pinned (await expressions and for await loops, as written in sequence). " +
      "If this statement is meant for every visit, update the pinned count; if it belongs to the seam, put it behind the seam's condition."
  ]);
  // A file with the seam's code gone is refused too, not passed for want of anything to find.
  const empty = seamProblems("empty.ts", "export const nothing = 1;\n", SCANNER_RULES);
  assert.equal(empty[0], "empty.ts: only 0 uses of the seam were found, so the walk did not see the code it holds");
  // An await removed for every visit moves the number as one added does.
  const fewer = seamProblems("lib/scroll-check.ts", replaceOnce(check, "  await waitUntil(run.navigationStartedAt + timing.settleAfterNavigationMs);", "  void waitUntil(run.navigationStartedAt + timing.settleAfterNavigationMs);"), CHECK_RULES);
  assert.ok(fewer.some((line) => /lib\/scroll-check\.ts sequence: \d+ awaits outside the seam's conditions/.test(line)), JSON.stringify(fewer));
});

test("no formal-verification suite sets the seam, so each of the register's rows holds for a visit without it", () => {
  const manifest = JSON.parse(read("RELEASE_READINESS.json")) as {
    gates: { "formal-verification": { requiredSuites: { id: string }[] } };
  };
  const suites = manifest.gates["formal-verification"].requiredSuites.map((suite) => suite.id);
  assert.equal(suites.length, 21);
  assert.ok(suites.includes("lib/fv-scroll-producer.test.ts") && suites.includes("lib/fv-worker-readout.test.ts"));
  // The option by any of its names, and the two fields only a seam hands a check.
  const seamNames = /investigationSeam|deadlineMarginMs|\bboundary\s*[:=(]|\.boundary\b/i;
  for (const suite of suites) {
    const lines = read(suite).split("\n").filter((line) => seamNames.test(line));
    assert.deepEqual(lines, [], `${suite} names the seam, so docs/formal-verification.md can no longer say its rows hold without it`);
  }
  // The pattern finds what it is for.
  for (const line of ['run.boundary = async () => undefined;', "{ boundary: (name) => hook(name) }", "deadlineMarginMs: 60_000", "investigationSeam: {}", "type InvestigationSeam"]) {
    assert.equal(seamNames.test(line), true, line);
  }
  assert.match(read("docs/formal-verification.md"), /^- Anything about a visit made with the scanner's investigation seam set\./m);
});

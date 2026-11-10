import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * The investigation seam's promise to every visit that does not set it: the
 * scanner and the check run the statements they always ran. This holds the
 * shape of the source that makes it so. Every place the scanner or the check
 * reads the seam sits inside a condition that tests the seam's presence, on
 * the side of that condition a visit without a seam never takes.
 *
 * It reads the parsed source, so it shows where the seam's statements are,
 * not how long a visit takes. A visit without a seam still evaluates the
 * conditions themselves: one property read and a handful of comparisons.
 *
 * The checker is run against planted variants below, each of which moves one
 * use of the seam out from behind its condition.
 */

const root = process.cwd();
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

type GuardRules = {
  /** The functions whose bodies are held; a use anywhere else in the file is refused outright. */
  functions: readonly string[];
  /** Helpers that only ever run for a seam visit: their bodies are free, their callers are held. */
  seamOnlyFunctions: readonly string[];
  /** A name used as a value, or a property read by this name, is a use of the seam. */
  names: ReadonlySet<string>;
  /** Tests whose true side only a seam visit takes. */
  whenTrue: ReadonlySet<string>;
  /** Tests whose false side only a seam visit takes. */
  whenFalse: ReadonlySet<string>;
};

const SCANNER_RULES: GuardRules = {
  functions: ["scanSiteWithMeasurementOnLeasedBrowser", "runScrollCheckPhase"],
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
  functions: ["runScrollCheck", "sequence"],
  seamOnlyFunctions: ["awaitBoundary"],
  names: new Set(["boundary", "deadlineMarginMs", "awaitBoundary"]),
  whenTrue: new Set(["run.boundary"]),
  whenFalse: new Set(["run.deadlineMarginMs === undefined"])
};

const text = (node: ts.Node, source: ts.SourceFile): string => node.getText(source).replace(/\s+/g, " ");

/** Whether `inner` is `outer` or inside it. */
function within(inner: ts.Node, outer: ts.Node | undefined): boolean {
  for (let node: ts.Node | undefined = inner; node; node = node.parent) if (node === outer) return true;
  return false;
}

/**
 * Whether a node sits where only a seam visit goes: inside the test, or on
 * the seam's side, of an enclosing condition the rules name.
 */
function onSeamSide(node: ts.Node, source: ts.SourceFile, rules: GuardRules): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const test = ts.isIfStatement(current) ? current.expression : ts.isConditionalExpression(current) ? current.condition : undefined;
    if (!test) continue;
    const seamSideTrue = ts.isIfStatement(current) ? current.thenStatement : (current as ts.ConditionalExpression).whenTrue;
    const seamSideFalse = ts.isIfStatement(current) ? current.elseStatement : (current as ts.ConditionalExpression).whenFalse;
    const condition = text(test, source);
    if (rules.whenTrue.has(condition) && (within(node, test) || within(node, seamSideTrue))) return true;
    if (rules.whenFalse.has(condition) && (within(node, test) || within(node, seamSideFalse))) return true;
  }
  return false;
}

/**
 * Every use of the seam in `file` that a visit without a seam could reach:
 * one outside the held functions, or one inside them with no enclosing
 * condition from the rules on whose seam side it sits.
 */
function unguardedSeamUses(fileName: string, sourceText: string, rules: GuardRules): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  let uses = 0;
  const functionOf = (node: ts.Node): string | null => {
    let outermost: string | null = null;
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) && current.name) outermost = current.name.text;
    }
    return outermost;
  };
  const isUse = (node: ts.Identifier): boolean => {
    if (!rules.names.has(node.text)) return false;
    const parent = node.parent;
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
    if (ts.isIdentifier(node) && isUse(node)) {
      const owner = functionOf(node);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const where = `${fileName}:${line} ${text(node.parent, source).slice(0, 90)}`;
      if (owner !== null && rules.seamOnlyFunctions.includes(owner)) {
        // Free inside; its callers are uses of its own name, held like any other.
      } else if (owner === null || !rules.functions.includes(owner)) {
        problems.push(`outside the held functions: ${where}`);
      } else {
        uses += 1;
        if (!onSeamSide(node, source, rules)) problems.push(`not behind the seam's presence: ${where}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (uses < 4) problems.push(`${fileName}: only ${uses} uses of the seam were found, so the walk did not see the code it holds`);
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

test("every use of the seam in the scanner and in the check sits behind the seam's presence", () => {
  const scanner = read("lib/scanner.ts");
  const check = read("lib/scroll-check.ts");
  assert.deepEqual(unguardedSeamUses("lib/scanner.ts", scanner, SCANNER_RULES), []);
  assert.deepEqual(unguardedSeamUses("lib/scroll-check.ts", check, CHECK_RULES), []);

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

test("the checker refuses each way a use of the seam could leave its condition", () => {
  const scanner = read("lib/scanner.ts");
  const check = read("lib/scroll-check.ts");
  const scannerVariants: [string, string, string, RegExp][] = [
    [
      "a hook called through an optional chain, with no condition",
      "if (seam !== null) seam.finalFingerprintRead(tentativeFingerprintCollection);",
      "seam?.finalFingerprintRead(tentativeFingerprintCollection);",
      /not behind the seam's presence: lib\/scanner\.ts:\d+ seam\?\.finalFingerprintRead/
    ],
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
    ]
  ];
  for (const [what, from, to, problem] of scannerVariants) {
    const problems = unguardedSeamUses("lib/scanner.ts", replaceOnce(scanner, from, to), SCANNER_RULES);
    assert.ok(problems.some((line) => problem.test(line)), `${what} was not refused: ${JSON.stringify(problems)}`);
  }
  const checkVariants: [string, string, string, RegExp][] = [
    [
      "a boundary awaited through an optional call",
      'if (run.boundary) await awaitBoundary(run.boundary, "check-start", withinDeadline);',
      'await run.boundary?.("check-start", new AbortController().signal);',
      /not behind the seam's presence: lib\/scroll-check\.ts:\d+ run\.boundary/
    ],
    [
      "the margin handed to every deadline",
      "run.deadlineMarginMs === undefined\n      ? scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt)\n      : scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt, run.deadlineMarginMs);",
      "scrollCheckDeadline(run.timing, run.navigationStartedAt, run.startedAt, run.deadlineMarginMs);",
      /not behind the seam's presence: lib\/scroll-check\.ts:\d+ run\.deadlineMarginMs/
    ]
  ];
  for (const [what, from, to, problem] of checkVariants) {
    const problems = unguardedSeamUses("lib/scroll-check.ts", replaceOnce(check, from, to), CHECK_RULES);
    assert.ok(problems.some((line) => problem.test(line)), `${what} was not refused: ${JSON.stringify(problems)}`);
  }
  // A file with the seam's code gone is refused too, not passed for want of anything to find.
  assert.deepEqual(unguardedSeamUses("empty.ts", "export const nothing = 1;\n", SCANNER_RULES), [
    "empty.ts: only 0 uses of the seam were found, so the walk did not see the code it holds"
  ]);
});

test("no formal-verification suite sets the seam, so each of the register's rows holds for a visit without it", () => {
  const manifest = JSON.parse(read("RELEASE_READINESS.json")) as {
    gates: { "formal-verification": { requiredSuites: { id: string }[] } };
  };
  const suites = manifest.gates["formal-verification"].requiredSuites.map((suite) => suite.id);
  assert.equal(suites.length, 16);
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

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { parseCorrectionsLedger, parsedCorrectionsLedgerReportIds } from "./corrections-ledger-model";

/**
 * Retention prunes public/reports on every featured refresh, and a test that
 * reads one report there by a literal id then fails that refresh's proposal on
 * a missing file (2026-09-28). This guard finds every such read in the test
 * sources and requires each id to be published at HEAD and pinned by the
 * corrections ledger, the only pin retention honors, so an unpinned read fails
 * when it is written rather than weeks later on an automation branch.
 */

const REPORT_ID = /\b\d{8}-[0-9a-f]{32}\b/g;
const REMEDY = "freeze it under test-fixtures/reports and read it through lib/pinned-reports.ts";
/** lib/pinned-reports.ts helpers that read public/reports; each takes the report id first. */
const COMMITTED_READ_HELPERS = new Set(["ledgerPinnedReportWire", "ledgerPinnedReportView"]);
const FILE_READS = new Set(["readFileSync", "readFile"]);
const ELEMENT_CALLBACKS = new Set(["forEach", "map", "flatMap", "filter", "some", "every", "find"]);
const MAX_DEPTH = 16;

type Source = { file: string; text: string };
type CommittedRead = { file: string; line: number; id: string };

/**
 * Reads of public/reports under the repository root whose report id resolves
 * to a literal: inline, through a const, a const array or object (for-of,
 * element and property access, destructuring, array callbacks), or through a
 * function parameter traced to the literal arguments of its call sites. A
 * read whose id comes from the corpus itself (a directory listing, the
 * corrections ledger) selects by property and is not a literal read.
 */
function committedReportReads(sources: readonly Source[]): CommittedRead[] {
  const program = ts.createProgram({
    rootNames: sources.map((source) => source.file),
    options: { allowJs: true, noLib: true, noResolve: true, noEmit: true, types: [] },
    host: sourceHost(sources)
  });
  const checker = program.getTypeChecker();
  const reads: CommittedRead[] = [];
  for (const source of sources) {
    const sourceFile = program.getSourceFile(source.file);
    if (!sourceFile) throw new Error(`${source.file} did not parse`);
    reads.push(...fileReads(sourceFile, checker));
  }
  return reads;
}

function sourceHost(sources: readonly Source[]): ts.CompilerHost {
  const texts = new Map(sources.map((source) => [source.file, source.text]));
  return {
    getSourceFile: (fileName, languageVersion) => {
      const text = texts.get(fileName);
      if (text === undefined) return undefined;
      const kind = fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
      return ts.createSourceFile(fileName, text, languageVersion, true, kind);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => texts.has(fileName),
    readFile: (fileName) => texts.get(fileName)
  };
}

function fileReads(sourceFile: ts.SourceFile, checker: ts.TypeChecker): CommittedRead[] {
  const calls: ts.CallExpression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) current = current.expression;
    return current;
  };

  const calleeName = (callee: ts.Expression): string | undefined => {
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return undefined;
  };

  // Every expression `node` can evaluate to, following bindings to their sources.
  const values = (node: ts.Expression, depth: number): ts.Expression[] => {
    if (depth > MAX_DEPTH) return [];
    const expression = unwrap(node);
    if (ts.isConditionalExpression(expression)) {
      return [...values(expression.whenTrue, depth + 1), ...values(expression.whenFalse, depth + 1)];
    }
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [...values(expression.left, depth + 1), ...values(expression.right, depth + 1)];
    }
    if (ts.isIdentifier(expression)) return bindingValues(expression, depth + 1);
    if (ts.isElementAccessExpression(expression)) {
      const index = unwrap(expression.argumentExpression);
      return elements(expression.expression, depth + 1, ts.isNumericLiteral(index) ? Number(index.text) : undefined);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return properties(expression.expression, expression.name.text, depth + 1);
    }
    return [expression];
  };

  const elements = (collection: ts.Expression, depth: number, index?: number): ts.Expression[] => {
    const found: ts.Expression[] = [];
    for (const terminal of values(collection, depth)) {
      if (!ts.isArrayLiteralExpression(terminal)) continue;
      terminal.elements.forEach((element, position) => {
        if (ts.isSpreadElement(element)) {
          if (index === undefined) found.push(...elements(element.expression, depth + 1));
        } else if (index === undefined || index === position) {
          found.push(...values(element, depth + 1));
        }
      });
    }
    return found;
  };

  const properties = (object: ts.Expression, key: string, depth: number): ts.Expression[] => {
    const found: ts.Expression[] = [];
    for (const terminal of values(object, depth)) {
      if (!ts.isObjectLiteralExpression(terminal)) continue;
      for (const property of terminal.properties) {
        if (ts.isPropertyAssignment(property) && propertyKey(property.name) === key) {
          found.push(...values(property.initializer, depth + 1));
        } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) {
          found.push(...values(property.name, depth + 1));
        }
      }
    }
    return found;
  };

  const propertyKey = (name: ts.PropertyName): string | undefined =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

  const forOfOver = (declaration: ts.VariableDeclaration): ts.ForOfStatement | undefined => {
    const statement = declaration.parent.parent;
    return ts.isForOfStatement(statement) && statement.initializer === declaration.parent ? statement : undefined;
  };

  const bindingValues = (identifier: ts.Identifier, depth: number): ts.Expression[] => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return [];
    if (ts.isVariableDeclaration(declaration)) return declarationValues(declaration, depth);
    if (ts.isBindingElement(declaration)) return bindingElementValues(declaration, depth);
    if (ts.isParameter(declaration)) return argumentValues(declaration, depth);
    return [];
  };

  const declarationValues = (declaration: ts.VariableDeclaration, depth: number): ts.Expression[] => {
    const loop = forOfOver(declaration);
    if (loop) return elements(loop.expression, depth + 1);
    return declaration.initializer ? values(declaration.initializer, depth + 1) : [];
  };

  const bindingElementValues = (element: ts.BindingElement, depth: number): ts.Expression[] => {
    if (element.dotDotDotToken || depth > MAX_DEPTH) return [];
    const pattern = element.parent;
    const holder = pattern.parent;
    let bound: ts.Expression[];
    if (ts.isVariableDeclaration(holder)) bound = declarationValues(holder, depth + 1);
    else if (ts.isBindingElement(holder)) bound = bindingElementValues(holder, depth + 1);
    else if (ts.isParameter(holder)) bound = argumentValues(holder, depth + 1);
    else return [];
    if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(element);
      return bound.flatMap((value) => elements(value, depth + 1, index));
    }
    const key = propertyKey(element.propertyName ?? (element.name as ts.Identifier));
    return key === undefined ? [] : bound.flatMap((value) => properties(value, key, depth + 1));
  };

  const argumentValues = (parameter: ts.ParameterDeclaration, depth: number): ts.Expression[] => {
    if (parameter.dotDotDotToken || depth > MAX_DEPTH) return [];
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    const call = fn.parent;
    // `ids.forEach((id) => ...)`: the first parameter is each element.
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isCallExpression(call) &&
      call.arguments.includes(fn) &&
      ts.isPropertyAccessExpression(call.expression) &&
      ELEMENT_CALLBACKS.has(call.expression.name.text)
    ) {
      return index === 0 ? elements(call.expression.expression, depth + 1) : [];
    }
    let name: ts.Identifier | undefined;
    if (ts.isFunctionDeclaration(fn)) name = fn.name;
    else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent)) {
      name = ts.isIdentifier(fn.parent.name) ? fn.parent.name : undefined;
    }
    const target = name && checker.getSymbolAtLocation(name);
    if (!target) return [];
    return calls
      .filter((site) => ts.isIdentifier(site.expression) && checker.getSymbolAtLocation(site.expression) === target)
      .flatMap((site) => (site.arguments[index] ? values(site.arguments[index], depth + 1) : []));
  };

  const literalIds = (node: ts.Expression, depth: number): string[] => {
    const ids: string[] = [];
    for (const terminal of values(node, depth)) {
      if (ts.isStringLiteralLike(terminal)) {
        ids.push(...(terminal.text.match(REPORT_ID) ?? []));
      } else if (ts.isTemplateExpression(terminal)) {
        ids.push(...(terminal.head.text.match(REPORT_ID) ?? []));
        for (const span of terminal.templateSpans) {
          ids.push(...literalIds(span.expression, depth + 1), ...(span.literal.text.match(REPORT_ID) ?? []));
        }
      } else if (ts.isBinaryExpression(terminal) && terminal.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        ids.push(...literalIds(terminal.left, depth + 1), ...literalIds(terminal.right, depth + 1));
      }
    }
    return ids;
  };

  const isCwd = (node: ts.Expression, depth: number): boolean => {
    const found = values(node, depth);
    return (
      found.length > 0 &&
      found.every(
        (value) =>
          ts.isCallExpression(value) &&
          ts.isPropertyAccessExpression(value.expression) &&
          ts.isIdentifier(value.expression.expression) &&
          value.expression.expression.text === "process" &&
          value.expression.name.text === "cwd"
      )
    );
  };

  const isText = (node: ts.Expression | undefined, text: string): boolean =>
    node !== undefined && ts.isStringLiteralLike(unwrap(node)) && (unwrap(node) as ts.StringLiteralLike).text === text;

  // The id-bearing parts of a path under the repository's public/reports, or
  // null when the path is not there (a temporary root, test-fixtures).
  const corpusIdParts = (node: ts.Expression, depth: number): ts.Expression[] | null => {
    let matched = false;
    const parts: ts.Expression[] = [];
    for (const value of values(node, depth)) {
      const found = corpusTerminalParts(value, depth + 1);
      if (found) {
        matched = true;
        parts.push(...found);
      }
    }
    return matched ? parts : null;
  };

  const corpusTerminalParts = (value: ts.Expression, depth: number): ts.Expression[] | null => {
    if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
      const text = ts.isTemplateExpression(value) ? value.head.text : value.text;
      return text.replace(/^\.\//, "").startsWith("public/reports") ? [value] : null;
    }
    if (depth > MAX_DEPTH) return null;
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return corpusIdParts(value.left, depth + 1) ? [value] : null;
    }
    if (!ts.isCallExpression(value)) return null;
    const name = calleeName(value.expression);
    if (name !== "join" && name !== "resolve") return null;
    const args = value.arguments;
    let start = 0;
    while (start < args.length && isCwd(args[start], depth + 1)) start++;
    if (start >= args.length) return null;
    const base = corpusIdParts(args[start], depth + 1);
    if (base) return [...base, ...args.slice(start + 1)];
    if (isText(args[start], "public") && isText(args[start + 1], "reports")) return args.slice(start + 2);
    return null;
  };

  const reads: CommittedRead[] = [];
  for (const call of calls) {
    const name = calleeName(call.expression);
    let parts: ts.Expression[] | null = null;
    if (name && COMMITTED_READ_HELPERS.has(name) && call.arguments[0]) parts = [call.arguments[0]];
    else if (name && FILE_READS.has(name) && call.arguments[0]) parts = corpusIdParts(call.arguments[0], 0);
    else if (name === "readStaticReportBundle" && call.arguments[1] && corpusIdParts(call.arguments[0], 0)) {
      parts = [call.arguments[1]];
    }
    if (!parts) continue;
    const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
    for (const id of new Set(parts.flatMap((part) => literalIds(part, 0)))) {
      reads.push({ file: sourceFile.fileName, line, id });
    }
  }
  return reads;
}

function committedReadProblems(
  reads: readonly CommittedRead[],
  reportsDir: string,
  pinnedIds: ReadonlySet<string>
): string[] {
  return reads.flatMap(({ file, line, id }) => {
    if (!existsSync(path.join(reportsDir, `${id}.json`))) {
      return [`${file}:${line} reads ${id} from public/reports, which no longer publishes it; ${REMEDY}`];
    }
    if (!pinnedIds.has(id)) {
      return [`${file}:${line} reads ${id} from public/reports, where no corrections-ledger pin keeps it from retention; ${REMEDY}`];
    }
    return [];
  });
}

function testSources(): Source[] {
  const found: Source[] = [];
  for (const [dir, suffix] of [["lib", ".test.ts"], ["scripts", ".test.mjs"]] as const) {
    for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(suffix)) continue;
      const file = path.join(dir, entry);
      found.push({ file, text: readFileSync(file, "utf8") });
    }
  }
  return found;
}

function ledgerPinnedIds(): ReadonlySet<string> {
  return parsedCorrectionsLedgerReportIds(parseCorrectionsLedger(JSON.parse(readFileSync("public/corrections.json", "utf8"))));
}

test("every report a test reads from public/reports by id is published there and pinned against retention", () => {
  const sources = testSources();
  // The walk reaches both suites, so an empty result is a clean tree rather than an empty scan.
  assert.ok(sources.filter((source) => source.file.startsWith("lib")).length > 100, "lib test sources");
  assert.ok(sources.some((source) => source.file.startsWith("scripts")), "scripts test sources");
  const reads = committedReportReads(sources.filter((source) => /\d{8}-[0-9a-f]{32}/.test(source.text)));
  const problems = committedReadProblems(reads, path.join("public", "reports"), ledgerPinnedIds());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the read detector follows every binding shape to its literal id and skips reads that are not literal corpus reads", () => {
  const id = (n: number) => `20260101-${String(n).padStart(32, "0")}`;
  const lib = `
    import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    import ledger from "../public/corrections.json";
    readFileSync(\`public/reports/${id(1)}.json\`, "utf8");
    const name2 = "${id(2)}.json";
    readFileSync(path.join(process.cwd(), "public", "reports", name2));
    const cases3 = ["${id(3)}", "${id(4)}"];
    for (const c of cases3) readFileSync(\`public/reports/\${c}.json\`);
    const list5 = ["${id(5)}", "${id(6)}"];
    readFileSync(\`public/reports/\${list5[1]}.json\`);
    function helperView(reportId: string) {
      return readFileSync(path.join(process.cwd(), "public", "reports", \`\${reportId}.json\`), "utf8");
    }
    for (const [r7, url] of [["${id(7)}", "https://example.com/"]] as const) helperView(r7);
    const cases8 = [{ id: "${id(8)}" }];
    for (const c8 of cases8) readFileSync(\`public/reports/\${c8.id}.json\`);
    for (const { id: r9 } of [{ id: "${id(9)}" }]) readFileSync(\`public/reports/\${r9}.json\`);
    ["${id(10)}"].forEach((r10) => readFileSync(\`public/reports/\${r10}.json\`));
    const corpus = path.join(process.cwd(), "public", "reports");
    readFileSync(path.join(corpus, "${id(11)}.json"));
    const root = process.cwd();
    readFileSync(path.join(root, "public", "reports", "${id(12)}.json"));
    ledgerPinnedReportView("${id(13)}");
    await readStaticReportBundle(path.join(process.cwd(), "public", "reports"), "${id(14)}");
    const pick15 = Math.random() > 0.5 ? "${id(15)}" : "${id(16)}";
    readFileSync(\`public/reports/\${pick15}.json\`);
    await readFile(path.join("public", "reports", "${id(17)}.json"));
    function fromFile(file: string) {
      return readFileSync(file, "utf8");
    }
    fromFile(path.join(process.cwd(), "public", "reports", "${id(18)}.json"));
    fromFile(path.join(process.cwd(), "test-fixtures", "reports", "${id(19)}.json"));
    readFileSync("public/reports/" + "${id(20)}" + ".json");
    const pick22 = process.env.REPORT ?? "${id(22)}";
    ledgerPinnedReportWire(pick22);
    const base23 = ["${id(23)}"];
    for (const r23 of [...base23]) ledgerPinnedReportWire(r23);
    const pick24 = process.env.REPORT || "${id(24)}";
    ledgerPinnedReportWire(pick24);
    const ext = "json";
    readFileSync(\`public/reports/${id(25)}.\${ext}\`);

    const tmp = mkdtempSync("sbl-");
    readFileSync(path.join(tmp, "public", "reports", "${id(30)}.json"));
    readFileSync(path.join(process.cwd(), "test-fixtures", "reports", "${id(31)}.json"));
    existsSync(\`public/reports/${id(32)}.json\`);
    writeFileSync(\`public/reports/${id(33)}.json\`, "{}");
    for (const name of readdirSync("public/reports")) readFileSync(path.join("public/reports", name));
    for (const reportId of ledger.entries[0].reportIds) readFileSync(\`public/reports/\${reportId}.json\`);
    function unrelated() {
      const shadow = "${id(34)}";
      return shadow;
    }
    function scoped(shadow: string) {
      return readFileSync(\`public/reports/\${shadow}.json\`);
    }
    scoped(process.env.REPORT ?? "");
    frozenReportWire("${id(35)}");
  `;
  const script = `
    import { readFileSync } from "node:fs";
    readFileSync(\`public/reports/${id(21)}.json\`, "utf8");
  `;
  const reads = committedReportReads([
    { file: "lib/example.test.ts", text: lib },
    { file: "scripts/example.test.mjs", text: script }
  ]);
  assert.deepEqual(
    reads.map((read) => `${read.file} ${read.id}`).sort(),
    [
      ...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 23, 24, 25].map((n) => `lib/example.test.ts ${id(n)}`),
      `scripts/example.test.mjs ${id(21)}`
    ].sort()
  );
  // A read is reported at the call that performs it, inside the traced helper.
  assert.deepEqual(reads.find((read) => read.id === id(7)), { file: "lib/example.test.ts", line: 14, id: id(7) });
});

test("a literal corpus read fails when its report is gone or unpinned, naming the frozen-copy remedy", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sbl-pinned-reports-"));
  try {
    const published = "20260101-00000000000000000000000000000001";
    const pruned = "20260101-00000000000000000000000000000002";
    const unpinned = "20260101-00000000000000000000000000000003";
    for (const id of [published, unpinned]) writeFileSync(path.join(dir, `${id}.json`), "{}\n");
    const reads = [published, pruned, unpinned].map((id, index) => ({ file: "lib/example.test.ts", line: index + 1, id }));
    assert.deepEqual(committedReadProblems(reads, dir, new Set([published, pruned])), [
      `lib/example.test.ts:2 reads ${pruned} from public/reports, which no longer publishes it; freeze it under test-fixtures/reports and read it through lib/pinned-reports.ts`,
      `lib/example.test.ts:3 reads ${unpinned} from public/reports, where no corrections-ledger pin keeps it from retention; freeze it under test-fixtures/reports and read it through lib/pinned-reports.ts`
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

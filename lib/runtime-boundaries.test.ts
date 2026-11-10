import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

type RuntimeBoundary = {
  name: string;
  entrypoints: readonly string[];
  blockedLocalModules: ReadonlySet<string>;
  blockedPackages: ReadonlySet<string>;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".jsx"] as const;
const PROJECT_ROOT = process.cwd();

const NODE_ONLY_MODULES = new Set([
  "lib/access-control.ts",
  "lib/adblock-engine.ts",
  "lib/investigation-seam.ts",
  "lib/keystroke-exfiltration.ts",
  "lib/node-scan-measurement.ts",
  "lib/public-scan-proxy.ts",
  "lib/report-store.ts",
  "lib/runtime-status.ts",
  "lib/scan-api.ts",
  "lib/scan-gate.ts",
  "lib/scan-jobs.ts",
  "lib/scan-limits.ts",
  "lib/scan-result-v2-r2-builder.ts",
  "lib/scanner.ts",
  "lib/static-report-files.ts",
  "lib/url-safety.ts",
  "investigation/local/fs-log-store.ts",
  "investigation/local/recorded-folder.ts"
]);

const BROWSER_CLIENT_BLOCKED_PACKAGES = new Set(["@cloudflare/playwright", "next/server", "playwright"]);
const WORKER_BLOCKED_PACKAGES = new Set(["next/server", "playwright"]);
const WORKSPACE_ENTRYPOINT = "cloudflare/investigation-worker.ts";
const WORKSPACE_DIRECTORY = "investigation/";

test("Cloudflare Worker imports stay out of Node-only modules", async () => {
  await assertBoundary({
    name: "cloudflare-worker",
    entrypoints: [
      "cloudflare/container-worker.ts",
      "cloudflare/r2-remediation-worker.ts",
      "cloudflare/r2-delete-canary-worker.ts",
      WORKSPACE_ENTRYPOINT,
      // Written to run in this Worker. The entry reaches the viewer, and through it the
      // store, the log, the machine, the evidence model and the aggregates. Neither the case
      // service, which the production entry does not configure, nor the summary tier is
      // reached. Each is named, so none drops out if an import moves.
      "investigation/core/case-log.ts",
      "investigation/core/case-store.ts",
      "investigation/core/case-service.ts",
      "investigation/core/viewer-routes.ts",
      "investigation/core/viewer-pages.ts",
      "investigation/core/viewer-text.ts",
      "investigation/core/workspace-response.ts",
      "investigation/core/summary-tier.ts",
      // W4's imported case, its adapters, the recorder's shapes and the sufficiency assessment run here too, reached by nothing yet.
      "investigation/core/imported-case.ts",
      "investigation/core/imported-ids.ts",
      "investigation/core/recorder-shapes.ts",
      "investigation/core/capture-adapter.ts",
      "investigation/core/trial-layout.ts",
      "investigation/core/sufficiency.ts"
    ],
    blockedLocalModules: NODE_ONLY_MODULES,
    blockedPackages: WORKER_BLOCKED_PACKAGES
  });
});

test("browser client imports stay out of Node and server modules", async () => {
  await assertBoundary({
    name: "browser-client",
    entrypoints: [
      "app/site-behavior-app.tsx",
      "app/reports/[id]/saved-report-client.tsx",
      // The app reaches this code-split importer with import(), so keep an
      // explicit entrypoint even if the shell import is later refactored.
      "lib/pagegraph-client-import.ts",
      "lib/pagegraph-v2-r2-builder.ts"
    ],
    blockedLocalModules: NODE_ONLY_MODULES,
    blockedPackages: BROWSER_CLIENT_BLOCKED_PACKAGES
  });
});

/**
 * The private investigation workspace is one deployment and the public scanner and
 * site another. Everything that builds a public artifact starts from these: every
 * file under app/ and, if they ever exist, pages/ and src/; every other Worker; and
 * the files at the root Next reads on its own, such as a middleware or its config.
 * Each graph below is the real import walk, so a public module that named the
 * workspace would appear in it.
 */
async function publicEntrypoints(): Promise<string[]> {
  const SOURCE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
  const filesUnder = async (directory: string): Promise<string[]> => {
    try {
      const files = await readdir(path.join(PROJECT_ROOT, directory), { recursive: true });
      return files.map((file) => `${directory}/${normalizeProjectPath(file)}`);
    } catch {
      return [];
    }
  };
  const root = (await readdir(PROJECT_ROOT, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const workers = await filesUnder("cloudflare");
  return [
    ...(await filesUnder("app")),
    ...(await filesUnder("pages")),
    ...(await filesUnder("src")),
    ...workers.filter((file) => file !== WORKSPACE_ENTRYPOINT),
    ...root
  ].filter((file) => SOURCE.test(file) && !file.endsWith(".d.ts"));
}

test("no public entrypoint reaches the investigation workspace", async () => {
  const entrypoints = await publicEntrypoints();
  for (const expected of ["app/site-behavior-app.tsx", "cloudflare/container-worker.ts", "next.config.mjs"]) {
    assert.ok(entrypoints.includes(expected), `${expected} could not be located`);
  }
  assert.ok(entrypoints.some((file) => file.startsWith("app/api/") && file.endsWith("/route.ts")), "the API routes could not be located");
  assert.ok(!entrypoints.includes(WORKSPACE_ENTRYPOINT));
  const reached = new Set<string>();
  for (const entrypoint of entrypoints) await collectRuntimeImportGraph(entrypoint, reached);
  const violations: string[] = [];
  for (const modulePath of reached) {
    if (modulePath.startsWith(WORKSPACE_DIRECTORY) || modulePath === WORKSPACE_ENTRYPOINT) violations.push(`reaches ${modulePath}`);
    // A computed import the walk cannot follow, or a worker built from a URL, would
    // ordinarily still spell the directory. Text split to dodge this is out of scope.
    const source = await readFile(path.join(PROJECT_ROOT, modulePath), "utf8");
    if (/(?:^|[^A-Za-z0-9_-])investigation\/|investigation-worker/m.test(source)) violations.push(`${modulePath} names the workspace`);
  }
  assert.deepEqual(violations, []);
  assert.ok(reached.size > 300, `the public graph reached only ${reached.size} modules, so this walk did not run`);
});

/**
 * The scanner's investigation seam is one optional field of a visit's options,
 * which only a private capture sets (lib/investigation-seam.ts). Nothing that
 * builds or runs the public scanner may set it, and the simplest thing that
 * holds that is that nothing else names it: not the option, not its type, not
 * the key a marked visit carries, and nothing either seam module exports.
 * Three files define it: the seam's module, the scanner, and the module that
 * holds the mark and its check (lib/seam-visit-mark.ts). Every other source
 * file under app/, cloudflare/, lib/ and scripts/, and at the root, is swept,
 * tests aside: that is every module the public entry points reach (held
 * below), and with them the scan API and its jobs, the calibration runtime,
 * the qualification acquirer and the repeatability script.
 *
 * A module that must refuse a seam visit calls a helper of the mark's module.
 * Each such module is listed below with the helpers it may name, and may name
 * nothing else of the seam: not the key, and not the function that marks. A
 * module that hands the sanitizer a stored report may name the refusal's
 * class, to turn a refusal into its own declared failure, and nothing else.
 * A name split across strings to dodge this is out of scope, as it is above.
 */
const SEAM_NAME = /investigationSeam/i;
const SEAM_MODULES = ["lib/investigation-seam.ts", "lib/seam-visit-mark.ts"] as const;
const SEAM_DEFINERS: ReadonlySet<string> = new Set([...SEAM_MODULES, "lib/scanner.ts"]);
/** The modules that refuse a seam visit, each with the helpers of lib/seam-visit-mark.ts it calls. */
const SEAM_HELPER_USERS: Readonly<Record<string, readonly string[]>> = {
  "lib/redact-scan-report-v1.ts": ["refuseSeamVisit"],
  "lib/report-store.ts": ["refuseSeamVisit"],
  "lib/scan-api.ts": ["refuseSeamOption", "refuseSeamVisit"],
  "lib/scan-report-reader.ts": ["isSeamVisit"],
  "lib/scan-report-v1-projection.ts": ["refuseSeamVisit"],
  "lib/scan-report-v2-runtime-builder.ts": ["refuseSeamVisit"],
  "lib/scan-report-v2-shadow-store.ts": ["refuseSeamVisit"],
  "lib/scan-report-view.ts": ["isSeamVisit"]
};
/**
 * The modules that hand the sanitizer a stored report a reader has passed.
 * The sanitizer makes the readers' check again on each arm of a comparison,
 * so it can refuse a shape they passed; each of these catches that refusal
 * by its class and answers with its own declared failure.
 */
const SEAM_REFUSAL_CATCHERS: Readonly<Record<string, readonly string[]>> = {
  "lib/managed-report-reader.ts": ["SeamVisitRefusal"],
  "lib/privacy-replacement.ts": ["SeamVisitRefusal"],
  "lib/r2-report-remediation.ts": ["SeamVisitRefusal"],
  "lib/remediate-reports-cli.ts": ["SeamVisitRefusal"]
};
const SEAM_NAME_USERS: Readonly<Record<string, readonly string[]>> = { ...SEAM_HELPER_USERS, ...SEAM_REFUSAL_CATCHERS };

/** Every name a module exports, read from its parse. */
function exportedNames(fileName: string, source: string): string[] {
  const names: string[] = [];
  for (const statement of ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true).statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.push(element.name.text);
      }
      continue;
    }
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

const asWord = (name: string): RegExp => new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, "\\$&")}(?![A-Za-z0-9_$])`);

/** What a file names of the seam that it may not: the seam by any spelling, or an export of either seam module. */
function seamNamesIn(file: string, source: string, exports: readonly string[]): string[] {
  if (SEAM_DEFINERS.has(file)) return [];
  const allowed = SEAM_NAME_USERS[file] ?? [];
  const named = exports.filter((name) => !allowed.includes(name) && asWord(name).test(source));
  if (SEAM_NAME.test(source)) named.push("the seam itself");
  return named.map((name) => `${file} names ${name}`);
}

async function sweptSources(): Promise<string[]> {
  const SOURCE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
  const TEST = /\.test\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
  const swept: string[] = [];
  for (const directory of ["app", "cloudflare", "lib", "scripts"]) {
    for (const file of await readdir(path.join(PROJECT_ROOT, directory), { recursive: true })) {
      swept.push(`${directory}/${normalizeProjectPath(file)}`);
    }
  }
  for (const entry of await readdir(PROJECT_ROOT, { withFileTypes: true })) if (entry.isFile()) swept.push(entry.name);
  return swept.filter((file) => SOURCE.test(file) && !TEST.test(file) && !file.endsWith(".d.ts"));
}

test("no public module names the investigation seam, its mark or anything its modules export", async () => {
  const sources = await sweptSources();
  assert.ok(sources.length > 500, `the sweep read only ${sources.length} files, so it did not run`);

  const exports: string[] = [];
  for (const module of SEAM_MODULES) exports.push(...exportedNames(module, await readFile(path.join(PROJECT_ROOT, module), "utf8")));
  // The names the sweep holds, so a reader of a failure knows what it looked for.
  for (const name of ["SEAM_VISIT_MARKER", "rememberSeamVisit", "isSeamVisit", "refuseSeamVisit", "refuseSeamOption", "SeamVisitRefusal", "openInvestigationSeam", "investigationSeamUse", "describeInvestigationSeam", "InvestigationSeam"]) {
    assert.ok(exports.includes(name), `${name} is no longer an export the sweep reads`);
  }
  assert.equal(new Set(exports).size, exports.length, "the two seam modules export one name twice");

  const violations: string[] = [];
  for (const file of sources) violations.push(...seamNamesIn(file, await readFile(path.join(PROJECT_ROOT, file), "utf8"), exports));
  assert.deepEqual(violations, [], "only the seam's two modules and the scanner may name the seam; a refusing module may name its listed helpers and nothing else");

  // Each definer does name it, and each listed module calls each helper it
  // is listed with, so neither list can go stale.
  for (const definer of SEAM_DEFINERS) {
    assert.ok(SEAM_NAME.test(await readFile(path.join(PROJECT_ROOT, definer), "utf8")), `${definer} no longer names the seam`);
  }
  for (const [file, helpers] of Object.entries(SEAM_HELPER_USERS)) {
    const source = await readFile(path.join(PROJECT_ROOT, file), "utf8");
    for (const helper of helpers) assert.ok(new RegExp(`\\b${helper}\\(`).test(source), `${file} no longer calls ${helper}`);
  }
  // A catching module tests for the refusal and never makes one of its own.
  assert.equal(Object.keys(SEAM_NAME_USERS).length, Object.keys(SEAM_HELPER_USERS).length + Object.keys(SEAM_REFUSAL_CATCHERS).length, "one module is on both lists");
  for (const file of Object.keys(SEAM_REFUSAL_CATCHERS)) {
    const source = await readFile(path.join(PROJECT_ROOT, file), "utf8");
    assert.match(source, /\binstanceof SeamVisitRefusal\b/, `${file} no longer catches the refusal`);
    assert.doesNotMatch(source, /\bnew SeamVisitRefusal\b|\bextends SeamVisitRefusal\b/, `${file} makes a refusal of its own`);
  }

  // The sweep covers the public scanner: every module a public entry point
  // reaches, and each caller of the scanner by name.
  const reached = new Set<string>();
  for (const entrypoint of await publicEntrypoints()) await collectRuntimeImportGraph(entrypoint, reached);
  const unswept = [...reached].filter((file) => !sources.includes(file));
  assert.deepEqual(unswept, [], "a public entry point reaches a module the sweep does not read");
  for (const caller of [
    "app/api/scan/route.ts",
    "lib/scan-api.ts",
    "lib/scan-jobs.ts",
    "lib/calibration-scan-runtime.ts",
    "lib/redact-scan-report-v1.ts",
    "lib/report-store.ts",
    "lib/scan-report-v2-runtime-builder.ts",
    "lib/scan-report-v2-shadow-store.ts",
    "scripts/v1-qualification-acquire.mjs",
    "scripts/repeatability-run.mjs",
    "scripts/calibration-study-acquire.mjs",
    "scripts/aa-study-acquire.mjs"
  ]) {
    assert.ok(sources.includes(caller), `${caller} could not be located`);
  }
  assert.ok(reached.has("lib/scan-api.ts") && reached.has("lib/scanner.ts") && reached.has("lib/investigation-seam.ts"));

  // The check finds each way to name it. A file outside both lists may name
  // nothing; a listed module may name its helpers and still not the key, the
  // marking function or the seam's own exports.
  const outside = "lib/some-public-module.ts";
  for (const spelling of [
    "{ investigationSeam: seam }",
    "let seam: InvestigationSeam;",
    'delete result["investigationSeamVisit"];',
    "delete result[SEAM_VISIT_MARKER];",
    "rememberSeamVisit(result);",
    "if (isSeamVisit(result)) return;",
    "refuseSeamVisit(result, 'here');",
    "catch (error) { if (error instanceof SeamVisitRefusal) return; }",
    "openInvestigationSeam({})",
    "investigationSeamUse(envelope)",
    "INVESTIGATIONSEAM"
  ]) {
    assert.notDeepEqual(seamNamesIn(outside, spelling, exports), [], spelling);
  }
  const refuser = "lib/report-store.ts";
  assert.deepEqual(seamNamesIn(refuser, 'import { refuseSeamVisit } from "./seam-visit-mark";\nrefuseSeamVisit(report, "the report store");', exports), []);
  for (const spelling of ["delete report[SEAM_VISIT_MARKER];", "rememberSeamVisit(report);", "if (isSeamVisit(report)) return;", "refuseSeamOption(options);"]) {
    assert.notDeepEqual(seamNamesIn(refuser, spelling, exports), [], `${spelling} in a module listed for another helper`);
  }
  // A catching module may name the refusal's class, and no helper.
  const catcher = "lib/managed-report-reader.ts";
  assert.deepEqual(seamNamesIn(catcher, 'import { SeamVisitRefusal } from "./seam-visit-mark";\nif (error instanceof SeamVisitRefusal) return;', exports), []);
  for (const spelling of ["refuseSeamVisit(report, 'here');", "if (isSeamVisit(report)) return;", "delete report[SEAM_VISIT_MARKER];"]) {
    assert.notDeepEqual(seamNamesIn(catcher, spelling, exports), [], `${spelling} in a module listed only to catch`);
  }
  assert.notDeepEqual(seamNamesIn(refuser, "if (error instanceof SeamVisitRefusal) return;", exports), [], "the class named in a module listed only to refuse");
  // A longer name that only contains a helper's is not that helper.
  assert.deepEqual(seamNamesIn(outside, "const refuseSeamVisitors = 1; const myisSeamVisit = 2;", exports), []);
});

test("each module that refuses a seam visit imports its helper from the module that imports nothing", async () => {
  const sources = await sweptSources();
  // The mark's module: no import, no require, not Node-only. The redactor
  // imports it, and the redactor runs in the browser and in a Worker.
  const mark = await readFile(path.join(PROJECT_ROOT, "lib/seam-visit-mark.ts"), "utf8");
  assert.doesNotMatch(mark, /^\s*(?:import|export)\b[^;]*\bfrom\b|\brequire\(|\bimport\(/m);
  assert.deepEqual(await readRuntimeImports("lib/seam-visit-mark.ts"), []);
  assert.equal(NODE_ONLY_MODULES.has("lib/seam-visit-mark.ts"), false);

  // Each refusing module names its helpers in one import of that module.
  const namedImports = (fileName: string, source: string, specifier: string): string[] => {
    const names: string[] = [];
    for (const statement of ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true).statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push(element.name.text);
    }
    return names.sort();
  };
  for (const [file, helpers] of Object.entries(SEAM_NAME_USERS)) {
    const source = await readFile(path.join(PROJECT_ROOT, file), "utf8");
    assert.deepEqual(namedImports(file, source, "./seam-visit-mark"), [...helpers].sort(), `${file} must import exactly its helpers from ./seam-visit-mark`);
  }

  // Nothing but the scanner imports the seam's own module, which brings the
  // scanner's runtime with it (the fingerprint observer, the scroll check).
  const importsSeamModule = /["'](?:\.{1,2}\/(?:lib\/)?|@\/lib\/)investigation-seam(?:\.[cm]?[jt]s)?["']/;
  const importers: string[] = [];
  for (const file of sources) if (importsSeamModule.test(await readFile(path.join(PROJECT_ROOT, file), "utf8"))) importers.push(file);
  assert.deepEqual(importers, ["lib/scanner.ts"]);
  for (const spelling of ['from "./investigation-seam"', 'from "../lib/investigation-seam.js"', 'import("@/lib/investigation-seam")']) {
    assert.equal(importsSeamModule.test(spelling), true, spelling);
  }
  // And the modules it brings are what a refusing module is spared.
  const seamGraph = await collectRuntimeImportGraph("lib/investigation-seam.ts");
  for (const heavy of ["lib/fingerprint-observer.ts", "lib/scroll-check.ts", "lib/scan-runtime.ts"]) assert.ok(seamGraph.has(heavy), heavy);
  for (const file of ["lib/scan-report-v2-shadow-store.ts", "lib/verify-v2-shadow-cli.ts"]) {
    const graph = await collectRuntimeImportGraph(file);
    for (const heavy of ["lib/investigation-seam.ts", "lib/fingerprint-observer.ts", "lib/scroll-check.ts"]) {
      assert.equal(graph.has(heavy), false, `${file} reaches ${heavy}`);
    }
  }
});

/**
 * docs/runtime-boundaries.md states the set of refusing steps as a table: the
 * functions that refuse, and the test that holds each. A list kept in a
 * document goes stale without a failure, so this reads it against the code,
 * both ways. What it holds is that list against the functions that call a
 * helper. It cannot hold that the list is complete as a list of publication
 * paths: a new exporter that calls no helper is in neither.
 */
function refusingSteps(docs: string): { functions: string[]; tests: string[] }[] {
  const lines = docs.split("\n");
  const head = lines.findIndex((line) => line.startsWith("| Step | Answer for a marked input |"));
  if (head === -1) return [];
  const steps: { functions: string[]; tests: string[] }[] = [];
  for (let index = head + 2; index < lines.length && lines[index].startsWith("|"); index += 1) {
    const cells = lines[index].split("|").slice(1, -1);
    steps.push({
      functions: [...(cells[0] ?? "").matchAll(/`([A-Za-z0-9_$]+)`/g)].map((match) => match[1]),
      tests: [...(cells[cells.length - 1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1])
    });
  }
  return steps;
}

/**
 * The functions the docs list as catching the sanitizer's refusal: the first
 * name of each item of the list that follows the lead-in.
 */
function documentedCatchers(docs: string): string[] {
  const lines = docs.split("\n");
  const head = lines.findIndex((line) => line.endsWith("catches the refusal and gives its own declared failure:"));
  if (head === -1) return [];
  const names: string[] = [];
  for (let index = head + 2; index < lines.length && lines[index].startsWith("- "); index += 1) {
    names.push(/^- `([A-Za-z0-9_$]+)`/.exec(lines[index])?.[1] ?? `an item with no function (${lines[index].slice(0, 40)})`);
  }
  return names;
}

/**
 * Each top-level function of a file that uses one of the names it is listed
 * with, anywhere inside it: a helper it calls, or the refusal's class in an
 * `instanceof`.
 */
function functionsCallingSeamHelpers(fileName: string, source: string, helpers: readonly string[]): string[] {
  const calling: string[] = [];
  for (const statement of ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true).statements) {
    let calls = false;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.includes(node.expression.text)) calls = true;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(node.right) && helpers.includes(node.right.text)) calls = true;
      ts.forEachChild(node, visit);
    };
    visit(statement);
    if (!calls) continue;
    calling.push(ts.isFunctionDeclaration(statement) && statement.name ? statement.name.text : `a statement that is no named function (${statement.getText().slice(0, 40)})`);
  }
  return calling.sort();
}

test("the documented refusing steps and catching functions are the functions that use the seam's helpers, and the tests named exist", async () => {
  const docsFile = "docs/runtime-boundaries.md";
  const docs = await readFile(path.join(PROJECT_ROOT, docsFile), "utf8");
  const steps = refusingSteps(docs);
  assert.ok(steps.length >= 8, `${docsFile} lists ${steps.length} refusing steps, so its table was not read`);
  const documented = steps.flatMap((step) => step.functions).sort();
  assert.equal(new Set(documented).size, documented.length, "one function is listed as two steps");

  const calling: string[] = [];
  for (const [file, helpers] of Object.entries(SEAM_HELPER_USERS)) {
    const found = functionsCallingSeamHelpers(file, await readFile(path.join(PROJECT_ROOT, file), "utf8"), helpers);
    assert.notDeepEqual(found, [], `${file} is listed as refusing and no function of it calls a helper`);
    calling.push(...found);
  }
  assert.deepEqual(documented, calling.sort(), `${docsFile} must list exactly the functions that call a helper of lib/seam-visit-mark.ts`);

  const testNames = [...(await readFile(path.join(PROJECT_ROOT, "lib/investigation-seam.test.ts"), "utf8")).matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((match) => match[1]);
  assert.ok(testNames.length > 20, "the seam's test names were not read");
  for (const step of steps) {
    assert.notDeepEqual(step.tests, [], `${step.functions.join(", ")} is listed with no test`);
    for (const named of step.tests) {
      assert.equal(testNames.filter((name) => name.startsWith(named)).length, 1, `${docsFile} names a test that lib/investigation-seam.test.ts does not have exactly once: ${named}`);
    }
  }

  // The same for the functions that catch the sanitizer's refusal of a stored
  // report: the docs list them, and the list is the functions that test for
  // the refusal's class.
  const catching: string[] = [];
  for (const [file, names] of Object.entries(SEAM_REFUSAL_CATCHERS)) {
    const found = functionsCallingSeamHelpers(file, await readFile(path.join(PROJECT_ROOT, file), "utf8"), names);
    assert.notDeepEqual(found, [], `${file} is listed as catching the refusal and no function of it tests for it`);
    catching.push(...found);
  }
  assert.deepEqual(documentedCatchers(docs).sort(), catching.sort(), `${docsFile} must list exactly the functions that catch the refusal`);
  assert.deepEqual(documentedCatchers("each catches the refusal and gives its own declared failure:\n\n- `one` answers.\n- `two`, the step.\n\nprose `three`"), ["one", "two"]);
  assert.deepEqual(functionsCallingSeamHelpers("x.ts", "function reads() { try { go(); } catch (error) { if (error instanceof SeamVisitRefusal) return; throw error; } }\nfunction other() { return new Error(); }", ["SeamVisitRefusal"]), ["reads"]);

  // The reading finds what it must: a helper call inside a closure counts for
  // the function around it, one outside any named function is reported, and a
  // row's functions and tests are read from its first and last cells.
  assert.deepEqual(
    functionsCallingSeamHelpers("x.ts", "export async function outer() { const inner = async () => { refuseSeamVisit(1, 'x'); }; }\nfunction quiet() { other(); }", ["refuseSeamVisit"]),
    ["outer"]
  );
  assert.match(functionsCallingSeamHelpers("x.ts", "export const read = (value: unknown) => isSeamVisit(value);", ["isSeamVisit"])[0], /no named function/);
  assert.deepEqual(refusingSteps("| Step | Answer for a marked input | What | Test |\n|---|---|---|---|\n| `one`, `two` | Throws. | `notAStep` | \"a test\", \"another\" |\n\nprose"), [
    { functions: ["one", "two"], tests: ["a test", "another"] }
  ]);
});

test("no client file statically imports its way to the mark's module", async () => {
  // The redactor that calls the mark's check reaches the browser only in
  // chunks loaded on demand. A static import of it from a client file would
  // put it, and the mark's module with it, in a page's initial JavaScript.
  const staticImportsOf = (fileName: string, source: string): string[] => {
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
        const typesOnly = clause?.isTypeOnly || (clause && !clause.name && named !== null && named.length > 0 && named.every((element) => element.isTypeOnly));
        if (!typesOnly && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node)) {
        if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest));
    return imports;
  };
  const staticGraph = async (entry: string): Promise<Set<string>> => {
    const visited = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const specifier of staticImportsOf(current, await readFile(path.join(PROJECT_ROOT, current), "utf8"))) {
        const resolved = await resolveLocalImport(current, specifier);
        if (resolved && !visited.has(resolved)) pending.push(resolved);
      }
    }
    return visited;
  };
  const clients: string[] = [];
  for (const file of await readdir(path.join(PROJECT_ROOT, "app"), { recursive: true })) {
    const projectPath = `app/${normalizeProjectPath(file)}`;
    if (!/\.tsx?$/.test(projectPath) || /\.test\.tsx?$/.test(projectPath)) continue;
    if (/^\s*["']use client["']/.test(await readFile(path.join(PROJECT_ROOT, projectPath), "utf8"))) clients.push(projectPath);
  }
  assert.ok(clients.length >= 20 && clients.includes("app/site-behavior-app.tsx"), `only ${clients.length} client files were found`);
  const reaching: string[] = [];
  for (const client of clients) {
    const graph = await staticGraph(client);
    for (const module of ["lib/seam-visit-mark.ts", "lib/redact-scan-report-v1.ts"]) if (graph.has(module)) reaching.push(`${client} statically reaches ${module}`);
  }
  assert.deepEqual(reaching, []);
  // The static walk does walk: the homepage's client reaches its lazy
  // reader's loader statically, and the mark's module only with dynamic
  // imports followed.
  assert.ok((await staticGraph("app/site-behavior-app.tsx")).has("lib/client-report-reader.ts"));
  assert.ok((await collectRuntimeImportGraph("app/site-behavior-app.tsx")).has("lib/seam-visit-mark.ts"));
});

test("no alias can name the workspace without spelling it", async () => {
  // The walk resolves only relative paths and the one project alias, so another alias would be invisible to it.
  const config = ts.parseConfigFileTextToJson("tsconfig.json", await readFile(path.join(PROJECT_ROOT, "tsconfig.json"), "utf8")).config as {
    compilerOptions: { paths?: Record<string, string[]> };
  };
  assert.deepEqual(config.compilerOptions.paths, { "@/*": ["./*"] });
  const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { imports?: unknown };
  assert.equal(manifest.imports, undefined);
});

test("the workspace entrypoint reaches its gate and verifier by plain imports, and stays inside its own code", async () => {
  // The same walk, from the other side, so the test above is not looking for an edge
  // of a shape it would never see. This shows the plain import form only: the other
  // forms are held by the walk's own test below.
  const graph = await collectRuntimeImportGraph(WORKSPACE_ENTRYPOINT);
  assert.ok(graph.has("investigation/core/workspace-gate.ts"));
  assert.ok(graph.has("investigation/core/access-token.ts"));
  for (const viewer of ["viewer-routes.ts", "viewer-pages.ts", "viewer-text.ts", "workspace-response.ts"]) assert.ok(graph.has(`investigation/core/${viewer}`), viewer);
  const outside = [...graph].filter((file) => file !== WORKSPACE_ENTRYPOINT && !file.startsWith(WORKSPACE_DIRECTORY));
  assert.deepEqual(outside, [], "the workspace imports nothing of the public scanner's yet");
});

test("the workspace's production code imports no test code", async () => {
  for (const file of await readdir(path.join(PROJECT_ROOT, "investigation/core"))) {
    const imports = await readRuntimeImports(`investigation/core/${file}`);
    assert.deepEqual(imports.filter((specifier) => specifier.includes("/test/") || specifier.includes("finite-check")), [], file);
  }
});

test("the walk sees every runtime edge and no type-only one", () => {
  const source = `
    import "./bare";
    import named from "./named";
    import { a, type B } from "./mixed";
    import type { C } from "./type-only";
    import type D from "./type-only-default";
    export type E = C;
    export { f } from "./re-exported";
    export * from "./star";
    export type { G } from "./type-only-export";
    export const later = 1;
    import h = require("./import-equals");
    const i = await import("./dynamic");
    const j = require("./required");
    const k = \`import "./inside-a-template";\`;
    // import "./inside-a-comment";
  `;
  assert.deepEqual(runtimeImportsOf("fixture.ts", source).sort(), [
    "./bare",
    "./dynamic",
    "./import-equals",
    "./mixed",
    "./named",
    "./re-exported",
    "./required",
    "./star"
  ]);
});

async function assertBoundary(boundary: RuntimeBoundary): Promise<void> {
  const violations: string[] = [];

  for (const entrypoint of boundary.entrypoints) {
    const graph = await collectRuntimeImportGraph(entrypoint);

    for (const modulePath of graph) {
      if (modulePath !== entrypoint && boundary.blockedLocalModules.has(modulePath)) {
        violations.push(`${entrypoint} reaches Node-only module ${modulePath}`);
      }

      const imports = await readRuntimeImports(modulePath);
      for (const specifier of imports) {
        if (isNodeBuiltin(specifier)) {
          violations.push(`${modulePath} imports Node builtin ${specifier}`);
        } else if (boundary.blockedPackages.has(specifier)) {
          violations.push(`${modulePath} imports ${specifier}`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], `${boundary.name} runtime boundary violations`);
}

async function collectRuntimeImportGraph(entrypoint: string, visited = new Set<string>()): Promise<Set<string>> {
  const pending = [entrypoint];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    for (const specifier of await readRuntimeImports(current)) {
      const resolved = await resolveLocalImport(current, specifier);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return visited;
}

async function readRuntimeImports(projectRelativePath: string): Promise<string[]> {
  const source = await readFile(path.join(PROJECT_ROOT, projectRelativePath), "utf8");
  return runtimeImportsOf(projectRelativePath, source);
}

/**
 * Read from the parsed file, not by pattern: a pattern for `import ... from` ran
 * past a bare `import "x";` into the next statement and lost the edge, and read an
 * `export type` as type-only through to a later re-export.
 */
function runtimeImportsOf(fileName: string, source: string): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        imports.push(node.moduleReference.expression.text);
      }
    } else if (ts.isCallExpression(node)) {
      // Code-split browser features are still runtime edges. The first import-only
      // walk silently skipped the PageGraph upload chunk.
      const [specifier] = node.arguments;
      const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (loads && specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest));
  return imports;
}

async function resolveLocalImport(importer: string, specifier: string): Promise<string | null> {
  if (specifier.startsWith("@/")) {
    return resolveProjectPath(specifier.slice(2));
  }

  if (specifier.startsWith(".")) {
    return resolveProjectPath(path.join(path.dirname(importer), specifier));
  }

  return null;
}

async function resolveProjectPath(projectPath: string): Promise<string | null> {
  const normalized = normalizeProjectPath(projectPath);
  const extension = path.extname(normalized);
  if (SOURCE_EXTENSIONS.includes(extension as (typeof SOURCE_EXTENSIONS)[number])) {
    return normalized;
  }

  for (const candidate of SOURCE_EXTENSIONS.flatMap((sourceExtension) => [`${normalized}${sourceExtension}`, `${normalized}/index${sourceExtension}`])) {
    try {
      await readFile(path.join(PROJECT_ROOT, candidate), "utf8");
      return candidate;
    } catch {
      // Try the next source extension.
    }
  }

  return null;
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath.split(path.sep).join("/");
}

function isNodeBuiltin(specifier: string): boolean {
  const bareSpecifier = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  const rootSpecifier = bareSpecifier.split("/")[0];
  return builtinModules.includes(bareSpecifier) || builtinModules.includes(rootSpecifier);
}

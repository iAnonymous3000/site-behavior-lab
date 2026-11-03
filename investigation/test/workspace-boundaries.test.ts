import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { assertCaughtBy, holds } from "../../lib/finite-check";

/**
 * What can reach what, in the style of lib/runtime-boundaries.test.ts, which holds the
 * public side. Here: the pure core runs in a Worker, so it names no Node builtin,
 * package or Node global, and reaches neither the filesystem store nor test code. The
 * filesystem store does reach the core and Node, read by the same code, so none of
 * this passes because the walk could not see an edge. No public entry reaches any of
 * this: lib/runtime-boundaries.test.ts walks that, and names the filesystem store too.
 */

const ROOT = process.cwd();
const WORKSPACE_ENTRY = "cloudflare/investigation-worker.ts";
const CORE = "investigation/core";
const LOCAL = "investigation/local";
const TEST = "investigation/test";
const NODE_GLOBALS = new Set(["process", "Buffer", "require", "module", "__dirname", "__filename", "global", "setImmediate"]);

type Read = (file: string) => string;
const readProject: Read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const filesIn = (directory: string): string[] => readdirSync(path.join(ROOT, directory)).filter((file) => file.endsWith(".ts")).map((file) => `${directory}/${file}`);

/** Every runtime edge in a file, read from its parse: the same forms lib/runtime-boundaries.test.ts counts. */
function runtimeImports(file: string, source: string): string[] {
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
      const [specifier] = node.arguments;
      const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (loads && specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
  return imports;
}

/** A Node global used as a value, not a property or key of the same name, nor a local binding's own name. */
function nodeGlobalsUsed(file: string, source: string): string[] {
  const used: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) {
      const { parent } = node;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node);
      if (!isName) used.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return used;
}

const isNodeBuiltin = (specifier: string): boolean => specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]);

function resolve(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return `${path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))}.ts`;
}

function graphOf(entries: readonly string[], read: Read): Set<string> {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(file, read(file))) {
      const next = resolve(file, specifier);
      if (next !== null) pending.push(next);
    }
  }
  return seen;
}

/** The rule itself, over whatever the project's files read as. */
function checkWorkerSide(read: Read): void {
  const entries = [WORKSPACE_ENTRY, ...filesIn(CORE)];
  const graph = graphOf(entries, read);
  // Reach first, across the whole graph, so an edge is reported as an edge and not as what the far file holds.
  for (const file of graph) {
    holds("the Worker's side reaches neither the filesystem store nor test code", !file.startsWith(`${LOCAL}/`) && !file.startsWith(`${TEST}/`), () => file);
  }
  for (const file of graph) {
    holds("the Worker's side stays inside the workspace's own code", file === WORKSPACE_ENTRY || file.startsWith(`${CORE}/`), () => file);
  }
  for (const file of graph) {
    const source = read(file);
    for (const specifier of runtimeImports(file, source)) {
      holds("the Worker's side names no Node builtin", !isNodeBuiltin(specifier), () => ({ file, specifier }));
      holds("the Worker's side names no package", specifier.startsWith("."), () => ({ file, specifier }));
    }
    holds("the Worker's side uses no Node global", nodeGlobalsUsed(file, source).length === 0, () => ({ file, used: nodeGlobalsUsed(file, source) }));
    holds("the Worker's side does not spell the filesystem store's folder", !/investigation\/local|\.\.\/local\b|\.\/local\b/.test(source), () => file);
  }
}

test("the Worker's side stays pure: every core module, and everything the entry reaches", () => {
  checkWorkerSide(readProject);
});

test("the walk from the entry really reaches the gate, its configuration and the verifier", () => {
  const graph = graphOf([WORKSPACE_ENTRY], readProject);
  for (const file of ["investigation/core/workspace-gate.ts", "investigation/core/workspace-config.ts", "investigation/core/access-token.ts"]) {
    assert.ok(graph.has(file), file);
  }
});

test("every core module is walked, including the summary tier the entry does not reach", () => {
  const graph = graphOf(filesIn(CORE), readProject);
  for (const file of [
    "investigation/core/actor.ts",
    "investigation/core/aggregates.ts",
    "investigation/core/canonical-json.ts",
    "investigation/core/case-events.ts",
    "investigation/core/case-log.ts",
    "investigation/core/case-machine.ts",
    "investigation/core/case-store.ts",
    "investigation/core/evidence-model.ts",
    "investigation/core/ids.ts",
    "investigation/core/purge.ts",
    "investigation/core/readings.ts",
    "investigation/core/summary-tier.ts",
    "investigation/core/case-service.ts",
    "investigation/core/viewer-pages.ts",
    "investigation/core/viewer-routes.ts",
    "investigation/core/viewer-text.ts",
    "investigation/core/workspace-response.ts",
    "investigation/core/imported-case.ts",
    "investigation/core/imported-ids.ts",
    "investigation/core/recorder-shapes.ts",
    "investigation/core/capture-adapter.ts",
    "investigation/core/trial-layout.ts",
    "investigation/core/sufficiency.ts"
  ]) {
    assert.ok(graph.has(file), file);
  }
});

test("the Worker's entry reaches the viewer, and through it the case code it reads, and neither the service it has none of nor the summary tier", () => {
  const graph = graphOf([WORKSPACE_ENTRY], readProject);
  for (const file of ["viewer-routes.ts", "viewer-pages.ts", "viewer-text.ts", "workspace-response.ts", "case-store.ts", "case-log.ts", "evidence-model.ts", "aggregates.ts", "readings.ts", "case-machine.ts"]) {
    assert.ok(graph.has(`${CORE}/${file}`), file);
  }
  // The production entry configures no service, and the viewer names the seam by its types alone.
  assert.ok(!graph.has(`${CORE}/case-service.ts`));
  // A summary keeps a range's count of 0 as the capture gave it, which is no reading, so the viewer never reads one.
  assert.ok(!graph.has(`${CORE}/summary-tier.ts`));
  for (const viewer of ["viewer-routes.ts", "viewer-pages.ts", "viewer-text.ts"]) assert.ok(!graphOf([`${CORE}/${viewer}`], readProject).has(`${CORE}/summary-tier.ts`), viewer);
});

test("the other way: the filesystem store reaches the core and Node, seen by the same reader", () => {
  const entries = filesIn(LOCAL);
  assert.deepEqual(entries.sort(), ["investigation/local/fs-log-store.ts", "investigation/local/recorded-folder.ts"]);
  const graph = graphOf(["investigation/local/fs-log-store.ts"], readProject);
  assert.ok(graph.has("investigation/core/case-log.ts"), "the store reaches the core by a runtime import");
  const specifiers = runtimeImports(entries[0], readProject(entries[0]));
  assert.ok(specifiers.some(isNodeBuiltin), "the store's Node import is visible to the reader the Worker's side is held by");
  assert.ok(nodeGlobalsUsed(entries[0], readProject(entries[0])).includes("process"), "its Node global is visible too");
  for (const file of graph) assert.ok(!file.startsWith(`${TEST}/`), file);
});

test("W4's reader of a recorded folder reaches the core's path rule and Node, and no test code", () => {
  const reader = "investigation/local/recorded-folder.ts";
  const graph = graphOf([reader], readProject);
  assert.ok(graph.has("investigation/core/recorder-shapes.ts"), "the reader holds paths to the core's rule by a runtime import");
  assert.ok(runtimeImports(reader, readProject(reader)).some(isNodeBuiltin), "its Node import is visible to the reader the Worker's side is held by");
  for (const file of graph) assert.ok(!file.startsWith(`${TEST}/`), file);
});

/** Plant one line into a real file, without touching it, and require the rule to refuse. */
function planted(target: string, line: string): Read {
  return (file) => (file === target ? `${line}\n${readProject(file)}` : readProject(file));
}

for (const [name, property, target, line] of [
  ["an import of the filesystem store from the gate", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/workspace-gate.ts", 'import "../local/fs-log-store";'],
  ["an import of the filesystem store from the log", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/case-log.ts", 'import { fsLogStores } from "../local/fs-log-store";'],
  ["an import of the filesystem store from the Worker", "the Worker's side reaches neither the filesystem store nor test code", WORKSPACE_ENTRY, 'import "../investigation/local/fs-log-store";'],
  ["a dynamic import of the filesystem store", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/case-log.ts", 'const later = () => import("../local/fs-log-store");'],
  ["a require of the filesystem store", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/canonical-json.ts", 'const later = () => require("../local/fs-log-store");'],
  ["a computed import that spells the folder", "the Worker's side does not spell the filesystem store's folder", "investigation/core/case-log.ts", 'const later = () => import(`../local/${"fs-log-store"}`);'],
  ["an import of test code", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/actor.ts", 'import "../test/log-fixture";'],
  ["a Node builtin", "the Worker's side names no Node builtin", "investigation/core/case-log.ts", 'import { createHash } from "node:crypto";'],
  ["a Node builtin with no prefix", "the Worker's side names no Node builtin", "investigation/core/canonical-json.ts", 'import "fs";'],
  ["a package", "the Worker's side names no package", "investigation/core/case-log.ts", 'import "some-package";'],
  ["a Node global", "the Worker's side uses no Node global", "investigation/core/canonical-json.ts", 'const bytes = Buffer.from("x");'],
  ["an import of the filesystem store from the store", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/case-store.ts", 'import { fsLogStores } from "../local/fs-log-store";'],
  ["a Node builtin in the machine", "the Worker's side names no Node builtin", "investigation/core/case-machine.ts", 'import { createHash } from "node:crypto";'],
  ["a Node global in the summary", "the Worker's side uses no Node global", "investigation/core/summary-tier.ts", 'const bytes = Buffer.from("x");'],
  ["a public module in the readings", "the Worker's side stays inside the workspace's own code", "investigation/core/readings.ts", 'import "../../lib/finite-check";'],
  ["a package in the evidence model", "the Worker's side names no package", "investigation/core/evidence-model.ts", 'import "some-package";'],
  ["the process global", "the Worker's side uses no Node global", "investigation/core/case-log.ts", "const pid = process.pid;"],
  ["a module outside the workspace", "the Worker's side stays inside the workspace's own code", "investigation/core/case-log.ts", 'import "../../lib/finite-check";'],
  ["a Node builtin in the adapter", "the Worker's side names no Node builtin", "investigation/core/capture-adapter.ts", 'import { readFileSync } from "node:fs";'],
  ["the local reader from the trial layout", "the Worker's side reaches neither the filesystem store nor test code", "investigation/core/trial-layout.ts", 'import { readRecordedFiles } from "../local/recorded-folder";'],
  ["a Node global in the imported case", "the Worker's side uses no Node global", "investigation/core/imported-case.ts", 'const bytes = Buffer.from("x");'],
  ["a Node builtin in the recorder's shapes", "the Worker's side names no Node builtin", "investigation/core/recorder-shapes.ts", 'import { readFileSync } from "node:fs";']
] as const) {
  test(`${name} in the Worker's side is caught`, async () => {
    await assertCaughtBy(name, property, () => checkWorkerSide(planted(target, line)));
  });
}

test("a property or key that shares a Node global's name is not a use of it", () => {
  assert.deepEqual(nodeGlobalsUsed("x.ts", "const a = { process: 1 }; const b = a.process; type C = { module: string };"), []);
  assert.deepEqual(nodeGlobalsUsed("x.ts", "const a = process.pid;"), ["process"]);
});

test("a type-only import is no runtime edge, so the store's types cannot pull it in", () => {
  assert.deepEqual(runtimeImports("x.ts", 'import type { A } from "../local/fs-log-store"; export type { B } from "../local/fs-log-store";'), []);
  assert.deepEqual(runtimeImports("x.ts", 'import { type A, b } from "./y"; export { c } from "./z";').sort(), ["./y", "./z"]);
});

test("the scanner image's runtime stage copies nothing of the workspace, the viewer included", () => {
  const dockerfile = readProject("Dockerfile");
  const stages = dockerfile.split(/^FROM /m);
  const runner = stages[stages.length - 1];
  assert.match(runner, /AS runner/);
  const sources = [...runner.matchAll(/^COPY\s+(?:--from=\S+\s+)?(.+?)\s+\S+$/gm)].flatMap(([, list]) => list.split(/\s+/));
  assert.ok(sources.length >= 5, "the runner stage's copies were read");
  for (const source of sources) {
    assert.doesNotMatch(source, /investigation|cloudflare|^\.$|^\/app\/?$/, source);
  }
});

test("the public boundary test walks each W4 core module as a Worker entrypoint, so a Node import in one fails it by name", () => {
  const source = readProject("lib/runtime-boundaries.test.ts");
  const worker = source.match(/name: "cloudflare-worker",\s*entrypoints: \[([^\]]*)\]/);
  assert.ok(worker !== null, "the Worker boundary's entrypoints were read");
  for (const file of ["imported-case.ts", "imported-ids.ts", "recorder-shapes.ts", "capture-adapter.ts", "trial-layout.ts", "sufficiency.ts"].map((name) => `investigation/core/${name}`)) {
    assert.ok(worker[1].includes(JSON.stringify(file)), `${file} is a Worker entrypoint`);
    assert.ok(readProject(file).length > 0, `${file} is where the list says`);
  }
});

test("the public boundary test names the filesystem store and the recorded-folder reader as Node-only, and each is where it says", () => {
  const source = readProject("lib/runtime-boundaries.test.ts");
  const nodeOnly = source.match(/NODE_ONLY_MODULES = new Set\(\[([^\]]*)\]/);
  assert.ok(nodeOnly !== null, "the Node-only list was read");
  for (const file of ["investigation/local/fs-log-store.ts", "investigation/local/recorded-folder.ts"]) {
    assert.ok(nodeOnly[1].includes(JSON.stringify(file)), `${file} is pinned as Node-only`);
    assert.ok(readProject(file).length > 0, `${file} is where the pin says`);
  }
});

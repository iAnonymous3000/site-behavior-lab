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
  "investigation/local/fs-log-store.ts"
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
      // No route reaches the case log yet, and it is written to run in this Worker.
      "investigation/core/case-log.ts"
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

import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
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
  "lib/url-safety.ts"
]);

const BROWSER_CLIENT_BLOCKED_PACKAGES = new Set(["@cloudflare/playwright", "next/server", "playwright"]);
const WORKER_BLOCKED_PACKAGES = new Set(["next/server", "playwright"]);

test("Cloudflare Worker imports stay out of Node-only modules", async () => {
  await assertBoundary({
    name: "cloudflare-worker",
    entrypoints: [
      "cloudflare/container-worker.ts",
      "cloudflare/r2-remediation-worker.ts",
      "cloudflare/r2-delete-canary-worker.ts"
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

async function collectRuntimeImportGraph(entrypoint: string): Promise<Set<string>> {
  const visited = new Set<string>();
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

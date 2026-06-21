import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

type RuntimeBoundary = {
  name: string;
  entrypoints: readonly string[];
  blockedLocalModules: ReadonlySet<string>;
  blockedPackages: ReadonlySet<string>;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"] as const;
const PROJECT_ROOT = process.cwd();

const NODE_ONLY_MODULES = new Set([
  "lib/access-control.ts",
  "lib/adblock-engine.ts",
  "lib/public-scan-proxy.ts",
  "lib/report-store.ts",
  "lib/runtime-status.ts",
  "lib/scan-api.ts",
  "lib/scan-gate.ts",
  "lib/scan-jobs.ts",
  "lib/scan-limits.ts",
  "lib/scanner.ts",
  "lib/static-report-files.ts",
  "lib/url-safety.ts"
]);

const BROWSER_CLIENT_BLOCKED_PACKAGES = new Set(["@cloudflare/playwright", "next/server", "playwright"]);
const WORKER_BLOCKED_PACKAGES = new Set(["next/server", "playwright"]);

test("Cloudflare Worker imports stay out of Node-only modules", async () => {
  await assertBoundary({
    name: "cloudflare-worker",
    entrypoints: ["cloudflare/worker.ts"],
    blockedLocalModules: NODE_ONLY_MODULES,
    blockedPackages: WORKER_BLOCKED_PACKAGES
  });
});

test("browser client imports stay out of Node and server modules", async () => {
  await assertBoundary({
    name: "browser-client",
    entrypoints: ["app/site-behavior-app.tsx", "app/reports/[id]/saved-report-client.tsx"],
    blockedLocalModules: NODE_ONLY_MODULES,
    blockedPackages: BROWSER_CLIENT_BLOCKED_PACKAGES
  });
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
  const imports: string[] = [];

  for (const match of source.matchAll(/^\s*import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gm)) {
    if (!match[1]) imports.push(match[2]);
  }

  for (const match of source.matchAll(/^\s*export\s+(type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["'];?/gm)) {
    if (!match[1]) imports.push(match[2]);
  }

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

  for (const sourceExtension of SOURCE_EXTENSIONS) {
    try {
      const candidate = `${normalized}${sourceExtension}`;
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

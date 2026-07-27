import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();

/**
 * Every `dist/schema/lib/<name>.js` a workflow, npm script, or script file
 * executes must actually be emitted by `tsconfig.schema.json`.
 *
 * That config uses an explicit `include` allowlist, so a module reaches the
 * output only by being listed or by being imported (transitively) from
 * something listed. `dca6797` added a scan-featured step that requires
 * `scan-report-acquisition.js`, which nothing in the allowlist imports, so the
 * step threw "Cannot find module" on every run from the moment it shipped. It
 * was never noticed because the runs before it failed earlier for other
 * reasons.
 */
function schemaProgramModules(): Set<string> {
  const config = JSON.parse(
    readFileSync(path.join(ROOT, "tsconfig.schema.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")
  ) as { include: string[] };
  const reachable = new Set<string>();
  const queue = [...config.include];
  while (queue.length > 0) {
    const relative = queue.shift()!;
    if (reachable.has(relative)) continue;
    const absolute = path.join(ROOT, relative);
    if (!existsSync(absolute)) continue;
    reachable.add(relative);
    const source = readFileSync(absolute, "utf8");
    // Value imports only: a type-only import is erased and emits nothing.
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+"\.\/([a-z0-9.-]+)"/g)) {
      queue.push(`lib/${match[1]}.ts`);
    }
    for (const match of source.matchAll(/(?:^|\n)\s*import\s+"\.\/([a-z0-9.-]+)"/g)) {
      queue.push(`lib/${match[1]}.ts`);
    }
    for (const match of source.matchAll(/await import\("\.\/([a-z0-9.-]+)"\)/g)) {
      queue.push(`lib/${match[1]}.ts`);
    }
  }
  return reachable;
}

function referencedSchemaModules(): Map<string, string[]> {
  const referenced = new Map<string, string[]>();
  const files: string[] = [path.join(ROOT, "package.json")];
  for (const dir of [".github/workflows", "scripts"]) {
    const absolute = path.join(ROOT, dir);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      if (/\.(ya?ml|mjs|js|json)$/.test(name)) files.push(path.join(absolute, name));
    }
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Both spellings automation uses: the literal path an npm script or
    // workflow names, and the segmented `path.join(root, "dist", "schema",
    // "lib", "x.js")` a launcher builds. Only the first was matched, so every
    // module reached exclusively through a launcher was outside this contract.
    const references = [
      ...source.matchAll(/dist\/schema\/lib\/([a-z0-9-]+)\.js/g),
      ...source.matchAll(/"dist",\s*"schema",\s*"lib",\s*"([a-z0-9-]+)\.js"/g)
    ];
    for (const match of references) {
      const key = `lib/${match[1]}.ts`;
      if (!referenced.has(key)) referenced.set(key, []);
      const where = path.relative(ROOT, file);
      if (!referenced.get(key)!.includes(where)) referenced.get(key)!.push(where);
    }
  }
  return referenced;
}

test("every schema module an automation entrypoint executes is emitted by the schema build", () => {
  const emitted = schemaProgramModules();
  const referenced = referencedSchemaModules();

  assert.ok(referenced.size >= 5, `expected to find schema module references, found ${referenced.size}`);
  assert.ok(
    referenced.has("lib/scan-report-acquisition.ts"),
    "the regression case must still be covered by a real reference"
  );

  const missing: string[] = [];
  for (const [module, callers] of referenced) {
    if (!emitted.has(module)) missing.push(`${module} (required by ${callers.join(", ")})`);
  }
  assert.deepEqual(
    missing,
    [],
    `these modules are executed from dist/schema but tsconfig.schema.json never emits them:\n  ${missing.join("\n  ")}`
  );
});

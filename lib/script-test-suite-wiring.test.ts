import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function commandsReachableFrom(rootScript: string): string[] {
  const visited = new Set<string>();
  const commands: string[] = [];
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const command = packageJson.scripts[name];
    if (command === undefined) return;
    commands.push(command);
    for (const hop of command.matchAll(/npm run ([\w:-]+)/g)) visit(hop[1]);
  };
  visit(rootScript);
  return commands;
}

test("every lib test directory runs in an npm script that test:unit reaches", () => {
  const reachable = commandsReachableFrom("test:unit").join("\n");
  const directories = new Set<string>();
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${relative}/${entry.name}`);
      else if (entry.name.endsWith(".test.ts") && !entry.name.startsWith("investigation-")) {
        directories.add(relative);
      }
    }
  };
  walk("lib");
  assert.ok(directories.has("lib"), "the lib suites could not be located");
  assert.ok(directories.has("lib/corpus-overview-suite"), "the shared-corpus group could not be located");

  for (const directory of directories) {
    assert.ok(
      reachable.includes(`.unit-test-dist/${directory}/*.test.js`),
      `${directory}/*.test.ts compiles but runs in no npm script reachable from test:unit`
    );
  }
});

test("investigation workspace tests are wired under test:investigation:all outside test:unit", () => {
  const unitReachable = commandsReachableFrom("test:unit").join("\n");
  assert.equal(unitReachable.includes("test:investigation"), false, "investigation tests must stay outside scanner test:unit");
  const invReachable = commandsReachableFrom("test:investigation:all").join("\n");
  assert.ok(invReachable.includes("tsc -p tsconfig.investigation-test.json"));
  assert.ok(invReachable.includes("scripts/tla-case-machine-conformance.test.mjs"));
});

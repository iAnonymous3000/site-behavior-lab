import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * The producer suites under scripts/ are plain ESM, so `tsc -p
 * tsconfig.test.json` never compiles them and the `.unit-test-dist/lib/*.test.js`
 * glob can never pick them up. Each one therefore has to be named by an npm
 * script that test:unit reaches, and nothing but this guard notices when one is
 * not: an orphaned suite passes when a human runs it by hand and protects
 * nothing in CI. Two calibration ceremony suites (26 tests guarding workflow
 * least-privilege, one-shot dispatch, and anti-substitution) sat unwired that
 * way.
 */

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

// The commands test:unit actually executes, following `npm run` hops.
function commandsReachableFromTestUnit(): string[] {
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
  visit("test:unit");
  return commands;
}

// A run-schema-cli target names its script indirectly, through the launcher's
// own table, so resolve those to the file they spawn.
function schemaLauncherTargets(commands: readonly string[]): string[] {
  const launcher = readFileSync(path.join(root, "scripts", "run-schema-cli.mjs"), "utf8");
  const resolved: string[] = [];
  for (const command of commands) {
    for (const match of command.matchAll(/node scripts\/run-schema-cli\.mjs ([\w-]+)/g)) {
      const entry = launcher.match(new RegExp(`"${match[1]}": \\[([^\\]]*)\\]`))?.[1];
      if (entry === undefined) continue;
      resolved.push([...entry.matchAll(/"([^"]+)"/g)].map((part) => part[1]).join("/"));
    }
  }
  return resolved;
}

test("every scripts/*.test.mjs suite is named by an npm script that test:unit runs", () => {
  const commands = commandsReachableFromTestUnit();
  const reachable = [...commands, ...schemaLauncherTargets(commands)].join("\n");

  const suites = readdirSync(path.join(root, "scripts"))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort();
  assert.ok(suites.length > 0, "the scripts/ producer suites could not be located");

  for (const suite of suites) {
    assert.ok(
      reachable.includes(`scripts/${suite}`),
      `scripts/${suite} runs in no npm script reachable from test:unit, so it guards nothing in CI`
    );
  }
});

test("the calibration ceremony suites run after the launcher that builds dist/schema", () => {
  // Both suites load ../dist/schema/lib/canonical-json.js and refuse to run
  // without it, so ordering them before the producer step would turn the whole
  // wiring back into a no-op that fails for an unrelated reason.
  const testUnit = packageJson.scripts["test:unit"];
  const producer = testUnit.indexOf("npm run test:calibration-producer");
  const ceremony = testUnit.indexOf("npm run test:calibration-ceremony");
  assert.ok(producer >= 0, "test:unit must run the calibration producer suite");
  assert.ok(ceremony > producer, "test:unit must run the ceremony suites after dist/schema is built");

  assert.equal(
    packageJson.scripts["test:calibration-ceremony"],
    "node --test scripts/calibration-acquisition-authorization-lib.test.mjs scripts/calibration-label-roster-lib.test.mjs scripts/calibration-assemble-custody-lib.test.mjs"
  );
});

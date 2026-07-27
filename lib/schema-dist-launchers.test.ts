import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * Every consumer of the dist/schema production artifact must be able to skip
 * its own compile when an orchestrator has already built it for the whole run.
 *
 * The flag is not decorative. scripts/run-ci-scan.mjs runs the remediation
 * check once PER SITE and sets it expressly to prevent the recompile, so an
 * npm script with an inline `tsc &&` made a full featured refresh pay for one
 * whole schema build per scanned site while the caller believed it had
 * suppressed them.
 */
const SCHEMA_DIST_READY = "SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY";

test("no npm script compiles the schema artifact where an orchestrator cannot skip it", () => {
  const inline = Object.entries(packageJson.scripts).filter(
    ([, command]) => /tsc\s+-p\s+tsconfig\.schema\.json\s*&&/.test(command)
  );
  assert.deepEqual(
    inline.map(([name]) => name),
    [],
    "route these through a scripts/*.mjs launcher that honors the schema-dist flag"
  );
});

test("every schema-artifact launcher honors the orchestrator's build flag", () => {
  const launchers = [
    ...new Set(
      Object.values(packageJson.scripts)
        .map((command) => command.match(/^node (scripts\/[\w-]+\.mjs)/)?.[1])
        .filter((file): file is string => file !== undefined)
    )
  ]
    // Consumers RUN something out of dist/schema. scripts/build-schema.mjs
    // produces that artifact and must always compile, so it is not one.
    .filter((file) => {
      const source = readFileSync(path.join(root, file), "utf8");
      return source.includes("tsconfig.schema.json") && /"dist", "schema"/.test(source);
    });

  assert.ok(launchers.length > 0, "the schema launchers could not be located");
  assert.ok(launchers.includes("scripts/run-schema-cli.mjs"));
  for (const file of launchers) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.match(
      source,
      new RegExp(`if \\(process\\.env\\.${SCHEMA_DIST_READY} !== "1"\\) \\{`),
      `${file} must skip its compile when the artifact is already built`
    );
  }
});

test("the shared schema launcher forwards arguments and refuses unknown targets", () => {
  // `npm run reports:remediate -- --check` is the fail-closed corpus gate; a
  // launcher that dropped the flag would silently REWRITE every report in CI.
  const launcher = path.join(root, "scripts", "run-schema-cli.mjs");
  const source = readFileSync(launcher, "utf8");
  assert.match(source, /\.\.\.forwarded/);

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    const target = command.match(/^node scripts\/run-schema-cli\.mjs ([\w-]+)$/)?.[1];
    if (!target) continue;
    assert.match(source, new RegExp(`"${target}": \\[`), `${name} names a target the launcher does not define`);
  }

  const refused = spawnSync(process.execPath, [launcher, "../../etc/passwd"], { cwd: root, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Unknown schema CLI/);
});

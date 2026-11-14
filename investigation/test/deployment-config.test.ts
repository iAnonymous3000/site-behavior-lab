import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * The workspace's deployment shape, while nothing deploys it: its aliases stay off,
 * because a workers.dev or preview address would answer outside the Access
 * application, and it binds nothing of the public scanner's. It binds the two
 * Durable Object classes its cases live in, on SQLite storage, and one bucket of its
 * own. A new top-level key in the config, or a new binding, has to be added here on
 * purpose.
 */

const root = process.cwd();
const CONFIG = "wrangler.investigation.jsonc";
const raw = readFileSync(path.join(root, CONFIG), "utf8");
const parsed = ts.parseConfigFileTextToJson(CONFIG, raw);
const config = parsed.config as Record<string, unknown>;

test("the config parses, and names the workspace Worker", () => {
  assert.equal(parsed.error, undefined);
  assert.equal(config.name, "site-behavior-lab-investigation");
  assert.equal(config.main, "cloudflare/investigation-worker.ts");
});

test("neither alias can answer outside the Access application", () => {
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test("logs stay off until reading one is proven not to show a visited address", () => {
  assert.deepEqual(config.observability, { enabled: false });
});

test("the config holds only what the case host needs: no hostname, route, variable or container", () => {
  assert.deepEqual(Object.keys(config).sort(), [
    "$schema",
    "compatibility_date",
    "durable_objects",
    "main",
    "migrations",
    "name",
    "observability",
    "preview_urls",
    "r2_buckets",
    "workers_dev"
  ]);
});

test("its bindings are exactly the two case classes, both on SQLite storage, and one bucket that is not the public one", () => {
  assert.deepEqual(config.durable_objects, {
    bindings: [
      { name: "INVESTIGATION_CASES", class_name: "InvestigationCase" },
      { name: "INVESTIGATION_CASE_INDEX", class_name: "InvestigationCaseIndex" }
    ]
  });
  // One migration, naming both classes as SQLite classes and nothing else: a case's head is a row there.
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["InvestigationCase", "InvestigationCaseIndex"] }]);
  assert.deepEqual(config.r2_buckets, [{ binding: "INVESTIGATION_OBJECTS", bucket_name: "site-behavior-lab-investigation-objects" }]);
  // The entry exports a class for each binding, by the names the config gives.
  const entry = readFileSync(path.join(root, config.main as string), "utf8");
  for (const { class_name } of (config.durable_objects as { bindings: { class_name: string }[] }).bindings) {
    assert.match(entry, new RegExp(`^export class ${class_name} \\{$`, "m"), class_name);
  }
});

test("it can never bind the public reports bucket or the scanner, even in a comment's shadow", () => {
  assert.doesNotMatch(raw, /site-behavior-lab-reports|"SCANNER"|"REPORTS"|ScannerContainer|scan\.sitebehavior\.org/);
});

function filesUnder(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(relative) : [relative];
  });
}

test("no workflow, deploy script or npm script can deploy it", () => {
  const namesTheWorkspace = /wrangler\.investigation|investigation-worker/;
  const deployPaths = [...filesUnder(".github/workflows"), ...filesUnder("scripts").filter((file) => file.endsWith(".mjs"))];
  assert.ok(deployPaths.some((file) => file.endsWith("deploy-container.yml")));
  assert.ok(deployPaths.some((file) => file.endsWith("deploy-container.mjs")));
  for (const file of deployPaths) {
    assert.doesNotMatch(readFileSync(path.join(root, file), "utf8"), namesTheWorkspace, file);
  }
  const scripts = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, namesTheWorkspace, name);
  }
});

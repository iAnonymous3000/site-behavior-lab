import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * The workspace's deployment shape, while nothing deploys it: its aliases stay off,
 * because a workers.dev or preview address would answer outside the Access
 * application, and it binds nothing of the public scanner's. A new top-level key
 * in the config has to be added here on purpose.
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

test("the config holds only what the deny-all Worker needs: no hostname, binding or container", () => {
  assert.deepEqual(Object.keys(config).sort(), [
    "$schema",
    "compatibility_date",
    "main",
    "name",
    "observability",
    "preview_urls",
    "workers_dev"
  ]);
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

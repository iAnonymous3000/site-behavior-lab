import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import ts from "typescript";
import { ATTEMPT_ONE, freshDirectory, handEntryText, runnerActorText, sha256OfText } from "./log-fixture";

/**
 * The log on real workerd, where its WebCrypto, TextDecoder and string methods
 * actually run. Node's differ in places, so a pass in the rest of this folder would
 * not show this. The bundle is made by the same tool and compatibility date as the
 * workspace's Worker, from a test entry: nothing here deploys, and no route exists.
 */

const ROOT = process.cwd();
const CONFIG_PATH = "wrangler.investigation.jsonc";
const config = ts.parseConfigFileTextToJson(CONFIG_PATH, readFileSync(path.join(ROOT, CONFIG_PATH), "utf8")).config as { compatibility_date: string };
const ENTRY = "investigation/test/workerd-case-log-entry.ts";

function bundle(outputDirectory: string): string {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", ENTRY, "--config", CONFIG_PATH, "--dry-run", "--outdir", outputDirectory],
    // The test's own bound cannot fire while this blocks the event loop.
    { cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe", timeout: 120_000 }
  );
  return path.join(outputDirectory, "workerd-case-log-entry.js");
}

test("on real workerd the log gives the digests Node gives, and refuses what Node refuses", { timeout: 180_000 }, async () => {
  const directory = freshDirectory("workerd");
  let miniflare: Miniflare | undefined;
  try {
    const scriptPath = bundle(directory);
    miniflare = new Miniflare({ modules: true, scriptPath, modulesRoot: directory, compatibilityDate: config.compatibility_date, log: new Log(LogLevel.ERROR) });
    const answer = await miniflare.dispatchFetch("https://workspace.invalid/");
    assert.equal(answer.status, 200);
    const evidence = "ec0a5578e135b08703e07aec1bd239a35426697ba0d8c1b4fb451f09a4f6e10a";
    const entry = handEntryText({
      actorText: runnerActorText(ATTEMPT_ONE),
      atMs: 1793534401000,
      eventsText: '[{"data":{"count":2,"nested":{"a":[1,"é"],"z":null}},"type":"capture-recorded"}]',
      evidence: [evidence],
      prev: "0".repeat(64),
      seq: 1
    });
    assert.deepEqual(await answer.json(), {
      canonical: '{"a":"é","b":"\u{1f600}"}',
      lone: true,
      evidence,
      digest: sha256OfText(entry),
      stale: "conflict",
      clean: "opened",
      otherCase: "wrong-case",
      afterEdit: "entry-edited",
      afterChange: "evidence-changed"
    });
  } finally {
    await miniflare?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { R2_DELETE_CANARY_PREFIX } from "./r2-delete-canary";

const ROOT = process.cwd();
const WORKER_NAME = "r2-delete-canary-integration";
const TOKEN = "r2-delete-canary-runtime-token-20260721";

test(
  "workerd executes the authenticated R2 create, exact readback, delete, and absence canary",
  { timeout: 30_000 },
  async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "sbl-r2-delete-runtime-"));
    let miniflare: Miniflare | undefined;
    try {
      const bundlePath = bundleCanaryWorker(temporaryDirectory);
      miniflare = new Miniflare({
        name: WORKER_NAME,
        modules: true,
        scriptPath: bundlePath,
        modulesRoot: temporaryDirectory,
        compatibilityDate: "2026-06-19",
        bindings: { SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN: TOKEN },
        r2Buckets: ["REPORTS"],
        r2Persist: false,
        log: new Log(LogLevel.ERROR)
      });

      const wrongMethod = await miniflare.dispatchFetch("https://canary.invalid/run");
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("allow"), "POST");

      const wrongPath = await miniflare.dispatchFetch("https://canary.invalid/not-run", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      assert.equal(wrongPath.status, 405);

      const missingAuth = await miniflare.dispatchFetch("https://canary.invalid/run", { method: "POST" });
      assert.equal(missingAuth.status, 401);
      assert.equal(missingAuth.headers.get("www-authenticate"), "Bearer");

      const wrongAuth = await miniflare.dispatchFetch("https://canary.invalid/run", {
        method: "POST",
        headers: { authorization: `Bearer ${"x".repeat(40)}` }
      });
      assert.equal(wrongAuth.status, 401);

      const bucket = await miniflare.getR2Bucket("REPORTS");
      assert.equal((await bucket.list({ prefix: R2_DELETE_CANARY_PREFIX })).objects.length, 0);

      const passed = await miniflare.dispatchFetch("https://canary.invalid/run", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      assert.equal(passed.status, 200);
      assert.deepEqual(await passed.json(), {
        ok: true,
        status: "passed",
        scope: "r2-write-read-delete",
        keyPrefix: R2_DELETE_CANARY_PREFIX,
        created: true,
        readBack: true,
        deleted: true
      });
      assert.equal(
        (await bucket.list({ prefix: R2_DELETE_CANARY_PREFIX })).objects.length,
        0,
        "the real R2 binding has no canary object after the absence readback"
      );
    } finally {
      await miniflare?.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
);

function bundleCanaryWorker(outputDirectory: string): string {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
      "deploy",
      path.join(ROOT, "cloudflare", "r2-delete-canary-worker.ts"),
      "--dry-run",
      "--outdir",
      outputDirectory,
      "--name",
      WORKER_NAME,
      "--compatibility-date",
      "2026-06-19"
    ],
    { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: "pipe" }
  );
  return path.join(outputDirectory, "r2-delete-canary-worker.js");
}

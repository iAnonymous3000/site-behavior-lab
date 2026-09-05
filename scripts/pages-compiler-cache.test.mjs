import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachPagesCompilerCache } from "./pages-compiler-cache.mjs";

test("a fresh Pages worktree retains compiler inputs but cannot inherit prior report or fetch output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pages-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, ".next-pages-work");
  const cache = path.join(work, ".next", "cache");
  await attachPagesCompilerCache(root, work);
  await writeFile(path.join(cache, "webpack", "pack"), "compiled module");
  await writeFile(path.join(cache, "swc", "transform"), "compiler binary");
  await writeFile(path.join(cache, ".rscinfo"), "Next-owned compiler identity");
  await writeFile(path.join(cache, ".tsbuildinfo"), "TypeScript incremental state");
  await writeFile(path.join(cache, ".previewinfo"), "old preview identity");
  await mkdir(path.join(cache, "fetch-cache"));
  await writeFile(path.join(cache, "fetch-cache", "report"), "old report");
  await writeFile(path.join(work, "deployment.json"), "old revision");
  await mkdir(path.join(work, "out"));
  await writeFile(path.join(work, "out", "report.html"), "old rendering");
  await rm(work, { recursive: true, force: true });

  await attachPagesCompilerCache(root, work);
  assert.equal(await readFile(path.join(cache, "webpack", "pack"), "utf8"), "compiled module");
  assert.equal(await readFile(path.join(cache, "swc", "transform"), "utf8"), "compiler binary");
  assert.equal(await readFile(path.join(cache, ".rscinfo"), "utf8"), "Next-owned compiler identity");
  assert.equal(await readFile(path.join(cache, ".tsbuildinfo"), "utf8"), "TypeScript incremental state");
  assert.deepEqual((await readdir(cache)).sort(), [".rscinfo", ".tsbuildinfo", "swc", "webpack"]);
  for (const stale of ["out/report.html", "deployment.json", ".next/cache/fetch-cache/report", ".next/cache/.previewinfo"]) {
    await assert.rejects(readFile(path.join(work, stale)), { code: "ENOENT" });
  }
  // Runtime and Pages compilation must not write into one another's caches.
  await assert.rejects(readFile(path.join(root, ".next", "cache", "webpack", "pack")), { code: "ENOENT" });
});

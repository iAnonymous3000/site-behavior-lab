import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  acquireReportCorpusLock,
  REPORT_CORPUS_LOCK_FILENAME,
  ReportCorpusLockedError
} from "./report-corpus-lock";

test("the shared corpus lease is exclusive and normal release removes only its own lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbl-corpus-lock-"));
  try {
    const lock = await acquireReportCorpusLock(directory, "first");
    await assert.rejects(() => acquireReportCorpusLock(directory, "second"), ReportCorpusLockedError);
    await lock.release();
    await assert.rejects(() => access(path.join(directory, REPORT_CORPUS_LOCK_FILENAME)), /ENOENT/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release never deletes a lock pathname that another writer replaced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbl-corpus-lock-race-"));
  try {
    const lock = await acquireReportCorpusLock(directory, "original");
    await unlink(lock.path);
    await writeFile(lock.path, "replacement-owner\n", { flag: "wx" });

    await assert.rejects(() => lock.release(), /lock identity changed before release/);
    assert.equal(await readFile(lock.path, "utf8"), "replacement-owner\n");
    assert.equal(
      (await readdir(directory)).some((name) => name.includes(".retired")),
      true,
      "the displaced replacement is retained for inspection instead of deleted"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

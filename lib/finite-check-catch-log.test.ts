import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertCaughtBy, CATCH_LOG_ENV, holds, loadVariant } from "./finite-check";

/**
 * The catch log of lib/finite-check.ts: what assertCaughtBy writes when the
 * environment names a log, and what it leaves unwritten.
 *
 * This is not a suite of the formal verification register. It holds the
 * recorder an execution report reads, and lib/finite-check.test.ts stays the
 * harness's own test. The variable is set and restored around each case, in
 * this process, so no other test file sees it.
 */

type Catch = { variant: string; property: string; caughtBy: string };

/** Run one case with the catch log named, and return the lines it left. */
async function withCatchLog(t: { after: (callback: () => void) => void }, run: () => Promise<unknown>): Promise<{ lines: Catch[]; raw: string }> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "finite-check-catch-log-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, "catches.jsonl");
  const before = process.env[CATCH_LOG_ENV];
  process.env[CATCH_LOG_ENV] = log;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env[CATCH_LOG_ENV];
    else process.env[CATCH_LOG_ENV] = before;
  }
  const raw = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { raw, lines: raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Catch) };
}

test("an accepted catch is appended to the named log, with the property the suite named and the one the counterexample carried", async (t) => {
  const { lines, raw } = await withCatchLog(t, async () => {
    await assertCaughtBy("a first variant", "p", () => holds("p", false, () => 1));
    await assertCaughtBy('a "second" variant', "q", async () => holds("q", false, () => 2));
  });
  assert.deepEqual(lines, [
    { variant: "a first variant", property: "p", caughtBy: "p" },
    { variant: 'a "second" variant', property: "q", caughtBy: "q" }
  ]);
  // One line to a catch, each ended, so a reader can count catches by lines.
  assert.equal(raw.split("\n").length, 3);
  assert.ok(raw.endsWith("\n"));
});

test("a harness changed to accept another property shows it in the log: the two properties differ", async (t) => {
  // The variant drops the comparison that refuses a catch for the wrong property.
  const weakened = loadVariant<{ assertCaughtBy: typeof assertCaughtBy; holds: typeof holds }>(require.resolve("./finite-check"), [
    { find: "if (error.property !== property) {", replace: "if (false) {" }
  ]);
  const { lines } = await withCatchLog(t, async () => {
    await weakened.assertCaughtBy("caught for the wrong reason", "p", () => weakened.holds("q", false, () => 1));
  });
  assert.deepEqual(lines, [{ variant: "caught for the wrong reason", property: "p", caughtBy: "q" }]);
});

test("a refused variant appends nothing: one the check passes, one caught for another property, one that breaks the check", async (t) => {
  const { raw } = await withCatchLog(t, async () => {
    await assert.rejects(assertCaughtBy("passes", "p", () => undefined), /passed the check/);
    await assert.rejects(assertCaughtBy("another property", "p", () => holds("q", false, () => 1)), /caught by "q", not "p"/);
    await assert.rejects(
      assertCaughtBy("breaks", "p", () => {
        throw new TypeError("not a counterexample");
      }),
      /broke the check itself/
    );
  });
  assert.equal(raw, "");
});

test("with no log named, or an empty name, a catch is accepted and no file is opened", async () => {
  const before = process.env[CATCH_LOG_ENV];
  try {
    // An empty name is no name. Read as a path it could not be opened, and the catch would fail.
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env[CATCH_LOG_ENV];
      else process.env[CATCH_LOG_ENV] = value;
      const caught = await assertCaughtBy("v", "p", () => holds("p", false, () => 1));
      assert.equal(caught.property, "p");
    }
  } finally {
    if (before === undefined) delete process.env[CATCH_LOG_ENV];
    else process.env[CATCH_LOG_ENV] = before;
  }
});

test("a log that cannot be written fails the catch, so a run asked for a record cannot pass without it", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "finite-check-catch-log-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = process.env[CATCH_LOG_ENV];
  process.env[CATCH_LOG_ENV] = path.join(directory, "no-such-directory", "catches.jsonl");
  try {
    await assert.rejects(assertCaughtBy("v", "p", () => holds("p", false, () => 1)), /ENOENT/);
  } finally {
    if (before === undefined) delete process.env[CATCH_LOG_ENV];
    else process.env[CATCH_LOG_ENV] = before;
  }
});

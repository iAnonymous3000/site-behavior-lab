import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSyncBounded } from "./bounded-spawn";

test("a child that exits on its own is returned, whatever its exit status", () => {
  const result = spawnSyncBounded("bash", ["-c", "echo out; echo err >&2; exit 3"], { encoding: "utf8" });
  assert.equal(result.status, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
});

test("a child still running at the bound is killed with SIGKILL and fails the test", () => {
  // The child ignores SIGTERM and would exit 0 on its own after ten seconds.
  // Without the bound that clean exit comes back as a result instead of a
  // failure, and a softer kill signal is ignored until then, so neither can
  // pass this test.
  const program = "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 10_000);";
  assert.throws(
    () => spawnSyncBounded(process.execPath, ["-e", program], { encoding: "utf8" }, 250),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(
        error.message,
        /was still running after 250 ms and was killed \(error ETIMEDOUT, signal SIGKILL\): a stuck or failed child process, not a wrong exit status/
      );
      // The program is named by its size rather than pasted into the failure.
      assert.ok(error.message.startsWith(`${process.execPath} -e <${program.length}-character argument> `));
      return true;
    }
  );
});

test("a child killed by a signal fails the test rather than reading as a refusal", () => {
  assert.throws(
    () => spawnSyncBounded("bash", ["-c", "echo partial >&2; kill -KILL $$"], { encoding: "utf8" }),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(
        error.message,
        "bash -c echo partial >&2; kill -KILL $$ was killed by a signal (error none, signal SIGKILL): " +
          "a stuck or failed child process, not a wrong exit status. Its stderr ended: partial"
      );
      return true;
    }
  );
});

test("a child that cannot start fails the test with its error", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-bounded-spawn-"));
  try {
    const missing = path.join(directory, "missing");
    assert.throws(
      () => spawnSyncBounded(missing, [], { encoding: "utf8" }),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.ok(
          error.message.startsWith(`${missing} could not run to completion (error ENOENT, signal none): `),
          error.message
        );
        return true;
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Runs a child process synchronously for a test, and fails the test when the
// child does not exit on its own within a bound.
//
// Tests that execute a workflow's own controller text (a `run: |` block through
// `bash -c`, an inline program through `node -e`) do it with spawnSync, and
// spawnSync blocks the event loop until the child exits, so node --test's own
// --test-timeout cannot fire while it waits. A controller that never exits
// therefore froze its test file, held a slot of the parallel unit lane, and
// made a local gate look hung rather than red. On 2026-10-19 that was every
// local run of release-evidence.test.ts on a Mac whose kernel pipe buffers had
// fallen under 1 KB: bash 5.3 blocked forever writing the here-document of
// `read -r ... < <(node <<'NODE' ...)`, while Linux CI passed the same file.
//
// Every such spawn goes through spawnSyncBounded. The child gets
// SPAWN_SYNC_TIMEOUT_MS and is then killed with SIGKILL, which no trap can
// delay. A child that did not exit on its own (still running at the bound,
// killed by any signal, or unable to start) fails the test with a message
// naming result.error and result.signal. Returning it instead would let a
// refusal check such as `notEqual(status, 0)` read the null status of a killed
// controller as a refusal, and pass.
//
// Killing the child does not kill what it started: a process substitution
// blocked in a here-document write outlives the bash that ran it. It holds
// only its own pipes, so the test still fails and the run still ends, but it
// lingers until killed by pid. Running the child detached, so that its whole
// process group could be killed, would also put it out of reach of Ctrl-C on
// the gate, so it is not.
//
// Test support only: no production module may import this.

import assert from "node:assert/strict";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";

// The slowest spawn these tests made on 2026-10-19 took 0.38 s (the
// release-evidence.mjs CLI over its fixture), and the slowest bash controller
// 0.2 s. A minute is over 150 times that: room for a slow or overloaded CI
// runner, while a stuck child still fails within a minute instead of never.
export const SPAWN_SYNC_TIMEOUT_MS = 60_000;

export type BoundedSpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, "timeout" | "killSignal">;

/**
 * spawnSync with a deadline. Returns the result of a child that exited on its
 * own, whatever its exit status, and fails the test on any other outcome.
 * `timeoutMs` exists for this module's own test.
 */
export function spawnSyncBounded(
  command: string,
  args: readonly string[],
  options: BoundedSpawnOptions,
  timeoutMs: number = SPAWN_SYNC_TIMEOUT_MS
): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { ...options, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (result.error !== undefined || result.signal !== null) {
    assert.fail(unfinishedChildMessage(command, args, result, timeoutMs));
  }
  return result;
}

function unfinishedChildMessage(
  command: string,
  args: readonly string[],
  result: SpawnSyncReturns<string>,
  timeoutMs: number
): string {
  // A controller is thousands of characters of shell or JavaScript. Name it by
  // size; the failing test's own name says which one it was. Paths and short
  // one-line arguments stay readable.
  const shown = [
    command,
    ...args.map((arg) => (arg.length > 200 || arg.includes("\n") ? `<${arg.length}-character argument>` : arg))
  ].join(" ");
  const error = result.error as NodeJS.ErrnoException | undefined;
  const outcome =
    error?.code === "ETIMEDOUT"
      ? `was still running after ${timeoutMs} ms and was killed`
      : error !== undefined
        ? "could not run to completion"
        : "was killed by a signal";
  // A child that never started has no output at all.
  const stderr = typeof result.stderr === "string" ? result.stderr.trim().slice(-400) : "";
  return (
    `${shown} ${outcome} (error ${error?.code ?? error?.message ?? "none"}, signal ${result.signal ?? "none"}): ` +
    "a stuck or failed child process, not a wrong exit status." +
    (stderr ? ` Its stderr ended: ${stderr}` : "")
  );
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as afterTurn } from "node:timers/promises";
import { test } from "node:test";
import {
  runScannerCleanupWithinDeadline,
  ScannerOperationTimeoutError,
  withScannerOperationDeadline
} from "./scanner-resource-lifecycle";

test("scanner operations return at the deadline when work ignores cancellation", async () => {
  let signal: AbortSignal | null = null;
  const started = Date.now();
  await assert.rejects(
    withScannerOperationDeadline(
      async (operationSignal) => {
        signal = operationSignal;
        return new Promise<never>(() => undefined);
      },
      { label: "hostile operation", timeoutMs: 5 }
    ),
    (error: unknown) =>
      error instanceof ScannerOperationTimeoutError && error.label === "hostile operation"
  );
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  assert.equal(Date.now() - started < 250, true);
});

test("a resource that resolves after timeout is disposed exactly once", async () => {
  let resolveResource: (value: { id: number }) => void = () => undefined;
  const pendingResource = new Promise<{ id: number }>((resolve) => {
    resolveResource = resolve;
  });
  const disposed: number[] = [];
  const operation = withScannerOperationDeadline(
    () => pendingResource,
    {
      label: "late browser launch",
      timeoutMs: 5,
      onLateSuccess: async (resource) => {
        disposed.push(resource.id);
      }
    }
  );

  await assert.rejects(operation, ScannerOperationTimeoutError);
  resolveResource({ id: 7 });
  await afterTurn();
  assert.deepEqual(disposed, [7]);
});

test("scanner cleanup starts every close and returns without awaiting hostile promises", async () => {
  const started: string[] = [];
  const before = Date.now();
  await runScannerCleanupWithinDeadline(
    [
      {
        label: "context close",
        run: () => {
          started.push("context");
          return new Promise(() => undefined);
        }
      },
      {
        label: "proxy close",
        run: () => {
          started.push("proxy");
          return Promise.reject(new Error("close failed"));
        }
      }
    ],
    5
  );

  assert.deepEqual(started.sort(), ["context", "proxy"]);
  assert.equal(Date.now() - before < 250, true);
});

test("the scanner bounds cached Chromium launch and both final cleanup operations", async () => {
  const source = await readFile(path.join(process.cwd(), "lib/scanner.ts"), "utf8");

  assert.match(source, /withScannerOperationDeadline<Browser>\([\s\S]*chromium\.launch/);
  assert.match(source, /onLateSuccess: \(browser\) =>[\s\S]*browser\.close\(\)/);
  assert.match(source, /browserLaunchPromise = null/);
  assert.match(source, /runScannerCleanupWithinDeadline\(\[[\s\S]*contextToClose\.close\(\)[\s\S]*scanProxy\.close\(\)/);
});

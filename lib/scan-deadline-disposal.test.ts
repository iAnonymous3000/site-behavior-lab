import assert from "node:assert/strict";
import test from "node:test";
import { withDeadlineDisposing } from "./scan-runtime";

const timeoutError = () => new Error("scan-deadline");

/** Resolves with a disposable handle after `delayMs`, recording disposal. */
function lateResource(delayMs: number) {
  const state = { disposed: 0 };
  const value = { id: "resource" };
  const operation = new Promise<typeof value>((resolve) => setTimeout(() => resolve(value), delayMs));
  return { state, value, operation, dispose: () => { state.disposed += 1; } };
}

/** Lets a late operation settle and its disposal microtask run. */
async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("a resource that arrives after the deadline is disposed, not abandoned", async () => {
  // Racing abandons the loser, it never cancels it. Without disposal a proxy
  // server or browser context that materializes a moment late stays open for
  // the lifetime of the process, holding a port or a Chromium context while
  // the scan slot it belonged to has already been released.
  const { state, operation, dispose } = lateResource(120);

  await assert.rejects(
    withDeadlineDisposing(() => operation, Date.now(), 30, dispose, timeoutError),
    /scan-deadline/
  );
  assert.equal(state.disposed, 0, "the resource does not exist yet when the deadline fires");

  await settle(200);
  assert.equal(state.disposed, 1, "the late resource must be disposed exactly once");
});

test("a resource delivered within the deadline is returned and never disposed", async () => {
  const { state, value, operation, dispose } = lateResource(5);

  assert.equal(await withDeadlineDisposing(() => operation, Date.now(), 500, dispose, timeoutError), value);
  await settle(50);
  assert.equal(state.disposed, 0, "the caller owns a resource it successfully received");
});

test("the deadline is absolute: time already spent is time unavailable", async () => {
  // Setup steps run in sequence, so each must inherit what the previous ones
  // consumed. A per-operation budget would let a wedged sequence outlive the
  // duration the scan advertises, one step at a time.
  const { state, operation, dispose } = lateResource(60);
  const started = Date.now() - 90;

  await assert.rejects(
    withDeadlineDisposing(() => operation, started, 100, dispose, timeoutError),
    /scan-deadline/,
    "only 10ms of a 100ms budget remained"
  );
  await settle(150);
  assert.equal(state.disposed, 1);
});

test("an exhausted deadline never starts creating the resource", async () => {
  // The step is a factory precisely so this case allocates nothing: a caller
  // passing an already-constructed promise has started the work before the
  // deadline could refuse it.
  let started = 0;
  let disposed = 0;

  await assert.rejects(
    withDeadlineDisposing(
      () => { started += 1; return Promise.resolve({ id: "r" }); },
      Date.now() - 500,
      100,
      () => { disposed += 1; },
      timeoutError
    ),
    /scan-deadline/
  );
  await settle(50);
  assert.equal(started, 0, "nothing may be created once the deadline has passed");
  assert.equal(disposed, 0, "and so there is nothing to dispose");
});

test("caller cancellation ends the wait and still disposes a late resource", async () => {
  const { state, operation, dispose } = lateResource(120);
  const controller = new AbortController();
  const pending = withDeadlineDisposing(() => operation, Date.now(), 5_000, dispose, timeoutError, controller.signal);

  controller.abort(new Error("scan-cancelled"));
  await assert.rejects(pending, /scan-cancelled/, "cancellation must not wait out the full deadline");

  await settle(200);
  assert.equal(state.disposed, 1, "a resource that arrives after cancellation must not leak");
});

test("a signal already aborted creates nothing", async () => {
  let started = 0;
  const controller = new AbortController();
  controller.abort(new Error("scan-cancelled"));

  await assert.rejects(
    withDeadlineDisposing(
      () => { started += 1; return Promise.resolve({ id: "r" }); },
      Date.now(),
      5_000,
      () => undefined,
      timeoutError,
      controller.signal
    ),
    /scan-cancelled/
  );
  assert.equal(started, 0);
});

test("an operation that fails on its own disposes nothing and surfaces its own error", async () => {
  let disposed = 0;
  const failure = new Error("proxy refused to bind");

  await assert.rejects(
    withDeadlineDisposing(() => Promise.reject(failure), Date.now(), 500, () => { disposed += 1; }, timeoutError),
    /proxy refused to bind/,
    "the real cause must not be replaced by a deadline error"
  );
  await settle(50);
  assert.equal(disposed, 0, "there is no resource to dispose when creation failed");
});

test("a disposal that itself fails cannot mask the deadline or crash the process", async () => {
  const operation = new Promise<{ id: string }>((resolve) => setTimeout(() => resolve({ id: "r" }), 60));

  await assert.rejects(
    withDeadlineDisposing(() => operation, Date.now(), 20, () => Promise.reject(new Error("close failed")), timeoutError),
    /scan-deadline/
  );
  // An unhandled rejection here would take down the scanner process; reaching
  // this line at all is the assertion.
  await settle(150);
});

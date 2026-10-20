import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { setImmediate as afterTurn } from "node:timers/promises";
import { test } from "node:test";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { PublicScanError } from "./public-errors";
import {
  closeSharedBrowserForTests,
  SCAN_SETUP_TIMEOUT_MESSAGE,
  scanSiteWithMeasurement,
  type ScanSiteOptions
} from "./scanner";
import {
  runScannerCleanupWithinDeadline,
  ScannerOperationTimeoutError,
  withScannerOperationDeadline
} from "./scanner-resource-lifecycle";
import type { ScanRequestPayload } from "./types";

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
  assert.ok(Date.now() - started < 1_000, "the 5ms deadline must win, not the 15s operation default");
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
  assert.ok(Date.now() - before < 1_000, "the 5ms cleanup bound must win, not the 2s cleanup default");
});

test("the scanner bounds cached Chromium launch, both final cleanup operations and a retired browser's close", async () => {
  const source = await readFile(path.join(process.cwd(), "lib/scanner.ts"), "utf8");

  assert.match(source, /withScannerOperationDeadline<Browser>\([\s\S]*chromium\.launch/);
  assert.match(source, /onLateSuccess: \(browser\) =>[\s\S]*browser\.close\(\)/);
  assert.match(source, /browserLaunchPromise = null/);
  assert.match(source, /runScannerCleanupWithinDeadline\(\[[\s\S]*contextToClose\.close\(\)[\s\S]*scanProxy\.close\(\)/);
  // Playwright sends Browser.close with no deadline, and a retired browser is
  // the one most likely to be wedged.
  assert.match(
    source,
    /void runScannerCleanupWithinDeadline\(\[\{ label: "retired Chromium close", run: \(\) => browser\.close\(\) \}\]\);/,
    "a retired browser's close must be detached and bounded"
  );
});

/**
 * The scanner's own Chromium, instrumented. Every browser it launches while
 * this is installed is recorded, and that browser's newContext and close are
 * wrapped, so a test can cancel a visit or wedge it at exactly its context
 * creation, hold a created context back from its visit, reach a visit's
 * context before the visit does, and count the closes the scanner issues.
 */
type ScannerChromium = {
  readonly launched: Browser[];
  /** Browser.close calls per launched browser, until stopCounting. */
  readonly closeCalls: Map<Browser, number>;
  /** One per creation passed straight to Chromium, neither wedged nor held, settled once its context has closed. */
  readonly contextsClosed: Promise<void>[];
  /** For each cancel armed below, whether its context was still being created when it fired. */
  readonly cancelsDuringCreation: boolean[];
  /** Cancels the visit making the next newContext call while that call is in flight. */
  cancelNextContextCreation: (() => void) | null;
  /** Makes the next newContext call never settle, as a wedged browser's does. */
  wedgeNextContextCreation: boolean;
  wedgedContextCreations: number;
  /** Receives the next context created, before the scanner does. */
  onNextContext: ((context: BrowserContext) => void) | null;
  /** Holds the next context Chromium creates back from its visit, as a slow browser would. */
  holdNextContextCreation(): HeldContextCreation;
  /** Resolves with the next browser the scanner launches after this call. */
  nextLaunch(): Promise<Browser>;
  /** The test's own cleanup closes browsers too; those closes are not the scanner's. */
  stopCounting(): void;
  restore(): void;
};

type HeldContextCreation = {
  /** Resolves once a visit has asked for the held context. */
  readonly requested: Promise<void>;
  /** Hands the context, created in Chromium meanwhile, to the visit that asked for it. */
  deliver(): void;
  /** Resolves once the scanner itself closes the delivered context. */
  readonly disposed: Promise<void>;
};

function instrumentScannerChromium(): ScannerChromium {
  const launchWaiters: Array<(browser: Browser) => void> = [];
  let counting = true;
  let heldCreation: { requested: () => void; delivery: Promise<void>; disposed: () => void } | null = null;
  const originalLaunch = chromium.launch;
  const instrumented: ScannerChromium = {
    launched: [],
    closeCalls: new Map(),
    contextsClosed: [],
    cancelsDuringCreation: [],
    cancelNextContextCreation: null,
    wedgeNextContextCreation: false,
    wedgedContextCreations: 0,
    onNextContext: null,
    holdNextContextCreation: () => {
      let requested = (): void => undefined;
      let deliver = (): void => undefined;
      let disposed = (): void => undefined;
      const held = {
        requested: new Promise<void>((resolve) => {
          requested = resolve;
        }),
        delivery: new Promise<void>((resolve) => {
          deliver = resolve;
        }),
        disposed: new Promise<void>((resolve) => {
          disposed = resolve;
        })
      };
      heldCreation = { requested, delivery: held.delivery, disposed };
      return { requested: held.requested, deliver, disposed: held.disposed };
    },
    nextLaunch: () => new Promise<Browser>((resolve) => launchWaiters.push(resolve)),
    stopCounting: () => {
      counting = false;
    },
    restore: () => {
      chromium.launch = originalLaunch;
    }
  };
  chromium.launch = async (...args: Parameters<typeof chromium.launch>) => {
    const browser = await originalLaunch.apply(chromium, args);
    instrumented.launched.push(browser);
    const originalNewContext = browser.newContext;
    browser.newContext = (...contextArgs: Parameters<Browser["newContext"]>) => {
      if (instrumented.wedgeNextContextCreation) {
        instrumented.wedgeNextContextCreation = false;
        instrumented.wedgedContextCreations += 1;
        return new Promise<BrowserContext>(() => undefined);
      }
      const held = heldCreation;
      heldCreation = null;
      if (held) {
        const pending = originalNewContext.apply(browser, contextArgs);
        held.requested();
        return pending.then(
          async (context) => {
            await held.delivery;
            const close = context.close;
            context.close = (...closeArgs: Parameters<BrowserContext["close"]>) => {
              held.disposed();
              return close.apply(context, closeArgs);
            };
            return context;
          },
          async (error: unknown) => {
            await held.delivery;
            throw error;
          }
        );
      }
      const creation = originalNewContext.apply(browser, contextArgs);
      let settled = false;
      const onContext = instrumented.onNextContext;
      instrumented.onNextContext = null;
      instrumented.contextsClosed.push(
        creation.then(
          (context) => {
            settled = true;
            const closed = new Promise<void>((resolve) => context.once("close", () => resolve()));
            onContext?.(context);
            return closed;
          },
          () => {
            settled = true;
          }
        )
      );
      const cancel = instrumented.cancelNextContextCreation;
      instrumented.cancelNextContextCreation = null;
      if (cancel) {
        // A microtask, not a timer: it runs after the scanner subscribes to its
        // signal, which withDeadlineDisposing does synchronously once this call
        // returns, and before Chromium can answer, which takes a round trip.
        queueMicrotask(() => {
          instrumented.cancelsDuringCreation.push(!settled);
          cancel();
        });
      }
      return creation;
    };
    const originalClose = browser.close;
    browser.close = (...closeArgs: Parameters<Browser["close"]>) => {
      if (counting) instrumented.closeCalls.set(browser, (instrumented.closeCalls.get(browser) ?? 0) + 1);
      return originalClose.apply(browser, closeArgs);
    };
    for (const waiter of launchWaiters.splice(0)) waiter(browser);
    return browser;
  };
  return instrumented;
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${timeoutMs} ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startScanFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Fixture</title><p>Small, ordinary public page.</p>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

async function closeScanFixture(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const fixturePayload: ScanRequestPayload = {
  url: "http://fixture.test/",
  device: "desktop",
  gpcEnabled: false,
  consentMode: "observe"
};

function fixtureScanOptions(port: number, extra: ScanSiteOptions = {}): ScanSiteOptions {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    ...extra
  };
}

function scanOutcome(scan: Promise<unknown>): Promise<string> {
  return scan.then(
    () => "completed",
    (error: unknown) => {
      if (error instanceof PublicScanError && error.message === SCAN_SETUP_TIMEOUT_MESSAGE) return "scan setup timeout";
      if (error instanceof Error && error.name === "AbortError") return "AbortError";
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  );
}

test("a visit cancelled while its context is being created keeps the shared browser", { timeout: 60_000 }, async () => {
  // A cancel says nothing about the browser. Retiring it there launched a
  // fresh Chromium after every cancel and never closed the one it replaced,
  // about 150 MB each, until a deploy or the kernel ended the process.
  await closeSharedBrowserForTests();
  const scanner = instrumentScannerChromium();
  const fixture = await startScanFixture();
  try {
    const warm = await scanSiteWithMeasurement(fixturePayload, fixtureScanOptions(fixture.port));
    const cancelled: string[] = [];
    // A caller's own reason reaches the visit as its error, so the scanner
    // must read its signal, not the error's type.
    const reasons = [
      undefined,
      new DOMException("The caller timed out.", "TimeoutError"),
      new Error("The client went away.")
    ];
    for (const reason of reasons) {
      const controller = new AbortController();
      scanner.cancelNextContextCreation = () => controller.abort(reason);
      cancelled.push(
        await scanOutcome(
          scanSiteWithMeasurement(fixturePayload, fixtureScanOptions(fixture.port, { signal: controller.signal }))
        )
      );
    }
    const next = await scanSiteWithMeasurement(fixturePayload, fixtureScanOptions(fixture.port));
    // Every context these visits asked for has closed, including the three a
    // cancel left to arrive after its visit had ended.
    await settleWithin(Promise.all(scanner.contextsClosed), 10_000, "Every context the visits created closing");
    assert.deepEqual(
      {
        statuses: [warm.result.summary.status, next.result.summary.status],
        cancelled,
        cancelsDuringCreation: scanner.cancelsDuringCreation,
        contextsCreated: scanner.contextsClosed.length,
        launches: scanner.launched.length,
        connected: scanner.launched.filter((browser) => browser.isConnected()).length
      },
      {
        statuses: [200, 200],
        cancelled: ["AbortError", "TimeoutError: The caller timed out.", "Error: The client went away."],
        cancelsDuringCreation: [true, true, true],
        contextsCreated: 5,
        launches: 1,
        connected: 1
      }
    );
  } finally {
    scanner.stopCounting();
    await closeSharedBrowserForTests();
    for (const browser of scanner.launched) await browser.close().catch(() => undefined);
    scanner.restore();
    await closeScanFixture(fixture.server);
  }
});

test(
  "a browser that cannot open a context is retired, keeps its own DevTools port for a sibling visit, and closes after that visit",
  { timeout: 90_000 },
  async () => {
    // PR #128's recovery stays: the wedged browser leaves the cache and the
    // next visit launches a fresh one. The sibling still mid-setup on the
    // wedged one must dial that browser's DevTools port, not the fresh one's,
    // and the wedged browser closes when the sibling gives it back, not before
    // and not never.
    await closeSharedBrowserForTests();
    const scanner = instrumentScannerChromium();
    const fixture = await startScanFixture();
    let releaseSibling = (): void => undefined;
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const inFlight: Promise<unknown>[] = [];
    try {
      // The sibling holds its context on the first browser and waits there,
      // before its page and its worker realm channel exist.
      let siblingHasContext = (): void => undefined;
      const siblingContextReady = new Promise<void>((resolve) => {
        siblingHasContext = resolve;
      });
      scanner.onNextContext = (context) => {
        const newPage = context.newPage;
        context.newPage = async () => {
          await siblingGate;
          return newPage.apply(context);
        };
        siblingHasContext();
      };
      const order: string[] = [];
      let siblingChannel = false;
      const sibling = scanOutcome(
        scanSiteWithMeasurement(
          fixturePayload,
          fixtureScanOptions(fixture.port, {
            onWorkerRealmChannelEstablishedForTests: () => {
              siblingChannel = true;
            }
          })
        )
      ).then((outcome) => {
        order.push("sibling settled");
        return outcome;
      });
      inFlight.push(sibling);
      await settleWithin(siblingContextReady, 20_000, "The sibling visit opening its context");
      assert.equal(scanner.launched.length, 1, "the sibling's visit launches the first browser");
      const [first] = scanner.launched;
      const firstDisconnected = new Promise<void>((resolve) => {
        first.once("disconnected", () => {
          order.push("first browser disconnected");
          resolve();
        });
      });

      // Three seconds of budget left, so the wedged creation reaches the scan
      // deadline quickly and still has time to be asked for.
      scanner.wedgeNextContextCreation = true;
      const wedged = await scanOutcome(
        scanSiteWithMeasurement(fixturePayload, fixtureScanOptions(fixture.port, { scanBudgetSpentMsForTests: 42_000 }))
      );

      const relaunch = scanner.nextLaunch();
      let nextChannel = false;
      const next = scanOutcome(
        scanSiteWithMeasurement(
          fixturePayload,
          fixtureScanOptions(fixture.port, {
            onWorkerRealmChannelEstablishedForTests: () => {
              nextChannel = true;
            }
          })
        )
      );
      inFlight.push(next);
      await settleWithin(relaunch, 20_000, "A fresh browser launching for the visit after the wedge");
      const firstClosesWhileSiblingHeldIt = scanner.closeCalls.get(first) ?? 0;
      const firstConnectedWhileSiblingHeldIt = first.isConnected();

      releaseSibling();
      const siblingOutcome = await settleWithin(sibling, 45_000, "The sibling visit finishing");
      const nextOutcome = await settleWithin(next, 45_000, "The visit on the fresh browser finishing");
      const firstClosed = await settleWithin(firstDisconnected, 15_000, "The first browser closing").then(
        () => true,
        () => false
      );
      assert.deepEqual(
        {
          wedgedContextCreations: scanner.wedgedContextCreations,
          wedged,
          launches: scanner.launched.length,
          firstClosesWhileSiblingHeldIt,
          firstConnectedWhileSiblingHeldIt,
          sibling: siblingOutcome,
          siblingChannel,
          next: nextOutcome,
          nextChannel,
          firstClosed,
          // A copy: the cleanup below closes the first browser if the scanner
          // never did, and that must not rewrite what was observed here.
          order: [...order],
          firstCloses: scanner.closeCalls.get(first) ?? 0
        },
        {
          wedgedContextCreations: 1,
          wedged: "scan setup timeout",
          launches: 2,
          firstClosesWhileSiblingHeldIt: 0,
          firstConnectedWhileSiblingHeldIt: true,
          sibling: "completed",
          siblingChannel: true,
          next: "completed",
          nextChannel: true,
          firstClosed: true,
          order: ["sibling settled", "first browser disconnected"],
          firstCloses: 1
        }
      );
    } finally {
      releaseSibling();
      await Promise.allSettled(inFlight);
      scanner.stopCounting();
      await closeSharedBrowserForTests();
      for (const browser of scanner.launched) await browser.close().catch(() => undefined);
      scanner.restore();
      await closeScanFixture(fixture.server);
    }
  }
);

test(
  "a cancel racing a wedge closes the retired browser once, and a context that arrives after the close is disposed",
  { timeout: 60_000 },
  async () => {
    await closeSharedBrowserForTests();
    const scanner = instrumentScannerChromium();
    const fixture = await startScanFixture();
    let held: HeldContextCreation | null = null;
    const inFlight: Promise<unknown>[] = [];
    try {
      // The first visit's context is created in Chromium but held back from
      // it, as a slow browser's would be, until after its browser has closed.
      held = scanner.holdNextContextCreation();
      const controller = new AbortController();
      const cancelled = scanOutcome(
        scanSiteWithMeasurement(fixturePayload, fixtureScanOptions(fixture.port, { signal: controller.signal }))
      );
      inFlight.push(cancelled);
      await settleWithin(held.requested, 20_000, "The first visit asking for its context");
      assert.equal(scanner.launched.length, 1, "the first visit launches the browser");
      const [browser] = scanner.launched;
      const disconnected = new Promise<void>((resolve) => {
        browser.once("disconnected", () => resolve());
      });

      // A second visit on the same browser wedges and retires it while the
      // first still holds it. Then the first is cancelled mid-creation.
      scanner.wedgeNextContextCreation = true;
      const wedged = await scanOutcome(
        scanSiteWithMeasurement(fixturePayload, fixtureScanOptions(fixture.port, { scanBudgetSpentMsForTests: 42_000 }))
      );
      const closesWhileFirstHeldIt = scanner.closeCalls.get(browser) ?? 0;
      controller.abort();
      const cancelOutcome = await settleWithin(cancelled, 20_000, "The cancelled visit settling");
      const closed = await settleWithin(disconnected, 15_000, "The retired browser closing").then(
        () => true,
        () => false
      );
      held.deliver();
      const lateContextDisposed = await settleWithin(held.disposed, 10_000, "The late context being disposed").then(
        () => true,
        () => false
      );
      assert.deepEqual(
        {
          wedgedContextCreations: scanner.wedgedContextCreations,
          wedged,
          cancelled: cancelOutcome,
          closesWhileFirstHeldIt,
          closed,
          closes: scanner.closeCalls.get(browser) ?? 0,
          lateContextDisposed,
          launches: scanner.launched.length
        },
        {
          wedgedContextCreations: 1,
          wedged: "scan setup timeout",
          cancelled: "AbortError",
          closesWhileFirstHeldIt: 0,
          closed: true,
          closes: 1,
          lateContextDisposed: true,
          launches: 1
        }
      );
    } finally {
      held?.deliver();
      await Promise.allSettled(inFlight);
      scanner.stopCounting();
      await closeSharedBrowserForTests();
      for (const browser of scanner.launched) await browser.close().catch(() => undefined);
      scanner.restore();
      await closeScanFixture(fixture.server);
    }
  }
);

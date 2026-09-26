import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import {
  DedicatedWorkerAttachSession,
  devtoolsBrowserWebSocketUrl,
  openDevtoolsBrowserChannel,
  type AttachedWorker,
  type DevtoolsChannel,
  type WorkerRealmInstaller
} from "./devtools-worker-channel";
import { fingerprintObserverWorkerInstallExpression } from "./worker-fingerprint-realm";

/**
 * The fingerprint observer in paused dedicated worker realms, against real
 * Chromium on local pages. These tests run from the compiled output, never
 * through tsx: the install evaluates the observer's serialized source, and a
 * transpiler that injects helpers into it changes what reaches the realm.
 */

const FIXTURE_SITE_KEY = "127.0.0.1";

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const reservation = createNetServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const bound = reservation.address();
      const port = bound && typeof bound === "object" ? bound.port : null;
      reservation.close(() => (port === null ? reject(new Error("no port")) : resolve(port)));
    });
  });
}

async function startFixtureServer(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

type PausedWorkerHarness = {
  page: Page;
  session: DedicatedWorkerAttachSession;
  crashed: () => boolean;
};

/**
 * A browser with a loopback DevTools port, one page, and the scanner's worker
 * realm channel attached to that page with `installers`, exactly as the
 * scanner opens it.
 */
async function openPausedWorkerHarness(
  t: TestContext,
  installers: readonly WorkerRealmInstaller[]
): Promise<PausedWorkerHarness> {
  const devtoolsPort = await reserveLoopbackPort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${devtoolsPort}`] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  let crashed = false;
  page.on("crash", () => {
    crashed = true;
  });
  const targetSession = await context.newCDPSession(page);
  const info = (await targetSession.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
  await targetSession.detach();
  const channel = await openDevtoolsBrowserChannel(await devtoolsBrowserWebSocketUrl(devtoolsPort));
  const session = new DedicatedWorkerAttachSession(channel, installers);
  t.after(() => session.close());
  await session.attachToPage(info.targetInfo.targetId);
  return { page, session, crashed: () => crashed };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A follow-up evaluate answers only while the page's renderer is alive. */
async function pageStillAnswers(page: Page): Promise<boolean> {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(
      (value) => value === 2,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
}

type InstallRecord = { sessionId: string; nested: boolean; value: unknown; exception: string | null };

/**
 * Evaluates the production worker install expression in each paused worker
 * and keeps what the realm answered.
 */
function recordingObserverInstaller(expression: string) {
  const installs: InstallRecord[] = [];
  const installer: WorkerRealmInstaller = {
    async install(worker: AttachedWorker, channel: DevtoolsChannel) {
      let value: unknown;
      let exception: string | null = null;
      try {
        const evaluated = await channel.send(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          worker.sessionId
        );
        const details = evaluated.exceptionDetails as { exception?: { description?: unknown } } | undefined;
        if (details) exception = String(details.exception?.description ?? "exception");
        value = (evaluated.result as { value?: unknown } | undefined)?.value;
      } catch (error) {
        exception = error instanceof Error ? error.message : String(error);
      }
      installs.push({ sessionId: worker.sessionId, nested: worker.nested, value, exception });
    },
    concluded() {}
  };
  return { installer, installs };
}

/**
 * Design test 9, the paused-install crash guard. A worker paused before its
 * first statement has a partly initialized global, and reading a lazily
 * initialized worker global there (self.location) or creating a WebGL context
 * crashes the renderer, taking the measured page and all its workers with it,
 * in every arm. This installs the compiled observer, through the production
 * install expression, into every dedicated worker shape the scanner can meet,
 * including the ones whose script fails to load or parse, and requires the
 * page to survive, every attached worker to answer `true`, and every runnable
 * worker to run with the observer already in place.
 *
 * It runs in the unit suite, which CI runs on every pull request, including
 * each Playwright or Chromium bump: a new Chromium can make another global
 * lazy, and this is where that shows.
 */
test("real Chromium: installing the observer into paused workers of every shape never crashes the renderer", { timeout: 60_000 }, async (t) => {
  const beacons: string[] = [];
  // A worker's own testimony that the observer was in place before its first
  // statement: the offscreen getImageData it sees is no longer native.
  const beaconSource =
    "fetch(BEACON_ORIGIN + '/beacon/' + self.name + '?wrapped=' + String(!Function.prototype.toString.call(OffscreenCanvasRenderingContext2D.prototype.getImageData).includes('[native code]')));";
  const port = await startFixtureServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/beacon/")) {
      beacons.push(`${url.pathname.slice("/beacon/".length)}${url.search}`);
      response.writeHead(204);
      response.end();
      return;
    }
    const source = beaconSource.replace("BEACON_ORIGIN", JSON.stringify(`http://${request.headers.host}`));
    const scripts: Record<string, string> = {
      "/w.js": source,
      "/m.js": `import './dep.js';\n${source}`,
      "/dep.js": "export {};",
      "/nested.js": `${source} new Worker('/w.js', { name: 'nestedchild' });`,
      "/import-fails.js": `import './does-not-exist.js';\n${source}`,
      "/syntax.js": `${source} +++ ;;; {`
    };
    const script = scripts[url.pathname];
    if (script) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>paused install crash guard</title><script>
      const source = ${JSON.stringify(beaconSource)}.replace("BEACON_ORIGIN", JSON.stringify(location.origin));
      new Worker('/w.js', { name: 'classic' });
      new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), { name: 'blob' });
      new Worker('data:text/javascript,' + encodeURIComponent(source), { name: 'data' });
      new Worker('/m.js', { name: 'module', type: 'module' });
      new Worker('/nested.js', { name: 'nestedparent' });
      new Worker('/missing.js', { name: 'missing' });
      new Worker('/import-fails.js', { name: 'importfails', type: 'module' });
      new Worker('/syntax.js', { name: 'syntax' });
    </script>`);
  });

  const { installer, installs } = recordingObserverInstaller(fingerprintObserverWorkerInstallExpression(FIXTURE_SITE_KEY));
  const harness = await openPausedWorkerHarness(t, [installer]);
  // Every shape above creates a worker target: the six that run, and the
  // three whose script 404s, fails an import or fails to parse.
  const expectedAttaches = 9;
  const runnableWorkers = ["blob", "classic", "data", "module", "nestedchild", "nestedparent"];
  await harness.page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 }).catch(() => undefined);
  await waitFor(() => installs.length >= expectedAttaches && beacons.length >= runnableWorkers.length, 15_000);
  await harness.session.settle(5_000);

  assert.equal(harness.crashed(), false, "installing the observer into a paused worker crashed the renderer");
  assert.equal(await pageStillAnswers(harness.page), true, "the measured page must survive every paused install");
  assert.deepEqual(harness.session.attachCounts(), {
    attachedDedicatedWorkerCount: expectedAttaches,
    attachedNestedDedicatedWorkerCount: 1,
    attachedSharedWorkerCount: 0
  });
  assert.equal(installs.length, expectedAttaches, "every attached worker must have been installed into");
  for (const install of installs) {
    assert.deepEqual(
      { value: install.value, exception: install.exception },
      { value: true, exception: null },
      `the install into worker session ${install.sessionId} must run to its end inside the realm`
    );
  }
  assert.deepEqual(
    beacons.map((beacon) => beacon.split("?")[0]).sort(),
    runnableWorkers,
    "every runnable worker must still run after its paused install"
  );
  for (const beacon of beacons) {
    assert.match(beacon, /\?wrapped=true$/, `the observer must precede the worker's first statement: ${beacon}`);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import {
  DedicatedWorkerAttachSession,
  devtoolsBrowserWebSocketUrl,
  openDevtoolsBrowserChannel,
  type AttachedWorker,
  type DevtoolsChannel,
  type DevtoolsEvent,
  type WorkerRealmInstaller
} from "./devtools-worker-channel";
import { collectFingerprintObservationsWithCoverage, fingerprintObserverInitScript } from "./fingerprint-observer";
import {
  FingerprintWorkerRealmInstaller,
  fingerprintObserverWorkerInstallExpression
} from "./worker-fingerprint-realm";

/**
 * The fingerprint observer in paused dedicated worker realms. The browser
 * tests run against real Chromium on local pages, from the compiled output,
 * never through tsx: the install evaluates the observer's serialized source,
 * and a transpiler that injects helpers into it changes what reaches the
 * realm.
 */

const FIXTURE_SITE_KEY = "127.0.0.1";

type SentCommand = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

function scriptedChannel(
  respond: (command: SentCommand) => Record<string, unknown> | Promise<Record<string, unknown>> | Error = () => ({})
) {
  const sent: SentCommand[] = [];
  const handlers: Array<(event: DevtoolsEvent) => void> = [];
  const channel: DevtoolsChannel = {
    async send(method, params = {}, sessionId) {
      const command: SentCommand = { method, params, ...(sessionId ? { sessionId } : {}) };
      sent.push(command);
      const result = await respond(command);
      if (result instanceof Error) throw result;
      return result;
    },
    onEvent(handler) {
      handlers.push(handler);
    },
    close() {}
  };
  return {
    channel,
    sent,
    emit(event: DevtoolsEvent) {
      for (const handler of handlers) handler(event);
    }
  };
}

function attachEvent(sessionId: string, type: "worker" | "shared_worker" = "worker"): DevtoolsEvent {
  return {
    method: "Target.attachedToTarget",
    sessionId: "page-session",
    params: {
      sessionId,
      targetInfo: { type, targetId: `${sessionId}-target`, url: "http://fixture.test/w.js" },
      waitingForDebugger: true
    }
  };
}

function commandsFor(sent: readonly SentCommand[], sessionId: string): string[] {
  return sent
    .filter((command) => command.sessionId === sessionId)
    .map((command) => (command.method === "Runtime.evaluate" ? `Runtime.evaluate ${String(command.params.expression)}` : command.method));
}

test("the worker install expression is the document observer's own source, called with the site key and the worker realm", () => {
  const expression = fingerprintObserverWorkerInstallExpression("example.com");
  assert.equal(
    expression,
    `(${fingerprintObserverInitScript.toString()})("example.com", {"realm":"dedicated-worker"})`,
    "a worker must run exactly the function documents run, not a second copy of it"
  );
});

/**
 * One source for both realms. The worker module may take the observer's
 * function and its types, and nothing else: a wrapper, threshold or heuristic
 * restated beside the observer would let the two realms disagree while each
 * passes its own tests.
 */
test("the worker realm module takes nothing from the observer but its function and types", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/worker-fingerprint-realm.ts"), "utf8");
  const observerImports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']\.\/fingerprint-observer["']/g)];
  assert.equal(observerImports.length, 1, "exactly one import from the observer");
  const [, wholeTypeImport, names] = observerImports[0];
  const valueNames = wholeTypeImport
    ? []
    : names
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "" && !name.startsWith("type "));
  assert.deepEqual(valueNames, ["fingerprintObserverInitScript"]);
});

test("the installer evaluates the one expression in each dedicated worker before its resume and counts only a true answer", async () => {
  const expression = fingerprintObserverWorkerInstallExpression(FIXTURE_SITE_KEY);
  const answers: Record<string, Record<string, unknown> | Error> = {
    "answers-true": { result: { type: "boolean", value: true } },
    "answers-false": { result: { type: "boolean", value: false } },
    throws: {
      result: { type: "object", subtype: "error" },
      exceptionDetails: { exception: { description: "ReferenceError: window is not defined" } }
    },
    "transport-fails": new Error("Session with given id not found.")
  };
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") return answers[command.sessionId!];
    return {};
  });
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const session = new DedicatedWorkerAttachSession(scripted.channel, [installer]);
  await session.attachToPage("page-target-id");
  for (const sessionId of Object.keys(answers)) scripted.emit(attachEvent(sessionId));
  await session.settle(1_000);

  for (const sessionId of Object.keys(answers)) {
    assert.deepEqual(commandsFor(scripted.sent, sessionId), [
      "Target.setAutoAttach",
      `Runtime.evaluate ${expression}`,
      "Runtime.runIfWaitingForDebugger"
    ]);
  }
  assert.deepEqual(installer.installDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 3 });
});

/**
 * An answer that comes back after the watchdog let the worker run cannot say
 * the observer preceded the worker's first statement: the worker may have run
 * uninstrumented for part of the window.
 */
test("an install answer arriving after the watchdog released the worker leaves it counted as failed", async () => {
  let answerEvaluate: (() => void) | null = null;
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") {
      return new Promise((resolve) => {
        answerEvaluate = () => resolve({ result: { type: "boolean", value: true } });
      });
    }
    return {};
  });
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const session = new DedicatedWorkerAttachSession(scripted.channel, [installer], { handshakeTimeoutMs: 50 });
  await session.attachToPage("page-target-id");
  scripted.emit(attachEvent("slow-worker"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(installer.installDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1 });

  answerEvaluate!();
  await session.settle(1_000);
  assert.deepEqual(installer.installDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1 });
  assert.equal(
    commandsFor(scripted.sent, "slow-worker").filter((method) => method === "Runtime.runIfWaitingForDebugger").length,
    1
  );
});

test("a shared worker attach gets nothing installed and no install record", async () => {
  const scripted = scriptedChannel((command) =>
    command.method === "Target.attachToTarget" ? { sessionId: "page-session" } : {}
  );
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const session = new DedicatedWorkerAttachSession(scripted.channel, [installer]);
  await session.attachToPage("page-target-id");
  scripted.emit(attachEvent("shared-session", "shared_worker"));
  await session.settle(1_000);

  assert.deepEqual(commandsFor(scripted.sent, "shared-session"), [
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger"
  ]);
  assert.deepEqual(installer.installDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 0 });
  assert.equal(session.attachCounts().attachedSharedWorkerCount, 1);
});

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
  channel: DevtoolsChannel;
  session: DedicatedWorkerAttachSession;
  installer: FingerprintWorkerRealmInstaller;
  /** Every worker the channel attached, in attach order. */
  workers: AttachedWorker[];
  crashed: () => boolean;
};

/**
 * A browser with a loopback DevTools port, one page, and the scanner's worker
 * realm channel attached to that page with the production fingerprint
 * installer, exactly as the scanner opens it in an arm without GPC.
 */
async function openPausedWorkerHarness(t: TestContext): Promise<PausedWorkerHarness> {
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
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const workers: AttachedWorker[] = [];
  // Records which workers were attached, then hands each to the production
  // installer unchanged.
  const attachRecorder: WorkerRealmInstaller = {
    async install(worker: AttachedWorker, installChannel: DevtoolsChannel) {
      workers.push(worker);
      await installer.install(worker, installChannel);
    },
    concluded(worker: AttachedWorker) {
      installer.concluded(worker);
    }
  };
  const session = new DedicatedWorkerAttachSession(channel, [attachRecorder]);
  t.after(() => session.close());
  await session.attachToPage(info.targetInfo.targetId);
  return { page, channel, session, installer, workers, crashed: () => crashed };
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

type WorkerReading = { name: string; snapshot: unknown; nested: boolean };

/**
 * Reads each attached worker's cumulative snapshot from inside its realm over
 * the same DevTools session that installed it. The inspector serializes the
 * answer natively, so nothing the worker did to its own intrinsics can shape
 * what the test reads.
 */
async function readWorkerSnapshots(harness: PausedWorkerHarness): Promise<WorkerReading[]> {
  const readings: WorkerReading[] = [];
  for (const worker of harness.workers) {
    const evaluated = await harness.channel.send(
      "Runtime.evaluate",
      {
        expression:
          "({ name: self.name, snapshot: typeof self.__siteBehaviorLabFingerprintSnapshot === 'function' ? self.__siteBehaviorLabFingerprintSnapshot() : null })",
        returnByValue: true
      },
      worker.sessionId
    );
    const value = (evaluated.result as { value?: { name: string; snapshot: unknown } } | undefined)?.value;
    assert.ok(value, `worker session ${worker.sessionId} answered no reading`);
    readings.push({ name: value.name, snapshot: value.snapshot, nested: worker.nested });
  }
  return readings.sort((left, right) => left.name.localeCompare(right.name));
}

/** A worker realm's snapshot through the same collection a frame's goes through. */
function snapshotAsFrame(snapshot: unknown) {
  return { evaluate: async () => snapshot };
}

/**
 * Design test 9, the paused-install crash guard. A worker paused before its
 * first statement has a partly initialized global, and reading a lazily
 * initialized worker global there (self.location) or creating a WebGL context
 * crashes the renderer, taking the measured page and all its workers with it,
 * in every arm. This installs the compiled observer through the production
 * installer into every dedicated worker shape the scanner can meet, including
 * the ones whose script fails to load or parse, and requires the page to
 * survive, every attached worker to be installed, and every runnable worker to
 * run with the observer already in place.
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

  const harness = await openPausedWorkerHarness(t);
  // Every shape above creates a worker target: the six that run, and the
  // three whose script 404s, fails an import or fails to parse.
  const expectedAttaches = 9;
  const runnableWorkers = ["blob", "classic", "data", "module", "nestedchild", "nestedparent"];
  await harness.page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 }).catch(() => undefined);
  await waitFor(() => {
    const { installedWorkerCount, installFailedWorkerCount } = harness.installer.installDiagnostics();
    return installedWorkerCount + installFailedWorkerCount >= expectedAttaches && beacons.length >= runnableWorkers.length;
  }, 15_000);
  await harness.session.settle(5_000);

  assert.equal(harness.crashed(), false, "installing the observer into a paused worker crashed the renderer");
  assert.equal(await pageStillAnswers(harness.page), true, "the measured page must survive every paused install");
  assert.deepEqual(harness.session.attachCounts(), {
    attachedDedicatedWorkerCount: expectedAttaches,
    attachedNestedDedicatedWorkerCount: 1,
    attachedSharedWorkerCount: 0
  });
  assert.deepEqual(
    harness.installer.installDiagnostics(),
    { installedWorkerCount: expectedAttaches, installFailedWorkerCount: 0 },
    "every attached worker's install must run to its end inside the realm and answer true"
  );
  assert.deepEqual(
    beacons.map((beacon) => beacon.split("?")[0]).sort(),
    runnableWorkers,
    "every runnable worker must still run after its paused install"
  );
  for (const beacon of beacons) {
    assert.match(beacon, /\?wrapped=true$/, `the observer must precede the worker's first statement: ${beacon}`);
  }
});

/**
 * One fingerprinting routine, OffscreenCanvas 2D text and readback with an
 * export, font measurement across ten fonts, and a WebGL renderer and pixel
 * read, run once in the page and once in a dedicated worker. The body is the
 * same source text in both realms.
 */
const PROBE_SOURCE = `
async function probe(name, origin) {
  const canvas = new OffscreenCanvas(200, 60);
  const context = canvas.getContext("2d");
  context.font = "14px Arial";
  context.fillText("abcdefghijklmnopqrstuvwxyz0123", 2, 20);
  context.getImageData(0, 0, 200, 60);
  await canvas.convertToBlob();
  const fontContext = new OffscreenCanvas(10, 10).getContext("2d");
  for (const font of ["Arial", "Courier New", "Georgia", "Times New Roman", "Verdana", "Tahoma", "Impact", "Comic Sans MS", "Trebuchet MS", "Palatino"]) {
    fontContext.font = "72px '" + font + "', monospace";
    fontContext.measureText("mmmmmmmmmmlli");
  }
  const gl = new OffscreenCanvas(16, 16).getContext("webgl");
  gl.getParameter(37446);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  await fetch(origin + "/done/" + name);
}
`;

/**
 * Worker-side events are recorded by the page realm's own wrappers and
 * heuristics: the same routine yields the same events and the same detections
 * in a worker as in the page, read through the same collection.
 */
test("real Chromium: a dedicated worker records the same events and detections as the page for the same routine", { timeout: 60_000 }, async (t) => {
  const done: string[] = [];
  const port = await startFixtureServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/done/")) {
      done.push(url.pathname.slice("/done/".length));
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/probe.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(`${PROBE_SOURCE}\nprobe(self.name, self.location.origin);`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>realm parity</title><script>${PROBE_SOURCE}
      probe("page", location.origin).then(() => new Worker("/probe.js", { name: "worker" }));
    </script>`);
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.addInitScript(fingerprintObserverInitScript, FIXTURE_SITE_KEY);
  await harness.page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 2, 15_000);
  assert.deepEqual(done.sort(), ["page", "worker"]);

  const pageCollection = await collectFingerprintObservationsWithCoverage([harness.page.mainFrame()]);
  const [workerReading] = await readWorkerSnapshots(harness);
  assert.equal(workerReading.name, "worker");
  const workerCollection = await collectFingerprintObservationsWithCoverage([snapshotAsFrame(workerReading.snapshot)]);

  assert.equal(pageCollection.readableFrames, 1);
  assert.equal(workerCollection.readableFrames, 1, "the worker realm's snapshot must be one the frame collection accepts");
  assert.deepEqual(
    workerCollection.observations,
    pageCollection.observations,
    "the worker realm must record exactly what the page records for the same routine"
  );
  assert.deepEqual(
    workerCollection.observations.detections.map((detection) => detection.heuristic).sort(),
    ["canvas-font-probing-v1", "openwpm-canvas-v1", "webgl-entropy-read-v1"]
  );
  const canvas = workerCollection.observations.detections.find((detection) => detection.kind === "canvas-fingerprinting");
  assert.deepEqual(canvas?.evidence, {
    readApis: ["canvas.convertToBlob", "canvas.getImageData"],
    maxCanvasWidth: 200,
    maxCanvasHeight: 60,
    maxDistinctTextCharacters: 30,
    maxTextWriteCalls: 1
  });
  assert.deepEqual(harness.installer.installDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0 });
});

test("real Chromium: a worker started by another worker is observed in its own realm", { timeout: 60_000 }, async (t) => {
  const done: string[] = [];
  const port = await startFixtureServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/done/")) {
      done.push(url.pathname.slice("/done/".length));
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/parent.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(
        `const childSource = ${JSON.stringify(`${PROBE_SOURCE}\nprobe(self.name, ORIGIN);`)}.replace("ORIGIN", JSON.stringify(self.location.origin));\n` +
          "new Worker(URL.createObjectURL(new Blob([childSource], { type: 'text/javascript' })), { name: 'child' });\n" +
          "fetch(self.location.origin + '/done/parent');"
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>nested worker</title><script>new Worker("/parent.js", { name: "parent" });</script>`);
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 2, 15_000);
  assert.deepEqual(done.sort(), ["child", "parent"]);

  const readings = await readWorkerSnapshots(harness);
  assert.deepEqual(
    readings.map((reading) => ({ name: reading.name, nested: reading.nested })),
    [
      { name: "child", nested: true },
      { name: "parent", nested: false }
    ]
  );
  const child = await collectFingerprintObservationsWithCoverage([snapshotAsFrame(readings[0].snapshot)]);
  const parent = await collectFingerprintObservationsWithCoverage([snapshotAsFrame(readings[1].snapshot)]);
  assert.deepEqual(
    child.observations.detections.map((detection) => detection.heuristic).sort(),
    ["canvas-font-probing-v1", "openwpm-canvas-v1", "webgl-entropy-read-v1"],
    "the nested worker's own calls must be recorded in its own realm"
  );
  assert.deepEqual(parent.observations, { events: [], detections: [] }, "a worker that only starts another records nothing");
  assert.equal(harness.session.attachCounts().attachedNestedDedicatedWorkerCount, 1);
  assert.deepEqual(harness.installer.installDiagnostics(), { installedWorkerCount: 2, installFailedWorkerCount: 0 });
});

/**
 * A worker that turns hostile after the install: it replaces the canvas and
 * size getters and the collection and serialization intrinsics, deletes
 * createImageBitmap from its global, and then fingerprints through a bitmap
 * drawn from a text canvas into a second canvas that it reads. The observer
 * captured everything it uses at install, and its createImageBitmap wrapper
 * sits on WorkerGlobalScope.prototype, where the delete does not reach.
 */
test("real Chromium: a worker that poisons its realm after install still has its fingerprinting recorded", { timeout: 60_000 }, async (t) => {
  const done: string[] = [];
  const hostile = `
    const nativeGetImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
    Object.defineProperty(OffscreenCanvasRenderingContext2D.prototype, "canvas", { get() { return null; }, configurable: true });
    Object.defineProperty(OffscreenCanvas.prototype, "width", { get() { return 1; }, configurable: true });
    Object.defineProperty(OffscreenCanvas.prototype, "height", { get() { return 1; }, configurable: true });
    Set.prototype.add = function () { return this; };
    Map.prototype.get = function () { return undefined; };
    Map.prototype.set = function () { return this; };
    JSON.stringify = () => "{}";
    Object.keys = () => [];
    self.queueMicrotask = () => {};
    const deleted = delete self.createImageBitmap;
    const createBitmap = self.createImageBitmap;
    const nativeFetch = fetch;
    const origin = self.location.origin;
    const reflectApply = Reflect.apply;
    Reflect.apply = () => undefined;
    Function.prototype.call = function () { return undefined; };
    (async () => {
      const source = new OffscreenCanvas(200, 60);
      source.getContext("2d").fillText("abcdefghijklmnopqrstuvwxyz0123", 2, 20);
      const bitmap = await createBitmap(source);
      const target = new OffscreenCanvas(200, 60);
      const context = target.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      reflectApply(nativeGetImageData, context, [0, 0, 200, 60]);
      await nativeFetch(origin + "/done/" + String(deleted) + "-" + String(typeof createBitmap));
    })();
  `;
  const port = await startFixtureServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/done/")) {
      done.push(url.pathname.slice("/done/".length));
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/hostile.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(hostile);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>hostile worker</title><script>new Worker("/hostile.js", { name: "hostile" });</script>`);
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  // The delete succeeded and the worker still found a createImageBitmap: the
  // one on the prototype, which is the observer's wrapper.
  assert.deepEqual(done, ["true-function"]);

  const [reading] = await readWorkerSnapshots(harness);
  const collection = await collectFingerprintObservationsWithCoverage([snapshotAsFrame(reading.snapshot)]);
  assert.equal(collection.readableFrames, 1);
  assert.deepEqual(collection.observations.detections, [
    {
      kind: "canvas-fingerprinting",
      heuristic: "openwpm-canvas-v1",
      count: 1,
      evidence: {
        readApis: ["canvas.getImageData"],
        maxCanvasWidth: 200,
        maxCanvasHeight: 60,
        maxDistinctTextCharacters: 30,
        maxTextWriteCalls: 1
      }
    }
  ]);
});

/**
 * Listener coverage is a document fact: a worker has no user input to listen
 * to. A worker's addEventListener therefore stays native, and its
 * registrations capture no stacks and never reach the interaction summaries.
 */
test("real Chromium: a worker realm keeps its native addEventListener", { timeout: 60_000 }, async (t) => {
  const done: string[] = [];
  const port = await startFixtureServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/done/")) {
      done.push(url.pathname.slice("/done/".length));
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/listener.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(
        "for (const type of ['message', 'keydown', 'input', 'click', 'scroll']) self.addEventListener(type, () => undefined);\n" +
          "fetch(self.location.origin + '/done/' + String(Function.prototype.toString.call(EventTarget.prototype.addEventListener).includes('[native code]')));"
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>worker listeners</title><script>new Worker("/listener.js", { name: "listener" });</script>`);
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  assert.deepEqual(done, ["true"], "the worker's addEventListener must be the native one");
  const [reading] = await readWorkerSnapshots(harness);
  const collection = await collectFingerprintObservationsWithCoverage([snapshotAsFrame(reading.snapshot)]);
  assert.deepEqual(collection.observations, { events: [], detections: [] });
  assert.equal(collection.listenerAttributionLostFrames, 0);
  assert.deepEqual(harness.installer.installDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0 });
});

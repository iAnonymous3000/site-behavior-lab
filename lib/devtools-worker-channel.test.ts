import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  DedicatedWorkerAttachSession,
  devtoolsBrowserWebSocketUrl,
  openDevtoolsBrowserChannel,
  type AttachedWorker,
  type DevtoolsChannel,
  type DevtoolsEvent,
  type WorkerRealmConclusion,
  type WorkerRealmInstaller
} from "./devtools-worker-channel";
import { GPC_WORKER_HANDSHAKE_EXPRESSION, GpcWorkerRealmInstaller } from "./gpc-worker-verification";

/**
 * The worker realm channel's own contract, apart from any one installer: one
 * attach, installers in list order inside each worker's single pause, one
 * resume, and exactly one conclusion per worker for every installer. The GPC
 * arm's composition is pinned in gpc-worker-verification.test.ts.
 */

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
      const result = respond(command);
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

function workerAttachEvent(sessionId: string): DevtoolsEvent {
  return {
    method: "Target.attachedToTarget",
    sessionId: "page-session",
    params: {
      sessionId,
      targetInfo: { type: "worker", targetId: `${sessionId}-target`, url: "http://fixture.test/w.js" },
      waitingForDebugger: true
    }
  };
}

function pageAttachResponder(command: SentCommand): Record<string, unknown> {
  return command.method === "Target.attachToTarget" ? { sessionId: "page-session" } : {};
}

type Conclusion = { how: WorkerRealmConclusion; releasedAtConclusion: boolean };

/**
 * An installer that evaluates `expression` in the worker and records what the
 * channel tells it. `stall` makes its install wait until the test lets it go;
 * `fail` makes its install throw.
 */
function recordingInstaller(expression: string, behavior: { stall?: boolean; fail?: boolean } = {}) {
  const conclusions: Conclusion[] = [];
  const installs: string[] = [];
  let finishStall: (() => void) | null = null;
  const stalled = new Promise<void>((resolve) => {
    finishStall = resolve;
  });
  const installer: WorkerRealmInstaller = {
    async install(worker: AttachedWorker, channel: DevtoolsChannel) {
      installs.push(worker.sessionId);
      if (behavior.stall) await stalled;
      if (behavior.fail) throw new Error(`${expression} failed to install`);
      await channel.send("Runtime.evaluate", { expression, returnByValue: true }, worker.sessionId);
    },
    concluded(worker: AttachedWorker, how: WorkerRealmConclusion) {
      conclusions.push({ how, releasedAtConclusion: worker.released });
    }
  };
  return { installer, conclusions, installs, finishStall: () => finishStall!() };
}

function commandsFor(sent: readonly SentCommand[], sessionId: string): string[] {
  return sent
    .filter((command) => command.sessionId === sessionId)
    .map((command) =>
      command.method === "Runtime.evaluate" ? `Runtime.evaluate ${String(command.params.expression)}` : command.method
    );
}

test("installers run in list order inside one pause, and the worker is resumed exactly once", async () => {
  const scripted = scriptedChannel(pageAttachResponder);
  const first = recordingInstaller("first");
  const second = recordingInstaller("second");
  const session = new DedicatedWorkerAttachSession(scripted.channel, [first.installer, second.installer]);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(1_000);

  assert.deepEqual(commandsFor(scripted.sent, "worker-session"), [
    "Target.setAutoAttach",
    "Runtime.evaluate first",
    "Runtime.evaluate second",
    "Runtime.runIfWaitingForDebugger"
  ]);
  // Concluded once each, after the one resume was sent.
  assert.deepEqual(first.conclusions, [{ how: "released", releasedAtConclusion: true }]);
  assert.deepEqual(second.conclusions, [{ how: "released", releasedAtConclusion: true }]);
});

test("a channel with no installers sends a worker nothing but the recursion and one resume", async () => {
  const scripted = scriptedChannel(pageAttachResponder);
  const session = new DedicatedWorkerAttachSession(scripted.channel, []);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(1_000);

  // The channel itself never evaluates inside a realm: in an arm with no
  // installers, the only commands a paused worker receives are these two.
  assert.deepEqual(commandsFor(scripted.sent, "worker-session"), [
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger"
  ]);
  assert.deepEqual(session.attachCounts(), {
    attachedDedicatedWorkerCount: 1,
    attachedNestedDedicatedWorkerCount: 0,
    attachedSharedWorkerCount: 0
  });
});

test("the watchdog concludes every installer before its one resume, and nothing installs after it", async () => {
  const scripted = scriptedChannel(pageAttachResponder);
  const stalling = recordingInstaller("stalling", { stall: true });
  const later = recordingInstaller("later");
  const session = new DedicatedWorkerAttachSession(scripted.channel, [stalling.installer, later.installer], {
    handshakeTimeoutMs: 50
  });
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  // The conclusion goes out before the resume, so an install result arriving
  // after it knows the worker had already been let go.
  assert.deepEqual(stalling.conclusions, [{ how: "watchdog", releasedAtConclusion: false }]);
  assert.deepEqual(later.conclusions, [{ how: "watchdog", releasedAtConclusion: false }]);
  assert.deepEqual(commandsFor(scripted.sent, "worker-session"), [
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger"
  ]);

  // The stalled install finishing now must not let the next installer into a
  // running realm, send a second resume, or conclude anyone again.
  stalling.finishStall();
  await session.settle(1_000);
  assert.deepEqual(later.installs, [], "no installer may run after the watchdog released the worker");
  assert.deepEqual(commandsFor(scripted.sent, "worker-session"), [
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger",
    "Runtime.evaluate stalling"
  ]);
  assert.equal(stalling.conclusions.length, 1);
  assert.equal(later.conclusions.length, 1);
});

test("an installer that throws does not skip the next installer or the resume", async () => {
  const scripted = scriptedChannel(pageAttachResponder);
  const failing = recordingInstaller("failing", { fail: true });
  const next = recordingInstaller("next");
  const session = new DedicatedWorkerAttachSession(scripted.channel, [failing.installer, next.installer]);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(1_000);

  assert.deepEqual(commandsFor(scripted.sent, "worker-session"), [
    "Target.setAutoAttach",
    "Runtime.evaluate next",
    "Runtime.runIfWaitingForDebugger"
  ]);
  assert.deepEqual(failing.conclusions, [{ how: "released", releasedAtConclusion: true }]);
  assert.deepEqual(next.conclusions, [{ how: "released", releasedAtConclusion: true }]);
});

test("settle concludes a worker still paused exactly once, and the flow finishing later adds nothing", async () => {
  const scripted = scriptedChannel(pageAttachResponder);
  const stalling = recordingInstaller("stalling", { stall: true });
  // The watchdog is beyond this test's horizon, so only the settle sweep can
  // conclude the worker.
  const session = new DedicatedWorkerAttachSession(scripted.channel, [stalling.installer], {
    handshakeTimeoutMs: 60_000
  });
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(0);
  assert.deepEqual(stalling.conclusions, [{ how: "settled", releasedAtConclusion: false }]);

  stalling.finishStall();
  await session.settle(1_000);
  assert.equal(stalling.conclusions.length, 1);
  assert.deepEqual(commandsFor(scripted.sent, "worker-session"), [
    "Target.setAutoAttach",
    "Runtime.evaluate stalling",
    "Runtime.runIfWaitingForDebugger"
  ]);
});

/**
 * GPC runs first so its outcome cannot depend on what runs after it in the
 * same pause. A later installer that stalls past the watchdog, or throws,
 * leaves a worker whose readback came back true while it was held verified.
 */
test("a later installer's stall or failure cannot unverify a GPC readback taken while the worker was held", async () => {
  for (const behavior of [{ stall: true }, { fail: true }]) {
    const scripted = scriptedChannel((command) => {
      if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
      if (command.method === "Runtime.evaluate" && command.params.expression === GPC_WORKER_HANDSHAKE_EXPRESSION) {
        return { result: { value: true } };
      }
      return {};
    });
    const gpc = new GpcWorkerRealmInstaller();
    const later = recordingInstaller("later", behavior);
    const session = new DedicatedWorkerAttachSession(scripted.channel, [gpc, later.installer], {
      handshakeTimeoutMs: 50
    });
    await session.attachToPage("page-target-id");
    scripted.emit(workerAttachEvent("worker-session"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    later.finishStall();
    await session.settle(1_000);

    assert.deepEqual(
      gpc.verificationDiagnostics(session.attachCounts()),
      {
        attachedDedicatedWorkerCount: 1,
        attachedNestedDedicatedWorkerCount: 0,
        attachedSharedWorkerCount: 0,
        verifiedWorkerCount: 1,
        unverifiedAttachedWorkerCount: 0
      },
      `a later installer that ${behavior.stall ? "stalls" : "throws"} must not change the GPC outcome`
    );
    assert.equal(
      commandsFor(scripted.sent, "worker-session").filter((method) => method === "Runtime.runIfWaitingForDebugger")
        .length,
      1
    );
  }
});

/**
 * Against real Chromium: in every dedicated worker shape, the GPC installer and
 * a second installer both run inside the worker's one pause, in that order,
 * before the worker's first statement, and each worker is resumed once. The
 * second installer records whether GPC was already present when it ran, so the
 * order is testified from inside the realm, not only read off the command log.
 */
test("real Chromium: installers run in order inside each worker's one pause, before its first statement", { timeout: 30_000 }, async (t) => {
  const beacons: string[] = [];
  const beaconSource =
    "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl) + '&order=' + String(globalThis.__sblInstallOrder));";
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/beacon/")) {
      beacons.push(decodeURIComponent(url.slice("/beacon/".length)));
      response.writeHead(204);
      response.end();
      return;
    }
    const scripts: Record<string, string> = {
      "/w.js": beaconSource,
      "/m.js": `import './dep.js';\n${beaconSource}`,
      "/dep.js": "export {};",
      "/nested.js": `${beaconSource} new Worker('/w.js', { name: 'nestedchild' });`
    };
    const script = scripts[url.split("?")[0]];
    if (script) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>installer order</title><script>
      const beaconSource = ${JSON.stringify(beaconSource)};
      // A data: worker runs in an opaque origin, so its beacon target is
      // baked in absolutely.
      const dataSource = beaconSource.replace("self.location.origin + '", "'" + location.origin);
      new Worker('/w.js', { name: 'classic' });
      new Worker(URL.createObjectURL(new Blob([beaconSource], { type: 'text/javascript' })), { name: 'blob' });
      new Worker('data:text/javascript,' + encodeURIComponent(dataSource), { name: 'data' });
      new Worker('/m.js', { name: 'module', type: 'module' });
      new Worker('/nested.js', { name: 'nestedparent' });
    </script>`);
  });
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

  const devtoolsPort = await new Promise<number>((resolve, reject) => {
    const reservation = createNetServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const bound = reservation.address();
      const port = bound && typeof bound === "object" ? bound.port : null;
      reservation.close(() => (port === null ? reject(new Error("no port")) : resolve(port)));
    });
  });
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${devtoolsPort}`]
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  let crashed = false;
  page.on("crash", () => {
    crashed = true;
  });

  const targetSession = await context.newCDPSession(page);
  const info = (await targetSession.send("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  await targetSession.detach();

  const channel = await openDevtoolsBrowserChannel(await devtoolsBrowserWebSocketUrl(devtoolsPort));
  t.after(() => channel.close());
  const sent: SentCommand[] = [];
  const recording: DevtoolsChannel = {
    send(method, params = {}, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      return channel.send(method, params, sessionId);
    },
    onEvent: (handler) => channel.onEvent(handler),
    close: () => channel.close()
  };
  // Reads only navigator, which is initialized while the worker is paused.
  const orderExpression =
    "globalThis.__sblInstallOrder = navigator.globalPrivacyControl === true ? 'after-gpc' : 'before-gpc'; true;";
  const gpc = new GpcWorkerRealmInstaller();
  const marker: WorkerRealmInstaller = {
    async install(worker, installChannel) {
      await installChannel.send("Runtime.evaluate", { expression: orderExpression, returnByValue: true }, worker.sessionId);
    },
    concluded() {}
  };
  const session = new DedicatedWorkerAttachSession(recording, [gpc, marker]);
  await session.attachToPage(info.targetInfo.targetId);

  await page.goto(`http://127.0.0.1:${address.port}/`, { timeout: 10_000 });
  const deadline = Date.now() + 15_000;
  while (beacons.length < 6 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await session.settle(5_000);

  assert.deepEqual(
    beacons.map((beacon) => beacon.split("?")[0]).sort(),
    ["blob", "classic", "data", "module", "nestedchild", "nestedparent"]
  );
  for (const beacon of beacons) {
    assert.match(beacon, /gpc=true&order=after-gpc$/, `both installers must precede the first statement, GPC first: ${beacon}`);
  }
  assert.equal(crashed, false);
  assert.equal(await page.evaluate(() => 1 + 1), 2, "the measured page must survive the pauses");

  const workerSessions = [...new Set(sent.filter((command) => command.method === "Runtime.evaluate").map((command) => command.sessionId!))];
  assert.equal(workerSessions.length, 6);
  for (const sessionId of workerSessions) {
    assert.deepEqual(commandsFor(sent, sessionId), [
      "Target.setAutoAttach",
      `Runtime.evaluate ${GPC_WORKER_HANDSHAKE_EXPRESSION}`,
      `Runtime.evaluate ${orderExpression}`,
      "Runtime.runIfWaitingForDebugger"
    ]);
  }
  assert.deepEqual(gpc.verificationDiagnostics(session.attachCounts()), {
    attachedDedicatedWorkerCount: 6,
    attachedNestedDedicatedWorkerCount: 1,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 6,
    unverifiedAttachedWorkerCount: 0
  });
});

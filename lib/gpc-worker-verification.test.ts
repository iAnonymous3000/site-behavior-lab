import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";
import {
  devtoolsBrowserWebSocketUrl,
  GPC_WORKER_HANDSHAKE_EXPRESSION,
  GpcWorkerVerificationSession,
  openDevtoolsBrowserChannel,
  type GpcWorkerCdpChannel,
  type GpcWorkerCdpEvent
} from "./gpc-worker-verification";

type SentCommand = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

type ScriptedChannel = {
  channel: GpcWorkerCdpChannel;
  emit(event: GpcWorkerCdpEvent): void;
  sent: SentCommand[];
  closed(): boolean;
};

function scriptedChannel(
  respond: (command: SentCommand) => Record<string, unknown> | Promise<Record<string, unknown>> | Error = () => ({})
): ScriptedChannel {
  const sent: SentCommand[] = [];
  const handlers: Array<(event: GpcWorkerCdpEvent) => void> = [];
  let isClosed = false;
  return {
    channel: {
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
      close() {
        isClosed = true;
      }
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
    sent,
    closed: () => isClosed
  };
}

function workerAttachEvent(sessionId: string, type = "worker"): GpcWorkerCdpEvent {
  return {
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: { type, targetId: `${sessionId}-target`, url: "http://fixture.test/w.js" },
      waitingForDebugger: true
    }
  };
}

/**
 * The handshake expression is the delivery AND the attestation, so it is
 * pinned behaviorally, not by string matching: it must install the signal
 * into a bare realm and answer true, and it must answer false in a realm
 * where installation cannot succeed. A version of this expression that
 * returns true without reading the realm back fails the second pin.
 */
test("the handshake expression installs GPC and attests only what the realm actually holds", () => {
  const bareNavigator: Record<string, unknown> = {};
  const installedReadback = runInNewContext(GPC_WORKER_HANDSHAKE_EXPRESSION, { navigator: bareNavigator });
  assert.equal(installedReadback, true);
  assert.equal(bareNavigator.globalPrivacyControl, true);
  assert.equal(
    Object.getOwnPropertyDescriptor(bareNavigator, "globalPrivacyControl")?.configurable,
    false
  );

  const sabotagedNavigator: Record<string, unknown> = {};
  Object.defineProperty(sabotagedNavigator, "globalPrivacyControl", {
    configurable: false,
    get: () => false
  });
  const sabotagedReadback = runInNewContext(GPC_WORKER_HANDSHAKE_EXPRESSION, {
    navigator: sabotagedNavigator
  });
  assert.equal(
    sabotagedReadback,
    false,
    "a realm that did not accept the signal must never be attested as carrying it"
  );
});

test("attaching to the page target turns on paused auto-attach for exactly that session", async () => {
  const scripted = scriptedChannel((command) =>
    command.method === "Target.attachToTarget" ? { sessionId: "page-session" } : {}
  );
  const session = new GpcWorkerVerificationSession(scripted.channel);
  await session.attachToPage("page-target-id");

  assert.deepEqual(scripted.sent[0], {
    method: "Target.attachToTarget",
    params: { targetId: "page-target-id", flatten: true }
  });
  assert.deepEqual(scripted.sent[1], {
    method: "Target.setAutoAttach",
    params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId: "page-session"
  });
});

test("a worker that reads the signal back true is verified, after recursion and before release", async () => {
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") return { result: { value: true } };
    return {};
  });
  const session = new GpcWorkerVerificationSession(scripted.channel);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(1_000);

  const workerCommands = scripted.sent.filter((command) => command.sessionId === "worker-session");
  assert.deepEqual(
    workerCommands.map((command) => command.method),
    ["Target.setAutoAttach", "Runtime.evaluate", "Runtime.runIfWaitingForDebugger"],
    "recursion must be armed before the worker is released, or a nested worker starts unobserved"
  );
  const evaluate = workerCommands.find((command) => command.method === "Runtime.evaluate");
  assert.equal(evaluate?.params.expression, GPC_WORKER_HANDSHAKE_EXPRESSION);
  assert.equal(evaluate?.params.returnByValue, true);
  assert.deepEqual(session.diagnostics(), {
    attachedDedicatedWorkerCount: 1,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 1,
    unverifiedAttachedWorkerCount: 0
  });
});

test("a false readback and an evaluate failure are both terminal unverified states, and both release", async () => {
  for (const evaluateOutcome of [{ result: { value: false } }, new Error("worker realm rejected the evaluate")]) {
    const scripted = scriptedChannel((command) => {
      if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
      if (command.method === "Runtime.evaluate") return evaluateOutcome;
      return {};
    });
    const session = new GpcWorkerVerificationSession(scripted.channel);
    await session.attachToPage("page-target-id");
    scripted.emit(workerAttachEvent("worker-session"));
    await session.settle(1_000);

    assert.deepEqual(session.diagnostics(), {
      attachedDedicatedWorkerCount: 1,
      attachedSharedWorkerCount: 0,
      verifiedWorkerCount: 0,
      unverifiedAttachedWorkerCount: 1
    });
    assert.equal(
      scripted.sent.some(
        (command) =>
          command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "worker-session"
      ),
      true,
      "an unverified worker must still be released: the site keeps its worker either way"
    );
  }
});

test("a stalled handshake is concluded unverified by the watchdog and a late readback cannot upgrade it", async () => {
  let releaseEvaluate: ((value: Record<string, unknown>) => void) | null = null;
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") {
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseEvaluate = resolve;
      });
    }
    return {};
  });
  const session = new GpcWorkerVerificationSession(scripted.channel, { handshakeTimeoutMs: 50 });
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(2_000);

  assert.deepEqual(session.diagnostics(), {
    attachedDedicatedWorkerCount: 1,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 0,
    unverifiedAttachedWorkerCount: 1
  });
  assert.equal(
    scripted.sent.some(
      (command) =>
        command.method === "Runtime.runIfWaitingForDebugger" && command.sessionId === "worker-session"
    ),
    true,
    "the watchdog must release the worker rather than leave the site's worker paused"
  );

  // The worker already ran unpaused for part of its window; testimony arriving
  // after the terminal state must not rewrite the recorded fact.
  assert.notEqual(releaseEvaluate, null);
  releaseEvaluate!({ result: { value: true } });
  await session.settle(1_000);
  assert.equal(session.diagnostics().verifiedWorkerCount, 0);
  assert.equal(session.diagnostics().unverifiedAttachedWorkerCount, 1);
});

test("a worker still mid-handshake when the settle backstop expires is swept into the unverified accounting, terminally", async () => {
  let releaseEvaluate: ((value: Record<string, unknown>) => void) | null = null;
  let signalEvaluateRequested: (() => void) | null = null;
  const evaluateRequested = new Promise<void>((resolve) => {
    signalEvaluateRequested = resolve;
  });
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") {
      signalEvaluateRequested!();
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseEvaluate = resolve;
      });
    }
    return {};
  });
  // The watchdog is deliberately beyond this test's horizon: only the
  // post-settle sweep can conclude this worker, so the assertions pin the
  // sweep itself. No real timing race: a zero backstop returns immediately,
  // with the worker attached and no terminal record on file.
  const session = new GpcWorkerVerificationSession(scripted.channel, { handshakeTimeoutMs: 60_000 });
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-session"));
  await session.settle(0);

  assert.deepEqual(
    session.diagnostics(),
    {
      attachedDedicatedWorkerCount: 1,
      attachedSharedWorkerCount: 0,
      verifiedWorkerCount: 0,
      unverifiedAttachedWorkerCount: 1
    },
    "an attached worker the backstop cut short must be recorded as unverified, never as zero loss"
  );

  // Testimony arriving after the sweep must not flip the frozen record,
  // decrement the disclosed loss, or count the worker a second time.
  await evaluateRequested;
  assert.notEqual(releaseEvaluate, null);
  releaseEvaluate!({ result: { value: true } });
  await session.settle(1_000);
  assert.deepEqual(session.diagnostics(), {
    attachedDedicatedWorkerCount: 1,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 0,
    unverifiedAttachedWorkerCount: 1
  });
});

test("auxiliary targets are recursed into and released without entering worker accounting", async () => {
  const scripted = scriptedChannel((command) =>
    command.method === "Target.attachToTarget" ? { sessionId: "page-session" } : {}
  );
  const session = new GpcWorkerVerificationSession(scripted.channel);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("iframe-session", "iframe"));
  await session.settle(1_000);

  const iframeCommands = scripted.sent.filter((command) => command.sessionId === "iframe-session");
  assert.deepEqual(
    iframeCommands.map((command) => command.method),
    ["Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]
  );
  assert.deepEqual(session.diagnostics(), {
    attachedDedicatedWorkerCount: 0,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 0,
    unverifiedAttachedWorkerCount: 0
  });
});

test("a shared worker attach, if the browser ever delivers one, is counted in its own column", async () => {
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") return { result: { value: true } };
    return {};
  });
  const session = new GpcWorkerVerificationSession(scripted.channel);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("shared-session", "shared_worker"));
  await session.settle(1_000);

  assert.deepEqual(session.diagnostics(), {
    attachedDedicatedWorkerCount: 0,
    attachedSharedWorkerCount: 1,
    verifiedWorkerCount: 1,
    unverifiedAttachedWorkerCount: 0
  });
});

test("workers attached while an earlier handshake settles are drained by the same settle call", async () => {
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") {
      if (command.sessionId === "worker-parent") {
        // The parent's handshake surfaces a nested worker mid-flight.
        scripted.emit(workerAttachEvent("worker-child"));
      }
      return { result: { value: true } };
    }
    return {};
  });
  const session = new GpcWorkerVerificationSession(scripted.channel);
  await session.attachToPage("page-target-id");
  scripted.emit(workerAttachEvent("worker-parent"));
  await session.settle(2_000);

  assert.deepEqual(session.diagnostics(), {
    attachedDedicatedWorkerCount: 2,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 2,
    unverifiedAttachedWorkerCount: 0
  });
});

test("close closes the channel exactly once", () => {
  const scripted = scriptedChannel();
  const session = new GpcWorkerVerificationSession(scripted.channel);
  assert.equal(scripted.closed(), false);
  session.close();
  session.close();
  assert.equal(scripted.closed(), true);
});

/**
 * The mechanism against real Chromium: every dedicated worker shape the
 * characterization matrix names (classic, blob:, data:, module with a static
 * dependency, nested parent and child) is paused, attested from inside its own
 * realm, and observes the signal in its FIRST statement, while an unattached
 * page in the same browser stays untouched. The blob and data workers are the
 * pair the retired route-transform design could only block; here they must
 * run AND carry the signal.
 */
test("real Chromium: all six worker shapes attest and observe GPC while an unattached page stays untouched", { timeout: 30_000 }, async (t) => {
  const beacons: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/beacon/")) {
      beacons.push(decodeURIComponent(url.slice("/beacon/".length)));
      response.writeHead(204);
      response.end();
      return;
    }
    const scripts: Record<string, string> = {
      "/w.js": "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));",
      "/m.js":
        "import { depGpc } from './dep.js';\n" +
        "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl) + '&dep=' + String(depGpc));",
      "/dep.js": "export const depGpc = self.navigator.globalPrivacyControl;",
      "/nested.js":
        "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl)); new Worker('/nestedchild.js', { name: self.name.replace('parent', 'child') });",
      "/nestedchild.js": "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));"
    };
    const script = scripts[url.split("?")[0]];
    if (script) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    const marker = url.includes("arm=verified") ? "verified" : "untouched";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>worker matrix</title><script>
      const marker = ${JSON.stringify(marker)};
      const blobSource = "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));";
      // A data: worker runs in an opaque origin where self.location.origin is
      // "null", so its beacon target must be baked in absolutely.
      const dataSource = "fetch('" + location.origin + "/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));";
      new Worker('/w.js', { name: marker + '-classic' });
      new Worker(URL.createObjectURL(new Blob([blobSource], { type: 'text/javascript' })), { name: marker + '-blob' });
      new Worker('data:text/javascript,' + encodeURIComponent(dataSource), { name: marker + '-data' });
      new Worker('/m.js', { name: marker + '-module', type: 'module' });
      new Worker('/nested.js', { name: marker + '-nestedparent' });
    </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // closeAllConnections first: Chromium holds keep-alive sockets, and a plain
  // close() would wait on them if browser teardown ever stalls, wedging the
  // whole serial suite rather than failing one test.
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
  // Two CONTEXTS, not two pages in one: the untouched arm must share nothing
  // with the attached page beyond the browser process, exactly like the
  // scanner's two arms.
  const verifiedContext = await browser.newContext();
  t.after(() => verifiedContext.close());
  const untouchedContext = await browser.newContext();
  t.after(() => untouchedContext.close());

  const verifiedPage = await verifiedContext.newPage();
  const untouchedPage = await untouchedContext.newPage();

  const targetSession = await verifiedContext.newCDPSession(verifiedPage);
  const info = (await targetSession.send("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  await targetSession.detach();

  const wsUrl = await devtoolsBrowserWebSocketUrl(devtoolsPort);
  const channel = await openDevtoolsBrowserChannel(wsUrl);
  t.after(() => channel.close());
  const session = new GpcWorkerVerificationSession(channel);
  await session.attachToPage(info.targetInfo.targetId);

  const expectedNames = (marker: string) => [
    `${marker}-blob`,
    `${marker}-classic`,
    `${marker}-data`,
    `${marker}-module`,
    `${marker}-nestedchild`,
    `${marker}-nestedparent`
  ];
  const beaconNames = (marker: string) =>
    beacons
      .filter((beacon) => beacon.startsWith(`${marker}-`))
      .map((beacon) => beacon.split("?")[0])
      .sort();

  // Sequential and explicitly bounded: an unbounded parallel pair was the one
  // await in this test a wedged navigation could park forever.
  await verifiedPage.goto(`http://127.0.0.1:${address.port}/?arm=verified`, { timeout: 10_000 });
  await untouchedPage.goto(`http://127.0.0.1:${address.port}/?arm=untouched`, { timeout: 10_000 });
  const deadline = Date.now() + 15_000;
  while (
    (beaconNames("verified").length < 6 || beaconNames("untouched").length < 6) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await session.settle(5_000);

  assert.deepEqual(beaconNames("verified"), expectedNames("verified"));
  assert.deepEqual(beaconNames("untouched"), expectedNames("untouched"));
  for (const beacon of beacons.filter((entry) => entry.startsWith("verified-"))) {
    assert.match(beacon, /gpc=true/, `attached page worker must observe the signal: ${beacon}`);
  }
  assert.match(
    beacons.find((entry) => entry.startsWith("verified-module")) ?? "",
    /dep=true/,
    "a module worker's static dependency evaluates after the pre-start install and must see the signal"
  );
  for (const beacon of beacons.filter((entry) => entry.startsWith("untouched-"))) {
    assert.match(
      beacon,
      /gpc=undefined/,
      `an unattached page in the same browser must stay untouched: ${beacon}`
    );
  }
  const diagnostics = session.diagnostics();
  assert.equal(diagnostics.attachedDedicatedWorkerCount, 6);
  assert.equal(diagnostics.verifiedWorkerCount, 6);
  assert.equal(diagnostics.unverifiedAttachedWorkerCount, 0);
});

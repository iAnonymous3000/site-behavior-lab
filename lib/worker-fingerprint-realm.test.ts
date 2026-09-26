import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import {
  DedicatedWorkerAttachSession,
  DedicatedWorkerWitness,
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
  MAX_WORKER_SNAPSHOT_PAYLOAD_CHARS,
  fingerprintObserverWorkerInstallExpression,
  type WorkerFingerprintRealmReadout
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
  const closeHandlers: Array<() => void> = [];
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
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {}
  };
  return {
    channel,
    sent,
    emit(event: DevtoolsEvent) {
      for (const handler of handlers) handler(event);
    },
    /** The transport going away underneath the session, as a browser crash would. */
    drop() {
      for (const handler of closeHandlers) handler();
    }
  };
}

function attachEvent(
  sessionId: string,
  type: "worker" | "shared_worker" = "worker",
  options: { arrivedOn?: string; waitingForDebugger?: boolean; ownerFrame?: string } = {}
): DevtoolsEvent {
  return {
    method: "Target.attachedToTarget",
    sessionId: options.arrivedOn ?? "page-session",
    params: {
      sessionId,
      targetInfo: {
        type,
        targetId: `${sessionId}-target`,
        url: "http://fixture.test/w.js",
        parentFrameId: options.ownerFrame ?? "main-frame"
      },
      waitingForDebugger: options.waitingForDebugger ?? true
    }
  };
}

function commandsFor(sent: readonly SentCommand[], sessionId: string): string[] {
  return sent
    .filter((command) => command.sessionId === sessionId)
    .map((command) => (command.method === "Runtime.evaluate" ? `Runtime.evaluate ${String(command.params.expression)}` : command.method));
}

test("the worker install expression is the document observer's own source, called with the site key and the worker realm", () => {
  const sink = { sinkName: "__sink", capability: "cap" };
  const expression = fingerprintObserverWorkerInstallExpression("example.com", sink);
  assert.equal(
    expression,
    `(${fingerprintObserverInitScript.toString()})("example.com", {"realm":"dedicated-worker","sinkName":"__sink","capability":"cap"})`,
    "a worker must run exactly the function documents run, not a second copy of it"
  );
  assert.ok(expression.startsWith(`(${fingerprintObserverInitScript.toString()})(`));
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

/** One emission on the sink, as the browser delivers it on the worker's session. */
function emission(
  installer: FingerprintWorkerRealmInstaller,
  sessionId: string,
  sequence: number,
  state: "open" | "closed",
  snapshot?: string,
  options: { capability?: string } = {}
): DevtoolsEvent {
  const header = `${options.capability ?? installer.capability}\n${sequence}\n${state}`;
  return {
    method: "Runtime.bindingCalled",
    sessionId,
    params: {
      name: installer.sinkName,
      payload: state === "closed" ? `${header}\n${snapshot ?? EMPTY_SNAPSHOT}` : header,
      executionContextId: 1
    }
  };
}

const EMPTY_SNAPSHOT = JSON.stringify({ detections: [], events: {} });
const READ_SNAPSHOT = JSON.stringify({ detections: [], events: { "canvas.getImageData": 1 } });
const LATER_SNAPSHOT = JSON.stringify({ detections: [], events: { "canvas.getImageData": 2 } });
const LATEST_SNAPSHOT = JSON.stringify({ detections: [], events: { "canvas.getImageData": 3 } });

test("the installer reads the owner, adds the sink and evaluates the one expression before each resume, and counts only a true answer with its first snapshot", async () => {
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const expression = fingerprintObserverWorkerInstallExpression(FIXTURE_SITE_KEY, installer);
  const answers: Record<string, Record<string, unknown> | Error> = {
    "answers-true": { result: { type: "boolean", value: true } },
    "true-without-snapshot": { result: { type: "boolean", value: true } },
    "answers-false": { result: { type: "boolean", value: false } },
    throws: {
      result: { type: "object", subtype: "error" },
      exceptionDetails: { exception: { description: "ReferenceError: window is not defined" } }
    },
    "transport-fails": new Error("Session with given id not found.")
  };
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame", loaderId: "loader-1" } } };
    if (command.method === "Runtime.evaluate") {
      // The realm's first closed snapshot goes out during the evaluation, so
      // the browser delivers it before the evaluation's answer.
      if (command.sessionId === "answers-true") scripted.emit(emission(installer, command.sessionId, 1, "closed"));
      return answers[command.sessionId!];
    }
    return {};
  });
  const session = new DedicatedWorkerAttachSession(scripted.channel, [installer]);
  await session.attachToPage("page-target-id");
  for (const sessionId of Object.keys(answers)) scripted.emit(attachEvent(sessionId));
  await session.settle(1_000);

  for (const sessionId of Object.keys(answers)) {
    assert.deepEqual(commandsFor(scripted.sent, sessionId), [
      "Target.setAutoAttach",
      "Runtime.addBinding",
      `Runtime.evaluate ${expression}`,
      "Runtime.runIfWaitingForDebugger"
    ]);
    const binding = scripted.sent.find((command) => command.sessionId === sessionId && command.method === "Runtime.addBinding");
    assert.deepEqual(binding?.params, { name: installer.sinkName });
  }
  // The owner read goes to the session each attach arrived on, once per worker.
  assert.equal(
    commandsFor(scripted.sent, "page-session").filter((method) => method === "Page.getFrameTree").length,
    Object.keys(answers).length
  );
  assert.deepEqual(installer.installDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 4 });
});

test("the sink name and capability are fresh per installer and never guessable from the site", () => {
  const first = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const second = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  assert.notEqual(first.sinkName, second.sinkName);
  assert.notEqual(first.capability, second.capability);
  assert.match(first.capability, /^[0-9a-f]{48}$/);
  assert.equal(first.sinkName.includes(FIXTURE_SITE_KEY), false);
});

/**
 * An answer that comes back after the watchdog let the worker run cannot say
 * the observer preceded the worker's first statement: the worker may have run
 * uninstrumented for part of the window.
 */
test("an install answer arriving after the watchdog released the worker leaves it counted as failed", async () => {
  let answerEvaluate: (() => void) | null = null;
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Runtime.evaluate") {
      return new Promise((resolve) => {
        answerEvaluate = () => {
          scripted.emit(emission(installer, "slow-worker", 1, "closed"));
          resolve({ result: { type: "boolean", value: true } });
        };
      });
    }
    return {};
  });
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
  const readout = await installer.readout({ session, witness: { count: () => 0 }, settleMs: 0 });
  assert.deepEqual([readout.readableSnapshots, readout.unreadRealms], [[], 0]);
});

/**
 * A scripted page with the production installer: each worker attaches on the
 * page session, its install answers true after its first closed snapshot, and
 * the page's frame tree is whatever the test says it is now.
 */
async function scriptedWorkerRealms(
  options: {
    handshake?: (sessionId: string) => boolean;
    frameTree?: () => Record<string, unknown> | Error;
    /** The readout barrier's answer on a worker's session; by default at once. */
    barrier?: (sessionId: string) => Record<string, unknown> | Promise<Record<string, unknown>> | Error;
  } = {}
) {
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  let frameTree = options.frameTree ?? (() => ({ frame: { id: "main-frame", loaderId: "loader-1" } }));
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (command.method === "Page.getFrameTree") {
      const tree = frameTree();
      return tree instanceof Error ? tree : { frameTree: tree };
    }
    if (command.method === "Runtime.getIsolateId") {
      return options.barrier ? options.barrier(command.sessionId!) : { id: `isolate-${command.sessionId}` };
    }
    if (command.method === "Runtime.evaluate") {
      if (options.handshake?.(command.sessionId!) !== false) {
        scripted.emit(emission(installer, command.sessionId!, 1, "closed"));
      }
      return { result: { type: "boolean", value: true } };
    }
    return {};
  });
  const session = new DedicatedWorkerAttachSession(scripted.channel, [installer]);
  await session.attachToPage("page-target-id");
  return {
    installer,
    session,
    scripted,
    async attach(...sessionIds: string[]) {
      for (const sessionId of sessionIds) scripted.emit(attachEvent(sessionId));
      await session.settle(1_000);
    },
    emit(sessionId: string, sequence: number, state: "open" | "closed", snapshot?: string) {
      scripted.emit(emission(installer, sessionId, sequence, state, snapshot));
    },
    detach(sessionId: string) {
      scripted.emit({ method: "Target.detachedFromTarget", sessionId: "page-session", params: { sessionId } });
    },
    setFrameTree(next: () => Record<string, unknown> | Error) {
      frameTree = next;
    },
    readout(observedDedicated: number, settleMs = 200): Promise<WorkerFingerprintRealmReadout> {
      return installer.readout({ session, witness: { count: () => observedDedicated }, settleMs });
    }
  };
}

function readoutTerms(readout: WorkerFingerprintRealmReadout) {
  const nonZero = Object.fromEntries(
    Object.entries(readout.diagnostics).filter(
      ([key, value]) => value !== 0 && key !== "observedDedicated" && key !== "attachedDedicated" && key !== "attachedNested"
    )
  );
  return { snapshots: readout.readableSnapshots, unread: readout.unreadRealms, terms: nonZero };
}

/** A barrier each test answers by hand, per worker session. */
function heldBarriers() {
  const answers = new Map<string, () => void>();
  return {
    barrier: (sessionId: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        answers.set(sessionId, () => resolve({ id: `isolate-${sessionId}` }));
      }),
    answer(sessionId: string) {
      const answer = answers.get(sessionId);
      assert.ok(answer, `no barrier was sent to ${sessionId}`);
      answer();
    }
  };
}

/**
 * A running worker's freeze point is its answer to the barrier: what it
 * emitted before answering belongs to the freeze even when it reaches the
 * host after the readout began, and what it emits after answering does not,
 * even while the readout still waits on another worker.
 */
test("readout: a running worker is read at its last word when its barrier answer arrives, and what follows the answer does not move that freeze", async () => {
  const held = heldBarriers();
  const realms = await scriptedWorkerRealms({ barrier: held.barrier });
  await realms.attach("w1", "w2");
  for (const sessionId of ["w1", "w2"]) {
    realms.emit(sessionId, 2, "open");
    realms.emit(sessionId, 3, "closed", READ_SNAPSHOT);
  }
  const pending = realms.readout(2, 2_000);
  assert.deepEqual(
    realms.scripted.sent.filter((command) => command.method === "Runtime.getIsolateId").map((command) => command.sessionId),
    ["w1", "w2"],
    "each running worker gets one barrier on its own session"
  );
  // Emitted before w1 answered, though it reaches the host after the call.
  realms.emit("w1", 4, "open");
  realms.emit("w1", 5, "closed", LATER_SNAPSHOT);
  held.answer("w1");
  await new Promise((resolve) => setImmediate(resolve));
  // A later task, after w1's answer, while the readout still waits on w2.
  realms.emit("w1", 6, "open");
  realms.emit("w1", 7, "closed", LATEST_SNAPSHOT);
  held.answer("w2");
  assert.deepEqual(readoutTerms(await pending), {
    snapshots: [LATER_SNAPSHOT, READ_SNAPSHOT],
    unread: 0,
    terms: { readable: 2 }
  });
});

/**
 * Delivery lags the realm. The host holds a closed snapshot at the call, but
 * before answering the worker began a task that is still open: the older
 * snapshot is not its state at the freeze, so it waits for the task and, with
 * no closed snapshot by the bound, is cut off, never read at the older state.
 */
test("readout: a closed snapshot the host holds at the call is not read when the worker's answer shows a task begun before it", async () => {
  const held = heldBarriers();
  const realms = await scriptedWorkerRealms({ barrier: held.barrier });
  await realms.attach("w1");
  realms.emit("w1", 2, "open");
  realms.emit("w1", 3, "closed", EMPTY_SNAPSHOT);
  const pending = realms.readout(1, 50);
  realms.emit("w1", 4, "open");
  held.answer("w1");
  assert.deepEqual(readoutTerms(await pending), { snapshots: [], unread: 1, terms: { cutOff: 1 } });
});

test("readout: a running worker whose barrier answer does not come within the bound is cut off, never read at the host's older state", async () => {
  const realms = await scriptedWorkerRealms({ barrier: () => new Promise(() => undefined) });
  await realms.attach("w1");
  realms.emit("w1", 2, "open");
  realms.emit("w1", 3, "closed", READ_SNAPSHOT);
  assert.deepEqual(readoutTerms(await realms.readout(1, 50)), { snapshots: [], unread: 1, terms: { cutOff: 1 } });
});

/**
 * A worker that goes away can emit nothing more, so its detach answers its
 * barrier with the stream as received. A barrier that errors while the worker
 * is still attached answers nothing, and the worker waits out the bound.
 */
test("readout: a worker that goes away before answering is read as received, and a barrier error while attached is no answer", async () => {
  const realms = await scriptedWorkerRealms({
    barrier: (sessionId) => (sessionId === "errors" ? new Error("Internal error") : new Promise(() => undefined))
  });
  await realms.attach("leaves", "errors");
  for (const sessionId of ["leaves", "errors"]) {
    realms.emit(sessionId, 2, "open");
    realms.emit(sessionId, 3, "closed", READ_SNAPSHOT);
  }
  const pending = realms.readout(2, 100);
  realms.detach("leaves");
  assert.deepEqual(readoutTerms(await pending), {
    snapshots: [READ_SNAPSHOT],
    unread: 1,
    terms: { readable: 1, cutOff: 1 }
  });
});

test("readout: a worker open at the freeze is read at the first closed snapshot after it, which the drain waits for", async () => {
  const realms = await scriptedWorkerRealms();
  await realms.attach("w1");
  realms.emit("w1", 2, "open");
  const pending = realms.readout(1, 2_000);
  setTimeout(() => {
    realms.emit("w1", 3, "closed", READ_SNAPSHOT);
    realms.emit("w1", 4, "open");
    realms.emit("w1", 5, "closed", LATER_SNAPSHOT);
  }, 30);
  assert.deepEqual(readoutTerms(await pending), { snapshots: [READ_SNAPSHOT], unread: 0, terms: { readable: 1 } });
});

test("readout: a worker whose last word stays open is cut off and unread, never clean", async () => {
  const realms = await scriptedWorkerRealms();
  await realms.attach("w1");
  realms.emit("w1", 2, "open");
  assert.deepEqual(readoutTerms(await realms.readout(1, 50)), { snapshots: [], unread: 1, terms: { cutOff: 1 } });
});

test("readout: a gap, an oversized payload, a malformed payload or the realm's own null leaves the worker unread", async () => {
  const realms = await scriptedWorkerRealms();
  await realms.attach("gap", "oversize", "malformed", "null");
  realms.emit("gap", 3, "closed", READ_SNAPSHOT);
  realms.emit("oversize", 2, "closed", " ".repeat(MAX_WORKER_SNAPSHOT_PAYLOAD_CHARS));
  realms.scripted.emit({
    method: "Runtime.bindingCalled",
    sessionId: "malformed",
    params: { name: realms.installer.sinkName, payload: `${realms.installer.capability}\n2\nclosing` }
  });
  realms.emit("null", 2, "closed", "null");
  assert.deepEqual(readoutTerms(await realms.readout(4, 50)), { snapshots: [], unread: 4, terms: { streamBroken: 4 } });
});

test("readout: an emission without this scan's capability is ignored and breaks nothing", async () => {
  const realms = await scriptedWorkerRealms();
  await realms.attach("w1");
  realms.scripted.emit(emission(realms.installer, "w1", 2, "closed", LATER_SNAPSHOT, { capability: "forged" }));
  realms.emit("w1", 2, "open");
  realms.emit("w1", 3, "closed", READ_SNAPSHOT);
  assert.deepEqual(readoutTerms(await realms.readout(1)), { snapshots: [READ_SNAPSHOT], unread: 0, terms: { readable: 1 } });
});

test("readout: an install that answered true without its first snapshot leaves the worker unread", async () => {
  const realms = await scriptedWorkerRealms({ handshake: (sessionId) => sessionId !== "silent" });
  await realms.attach("silent");
  // The same snapshot arriving after the answer cannot rescue it.
  realms.emit("silent", 1, "closed", READ_SNAPSHOT);
  assert.deepEqual(readoutTerms(await realms.readout(1)), { snapshots: [], unread: 1, terms: { installFailed: 1 } });
});

test("readout: a closed channel leaves every worker still attached unread, and every witnessed worker it never attached", async () => {
  const realms = await scriptedWorkerRealms();
  await realms.attach("alive", "gone");
  realms.emit("alive", 2, "open");
  realms.emit("alive", 3, "closed", READ_SNAPSHOT);
  realms.emit("gone", 2, "open");
  realms.emit("gone", 3, "closed", READ_SNAPSHOT);
  realms.detach("gone");
  realms.scripted.drop();
  // Three witnessed: the two attached, and one that started after the drop.
  // The gone worker's stream is whole, but with no channel its owner cannot
  // be checked against the current frames.
  assert.deepEqual(readoutTerms(await realms.readout(3)), {
    snapshots: [],
    unread: 3,
    terms: { channelLostAlive: 1, ownerUnknown: 1, unattachedDedicated: 1 }
  });
});

test("readout: with no channel at all, every witnessed worker is unread", async () => {
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const readout = await installer.readout({ session: null, witness: { count: () => 2 }, settleMs: 0 });
  assert.deepEqual(readoutTerms(readout), { snapshots: [], unread: 2, terms: { unattachedDedicated: 2 } });
});

test("readout: the drain waits for the channel's attaches to reach the witness, and what attaches in it was paused at the freeze", async () => {
  const realms = await scriptedWorkerRealms();
  const pending = realms.readout(1, 2_000);
  setTimeout(() => realms.scripted.emit(attachEvent("late-attach")), 30);
  assert.deepEqual(readoutTerms(await pending), { snapshots: [], unread: 0, terms: {} });
  // Without the wait, the witnessed worker would have read as never attached.
  const unattached = await (await scriptedWorkerRealms()).readout(1, 20);
  assert.deepEqual(readoutTerms(unattached), { snapshots: [], unread: 1, terms: { unattachedDedicated: 1 } });
});

test("readout: a worker still held for its installers at the freeze ran nothing and is excluded", async () => {
  let releaseInstall: (() => void) | null = null;
  const holding: WorkerRealmInstaller = {
    install: () =>
      new Promise<void>((resolve) => {
        releaseInstall = resolve;
      }),
    concluded() {}
  };
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const scripted = scriptedChannel((command) => (command.method === "Target.attachToTarget" ? { sessionId: "page-session" } : {}));
  const session = new DedicatedWorkerAttachSession(scripted.channel, [holding, installer]);
  await session.attachToPage("page-target-id");
  scripted.emit(attachEvent("held"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const readout = await installer.readout({ session, witness: { count: () => 1 }, settleMs: 0 });
  assert.deepEqual(readoutTerms(readout), { snapshots: [], unread: 0, terms: { pausedAtReadout: 1 } });
  releaseInstall!();
  await session.settle(1_000);
});

test("readout: a worker already running when it attached gets nothing installed and is unread", async () => {
  const realms = await scriptedWorkerRealms();
  realms.scripted.emit(attachEvent("running", "worker", { waitingForDebugger: false }));
  await realms.session.settle(1_000);
  assert.deepEqual(
    commandsFor(realms.scripted.sent, "running").filter((method) => method !== "Target.setAutoAttach"),
    ["Runtime.runIfWaitingForDebugger"]
  );
  assert.deepEqual(readoutTerms(await realms.readout(1)), { snapshots: [], unread: 1, terms: { attachedLate: 1 } });
});

test("readout: a worker that has gone is read only while its owner document is current", async () => {
  const realms = await scriptedWorkerRealms();
  await realms.attach("current", "replaced");
  for (const sessionId of ["current", "replaced"]) {
    realms.emit(sessionId, 2, "open");
    realms.emit(sessionId, 3, "closed", READ_SNAPSHOT);
    realms.detach(sessionId);
  }
  // The same frame, a new document: every worker recorded on loader-1 is gone
  // with its document.
  realms.setFrameTree(() => ({ frame: { id: "main-frame", loaderId: "loader-2" } }));
  assert.deepEqual(readoutTerms(await realms.readout(2)), { snapshots: [], unread: 0, terms: { ownerReplaced: 2 } });
  // A worker gone at the call can emit nothing more: it gets no barrier.
  assert.equal(realms.scripted.sent.some((command) => command.method === "Runtime.getIsolateId"), false);
  realms.setFrameTree(() => ({ frame: { id: "main-frame", loaderId: "loader-1" } }));
  assert.deepEqual(readoutTerms(await realms.readout(2)), {
    snapshots: [READ_SNAPSHOT, READ_SNAPSHOT],
    unread: 0,
    terms: { readable: 2 }
  });
  // Current frames that cannot be read never exclude a worker silently.
  realms.setFrameTree(() => new Error("Page.getFrameTree failed"));
  assert.deepEqual(readoutTerms(await realms.readout(2)), { snapshots: [], unread: 2, terms: { ownerUnknown: 2 } });
});

/**
 * A document's workers end with it, and a navigation can end one mid-task,
 * before its stream is whole. Such a worker ran no code of a current
 * document, so it is excluded like a replaced frame, never counted as a loss;
 * a gone worker whose document is still current keeps the term its stream
 * gives it.
 */
test("readout: a gone worker of a replaced document is excluded whatever state its stream was left in", async () => {
  let childLoader = "child-loader-1";
  let treesReadable = true;
  const realms = await scriptedWorkerRealms({
    handshake: (sessionId) => sessionId !== "failed-replaced",
    frameTree: () =>
      treesReadable
        ? {
            frame: { id: "main-frame", loaderId: "loader-1" },
            childFrames: [{ frame: { id: "child-frame", loaderId: childLoader } }]
          }
        : new Error("Page.getFrameTree failed")
  });
  for (const sessionId of ["open-replaced", "broken-replaced", "failed-replaced"]) {
    realms.scripted.emit(attachEvent(sessionId, "worker", { ownerFrame: "child-frame" }));
  }
  realms.scripted.emit(attachEvent("open-current"));
  await realms.session.settle(1_000);
  realms.emit("open-replaced", 2, "open");
  realms.emit("broken-replaced", 3, "closed", READ_SNAPSHOT);
  realms.emit("open-current", 2, "open");
  for (const sessionId of ["open-replaced", "broken-replaced", "failed-replaced", "open-current"]) realms.detach(sessionId);

  // The child frame now shows another document.
  childLoader = "child-loader-2";
  assert.deepEqual(readoutTerms(await realms.readout(4, 50)), {
    snapshots: [],
    unread: 1,
    terms: { ownerReplaced: 3, cutOff: 1 }
  });
  // Frames that cannot be read show nothing replaced: each worker keeps the
  // term its state gives it.
  treesReadable = false;
  assert.deepEqual(readoutTerms(await realms.readout(4, 50)), {
    snapshots: [],
    unread: 4,
    terms: { cutOff: 2, streamBroken: 1, installFailed: 1 }
  });
});

test("readout: a worker whose owner could not be recorded during its pause is unread, and its nested child inherits that", async () => {
  const realms = await scriptedWorkerRealms({ frameTree: () => new Error("Page.getFrameTree failed") });
  await realms.attach("orphan");
  realms.scripted.emit(attachEvent("child", "worker", { arrivedOn: "orphan" }));
  await realms.session.settle(1_000);
  // A nested worker's owner is its parent's: no frame tree is read for it.
  assert.equal(commandsFor(realms.scripted.sent, "orphan").includes("Page.getFrameTree"), false);
  assert.deepEqual(readoutTerms(await realms.readout(2)), { snapshots: [], unread: 2, terms: { ownerUnknown: 2 } });
});

test("readout: a worker that died while held ran nothing and is excluded, although its install failed", async () => {
  let releaseHold: (() => void) | null = null;
  const holding: WorkerRealmInstaller = {
    install: () =>
      new Promise<void>((resolve) => {
        releaseHold = resolve;
      }),
    concluded() {}
  };
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  let died = false;
  const scripted = scriptedChannel((command) => {
    if (command.method === "Target.attachToTarget") return { sessionId: "page-session" };
    if (died && command.sessionId === "dies") return new Error("Session with given id not found.");
    return {};
  });
  const session = new DedicatedWorkerAttachSession(scripted.channel, [holding, installer]);
  await session.attachToPage("page-target-id");
  scripted.emit(attachEvent("dies"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  died = true;
  scripted.emit({ method: "Target.detachedFromTarget", sessionId: "page-session", params: { sessionId: "dies" } });
  releaseHold!();
  await session.settle(1_000);
  assert.deepEqual(installer.installDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1 });
  const readout = await installer.readout({ session, witness: { count: () => 1 }, settleMs: 0 });
  assert.deepEqual(readoutTerms(readout), { snapshots: [], unread: 0, terms: { diedPaused: 1 } });
});

/**
 * The worker realm path adds no merge of its own: a snapshot delivered as a
 * worker realm is normalized and merged exactly as the same text delivered as
 * a frame, and what the collection rejects for a frame it rejects for a
 * worker, counted as an unread realm.
 */
test("the same snapshot text merges identically as a frame and as a worker realm", async () => {
  const canvas = {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: { readApis: ["canvas.getImageData"], maxCanvasWidth: 200, maxCanvasHeight: 60, maxDistinctTextCharacters: 30, maxTextWriteCalls: 1 }
  };
  const first = JSON.stringify({ detections: [canvas], events: { "canvas.getImageData": 1 } });
  const second = JSON.stringify({
    detections: [{ ...canvas, evidence: { ...canvas.evidence, readApis: ["canvas.convertToBlob"], maxCanvasWidth: 300 } }],
    events: { "canvas.convertToBlob": 1, "canvas.getImageData": 2 }
  });
  const asFrames = await collectFingerprintObservationsWithCoverage([
    { evaluate: async () => first },
    { evaluate: async () => second }
  ]);
  const asFrameAndWorker = await collectFingerprintObservationsWithCoverage([{ evaluate: async () => first }], {
    readableSnapshots: [second],
    unreadRealms: 0
  });
  const asWorkers = await collectFingerprintObservationsWithCoverage([], {
    readableSnapshots: [first, second],
    unreadRealms: 0
  });
  assert.deepEqual(asFrameAndWorker.observations, asFrames.observations);
  assert.deepEqual(asWorkers.observations, asFrames.observations);
  assert.equal(asFrames.observations.detections[0].count, 2);
  assert.deepEqual(
    { ...asFrameAndWorker, observations: undefined },
    {
      observations: undefined,
      attemptedFrames: 1,
      readableFrames: 1,
      listenerAttributionLostFrames: 0,
      attemptedWorkerRealms: 1,
      readableWorkerRealms: 1
    }
  );

  const rejected = await collectFingerprintObservationsWithCoverage([], {
    readableSnapshots: [
      "not json",
      JSON.stringify({ detections: [], events: { "canvas.toDataURL": 1 }, listenerAttributionLost: true }),
      first
    ],
    unreadRealms: 2
  });
  assert.deepEqual(
    { ...rejected, observations: undefined },
    {
      observations: undefined,
      attemptedFrames: 0,
      readableFrames: 0,
      listenerAttributionLostFrames: 0,
      attemptedWorkerRealms: 5,
      readableWorkerRealms: 1
    }
  );
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
  /** Playwright's own record of the page's dedicated workers, as the scanner keeps it. */
  witness: DedicatedWorkerWitness;
  /** Every worker the channel attached, in attach order. */
  workers: AttachedWorker[];
  crashed: () => boolean;
};

/**
 * A browser with a loopback DevTools port, one page, and the scanner's worker
 * realm channel attached to that page with the production fingerprint
 * installer, exactly as the scanner opens it in an arm without GPC. A test may
 * put one installer ahead of it, as the GPC arm does.
 */
async function openPausedWorkerHarness(
  t: TestContext,
  options: { before?: WorkerRealmInstaller; launchArgs?: string[] } = {}
): Promise<PausedWorkerHarness> {
  const devtoolsPort = await reserveLoopbackPort();
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${devtoolsPort}`, ...(options.launchArgs ?? [])]
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  let crashed = false;
  page.on("crash", () => {
    crashed = true;
  });
  const witness = new DedicatedWorkerWitness();
  page.on("worker", () => witness.observe());
  const targetSession = await context.newCDPSession(page);
  const info = (await targetSession.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
  await targetSession.detach();
  const channel = await openDevtoolsBrowserChannel(await devtoolsBrowserWebSocketUrl(devtoolsPort));
  const installer = new FingerprintWorkerRealmInstaller(FIXTURE_SITE_KEY);
  const workers: AttachedWorker[] = [];
  // Records which workers were attached; the production installer runs after
  // it, unwrapped, so it hears every channel event and the channel's close.
  const attachRecorder: WorkerRealmInstaller = {
    async install(worker: AttachedWorker) {
      workers.push(worker);
    },
    concluded() {}
  };
  const installers = [attachRecorder, ...(options.before ? [options.before] : []), installer];
  const session = new DedicatedWorkerAttachSession(channel, installers);
  t.after(() => session.close());
  await session.attachToPage(info.targetInfo.targetId);
  return { page, channel, session, installer, witness, workers, crashed: () => crashed };
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

/** The production readout at one freeze, with the scanner's witness and channel. */
function readWorkerRealms(harness: PausedWorkerHarness, settleMs = 2_000): Promise<WorkerFingerprintRealmReadout> {
  return harness.installer.readout({ session: harness.session, witness: harness.witness, settleMs });
}

/** One worker realm's snapshot through the collection every frame goes through. */
function collectWorkerSnapshot(snapshot: string) {
  return collectFingerprintObservationsWithCoverage([], { readableSnapshots: [snapshot], unreadRealms: 0 });
}

type WorkerFixtureRoutes = {
  page: string;
  scripts?: Record<string, string>;
  /** Serve the page and its scripts cross-origin isolated, so SharedArrayBuffer exists. */
  crossOriginIsolated?: boolean;
};

/** A local page and its worker scripts, with a `/done/<name>` beacon the scripts can call. */
async function startWorkerFixture(
  t: TestContext,
  routes: WorkerFixtureRoutes | (() => WorkerFixtureRoutes)
): Promise<{ origin: string; done: string[] }> {
  const done: string[] = [];
  const port = await startFixtureServer(t, (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/done/")) {
      done.push(url.pathname.slice("/done/".length));
      response.writeHead(204);
      response.end();
      return;
    }
    const current = typeof routes === "function" ? routes() : routes;
    const isolation: Record<string, string> = current.crossOriginIsolated
      ? { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" }
      : {};
    const script = current.scripts?.[url.pathname];
    if (script !== undefined) {
      response.writeHead(200, { "content-type": "text/javascript", ...isolation });
      response.end(script);
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...isolation });
    response.end(current.page);
  });
  return { origin: `http://127.0.0.1:${port}`, done };
}

/** 2D text on an OffscreenCanvas read back whole: the openwpm-canvas-v1 shape. */
const CANVAS_READ_SOURCE =
  "const canvas = new OffscreenCanvas(200, 60); const context = canvas.getContext('2d'); " +
  "context.fillText('abcdefghijklmnopqrstuvwxyz0123', 2, 20); context.getImageData(0, 0, 200, 60);";

/**
 * Design test 9, the paused-install crash guard. A worker paused before its
 * first statement has a partly initialized global, and reading a lazily
 * initialized worker global there (self.location) or creating a WebGL context
 * crashes the renderer, taking the measured page and all its workers with it,
 * in every arm. This installs the compiled observer through the production
 * installer into every dedicated worker shape the scanner can meet, including
 * the ones whose script fails to load or parse, and requires the page to
 * survive, every attached worker to be installed (its install answering true
 * after its first closed snapshot reached the sink), and every runnable
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
    "every attached worker's install must run to its end inside the realm, reach the sink, and answer true"
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
 * heuristics, and read back through the production readout: the same routine
 * yields the same events and the same detections in a worker as in the page,
 * through the same collection.
 */
test("real Chromium: a dedicated worker records the same events and detections as the page for the same routine", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>realm parity</title><script>${PROBE_SOURCE}
      probe("page", location.origin).then(() => new Worker("/probe.js", { name: "worker" }));
    </script>`,
    scripts: { "/probe.js": `${PROBE_SOURCE}\nprobe(self.name, self.location.origin);` }
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.addInitScript(fingerprintObserverInitScript, FIXTURE_SITE_KEY);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 2, 15_000);
  assert.deepEqual(done.sort(), ["page", "worker"]);

  const pageCollection = await collectFingerprintObservationsWithCoverage([harness.page.mainFrame()]);
  const readout = await readWorkerRealms(harness);
  assert.equal(readout.unreadRealms, 0);
  assert.equal(readout.readableSnapshots.length, 1);
  const workerCollection = await collectFingerprintObservationsWithCoverage([], readout);

  assert.equal(pageCollection.readableFrames, 1);
  assert.equal(workerCollection.readableWorkerRealms, 1, "the worker realm's snapshot must be one the collection accepts");
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

  // One collection over the page and the worker counts the routine twice,
  // once per realm, and nothing more.
  const both = await collectFingerprintObservationsWithCoverage([harness.page.mainFrame()], await readWorkerRealms(harness));
  const canvasReads = both.observations.events.find((event) => event.api === "canvas.getImageData");
  assert.equal(canvasReads?.count, 2);
  assert.equal(both.observations.detections.find((detection) => detection.kind === "canvas-fingerprinting")?.count, 2);
});

/** Design test 1: a blob: worker's text, readback and export, read back as one canvas detection. */
test("real Chromium: a blob worker's OffscreenCanvas text, readback and export reach the canvas heuristic", { timeout: 60_000 }, async (t) => {
  const workerSource = `(async () => { ${CANVAS_READ_SOURCE} await canvas.convertToBlob(); await fetch(ORIGIN + '/done/blob'); })();`;
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>blob worker</title><script>
      new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}.replace("ORIGIN", JSON.stringify(location.origin))], { type: "text/javascript" })));
    </script>`
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);

  const collection = await collectFingerprintObservationsWithCoverage([], await readWorkerRealms(harness));
  assert.deepEqual([collection.attemptedWorkerRealms, collection.readableWorkerRealms], [1, 1]);
  assert.deepEqual(collection.observations.detections, [
    {
      kind: "canvas-fingerprinting",
      heuristic: "openwpm-canvas-v1",
      count: 1,
      evidence: {
        readApis: ["canvas.convertToBlob", "canvas.getImageData"],
        maxCanvasWidth: 200,
        maxCanvasHeight: 60,
        maxDistinctTextCharacters: 30,
        maxTextWriteCalls: 1
      }
    }
  ]);
  assert.deepEqual(
    collection.observations.events.map((event) => event.api).sort(),
    ["canvas.convertToBlob", "canvas.getImageData"]
  );
});

test("real Chromium: a worker started by another worker is observed in its own realm", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>nested worker</title><script>new Worker("/parent.js", { name: "parent" });</script>`,
    scripts: {
      "/parent.js":
        `const childSource = ${JSON.stringify(`${PROBE_SOURCE}\nprobe(self.name, ORIGIN);`)}.replace("ORIGIN", JSON.stringify(self.location.origin));\n` +
        "new Worker(URL.createObjectURL(new Blob([childSource], { type: 'text/javascript' })), { name: 'child' });\n" +
        "fetch(self.location.origin + '/done/parent');"
    }
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 2, 15_000);
  assert.deepEqual(done.sort(), ["child", "parent"]);

  assert.deepEqual(
    harness.workers.map((worker) => worker.nested),
    [false, true]
  );
  const readout = await readWorkerRealms(harness);
  assert.equal(readout.unreadRealms, 0);
  assert.equal(readout.diagnostics.attachedNested, 1);
  const collections = await Promise.all(readout.readableSnapshots.map((snapshot) => collectWorkerSnapshot(snapshot)));
  assert.deepEqual(
    collections.map((collection) => collection.observations.detections.map((detection) => detection.heuristic).sort()),
    [[], ["canvas-font-probing-v1", "openwpm-canvas-v1", "webgl-entropy-read-v1"]],
    "the parent only starts the child, and the child's own calls are recorded in its own realm"
  );
  assert.deepEqual(collections[0].observations, { events: [], detections: [] });
  assert.deepEqual(harness.installer.installDiagnostics(), { installedWorkerCount: 2, installFailedWorkerCount: 0 });
});

/**
 * Design tests 5 and 7: a worker that fingerprints and then closes itself or
 * throws still delivers its task's closed snapshot, and a worker that throws
 * before any call is installed, read and clean.
 */
test("real Chromium: a worker that closes itself or throws right after fingerprinting is read, and one that throws first reads clean", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>worker exits</title><script>
      const closes = new Worker("/closes.js");
      const throwsAfter = new Worker("/throws-after.js");
      const throwsFirst = new Worker("/throws-first.js");
      for (const [name, worker] of [["closes", closes], ["throwsafter", throwsAfter], ["throwsfirst", throwsFirst]]) {
        worker.onerror = (event) => { event.preventDefault(); fetch("/done/" + name); };
      }
      setTimeout(() => fetch("/done/closes"), 500);
    </script>`,
    scripts: {
      "/closes.js": `${CANVAS_READ_SOURCE} self.close();`,
      "/throws-after.js": `${CANVAS_READ_SOURCE} throw new Error("after");`,
      "/throws-first.js": `throw new Error("first");`
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 3, 15_000);
  assert.deepEqual(done.sort(), ["closes", "throwsafter", "throwsfirst"]);

  const readout = await readWorkerRealms(harness);
  assert.equal(readout.unreadRealms, 0, JSON.stringify(readout.diagnostics));
  assert.equal(readout.diagnostics.readable, 3);
  const heuristics = (
    await Promise.all(readout.readableSnapshots.map((snapshot) => collectWorkerSnapshot(snapshot)))
  ).map((collection) => collection.observations.detections.map((detection) => detection.heuristic).join(","));
  assert.deepEqual(heuristics.sort(), ["", "openwpm-canvas-v1", "openwpm-canvas-v1"]);
});

/**
 * Design test 6, as this Chromium behaves. A worker whose task is still
 * running at the freeze has said "open" and nothing since, so it reads as
 * unread, never as the clean state before its task began. The drain waits for
 * the task's closed snapshot, so a task that ends within the bound is read,
 * and a task that outlasts it is read at the next freeze once it has ended.
 *
 * The design measured a page's worker.terminate() mid-task as a realm that
 * never delivers its closed snapshot. Chromium 153 lets the terminated task
 * run to its end, or forcibly ends it after about two seconds, and in both
 * cases runs the task's microtask checkpoint, so the closed snapshot arrives
 * just before the target detaches. What a freeze can cut off is a task still
 * running when the drain ends, which this test pins.
 */
test("real Chromium: a worker mid-task at the freeze is unread until its task's closed snapshot arrives", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>workers mid-task</title><script>
      for (const name of ["long", "short"]) {
        const worker = new Worker("/" + name + ".js");
        worker.onmessage = () => fetch("/done/" + name);
      }
    </script>`,
    scripts: {
      "/long.js": `${CANVAS_READ_SOURCE} postMessage("read"); const until = Date.now() + 3000; while (Date.now() < until) {}`,
      "/short.js": `${CANVAS_READ_SOURCE} postMessage("read"); const until = Date.now() + 300; while (Date.now() < until) {}`
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 2, 15_000);

  // Both tasks are running at the freeze. The short one ends inside the
  // drain; the long one does not.
  const midTask = await readWorkerRealms(harness, 1_000);
  assert.equal(midTask.unreadRealms, 1, `the worker still mid-task must be unread: ${JSON.stringify(midTask.diagnostics)}`);
  assert.equal(midTask.diagnostics.cutOff, 1);
  assert.equal(midTask.diagnostics.readable, 1);
  const [short] = await Promise.all(midTask.readableSnapshots.map((snapshot) => collectWorkerSnapshot(snapshot)));
  assert.deepEqual(
    short.observations.detections.map((detection) => detection.heuristic),
    ["openwpm-canvas-v1"],
    "the drain must wait for the task that ends inside it"
  );

  // Once the long task has ended, its closed snapshot is its last word.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const afterTask = await readWorkerRealms(harness, 1_000);
  assert.deepEqual([afterTask.readableSnapshots.length, afterTask.unreadRealms], [2, 0]);
  const collection = await collectFingerprintObservationsWithCoverage([], afterTask);
  assert.deepEqual([collection.attemptedWorkerRealms, collection.readableWorkerRealms], [2, 2]);
  assert.equal(collection.observations.detections[0]?.count, 2);
});

/**
 * Delivery lags the realm. Two workers flood the channel with emissions, and a
 * third fingerprints once while its emissions queue behind theirs, so at the
 * freeze the host may still hold that worker's state from before it
 * fingerprinted. Its barrier's answer queues behind the same backlog, so it is
 * read with its fingerprinting or, when the backlog outlasts the bound, cut
 * off; never read at the older, clean state. Every realm read here must show
 * its own worker's work.
 *
 * This also pins the platform assumption the barrier rests on: a worker's
 * answer reaches the host behind every emission the worker made before it.
 */
test("real Chromium: a worker whose emissions queue behind a backlog at the freeze is never read at an older state", { timeout: 60_000 }, async (t) => {
  // 45,000 measureText calls, each followed by a microtask turn: 90,000
  // emissions, below the realm's emission cap.
  const floodSource =
    "(async () => { const context = new OffscreenCanvas(1, 1).getContext('2d'); " +
    "for (let index = 0; index < 45000; index += 1) { context.measureText('flood'); await null; } })();";
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>emission backlog</title><script>
      new Worker("/flood.js");
      new Worker("/fingerprint.js");
      new Worker("/flood.js");
    </script>`,
    scripts: {
      "/flood.js": floodSource,
      "/fingerprint.js": `setTimeout(() => { ${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/fingerprint"); }, 300);`
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const readout = await readWorkerRealms(harness, 500);
  assert.equal(readout.diagnostics.readable + readout.unreadRealms, 3, JSON.stringify(readout.diagnostics));
  const collections = await Promise.all(readout.readableSnapshots.map((snapshot) => collectWorkerSnapshot(snapshot)));
  let fingerprintingRead = 0;
  for (const collection of collections) {
    const flooded = collection.observations.events.some((event) => event.api === "canvas.measureText");
    const fingerprinted = collection.observations.detections.some((detection) => detection.heuristic === "openwpm-canvas-v1");
    assert.ok(
      flooded || fingerprinted,
      `a worker was read at a state from before its own work: ${JSON.stringify(collection.observations)}`
    );
    if (fingerprinted) fingerprintingRead += 1;
  }
  assert.ok(
    fingerprintingRead === 1 || readout.unreadRealms >= 1,
    `the fingerprinting worker must be read with its fingerprinting or counted unread: ${JSON.stringify(readout.diagnostics)}`
  );
});

/**
 * The realm's own bound on its stream. A worker that records in a microtask
 * loop emits twice per turn; at the 100,000th emission the realm marks its
 * coverage lost, sends one final closed `null`, and falls silent, so an
 * emission flood ends as an unread realm rather than unbounded host work.
 */
test("real Chromium: a worker past the emission cap ends its stream with its own null and is unread", { timeout: 60_000 }, async (t) => {
  // 50,100 turns, each one open and one closed: past 100,000 emissions.
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>emission cap</title><script>
      const worker = new Worker("/flood.js");
      worker.onmessage = () => fetch("/done/flooded");
    </script>`,
    scripts: {
      "/flood.js":
        "(async () => { const context = new OffscreenCanvas(1, 1).getContext('2d'); " +
        "for (let index = 0; index < 50100; index += 1) { context.measureText('flood'); await null; } postMessage('flooded'); })();"
    }
  });
  const harness = await openPausedWorkerHarness(t);
  let highestSequence = 0;
  let finalPayload = "";
  harness.channel.onEvent((event) => {
    if (event.method !== "Runtime.bindingCalled" || event.params.name !== harness.installer.sinkName) return;
    const [, sequence, ...rest] = String(event.params.payload).split("\n");
    if (Number(sequence) > highestSequence) {
      highestSequence = Number(sequence);
      finalPayload = rest.join("\n");
    }
  });
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1 && highestSequence >= 100_000, 30_000);
  assert.deepEqual(done, ["flooded"], "the worker must run its whole loop");
  // Anything the realm sent after its final emission would have arrived by now.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(highestSequence, 100_000, "the realm must fall silent at its emission cap");
  assert.equal(finalPayload, "closed\nnull", "the realm's final emission is its own null");

  const readout = await readWorkerRealms(harness, 500);
  assert.deepEqual([readout.readableSnapshots, readout.unreadRealms], [[], 1]);
  assert.equal(readout.diagnostics.streamBroken, 1);
});

/**
 * A thread-pool worker spends its idle time blocked in Atomics.wait. The
 * barrier is answered by interrupt, so such a worker is read within the bound
 * at the state it reached before it blocked. A barrier that waited for the
 * worker's task to end, as Runtime.evaluate does, would cut every idle pool
 * worker off.
 */
test("real Chromium: a worker blocked in Atomics.wait at the freeze is read within the bound", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    crossOriginIsolated: true,
    page: `<!doctype html><title>idle pool worker</title><script>
      const worker = new Worker("/pool.js");
      worker.onmessage = (event) => fetch("/done/" + event.data);
    </script>`,
    scripts: {
      "/pool.js":
        `${CANVAS_READ_SOURCE} ` +
        "setTimeout(() => { const cell = new Int32Array(new SharedArrayBuffer(4)); postMessage('waiting'); Atomics.wait(cell, 0, 0, 20000); }, 0);"
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  assert.deepEqual(done, ["waiting"], "the worker must reach its Atomics.wait");
  assert.equal(await harness.page.evaluate(() => crossOriginIsolated), true);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const readout = await readWorkerRealms(harness, 500);
  assert.equal(readout.unreadRealms, 0, JSON.stringify(readout.diagnostics));
  const collection = await collectFingerprintObservationsWithCoverage([], readout);
  assert.deepEqual(
    collection.observations.detections.map((detection) => detection.heuristic),
    ["openwpm-canvas-v1"]
  );
});

/**
 * Design test 10. The page terminates a worker while the channel still holds
 * it: the worker never ran a statement, so it is excluded, not a loss,
 * although its fingerprint install necessarily failed.
 */
test("real Chromium: a worker the page terminates while the channel holds it is excluded, not a loss", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>died paused</title><script>
      const worker = new Worker("/w.js");
      setTimeout(() => { worker.terminate(); fetch("/done/terminated"); }, 300);
    </script>`,
    scripts: { "/w.js": `${CANVAS_READ_SOURCE}` }
  });
  // An installer ahead of the observer holds each worker for a second, as a
  // slow GPC handshake would.
  const delay: WorkerRealmInstaller = {
    install: () => new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    concluded() {}
  };
  const harness = await openPausedWorkerHarness(t, { before: delay });
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1 && harness.installer.installDiagnostics().installFailedWorkerCount >= 1, 15_000);
  await harness.session.settle(5_000);

  assert.equal(harness.crashed(), false);
  assert.deepEqual(harness.installer.installDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1 });
  const readout = await readWorkerRealms(harness, 500);
  assert.equal(readout.diagnostics.diedPaused, 1);
  assert.deepEqual([readout.readableSnapshots, readout.unreadRealms], [[], 0]);
});

/**
 * Design test 11, owner-document scope. The first document starts a worker
 * that fingerprints, then navigates the page to a second document of the same
 * site, which ends the first worker with its document. The second document's
 * worker fingerprints differently and closes itself at once. Only the current
 * document's worker is credited, and the replaced one is not a loss.
 */
test("real Chromium: a worker of a document the page navigated away from is not credited, and a current document's closed worker is", { timeout: 60_000 }, async (t) => {
  const webglSource =
    "const gl = new OffscreenCanvas(16, 16).getContext('webgl'); gl.getParameter(37446); " +
    "gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));";
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>owner scope</title><script>
      if (location.search === "") {
        const worker = new Worker("/first.js");
        worker.onmessage = () => { location.href = "/?second"; };
      } else {
        new Worker("/second.js");
        fetch("/done/second-document");
      }
    </script>`,
    scripts: {
      "/first.js": `${CANVAS_READ_SOURCE} postMessage("read");`,
      "/second.js": `${webglSource} fetch(self.location.origin + "/done/second-worker"); self.close();`
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 2 && harness.workers.every((worker) => worker.detached), 15_000);
  assert.deepEqual(done.sort(), ["second-document", "second-worker"]);
  assert.equal(harness.workers.length, 2);

  const readout = await readWorkerRealms(harness);
  assert.equal(readout.unreadRealms, 0, JSON.stringify(readout.diagnostics));
  assert.equal(readout.diagnostics.ownerReplaced, 1);
  const collection = await collectFingerprintObservationsWithCoverage([], readout);
  assert.deepEqual(
    collection.observations.detections.map((detection) => detection.heuristic),
    ["webgl-entropy-read-v1"],
    "only the current document's worker may be credited"
  );
});

/**
 * The navigation ends the first document's worker in the middle of a long
 * task, after it has fingerprinted and said "open", so its task's closed
 * snapshot never comes. Its document is gone, so it is excluded, not cut off:
 * a busy worker of an interstitial that navigates to the site never counts
 * against the site's evidence.
 */
test("real Chromium: a worker ended mid-task by its document's navigation is excluded, not cut off", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>owner scope mid-task</title><script>
      if (location.search === "") {
        const worker = new Worker("/busy.js");
        worker.onmessage = () => { location.href = "/?second"; };
      } else {
        fetch("/done/second-document");
      }
    </script>`,
    scripts: {
      "/busy.js": `${CANVAS_READ_SOURCE} postMessage("read"); const until = Date.now() + 5000; while (Date.now() < until) {}`
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1 && harness.workers.length === 1 && harness.workers[0].detached, 15_000);
  assert.deepEqual(done, ["second-document"]);
  assert.equal(harness.workers[0].detached, true, "the navigation must end the first document's worker");

  const readout = await readWorkerRealms(harness, 300);
  assert.equal(readout.unreadRealms, 0, JSON.stringify(readout.diagnostics));
  assert.equal(readout.diagnostics.ownerReplaced, 1);
  assert.equal(readout.diagnostics.cutOff, 0);
  assert.deepEqual(readout.readableSnapshots, []);
});

/**
 * Owner scope across processes. With every site in its own process, a
 * cross-site iframe is its own target: its workers attach on its session, and
 * their owner is read from its frame tree, at the pause and at the readout.
 * The iframe's first worker closes itself at once and is credited while its
 * document is current; once the iframe navigates, only the new document's
 * worker is.
 */
test("real Chromium: a cross-site iframe's workers are scoped to the iframe's current document", { timeout: 60_000 }, async (t) => {
  let port = 0;
  // The fixture serves one page, top and frame alike; only the top embeds.
  const { origin, done } = await startWorkerFixture(t, () => ({
    page: `<!doctype html><title>cross-site frame</title><body><script>
      if (window === top) {
        const frame = document.createElement("iframe");
        frame.src = "http://localhost:${port}/?frame=1";
        document.body.append(frame);
      }
    </script>`,
    scripts: {
      "/closing.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/" + self.name); self.close();`
    }
  }));
  port = Number(new URL(origin).port);
  const harness = await openPausedWorkerHarness(t, { launchArgs: ["--site-per-process"] });
  const frameTargetSessions: string[] = [];
  harness.channel.onEvent((event) => {
    const targetInfo = event.params.targetInfo as { type?: unknown } | undefined;
    if (event.method === "Target.attachedToTarget" && targetInfo?.type === "iframe") {
      frameTargetSessions.push(String(event.params.sessionId));
    }
  });
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => harness.page.frames().length === 2, 10_000);
  const frame = harness.page.frames()[1];
  assert.match(frame.url(), /^http:\/\/localhost:/);
  await frame.evaluate(() => {
    new Worker("/closing.js", { name: "first" });
  });
  await waitFor(() => done.length >= 1 && harness.workers.length === 1 && harness.workers[0].detached, 15_000);
  assert.ok(
    frameTargetSessions.includes(String(harness.workers[0].arrivedOnSessionId)),
    "the worker must attach on the out-of-process frame's own session"
  );

  const current = await readWorkerRealms(harness, 300);
  assert.deepEqual([current.diagnostics.readable, current.unreadRealms], [1, 0], JSON.stringify(current.diagnostics));

  await frame.evaluate(() => {
    location.search = "?frame=2";
  });
  await waitFor(() => harness.page.frames()[1]?.url().endsWith("?frame=2") === true, 10_000);
  await harness.page.frames()[1].evaluate(() => {
    new Worker("/closing.js", { name: "second" });
  });
  await waitFor(() => done.length >= 2 && harness.workers.length === 2 && harness.workers[1].detached, 15_000);
  assert.deepEqual(done, ["first", "second"]);
  const replaced = await readWorkerRealms(harness, 300);
  assert.deepEqual(
    [replaced.diagnostics.readable, replaced.diagnostics.ownerReplaced, replaced.unreadRealms],
    [1, 1, 0],
    JSON.stringify(replaced.diagnostics)
  );
});

/**
 * Design test 12 at the realm level. The channel goes away while a worker it
 * installed is alive, and the page then starts another worker the channel can
 * no longer reach. Neither can be read, and the page never reads clean.
 */
test("real Chromium: a dropped channel leaves its live worker and every later worker unread", { timeout: 60_000 }, async (t) => {
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>dropped channel</title><script>new Worker("/first.js");</script>`,
    scripts: {
      "/first.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/first");`,
      "/late.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/late");`
    }
  });
  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  harness.session.close();
  await harness.page.evaluate(() => {
    new Worker("/late.js");
  });
  await waitFor(() => done.length >= 2, 15_000);
  assert.deepEqual(done.sort(), ["first", "late"]);

  const readout = await readWorkerRealms(harness, 200);
  assert.deepEqual(readout.readableSnapshots, []);
  assert.equal(readout.unreadRealms, 2);
  assert.equal(readout.diagnostics.channelLostAlive, 1);
  assert.equal(readout.diagnostics.unattachedDedicated, 1);
});

/**
 * A worker that turns hostile after the install: it looks for the sink and
 * calls it by its name, replaces the canvas and size getters and the
 * collection and serialization intrinsics, deletes createImageBitmap from its
 * global, poisons Promise.prototype.then and the promise constructor lookup
 * the observer's checkpoint would meet, and then fingerprints through a bitmap
 * drawn from a text canvas into a second canvas that it reads. The observer
 * captured everything it uses at install, its createImageBitmap wrapper sits
 * on WorkerGlobalScope.prototype, where the delete does not reach, and the
 * sink was deleted before the worker's first statement.
 */
test("real Chromium: a worker that poisons its realm after install still has its fingerprinting read back", { timeout: 60_000 }, async (t) => {
  let sinkName = "";
  const hostile = () => `
    const surfaces = Object.getOwnPropertyNames(self).filter((name) => name.includes("siteBehaviorLab"));
    const sinkType = typeof self[${JSON.stringify(sinkName)}];
    let sinkCall = "none";
    try { self[${JSON.stringify(sinkName)}]("forged"); sinkCall = "called"; } catch { sinkCall = "threw"; }
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
    const report = "/done/" + String(deleted) + "-" + String(typeof createBitmap) + "-" + surfaces.length + "-" + sinkType + "-" + sinkCall;
    (async () => {
      const source = new OffscreenCanvas(200, 60);
      source.getContext("2d").fillText("abcdefghijklmnopqrstuvwxyz0123", 2, 20);
      const bitmap = await createBitmap(source);
      // Poisoned once nothing of the worker's own awaits the promise lookups.
      Promise.prototype.then = function () { throw new Error("then poisoned"); };
      Object.defineProperty(Promise.prototype, "constructor", { get() { throw new Error("constructor poisoned"); }, configurable: true });
      Reflect.apply = () => undefined;
      Function.prototype.call = function () { return undefined; };
      const target = new OffscreenCanvas(200, 60);
      const context = target.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      reflectApply(nativeGetImageData, context, [0, 0, 200, 60]);
      nativeFetch(origin + report);
    })();
  `;
  const { origin, done } = await startWorkerFixture(t, () => ({
    page: `<!doctype html><title>hostile worker</title><script>new Worker("/hostile.js", { name: "hostile" });</script>`,
    scripts: { "/hostile.js": hostile() }
  }));

  const harness = await openPausedWorkerHarness(t);
  sinkName = harness.installer.sinkName;
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  // The delete succeeded and the worker still found a createImageBitmap: the
  // one on the prototype, which is the observer's wrapper. Nothing of the
  // observer is on the worker's global, and the sink is neither there nor
  // callable by its name.
  assert.deepEqual(done, ["true-function-0-undefined-threw"]);

  const readout = await readWorkerRealms(harness);
  assert.equal(readout.unreadRealms, 0, JSON.stringify(readout.diagnostics));
  const collection = await collectFingerprintObservationsWithCoverage([], readout);
  assert.equal(collection.readableWorkerRealms, 1);
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
  const { origin, done } = await startWorkerFixture(t, {
    page: `<!doctype html><title>worker listeners</title><script>new Worker("/listener.js", { name: "listener" });</script>`,
    scripts: {
      "/listener.js":
        "for (const type of ['message', 'keydown', 'input', 'click', 'scroll']) self.addEventListener(type, () => undefined);\n" +
        "fetch(self.location.origin + '/done/' + String(Function.prototype.toString.call(EventTarget.prototype.addEventListener).includes('[native code]')));"
    }
  });

  const harness = await openPausedWorkerHarness(t);
  await harness.page.goto(`${origin}/`, { timeout: 10_000 });
  await waitFor(() => done.length >= 1, 15_000);
  assert.deepEqual(done, ["true"], "the worker's addEventListener must be the native one");
  const collection = await collectFingerprintObservationsWithCoverage([], await readWorkerRealms(harness));
  assert.deepEqual(collection.observations, { events: [], detections: [] });
  assert.deepEqual([collection.attemptedWorkerRealms, collection.readableWorkerRealms], [1, 1]);
  assert.equal(collection.listenerAttributionLostFrames, 0);
  assert.deepEqual(harness.installer.installDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0 });
});

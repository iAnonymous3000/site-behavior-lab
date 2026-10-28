import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DedicatedWorkerAttachSession,
  type DevtoolsChannel,
  type DevtoolsEvent
} from "./devtools-worker-channel";
import {
  SHARED_WORKER_ENDED_AT_ONCE_MS,
  SharedWorkerAttacher,
  inProcessAttacherTransportForTests,
  sharedWorkerAttacherThread,
  sharedWorkerAttacherThreadSource,
  sharedWorkerEndedAtOnce,
  type AttachedSharedWorker,
  type SharedWorkerChange,
  type SharedWorkerVisitChannel
} from "./shared-worker-attacher";
import { FingerprintWorkerRealmInstaller, fingerprintObserverWorkerInstallExpression } from "./worker-fingerprint-realm";

/**
 * The shared-worker attacher's own program, run in this thread against a
 * scripted browser: the real thread function, its real messages and the real
 * main-thread classes, with only the WebSocket under it replaced. The
 * real-Chromium cases, with the program on its own thread, are in
 * lib/worker-fingerprint-realm.test.ts.
 */

type Frame = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Answer = Record<string, unknown> | Error | "never";

class ScriptedBrowser {
  readonly sent: Frame[] = [];
  private deliverFrame: ((frame: Record<string, unknown>) => void) | null = null;
  private closeSocket: (() => void) | null = null;

  constructor(private readonly respond: (frame: Frame, browser: ScriptedBrowser) => Answer) {}

  /** @internal The fake socket's side. */
  connect(deliver: (frame: Record<string, unknown>) => void, close: () => void): void {
    this.deliverFrame = deliver;
    this.closeSocket = close;
  }

  /** The browser goes away under the attacher: its connection closes from the browser's end. */
  disconnect(): void {
    this.closeSocket?.();
  }

  /** @internal */
  received(frame: Frame): void {
    this.sent.push(frame);
    const answer = this.respond(frame, this);
    if (answer === "never") return;
    this.deliverFrame?.(
      answer instanceof Error ? { id: frame.id, error: { message: answer.message } } : { id: frame.id, result: answer }
    );
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.deliverFrame?.(sessionId === undefined ? { method, params } : { method, params, sessionId });
  }

  /** Answers, now, a command the script left unanswered ("never"), in order with the events around it. */
  answer(frame: Frame, result: Record<string, unknown>): void {
    this.deliverFrame?.({ id: frame.id, result });
  }

  /** The first command of a method sent on a session. */
  frame(sessionId: string, method: string): Frame {
    const found = this.sent.find((candidate) => candidate.sessionId === sessionId && candidate.method === method);
    assert.ok(found, `no ${method} on ${sessionId}`);
    return found;
  }

  /** The methods sent on one session, in order; the browser-level ones when none is named. */
  commands(sessionId?: string): string[] {
    return this.sent.filter((frame) => frame.sessionId === sessionId).map((frame) => frame.method);
  }
}

function defaultAnswer(frame: Frame): Answer {
  if (frame.method === "Target.attachToTarget") return { sessionId: "page-session" };
  if (frame.method === "Debugger.setInstrumentationBreakpoint") return { breakpointId: `bp-${frame.sessionId}` };
  if (frame.method === "Runtime.evaluate") return { result: { type: "boolean", value: true } };
  if (frame.method === "Runtime.getIsolateId") return { id: `isolate-${frame.sessionId}` };
  return {};
}

/** The real thread program, in this thread, over a socket the scripted browser answers in order. */
async function scriptedAttacher(
  t: TestContext,
  respond: (frame: Frame, browser: ScriptedBrowser) => Answer = defaultAnswer,
  options: { holdTimeoutMs?: number } = {}
): Promise<{ browser: ScriptedBrowser; attacher: SharedWorkerAttacher }> {
  const browser = new ScriptedBrowser(respond);
  class ScriptedSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      // One task per frame, in order, as a socket delivers them.
      browser.connect(
        (frame) => {
          const data = JSON.stringify(frame);
          setImmediate(() => this.onmessage?.({ data }));
        },
        () => this.close()
      );
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(text: string): void {
      browser.received(JSON.parse(text) as Frame);
    }
    close(): void {
      this.readyState = 3;
      setImmediate(() => this.onclose?.());
    }
  }
  const globals = globalThis as unknown as { WebSocket: unknown };
  const original = globals.WebSocket;
  globals.WebSocket = ScriptedSocket;
  let transport: ReturnType<typeof inProcessAttacherTransportForTests>;
  try {
    transport = inProcessAttacherTransportForTests({
      webSocketUrl: "ws://127.0.0.1:9/devtools/browser/scripted",
      ...(options.holdTimeoutMs !== undefined ? { holdTimeoutMs: options.holdTimeoutMs } : {})
    });
  } finally {
    globals.WebSocket = original;
  }
  const attacher = await SharedWorkerAttacher.openOverTransportForTests(transport);
  t.after(() => attacher.close());
  return { browser, attacher };
}

const ORIGIN = "http://127.0.0.1:4100";
const MAIN_URL = `blob:${ORIGIN}/7d1f6b0e-0000-4000-8000-000000000001`;

function sharedAttach(
  browser: ScriptedBrowser,
  sessionId: string,
  options: { contextId?: string; url?: string; waitingForDebugger?: boolean } = {}
): void {
  browser.emit("Target.attachedToTarget", {
    sessionId,
    targetInfo: {
      type: "shared_worker",
      targetId: `${sessionId}-target`,
      url: options.url ?? MAIN_URL,
      browserContextId: options.contextId ?? "context-a"
    },
    waitingForDebugger: options.waitingForDebugger ?? true
  });
}

function mainScriptPause(browser: ScriptedBrowser, sessionId: string, url = MAIN_URL): void {
  browser.emit("Debugger.scriptParsed", { scriptId: "3", url }, sessionId);
  browser.emit("Debugger.paused", { reason: "instrumentation", data: { scriptId: "3", url }, callFrames: [] }, sessionId);
}

function commitMainDocument(browser: ScriptedBrowser, loaderId: string, origin = ORIGIN): void {
  browser.emit("Page.frameNavigated", { frame: { id: "main-frame", loaderId, url: `${origin}/`, securityOrigin: origin } }, "page-session");
}

/** Waits for a condition; one that throws (a worker not reported yet) is not met yet. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const met = () => {
    try {
      return condition();
    } catch {
      return false;
    }
  };
  while (!met()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function registerVisit(
  attacher: SharedWorkerAttacher,
  installer: FingerprintWorkerRealmInstaller,
  contextId = "context-a"
): Promise<{ visit: SharedWorkerVisitChannel; changes: string[] }> {
  const visit = await attacher.register({
    browserContextId: contextId,
    pageTargetId: `page-of-${contextId}`,
    installCommands: installer.sharedWorkerInstallCommands()
  });
  const changes: string[] = [];
  visit.onWorkerChange((worker, change: SharedWorkerChange) => changes.push(`${worker.sessionId}:${change}`));
  installer.watchSharedWorkers(visit);
  return { visit, changes };
}

function workerOf(visit: SharedWorkerVisitChannel, sessionId: string): AttachedSharedWorker {
  const worker = visit.workers().find((candidate) => candidate.sessionId === sessionId);
  assert.ok(worker, `no worker ${sessionId}`);
  return worker;
}

/** A worker's hold for a wait's condition, before the visit may have heard of it. */
function holdOf(visit: SharedWorkerVisitChannel, sessionId: string): string | undefined {
  return visit.workers().find((candidate) => candidate.sessionId === sessionId)?.hold;
}

/** The realm's first closed snapshot on the sink, as the observer emits it during its install. */
function firstSnapshot(installer: FingerprintWorkerRealmInstaller, sessionId: string, browser: ScriptedBrowser): void {
  browser.emit(
    "Runtime.bindingCalled",
    { name: installer.sinkName, payload: `${installer.capability}\n1\nclosed\n${JSON.stringify({ detections: [], events: {} })}` },
    sessionId
  );
}

test("the attach step sets the breakpoint, then releases the start-up hold, on the worker's own session, and sends nothing else before a pause", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => visit.workers().length === 1 && browser.commands("sw-1").length === 3);
  assert.deepEqual(browser.commands("sw-1"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Runtime.runIfWaitingForDebugger"
  ]);
  assert.deepEqual(
    browser.sent.find((frame) => frame.method === "Debugger.setInstrumentationBreakpoint")?.params,
    { instrumentation: "beforeScriptExecution" }
  );
  assert.deepEqual(browser.commands(undefined).slice(0, 1), ["Target.setAutoAttach"]);
  assert.deepEqual(browser.sent[0].params, {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "shared_worker", exclude: false }, { exclude: true }]
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(browser.commands("sw-1").length, 3, "no binding and no install before the main-script pause");
  assert.equal(workerOf(visit, "sw-1").hold, "pending");
});

test("a shared worker of a context no visit registered is detached in its attach step, and nothing else is ever sent to it", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "foreign-1", { contextId: "context-of-another-scan" });
  // Whatever it does afterwards is not this attacher's.
  mainScriptPause(browser, "foreign-1");
  browser.emit("Runtime.bindingCalled", { name: installer.sinkName, payload: "anything" }, "foreign-1");
  await until(() => attacher.foreignDetachesForTests().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(browser.commands("foreign-1"), [], "no command on the other context's worker's session");
  const detach = browser.sent.filter((frame) => frame.method === "Target.detachFromTarget");
  assert.deepEqual(detach.map((frame) => [frame.sessionId, frame.params]), [[undefined, { sessionId: "foreign-1" }]]);
  assert.deepEqual(visit.workers(), [], "the visit never hears of it");
  assert.equal(attacher.foreignDetachesForTests()[0].browserContextId, "context-of-another-scan");
});

test("a pause at the main script runs the installer's commands while held, then removes the breakpoint and turns the debugger off", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    // The observer's first closed snapshot goes out during the evaluation,
    // ahead of the evaluation's answer, on the same socket.
    if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
    return defaultAnswer(frame);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1");
  await until(() => workerOf(visit, "sw-1").hold === "released");
  assert.deepEqual(browser.commands("sw-1"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Runtime.runIfWaitingForDebugger",
    "Runtime.addBinding",
    "Runtime.evaluate",
    "Debugger.removeBreakpoint",
    "Debugger.disable"
  ]);
  const onSession = browser.sent.filter((frame) => frame.sessionId === "sw-1");
  assert.deepEqual(onSession[3].params, { name: installer.sinkName });
  assert.deepEqual(onSession[4].params, {
    expression: fingerprintObserverWorkerInstallExpression("127.0.0.1", installer, "shared-worker"),
    returnByValue: true
  });
  assert.deepEqual(onSession[5].params, { breakpointId: "bp-sw-1" });
  assert.deepEqual(changes, ["sw-1:attached", "sw-1:held", "sw-1:installed", "sw-1:released"]);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0, lateWorkerCount: 0 });
  const worker = workerOf(visit, "sw-1");
  assert.equal(worker.debuggerOffAtRelease, true);
  assert.ok(worker.holdMs !== null && worker.holdMs >= 0);
});

test("an install answer without its first snapshot already forwarded leaves the shared worker's install failed", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Runtime.evaluate" && installer) {
      // The answer first, and the snapshot only after it: not an order the
      // install accepts.
      const sessionId = frame.sessionId!;
      setImmediate(() => setImmediate(() => firstSnapshot(installer!, sessionId, scripted)));
    }
    return defaultAnswer(frame);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1");
  await until(() => workerOf(visit, "sw-1").hold === "released");
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1, lateWorkerCount: 0 });
});

test("a first pause at another script is a late attach: nothing is installed and the debugger goes off at once", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1", `${ORIGIN}/imported-first.js`);
  await until(() => workerOf(visit, "sw-1").hold === "late");
  await until(() => browser.commands("sw-1").length === 5);
  assert.deepEqual(browser.commands("sw-1").slice(3), ["Debugger.removeBreakpoint", "Debugger.disable"]);
  assert.equal(workerOf(visit, "sw-1").lateReason, "other-script");
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 0, lateWorkerCount: 1 });
  // A later pause, before the debugger is off, changes nothing.
  mainScriptPause(browser, "sw-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workerOf(visit, "sw-1").hold, "late");
  assert.equal(browser.commands("sw-1").includes("Runtime.evaluate"), false);
});

/**
 * The broken hold, as traced in real Chromium (impl/hold-rate, 2026-10-27):
 * paused at its main script, the worker is let run by a release that is not
 * the thread's (Playwright's detach of the worker, or the thread's own
 * release reaching a worker another client already started), runs its main
 * script with no observer and stops at its `debugger;` statement, where the
 * install finally evaluates and answers. Through fingerprint-observer@10's
 * first build the thread reported that worker installed and released, and
 * the readout read it complete on the install's empty snapshot. Now the
 * resume while the install is unanswered makes it late: the debugger goes
 * off at once, nothing reports it installed or released, and the readout
 * counts it unread.
 */
test("a resume the thread did not send, before the install answers, breaks the hold: the worker is late, the debugger goes off at once, and nothing reports it installed or released", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t, (frame) =>
    frame.method === "Runtime.evaluate" ? "never" : defaultAnswer(frame)
  );
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1");
  await until(() => browser.commands("sw-1").includes("Runtime.evaluate"));
  browser.emit("Debugger.resumed", {}, "sw-1");
  await until(() => holdOf(visit, "sw-1") === "late");
  await until(() => browser.commands("sw-1").includes("Debugger.disable"));
  assert.deepEqual(browser.commands("sw-1"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Runtime.runIfWaitingForDebugger",
    "Runtime.addBinding",
    "Runtime.evaluate",
    "Debugger.removeBreakpoint",
    "Debugger.disable"
  ]);
  assert.equal(workerOf(visit, "sw-1").lateReason, "resumed-while-held");
  // The worker reaches its `debugger;` statement, where the install
  // evaluates late: its first snapshot, then its answer.
  browser.emit("Debugger.paused", { reason: "other", data: {}, callFrames: [] }, "sw-1");
  firstSnapshot(installer, "sw-1", browser);
  browser.answer(browser.frame("sw-1", "Runtime.evaluate"), { result: { type: "boolean", value: true } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(changes, ["sw-1:attached", "sw-1:held", "sw-1:late"]);
  const worker = workerOf(visit, "sw-1");
  assert.deepEqual([worker.hold, worker.holdMs, worker.debuggerOffAtRelease], ["late", null, null]);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 0, lateWorkerCount: 1 });
  assert.equal(
    browser.commands("sw-1").filter((method) => method === "Debugger.disable").length,
    1,
    "the debugger went off once, at the broken hold"
  );
});

test("a pause at a statement while held breaks the hold even if the resume ahead of it was never seen", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t, (frame) =>
    frame.method === "Runtime.evaluate" ? "never" : defaultAnswer(frame)
  );
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1");
  await until(() => browser.commands("sw-1").includes("Runtime.evaluate"));
  browser.emit("Debugger.paused", { reason: "other", data: {}, callFrames: [] }, "sw-1");
  await until(() => holdOf(visit, "sw-1") === "late");
  await until(() => browser.commands("sw-1").includes("Debugger.disable"));
  assert.equal(workerOf(visit, "sw-1").lateReason, "resumed-while-held");
  assert.deepEqual(changes, ["sw-1:attached", "sw-1:held", "sw-1:late"]);
});

/**
 * The other order: every install command answered while the worker was
 * still paused, so the observer was in place, and the resume comes behind the
 * answers on the worker's session. It is the hold's own end, and the worker is
 * released and read.
 */
test("a resume behind the install's answers keeps the hold: the worker is released and its install counts", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
    if (frame.method === "Debugger.disable") return "never";
    return defaultAnswer(frame);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1");
  await until(() => browser.commands("sw-1").includes("Debugger.disable"));
  browser.emit("Debugger.resumed", {}, "sw-1");
  browser.answer(browser.frame("sw-1", "Debugger.disable"), {});
  await until(() => holdOf(visit, "sw-1") === "released");
  assert.deepEqual(changes, ["sw-1:attached", "sw-1:held", "sw-1:installed", "sw-1:released"]);
  assert.equal(workerOf(visit, "sw-1").lateReason, null);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0, lateWorkerCount: 0 });
});

/** Defense in depth on the main thread: once late, a worker is never presented as held, installed or released. */
test("a late shared worker stays late whatever reports follow it", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1", `${ORIGIN}/imported-first.js`);
  await until(() => holdOf(visit, "sw-1") === "late");
  for (const type of ["held", "installed", "released", "late"]) {
    visit.onThreadReport({ type, contextId: "context-a", sessionId: "sw-1", answers: [], holdMs: 1, debuggerOff: true, reason: "other-pause" });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const worker = workerOf(visit, "sw-1");
  assert.deepEqual([worker.hold, worker.lateReason, worker.holdMs], ["late", "other-script", null]);
  assert.deepEqual(changes, ["sw-1:attached", "sw-1:late"]);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 0, lateWorkerCount: 1 });
});

/**
 * The worker emits the breakpoint's answer and its main script's parse in the
 * order they happened. A parse ahead of the answer (a script compiled before
 * the breakpoint was surely set) gets one probe on the worker's session: no
 * pause ahead of the probe's answer means the script ran, and a pause ahead
 * of it is a hold. A parse behind the answer needs no probe: the breakpoint
 * was set before the script compiled, so its pause is certain.
 */
test("a main script parsed before the breakpoint's answer with no pause ahead of the probe's answer was reached late; a pause ahead of it, or a parse behind the answer, is a hold", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Debugger.setInstrumentationBreakpoint" && frame.sessionId !== "parsed-after") {
      // Compiled before the breakpoint's answer: a replay, or a race.
      scripted.emit("Debugger.scriptParsed", { scriptId: "3", url: MAIN_URL }, frame.sessionId);
    }
    if (frame.method === "Runtime.getIsolateId" && frame.sessionId === "paused-ahead") {
      // The pause the worker emitted before the probe reached it.
      scripted.emit("Debugger.paused", { reason: "instrumentation", data: { scriptId: "3", url: MAIN_URL } }, frame.sessionId);
    }
    return defaultAnswer(frame);
  });
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);

  sharedAttach(browser, "ran");
  await until(() => holdOf(visit, "ran") === "late");
  assert.equal(workerOf(visit, "ran").lateReason, "ran-before-breakpoint");
  await until(() => browser.commands("ran").length === 6);
  assert.deepEqual(browser.commands("ran").slice(3), ["Runtime.getIsolateId", "Debugger.removeBreakpoint", "Debugger.disable"]);

  sharedAttach(browser, "paused-ahead");
  await until(() => holdOf(visit, "paused-ahead") === "released");
  assert.equal(workerOf(visit, "paused-ahead").lateReason, null);

  sharedAttach(browser, "parsed-after");
  await until(() => browser.commands("parsed-after").length === 3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  mainScriptPause(browser, "parsed-after");
  await until(() => workerOf(visit, "parsed-after").hold === "released");
  assert.equal(browser.commands("parsed-after").includes("Runtime.getIsolateId"), false, "no probe after a parse behind the answer");
});

test("a worker already running when it attached is late, and nothing is sent to it", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "running", { waitingForDebugger: false });
  await until(() => visit.workers().length === 1 && workerOf(visit, "running").hold === "late");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(browser.commands("running"), []);
  assert.equal(workerOf(visit, "running").lateReason, "running-at-attach");
});

test("the hold's watchdog lets a worker run when its install never answers, and the install counts as failed", async (t) => {
  const { browser, attacher } = await scriptedAttacher(
    t,
    (frame) => (frame.method === "Runtime.evaluate" ? "never" : defaultAnswer(frame)),
    { holdTimeoutMs: 40 }
  );
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === 3);
  mainScriptPause(browser, "sw-1");
  await until(() => workerOf(visit, "sw-1").hold === "released");
  assert.deepEqual(browser.commands("sw-1").slice(-2), ["Debugger.removeBreakpoint", "Debugger.disable"]);
  assert.deepEqual(changes, ["sw-1:attached", "sw-1:held", "sw-1:installed", "sw-1:released"]);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1, lateWorkerCount: 0 });
});

test("a worker gone while held died paused; one gone before any pause or script ended unreached; a parse or a long life is not ending at once", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t, (frame) =>
    frame.method === "Runtime.evaluate" && frame.sessionId === "dies-held" ? "never" : defaultAnswer(frame)
  );
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);

  sharedAttach(browser, "dies-held");
  await until(() => browser.commands("dies-held").length === 3);
  mainScriptPause(browser, "dies-held");
  await until(() => workerOf(visit, "dies-held").hold === "held");
  browser.emit("Target.detachedFromTarget", { sessionId: "dies-held" });
  await until(() => workerOf(visit, "dies-held").detached);
  assert.equal(workerOf(visit, "dies-held").detachedWhilePaused, true);

  sharedAttach(browser, "at-once");
  browser.emit("Target.detachedFromTarget", { sessionId: "at-once" });
  await until(() => visit.workers().some((worker) => worker.sessionId === "at-once" && worker.detached));
  const atOnce = workerOf(visit, "at-once");
  assert.equal(atOnce.endedUnreached, true);
  assert.ok(atOnce.lifetimeMs !== null && atOnce.lifetimeMs <= SHARED_WORKER_ENDED_AT_ONCE_MS, `${atOnce.lifetimeMs}`);
  assert.equal(sharedWorkerEndedAtOnce(atOnce), true);

  sharedAttach(browser, "parsed");
  browser.emit("Debugger.scriptParsed", { scriptId: "9", url: MAIN_URL }, "parsed");
  browser.emit("Target.detachedFromTarget", { sessionId: "parsed" });
  await until(() => visit.workers().some((worker) => worker.sessionId === "parsed" && worker.detached));
  assert.equal(workerOf(visit, "parsed").endedUnreached, false, "a script of it was seen: it may have run");
  assert.equal(sharedWorkerEndedAtOnce(workerOf(visit, "parsed")), false);

  sharedAttach(browser, "lived");
  await until(() => visit.workers().some((worker) => worker.sessionId === "lived"));
  await new Promise((resolve) => setTimeout(resolve, SHARED_WORKER_ENDED_AT_ONCE_MS * 3));
  browser.emit("Target.detachedFromTarget", { sessionId: "lived" });
  await until(() => workerOf(visit, "lived").detached);
  assert.equal(workerOf(visit, "lived").endedUnreached, true);
  assert.equal(sharedWorkerEndedAtOnce(workerOf(visit, "lived")), false, "it lived past the bound");
});

test("a worker's creation document is the main frame's current document on the attacher's own connection, and a subframe's commit moves nothing", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  assert.equal(visit.watchesDocuments(), true);
  assert.deepEqual(browser.commands("page-session"), ["Page.enable"]);
  sharedAttach(browser, "before-commit");
  commitMainDocument(browser, "loader-1");
  browser.emit(
    "Page.frameNavigated",
    { frame: { id: "child-frame", parentId: "main-frame", loaderId: "child-loader", securityOrigin: "https://ads.example" } },
    "page-session"
  );
  sharedAttach(browser, "after-commit");
  commitMainDocument(browser, "loader-2");
  sharedAttach(browser, "after-second-commit");
  await until(() => visit.workers().length === 3);
  assert.deepEqual(
    visit.workers().map((worker) => [worker.sessionId, worker.creationDocument]),
    [
      ["before-commit", null],
      ["after-commit", { frameId: "main-frame", loaderId: "loader-1", securityOrigin: ORIGIN }],
      ["after-second-commit", { frameId: "main-frame", loaderId: "loader-2", securityOrigin: ORIGIN }]
    ]
  );
  // A page session gone takes the documents with it.
  browser.emit("Target.detachedFromTarget", { sessionId: "page-session" });
  await until(() => !visit.watchesDocuments());
  sharedAttach(browser, "after-page-lost");
  await until(() => visit.workers().length === 4);
  assert.equal(workerOf(visit, "after-page-lost").creationDocument, null);
});

test("the main thread may send only the barrier, and only to its own context's workers", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const { visit: first } = await registerVisit(attacher, new FingerprintWorkerRealmInstaller("127.0.0.1"), "context-a");
  const { visit: second } = await registerVisit(attacher, new FingerprintWorkerRealmInstaller("127.0.0.1"), "context-b");
  sharedAttach(browser, "a-1", { contextId: "context-a" });
  sharedAttach(browser, "b-1", { contextId: "context-b" });
  await until(() => first.workers().length === 1 && second.workers().length === 1);
  assert.deepEqual(await first.channel.send("Runtime.getIsolateId", {}, "a-1"), { id: "isolate-a-1" });
  await assert.rejects(first.channel.send("Runtime.getIsolateId", {}, "b-1"), /Not a command this visit may send/);
  await assert.rejects(first.channel.send("Runtime.evaluate", { expression: "1" }, "a-1"), /is not sent to a shared worker/);
  assert.equal(browser.commands("b-1").includes("Runtime.getIsolateId"), false);
});

test("unregistering a visit detaches its workers and its page session, and its context's later workers are another's", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const { visit } = await registerVisit(attacher, new FingerprintWorkerRealmInstaller("127.0.0.1"));
  sharedAttach(browser, "sw-1");
  await until(() => visit.workers().length === 1);
  visit.unregister();
  assert.equal(visit.isChannelLost(), true);
  await until(() => browser.sent.filter((frame) => frame.method === "Target.detachFromTarget").length === 2);
  assert.deepEqual(
    browser.sent.filter((frame) => frame.method === "Target.detachFromTarget").map((frame) => frame.params.sessionId).sort(),
    ["page-session", "sw-1"]
  );
  sharedAttach(browser, "sw-2");
  await until(() => attacher.foreignDetachesForTests().length === 1);
  assert.deepEqual(browser.commands("sw-2"), []);
});

test("a lost DevTools connection loses every visit's channel, and a registration after it is refused", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const { visit } = await registerVisit(attacher, new FingerprintWorkerRealmInstaller("127.0.0.1"));
  const closed: string[] = [];
  visit.channel.onClose(() => closed.push("closed"));
  browser.disconnect();
  await until(() => attacher.isLost());
  assert.equal(visit.isChannelLost(), true);
  assert.deepEqual(closed, ["closed"]);
  await assert.rejects(
    attacher.register({ browserContextId: "context-b", pageTargetId: "page-b", installCommands: [] }),
    /connection closed/
  );
});

/**
 * The thread's program is serialized and run in a thread of its own, from the
 * bundle the scanner ships in. Anything it named outside its own body (an
 * import, a helper a compiler injected, the environment) would not exist
 * there, and a bundler may rewrite a module reference into one that does not.
 */
test("the serialized thread program is one self-contained function that names no module, import, helper or environment", () => {
  const program = sharedWorkerAttacherThread.toString();
  for (const forbidden of ["require(", "import(", "__webpack", "process.", "exports.", "module.", "__awaiter", "__classPrivateField", "__asyncGenerator", "_1."]) {
    assert.equal(program.includes(forbidden), false, `the thread program names ${forbidden}`);
  }
  // It parses on its own, as the thread will parse it.
  assert.equal(typeof new Function(`return (${program});`)(), "function");
  const source = sharedWorkerAttacherThreadSource();
  assert.equal(source.split("\n")[0], 'const { parentPort, workerData } = require("node:worker_threads");');
  assert.ok(source.includes(program));
});

/**
 * The readout's shared terms over the real attacher program: a scripted page
 * channel answers the frame tree at the freeze, and the scripted browser
 * plays the shared worker.
 */
async function scriptedSharedReadout(t: TestContext, respond: (frame: Frame, browser: ScriptedBrowser) => Answer = defaultAnswer) {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
    return respond(frame, scripted);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  let mainDocument = { id: "main-frame", loaderId: "loader-1", securityOrigin: ORIGIN };
  const pageHandlers: Array<(event: DevtoolsEvent) => void> = [];
  const pageChannel: DevtoolsChannel = {
    async send(method) {
      if (method === "Target.attachToTarget") return { sessionId: "page-on-channel" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: mainDocument } };
      return {};
    },
    onEvent(handler) {
      pageHandlers.push(handler);
    },
    onClose() {},
    close() {}
  };
  const session = new DedicatedWorkerAttachSession(pageChannel, [installer]);
  await session.watchSharedWorkers("context-a");
  await session.attachToPage("page-target");
  const { visit } = await registerVisit(attacher, installer);
  return {
    browser,
    installer: installer as FingerprintWorkerRealmInstaller,
    visit,
    session,
    discover(targetId: string) {
      for (const handler of pageHandlers) {
        handler({ method: "Target.targetCreated", params: { targetInfo: { type: "shared_worker", targetId, browserContextId: "context-a" } } });
      }
    },
    setMainDocument(next: { id: string; loaderId: string; securityOrigin: string }) {
      mainDocument = next;
    },
    readout(settleMs = 200) {
      return installer!.readout({ session, witness: { count: () => 0 }, settleMs });
    }
  };
}

function sharedTerms(readout: Awaited<ReturnType<FingerprintWorkerRealmInstaller["readout"]>>) {
  return {
    ...Object.fromEntries(Object.entries(readout.diagnostics.sharedWorkers).filter(([, value]) => value !== 0)),
    unread: readout.unreadRealms,
    readable: readout.readableSnapshots.length,
    unscoped: readout.unscopedSnapshots.length,
    endedAtOnce: readout.sharedWorkersEndedAtOnce
  };
}

test("readout: a shared worker held at its main script at the freeze ran nothing and is excluded", async (t) => {
  const realms = await scriptedSharedReadout(t, (frame) => (frame.method === "Runtime.evaluate" ? "never" : defaultAnswer(frame)));
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === 3);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => workerOf(realms.visit, "sw-1").hold === "held");
  assert.deepEqual(sharedTerms(await realms.readout(20)), {
    attached: 1,
    pausedAtReadout: 1,
    unread: 0,
    readable: 0,
    unscoped: 0,
    endedAtOnce: 0
  });
});

test("readout: a shared worker attached but not yet paused at the freeze is excluded when its first move is its main-script hold, and unread when it is late or makes none", async (t) => {
  const held = await scriptedSharedReadout(t);
  commitMainDocument(held.browser, "loader-1");
  sharedAttach(held.browser, "sw-1");
  await until(() => held.browser.commands("sw-1").length === 3);
  const pending = held.readout(1_000);
  setTimeout(() => mainScriptPause(held.browser, "sw-1"), 20);
  assert.deepEqual(sharedTerms(await pending), { attached: 1, pausedAtReadout: 1, unread: 0, readable: 0, unscoped: 0, endedAtOnce: 0 });

  const late = await scriptedSharedReadout(t);
  sharedAttach(late.browser, "sw-1");
  await until(() => late.browser.commands("sw-1").length === 3);
  const lateReadout = late.readout(1_000);
  setTimeout(() => mainScriptPause(late.browser, "sw-1", `${ORIGIN}/other.js`), 20);
  assert.deepEqual(sharedTerms(await lateReadout), { attached: 1, attachedLate: 1, unread: 1, readable: 0, unscoped: 0, endedAtOnce: 0 });

  const silent = await scriptedSharedReadout(t);
  sharedAttach(silent.browser, "sw-1");
  await until(() => silent.browser.commands("sw-1").length === 3);
  assert.deepEqual(sharedTerms(await silent.readout(50)), { attached: 1, unreached: 1, unread: 1, readable: 0, unscoped: 0, endedAtOnce: 0 });
});

test("readout: a shared worker read in full is credited only when its creation document is the main frame's at the freeze and its script is of that origin", async (t) => {
  for (const [label, url, freezeDocument, expected] of [
    ["same document and origin", MAIN_URL, { id: "main-frame", loaderId: "loader-1", securityOrigin: ORIGIN }, "readable"],
    ["a later document of the origin", MAIN_URL, { id: "main-frame", loaderId: "loader-2", securityOrigin: ORIGIN }, "unscoped"],
    ["another origin's script", "blob:https://ads.example/1", { id: "main-frame", loaderId: "loader-1", securityOrigin: ORIGIN }, "unscoped"],
    ["an opaque origin", "data:text/javascript,1", { id: "main-frame", loaderId: "loader-1", securityOrigin: ORIGIN }, "unscoped"]
  ] as const) {
    const realms = await scriptedSharedReadout(t);
    commitMainDocument(realms.browser, "loader-1");
    sharedAttach(realms.browser, "sw-1", { url });
    await until(() => realms.browser.commands("sw-1").length === 3);
    mainScriptPause(realms.browser, "sw-1", url);
    await until(() => workerOf(realms.visit, "sw-1").hold === "released");
    realms.setMainDocument({ ...freezeDocument });
    const terms = sharedTerms(await realms.readout());
    assert.deepEqual(
      [terms.readable, terms.unscoped, terms.unread],
      expected === "readable" ? [1, 0, 0] : [0, 1, 0],
      `${label}: ${JSON.stringify(terms)}`
    );
  }
});

test("readout: a discovered shared worker the attacher reports during the drain is joined by target, and one it never reports is unattached", async (t) => {
  const realms = await scriptedSharedReadout(t);
  commitMainDocument(realms.browser, "loader-1");
  realms.discover("sw-1-target");
  realms.discover("never-reported-target");
  const pending = realms.readout(300);
  setTimeout(() => sharedAttach(realms.browser, "sw-1"), 20);
  setTimeout(() => mainScriptPause(realms.browser, "sw-1"), 60);
  const terms = sharedTerms(await pending);
  assert.deepEqual(terms, {
    discovered: 2,
    attached: 1,
    pausedAtReadout: 1,
    unattached: 1,
    unread: 1,
    readable: 0,
    unscoped: 0,
    endedAtOnce: 0
  });
});

/**
 * The main thread's view of a hold lags the attacher's thread: the thread may
 * already have found a hold broken, its "late" report still in flight, or
 * find it so moments later. A broken hold ran its main script unobserved, so a
 * shared worker seen held is unsettled until its next move, bounded by the
 * drain: late is unread; released, or still held at the bound, is excluded.
 * Each case scripts the worker's install to stay unanswered, so its hold lasts
 * until the case moves it.
 */
const heldWhileUnanswered = (frame: Frame): Answer => (frame.method === "Runtime.evaluate" ? "never" : defaultAnswer(frame));
const UNREAD_LATE = { attached: 1, attachedLate: 1, unread: 1, readable: 0, unscoped: 0, endedAtOnce: 0 };
const EXCLUDED_HELD = { attached: 1, pausedAtReadout: 1, unread: 0, readable: 0, unscoped: 0, endedAtOnce: 0 };

test("readout: a shared worker held at the freeze whose hold then breaks during the drain is unread", async (t) => {
  const realms = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === 3);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => holdOf(realms.visit, "sw-1") === "held");
  const pending = realms.readout(1_000);
  setTimeout(() => realms.browser.emit("Debugger.resumed", {}, "sw-1"), 20);
  const readout = await pending;
  assert.deepEqual(sharedTerms(readout), UNREAD_LATE);
  assert.equal(workerOf(realms.visit, "sw-1").lateReason, "resumed-while-held");
});

test("readout: a shared worker reaching at the freeze that is held and then breaks its hold during the drain is unread", async (t) => {
  const realms = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === 3);
  const pending = realms.readout(1_000);
  setTimeout(() => mainScriptPause(realms.browser, "sw-1"), 20);
  setTimeout(() => realms.browser.emit("Debugger.resumed", {}, "sw-1"), 60);
  assert.deepEqual(sharedTerms(await pending), UNREAD_LATE);
});

test("readout: a shared worker attached during the drain that is held and then breaks its hold is unread", async (t) => {
  const realms = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(realms.browser, "loader-1");
  // sw-0, reaching at the freeze, keeps the drain open until it moves (late,
  // at 40 ms); by then sw-1, attached during the drain, is held, so the drain
  // waits for its next move too.
  sharedAttach(realms.browser, "sw-0");
  await until(() => realms.browser.commands("sw-0").length === 3);
  const pending = realms.readout(1_000);
  setTimeout(() => sharedAttach(realms.browser, "sw-1"), 10);
  setTimeout(() => mainScriptPause(realms.browser, "sw-1"), 20);
  setTimeout(() => mainScriptPause(realms.browser, "sw-0", `${ORIGIN}/other.js`), 40);
  setTimeout(() => realms.browser.emit("Debugger.resumed", {}, "sw-1"), 80);
  assert.deepEqual(sharedTerms(await pending), { attached: 2, attachedLate: 2, unread: 2, readable: 0, unscoped: 0, endedAtOnce: 0 });
  assert.deepEqual(
    [workerOf(realms.visit, "sw-0").lateReason, workerOf(realms.visit, "sw-1").lateReason],
    ["other-script", "resumed-while-held"]
  );
});

test("readout: a shared worker held at the freeze and released during the drain is excluded, as it ran nothing before the freeze", async (t) => {
  const realms = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === 3);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => holdOf(realms.visit, "sw-1") === "held");
  const pending = realms.readout(1_000);
  setTimeout(
    () => realms.browser.answer(realms.browser.frame("sw-1", "Runtime.evaluate"), { result: { type: "boolean", value: true } }),
    20
  );
  assert.deepEqual(sharedTerms(await pending), EXCLUDED_HELD);
  assert.equal(workerOf(realms.visit, "sw-1").hold, "released");
});

test("readout: a shared worker still held at the drain's bound is excluded", async (t) => {
  const realms = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === 3);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => holdOf(realms.visit, "sw-1") === "held");
  const started = Date.now();
  assert.deepEqual(sharedTerms(await realms.readout(80)), EXCLUDED_HELD);
  assert.ok(Date.now() - started >= 70, "the drain waited for the hold's next move until its bound");
  assert.equal(holdOf(realms.visit, "sw-1"), "held");
});

test("readout: a shared worker that ended at once is reported apart, and a lost attacher leaves its live workers unread", async (t) => {
  const realms = await scriptedSharedReadout(t);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "gone");
  realms.browser.emit("Target.detachedFromTarget", { sessionId: "gone" });
  sharedAttach(realms.browser, "live");
  await until(() => realms.browser.commands("live").length === 3);
  mainScriptPause(realms.browser, "live");
  await until(() => workerOf(realms.visit, "live").hold === "released" && workerOf(realms.visit, "gone").detached);
  assert.deepEqual(sharedTerms(await realms.readout()), {
    attached: 2,
    readable: 1,
    endedAtOnce: 1,
    unread: 0,
    unscoped: 0
  });
  realms.visit.markLost();
  assert.deepEqual(sharedTerms(await realms.readout()), {
    attached: 2,
    channelLostAlive: 1,
    endedAtOnce: 1,
    unread: 1,
    readable: 0,
    unscoped: 0
  });
});

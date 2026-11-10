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

/**
 * What the thread has sent on a worker's session once its attach step is
 * over and the question has answered: the debugger's enable, the breakpoint,
 * the question, the release, and the question's removal.
 */
const ATTACH_STEP = 5;

/** The question's own breakpoint, by the id the scripted browser gives it. */
const questionId = (sessionId: string | undefined): string => `ask-${sessionId}`;

function defaultAnswer(frame: Frame): Answer {
  if (frame.method === "Target.attachToTarget") return { sessionId: "page-session" };
  if (frame.method === "Debugger.setInstrumentationBreakpoint") return { breakpointId: `bp-${frame.sessionId}` };
  // A worker that has compiled nothing: the question resolves nowhere.
  if (frame.method === "Debugger.setBreakpointByUrl") return { breakpointId: questionId(frame.sessionId), locations: [] };
  if (frame.method === "Runtime.evaluate") return { result: { type: "boolean", value: true } };
  if (frame.method === "Runtime.getIsolateId") return { id: `isolate-${frame.sessionId}` };
  return {};
}

/** The real thread program, in this thread, over a socket the scripted browser answers in order. */
async function scriptedAttacher(
  t: TestContext,
  respond: (frame: Frame, browser: ScriptedBrowser) => Answer = defaultAnswer,
  options: { holdTimeoutMs?: number; commandTimeoutMs?: number } = {}
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
      ...(options.holdTimeoutMs !== undefined ? { holdTimeoutMs: options.holdTimeoutMs } : {}),
      ...(options.commandTimeoutMs !== undefined ? { commandTimeoutMs: options.commandTimeoutMs } : {})
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

test("the attach step sets the breakpoint, asks which scripts exist, then releases the start-up hold, on the worker's own session, takes the question away when it answers, and sends nothing else before a pause", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => visit.workers().length === 1 && browser.commands("sw-1").length === ATTACH_STEP);
  // Four commands in the attach event's own step, in this order: the
  // question behind the breakpoint, the release behind both. The fifth
  // follows the question's answer.
  assert.deepEqual(browser.commands("sw-1"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Debugger.setBreakpointByUrl",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.removeBreakpoint"
  ]);
  assert.deepEqual(
    browser.sent.find((frame) => frame.method === "Debugger.setInstrumentationBreakpoint")?.params,
    { instrumentation: "beforeScriptExecution" }
  );
  // Every script's first line, and a condition that is never true: the
  // question lists where it resolved and can pause nothing.
  assert.deepEqual(browser.frame("sw-1", "Debugger.setBreakpointByUrl").params, { urlRegex: ".*", lineNumber: 0, condition: "false" });
  assert.deepEqual(browser.frame("sw-1", "Debugger.removeBreakpoint").params, { breakpointId: questionId("sw-1") });
  assert.deepEqual(browser.commands(undefined).slice(0, 1), ["Target.setAutoAttach"]);
  assert.deepEqual(browser.sent[0].params, {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "shared_worker", exclude: false }, { exclude: true }]
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(browser.commands("sw-1").length, ATTACH_STEP, "no binding, no install and no probe before the main-script pause");
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(browser, "sw-1");
  await until(() => workerOf(visit, "sw-1").hold === "released");
  assert.deepEqual(browser.commands("sw-1"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Debugger.setBreakpointByUrl",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.removeBreakpoint",
    "Runtime.addBinding",
    "Runtime.evaluate",
    "Debugger.removeBreakpoint",
    "Debugger.disable"
  ]);
  const onSession = browser.sent.filter((frame) => frame.sessionId === "sw-1");
  assert.deepEqual(onSession[ATTACH_STEP].params, { name: installer.sinkName });
  assert.deepEqual(onSession[ATTACH_STEP + 1].params, {
    expression: fingerprintObserverWorkerInstallExpression("127.0.0.1", installer, "shared-worker"),
    returnByValue: true
  });
  assert.deepEqual(onSession[ATTACH_STEP + 2].params, { breakpointId: "bp-sw-1" });
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(browser, "sw-1");
  await until(() => workerOf(visit, "sw-1").hold === "released");
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 1, lateWorkerCount: 0 });
});

test("a first pause at another script is a late attach: nothing is installed and the debugger goes off at once", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t);
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "sw-1");
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(browser, "sw-1", `${ORIGIN}/imported-first.js`);
  await until(() => workerOf(visit, "sw-1").hold === "late");
  await until(() => browser.commands("sw-1").length === ATTACH_STEP + 2);
  assert.deepEqual(browser.commands("sw-1").slice(ATTACH_STEP), ["Debugger.removeBreakpoint", "Debugger.disable"]);
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(browser, "sw-1");
  await until(() => browser.commands("sw-1").includes("Runtime.evaluate"));
  browser.emit("Debugger.resumed", {}, "sw-1");
  await until(() => holdOf(visit, "sw-1") === "late");
  await until(() => browser.commands("sw-1").includes("Debugger.disable"));
  assert.deepEqual(browser.commands("sw-1"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Debugger.setBreakpointByUrl",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.removeBreakpoint",
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
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
 * A parse heard ahead of the breakpoint's answer (a script compiled before the
 * breakpoint was surely set) gets one probe on the worker's session: no pause
 * ahead of the probe's answer means the script ran, and a pause ahead of it
 * is a hold. A parse heard behind the answer sends no probe: by itself it
 * says nothing, since a browser may hold a parse back (Chromium 158), and
 * here the question listed no script, so the breakpoint was set before this
 * one compiled and its pause follows.
 */
test("a main script parsed before the breakpoint's answer with no pause ahead of the probe's answer was reached late; a pause ahead of it, or a parse behind the answer with no script listed, is a hold", async (t) => {
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
  // The probe goes out on the breakpoint's answer, ahead of the question's
  // answer and so of the question's removal; then the breakpoint's removal
  // and the debugger off.
  await until(() => browser.commands("ran").length === ATTACH_STEP + 3);
  assert.deepEqual(browser.commands("ran").slice(4), [
    "Runtime.getIsolateId",
    "Debugger.removeBreakpoint",
    "Debugger.removeBreakpoint",
    "Debugger.disable"
  ]);
  assert.deepEqual(
    browser.sent.filter((frame) => frame.sessionId === "ran" && frame.method === "Debugger.removeBreakpoint").map((frame) => frame.params.breakpointId),
    [questionId("ran"), "bp-ran"]
  );

  sharedAttach(browser, "paused-ahead");
  await until(() => holdOf(visit, "paused-ahead") === "released");
  assert.equal(workerOf(visit, "paused-ahead").lateReason, null);

  sharedAttach(browser, "parsed-after");
  await until(() => browser.commands("parsed-after").length === ATTACH_STEP);
  await new Promise((resolve) => setTimeout(resolve, 10));
  mainScriptPause(browser, "parsed-after");
  await until(() => workerOf(visit, "parsed-after").hold === "released");
  assert.equal(browser.commands("parsed-after").includes("Runtime.getIsolateId"), false, "no probe after a parse behind the answer when no script was listed");
});

/**
 * The question behind the breakpoint. Its answer lists every script the
 * worker had compiled by then, whatever the browser did with those scripts'
 * parse reports: Chromium 158 holds a parse back until the worker next
 * returns to its message loop or pauses, so a script that was already
 * running when the breakpoint went in is heard parsed behind the
 * breakpoint's answer, or never. A script listed sets what an early parse
 * sets, and the same probe decides.
 */
function questionLists(count: number, sessions: readonly string[]): (frame: Frame, browser: ScriptedBrowser) => Answer {
  return (frame) =>
    frame.method === "Debugger.setBreakpointByUrl" && sessions.includes(frame.sessionId ?? "")
      ? {
          breakpointId: questionId(frame.sessionId),
          locations: Array.from({ length: count }, (_, at) => ({ scriptId: String(3 + at), lineNumber: 0, columnNumber: 0 }))
        }
      : defaultAnswer(frame);
}

test("a script the question lists, and a probe answered with no pause ahead of it, is a worker reached late, whether its parse is heard behind the answers or never", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t, questionLists(1, ["parse-behind", "parse-never"]));
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);

  // Chromium 158's order for a worker reached while its script runs: both
  // answers, and the parse when the script's task ends.
  sharedAttach(browser, "parse-behind");
  await until(() => holdOf(visit, "parse-behind") === "late");
  browser.emit("Debugger.scriptParsed", { scriptId: "3", url: MAIN_URL }, "parse-behind");
  assert.equal(workerOf(visit, "parse-behind").lateReason, "ran-before-breakpoint");
  await until(() => browser.commands("parse-behind").includes("Debugger.disable"));
  assert.deepEqual(browser.commands("parse-behind"), [
    "Debugger.enable",
    "Debugger.setInstrumentationBreakpoint",
    "Debugger.setBreakpointByUrl",
    "Runtime.runIfWaitingForDebugger",
    "Debugger.removeBreakpoint",
    "Runtime.getIsolateId",
    "Debugger.removeBreakpoint",
    "Debugger.disable"
  ]);
  // A pause after it changes nothing, and nothing is installed.
  mainScriptPause(browser, "parse-behind");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workerOf(visit, "parse-behind").hold, "late");

  // The worker that ends in the task that held its parse: no parse at all.
  sharedAttach(browser, "parse-never");
  await until(() => holdOf(visit, "parse-never") === "late");
  assert.equal(workerOf(visit, "parse-never").lateReason, "ran-before-breakpoint");
  assert.deepEqual(changes, ["parse-behind:attached", "parse-behind:late", "parse-never:attached", "parse-never:late"]);
  assert.equal(browser.commands("parse-behind").includes("Runtime.evaluate"), false);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 0, installFailedWorkerCount: 0, lateWorkerCount: 2 });
});

test("a script the question lists and a main-script pause ahead of the probe's answer is a hold: the script compiled between the breakpoint and the question", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const listed = questionLists(1, ["between"]);
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Runtime.getIsolateId" && frame.sessionId === "between") {
      // The worker paused at its main script before the probe reached it.
      mainScriptPause(scripted, "between");
    }
    if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
    return listed(frame, scripted);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit, changes } = await registerVisit(attacher, installer);
  sharedAttach(browser, "between");
  await until(() => holdOf(visit, "between") === "released");
  assert.equal(browser.commands("between").includes("Runtime.getIsolateId"), true, "the listed script sent the probe");
  assert.equal(workerOf(visit, "between").lateReason, null);
  assert.deepEqual(changes, ["between:attached", "between:held", "between:installed", "between:released"]);
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0, lateWorkerCount: 0 });
});

test("a worker gone with a script listed and its probe unanswered is not one that ended unreached, though no parse of it was heard", async (t) => {
  const listed = questionLists(1, ["listed-gone"]);
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) =>
    frame.method === "Runtime.getIsolateId" ? "never" : listed(frame, scripted)
  );
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "listed-gone");
  await until(() => browser.commands("listed-gone").includes("Runtime.getIsolateId"));
  browser.emit("Target.detachedFromTarget", { sessionId: "listed-gone" });
  await until(() => workerOf(visit, "listed-gone").detached);
  const gone = workerOf(visit, "listed-gone");
  assert.equal(gone.hold, "pending");
  assert.equal(gone.endedUnreached, false, "the question found a script: it was reached, and it may have run");
  assert.equal(sharedWorkerEndedAtOnce(gone), false);

  // The same life with nothing listed is the worker never reached.
  sharedAttach(browser, "nothing-listed");
  await until(() => browser.commands("nothing-listed").length === ATTACH_STEP);
  browser.emit("Target.detachedFromTarget", { sessionId: "nothing-listed" });
  await until(() => workerOf(visit, "nothing-listed").detached);
  assert.equal(workerOf(visit, "nothing-listed").endedUnreached, true);
});

/**
 * A question that cannot say. Only an empty list shows that nothing was
 * compiled when the breakpoint went in. Refused, or answered with no list,
 * the question shows nothing of the kind, so the worker is taken as one that
 * may have had a script and the probe decides, as it does for a script
 * listed: late with no pause ahead of the probe's answer, a hold with the
 * main-script pause ahead of it. No worker is left waiting with the debugger
 * on for a pause that cannot come. What it was not told, the thread does not
 * say: such a worker gone before its probe answers is still one never
 * reached, since no script of it was seen or listed.
 */
const QUESTION_CANNOT_SAY: readonly { name: string; answer: (frame: Frame) => Answer; removal: boolean }[] = [
  { name: "refused", answer: () => new Error("Debugger agent is not enabled"), removal: false },
  { name: "answered with no list", answer: (frame) => ({ breakpointId: questionId(frame.sessionId) }), removal: true },
  { name: "answered with a list that is not an array", answer: (frame) => ({ breakpointId: questionId(frame.sessionId), locations: { length: 0 } }), removal: true },
  { name: "answered with nothing", answer: () => ({}), removal: false }
];

for (const failure of QUESTION_CANNOT_SAY) {
  test(`the question ${failure.name} cannot show that nothing was compiled, so the probe decides: late with no pause ahead of its answer, a hold with the main-script pause ahead of it`, async (t) => {
    let installer: FingerprintWorkerRealmInstaller | null = null;
    const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
      if (frame.method === "Debugger.setBreakpointByUrl") return failure.answer(frame);
      if (frame.method === "Runtime.getIsolateId" && frame.sessionId === "paused-ahead") mainScriptPause(scripted, "paused-ahead");
      if (frame.method === "Runtime.getIsolateId" && frame.sessionId === "gone") return "never";
      if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
      return defaultAnswer(frame);
    });
    installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
    const { visit } = await registerVisit(attacher, installer);

    sharedAttach(browser, "silent");
    await until(() => holdOf(visit, "silent") === "late");
    assert.equal(workerOf(visit, "silent").lateReason, "ran-before-breakpoint");
    await until(() => browser.commands("silent").includes("Debugger.disable"));
    assert.deepEqual(browser.commands("silent"), [
      "Debugger.enable",
      "Debugger.setInstrumentationBreakpoint",
      "Debugger.setBreakpointByUrl",
      "Runtime.runIfWaitingForDebugger",
      ...(failure.removal ? ["Debugger.removeBreakpoint"] : []),
      "Runtime.getIsolateId",
      "Debugger.removeBreakpoint",
      "Debugger.disable"
    ]);

    sharedAttach(browser, "paused-ahead");
    await until(() => holdOf(visit, "paused-ahead") === "released");
    assert.equal(workerOf(visit, "paused-ahead").lateReason, null);
    assert.equal(workerOf(visit, "paused-ahead").debuggerOffAtRelease, true);

    sharedAttach(browser, "gone");
    await until(() => browser.commands("gone").includes("Runtime.getIsolateId"));
    browser.emit("Target.detachedFromTarget", { sessionId: "gone" });
    await until(() => workerOf(visit, "gone").detached);
    assert.equal(workerOf(visit, "gone").endedUnreached, true, "no script of it was seen or listed");
    assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 1, installFailedWorkerCount: 0, lateWorkerCount: 1 });
  });
}

test("the question unanswered at the command's bound is a question that cannot say: a worker paused at its main script before the bound is held, and one still waiting at it is late by the probe", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(
    t,
    (frame, scripted) => {
      if (frame.method === "Debugger.setBreakpointByUrl") return "never";
      if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
      return defaultAnswer(frame);
    },
    { commandTimeoutMs: 250 }
  );
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);

  sharedAttach(browser, "in-time");
  await until(() => browser.commands("in-time").length === ATTACH_STEP - 1);
  mainScriptPause(browser, "in-time");
  await until(() => workerOf(visit, "in-time").hold === "released");
  assert.equal(browser.commands("in-time").includes("Runtime.getIsolateId"), false, "held before the question's bound: no probe");

  sharedAttach(browser, "waiting");
  await until(() => browser.commands("waiting").length === ATTACH_STEP - 1);
  assert.equal(workerOf(visit, "waiting").hold, "pending", "nothing is decided before the question's bound");
  await until(() => holdOf(visit, "waiting") === "late", 3_000);
  assert.equal(workerOf(visit, "waiting").lateReason, "ran-before-breakpoint");
  await until(() => browser.commands("waiting").includes("Debugger.disable"));
  assert.deepEqual(browser.commands("waiting").slice(ATTACH_STEP - 1), ["Runtime.getIsolateId", "Debugger.removeBreakpoint", "Debugger.disable"]);
  // The held worker's own question times out too, and changes nothing for it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(workerOf(visit, "in-time").hold, "released");
  assert.equal(browser.commands("in-time").includes("Runtime.getIsolateId"), false);
});

test("an empty list is the answer that shows nothing was compiled, with or without an id: no probe, and the main-script pause holds", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Debugger.setBreakpointByUrl" && frame.sessionId === "no-id") return { locations: [] };
    if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
    return defaultAnswer(frame);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  for (const [sessionId, attachStep] of [["no-id", ATTACH_STEP - 1], ["with-id", ATTACH_STEP]] as const) {
    sharedAttach(browser, sessionId);
    await until(() => browser.commands(sessionId).length === attachStep);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(browser.commands(sessionId).length, attachStep, "nothing more is sent: no probe, and no removal without an id");
    assert.equal(workerOf(visit, sessionId).hold, "pending");
    mainScriptPause(browser, sessionId);
    await until(() => workerOf(visit, sessionId).hold === "released");
    assert.equal(browser.commands(sessionId).includes("Runtime.getIsolateId"), false);
  }
});

test("the question's removal refused or never answered changes nothing: the hold ends with the debugger off, which clears every breakpoint", async (t) => {
  let installer: FingerprintWorkerRealmInstaller | null = null;
  const { browser, attacher } = await scriptedAttacher(t, (frame, scripted) => {
    if (frame.method === "Debugger.removeBreakpoint" && frame.params.breakpointId === questionId(frame.sessionId)) {
      return frame.sessionId === "refused" ? new Error("Breakpoint not found") : "never";
    }
    if (frame.method === "Runtime.evaluate" && installer) firstSnapshot(installer, frame.sessionId!, scripted);
    return defaultAnswer(frame);
  });
  installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  for (const sessionId of ["refused", "unanswered"]) {
    sharedAttach(browser, sessionId);
    await until(() => browser.commands(sessionId).length === ATTACH_STEP);
    mainScriptPause(browser, sessionId);
    await until(() => workerOf(visit, sessionId).hold === "released");
    // The last command on the session is the debugger off, behind the
    // breakpoint's own removal: nothing waited on the question's.
    assert.deepEqual(browser.commands(sessionId).slice(-2), ["Debugger.removeBreakpoint", "Debugger.disable"]);
    assert.equal(workerOf(visit, sessionId).debuggerOffAtRelease, true);
  }
  assert.deepEqual(installer.sharedInstallDiagnostics(), { installedWorkerCount: 2, installFailedWorkerCount: 0, lateWorkerCount: 0 });
});

test("a worker that detaches between the question and its answer is the worker never reached, and nothing is sent to it after", async (t) => {
  const { browser, attacher } = await scriptedAttacher(t, (frame) =>
    frame.method === "Debugger.setBreakpointByUrl" || frame.method === "Debugger.setInstrumentationBreakpoint" ? "never" : defaultAnswer(frame)
  );
  const installer = new FingerprintWorkerRealmInstaller("127.0.0.1");
  const { visit } = await registerVisit(attacher, installer);
  sharedAttach(browser, "gone-first");
  await until(() => browser.commands("gone-first").length === ATTACH_STEP - 1);
  browser.emit("Target.detachedFromTarget", { sessionId: "gone-first" });
  await until(() => workerOf(visit, "gone-first").detached);
  assert.equal(workerOf(visit, "gone-first").endedUnreached, true);
  // The question's answer arrives for a worker that has gone: with a script
  // listed, even. No removal and no probe follow it.
  browser.answer(browser.frame("gone-first", "Debugger.setInstrumentationBreakpoint"), { breakpointId: "bp-gone-first" });
  browser.answer(browser.frame("gone-first", "Debugger.setBreakpointByUrl"), {
    breakpointId: questionId("gone-first"),
    locations: [{ scriptId: "3", lineNumber: 0, columnNumber: 0 }]
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(browser.commands("gone-first").length, ATTACH_STEP - 1, "nothing is sent to a worker that has gone");
  const gone = workerOf(visit, "gone-first");
  assert.deepEqual([gone.hold, gone.endedUnreached], ["pending", true], "what the thread posted at the detach stands");
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
  await until(() => browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => browser.commands("dies-held").length === ATTACH_STEP);
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
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => held.browser.commands("sw-1").length === ATTACH_STEP);
  await until(() => holdOf(held.visit, "sw-1") === "pending");
  const pending = held.readout(1_000);
  setTimeout(() => mainScriptPause(held.browser, "sw-1"), 20);
  assert.deepEqual(sharedTerms(await pending), { attached: 1, pausedAtReadout: 1, unread: 0, readable: 0, unscoped: 0, endedAtOnce: 0 });

  const late = await scriptedSharedReadout(t);
  sharedAttach(late.browser, "sw-1");
  await until(() => late.browser.commands("sw-1").length === ATTACH_STEP);
  await until(() => holdOf(late.visit, "sw-1") === "pending");
  const lateReadout = late.readout(1_000);
  setTimeout(() => mainScriptPause(late.browser, "sw-1", `${ORIGIN}/other.js`), 20);
  assert.deepEqual(sharedTerms(await lateReadout), { attached: 1, attachedLate: 1, unread: 1, readable: 0, unscoped: 0, endedAtOnce: 0 });

  const silent = await scriptedSharedReadout(t);
  sharedAttach(silent.browser, "sw-1");
  await until(() => silent.browser.commands("sw-1").length === ATTACH_STEP);
  await until(() => holdOf(silent.visit, "sw-1") === "pending");
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
    await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
  await until(() => holdOf(realms.visit, "sw-1") === "pending");
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
  await until(() => realms.browser.commands("sw-0").length === ATTACH_STEP);
  // The thread's commands reach the scripted browser before its report of
  // the attach reaches the main thread: under load the readout could start
  // with no worker to wait for. The freeze needs the main thread to know it.
  await until(() => holdOf(realms.visit, "sw-0") === "pending");
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
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
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
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => holdOf(realms.visit, "sw-1") === "held");
  const started = Date.now();
  assert.deepEqual(sharedTerms(await realms.readout(80)), EXCLUDED_HELD);
  assert.ok(Date.now() - started >= 70, "the drain waited for the hold's next move until its bound");
  assert.equal(holdOf(realms.visit, "sw-1"), "held");
});

test("readout: a shared worker held at the freeze whose attacher's channel closes during the drain is unread, never excluded", async (t) => {
  // The channel's loss settles the drain, so the hold makes no further move
  // the readout can see: whether the hold the main thread last saw was still
  // in place is not known, and the loss itself releases the worker.
  const realms = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => holdOf(realms.visit, "sw-1") === "held");
  const pending = realms.readout(1_000);
  setTimeout(() => realms.visit.markLost(), 20);
  assert.deepEqual(sharedTerms(await pending), { attached: 1, channelLostAlive: 1, unread: 1, readable: 0, unscoped: 0, endedAtOnce: 0 });
  assert.equal(holdOf(realms.visit, "sw-1"), "held");
});

test("readout: a shared worker gone held with its install unanswered is unread, before the freeze or during the drain", async (t) => {
  // A hold another client broke resumes the worker, and that resume can be
  // overtaken by the detach: gone while the main thread still saw it held,
  // it may have run, so it is never excluded as having run nothing.
  const DIED_HELD = { attached: 1, diedHeld: 1, unread: 1, readable: 0, unscoped: 0, endedAtOnce: 0 };
  const before = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(before.browser, "loader-1");
  sharedAttach(before.browser, "sw-1");
  await until(() => before.browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(before.browser, "sw-1");
  await until(() => holdOf(before.visit, "sw-1") === "held");
  before.browser.emit("Target.detachedFromTarget", { sessionId: "sw-1" });
  await until(() => workerOf(before.visit, "sw-1").detached);
  assert.equal(workerOf(before.visit, "sw-1").detachedWhilePaused, true);
  assert.deepEqual(sharedTerms(await before.readout(20)), DIED_HELD);

  const during = await scriptedSharedReadout(t, heldWhileUnanswered);
  commitMainDocument(during.browser, "loader-1");
  sharedAttach(during.browser, "sw-2");
  await until(() => during.browser.commands("sw-2").length === ATTACH_STEP);
  mainScriptPause(during.browser, "sw-2");
  await until(() => holdOf(during.visit, "sw-2") === "held");
  const pending = during.readout(1_000);
  setTimeout(() => during.browser.emit("Target.detachedFromTarget", { sessionId: "sw-2" }), 20);
  assert.deepEqual(sharedTerms(await pending), DIED_HELD);
});

test("readout: a shared worker gone after its install answered, before the release's answer, is read from its stream", async (t) => {
  // The observer was installed while the worker was held, ahead of any
  // statement, and its first snapshot is in hand: the evidence is whole
  // whether or not the debugger's turning off let the worker run.
  const realms = await scriptedSharedReadout(t, (frame) => (frame.method === "Debugger.disable" ? "never" : defaultAnswer(frame)));
  const installer = realms.installer;
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").length === ATTACH_STEP);
  mainScriptPause(realms.browser, "sw-1");
  await until(() => realms.browser.commands("sw-1").includes("Debugger.disable"));
  await until(() => installer.sharedInstallDiagnostics().installedWorkerCount === 1);
  realms.browser.emit("Target.detachedFromTarget", { sessionId: "sw-1" });
  await until(() => workerOf(realms.visit, "sw-1").detached);
  const worker = workerOf(realms.visit, "sw-1");
  assert.deepEqual([worker.detachedWhilePaused, worker.hold, worker.released], [false, "released", true]);
  assert.deepEqual(sharedTerms(await realms.readout(20)), { attached: 1, readable: 1, unread: 0, unscoped: 0, endedAtOnce: 0 });
});

test("readout: a shared worker that ended at once is reported apart, and a lost attacher leaves its live workers unread", async (t) => {
  const realms = await scriptedSharedReadout(t);
  commitMainDocument(realms.browser, "loader-1");
  sharedAttach(realms.browser, "gone");
  realms.browser.emit("Target.detachedFromTarget", { sessionId: "gone" });
  sharedAttach(realms.browser, "live");
  await until(() => realms.browser.commands("live").length === ATTACH_STEP);
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

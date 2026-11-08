// Replays the traces of lib/fv-worker-model.ts through the real code: the attacher's thread
// over a scripted browser, the real mirror, the real installer and its real readout.
//
// All of this is one process: the thread's program runs in this thread over a stand-in socket and
// patched timers, and the port is a queue here. Nothing races. The socket delivers a frame when
// a trace says to, the port holds each report until a trace says to, the page's frame tree
// answers when a trace says to, and each bound fires when a trace says to. Each step ends with
// the loop run empty, so what a step did is all done before the next begins, and its results are
// compared with what the model said of that step. A real socket can hand the thread two frames
// in one task, which this cannot: lib/fv-worker-model.test.ts says what that moves.
//
// A mismatch is a counterexample by the property `replay-*`. Nothing about it says which layer
// is wrong: lib/fv-worker-model.test.ts holds the classifications.
import { createHook } from "node:async_hooks";
import { DedicatedWorkerAttachSession, type DevtoolsChannel, type DevtoolsEvent } from "./devtools-worker-channel";
import { holds } from "./finite-check";
import { MODEL_MAIN_DOCUMENT, MODEL_WORKER_URL, WORKER_TERMS, judged, judgedDedicated, snapshotText, type DedicatedProperty, type LandedWorker, type MirrorView, type Property, type Step } from "./fv-worker-model";
import type * as attacherModule from "./shared-worker-attacher";
import type { AttacherTransport, SharedWorkerVisitChannel } from "./shared-worker-attacher";
import type * as realmModule from "./worker-fingerprint-realm";
import type { WorkerFingerprintRealmReadout } from "./worker-fingerprint-realm";

export type AttacherModule = Pick<typeof attacherModule, "SharedWorkerAttacher" | "inProcessAttacherTransportForTests">;
export type RealmModule = Pick<typeof realmModule, "FingerprintWorkerRealmInstaller">;
export type Modules = { attacher: AttacherModule; realm: RealmModule };

/**
 * A variant's edit, kept out of the test's file, whose bytes name the thread's timer: scripts/unit-test-lanes.test.mjs takes
 * that word to mean a test waits on one, and this one waits on nothing, since the bound fires when a trace says to.
 */
export const A_DETACH_LEAVES_THE_HOLD_BOUND_RUNNING = {
  find: 'workers.delete(sessionId);\n        if (worker.watchdog !== null)\n            clearTimeout(worker.watchdog);\n        worker.watchdog = null;\n        post({\n            type: "detached",',
  replace: 'workers.delete(sessionId);\n        post({\n            type: "detached",'
};

const CONTEXT = "context-a";
const OTHER_SCRIPT = "http://site.test/imported.js";
/** Long enough to say a bound was asked for. Each bound is found by the step that set it, never by its length, and fires only when a trace says so. */
const A_BOUND_MS = 7_000;
/** A worker's life, by the thread's clock, either side of the ended-at-once bound. */
const QUICK_LIFE_MS = 1;
const LONG_LIFE_MS = 1_000;

const realSetImmediate = setImmediate;
const turn = () => new Promise<void>((resolve) => realSetImmediate(resolve));
/** Saved before any replay patches it, for the one self-test that sets a real timer on purpose. */
const realTimerFunction = setTimeout;

type Timer = { callback: () => void; ms: number; live: boolean; aCommand: boolean };

/**
 * The clock under a replay: no bound fires by itself, the thread's own clock reads what the trace
 * sets, and the loop is known to be empty, since every hop to the next task goes through here.
 */
export class ReplayClock {
  now = 1_000;
  lastCreated: Timer | null = null;
  private newBounds: Timer[] = [];
  private pendingHops = 0;

  /** Takes over the timer calls, the hop to the next task and the clock the code under replay reads. Returns how to give them back. */
  install(): () => void {
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { set: globals.setTimeout, clear: globals.clearTimeout, immediate: globals.setImmediate };
    const clock = performance as unknown as { now?: () => number };
    globals.setTimeout = (callback: () => void, ms: number) => {
      const timer: Timer = { callback, ms, live: true, aCommand: false };
      this.lastCreated = timer;
      this.newBounds.push(timer);
      return timer;
    };
    globals.clearTimeout = (timer: Timer | undefined) => {
      if (timer) timer.live = false;
    };
    globals.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      this.pendingHops += 1;
      return realSetImmediate(() => {
        this.pendingHops -= 1;
        callback(...args);
      });
    };
    clock.now = () => this.now;
    return () => {
      globals.setTimeout = saved.set;
      globals.clearTimeout = saved.clear;
      globals.setImmediate = saved.immediate;
      delete clock.now;
    };
  }

  /** Until nothing is left to run: promises at once, and what crosses a port however many hops it takes. */
  async quiet(): Promise<void> {
    do {
      await turn();
    } while (this.pendingHops > 0);
  }

  fire(timer: Timer | null | undefined): void {
    if (!timer || !timer.live) return;
    timer.live = false;
    timer.callback();
  }

  /** Forgets every bound set so far, so that the next read names what one step set. */
  mark(): void {
    this.newBounds = [];
  }

  /** The bound the step since `mark` set, by its role: the one timer no command answered for. */
  boundSinceMark(): Timer | null {
    return this.newBounds.find((timer) => !timer.aCommand && timer.live) ?? null;
  }
}

/**
 * Runs a replay under the clock, whatever becomes of it. Nothing under it may set a real timer:
 * every bound goes through the clock above, and a real one, however it was reached, is counted
 * when it is made, so that the replay fails at once and nothing waits on it. A hop to the next
 * task is no timer, and `quiet` takes those.
 */
export async function underReplayClock<T>(run: (clock: ReplayClock) => Promise<T>): Promise<T> {
  const clock = new ReplayClock();
  const restore = clock.install();
  let realTimers = 0;
  const watch = createHook({
    init: (_id, type) => {
      if (type === "Timeout") realTimers += 1;
    }
  });
  watch.enable();
  try {
    const result = await run(clock);
    holds("replay-sets-no-real-timer", realTimers === 0, () => ({ realTimers }));
    return result;
  } finally {
    watch.disable();
    restore();
  }
}

/** Sets one real timer and clears it at once: the self-test of the check above, and nothing else. */
export function aRealTimerSetAndCleared(): void {
  clearTimeout(realTimerFunction(() => undefined, 1));
}

type Frame = { id: number; method: string; params: Record<string, unknown>; sessionId?: string; timer: Timer | null; answered: boolean };

const sessionOf = (w: number) => `sw-${w}`;
const workerOf = (sessionId: unknown): number => (sessionId === "sw-1" ? 1 : 0);

/** A real report in the words a model's label uses. A reply names only its request, so the side that sent it says whose it is. */
function postOf(message: Record<string, unknown>, replyWorker: (requestId: unknown) => number): string {
  const w = workerOf(message.sessionId);
  switch (message.type) {
    case "attached":
      return `${w}:attached:${message.waitingForDebugger === true ? "waiting" : "running"}`;
    case "held":
      return `${w}:held`;
    case "late":
      return `${w}:late:${String(message.reason)}`;
    case "installed": {
      const answers = message.answers as { status: string; value?: { result?: { value?: unknown } } }[] | null;
      if (answers === null) return `${w}:installed:none`;
      return `${w}:installed:${answers.length === 2 && answers[1].status === "fulfilled" && answers[1].value?.result?.value === true ? "ok" : "bad"}`;
    }
    case "released":
      return `${w}:released:${message.debuggerOff === true ? "on" : "off"}`;
    case "detached": {
      if (message.diedWhileHeld === true) return `${w}:detached:held`;
      if (message.diedAfterInstall === true) return `${w}:detached:after-install`;
      if (message.endedUnreached === true) return `${w}:detached:unreached-${(message.lifetimeMs as number) <= QUICK_LIFE_MS ? "quick" : "long"}`;
      return `${w}:detached:other`;
    }
    case "event": {
      const event = message.event as DevtoolsEvent;
      const [, sequence, word] = String((event.params as { payload?: unknown }).payload).split("\n");
      return `${workerOf(event.sessionId)}:event:${sequence === "1" ? "first" : word}`;
    }
    case "reply":
      return `${replyWorker(message.requestId)}:reply:${typeof message.error === "string" ? "error" : "ok"}`;
    case "lost":
      return "0:lost";
    default:
      return `${w}:${String(message.type)}`;
  }
}

/** The name a model's port gives a report it carries. */
function portNameOf(post: string): string {
  const [w, kind, detail] = post.split(":");
  if (kind === "installed" || kind === "event" || kind === "reply") return `${w}:${kind}-${detail}`;
  if (kind === "detached") return `${w}:gone-${detail}`;
  return `${w}:${kind}`;
}

/** Commands in the words a label uses. One word stands for what the thread sends in one breath, and only for all of it. */
function sendsOf(frames: readonly Frame[], barriers: ReadonlySet<number>): string[] {
  const words: string[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame.sessionId === undefined) continue;
    const w = workerOf(frame.sessionId);
    const next = frames[index + 1]?.method;
    switch (frame.method) {
      case "Debugger.enable":
        if (next === "Debugger.setInstrumentationBreakpoint") {
          words.push(`${w}:arm`);
          index += 1;
        } else words.push(`${w}:enable-alone`);
        break;
      case "Runtime.runIfWaitingForDebugger":
        words.push(`${w}:run`);
        break;
      case "Runtime.addBinding":
        if (next === "Runtime.evaluate") {
          words.push(`${w}:install`);
          index += 1;
        } else words.push(`${w}:binding-alone`);
        break;
      case "Debugger.removeBreakpoint":
        if (next === "Debugger.disable") {
          words.push(`${w}:off+remove`);
          index += 1;
        } else words.push(`${w}:remove-alone`);
        break;
      case "Debugger.disable":
        words.push(`${w}:off`);
        break;
      case "Runtime.getIsolateId":
        words.push(`${w}:${barriers.has(frame.id) ? "barrier" : "probe"}`);
        break;
      default:
        words.push(`${w}:${frame.method}`);
    }
  }
  return words;
}

/** What each command the thread sends must ask, as lib/shared-worker-attacher.ts says it does. */
function paramsAreRight(frame: Frame, binding: { sinkName: string }): boolean {
  const asked = JSON.stringify(frame.params);
  switch (frame.method) {
    case "Debugger.setInstrumentationBreakpoint":
      return asked === JSON.stringify({ instrumentation: "beforeScriptExecution" });
    case "Debugger.removeBreakpoint":
      return asked === JSON.stringify({ breakpointId: `bp-${String(frame.sessionId)}` });
    case "Runtime.addBinding":
      return asked === JSON.stringify({ name: binding.sinkName });
    case "Runtime.evaluate":
      return (frame.params as { returnByValue?: unknown }).returnByValue === true && typeof (frame.params as { expression?: unknown }).expression === "string";
    case "Target.setAutoAttach":
      return asked === JSON.stringify({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "shared_worker", exclude: false }, { exclude: true }] });
    default:
      return asked === "{}" || frame.sessionId === undefined;
  }
}

const CAPABILITY_BYTES = new Uint8Array(24).fill(7);

/** The real thread over a scripted browser. What it posts stays here until someone takes it. */
export class ThreadSide {
  readonly transport: AttacherTransport;
  private readonly clock: ReplayClock;
  private socket: { onopen: (() => void) | null; onmessage: ((message: { data: string }) => void) | null; onclose: (() => void) | null; readyState: number };
  private readonly frames: Frame[] = [];
  private unseenFrames: Frame[] = [];
  private readonly barriers = new Set<number>();
  private readonly holdBounds = new Map<number, Timer | null>();
  private readonly attachedAt = new Map<number, number>();
  /** How many steps of a trace had what came out of them compared. */
  compared = 0;
  private readonly binding: { sinkName: string; capability: string };
  private passing = true;
  private listeners: Array<(message: unknown) => void> = [];
  private exitListeners: Array<(reason: string) => void> = [];
  /** Every report the thread has posted and no one has taken, in order. */
  port: Record<string, unknown>[] = [];
  private unseenPosts: Record<string, unknown>[] = [];
  private nextRequest = 900;
  private readonly requestWorkers = new Map<unknown, number>();
  barrierRequests: Record<string, unknown>[] = [];
  /** Each word the model drops that reached this thread, in order: what a check of them counts, kept here and not by the caller. */
  readonly droppedWordsHeard: string[] = [];

  constructor(clock: ReplayClock, attacher: AttacherModule, binding: { sinkName: string; capability: string }, options: { theThreadsOwnBounds?: boolean } = {}) {
    this.clock = clock;
    this.binding = binding;
    let made: ThreadSide["socket"] | null = null;
    class ScriptedSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((message: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        made = this;
      }
      send = (text: string): void => this.onSend(text);
      onSend: (text: string) => void = () => undefined;
      close(): void {
        this.readyState = 3;
      }
    }
    const globals = globalThis as unknown as { WebSocket: unknown };
    const saved = globals.WebSocket;
    globals.WebSocket = ScriptedSocket;
    try {
      this.transport = attacher.inProcessAttacherTransportForTests(options.theThreadsOwnBounds ? { webSocketUrl: "ws://127.0.0.1:9/replay" } : { webSocketUrl: "ws://127.0.0.1:9/replay", holdTimeoutMs: A_BOUND_MS, commandTimeoutMs: A_BOUND_MS });
    } finally {
      globals.WebSocket = saved;
    }
    this.socket = made as unknown as ThreadSide["socket"];
    (this.socket as unknown as ScriptedSocket).onSend = (text) => {
      const frame: Frame = { ...(JSON.parse(text) as Frame), timer: this.clock.lastCreated, answered: false };
      if (frame.timer) frame.timer.aCommand = true;
      this.frames.push(frame);
      this.unseenFrames.push(frame);
    };
    this.transport.onMessage((raw) => {
      const message = raw as Record<string, unknown>;
      if (this.passing) for (const listener of this.listeners) listener(message);
      else {
        this.port.push(message);
        this.unseenPosts.push(message);
      }
    });
    this.transport.onExit((reason) => {
      if (this.passing) for (const listener of this.exitListeners) listener(reason);
    });
  }

  /** The port as the main thread sees it: open while a visit registers, held once `holdPort` is called. */
  heldTransport(): AttacherTransport {
    return {
      postMessage: (message) => {
        if ((message as { type?: unknown }).type === "send" && !this.passing) this.barrierRequests.push(message as Record<string, unknown>);
        else this.transport.postMessage(message);
      },
      onMessage: (listener) => void this.listeners.push(listener),
      onExit: (listener) => void this.exitListeners.push(listener),
      terminate: () => this.transport.terminate()
    };
  }

  holdPort(): void {
    this.passing = false;
    this.unseenFrames = [];
    this.unseenPosts = [];
  }

  async open(): Promise<void> {
    await turn();
    this.socket.readyState = 1;
    this.socket.onopen?.();
    this.answerFirst(undefined, "Target.setAutoAttach", {});
    await this.clock.quiet();
    const autoAttach = this.frames.find((frame) => frame.method === "Target.setAutoAttach");
    holds("replay-the-thread-sends-what-the-model-says", autoAttach !== undefined && paramsAreRight(autoAttach, this.binding), () => ({ at: "the auto-attach", real: autoAttach?.params }));
  }

  async answerRegistration(): Promise<void> {
    await this.clock.quiet();
    this.answerFirst(undefined, "Target.attachToTarget", { sessionId: "page-session" });
    await this.clock.quiet();
    this.answerFirst("page-session", "Page.enable", {});
    await this.clock.quiet();
  }

  async commitMainDocument(): Promise<void> {
    const { frameId, loaderId, securityOrigin } = MODEL_MAIN_DOCUMENT;
    this.deliver({ method: "Page.frameNavigated", params: { frame: { id: frameId, loaderId, securityOrigin, url: `${securityOrigin}/` } }, sessionId: "page-session" });
    await this.clock.quiet();
  }

  /** Registers a visit straight on the thread, when no mirror is under test. */
  async registerAlone(): Promise<void> {
    this.transport.postMessage({ type: "register", contextId: CONTEXT, pageTargetId: "page-target", commands: [{ method: "Runtime.addBinding", params: { name: this.binding.sinkName } }, { method: "Runtime.evaluate", params: { expression: "true", returnByValue: true } }], attachStepDelayMs: 0, holdDelayMs: 0 });
    await this.answerRegistration();
    await this.commitMainDocument();
  }

  close(): void {
    this.passing = true;
    this.transport.terminate();
  }

  private deliver(frame: Record<string, unknown>): void {
    this.socket.onmessage?.({ data: JSON.stringify(frame) });
  }

  private answerFirst(sessionId: string | undefined, method: string, result: Record<string, unknown>): void {
    const frame = this.frames.find((candidate) => candidate.sessionId === sessionId && candidate.method === method && !candidate.answered);
    if (!frame) return;
    frame.answered = true;
    this.deliver({ id: frame.id, result });
  }

  private lastFrame(sessionId: string, method: string, which: (frame: Frame) => boolean = () => true): Frame | undefined {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame.sessionId === sessionId && frame.method === method && which(frame)) return frame;
    }
    return undefined;
  }

  private answer(frame: Frame | undefined, result: Record<string, unknown>): void {
    if (!frame) return;
    frame.answered = true;
    this.deliver({ id: frame.id, result });
  }

  private emitBinding(w: number, sequence: number, word: "open" | "closed"): void {
    const header = `${this.binding.capability}\n${sequence}\n${word}`;
    this.deliver({ method: "Runtime.bindingCalled", params: { name: this.binding.sinkName, payload: word === "closed" ? `${header}\n${snapshotText(sequence)}` : header }, sessionId: sessionOf(w) });
  }

  private act(name: string): void {
    const [kind, whichWorker, what, detail] = name.split(":");
    const w = Number(whichWorker);
    const sessionId = sessionOf(w);
    if (kind === "connection-closes") {
      this.socket.readyState = 3;
      this.socket.onclose?.();
    } else if (kind === "hold-bound") this.clock.fire(this.holdBounds.get(w));
    else if (kind === "off-bound") this.clock.fire(this.lastFrame(sessionId, "Debugger.disable")?.timer);
    else if (kind === "barrier-bound") this.clock.fire(this.lastFrame(sessionId, "Runtime.getIsolateId")?.timer);
    else if (kind === "thread-gets-barrier") this.transport.postMessage(this.requestFor(w));
    else if (kind === "hears") this.hears(w, what, detail);
    else throw new Error(`No such thread step: ${name}`);
  }

  private barrierRequest(w: number): Record<string, unknown> {
    this.nextRequest += 1;
    return { type: "send", requestId: this.nextRequest, contextId: CONTEXT, method: "Runtime.getIsolateId", sessionId: sessionOf(w) };
  }

  /** The barrier's request for this worker: the main thread's own if it sent one, else a stand-in's. */
  private requestFor(w: number): Record<string, unknown> {
    const index = this.barrierRequests.findIndex((request) => request.sessionId === sessionOf(w));
    const request = index === -1 ? this.barrierRequest(w) : (this.barrierRequests.splice(index, 1)[0] as Record<string, unknown>);
    this.requestWorkers.set(request.requestId, w);
    return request;
  }

  /** The report in the model's words. */
  wordOf(message: Record<string, unknown>): string {
    return postOf(message, (requestId) => this.requestWorkers.get(requestId) ?? -1);
  }

  /** A report the thread posted, handed over the port. */
  cross(message: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(message);
  }

  /** The thread is gone: the main thread hears that, and nothing it had queued arrives. */
  die(reason: string): void {
    this.port = [];
    for (const listener of this.exitListeners) listener(reason);
  }

  private hears(w: number, what: string, detail: string | undefined): void {
    const sessionId = sessionOf(w);
    const event = (method: string, params: Record<string, unknown>) => this.deliver({ method, params, sessionId });
    switch (what) {
      case "attach":
        this.attachedAt.set(w, this.clock.now);
        this.deliver({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { type: "shared_worker", targetId: `${sessionId}-target`, url: MODEL_WORKER_URL, browserContextId: CONTEXT }, waitingForDebugger: detail === "waiting" } });
        return;
      case "parsed":
        event("Debugger.scriptParsed", { scriptId: "3", url: MODEL_WORKER_URL });
        return;
      case "ack":
        this.answer(this.lastFrame(sessionId, "Debugger.setInstrumentationBreakpoint"), { breakpointId: `bp-${sessionId}` });
        return;
      case "pause-main":
        this.clock.mark();
        event("Debugger.paused", { reason: "instrumentation", data: { scriptId: "3", url: MODEL_WORKER_URL }, callFrames: [] });
        this.holdBounds.set(w, this.clock.boundSinceMark());
        return;
      case "pause-main-naming-only-its-script":
        this.clock.mark();
        event("Debugger.paused", { reason: "instrumentation", data: { scriptId: "3" }, callFrames: [] });
        this.holdBounds.set(w, this.clock.boundSinceMark());
        return;
      case "parsed-another-script":
        event("Debugger.scriptParsed", { scriptId: "9", url: OTHER_SCRIPT });
        return;
      case "pause-script":
        event("Debugger.paused", { reason: "instrumentation", data: { scriptId: "9", url: OTHER_SCRIPT }, callFrames: [] });
        return;
      case "pause-statement":
        event("Debugger.paused", { reason: "other", data: {}, callFrames: [] });
        return;
      case "resumed":
        event("Debugger.resumed", {});
        return;
      case "first":
        this.emitBinding(w, 1, "closed");
        return;
      case "open":
        this.emitBinding(w, 2, "open");
        return;
      case "closed":
        this.emitBinding(w, 3, "closed");
        return;
      case "install-ok":
      case "install-bad":
        this.answer(this.lastFrame(sessionId, "Runtime.addBinding"), {});
        this.answer(this.lastFrame(sessionId, "Runtime.evaluate"), { result: { type: "boolean", value: what === "install-ok" } });
        return;
      case "off-answer":
        this.answer(this.lastFrame(sessionId, "Debugger.disable"), {});
        return;
      case "probe-answer":
        // The probe and a barrier ask the same thing, so a probe's answer is to the thread's own question, never to a barrier.
        this.answer(this.lastFrame(sessionId, "Runtime.getIsolateId", (frame) => !this.barriers.has(frame.id)), { id: "isolate" });
        return;
      case "barrier-answer":
        this.answer(this.lastFrame(sessionId, "Runtime.getIsolateId"), { id: "isolate" });
        return;
      case "detach":
        this.clock.now = (this.attachedAt.get(w) ?? this.clock.now) + (detail === "quick" ? QUICK_LIFE_MS : LONG_LIFE_MS);
        this.deliver({ method: "Target.detachedFromTarget", params: { sessionId } });
        return;
      default:
        throw new Error(`No such word on a session: ${what}`);
    }
  }

  /** The step, then what it posted and sent, against the model's word. */
  async hear(step: Step, input: () => unknown): Promise<void> {
    const name = step.name.replace(/:@\d+$/, "");
    this.act(name);
    await this.clock.quiet();
    if (name.startsWith("thread-gets-barrier")) for (const frame of this.unseenFrames) if (frame.method === "Runtime.getIsolateId") this.barriers.add(frame.id);
    this.checkOutput(name, step.posts, step.sends, input);
  }

  private checkOutput(name: string, wantPosts: readonly string[], wantSends: readonly string[], input: () => unknown): void {
    const posts = this.unseenPosts.map((message) => this.wordOf(message));
    this.unseenPosts = [];
    const sends = sendsOf(this.unseenFrames, this.barriers);
    const wrong = this.unseenFrames.find((frame) => !paramsAreRight(frame, this.binding));
    this.unseenFrames = [];
    this.compared += 1;
    holds("replay-the-thread-sends-what-the-model-says", wrong === undefined, () => ({ at: name, method: wrong?.method, params: wrong?.params, trace: input() }));
    holds("replay-the-thread-posts-what-the-model-says", posts.join() === wantPosts.join(), () => ({ at: name, real: posts, model: wantPosts, trace: input() }));
    holds("replay-the-thread-sends-what-the-model-says", sends.join() === wantSends.join(), () => ({ at: name, real: sends, model: wantSends, trace: input() }));
  }

  /** A word the model drops, delivered and compared: nothing may come out but a late worker's own stream. */
  async hearDroppedWord(w: number, word: string, posts: readonly string[], input: () => unknown): Promise<void> {
    await this.hear({ name: `hears:${w}:${word}`, posts: [...posts], sends: [], ended: null }, input);
    this.droppedWordsHeard.push(word);
  }

  /** The step with no word on what comes out, for a variant that may leave the model's path. */
  async hearFreely(name: string): Promise<void> {
    this.act(name);
    await this.clock.quiet();
    this.unseenPosts = [];
    this.unseenFrames = [];
  }

  /** The barrier there and back, which the model takes as one step when the stream is not the question. */
  async barrierRoundTrip(w: number, input: () => unknown): Promise<void> {
    this.transport.postMessage(this.requestFor(w));
    await this.clock.quiet();
    for (const frame of this.unseenFrames) if (frame.method === "Runtime.getIsolateId") this.barriers.add(frame.id);
    this.checkOutput("barrier-round-trip", [], [`${w}:barrier`], input);
    this.answer(this.lastFrame(sessionOf(w), "Runtime.getIsolateId"), { id: "isolate" });
    await this.clock.quiet();
    this.checkOutput("barrier-round-trip", [`${w}:reply:ok`], [], input);
  }

  /** The length of the hold's bound, as asked of the clock when a pause set it. */
  holdBoundLength(w: number): number | null {
    return this.holdBounds.get(w)?.ms ?? null;
  }

  /** The hold's bound, fired whatever the thread did with it. A bound the thread cancelled does nothing. */
  async fireTheHoldBound(w: number, input: () => unknown): Promise<void> {
    this.clock.fire(this.holdBounds.get(w));
    await this.clock.quiet();
    this.checkOutput("the hold's bound", [], [], input);
  }

  /** A request of the main thread's that the thread must refuse, with nothing sent to the worker. */
  async asksForAnotherCommand(w: number, input: () => unknown): Promise<void> {
    this.transport.postMessage({ type: "send", requestId: 7, contextId: CONTEXT, method: "Runtime.evaluate", sessionId: sessionOf(w) });
    this.requestWorkers.set(7, w);
    await this.clock.quiet();
    this.checkOutput("a command no visit may send", [`${w}:reply:error`], [], input);
  }
}

/** What the mirror hears of a report, when no thread is under test, as the real thread words it: the whole replay holds the two to each other. */
function reportFor(name: string, requestFor: (w: number) => number, binding: { sinkName: string; capability: string }): Record<string, unknown> {
  const [whichWorker, kind] = name.split(":");
  const w = Number(whichWorker);
  const sessionId = sessionOf(w);
  const report = (type: string, rest: Record<string, unknown> = {}) => ({ type, contextId: CONTEXT, sessionId, ...rest });
  const answers = (value: boolean) => [{ status: "fulfilled", value: {} }, { status: "fulfilled", value: { result: { type: "boolean", value } } }];
  const gone = (diedWhileHeld: boolean, diedAfterInstall: boolean, endedUnreached: boolean, lifetimeMs: number) => report("detached", { lifetimeMs, diedWhileHeld, diedAfterInstall, endedUnreached });
  const event = (sequence: number, word: "open" | "closed") => {
    const header = `${binding.capability}\n${sequence}\n${word}`;
    return { type: "event", contextId: CONTEXT, event: { method: "Runtime.bindingCalled", params: { name: binding.sinkName, payload: word === "closed" ? `${header}\n${snapshotText(sequence)}` : header }, sessionId } };
  };
  switch (kind) {
    case "attached":
      return report("attached", { targetId: `${sessionId}-target`, url: MODEL_WORKER_URL, waitingForDebugger: true, attachedAt: 1_000, creationDocument: { ...MODEL_MAIN_DOCUMENT } });
    case "held":
      return report("held");
    case "installed-ok":
      return report("installed", { answers: answers(true), watchdog: false });
    case "installed-bad":
      return report("installed", { answers: answers(false), watchdog: false });
    case "installed-none":
      return report("installed", { answers: null, watchdog: true });
    case "late":
      return report("late", { reason: "resumed-while-held" });
    case "released":
      return report("released", { holdMs: 1, debuggerOff: true });
    case "gone-held":
      return gone(true, false, false, LONG_LIFE_MS);
    case "gone-after-install":
      return gone(false, true, false, LONG_LIFE_MS);
    case "gone-unreached-quick":
      return gone(false, false, true, QUICK_LIFE_MS);
    case "gone-unreached-long":
      return gone(false, false, true, LONG_LIFE_MS);
    case "gone-other":
      return gone(false, false, false, LONG_LIFE_MS);
    case "event-first":
      return event(1, "closed");
    case "event-open":
      return event(2, "open");
    case "event-closed":
      return event(3, "closed");
    case "reply-ok":
      return { type: "reply", requestId: requestFor(w), result: { id: "isolate" } };
    case "reply-error":
      return { type: "reply", requestId: requestFor(w), error: "Not a command this visit may send to this worker." };
    case "lost":
      return { type: "lost", reason: "The attacher's DevTools connection closed." };
    default:
      throw new Error(`No such report: ${name}`);
  }
}

/** The real mirror, installer, session and readout. Reports reach them when a trace says to. */
export class MainSide {
  private readonly clock: ReplayClock;
  private readonly handlers: Array<(event: DevtoolsEvent) => void> = [];
  private listener: (message: unknown) => void = () => undefined;
  private exitListener: (reason: string) => void = () => undefined;
  private readonly workerCount: number;
  private installer: InstanceType<RealmModule["FingerprintWorkerRealmInstaller"]>;
  private session: DedicatedWorkerAttachSession;
  private visit: SharedWorkerVisitChannel | null = null;
  private readout: WorkerFingerprintRealmReadout | null = null;
  private readonly barriers = new Map<number, number>();
  /** The frame tree the call asked for, unanswered: when it answers is the trace's to say. */
  private treesAnswer: (() => void) | null = null;
  private drainBound: Timer | null = null;
  /** The trace says the frame tree answers only behind the drain's end. */
  treesComeLate = false;
  /** How many steps of a trace the main thread heard. */
  heard = 0;
  /** How many times the real mirror or the real readout was held to the model's word. */
  checked = 0;
  /** How many of those were of a landing. */
  landingsChecked = 0;

  constructor(clock: ReplayClock, realm: RealmModule, workerCount: number) {
    this.clock = clock;
    this.workerCount = workerCount;
    this.installer = new realm.FingerprintWorkerRealmInstaller("site.test", { randomBytes: CAPABILITY_BYTES });
    const { frameId, loaderId, securityOrigin } = MODEL_MAIN_DOCUMENT;
    const scripted: DevtoolsChannel = {
      send: async (method) => {
        if (method === "Target.attachToTarget") return { sessionId: "page-on-channel" };
        if (method === "Page.getFrameTree") {
          return new Promise((resolve) => {
            this.treesAnswer = () => resolve({ frameTree: { frame: { id: frameId, loaderId, securityOrigin } } });
          });
        }
        return {};
      },
      onEvent: (handler) => void this.handlers.push(handler),
      onClose: () => undefined,
      close: () => undefined
    };
    this.session = new DedicatedWorkerAttachSession(scripted, [this.installer], { handshakeTimeoutMs: A_BOUND_MS });
  }

  get binding(): { sinkName: string; capability: string } {
    return { sinkName: this.installer.sinkName, capability: this.installer.capability };
  }

  /** The main thread's side over a transport: the thread's, or a stand-in that answers its starting words. */
  async open(attacher: AttacherModule, transport: AttacherTransport, thread: ThreadSide | null): Promise<void> {
    const opened = attacher.SharedWorkerAttacher.openOverTransportForTests(transport, { readyTimeoutMs: A_BOUND_MS, registerTimeoutMs: A_BOUND_MS });
    if (thread) await thread.open();
    const opener = await opened;
    await this.session.watchSharedWorkers(CONTEXT);
    await this.session.attachToPage("page-target");
    const registered = opener.register({
      browserContextId: CONTEXT,
      pageTargetId: "page-target",
      // The installer's own command list, with an expression that fits a test: the thread reads neither its text nor its meaning.
      installCommands: this.installer.sharedWorkerInstallCommands().map((command) => (command.method === "Runtime.evaluate" ? { method: command.method, params: { ...command.params, expression: "true" } } : command))
    });
    if (thread) await thread.answerRegistration();
    const visit = await registered;
    this.visit = visit;
    this.installer.watchSharedWorkers(visit);
    if (thread) await thread.commitMainDocument();
  }

  /** A stand-in for the thread: it starts, registers, and otherwise only keeps the barrier's requests. */
  aloneTransport(): AttacherTransport {
    return {
      postMessage: (raw) => {
        const message = raw as Record<string, unknown>;
        if (message.type === "register") queueMicrotask(() => this.listener({ type: "registered", contextId: CONTEXT, documentsWatched: true }));
        if (message.type === "send") this.barriers.set(workerOf(message.sessionId), message.requestId as number);
      },
      onMessage: (listener) => {
        this.listener = listener;
        queueMicrotask(() => listener({ type: "ready" }));
      },
      onExit: (listener) => {
        this.exitListener = listener;
      },
      terminate: () => undefined
    };
  }

  close(): void {
    this.session.close();
  }

  /** The frame tree answers. The readout classifies only behind this, whatever else it has waited for. */
  answerTrees(): void {
    this.treesAnswer?.();
    this.treesAnswer = null;
  }

  /** The port's report reaches the mirror. With no thread, it is worded here, and otherwise it is the thread's own. */
  async hearReport(name: string, real: Record<string, unknown> | null, deliverThrough: ((message: unknown) => void) | null): Promise<void> {
    this.heard += 1;
    const report = real ?? reportFor(name, (w) => this.barriers.get(w) ?? -1, this.binding);
    (deliverThrough ?? this.listener)(report);
    await this.clock.quiet();
  }

  /**
   * The frame tree answers at the call unless the trace says it comes late, so that with it in hand a drain
   * that ends too soon shows as a readout that ends too soon.
   */
  async freeze(): Promise<void> {
    this.heard += 1;
    this.clock.mark();
    void this.installer.readout({ session: this.session, witness: { count: () => 0 }, settleMs: A_BOUND_MS }).then((readout) => {
      this.readout = readout;
    });
    if (!this.treesComeLate) this.answerTrees();
    await this.clock.quiet();
    this.drainBound = this.clock.boundSinceMark();
  }

  async settleBound(): Promise<void> {
    this.heard += 1;
    this.clock.fire(this.drainBound);
    await this.clock.quiet();
  }

  async documentsAnswered(): Promise<void> {
    this.heard += 1;
    this.answerTrees();
    await this.clock.quiet();
  }

  async discover(w: number): Promise<void> {
    this.heard += 1;
    for (const handler of this.handlers) handler({ method: "Target.targetCreated", params: { targetInfo: { type: "shared_worker", targetId: `${sessionOf(w)}-target`, browserContextId: CONTEXT } } });
    await this.clock.quiet();
  }

  async threadDies(deliverThrough: ((reason: string) => void) | null): Promise<void> {
    this.heard += 1;
    (deliverThrough ?? this.exitListener)("The shared-worker attacher thread exited.");
    await this.clock.quiet();
  }

  /** The page's channel closes: nothing more of the page can be read, and a frame tree asked for after this comes back at once as none. */
  closeThePageChannel(): void {
    this.session.close();
  }

  /** A step of a trace that the main thread hears, with no thread under it. */
  async hearAlone(step: Step): Promise<void> {
    const name = step.name.replace(/:@\d+$/, "");
    const [kind, whichWorker] = name.split(":");
    if (kind === "mirror-hears") await this.hearReport(name.slice("mirror-hears:".length), null, null);
    else if (kind === "freeze") await this.freeze();
    else if (kind === "settle-bound") await this.settleBound();
    else if (kind === "discovered") await this.discover(Number(whichWorker));
    else if (kind === "thread-dies") await this.threadDies(null);
    else if (kind === "barrier-round-trip") await this.hearReport(`${whichWorker}:reply-ok`, null, null);
    else if (kind === "documents-answered") await this.documentsAnswered();
    else if (kind === "documents-late") this.heard += 1;
    else throw new Error(`No such main step: ${name}`);
  }

  /** The real mirror, held to what the model says it holds now. */
  checkMirror(expected: readonly MirrorView[], input: () => unknown): void {
    this.checked += 1;
    const workers = (this.visit as SharedWorkerVisitChannel).workers();
    const diagnostics = this.installer.sharedInstallDiagnostics();
    for (let w = 0; w < this.workerCount; w += 1) {
      const real = workers.find((worker) => worker.sessionId === sessionOf(w));
      const model = expected[w];
      const same = model.known ? real !== undefined && real.hold === model.hold && real.detached === model.detached && real.detachedWhilePaused === model.detachedWhilePaused && real.endedUnreached === model.endedUnreached : real === undefined;
      holds("replay-the-mirror-holds-what-the-model-says", same, () => ({ worker: w, real: real ? { hold: real.hold, detached: real.detached, detachedWhilePaused: real.detachedWhilePaused, endedUnreached: real.endedUnreached } : null, model, trace: input() }));
    }
    const count = (install: string) => expected.filter((view) => view.install === install).length;
    holds("replay-the-install-counts-what-the-model-says", diagnostics.installedWorkerCount === count("installed") && diagnostics.installFailedWorkerCount === count("failed") && diagnostics.lateWorkerCount === count("attached-late"), () => ({ real: diagnostics, model: expected, trace: input() }));
  }

  checkEnded(ended: boolean, input: () => unknown): void {
    holds("replay-the-drain-ends-where-the-model-says", (this.readout !== null) === ended, () => ({ real: this.readout !== null, model: ended, trace: input() }));
  }

  /**
   * The real readout's terms. First they are judged by the world's own facts, for the properties
   * the caller says must hold here, so that a variant that breaks one reports it. Then each is
   * held to the model's word.
   */
  checkLanding(everyWorld: readonly (readonly LandedWorker[])[], mustHold: ReadonlySet<Property>, input: () => unknown): void {
    this.checked += 1;
    this.landingsChecked += 1;
    const expected = everyWorld[0];
    const readout = this.readout;
    holds("replay-the-drain-ends-where-the-model-says", readout !== null, input);
    const real = readout as WorkerFingerprintRealmReadout;
    const shared = real.diagnostics.sharedWorkers as unknown as Record<string, number>;
    const reads = [...real.readableSnapshots, ...real.unscopedSnapshots];
    // The world's own facts, against the terms the real readout counted. With one worker its term is the one counted. With
    // more, a term the model gave no worker stands for the worker the model gave another. A worker the model lands nowhere
    // keeps that term here, whatever the real readout counted: only the comparisons below read the counts for it, and
    // they do not run once a required property is judged broken.
    for (const world of everyWorld) {
      const remaining = new Map([...WORKER_TERMS, "unattached"].map((term) => [term, shared[term]]));
      const remainingReads = [...reads];
      for (const worker of world) {
        let term = worker.term;
        if (term !== "nowhere" && (remaining.get(term) ?? 0) === 0) term = [...remaining].find(([, count]) => count > 0)?.[0] ?? "nowhere";
        if (term !== "nowhere") remaining.set(term, (remaining.get(term) as number) - 1);
        const read = term === "readable" || term === "ownerUnscoped" ? (remainingReads.shift() ?? null) : null;
        const readSeq = read === null ? 0 : (JSON.parse(read) as { seq: number }).seq;
        for (const property of judged({ ...worker, term, readSeq })) {
          if (mustHold.has(property)) holds(property, false, () => ({ real: term, readSeq, worker, trace: input() }));
        }
      }
    }
    const known = expected.filter(({ term }) => term !== "nowhere" && term !== "unattached").length;
    holds("every-worker-the-readout-heard-of-lands-in-one-term", shared.attached === known && WORKER_TERMS.reduce((sum, term) => sum + shared[term], 0) === known, () => ({ shared, expected, trace: input() }));
    const want = new Map<string, number>();
    const snapshots: string[] = [];
    for (const { term, readSeq } of expected) {
      if (term === "nowhere") continue;
      want.set(term, (want.get(term) ?? 0) + 1);
      if (readSeq !== 0) snapshots.push(snapshotText(readSeq));
    }
    for (const term of [...WORKER_TERMS, "unattached"]) holds("replay-the-real-readout-lands-where-the-model-says", shared[term] === (want.get(term) ?? 0), () => ({ term, real: shared[term], model: want.get(term) ?? 0, expected, trace: input() }));
    holds("replay-the-real-readout-lands-where-the-model-says", [...reads].sort().join() === snapshots.sort().join(), () => ({ real: reads, snapshots, trace: input() }));
    // An unread realm counted for each unread term, so that the published count follows the terms.
    const unread = ["installFailed", "attachedLate", "unreached", "cutOff", "streamBroken", "channelLostAlive", "diedHeld", "unattached"].reduce((sum, term) => sum + (want.get(term) ?? 0), 0);
    holds("replay-the-real-readout-lands-where-the-model-says", real.unreadRealms === unread, () => ({ real: real.unreadRealms, unread, trace: input() }));
    holds("replay-the-real-readout-lands-where-the-model-says", real.sharedWorkersEndedAtOnce === (want.get("endedAtOnce") ?? 0), () => ({ real: real.sharedWorkersEndedAtOnce, model: want.get("endedAtOnce") ?? 0, trace: input() }));
  }

  /** What the real readout ended with, for a trace written out by hand. */
  landed(): WorkerFingerprintRealmReadout | null {
    return this.readout;
  }
}


/** The steps that happen in the browser alone: nothing real hears them until what they emit is delivered. */
const WORLD_ONLY = new Set(["born", "other-release", "other-release-unheard", "starts-unreleased", "lands", "reaches-main", "reaches-dependency", "stops-at-statement", "stops-at-script", "evaluates-late", "emits", "ends"]);

/** The thread and the main thread at once, with the port between them held: one trace, step by step. */
export class WholeReplay {
  readonly thread: ThreadSide;
  readonly main: MainSide;

  private readonly clock: ReplayClock;

  private constructor(clock: ReplayClock, thread: ThreadSide, main: MainSide) {
    this.clock = clock;
    this.thread = thread;
    this.main = main;
  }

  static async open(clock: ReplayClock, modules: Modules, workerCount: number): Promise<WholeReplay> {
    const main = new MainSide(clock, modules.realm, workerCount);
    const thread = new ThreadSide(clock, modules.attacher, main.binding);
    await main.open(modules.attacher, thread.heldTransport(), thread);
    thread.holdPort();
    return new WholeReplay(clock, thread, main);
  }

  close(): void {
    this.thread.close();
    this.main.close();
  }

  /** Everything the thread has posted crosses the port, in order. */
  async crossEverything(): Promise<void> {
    for (const message of this.thread.port.splice(0)) {
      this.thread.cross(message);
      await this.clock.quiet();
    }
  }

  async step(step: Step, input: () => unknown): Promise<void> {
    const parts = step.name.split(":");
    const [kind] = parts;
    if (WORLD_ONLY.has(kind)) return;
    if (kind === "mirror-hears") {
      const index = parts[parts.length - 1].startsWith("@") ? Number((parts.pop() as string).slice(1)) : 0;
      const expected = `${parts[1]}:${parts[2]}`;
      const message = this.thread.port[index];
      const word = message ? portNameOf(this.thread.wordOf(message)) : null;
      holds("replay-the-port-carries-what-the-model-says", word === expected, () => ({ at: step.name, real: word, model: expected, trace: input() }));
      // The report the main side's own replay words itself, held to the thread's real one.
      const worded = shapeOf(reportFor(expected, () => message.requestId as number, this.main.binding));
      holds("replay-the-port-carries-what-the-model-says", worded === shapeOf(message), () => ({ at: step.name, real: shapeOf(message), worded, trace: input() }));
      this.thread.port.splice(index, 1);
      await this.main.hearReport(expected, message, (report) => this.thread.cross(report as Record<string, unknown>));
    } else if (kind === "freeze") await this.main.freeze();
    else if (kind === "settle-bound") await this.main.settleBound();
    else if (kind === "discovered") await this.main.discover(Number(parts[1]));
    else if (kind === "thread-dies") await this.main.threadDies((reason) => this.thread.die(reason));
    else if (kind === "documents-answered") await this.main.documentsAnswered();
    else if (kind === "documents-late") this.main.heard += 1;
    else if (kind === "barrier-round-trip") {
      await this.thread.barrierRoundTrip(Number(parts[1]), input);
      const reply = this.thread.port.shift() as Record<string, unknown>;
      await this.main.hearReport(`${parts[1]}:reply-ok`, reply, (report) => this.thread.cross(report as Record<string, unknown>));
    } else await this.thread.hear(step, input);
  }
}

/** A report's fields, with its values for fields that vary: what the main side's own wording has to match. */
function shapeOf(message: Record<string, unknown>): string {
  const varying = new Set(["attachedAt", "holdMs", "lifetimeMs", "reason", "debuggerOff", "waitingForDebugger", "error"]);
  const rest = Object.fromEntries(Object.entries(message).filter(([key]) => !varying.has(key)));
  return JSON.stringify(rest, (_key, value: unknown) => (typeof value === "string" && value.includes("\n") ? value.split("\n").slice(1).join("\n") : value));
}

/** One dedicated worker through the real session, installer and readout, over a channel that answers when a trace says to. */
export class DedicatedReplay {
  private readonly clock: ReplayClock;
  private readonly handlers: Array<(event: DevtoolsEvent) => void> = [];
  private readonly closers: Array<() => void> = [];
  private readonly held: { method: string; sessionId: string | undefined; resolve: (answer: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
  private readonly installer: InstanceType<RealmModule["FingerprintWorkerRealmInstaller"]>;
  private readonly session: DedicatedWorkerAttachSession;
  private readonly sessionClass: typeof DedicatedWorkerAttachSession;
  /** What the channel sent and told its installers, in order. */
  private readonly told: string[] = [];
  private pauseBound: Timer | null = null;
  private drainBound: Timer | null = null;
  private frozen = false;
  private closed = false;
  private readout: WorkerFingerprintRealmReadout | null = null;

  constructor(clock: ReplayClock, realm: RealmModule, sessionClass: typeof DedicatedWorkerAttachSession = DedicatedWorkerAttachSession) {
    this.clock = clock;
    this.sessionClass = sessionClass;
    this.installer = new realm.FingerprintWorkerRealmInstaller("site.test", { randomBytes: CAPABILITY_BYTES });
    const channel: DevtoolsChannel = {
      send: (method, _params, sessionId) => {
        if (method === "Runtime.runIfWaitingForDebugger") this.told.push("resume");
        if (this.closed) return Promise.reject(new Error("The channel is closed."));
        if (method === "Target.attachToTarget") return Promise.resolve({ sessionId: "page-on-channel" });
        if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "main-frame", loaderId: "loader-1", securityOrigin: "http://site.test" }, childFrames: [{ frame: { id: "owner-frame", loaderId: "owner-loader" } }] } });
        if (method === "Runtime.runIfWaitingForDebugger" || sessionId === "page-on-channel") return Promise.resolve({});
        if (method === "Runtime.getIsolateId" && !this.frozen) return Promise.resolve({});
        return new Promise((resolve, reject) => this.held.push({ method, sessionId, resolve, reject }));
      },
      onEvent: (handler) => void this.handlers.push(handler),
      onClose: (closer) => void this.closers.push(closer),
      close: () => undefined
    };
    // Beside the installer under test, an installer that only hears when the channel concludes a worker.
    const listener = { workerKinds: ["dedicated"] as const, install: async () => undefined, concluded: (_worker: unknown, how: string) => void this.told.push(`concluded:${how}`) };
    this.session = new this.sessionClass(channel, [this.installer, listener], { handshakeTimeoutMs: A_BOUND_MS });
  }

  async open(): Promise<void> {
    await this.session.attachToPage("page-target");
  }

  close(): void {
    this.session.close();
  }

  private emit(event: DevtoolsEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private answer(method: string, result: Record<string, unknown>): void {
    const index = this.held.findIndex((command) => command.method === method);
    if (index !== -1) this.held.splice(index, 1)[0].resolve(result);
  }

  async step(name: string): Promise<void> {
    const [kind, detail] = name.split(":");
    switch (kind) {
      case "hears-attach":
        this.clock.mark();
        this.emit({ method: "Target.attachedToTarget", sessionId: "page-on-channel", params: { sessionId: "dw-0", targetInfo: { type: "worker", targetId: "dw-0-target", parentFrameId: "owner-frame" }, waitingForDebugger: detail === "waiting" } });
        await this.clock.quiet();
        this.pauseBound = this.clock.boundSinceMark();
        return;
      case "hears-detach":
        this.emit({ method: "Target.detachedFromTarget", params: { sessionId: "dw-0" } });
        break;
      case "arm-answered":
        this.answer("Target.setAutoAttach", {});
        break;
      case "install-answered":
        this.answer("Runtime.addBinding", {});
        await this.clock.quiet();
        if (detail === "ok") this.emit({ method: "Runtime.bindingCalled", sessionId: "dw-0", params: { name: this.installer.sinkName, payload: `${this.installer.capability}\n1\nclosed\n${snapshotText(1)}` } });
        this.answer("Runtime.evaluate", { result: { type: "boolean", value: detail === "ok" } });
        break;
      case "pause-bound":
        this.clock.fire(this.pauseBound);
        break;
      case "barrier-answered":
        this.answer("Runtime.getIsolateId", {});
        break;
      case "channel-closes":
        this.closed = true;
        for (const command of this.held.splice(0)) command.reject(new Error("The channel is closed."));
        for (const closer of this.closers) closer();
        break;
      case "freeze":
        this.frozen = true;
        this.clock.mark();
        void this.installer.readout({ session: this.session, witness: { count: () => 0 }, settleMs: A_BOUND_MS }).then((readout) => {
          this.readout = readout;
        });
        await this.clock.quiet();
        this.drainBound = this.clock.boundSinceMark();
        return;
      case "settle-bound":
        this.clock.fire(this.drainBound);
        break;
      default:
        throw new Error(`No such dedicated step: ${name}`);
    }
    await this.clock.quiet();
  }

  /** The session's counts, the installer's, the channel's resume, and whether the readout has ended, against the model's word. */
  check(expected: { attached: number; installed: number; failed: number; resumed: boolean; ended: boolean }, input: () => unknown): void {
    const attached = this.session.attachCounts().attachedDedicatedWorkerCount;
    const diagnostics = this.installer.installDiagnostics();
    holds("replay-the-session-holds-what-the-model-says", attached === expected.attached && diagnostics.installedWorkerCount === expected.installed && diagnostics.installFailedWorkerCount === expected.failed, () => ({ real: { attached, ...diagnostics }, expected, trace: input() }));
    holds("replay-the-channel-resumes-where-the-model-says", this.told.includes("resume") === expected.resumed, () => ({ told: this.told, expected, trace: input() }));
    // The pause bound concludes every installer before its resume goes out; the flow's own end, after.
    const resume = this.told.indexOf("resume");
    const concluded = this.told.findIndex((word) => word.startsWith("concluded:"));
    if (resume !== -1 && concluded !== -1) {
      const bound = this.told[concluded] === "concluded:watchdog";
      holds("replay-the-channel-resumes-where-the-model-says", bound ? concluded < resume : resume < concluded, () => ({ told: this.told, trace: input() }));
    }
    holds("replay-the-drain-ends-where-the-model-says", (this.readout !== null) === expected.ended, () => ({ real: this.readout !== null, expected, trace: input() }));
  }

  /** The real readout's term, judged by the world's facts for what must hold, then held to the model's word, its snapshot and its unread count. */
  checkLanding(term: string, truths: readonly { ranAtFreeze: boolean; ranUnobserved: boolean; heldAtAttach: boolean }[], mustHold: ReadonlySet<DedicatedProperty>, input: () => unknown): void {
    const readout = this.readout as WorkerFingerprintRealmReadout;
    holds("replay-the-drain-ends-where-the-model-says", readout !== null, input);
    const diagnostics = readout.diagnostics as unknown as Record<string, number>;
    const terms = ["pausedAtReadout", "diedPaused", "ownerReplaced", "readable", "installFailed", "attachedLate", "cutOff", "streamBroken", "channelLostAlive", "ownerUnknown"];
    const real = terms.find((candidate) => diagnostics[candidate] > 0) ?? "nowhere";
    for (const truth of truths) {
      for (const property of judgedDedicated(real, truth)) {
        if (mustHold.has(property)) holds(property, false, () => ({ real, truth, trace: input() }));
      }
    }
    holds("replay-the-real-readout-lands-where-the-model-says", real === term && terms.reduce((sum, candidate) => sum + diagnostics[candidate], 0) === (term === "nowhere" ? 0 : 1), () => ({ real, model: term, diagnostics, trace: input() }));
    const readText = term === "readable" ? [snapshotText(1)] : [];
    const unscopedText = term === "ownerUnknown" ? [snapshotText(1)] : [];
    holds("replay-the-real-readout-lands-where-the-model-says", readout.readableSnapshots.join() === readText.join() && readout.unscopedSnapshots.join() === unscopedText.join(), () => ({ real: [readout.readableSnapshots, readout.unscopedSnapshots], term, trace: input() }));
    const unread = ["installFailed", "attachedLate", "cutOff", "streamBroken", "channelLostAlive"].includes(term) ? 1 : 0;
    holds("replay-the-real-readout-lands-where-the-model-says", readout.unreadRealms === unread, () => ({ real: readout.unreadRealms, unread, term, trace: input() }));
  }
}

import { Worker } from "node:worker_threads";
import type { AttachedWorker, DevtoolsChannel, DevtoolsEvent } from "./devtools-worker-channel";
import { SHARED_WORKER_ENDED_AT_ONCE_MS } from "./shared-worker-ended-at-once";

/**
 * The scanner's shared-worker attacher: one per shared browser, on a
 * worker_threads thread of its own, holding each shared worker of a scan's
 * browser context at its main script while the fingerprint observer is
 * installed, then letting it run (fingerprint-observer@10).
 *
 * WHY A HOLD AT THE MAIN SCRIPT, AND NOT AT THE START. Playwright's own
 * browser session auto-attaches every target and detaches each shared worker
 * at once, and that detach releases the worker's start-up hold whatever any
 * other client asked for. So a shared worker cannot be held at its start the
 * way the worker realm channel (lib/devtools-worker-channel.ts) holds a
 * dedicated one. It can be held a step later: in the attach event's own
 * synchronous step the thread turns on the debugger, sets an instrumentation
 * breakpoint before any script runs, and releases its own start-up hold at
 * once (keeping it deadlocked 198 of 200 concurrent loads in Step 0, since
 * Playwright's detach does not always release it). The worker then pauses
 * before its first script. Only a pause at the worker's own main script
 * (`targetInfo.url`) proves that none of its code ran before it: there the
 * thread runs the installer's commands, in order, on the worker's session,
 * removes the breakpoint and turns the debugger off, which resumes the worker.
 * No worker code runs with the debugger on after a hold, so no `debugger;`
 * statement can pause it.
 *
 * WHY A THREAD. Playwright's detach is processed on the scanner's main loop,
 * and so would a main-thread attacher's breakpoint be: under a busy main loop
 * (route decisions, CDP events) the worker started before the breakpoint
 * landed in 39.5% of loads in Step 0. Here a busy main loop cannot delay the
 * breakpoint, nor the install, nor the release: the thread does all three
 * itself, from the installer's commands, which the visit hands it when it
 * registers. The main thread only reads what the thread reports.
 *
 * A LOST RACE. A worker whose first pause is at another script, or not the
 * breakpoint's, or that is seen to have parsed its main script with the
 * breakpoint already set and no pause before a later answer on its session,
 * was reached late: its code ran before the observer could precede it. The
 * thread then sends the debugger off at once (markLate's `debuggerOn`),
 * installs nothing, and reports it late, so the readout counts it unread, as
 * it counts a dedicated worker attached late. The debugger is not off at
 * once, though: the disable lands a few milliseconds later, and until then
 * the worker's code runs with the debugger on, so a `debugger;` statement
 * there pauses it until it lands (about 1.7 ms, once, in impl/hold-rate).
 * Only a worker already running when it attached never has
 * the debugger on, since nothing is sent to it. A module worker with static
 * imports is always a lost race: its first script to run is a dependency,
 * never its main script.
 *
 * A BROKEN HOLD. Any client's release of a worker, `Runtime.runIfWaitingForDebugger`
 * or a waiting session's detach, also ends a pause the worker is in,
 * instrumentation pauses included. Playwright's detach can therefore reach a
 * worker the thread has just paused at its main script, and the worker then
 * runs that script with no observer: in 7 to 10% of loads of a trivial page
 * with an idle main loop, 2.5% of concurrent loaded ones and none of 200
 * single loaded ones (impl/hold-rate, 2026-10-28). A resume of a held worker,
 * or a pause at one of its statements, before every install command answered
 * is that case: the thread turns the debugger off at once and reports the
 * worker late, never installed or released, so the readout counts it unread.
 * Until the thread's `Debugger.disable` lands, a few milliseconds, the
 * worker's code runs with the debugger on, so a `debugger;` statement there
 * can pause it that long. A resume behind the answers is the hold's own end.
 *
 * SCOPE. The browser-level auto-attach reaches every shared worker of the
 * browser, a concurrent scan's included. Each visit registers its browser
 * context; a shared worker of a context no visit registered is detached in
 * its attach event's own step, and nothing else is sent to it: no debugger,
 * no breakpoint, no install. A registered visit only hears of, and can only
 * address, its own context's workers.
 *
 * OWNERSHIP. The thread also attaches each registered visit's page target on
 * its own connection and watches its main frame's commits, so the document
 * current when a shared worker attached is read from the same stream that
 * carried the attach, in the order the browser sent them, never by comparing
 * clocks across connections. The readout credits a shared worker to the
 * visit's main document only when that is the document at the freeze and the
 * worker's script origin is its origin (lib/worker-fingerprint-realm.ts).
 *
 * WORKERS THAT END AT ONCE. A shared worker the thread never reached (no
 * pause, and no script of it seen parsed) that ended within
 * SHARED_WORKER_ENDED_AT_ONCE_MS of its attach, by the thread's own receive
 * times, is reported apart from realms that ran unread: whether it ran any
 * code is not known.
 *
 * The thread's program is one self-contained function, serialized into the
 * thread: it reads nothing from this module, and names no module, import or
 * environment, so a bundler cannot rewrite it into something the thread does
 * not have. lib/shared-worker-attacher.test.ts holds the serialized text to
 * that.
 */

// The bound and the words that report it live in one dependency-free module
// the reader's bundles share (lib/shared-worker-ended-at-once.ts).
export { SHARED_WORKER_ENDED_AT_ONCE_MS };

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/** The bound on one hold, as the dedicated channel's watchdog bounds its pause. */
const DEFAULT_HOLD_TIMEOUT_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_REGISTER_TIMEOUT_MS = 5_000;
/** The only command the main thread may send to a shared worker: the readout's barrier. */
const MAIN_THREAD_COMMANDS: readonly string[] = ["Runtime.getIsolateId"];

/** One command the thread sends in a worker's main-script pause, in list order. */
export type SharedWorkerInstallCommand = Readonly<{ method: string; params: Record<string, unknown> }>;

/** One command's answer, settled, in the order the commands were sent. */
export type SettledCommandAnswer =
  | { readonly status: "fulfilled"; readonly value: Record<string, unknown> }
  | { readonly status: "rejected"; readonly reason: string };

/** The visit's main document when a shared worker attached, from the attacher's own connection. */
export type SharedWorkerCreationDocument = Readonly<{
  frameId: string;
  loaderId: string;
  securityOrigin: string | null;
}>;

/**
 * - `pending`: attached, breakpoint set or on its way, no pause yet;
 * - `held`: paused at its main script, the installer's commands running;
 * - `late`: its first pause was another script's, or it was seen running
 *   before any pause, or it was running when it attached, or its hold at its
 *   main script ended before the install answered;
 * - `released`: held at its main script, then let run with the debugger off.
 */
export type SharedWorkerHold = "pending" | "held" | "late" | "released";

/**
 * Why a shared worker was late. `resumed-while-held`: paused at its main
 * script, it was let run before the installer's commands answered, so its
 * main script ran with no observer. Any client's release quits a pause the
 * worker is in, instrumentation pauses included: Playwright's detach of the
 * worker, or this thread's own release when it reaches a worker another
 * client already let start.
 */
export type SharedWorkerLateReason =
  | "other-script"
  | "other-pause"
  | "ran-before-breakpoint"
  | "running-at-attach"
  | "resumed-while-held";

/** One shared worker of the visit's context, as the attacher reported it. */
export type AttachedSharedWorker = AttachedWorker & {
  readonly kind: "shared";
  readonly targetId: string;
  readonly url: string;
  readonly hold: SharedWorkerHold;
  /** Why it was late; null when it was not. */
  readonly lateReason: SharedWorkerLateReason | null;
  /** The thread's receive time of its attach, in the thread's own clock. */
  readonly attachedAt: number;
  /** Its lifetime by the thread's receive times of its attach and detach; null while attached. */
  readonly lifetimeMs: number | null;
  /** It ended, by the thread's receive times, before the thread saw a pause or a parsed script of it. */
  readonly endedUnreached: boolean;
  readonly creationDocument: SharedWorkerCreationDocument | null;
  /** From its main-script pause to the answer of the command that turned the debugger off; null if never held. */
  readonly holdMs: number | null;
  /** The debugger was turned off when it was let run after its hold. */
  readonly debuggerOffAtRelease: boolean | null;
};

export type SharedWorkerChange = "attached" | "held" | "installed" | "late" | "released" | "detached";

export type SharedWorkerChangeListener = (
  worker: AttachedSharedWorker,
  change: SharedWorkerChange,
  answers: readonly SettledCommandAnswer[] | null
) => void;

type AttacherThreadPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  close(): void;
};

type AttacherThreadData = {
  webSocketUrl: string;
  commandTimeoutMs: number;
  holdTimeoutMs: number;
};

/**
 * The attacher thread's whole program. Serialized and run with its port and
 * data as arguments; it must stay self-contained: globals only (WebSocket,
 * performance, timers, JSON), no reference to anything in this module.
 */
export function sharedWorkerAttacherThread(port: AttacherThreadPort, data: AttacherThreadData): void {
  type Answer = Record<string, unknown>;
  type PendingCommand = {
    resolve: (answer: Answer) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  type MainDocument = { frameId: string; loaderId: string; securityOrigin: string | null };
  type Visit = {
    contextId: string;
    commands: { method: string; params: Answer }[];
    attachStepDelayMs: number;
    holdDelayMs: number;
    pageSessionId: string | null;
    mainDocument: MainDocument | null;
    sessions: Set<string>;
  };
  type HeldWorker = {
    sessionId: string;
    contextId: string;
    url: string;
    attachedAt: number;
    hold: "pending" | "held" | "late" | "released";
    scripts: Map<string, string>;
    breakpointId: string | null;
    breakpointAcknowledged: boolean;
    /** Its main script was seen parsed before the breakpoint's answer: compiled before the breakpoint was surely set. */
    mainParsedBeforeBreakpoint: boolean;
    probeSent: boolean;
    watchdog: ReturnType<typeof setTimeout> | null;
    /** Every install command answered (or the watchdog let it run): from here a resume is the thread's own. */
    installConcluded: boolean;
  };

  const clock = () => performance.now();
  const pending = new Map<number, PendingCommand>();
  const visits = new Map<string, Visit>();
  const pageSessions = new Map<string, Visit>();
  const workers = new Map<string, HeldWorker>();
  let nextCommandId = 1;
  let ended = false;
  const socket = new WebSocket(data.webSocketUrl);

  const post = (message: Answer): void => {
    try {
      port.postMessage(message);
    } catch {
      // The main thread is gone; nothing reads this any more.
    }
  };

  const errorText = (error: unknown): string =>
    error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);

  // Each command is written to the socket synchronously, so commands sent in
  // one step reach the browser in the order they were sent.
  const send = (method: string, params: Answer, sessionId?: string): Promise<Answer> =>
    new Promise<Answer>((resolve, reject) => {
      if (ended || socket.readyState !== 1) {
        reject(new Error("The attacher's DevTools connection is closed."));
        return;
      }
      const id = nextCommandId;
      nextCommandId += 1;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`DevTools command timed out: ${method}`));
      }, data.commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    });

  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(new Error(reason));
    }
    pending.clear();
    for (const worker of workers.values()) {
      if (worker.watchdog !== null) clearTimeout(worker.watchdog);
    }
    workers.clear();
    post({ type: "lost", reason });
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    try {
      port.close();
    } catch {
      // Already closed.
    }
  };

  // Turning the debugger off resumes a paused worker and clears its
  // breakpoints; the breakpoint is removed first when its id is known.
  const turnDebuggerOff = (worker: HeldWorker): Promise<boolean> => {
    if (worker.breakpointId !== null) {
      send("Debugger.removeBreakpoint", { breakpointId: worker.breakpointId }, worker.sessionId).catch(() => undefined);
    }
    return send("Debugger.disable", {}, worker.sessionId).then(
      () => true,
      () => false
    );
  };

  const markLate = (worker: HeldWorker, reason: string, debuggerOn: boolean): void => {
    if (worker.hold !== "pending") return;
    worker.hold = "late";
    post({ type: "late", contextId: worker.contextId, sessionId: worker.sessionId, reason });
    if (debuggerOn) void turnDebuggerOff(worker);
  };

  // The worker emits the breakpoint's answer and its main script's parse on
  // its own session, in the order they happened. A parse after the answer
  // means the breakpoint was set before the script compiled, so its pause is
  // certain. A parse before it (a replay of a script already compiled when
  // the debugger came on, or one compiled while the breakpoint was on its
  // way) may have run unpaused: an answer on the worker's own session, sent
  // once both are in, arrives behind any pause the worker emitted before it,
  // and no pause by then means the main script ran.
  const probeIfParsed = (worker: HeldWorker): void => {
    if (worker.hold !== "pending" || !worker.mainParsedBeforeBreakpoint || !worker.breakpointAcknowledged || worker.probeSent) {
      return;
    }
    worker.probeSent = true;
    send("Runtime.getIsolateId", {}, worker.sessionId).then(
      () => markLate(worker, "ran-before-breakpoint", true),
      () => undefined
    );
  };

  // A hold the worker left before the install answered. Any client's release
  // quits a pause the worker is in, instrumentation pauses included:
  // Playwright's detach of the worker, or this thread's own release when it
  // reaches a worker another client already let start. The worker then ran
  // its main script with no observer, and the install evaluates only at its
  // next pause or task, so it was reached late: nothing is reported installed
  // or released, and the debugger goes off at once, so no later script or
  // `debugger;` statement of the worker can pause it. A resume after the last
  // answer comes behind it on the worker's session, with the observer already
  // in place, and is the thread's own release.
  const breakHold = (worker: HeldWorker): void => {
    if (worker.hold !== "held" || worker.installConcluded) return;
    worker.hold = "late";
    if (worker.watchdog !== null) clearTimeout(worker.watchdog);
    worker.watchdog = null;
    post({ type: "late", contextId: worker.contextId, sessionId: worker.sessionId, reason: "resumed-while-held" });
    void turnDebuggerOff(worker);
  };

  const holdAtMainScript = (worker: HeldWorker, pausedAt: number): void => {
    worker.hold = "held";
    post({ type: "held", contextId: worker.contextId, sessionId: worker.sessionId });
    const visit = visits.get(worker.contextId);
    const commands = visit ? visit.commands : [];
    let concluded = false;
    const conclude = (answers: Answer[] | null, watchdog: boolean): void => {
      // A broken hold (breakHold) already ended this worker's install.
      if (concluded || worker.hold !== "held") return;
      concluded = true;
      worker.installConcluded = true;
      if (worker.watchdog !== null) clearTimeout(worker.watchdog);
      worker.watchdog = null;
      // Reported while the worker is still paused: the debugger goes off,
      // and the worker runs, only after this.
      post({ type: "installed", contextId: worker.contextId, sessionId: worker.sessionId, answers, watchdog });
      void turnDebuggerOff(worker).then((debuggerOff) => {
        worker.hold = "released";
        post({
          type: "released",
          contextId: worker.contextId,
          sessionId: worker.sessionId,
          holdMs: clock() - pausedAt,
          debuggerOff
        });
      });
    };
    worker.watchdog = setTimeout(() => conclude(null, true), data.holdTimeoutMs);
    const install = (): void => {
      // Tests only: a broken hold can come before the install is sent.
      if (worker.hold !== "held") return;
      void Promise.all(
        commands.map((command) =>
          send(command.method, command.params, worker.sessionId).then(
            (value) => ({ status: "fulfilled", value }) as Answer,
            (error: unknown) => ({ status: "rejected", reason: errorText(error) }) as Answer
          )
        )
      ).then((answers) => conclude(answers, false));
    };
    const holdDelayMs = visit ? visit.holdDelayMs : 0;
    if (holdDelayMs > 0) setTimeout(install, holdDelayMs);
    else install();
  };

  const onAttached = (params: Answer, receivedAt: number): void => {
    const sessionId = params.sessionId;
    const info = params.targetInfo as Answer | undefined;
    if (typeof sessionId !== "string" || !info || info.type !== "shared_worker") return;
    const contextId = typeof info.browserContextId === "string" ? info.browserContextId : null;
    const visit = contextId === null ? undefined : visits.get(contextId);
    if (!visit || contextId === null) {
      // Another context's worker: detached in this same step, and nothing
      // else is ever sent to it.
      send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      post({ type: "foreign", browserContextId: contextId, targetId: info.targetId, detachSentAfterMs: clock() - receivedAt });
      return;
    }
    const worker: HeldWorker = {
      sessionId,
      contextId,
      url: typeof info.url === "string" ? info.url : "",
      attachedAt: receivedAt,
      hold: "pending",
      scripts: new Map(),
      breakpointId: null,
      breakpointAcknowledged: false,
      mainParsedBeforeBreakpoint: false,
      probeSent: false,
      watchdog: null,
      installConcluded: false
    };
    workers.set(sessionId, worker);
    visit.sessions.add(sessionId);
    const waitingForDebugger = params.waitingForDebugger === true;
    post({
      type: "attached",
      contextId,
      sessionId,
      targetId: typeof info.targetId === "string" ? info.targetId : "",
      url: worker.url,
      waitingForDebugger,
      attachedAt: receivedAt,
      creationDocument: visit.mainDocument
    });
    if (!waitingForDebugger) {
      // Already running when it attached: its main script ran before any
      // breakpoint could precede it, so nothing is sent to it.
      markLate(worker, "running-at-attach", false);
      return;
    }
    const setBreakpoint = (): void => {
      if (worker.hold !== "pending" || !workers.has(sessionId)) return;
      send("Debugger.enable", {}, sessionId).catch(() => undefined);
      send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, sessionId).then(
        (answer) => {
          if (typeof answer.breakpointId === "string") worker.breakpointId = answer.breakpointId;
          worker.breakpointAcknowledged = true;
          probeIfParsed(worker);
        },
        () => undefined
      );
    };
    if (visit.attachStepDelayMs > 0) {
      // Tests only: lose the race on purpose, releasing first and setting the
      // breakpoint after the worker has started.
      send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      setTimeout(setBreakpoint, visit.attachStepDelayMs);
      return;
    }
    // The breakpoint first, then the release, on the same session in one
    // step: the worker then pauses before its first script, whichever
    // client's release lets it start.
    setBreakpoint();
    send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
  };

  const onDetached = (params: Answer, receivedAt: number): void => {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    const visit = pageSessions.get(sessionId);
    if (visit) {
      // Its commits can no longer be seen, so no later worker gets a document.
      pageSessions.delete(sessionId);
      visit.pageSessionId = null;
      visit.mainDocument = null;
      post({ type: "page-lost", contextId: visit.contextId });
      return;
    }
    const worker = workers.get(sessionId);
    if (!worker) return;
    workers.delete(sessionId);
    if (worker.watchdog !== null) clearTimeout(worker.watchdog);
    worker.watchdog = null;
    post({
      type: "detached",
      contextId: worker.contextId,
      sessionId,
      lifetimeMs: receivedAt - worker.attachedAt,
      // Held with its install unanswered, whether it ran is not known: a hold
      // another client broke resumes it, and that resume can be overtaken by
      // the detach or never arrive. Held with its install answered, the
      // observer was in place before any statement it ran.
      diedWhileHeld: worker.hold === "held" && !worker.installConcluded,
      diedAfterInstall: worker.hold === "held" && worker.installConcluded,
      endedUnreached: worker.hold === "pending" && worker.scripts.size === 0
    });
  };

  const onFrameNavigated = (visit: Visit, params: Answer): void => {
    const frame = params.frame as Answer | undefined;
    // The main frame only: the one frame with no parent.
    if (!frame || frame.parentId !== undefined) return;
    if (typeof frame.id !== "string" || typeof frame.loaderId !== "string") return;
    visit.mainDocument = {
      frameId: frame.id,
      loaderId: frame.loaderId,
      securityOrigin: typeof frame.securityOrigin === "string" ? frame.securityOrigin : null
    };
  };

  const onEvent = (method: string, params: Answer, sessionId: string | undefined, receivedAt: number): void => {
    if (sessionId === undefined) {
      if (method === "Target.attachedToTarget") onAttached(params, receivedAt);
      else if (method === "Target.detachedFromTarget") onDetached(params, receivedAt);
      return;
    }
    const visit = pageSessions.get(sessionId);
    if (visit) {
      if (method === "Page.frameNavigated") onFrameNavigated(visit, params);
      return;
    }
    const worker = workers.get(sessionId);
    if (!worker) return;
    if (method === "Debugger.scriptParsed") {
      const scriptId = params.scriptId;
      const url = typeof params.url === "string" ? params.url : "";
      if (typeof scriptId === "string") worker.scripts.set(scriptId, url);
      if (url === worker.url && worker.hold === "pending" && !worker.breakpointAcknowledged) {
        worker.mainParsedBeforeBreakpoint = true;
        probeIfParsed(worker);
      }
      return;
    }
    if (method === "Debugger.resumed") {
      // While held, only another client's release resumes the worker before
      // the install answers (breakHold).
      breakHold(worker);
      return;
    }
    if (method === "Debugger.paused") {
      // A pause other than an instrumentation one while held means the
      // worker left its main-script pause and ran into a statement, as a
      // `debugger;` statement stops it: its hold was broken, even if its
      // resume was never seen.
      if (worker.hold === "held" && params.reason !== "instrumentation") {
        breakHold(worker);
        return;
      }
      // Only the first pause decides. A pause after a late classification is
      // resumed by the debugger going off.
      if (worker.hold !== "pending") return;
      const pauseData = (params.data ?? {}) as Answer;
      const scriptId = typeof pauseData.scriptId === "string" ? pauseData.scriptId : null;
      const url =
        typeof pauseData.url === "string" ? pauseData.url : scriptId !== null ? worker.scripts.get(scriptId) : undefined;
      if (params.reason === "instrumentation" && url === worker.url) {
        holdAtMainScript(worker, receivedAt);
      } else {
        markLate(worker, params.reason === "instrumentation" ? "other-script" : "other-pause", true);
      }
      return;
    }
    if (method === "Runtime.bindingCalled") {
      post({ type: "event", contextId: worker.contextId, event: { method, params, sessionId } });
    }
  };

  socket.onopen = () => {
    send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "shared_worker", exclude: false }, { exclude: true }]
    }).then(
      () => post({ type: "ready" }),
      () => end("The browser refused the shared-worker auto-attach.")
    );
  };
  socket.onmessage = (message: MessageEvent) => {
    const receivedAt = clock();
    let parsed: Answer;
    try {
      parsed = JSON.parse(String(message.data)) as Answer;
    } catch {
      return;
    }
    if (typeof parsed.id === "number") {
      const command = pending.get(parsed.id);
      if (!command) return;
      pending.delete(parsed.id);
      clearTimeout(command.timer);
      const failure = parsed.error as Answer | undefined;
      if (failure) {
        command.reject(new Error(typeof failure.message === "string" ? failure.message : "DevTools command failed."));
      } else {
        command.resolve((parsed.result as Answer | undefined) ?? {});
      }
      return;
    }
    if (typeof parsed.method !== "string") return;
    try {
      onEvent(
        parsed.method,
        (parsed.params as Answer | undefined) ?? {},
        typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        receivedAt
      );
    } catch {
      // One event's failure is its own; the stream keeps being read.
    }
  };
  socket.onclose = () => end("The attacher's DevTools connection closed.");
  socket.onerror = () => end("The attacher's DevTools connection failed.");

  port.on("message", (raw: unknown) => {
    const message = raw as Answer;
    if (!message || typeof message !== "object") return;
    if (message.type === "close") {
      end("The attacher was closed.");
      return;
    }
    const contextId = typeof message.contextId === "string" ? message.contextId : null;
    if (contextId === null) return;
    if (message.type === "register") {
      const visit: Visit = {
        contextId,
        commands: Array.isArray(message.commands) ? (message.commands as { method: string; params: Answer }[]) : [],
        attachStepDelayMs: typeof message.attachStepDelayMs === "number" ? message.attachStepDelayMs : 0,
        holdDelayMs: typeof message.holdDelayMs === "number" ? message.holdDelayMs : 0,
        pageSessionId: null,
        mainDocument: null,
        sessions: new Set()
      };
      // Registered at once, so a shared worker of the context that attaches
      // while the page is being attached is still held.
      visits.set(contextId, visit);
      send("Target.attachToTarget", { targetId: message.pageTargetId, flatten: true })
        .then((answer) => {
          const pageSessionId = answer.sessionId;
          if (typeof pageSessionId !== "string") throw new Error("The page could not be attached.");
          if (visits.get(contextId) !== visit) {
            send("Target.detachFromTarget", { sessionId: pageSessionId }).catch(() => undefined);
            throw new Error("The visit ended before its page was attached.");
          }
          visit.pageSessionId = pageSessionId;
          pageSessions.set(pageSessionId, visit);
          return send("Page.enable", {}, pageSessionId);
        })
        .then(
          () => post({ type: "registered", contextId, documentsWatched: true }),
          () => post({ type: "registered", contextId, documentsWatched: false })
        );
      return;
    }
    if (message.type === "unregister") {
      const visit = visits.get(contextId);
      if (!visit) return;
      visits.delete(contextId);
      for (const sessionId of visit.sessions) {
        const worker = workers.get(sessionId);
        if (!worker) continue;
        workers.delete(sessionId);
        if (worker.watchdog !== null) clearTimeout(worker.watchdog);
        // Detaching resumes a worker still held for this client.
        send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
      if (visit.pageSessionId !== null) {
        pageSessions.delete(visit.pageSessionId);
        send("Target.detachFromTarget", { sessionId: visit.pageSessionId }).catch(() => undefined);
      }
      return;
    }
    if (message.type === "send") {
      const requestId = message.requestId;
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
      const worker = workers.get(sessionId);
      const method = typeof message.method === "string" ? message.method : "";
      if (!worker || worker.contextId !== contextId || method !== "Runtime.getIsolateId") {
        post({ type: "reply", requestId, error: "Not a command this visit may send to this worker." });
        return;
      }
      send(method, {}, sessionId).then(
        (result) => post({ type: "reply", requestId, result }),
        (error: unknown) => post({ type: "reply", requestId, error: errorText(error) })
      );
    }
  });
}

/** The thread's source: its port and data come from worker_threads, by name, at run time. */
const ATTACHER_THREAD_SOURCE =
  'const { parentPort, workerData } = require("node:worker_threads");\n' +
  `(${sharedWorkerAttacherThread.toString()})(parentPort, workerData);\n`;

/** The serialized thread program, for the test that holds it self-contained. */
export function sharedWorkerAttacherThreadSource(): string {
  return ATTACHER_THREAD_SOURCE;
}

type MutableSharedWorker = { -readonly [Key in keyof AttachedSharedWorker]: AttachedSharedWorker[Key] };

type ThreadMessage = Record<string, unknown> & { type?: unknown };

/** How the main thread reaches the thread's program: a real thread in production. */
export type AttacherTransport = {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Once, when the program can no longer run, with why. */
  onExit(listener: (reason: string) => void): void;
  terminate(): void;
};

function threadTransport(data: AttacherThreadData): AttacherTransport {
  const thread = new Worker(ATTACHER_THREAD_SOURCE, { eval: true, workerData: data });
  // The scanner process must be free to exit with the thread still running.
  thread.unref();
  return {
    postMessage: (message) => thread.postMessage(message),
    onMessage: (listener) => {
      thread.on("message", listener);
    },
    onExit: (listener) => {
      thread.on("error", (error: unknown) => listener(error instanceof Error ? error.message : String(error)));
      thread.on("exit", () => listener("The shared-worker attacher thread exited."));
    },
    terminate: () => {
      void thread.terminate().catch(() => undefined);
    }
  };
}

/**
 * The same program in this thread, for unit tests that script the browser
 * under it with a WebSocket stand-in. Messages cross as JSON, one task
 * later, as structured clone and a real port would deliver them.
 */
export function inProcessAttacherTransportForTests(
  data: Partial<AttacherThreadData> & { webSocketUrl: string }
): AttacherTransport {
  const toMain: Array<(message: unknown) => void> = [];
  const toThread: Array<(message: unknown) => void> = [];
  const exits: Array<(reason: string) => void> = [];
  let closed = false;
  const cross = (listeners: Array<(message: unknown) => void>, message: unknown) => {
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    setImmediate(() => {
      for (const listener of listeners) listener(copy);
    });
  };
  sharedWorkerAttacherThread(
    {
      postMessage: (message) => {
        if (!closed) cross(toMain, message);
      },
      on: (_event, listener) => {
        toThread.push(listener);
      },
      close: () => {
        if (closed) return;
        closed = true;
        setImmediate(() => {
          for (const listener of exits) listener("The shared-worker attacher thread exited.");
        });
      }
    },
    {
      webSocketUrl: data.webSocketUrl,
      commandTimeoutMs: data.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      holdTimeoutMs: data.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS
    }
  );
  return {
    postMessage: (message) => {
      if (!closed) cross(toThread, message);
    },
    onMessage: (listener) => {
      toMain.push(listener);
    },
    onExit: (listener) => {
      exits.push(listener);
    },
    terminate: () => {
      if (closed) return;
      cross(toThread, { type: "close" });
    }
  };
}

export type SharedWorkerAttacherOptions = {
  commandTimeoutMs?: number;
  holdTimeoutMs?: number;
  readyTimeoutMs?: number;
  registerTimeoutMs?: number;
};

export type SharedWorkerRegistration = {
  browserContextId: string;
  /** The visit's page target, whose main-frame commits the thread watches. */
  pageTargetId: string;
  /** Sent in order in each held worker's main-script pause (lib/worker-fingerprint-realm.ts). */
  installCommands: readonly SharedWorkerInstallCommand[];
  /** Tests only: release at once and set the breakpoint this long after, losing the race on purpose. */
  attachStepDelayMsForTests?: number;
  /** Tests only: wait this long in each main-script pause before sending the install, so another client's release can land in it. */
  holdDelayMsForTests?: number;
};

/**
 * The main thread's side of the attacher: it starts the thread, registers
 * visits and routes the thread's reports to each visit's channel. One per
 * shared browser; it is lost when the browser's DevTools connection closes.
 */
export class SharedWorkerAttacher {
  private readonly thread: AttacherTransport;
  private readonly visits = new Map<string, SharedWorkerVisitChannel>();
  private readonly registrations = new Map<
    string,
    { resolve: (documentsWatched: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly replies = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly foreignDetaches: { browserContextId: string | null; targetId: unknown; detachSentAfterMs: number }[] = [];
  private nextRequestId = 1;
  private lostReason: string | null = null;
  private readonly registerTimeoutMs: number;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  /** Starts the thread and resolves once it holds the browser-level auto-attach. */
  static async open(webSocketUrl: string, options: SharedWorkerAttacherOptions = {}): Promise<SharedWorkerAttacher> {
    return SharedWorkerAttacher.start(
      threadTransport({
        webSocketUrl,
        commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        holdTimeoutMs: options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS
      }),
      options
    );
  }

  /** The same, over a transport a unit test made (inProcessAttacherTransportForTests). */
  static openOverTransportForTests(
    transport: AttacherTransport,
    options: SharedWorkerAttacherOptions = {}
  ): Promise<SharedWorkerAttacher> {
    return SharedWorkerAttacher.start(transport, options);
  }

  private static async start(transport: AttacherTransport, options: SharedWorkerAttacherOptions): Promise<SharedWorkerAttacher> {
    const attacher = new SharedWorkerAttacher(transport, options);
    const ready = new Promise<void>((resolve, reject) => {
      attacher.readyResolve = resolve;
      attacher.readyReject = reject;
    });
    const timer = setTimeout(
      () => attacher.fail("The shared-worker attacher did not start in time."),
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    );
    try {
      await ready;
    } catch (error) {
      attacher.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return attacher;
  }

  private constructor(transport: AttacherTransport, options: SharedWorkerAttacherOptions) {
    this.registerTimeoutMs = options.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
    this.thread = transport;
    this.thread.onMessage((message: unknown) => this.onThreadMessage(message as ThreadMessage));
    this.thread.onExit((reason) => this.fail(reason));
  }

  /** The thread or its DevTools connection is gone; nothing more can be held. */
  isLost(): boolean {
    return this.lostReason !== null;
  }

  /** Every other context's shared worker the thread detached at once, for the scope tests. */
  foreignDetachesForTests(): readonly { browserContextId: string | null; detachSentAfterMs: number }[] {
    return this.foreignDetaches.map(({ browserContextId, detachSentAfterMs }) => ({ browserContextId, detachSentAfterMs }));
  }

  /**
   * Registers a visit's browser context before its page navigates. Its shared
   * workers are held from the moment the thread hears of the registration;
   * this resolves once the thread also watches the page's commits, or found
   * it could not, in which case no shared worker of the visit is credited.
   */
  async register(registration: SharedWorkerRegistration): Promise<SharedWorkerVisitChannel> {
    if (this.lostReason !== null) throw new Error(this.lostReason);
    const contextId = registration.browserContextId;
    if (this.visits.has(contextId)) throw new Error("This browser context is already registered.");
    const visit = new SharedWorkerVisitChannel(contextId, this);
    this.visits.set(contextId, visit);
    const registered = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registrations.delete(contextId);
        reject(new Error("The shared-worker attacher did not register the visit in time."));
      }, this.registerTimeoutMs);
      this.registrations.set(contextId, { resolve, reject, timer });
    });
    this.thread.postMessage({
      type: "register",
      contextId,
      pageTargetId: registration.pageTargetId,
      commands: registration.installCommands.map((command) => ({ method: command.method, params: command.params })),
      attachStepDelayMs: registration.attachStepDelayMsForTests ?? 0,
      holdDelayMs: registration.holdDelayMsForTests ?? 0
    });
    try {
      visit.setDocumentsWatched(await registered);
    } catch (error) {
      visit.unregister();
      throw error;
    }
    return visit;
  }

  /** Stops the thread; every visit's channel is lost. Idempotent. */
  close(): void {
    if (this.lostReason === null) {
      try {
        this.thread.postMessage({ type: "close" });
      } catch {
        // Already gone.
      }
    }
    this.fail("The shared-worker attacher was closed.");
    this.thread.terminate();
  }

  /** @internal The visit channel's barrier, through the thread. */
  sendForVisit(contextId: string, method: string, sessionId: string): Promise<Record<string, unknown>> {
    if (this.lostReason !== null) return Promise.reject(new Error(this.lostReason));
    if (!MAIN_THREAD_COMMANDS.includes(method)) return Promise.reject(new Error(`${method} is not sent to a shared worker.`));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.replies.set(requestId, { resolve, reject });
      this.thread.postMessage({ type: "send", requestId, contextId, method, sessionId });
    });
  }

  /** @internal */
  unregisterVisit(contextId: string): void {
    if (this.visits.get(contextId) === undefined) return;
    this.visits.delete(contextId);
    const registration = this.registrations.get(contextId);
    if (registration) {
      this.registrations.delete(contextId);
      clearTimeout(registration.timer);
      registration.reject(new Error("The visit was unregistered."));
    }
    if (this.lostReason === null) this.thread.postMessage({ type: "unregister", contextId });
  }

  private fail(reason: string): void {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    this.readyReject?.(new Error(reason));
    this.readyReject = null;
    this.readyResolve = null;
    for (const registration of this.registrations.values()) {
      clearTimeout(registration.timer);
      registration.reject(new Error(reason));
    }
    this.registrations.clear();
    for (const reply of this.replies.values()) reply.reject(new Error(reason));
    this.replies.clear();
    for (const visit of this.visits.values()) visit.markLost();
  }

  private onThreadMessage(message: ThreadMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.type === "lost") {
      this.fail(typeof message.reason === "string" ? message.reason : "The shared-worker attacher was lost.");
      return;
    }
    if (message.type === "reply") {
      const requestId = typeof message.requestId === "number" ? message.requestId : -1;
      const reply = this.replies.get(requestId);
      if (!reply) return;
      this.replies.delete(requestId);
      if (typeof message.error === "string") reply.reject(new Error(message.error));
      else reply.resolve((message.result as Record<string, unknown> | undefined) ?? {});
      return;
    }
    if (message.type === "foreign") {
      this.foreignDetaches.push({
        browserContextId: typeof message.browserContextId === "string" ? message.browserContextId : null,
        targetId: message.targetId,
        detachSentAfterMs: typeof message.detachSentAfterMs === "number" ? message.detachSentAfterMs : Number.NaN
      });
      return;
    }
    const contextId = typeof message.contextId === "string" ? message.contextId : null;
    if (contextId === null) return;
    if (message.type === "registered") {
      const registration = this.registrations.get(contextId);
      if (!registration) return;
      this.registrations.delete(contextId);
      clearTimeout(registration.timer);
      registration.resolve(message.documentsWatched === true);
      return;
    }
    this.visits.get(contextId)?.onThreadReport(message);
  }
}

/**
 * One visit's side of the attacher: its own context's shared workers, a
 * DevTools channel through the thread for the readout's barrier and for the
 * stream the observer emits, and the changes each worker went through, in
 * the order the thread saw them.
 */
export class SharedWorkerVisitChannel {
  readonly browserContextId: string;
  /**
   * Events: each worker's `Runtime.bindingCalled`, and a
   * `Target.detachedFromTarget` when it goes away, recorded on the worker
   * before it is delivered. `send` reaches only the barrier command, on this
   * visit's own workers.
   */
  readonly channel: DevtoolsChannel;
  private readonly attacher: SharedWorkerAttacher;
  private readonly workersBySession = new Map<string, MutableSharedWorker>();
  private readonly listeners = new Set<SharedWorkerChangeListener>();
  private readonly eventHandlers = new Set<(event: DevtoolsEvent) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private lost = false;
  private documentsWatched = false;
  private pageLost = false;

  /** @internal Created by SharedWorkerAttacher.register. */
  constructor(browserContextId: string, attacher: SharedWorkerAttacher) {
    this.browserContextId = browserContextId;
    this.attacher = attacher;
    this.channel = {
      send: (method, _params, sessionId) =>
        typeof sessionId === "string"
          ? this.attacher.sendForVisit(this.browserContextId, method, sessionId)
          : Promise.reject(new Error("A shared worker command names its worker's session.")),
      onEvent: (handler) => {
        this.eventHandlers.add(handler);
      },
      onClose: (handler) => {
        this.closeHandlers.add(handler);
      },
      close: () => this.unregister()
    };
  }

  /** Every shared worker of the visit's context the thread reported, in attach order. */
  workers(): readonly AttachedSharedWorker[] {
    return [...this.workersBySession.values()];
  }

  /** The visit's main-frame commits were watched from registration, on the attacher's own connection, and still are. */
  watchesDocuments(): boolean {
    return this.documentsWatched && !this.pageLost;
  }

  /** The thread is gone, or the visit was unregistered: nothing more arrives. */
  isChannelLost(): boolean {
    return this.lost;
  }

  /** Workers held at their main script whose release has not been reported yet. */
  heldWorkerCount(): number {
    let held = 0;
    for (const worker of this.workersBySession.values()) if (worker.hold === "held" && !worker.detached) held += 1;
    return held;
  }

  onWorkerChange(listener: SharedWorkerChangeListener): void {
    this.listeners.add(listener);
  }

  /**
   * Ends the visit's registration: the thread detaches every worker of the
   * context still attached, which lets one still held run, and its page
   * session. Idempotent.
   */
  unregister(): void {
    this.attacher.unregisterVisit(this.browserContextId);
    this.markLost();
  }

  /** @internal */
  setDocumentsWatched(watched: boolean): void {
    this.documentsWatched = watched;
  }

  /** @internal */
  markLost(): void {
    if (this.lost) return;
    this.lost = true;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // Every other handler still hears it.
      }
    }
  }

  /** @internal One report from the thread, about this visit's context. */
  onThreadReport(message: ThreadMessage): void {
    if (this.lost) return;
    if (message.type === "page-lost") {
      this.pageLost = true;
      return;
    }
    if (message.type === "event") {
      const event = message.event as DevtoolsEvent | undefined;
      if (event && typeof event.method === "string") this.deliver(event);
      return;
    }
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
    if (sessionId === null) return;
    if (message.type === "attached") {
      if (this.workersBySession.has(sessionId)) return;
      const creation = message.creationDocument as SharedWorkerCreationDocument | null | undefined;
      const worker: MutableSharedWorker = {
        sessionId,
        kind: "shared",
        nested: false,
        arrivedOnSessionId: null,
        ownerFrameId: null,
        waitingForDebugger: message.waitingForDebugger === true,
        released: false,
        detached: false,
        detachedWhilePaused: false,
        targetId: typeof message.targetId === "string" ? message.targetId : "",
        url: typeof message.url === "string" ? message.url : "",
        hold: "pending",
        lateReason: null,
        attachedAt: typeof message.attachedAt === "number" ? message.attachedAt : Number.NaN,
        lifetimeMs: null,
        endedUnreached: false,
        // Only while the page's commits were watched from registration: a
        // document read on a stream that missed a commit could be stale.
        creationDocument: creation && this.watchesDocuments() ? { ...creation } : null,
        holdMs: null,
        debuggerOffAtRelease: null
      };
      this.workersBySession.set(sessionId, worker);
      this.announce(worker, "attached", null);
      return;
    }
    const worker = this.workersBySession.get(sessionId);
    if (!worker) return;
    // Late is terminal: nothing after it may present the worker as held,
    // installed or released, whatever order reports arrive in.
    if (worker.hold === "late" && (message.type === "held" || message.type === "installed" || message.type === "released")) {
      return;
    }
    switch (message.type) {
      case "held":
        worker.hold = "held";
        this.announce(worker, "held", null);
        return;
      case "installed": {
        const answers = Array.isArray(message.answers) ? (message.answers as SettledCommandAnswer[]) : null;
        this.announce(worker, "installed", message.watchdog === true ? null : answers);
        return;
      }
      case "late":
        if (worker.hold === "late") return;
        worker.hold = "late";
        worker.released = true;
        worker.lateReason =
          message.reason === "other-script" ||
          message.reason === "other-pause" ||
          message.reason === "ran-before-breakpoint" ||
          message.reason === "running-at-attach" ||
          message.reason === "resumed-while-held"
            ? message.reason
            : "other-pause";
        this.announce(worker, "late", null);
        return;
      case "released":
        worker.hold = "released";
        worker.released = true;
        worker.holdMs = typeof message.holdMs === "number" ? message.holdMs : null;
        worker.debuggerOffAtRelease = message.debuggerOff === true;
        this.announce(worker, "released", null);
        return;
      case "detached":
        worker.detached = true;
        worker.detachedWhilePaused = message.diedWhileHeld === true;
        if (message.diedAfterInstall === true && worker.hold === "held") {
          // Its install answered while it was held, and the debugger was on
          // its way off: the observer preceded any statement it ran, so it is
          // read as a released worker is, whether or not the release's
          // answer would have come.
          worker.hold = "released";
          worker.released = true;
        }
        worker.lifetimeMs = typeof message.lifetimeMs === "number" ? message.lifetimeMs : null;
        worker.endedUnreached = message.endedUnreached === true;
        this.announce(worker, "detached", null);
        // The channel's own bookkeeping comes first, as on the dedicated
        // channel: whoever hears the detach finds the worker already gone.
        this.deliver({ method: "Target.detachedFromTarget", params: { sessionId, targetId: worker.targetId } });
        return;
      default:
        return;
    }
  }

  private announce(
    worker: MutableSharedWorker,
    change: SharedWorkerChange,
    answers: readonly SettledCommandAnswer[] | null
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(worker, change, answers);
      } catch {
        // A listener's reading is its own.
      }
    }
  }

  private deliver(event: DevtoolsEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // A handler's reading is its own.
      }
    }
  }
}

/** Whether a worker ended at once: never reached, and gone within the bound of its attach. */
export function sharedWorkerEndedAtOnce(worker: AttachedSharedWorker): boolean {
  return (
    worker.detached &&
    worker.endedUnreached &&
    worker.lifetimeMs !== null &&
    worker.lifetimeMs <= SHARED_WORKER_ENDED_AT_ONCE_MS
  );
}

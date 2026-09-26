/**
 * The scanner's own DevTools channel into the measured page's workers, opened
 * in every scan arm.
 *
 * One attach: the client attaches to the measured page target only and turns
 * on paused auto-attach for that target's tree, recursively, so workers of
 * workers are covered too. One resume: each attached worker is held before its
 * first statement while the arm's installers run in order, and then released
 * exactly once. The installers are the only code that reaches a worker realm;
 * this module itself never evaluates anything inside one. Every arm installs
 * the fingerprint observer (lib/worker-fingerprint-realm.ts); in the GPC arm
 * the GPC installer (lib/gpc-worker-verification.ts) runs before it and
 * delivers and verifies the signal. A channel with no installers holds each
 * worker only for the recursion and the release. An installer that reads back
 * from the realms it installed into hears every event the channel receives and
 * the channel's close, and each attached worker says which session its attach
 * arrived on, which frame started it, and whether it went away while held.
 *
 * The pause is not the first one a worker sees. Playwright's own CDP layer
 * already auto-attaches every page and worker session paused and releases each
 * worker after its own setup, and a worker's first statement runs only once
 * every client holding it has released it. The channel lengthens that existing
 * hold; it does not introduce one.
 *
 * An installer runs in a realm whose global is only partly initialized. While
 * a worker is paused, reading a lazily initialized worker global (`self.location`
 * and similar) or creating a WebGL context crashes the renderer, which takes the
 * measured page and all its workers with it, in every arm. Nothing an installer
 * evaluates may do either at install time.
 *
 * Scope: the client attaches to one page target. Other pages in the browser,
 * including a concurrent scan's, are never attached.
 *
 * SharedWorker is outside the pause: Chromium does not auto-attach shared
 * workers from a page session, and a browser-wide auto-attach would pause the
 * workers of every page in the browser. A shared attach, if the browser ever
 * delivers one, is counted in its own column and runs the installers like a
 * dedicated one. The channel witnesses shared workers instead: browser-level
 * target discovery, filtered to shared workers, reports each one the scan's
 * browser context starts without attaching or pausing it
 * (`watchSharedWorkers`). Discovery rides this channel's socket, so a visit
 * without the channel witnesses none.
 *
 * Nested attaches are tagged. A worker whose attach event arrives on another
 * worker's session was started by that worker, not by a document, so the
 * page-side construction wrap (which runs only in document realms) never
 * counted it. lib/gpc-injection.ts nets constructions against page-level
 * attaches only; without the tag, a nested attach would offset a page-level
 * construction the channel never reached.
 */

/** One command step may not outlive this. */
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/**
 * Upper bound on how long one worker may stay paused for its installers. The
 * GPC handshake is three loopback round trips and the fingerprint observer's
 * install one evaluation of its serialized source, each normally single-digit
 * milliseconds; on expiry every installer is concluded and the worker is
 * force-released, never left paused.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
const DEVTOOLS_DISCOVERY_TIMEOUT_MS = 3_000;

export type DevtoolsEvent = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

/**
 * The transport seam. Production speaks the DevTools flat protocol over a
 * loopback WebSocket (`openDevtoolsBrowserChannel`); unit tests substitute a
 * scripted channel so every branch is reachable without a browser.
 */
export type DevtoolsChannel = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(handler: (event: DevtoolsEvent) => void): void;
  /** Once, when the transport closes, whether by close() or by the browser. */
  onClose(handler: () => void): void;
  close(): void;
};

/** One worker this channel attached, as installers see it. */
export type AttachedWorker = {
  readonly sessionId: string;
  readonly kind: "dedicated" | "shared";
  /** The attach arrived on another worker's session: a worker started it. */
  readonly nested: boolean;
  /** The session the attach arrived on: the page, an out-of-process frame, or the parent worker. */
  readonly arrivedOnSessionId: string | null;
  /** The attach's `targetInfo.parentFrameId`: the frame whose document started the worker, or its ancestor's. */
  readonly ownerFrameId: string | null;
  /** The attach said the worker is held before its first statement; false means it was already running. */
  readonly waitingForDebugger: boolean;
  /** This channel has sent the worker's one resume, from the flow or the watchdog. */
  readonly released: boolean;
  /** The browser detached the worker's target: the worker is gone. */
  readonly detached: boolean;
  /** The detach arrived before this channel sent the resume: the worker died paused and ran nothing. */
  readonly detachedWhilePaused: boolean;
};

/**
 * Why an installer's worker was concluded:
 * - `released`: every installer ran (or was skipped because the recursion
 *   could not be armed) and the one resume was sent;
 * - `watchdog`: the pause bound expired first, and the worker was released
 *   right after this conclusion;
 * - `settled`: a settle froze the accounting while the worker's pause was
 *   still unfinished.
 */
export type WorkerRealmConclusion = "released" | "watchdog" | "settled";

/**
 * One thing done inside a paused worker realm. The channel runs its installers
 * in list order inside the worker's single pause, then releases the worker
 * once. An installer never releases, and its failure is its own: a throw is
 * caught, and the next installer and the release still happen.
 */
export type WorkerRealmInstaller = {
  /**
   * Runs while the worker is paused. Skipped for every installer after the
   * watchdog released the worker, so nothing is installed into a running
   * realm.
   */
  install(worker: AttachedWorker, channel: DevtoolsChannel): Promise<void>;
  /**
   * Exactly once per attached worker, for every installer, whether or not its
   * install ran or finished. The watchdog calls it before it sends the
   * resume, so an install result arriving later can tell it came too late.
   */
  concluded(worker: AttachedWorker, how: WorkerRealmConclusion): void;
  /**
   * Every event the channel receives, after the channel's own bookkeeping for
   * it, for an installer that reads back from the realms it installed into.
   */
  onEvent?(event: DevtoolsEvent): void;
  /**
   * Once, when the channel is gone: closed by the scanner or by the browser.
   * Nothing a realm emits afterwards can arrive.
   */
  onChannelClosed?(): void;
};

export type WorkerAttachCounts = {
  /** Every dedicated worker this client attached, nested ones included. */
  attachedDedicatedWorkerCount: number;
  /** The subset of `attachedDedicatedWorkerCount` started by another worker. */
  attachedNestedDedicatedWorkerCount: number;
  attachedSharedWorkerCount: number;
};

/**
 * The browser-side witness: one count per dedicated worker Playwright's own
 * recursive auto-attach reports for the measured page (its page "worker"
 * event), nested ones included. Not a page binding, so the page can neither
 * call nor skip it.
 *
 * It lives outside the channel on purpose. The scanner creates and registers
 * it before the channel is established, so a failed establish or a dropped
 * channel cannot take its count with it, and every accounting that nets this
 * channel's attaches against the browser's record reads this one counter.
 */
export class DedicatedWorkerWitness {
  private observedDedicatedWorkerCount = 0;

  observe(): void {
    this.observedDedicatedWorkerCount += 1;
  }

  count(): number {
    return this.observedDedicatedWorkerCount;
  }
}

type AttachedWorkerRecord = {
  -readonly [Key in keyof AttachedWorker]: AttachedWorker[Key];
} & {
  /** Every installer has been concluded for this worker. */
  concluded: boolean;
};

export class DedicatedWorkerAttachSession {
  private readonly channel: DevtoolsChannel;
  private readonly installers: readonly WorkerRealmInstaller[];
  private readonly handshakeTimeoutMs: number;
  private readonly inFlight = new Set<Promise<void>>();
  /** Attached workers whose installers have not been concluded yet. */
  private readonly openWorkers = new Set<AttachedWorkerRecord>();
  /** Sessions of attached workers; an attach arriving on one is nested. */
  private readonly workerSessionIds = new Set<string>();
  /** Every attached worker by session, so a detach can be recorded on it. */
  private readonly workersBySession = new Map<string, AttachedWorkerRecord>();
  /** Sessions of attached out-of-process frame targets that have not detached. */
  private readonly frameTargetSessionIds = new Set<string>();
  private pageSessionId: string | null = null;
  /** The scan's browser context, whose shared workers discovery counts; null until watched. */
  private sharedWorkerContextId: string | null = null;
  /** Every shared worker target discovery reported in that context, by target id. */
  private readonly discoveredSharedWorkerTargetIds = new Set<string>();
  private attachedDedicatedWorkerCount = 0;
  private attachedNestedDedicatedWorkerCount = 0;
  private attachedSharedWorkerCount = 0;
  private closed = false;
  private channelLost = false;

  constructor(
    channel: DevtoolsChannel,
    installers: readonly WorkerRealmInstaller[],
    options: { handshakeTimeoutMs?: number } = {}
  ) {
    this.channel = channel;
    this.installers = [...installers];
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.channel.onEvent((event) => this.onChannelEvent(event));
    this.channel.onClose(() => this.markChannelLost());
  }

  /**
   * Attach to the measured page target and turn on paused auto-attach for its
   * target tree. Everything after this call is event-driven.
   */
  async attachToPage(pageTargetId: string): Promise<void> {
    const attached = await this.channel.send("Target.attachToTarget", {
      targetId: pageTargetId,
      flatten: true
    });
    const sessionId = attached.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("The worker realm channel could not attach to the measured page target.");
    }
    this.pageSessionId = sessionId;
    await this.enableAutoAttach(sessionId);
  }

  /**
   * Witness every shared worker the scan's browser context starts, from now
   * on: browser-level target discovery, filtered to shared workers, which
   * reports each target without attaching to it or pausing it. The filter on
   * the context keeps a concurrent scan's shared workers out, since the
   * browser is shared. Call before `attachToPage`, while the page has run
   * nothing.
   */
  async watchSharedWorkers(browserContextId: string): Promise<void> {
    this.sharedWorkerContextId = browserContextId;
    await this.channel.send("Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "shared_worker" }]
    });
  }

  /**
   * The shared workers discovery has reported in the scan's browser context
   * so far, each once whatever its later state. Visit-scoped: a shared worker
   * belongs to no one document, so none is excluded as a replaced document's.
   * It keeps its count after the channel closes, and counts nothing it could
   * not see while closed.
   */
  discoveredSharedWorkerCount(): number {
    return this.discoveredSharedWorkerTargetIds.size;
  }

  /** The channel is closed, by close() or by the browser; nothing more can arrive on it. */
  isChannelLost(): boolean {
    return this.channelLost;
  }

  /**
   * The measured page's current frame trees, read now: `Page.getFrameTree` on
   * the page target and on every out-of-process frame target still attached.
   * In-process frames, cross-site ones included when the browser keeps them in
   * process, are already in the page target's tree. Null when the channel is
   * lost or any of the reads fails, so a caller never takes a partial set of
   * trees for the whole page.
   */
  async currentFrameTrees(): Promise<unknown[] | null> {
    if (this.channelLost || this.pageSessionId === null) return null;
    const sessionIds = [this.pageSessionId, ...this.frameTargetSessionIds];
    try {
      const results = await Promise.all(
        sessionIds.map((sessionId) => this.channel.send("Page.getFrameTree", {}, sessionId))
      );
      return results.map((result) => result.frameTree);
    } catch {
      return null;
    }
  }

  attachCounts(): WorkerAttachCounts {
    return {
      attachedDedicatedWorkerCount: this.attachedDedicatedWorkerCount,
      attachedNestedDedicatedWorkerCount: this.attachedNestedDedicatedWorkerCount,
      attachedSharedWorkerCount: this.attachedSharedWorkerCount
    };
  }

  /**
   * Wait until every attached worker's pause reached a terminal state. Each
   * pause is individually bounded by its watchdog, so this resolves within one
   * handshake timeout of the last attach; `timeoutMs` is a final backstop
   * against a transport that stops answering entirely. On return every
   * attached worker is concluded for every installer: a pause the backstop cut
   * short is concluded `settled` rather than left indeterminate, because
   * callers freeze their counters right after this call and an attached
   * worker with no terminal record would read as zero loss.
   */
  async settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // A settling pause can add new in-flight work (a nested worker
    // attaching), so re-snapshot per iteration until the set drains or the
    // backstop expires.
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      ]);
    }
    // The conclusion guard makes this sweep the worker's one conclusion, so a
    // pause finishing later can neither flip the frozen record nor count the
    // worker twice. The worker itself is still released by its own watchdog,
    // by its flow finishing, or by close(); the sweep only makes the
    // accounting honest.
    for (const worker of [...this.openWorkers]) {
      this.concludeInstallers(worker, "settled");
    }
  }

  /**
   * Closing detaches this client. Chromium resumes any target that was
   * paused waiting for this client, so a worker can never stay suspended
   * beyond the session.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    // Whatever the transport does on close, the installers hear that nothing
    // more will arrive.
    this.markChannelLost();
  }

  private markChannelLost(): void {
    if (this.channelLost) return;
    this.channelLost = true;
    for (const installer of this.installers) {
      try {
        installer.onChannelClosed?.();
      } catch {
        // Every other installer still hears it.
      }
    }
  }

  private onChannelEvent(event: DevtoolsEvent): void {
    if (event.method === "Target.targetCreated") this.onTargetCreated(event);
    if (event.method === "Target.attachedToTarget") this.onAttachedToTarget(event);
    if (event.method === "Target.detachedFromTarget") this.onDetachedFromTarget(event);
    for (const installer of this.installers) {
      try {
        installer.onEvent?.(event);
      } catch {
        // An installer's reading is its own; the channel keeps delivering.
      }
    }
  }

  /** Discovery is browser-level, so its events carry no session. */
  private onTargetCreated(event: DevtoolsEvent): void {
    if (event.sessionId !== undefined || this.sharedWorkerContextId === null) return;
    const targetInfo = event.params.targetInfo as
      | { type?: unknown; targetId?: unknown; browserContextId?: unknown }
      | undefined;
    if (
      targetInfo?.type === "shared_worker" &&
      targetInfo.browserContextId === this.sharedWorkerContextId &&
      typeof targetInfo.targetId === "string"
    ) {
      this.discoveredSharedWorkerTargetIds.add(targetInfo.targetId);
    }
  }

  private onDetachedFromTarget(event: DevtoolsEvent): void {
    const sessionId = event.params.sessionId;
    if (typeof sessionId !== "string") return;
    this.frameTargetSessionIds.delete(sessionId);
    const worker = this.workersBySession.get(sessionId);
    if (!worker || worker.detached) return;
    worker.detached = true;
    worker.detachedWhilePaused = !worker.released;
  }

  private onAttachedToTarget(event: DevtoolsEvent): void {
    const params = event.params;
    const sessionId = params.sessionId;
    const targetInfo = params.targetInfo as { type?: unknown; parentFrameId?: unknown } | undefined;
    if (typeof sessionId !== "string" || !targetInfo) return;
    const type = typeof targetInfo.type === "string" ? targetInfo.type : "";
    const waitingForDebugger = params.waitingForDebugger === true;
    // The event's own sessionId names the session it arrived on: the page,
    // a frame or auxiliary target (page-level, because the construction wrap
    // runs in every frame of the measured page), or a worker (nested). Read
    // and register synchronously: a child can only attach after its parent's
    // setAutoAttach is sent, which happens after this registration.
    const arrivedOnSessionId = typeof event.sessionId === "string" ? event.sessionId : null;
    const nested = arrivedOnSessionId !== null && this.workerSessionIds.has(arrivedOnSessionId);
    if (type === "worker" || type === "shared_worker") this.workerSessionIds.add(sessionId);
    if (type === "iframe") this.frameTargetSessionIds.add(sessionId);
    const ownerFrameId =
      typeof targetInfo.parentFrameId === "string" && targetInfo.parentFrameId.length > 0
        ? targetInfo.parentFrameId
        : null;

    const operation = this.handleAttachedTarget(sessionId, type, waitingForDebugger, nested, {
      arrivedOnSessionId,
      ownerFrameId
    }).catch(() => undefined);
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation)
    );
  }

  private async handleAttachedTarget(
    sessionId: string,
    type: string,
    waitingForDebugger: boolean,
    nested: boolean,
    origin: { arrivedOnSessionId: string | null; ownerFrameId: string | null }
  ): Promise<void> {
    if (type !== "worker" && type !== "shared_worker") {
      // Out-of-process frames and other auxiliary targets are attached by the
      // same auto-attach filter. They are not measured here; recurse so their
      // workers are, then release immediately.
      try {
        await this.enableAutoAttach(sessionId);
      } finally {
        if (waitingForDebugger) await this.release(sessionId);
      }
      return;
    }

    if (type === "worker") {
      this.attachedDedicatedWorkerCount += 1;
      if (nested) this.attachedNestedDedicatedWorkerCount += 1;
    } else {
      this.attachedSharedWorkerCount += 1;
    }

    const worker: AttachedWorkerRecord = {
      sessionId,
      kind: type === "worker" ? "dedicated" : "shared",
      nested,
      arrivedOnSessionId: origin.arrivedOnSessionId,
      ownerFrameId: origin.ownerFrameId,
      waitingForDebugger,
      released: false,
      detached: false,
      detachedWhilePaused: false,
      concluded: false
    };
    this.workersBySession.set(sessionId, worker);
    this.openWorkers.add(worker);
    const watchdog = setTimeout(() => {
      // The worker must not stay paused past the bound. Conclude every
      // installer before the resume goes out, so an install result arriving
      // later cannot upgrade a worker that already ran for part of the window.
      this.concludeInstallers(worker, "watchdog");
      void this.releaseWorker(worker);
    }, this.handshakeTimeoutMs);

    try {
      // Recurse before any install and before releasing, so a worker
      // constructed inside this worker's first statements is itself paused.
      await this.enableAutoAttach(sessionId);
      for (const installer of this.installers) {
        // Once the watchdog let the worker run, nothing more is installed
        // into it: the realm is no longer before its first statement.
        if (worker.released) break;
        try {
          await installer.install(worker, this.channel);
        } catch {
          // The installer's failure is its own. The next installer and the
          // release still happen, and its conclusion below still arrives.
        }
      }
    } catch {
      // Recursion could not be armed, so no installer ran. The worker is
      // still released and concluded below.
    } finally {
      clearTimeout(watchdog);
      await this.releaseWorker(worker);
      this.concludeInstallers(worker, "released");
    }
  }

  /** Exactly one conclusion per attached worker, delivered to every installer. */
  private concludeInstallers(worker: AttachedWorkerRecord, how: WorkerRealmConclusion): void {
    if (worker.concluded) return;
    worker.concluded = true;
    this.openWorkers.delete(worker);
    for (const installer of this.installers) {
      try {
        installer.concluded(worker, how);
      } catch {
        // A conclusion runs from a timer too, where a throw would escape the
        // scan; every other installer still hears it.
      }
    }
  }

  private async enableAutoAttach(sessionId: string): Promise<void> {
    await this.channel.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    );
  }

  /** The worker's one resume, whichever of the flow and the watchdog comes first. */
  private async releaseWorker(worker: AttachedWorkerRecord): Promise<void> {
    if (worker.released) return;
    worker.released = true;
    await this.release(worker.sessionId);
  }

  private async release(sessionId: string): Promise<void> {
    try {
      await this.channel.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    } catch {
      // A dead transport detaches this client, and Chromium resumes targets
      // paused for a detached client, so failure here cannot strand a worker.
    }
  }
}

/**
 * Resolve the browser-level DevTools WebSocket URL for a loopback debugging
 * port. Loopback only by construction: the port is bound by Chromium on
 * 127.0.0.1 and the URL is fetched from the same interface.
 */
export async function devtoolsBrowserWebSocketUrl(
  port: number,
  timeoutMs: number = DEVTOOLS_DISCOVERY_TIMEOUT_MS
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`DevTools version endpoint answered ${response.status}.`);
  }
  const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  const url = body.webSocketDebuggerUrl;
  if (typeof url !== "string" || !url.startsWith("ws://127.0.0.1:")) {
    throw new Error("DevTools version endpoint did not expose a loopback WebSocket URL.");
  }
  return url;
}

type PendingCommand = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Minimal flat-protocol DevTools client over the global WebSocket. Playwright
 * owns its own CDP pipe and its `CDPSession` cannot address flattened child
 * sessions, which is exactly what holding workers needs, so the scanner speaks
 * to the browser's loopback DevTools endpoint directly.
 */
export async function openDevtoolsBrowserChannel(
  webSocketUrl: string,
  options: { commandTimeoutMs?: number; connectTimeoutMs?: number } = {}
): Promise<DevtoolsChannel> {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const socket = new WebSocket(webSocketUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("DevTools WebSocket connect timed out.")),
      options.connectTimeoutMs ?? DEVTOOLS_DISCOVERY_TIMEOUT_MS
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("DevTools WebSocket connect failed."));
    };
  });

  let nextCommandId = 1;
  const pending = new Map<number, PendingCommand>();
  const eventHandlers = new Set<(event: DevtoolsEvent) => void>();
  const closeHandlers = new Set<() => void>();
  let closeAnnounced = false;

  const failAllPending = (reason: string) => {
    for (const [id, command] of pending) {
      pending.delete(id);
      clearTimeout(command.timer);
      command.reject(new Error(reason));
    }
  };
  const announceClose = () => {
    if (closeAnnounced) return;
    closeAnnounced = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // Close handlers own their failures; every other one still runs.
      }
    }
  };

  socket.onmessage = (message: MessageEvent) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(message.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = parsed.id;
    if (typeof id === "number" && pending.has(id)) {
      const command = pending.get(id)!;
      pending.delete(id);
      clearTimeout(command.timer);
      const error = parsed.error as { message?: unknown } | undefined;
      if (error) {
        command.reject(new Error(typeof error.message === "string" ? error.message : "DevTools command failed."));
      } else {
        command.resolve((parsed.result as Record<string, unknown>) ?? {});
      }
      return;
    }
    const method = parsed.method;
    if (typeof method !== "string") return;
    const event: DevtoolsEvent = {
      method,
      params: (parsed.params as Record<string, unknown>) ?? {},
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {})
    };
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch {
        // Event handlers own their failures; the transport keeps delivering.
      }
    }
  };
  socket.onclose = () => {
    failAllPending("DevTools WebSocket closed.");
    announceClose();
  };
  socket.onerror = () => {
    failAllPending("DevTools WebSocket errored.");
    announceClose();
  };

  return {
    send(method, params = {}, sessionId) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("DevTools WebSocket is not open."));
          return;
        }
        const id = nextCommandId;
        nextCommandId += 1;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`DevTools command timed out: ${method}`));
        }, commandTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
    },
    close() {
      failAllPending("DevTools WebSocket closed.");
      try {
        socket.close();
      } catch {
        // Already closed or closing.
      }
      announceClose();
    }
  };
}

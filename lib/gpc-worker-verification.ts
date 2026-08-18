import { installGlobalPrivacyControl } from "./gpc-injection";

/**
 * Pre-start GPC delivery into Web Worker realms, with a readback handshake.
 *
 * The GPC arm used to deliver the worker signal by rewriting network worker
 * sources at the route boundary and by refusing blob:/data: workers outright.
 * Both halves conflated a recorded fact with the inference readers need:
 * a rewritten response proves the scanner served different bytes, not that the
 * worker observed the signal, and the refusal made the GPC arm the only arm in
 * which a site's local-scheme worker throws.
 *
 * This module replaces both with one mechanism. The scanner attaches its own
 * DevTools client to the measured page target only, auto-attaches every worker
 * of that page (recursively, so workers of workers are covered) paused before
 * their first statement, installs the GPC property inside the worker's own
 * realm, and reads it back in the same evaluation. Only a `true` readback from
 * inside the worker marks it verified; anything else is a terminal handshake
 * failure the caller must disclose. The worker is always released afterwards,
 * so the measured site keeps its workers either way.
 *
 * Scope and arms: the client attaches to one page target. The baseline arm
 * never opens a channel, so its behavior is untouched; other pages in the
 * browser (including a concurrent scan's) are never attached.
 *
 * SharedWorker is outside this mechanism: Chromium does not auto-attach
 * shared workers from a page session, and a browser-wide auto-attach would
 * pause the baseline arm's workers too. Shared workers therefore run
 * untouched and are disclosed as unverified through the construction counts
 * kept by lib/gpc-injection.ts.
 */

/** One command/handshake step may not outlive this. */
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/**
 * Upper bound on how long one worker may stay paused for its handshake. The
 * handshake is three loopback round trips, normally single-digit
 * milliseconds; on expiry the worker is force-released and recorded as a
 * handshake failure, never left paused and never silently passed.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
const DEVTOOLS_DISCOVERY_TIMEOUT_MS = 3_000;

export type GpcWorkerVerificationDiagnostics = {
  attachedDedicatedWorkerCount: number;
  attachedSharedWorkerCount: number;
  verifiedWorkerCount: number;
  unverifiedAttachedWorkerCount: number;
};

export type GpcWorkerCdpEvent = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

/**
 * The transport seam. Production speaks the DevTools flat protocol over a
 * loopback WebSocket (`openDevtoolsBrowserChannel`); unit tests substitute a
 * scripted channel so every handshake branch is reachable without a browser.
 */
export type GpcWorkerCdpChannel = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(handler: (event: GpcWorkerCdpEvent) => void): void;
  close(): void;
};

/**
 * The exact expression evaluated inside each paused worker realm. It reuses
 * the same realm-local initializer documents get, then reads the property
 * back in the same evaluation: the returned boolean is testimony from inside
 * the worker, not an assumption from outside it.
 */
export const GPC_WORKER_HANDSHAKE_EXPRESSION =
  `(${installGlobalPrivacyControl.toString()})();\n` +
  `navigator.globalPrivacyControl === true;`;

type WorkerHandshakeRecord = {
  settled: boolean;
};

export class GpcWorkerVerificationSession {
  private readonly channel: GpcWorkerCdpChannel;
  private readonly handshakeTimeoutMs: number;
  private readonly inFlight = new Set<Promise<void>>();
  private attachedDedicatedWorkerCount = 0;
  private attachedSharedWorkerCount = 0;
  private verifiedWorkerCount = 0;
  private unverifiedAttachedWorkerCount = 0;
  private closed = false;

  constructor(channel: GpcWorkerCdpChannel, options: { handshakeTimeoutMs?: number } = {}) {
    this.channel = channel;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.channel.onEvent((event) => this.onChannelEvent(event));
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
      throw new Error("GPC worker verification could not attach to the measured page target.");
    }
    await this.enableAutoAttach(sessionId);
  }

  diagnostics(): GpcWorkerVerificationDiagnostics {
    return {
      attachedDedicatedWorkerCount: this.attachedDedicatedWorkerCount,
      attachedSharedWorkerCount: this.attachedSharedWorkerCount,
      verifiedWorkerCount: this.verifiedWorkerCount,
      unverifiedAttachedWorkerCount: this.unverifiedAttachedWorkerCount
    };
  }

  /**
   * Wait until every observed worker handshake reached a terminal state. Each
   * handshake is individually bounded by its watchdog, so this resolves within
   * one handshake timeout of the last attach; `timeoutMs` is a final backstop
   * against a transport that stops answering entirely.
   */
  async settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // A settling handshake can add new in-flight work (a nested worker
    // attaching), so re-snapshot per iteration until the set drains or the
    // backstop expires.
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      ]);
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
  }

  private onChannelEvent(event: GpcWorkerCdpEvent): void {
    if (event.method !== "Target.attachedToTarget") return;
    const params = event.params;
    const sessionId = params.sessionId;
    const targetInfo = params.targetInfo as { type?: unknown } | undefined;
    if (typeof sessionId !== "string" || !targetInfo) return;
    const type = typeof targetInfo.type === "string" ? targetInfo.type : "";
    const waitingForDebugger = params.waitingForDebugger === true;

    const operation = this.handleAttachedTarget(sessionId, type, waitingForDebugger).catch(() => undefined);
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation)
    );
  }

  private async handleAttachedTarget(
    sessionId: string,
    type: string,
    waitingForDebugger: boolean
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

    if (type === "worker") this.attachedDedicatedWorkerCount += 1;
    else this.attachedSharedWorkerCount += 1;

    const record: WorkerHandshakeRecord = { settled: false };
    const watchdog = setTimeout(() => {
      // The worker must not stay paused past the handshake bound. Force the
      // terminal unverified state first so a late evaluate result cannot
      // upgrade a worker that already ran unpaused for part of the window.
      this.concludeWorker(record, false);
      void this.release(sessionId);
    }, this.handshakeTimeoutMs);

    try {
      // Recurse before releasing so a worker constructed inside this worker's
      // first statements is itself paused and verified.
      await this.enableAutoAttach(sessionId);
      const evaluated = await this.channel.send(
        "Runtime.evaluate",
        { expression: GPC_WORKER_HANDSHAKE_EXPRESSION, returnByValue: true },
        sessionId
      );
      const result = evaluated.result as { value?: unknown } | undefined;
      this.concludeWorker(record, result?.value === true);
    } catch {
      this.concludeWorker(record, false);
    } finally {
      clearTimeout(watchdog);
      await this.release(sessionId);
    }
  }

  /** Exactly one terminal state per attached worker. */
  private concludeWorker(record: WorkerHandshakeRecord, verified: boolean): void {
    if (record.settled) return;
    record.settled = true;
    if (verified) this.verifiedWorkerCount += 1;
    else this.unverifiedAttachedWorkerCount += 1;
  }

  private async enableAutoAttach(sessionId: string): Promise<void> {
    await this.channel.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId
    );
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
 * sessions, which is exactly what worker verification needs, so the scanner
 * speaks to the browser's loopback DevTools endpoint directly.
 */
export async function openDevtoolsBrowserChannel(
  webSocketUrl: string,
  options: { commandTimeoutMs?: number; connectTimeoutMs?: number } = {}
): Promise<GpcWorkerCdpChannel> {
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
  const eventHandlers = new Set<(event: GpcWorkerCdpEvent) => void>();

  const failAllPending = (reason: string) => {
    for (const [id, command] of pending) {
      pending.delete(id);
      clearTimeout(command.timer);
      command.reject(new Error(reason));
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
    const event: GpcWorkerCdpEvent = {
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
  socket.onclose = () => failAllPending("DevTools WebSocket closed.");
  socket.onerror = () => failAllPending("DevTools WebSocket errored.");

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
    close() {
      failAllPending("DevTools WebSocket closed.");
      try {
        socket.close();
      } catch {
        // Already closed or closing.
      }
    }
  };
}

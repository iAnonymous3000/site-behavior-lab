import type {
  AttachedWorker,
  DedicatedWorkerAttachSession,
  DedicatedWorkerWitness,
  DevtoolsChannel,
  DevtoolsEvent,
  WorkerRealmInstaller
} from "./devtools-worker-channel";
import {
  fingerprintObserverInitScript,
  type FingerprintObserverRealmArgs,
  type FingerprintWorkerRealmReadout
} from "./fingerprint-observer";

/**
 * The fingerprint observer inside dedicated Web Worker realms.
 *
 * A worker's canvas, font and WebGL calls run in the worker's own realm, where
 * the document observer's wrappers never reach. The worker realm channel
 * (lib/devtools-worker-channel.ts) holds each dedicated worker of the measured
 * page paused before its first statement; this module puts the observer into
 * that paused realm and reads the realm's evidence back.
 *
 * ONE SOURCE. What runs in the worker is the document observer itself,
 * `fingerprintObserverInitScript`, serialized and called with the worker realm
 * argument. This module restates no wrapper, threshold or heuristic, and
 * imports nothing else from the observer, so a worker's calls are recorded by
 * exactly the code that records a document's. It never parses a snapshot
 * either: it hands the realms' own snapshot text to the observer's collection,
 * which normalizes and merges it exactly as it does a frame's.
 *
 * CRASH HAZARD. The install runs while the worker's global is only partly
 * initialized, and there a read of a lazily initialized global or a WebGL
 * context creation crashes the renderer, destroying the measured page in
 * every arm. The observer's docblock states the rule, and
 * lib/worker-fingerprint-realm.test.ts installs this exact expression into
 * paused workers of every shape in real Chromium and fails on a crash.
 *
 * READBACK. A worker realm has no read surface. In the pause the installer
 * adds a `Runtime.addBinding` sink on the worker's session, which the observer
 * captures and deletes before the worker's first statement, and the realm
 * streams over it with the edge protocol the observer's docblock describes:
 * "open" at a task's first recording, "closed" with the realm's cumulative
 * snapshot at the task's microtask checkpoint. The host keeps only strings per
 * worker (the last closed snapshot, and one slot per pending freeze) and reads
 * them at the same two instants the page realm is read, under the readout rule
 * on `readout`.
 *
 * SCOPE. Worker evidence is scoped to current documents, as the page realm's
 * is: a replaced document's observer state is gone. The installer records each
 * worker's owner document, the frame and its loader, during the pause, when
 * the worker is alive and its owner therefore current. At a readout a worker
 * still attached is current, because a dedicated worker dies with its owner
 * document, and a worker that has gone is credited only when its owner
 * document is still in the page's current frame trees. An interstitial that
 * fingerprints in a worker and then navigates to the site is therefore not
 * credited to the site.
 */

/** Serialized once per process: the same text for every worker of every scan. */
const FINGERPRINT_OBSERVER_SOURCE = fingerprintObserverInitScript.toString();

/**
 * A worker realm snapshot carries summaries only, never raw text: the largest
 * the full worker vocabulary produces is under 1,500 characters. A payload
 * over this bound is not one the observer emits, and its realm is unread.
 */
export const MAX_WORKER_SNAPSHOT_PAYLOAD_CHARS = 16_384;

/** The readout's drain bound: the scanner passes the smaller of this and the budget left. */
export const WORKER_REALM_READOUT_SETTLE_MS = 500;

/**
 * The exact expression evaluated inside a paused dedicated worker: the
 * observer's own function, called with the scan's first-party site key (the
 * value the document's init script gets) and the worker realm argument, which
 * names the scan's sink and capability. It evaluates to `true` only when the
 * whole observer ran inside the realm and sent its first closed snapshot.
 */
export function fingerprintObserverWorkerInstallExpression(
  firstPartySiteKey: string,
  sink: { sinkName: string; capability: string }
): string {
  const realmArgs: FingerprintObserverRealmArgs = {
    realm: "dedicated-worker",
    sinkName: sink.sinkName,
    capability: sink.capability
  };
  return `(${FINGERPRINT_OBSERVER_SOURCE})(${JSON.stringify(firstPartySiteKey)}, ${JSON.stringify(realmArgs)})`;
}

export type WorkerFingerprintInstallDiagnostics = {
  /**
   * Dedicated workers whose install answered `true`, with its first closed
   * snapshot already received, while the channel still held them.
   */
  installedWorkerCount: number;
  /**
   * Attached dedicated workers the observer is not known to precede: the
   * install threw, answered anything but `true`, came back without its first
   * snapshot, or came back only after the pause had been concluded (watchdog
   * or settle), when the worker may already have run its first statements
   * uninstrumented; or the worker was already running when it attached.
   */
  installFailedWorkerCount: number;
};

/**
 * Every term of one readout, so each can be asserted. Excluded workers ran no
 * page code at the freeze or belong to a document that is no longer current;
 * unread ones ran page code whose evidence cannot be read in full.
 */
export type WorkerFingerprintReadoutDiagnostics = {
  /** The browser-side witness at the freeze. */
  observedDedicated: number;
  /** This channel's dedicated attaches after the drain, nested ones included. */
  attachedDedicated: number;
  attachedNested: number;
  /** Excluded: still held before its first statement at the freeze. */
  pausedAtReadout: number;
  /** Excluded: the worker's target went away before the channel released it. */
  diedPaused: number;
  /** Excluded: the worker has gone and its owner document is no longer current. */
  ownerReplaced: number;
  /** Read: one cumulative snapshot. */
  readable: number;
  /** Unread: released without the observer known to precede its first statement. */
  installFailed: number;
  /** Unread: already running when it attached. */
  attachedLate: number;
  /** Unread: its last word at the freeze was "open", and no closed snapshot followed within the drain. */
  cutOff: number;
  /** Unread: a sequence gap, an oversized or malformed payload, or the realm's own `null`. */
  streamBroken: number;
  /** Unread: the channel closed while the worker was alive, so its later emissions cannot arrive. */
  channelLostAlive: number;
  /** Unread: its owner document could not be recorded, or could not be checked against the current frames. */
  ownerUnknown: number;
  /** Unread: witnessed by the browser but never attached by the channel. */
  unattachedDedicated: number;
};

export type WorkerFingerprintRealmReadout = FingerprintWorkerRealmReadout & {
  readonly diagnostics: WorkerFingerprintReadoutDiagnostics;
};

type OwnerDocument = { frameId: string; loaderId: string };

/** A pending freeze waiting on one worker: the first closed snapshot after the freeze's sequence. */
type FreezeSlot = { freezeSeq: number; snapshot: string | null };

type WorkerRealmRecord = {
  readonly worker: AttachedWorker;
  /** Null until the install reached its terminal record. */
  install: "installed" | "failed" | "attached-late" | null;
  /** Null while the pause's read is pending; "unknown" when it failed. */
  owner: OwnerDocument | "unknown" | null;
  lastSeq: number;
  lastWord: "open" | "closed" | null;
  /** The text of the last closed emission: a snapshot or the realm's own "null". */
  lastClosed: string | null;
  broken: boolean;
  /** The channel closed while this worker was still attached. */
  lostWithChannel: boolean;
  readonly slots: Set<FreezeSlot>;
};

type FrozenRealm =
  | { record: WorkerRealmRecord; state: "excluded"; reason: "pausedAtReadout" | "diedPaused" }
  | {
      record: WorkerRealmRecord;
      state: "unread";
      reason: "installFailed" | "attachedLate" | "streamBroken" | "channelLostAlive";
    }
  | { record: WorkerRealmRecord; state: "closed"; snapshot: string }
  | { record: WorkerRealmRecord; state: "open"; slot: FreezeSlot };

/**
 * The fingerprint observer's installer on the worker realm channel, in every
 * arm, and the ledger of what each worker realm streamed back. It runs after
 * the GPC installer in the GPC arm's pause, so the GPC outcome never depends
 * on it; for the same reason the owner document is read here, after GPC, and
 * not by the channel before every installer.
 *
 * Dedicated workers only. The channel does not receive shared workers from a
 * page session; should one ever attach, nothing is installed into it here,
 * since this installer's paused-install guard covers dedicated worker shapes
 * only, and it stays in the channel's shared attach count.
 */
export class FingerprintWorkerRealmInstaller implements WorkerRealmInstaller {
  /** The sink's name on every worker session of this scan; random, so no page can guess it. */
  readonly sinkName: string;
  /** Opens every emission of this scan; anything else on the sink is ignored. */
  readonly capability: string;
  private readonly expression: string;
  /** Attached dedicated workers whose install reached its terminal record. */
  private readonly settledWorkers = new WeakSet<AttachedWorker>();
  private readonly records = new Map<string, WorkerRealmRecord>();
  private readonly changeWaiters = new Set<() => void>();
  private installedWorkerCount = 0;
  private installFailedWorkerCount = 0;
  private channelLost = false;

  /** `firstPartySiteKey` is the value the scan's documents get from their init script. */
  constructor(firstPartySiteKey: string, options: { randomBytes?: Uint8Array } = {}) {
    const randomBytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(24));
    if (randomBytes.length < 16) throw new Error("The worker realm sink requires at least 128 bits of capability entropy.");
    this.capability = bytesToHex(randomBytes);
    this.sinkName = `__siteBehaviorLabFingerprintSink_${this.capability.slice(0, 16)}`;
    this.expression = fingerprintObserverWorkerInstallExpression(firstPartySiteKey, {
      sinkName: this.sinkName,
      capability: this.capability
    });
  }

  async install(worker: AttachedWorker, channel: DevtoolsChannel): Promise<void> {
    if (worker.kind !== "dedicated") return;
    const record = this.recordFor(worker);
    if (!worker.waitingForDebugger) {
      // Already running when it attached: its first statements ran before any
      // install could, so nothing is installed and its realm is unread.
      this.concludeWorker(worker, "attached-late");
      return;
    }
    // One burst, processed in order by the browser: the owner read on the
    // session the attach arrived on, then the sink, then the observer, which
    // finds the sink already on its global. The worker stays held throughout.
    const ownerRead = this.readOwner(worker, channel);
    const binding = channel.send("Runtime.addBinding", { name: this.sinkName }, worker.sessionId);
    const evaluation = channel.send(
      "Runtime.evaluate",
      { expression: this.expression, returnByValue: true },
      worker.sessionId
    );
    const [owner, bound, evaluated] = await Promise.allSettled([ownerRead, binding, evaluation]);
    record.owner = owner.status === "fulfilled" ? owner.value : "unknown";
    let installed = false;
    if (bound.status === "fulfilled" && evaluated.status === "fulfilled") {
      const result = evaluated.value.result as { value?: unknown } | undefined;
      // The realm's first closed snapshot is emitted during the evaluation, so
      // it precedes the evaluation's answer on the worker's session; an answer
      // without it means the realm cannot reach the host.
      installed =
        evaluated.value.exceptionDetails === undefined &&
        result?.value === true &&
        record.lastSeq >= 1 &&
        !record.broken;
    }
    // Terminal here, while the channel still holds the worker. A watchdog or
    // settle that concluded the worker first already recorded the install as
    // failed, and this late answer cannot upgrade it.
    this.concludeWorker(worker, installed ? "installed" : "failed");
  }

  /** A worker concluded without an answer of its own is uninstrumented. After an answer this is a no-op. */
  concluded(worker: AttachedWorker): void {
    if (worker.kind !== "dedicated") return;
    this.recordFor(worker);
    this.concludeWorker(worker, "failed");
  }

  onEvent(event: DevtoolsEvent): void {
    if (event.method === "Target.attachedToTarget") {
      // A drain may be waiting for the channel's attaches to reach the witness.
      this.announceChange();
      return;
    }
    if (event.method !== "Runtime.bindingCalled" || event.params.name !== this.sinkName) return;
    const record = typeof event.sessionId === "string" ? this.records.get(event.sessionId) : undefined;
    if (!record) return;
    this.receive(record, event.params.payload);
    this.announceChange();
  }

  onChannelClosed(): void {
    if (this.channelLost) return;
    this.channelLost = true;
    // Every worker still attached keeps running (Chromium resumes a worker
    // held for a client that went away), and nothing it emits can arrive now.
    for (const record of this.records.values()) {
      if (!record.worker.detached) record.lostWithChannel = true;
    }
    this.announceChange();
  }

  installDiagnostics(): WorkerFingerprintInstallDiagnostics {
    return {
      installedWorkerCount: this.installedWorkerCount,
      installFailedWorkerCount: this.installFailedWorkerCount
    };
  }

  /**
   * The worker realms at one freeze, run at exactly the instants the page
   * realm is read (the passive boundary and the final state read).
   *
   * 1. The freeze is this call, before its first await. Each worker's state
   *    is taken as its last word so far: a closed snapshot, an open task, or
   *    a state that excludes it or leaves it unread.
   * 2. The drain, bounded by `settleMs`: wait until the channel's attaches
   *    reach the witness's count at the freeze (a witnessed worker not yet
   *    attached is still paused, not lost), and, for each worker whose last
   *    word at the freeze was "open", for the first closed snapshot after it.
   *    That is a page evaluate waiting for the current task to end. The drain
   *    never waits for a worker's latest state to be closed, which a worker
   *    drawing every frame could starve.
   * 3. Each worker is classified, and a worker that has gone is checked
   *    against the page's current frame trees.
   *
   * Never rejects. With no channel (it was never established), every
   * witnessed worker is unread.
   */
  async readout(options: {
    session: DedicatedWorkerAttachSession | null;
    witness: Pick<DedicatedWorkerWitness, "count">;
    settleMs: number;
  }): Promise<WorkerFingerprintRealmReadout> {
    const observedDedicated = options.witness.count();
    const frozen: FrozenRealm[] = [];
    for (const record of this.records.values()) frozen.push(this.freeze(record));
    // A dedicated worker this installer has neither installed nor heard
    // concluded is still held by an installer before it (GPC, in its arm).
    const heldBeforeInstall = Math.max(
      0,
      (options.session?.attachCounts().attachedDedicatedWorkerCount ?? 0) - frozen.length
    );

    try {
      await this.drain(options.session, observedDedicated, frozen, options.settleMs);
    } finally {
      for (const realm of frozen) if (realm.state === "open") realm.record.slots.delete(realm.slot);
    }

    const attachCounts = options.session?.attachCounts() ?? {
      attachedDedicatedWorkerCount: 0,
      attachedNestedDedicatedWorkerCount: 0,
      attachedSharedWorkerCount: 0
    };
    const diagnostics: WorkerFingerprintReadoutDiagnostics = {
      observedDedicated,
      attachedDedicated: attachCounts.attachedDedicatedWorkerCount,
      attachedNested: attachCounts.attachedNestedDedicatedWorkerCount,
      pausedAtReadout: heldBeforeInstall,
      diedPaused: 0,
      ownerReplaced: 0,
      readable: 0,
      installFailed: 0,
      attachedLate: 0,
      cutOff: 0,
      streamBroken: 0,
      channelLostAlive: 0,
      ownerUnknown: 0,
      unattachedDedicated: Math.max(0, observedDedicated - attachCounts.attachedDedicatedWorkerCount)
    };

    // A realm with its snapshot in hand still needs a current owner.
    const candidates: Array<{ record: WorkerRealmRecord; snapshot: string }> = [];
    for (const realm of frozen) {
      if (realm.state === "excluded" || realm.state === "unread") {
        diagnostics[realm.reason] += 1;
        continue;
      }
      const snapshot = realm.state === "closed" ? realm.snapshot : realm.slot.snapshot;
      if (snapshot === null) {
        // Open at the freeze, and still open when the drain ended: cut off
        // mid-task (terminated, or a task longer than the bound), or its
        // stream broke or its channel closed before the task's closed
        // snapshot arrived.
        if (realm.record.lostWithChannel) diagnostics.channelLostAlive += 1;
        else if (realm.record.broken) diagnostics.streamBroken += 1;
        else diagnostics.cutOff += 1;
        continue;
      }
      // The realm's own null: its observer lost coverage (an overflowed
      // bound or the emission cap), so it has nothing whole to give.
      if (snapshot === "null") {
        diagnostics.streamBroken += 1;
        continue;
      }
      candidates.push({ record: realm.record, snapshot });
    }

    const readableSnapshots: string[] = [];
    let currentDocuments: Map<string, string> | null | undefined;
    for (const { record, snapshot } of candidates) {
      const owner = record.owner;
      if (owner === null || owner === "unknown") {
        diagnostics.ownerUnknown += 1;
        continue;
      }
      if (record.worker.detached) {
        if (currentDocuments === undefined) currentDocuments = await currentDocumentLoaders(options.session);
        if (currentDocuments === null) {
          // The current frames could not be read, so the worker's owner
          // cannot be shown current or replaced; never excluded silently.
          diagnostics.ownerUnknown += 1;
          continue;
        }
        if (currentDocuments.get(owner.frameId) !== owner.loaderId) {
          diagnostics.ownerReplaced += 1;
          continue;
        }
      }
      diagnostics.readable += 1;
      readableSnapshots.push(snapshot);
    }

    return {
      readableSnapshots,
      unreadRealms:
        diagnostics.installFailed +
        diagnostics.attachedLate +
        diagnostics.cutOff +
        diagnostics.streamBroken +
        diagnostics.channelLostAlive +
        diagnostics.ownerUnknown +
        diagnostics.unattachedDedicated,
      diagnostics
    };
  }

  private freeze(record: WorkerRealmRecord): FrozenRealm {
    const worker = record.worker;
    // A worker the closed channel left running cannot be read, held or not:
    // Chromium resumed it when this client went away.
    if (record.lostWithChannel) return { record, state: "unread", reason: "channelLostAlive" };
    if (worker.detachedWhilePaused) return { record, state: "excluded", reason: "diedPaused" };
    if (!worker.released) return { record, state: "excluded", reason: "pausedAtReadout" };
    if (record.install === "attached-late") return { record, state: "unread", reason: "attachedLate" };
    if (record.install !== "installed") return { record, state: "unread", reason: "installFailed" };
    if (record.broken || record.lastWord === null) return { record, state: "unread", reason: "streamBroken" };
    if (record.lastWord === "closed" && record.lastClosed !== null) {
      return { record, state: "closed", snapshot: record.lastClosed };
    }
    const slot: FreezeSlot = { freezeSeq: record.lastSeq, snapshot: null };
    record.slots.add(slot);
    return { record, state: "open", slot };
  }

  private async drain(
    session: DedicatedWorkerAttachSession | null,
    observedDedicated: number,
    frozen: readonly FrozenRealm[],
    settleMs: number
  ): Promise<void> {
    const drained = () => {
      if (this.channelLost || session === null || session.isChannelLost()) return true;
      if (session.attachCounts().attachedDedicatedWorkerCount < observedDedicated) return false;
      return frozen.every(
        (realm) =>
          realm.state !== "open" ||
          realm.slot.snapshot !== null ||
          realm.record.broken ||
          realm.record.lostWithChannel
      );
    };
    if (drained()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiredBound = false;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expiredBound = true;
        resolve();
      }, Math.max(0, settleMs));
    });
    try {
      while (!expiredBound && !drained()) {
        let waiter: () => void = () => undefined;
        const changed = new Promise<void>((resolve) => {
          waiter = resolve;
        });
        this.changeWaiters.add(waiter);
        try {
          await Promise.race([changed, expired]);
        } finally {
          this.changeWaiters.delete(waiter);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private receive(record: WorkerRealmRecord, payload: unknown): void {
    if (record.broken || record.lostWithChannel) return;
    if (typeof payload !== "string") {
      record.broken = true;
      return;
    }
    const prefix = `${this.capability}\n`;
    // Not this scan's emission: ignored, never counted against the realm.
    if (!payload.startsWith(prefix)) return;
    if (payload.length > MAX_WORKER_SNAPSHOT_PAYLOAD_CHARS) {
      record.broken = true;
      return;
    }
    const sequenceEnd = payload.indexOf("\n", prefix.length);
    const sequenceText = sequenceEnd === -1 ? "" : payload.slice(prefix.length, sequenceEnd);
    const sequence = /^[1-9][0-9]{0,8}$/.test(sequenceText) ? Number(sequenceText) : Number.NaN;
    // Each emission is the next one: anything else is a lost or replayed
    // emission, and the realm's stream can no longer be read in full.
    if (sequence !== record.lastSeq + 1) {
      record.broken = true;
      return;
    }
    const rest = payload.slice(sequenceEnd + 1);
    if (rest === "open") {
      record.lastSeq = sequence;
      record.lastWord = "open";
      return;
    }
    if (!rest.startsWith("closed\n")) {
      record.broken = true;
      return;
    }
    const snapshot = rest.slice("closed\n".length);
    record.lastSeq = sequence;
    record.lastWord = "closed";
    record.lastClosed = snapshot;
    for (const slot of record.slots) {
      if (slot.snapshot === null && sequence > slot.freezeSeq) slot.snapshot = snapshot;
    }
  }

  /**
   * The worker's owner document, read during its pause, when the worker is
   * alive and its owner therefore committed and current: the attach's
   * `parentFrameId`, found in `Page.getFrameTree` on the session the attach
   * arrived on (the page, or the out-of-process frame that started it). A
   * worker started by another worker has its parent's owner.
   */
  private async readOwner(worker: AttachedWorker, channel: DevtoolsChannel): Promise<OwnerDocument | "unknown"> {
    if (worker.nested) {
      const parent = worker.arrivedOnSessionId === null ? undefined : this.records.get(worker.arrivedOnSessionId);
      const owner = parent?.owner;
      return owner && owner !== "unknown" ? owner : "unknown";
    }
    if (worker.ownerFrameId === null || worker.arrivedOnSessionId === null) return "unknown";
    try {
      const tree = await channel.send("Page.getFrameTree", {}, worker.arrivedOnSessionId);
      const loaderId = frameLoaderIds(tree.frameTree).get(worker.ownerFrameId);
      return loaderId === undefined ? "unknown" : { frameId: worker.ownerFrameId, loaderId };
    } catch {
      return "unknown";
    }
  }

  private recordFor(worker: AttachedWorker): WorkerRealmRecord {
    let record = this.records.get(worker.sessionId);
    if (!record) {
      record = {
        worker,
        install: null,
        owner: null,
        lastSeq: 0,
        lastWord: null,
        lastClosed: null,
        broken: false,
        lostWithChannel: this.channelLost,
        slots: new Set()
      };
      this.records.set(worker.sessionId, record);
    }
    return record;
  }

  private announceChange(): void {
    for (const waiter of [...this.changeWaiters]) waiter();
  }

  /** Exactly one terminal state per attached dedicated worker. */
  private concludeWorker(worker: AttachedWorker, install: "installed" | "failed" | "attached-late"): void {
    if (this.settledWorkers.has(worker)) return;
    this.settledWorkers.add(worker);
    const record = this.records.get(worker.sessionId);
    if (record) record.install = install;
    if (install === "installed") this.installedWorkerCount += 1;
    else this.installFailedWorkerCount += 1;
  }
}

/**
 * The page's current documents, as frame id to loader id, from the channel's
 * current frame trees. Null when there is no channel or the trees could not
 * all be read.
 */
async function currentDocumentLoaders(
  session: DedicatedWorkerAttachSession | null
): Promise<Map<string, string> | null> {
  if (session === null) return null;
  const trees = await session.currentFrameTrees();
  if (trees === null) return null;
  const loaders = new Map<string, string>();
  for (const tree of trees) {
    for (const [frameId, loaderId] of frameLoaderIds(tree)) loaders.set(frameId, loaderId);
  }
  return loaders;
}

/** Every frame of one `Page.getFrameTree` result, as frame id to loader id. */
function frameLoaderIds(tree: unknown): Map<string, string> {
  const loaders = new Map<string, string>();
  const pending: unknown[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop() as { frame?: { id?: unknown; loaderId?: unknown }; childFrames?: unknown } | null;
    if (!node || typeof node !== "object") continue;
    const frame = node.frame;
    if (frame && typeof frame.id === "string" && typeof frame.loaderId === "string") {
      loaders.set(frame.id, frame.loaderId);
    }
    if (Array.isArray(node.childFrames)) pending.push(...node.childFrames);
  }
  return loaders;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

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
import {
  sharedWorkerEndedAtOnce,
  type AttachedSharedWorker,
  type SettledCommandAnswer,
  type SharedWorkerChange,
  type SharedWorkerInstallCommand,
  type SharedWorkerVisitChannel
} from "./shared-worker-attacher";

/**
 * The fingerprint observer inside Web Worker realms: every dedicated worker of
 * the measured page, and every shared worker of the scan's browser context.
 *
 * A worker's canvas, font and WebGL calls run in the worker's own realm, where
 * the document observer's wrappers never reach. The worker realm channel
 * (lib/devtools-worker-channel.ts) holds each dedicated worker of the measured
 * page paused before its first statement, and the shared-worker attacher
 * (lib/shared-worker-attacher.ts) holds each shared worker at its main script;
 * this module puts the observer into that paused realm and reads the realm's
 * evidence back. A dedicated worker's install runs here, on the channel. A
 * shared worker's runs on the attacher's thread, from the commands this module
 * hands it (`sharedWorkerInstallCommands`), and its answers come back here to
 * be judged by the same rule as a dedicated worker's.
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
 * paused workers of every shape in real Chromium, dedicated and shared, and
 * fails on a crash.
 *
 * READBACK. A worker realm has no read surface. In the pause the installer
 * adds a `Runtime.addBinding` sink on the worker's session, which the observer
 * captures and deletes before the worker's first statement, and the realm
 * streams over it with the edge protocol the observer's docblock describes:
 * "open" at a task's first recording, "closed" with the realm's cumulative
 * snapshot at the task's microtask checkpoint. The host keeps only strings per
 * worker (the last closed snapshot, and one slot per pending freeze) and reads
 * them at the same two instants the page realm is read, under the readout rule
 * on `readout`. A shared worker's stream and barrier ride the attacher's
 * thread, which forwards them in the order its connection received them.
 *
 * SCOPE. Worker evidence is scoped to current documents, as the page realm's
 * is: a replaced document's observer state is gone. The installer records each
 * dedicated worker's owner document, the frame and its loader, from the page's
 * frame tree, read beside the install and never holding the worker: that read
 * is answered on the page's main thread, which a long task or a pending
 * navigation can keep for seconds. A late answer can describe the tree after
 * a navigation replaced the owner, so a loader counts as the owner's only
 * when the worker itself answers a command sent after it (`readOwner`). At a
 * readout every dedicated worker, attached or gone, is credited only when its
 * owner document is in the page's frame trees read at the freeze. An
 * interstitial that fingerprints in a worker and then navigates to the site
 * is therefore not credited to the site.
 *
 * A worker that goes away before it answers that command leaves its owner
 * unknown, whatever its document did, and on news pages that is the common
 * case: a blob worker that runs one job and ends within a second, while the
 * page's busy main thread holds the frame tree read. Its whole snapshot is
 * handed to the observer's collection unscoped, never credited: the
 * collection counts it unread when it records anything, and as no realm at
 * all when it records nothing, since a realm that observed nothing has
 * nothing to credit to any document.
 *
 * A SHARED WORKER has no one owner document: any document of its origin can
 * connect to it. It is credited to the visit's main document only when both
 * hold: its script's origin is that document's origin (a `blob:` URL carries
 * its creator's origin), and it was created after that document committed,
 * which the attacher reads as the main document current, on its own
 * connection, when the worker attached, being the document of the main frame
 * at the freeze. Otherwise it is unscoped, exactly as a dedicated worker with
 * an unknown owner is, and never excluded: a shared worker an earlier
 * document of the site started can still serve the current one.
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
 * The readout's barrier on a running worker's session. Chromium answers it on
 * the worker's own thread, by interrupt, so between two statements even in
 * the middle of a long task or a blocking wait on shared memory, and the
 * answer leaves the worker behind every emission the realm made before it. It
 * runs none of the page's code. `Runtime.evaluate` would not do: it waits for
 * the worker's current task to end, and for a blocking wait to return, so
 * every idle thread-pool worker would miss the bound.
 *
 * That the answer arrives behind the worker's earlier emissions is a platform
 * assumption, like the install's first snapshot arriving before the install's
 * answer. The real-Chromium backlog test pins it, and the blocked pool worker
 * test pins the interrupt. (This file is a coverage boundary source, so it
 * names no page API the boundary lists as uninstrumented.)
 *
 * The owner read sends the same command as the worker's vouch for its owner
 * (`readOwner`), for the same reasons: it runs nothing of the page's, and a
 * busy worker answers it at once.
 */
const READOUT_BARRIER_METHOD = "Runtime.getIsolateId";

/**
 * The exact expression evaluated inside a paused worker: the observer's own
 * function, called with the scan's first-party site key (the value the
 * document's init script gets) and the worker realm argument, which names the
 * scan's sink and capability and the kind of worker the host held. It
 * evaluates to `true` only when the whole observer ran inside the realm and
 * sent its first closed snapshot.
 */
export function fingerprintObserverWorkerInstallExpression(
  firstPartySiteKey: string,
  sink: { sinkName: string; capability: string },
  realm: FingerprintObserverRealmArgs["realm"] = "dedicated-worker"
): string {
  const realmArgs: FingerprintObserverRealmArgs = {
    realm,
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

/** The same two counts for the shared workers the attacher reported, apart from the dedicated ones. */
export type SharedWorkerFingerprintInstallDiagnostics = {
  /** Held at their main script, and the install answered `true` with its first snapshot while they were held. */
  installedWorkerCount: number;
  /** Held at their main script, and the install failed, came back late or never came back. */
  installFailedWorkerCount: number;
  /** Reached late: a first pause at another script, seen running before any pause, or running when attached. */
  lateWorkerCount: number;
};

/**
 * The shared-worker terms of one readout, apart from the dedicated ones,
 * which they never move. Excluded workers ran no page code at the freeze;
 * unread ones ran, or may have run, page code whose evidence cannot be read
 * in full; unscoped ones were read in full but cannot be credited to the
 * visit's main document; the ones that ended at once are none of these.
 */
export type SharedWorkerFingerprintReadoutDiagnostics = {
  /** The visit channel's discovery witness: every shared worker target it saw in the scan's context. */
  discovered: number;
  /** Every shared worker of the context the attacher reported, by the end of the drain. */
  attached: number;
  /** Excluded: held at its main script at the freeze, or first held after it. */
  pausedAtReadout: number;
  /** Excluded: it went away while held at its main script. */
  diedPaused: number;
  /** Read and credited to the visit's main document. */
  readable: number;
  /** Read in full but not credited: its snapshot is in `unscopedSnapshots`. */
  ownerUnscoped: number;
  /** Unread: held at its main script, but the install failed or came back late. */
  installFailed: number;
  /** Unread: reached late, so its code ran before the observer could precede it. */
  attachedLate: number;
  /**
   * Unread: never paused by the end of the drain, or gone without a pause
   * after a script of it was seen parsed or after living past the bound.
   */
  unreached: number;
  /** Unread, as for a dedicated worker. */
  cutOff: number;
  streamBroken: number;
  channelLostAlive: number;
  /** Unread: discovered on the visit channel, never reported by the attacher. */
  unattached: number;
  /** Neither read nor unread: never reached, and gone within SHARED_WORKER_ENDED_AT_ONCE_MS. */
  endedAtOnce: number;
};

/**
 * Every term of one readout, so each can be asserted. Excluded workers ran no
 * page code at the freeze or belong to a document that is no longer current;
 * unread ones ran page code whose evidence cannot be read in full; unscoped
 * ones were read in full, but their document could be shown neither current
 * nor replaced.
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
  /**
   * Excluded: its owner document was not in the page's frame trees read at
   * the freeze, whatever its stream state (cut off, broken, or never
   * installed), and whether or not its detach had arrived.
   */
  ownerReplaced: number;
  /** Read: one cumulative snapshot. */
  readable: number;
  /** Unread: released without the observer known to precede its first statement. */
  installFailed: number;
  /** Unread: already running when it attached. */
  attachedLate: number;
  /**
   * Unread: its last word at its freeze point was "open" and no closed
   * snapshot followed within the drain, or, running, it never answered the
   * readout barrier within the drain.
   */
  cutOff: number;
  /** Unread: a sequence gap, an oversized or malformed payload, or the realm's own `null`. */
  streamBroken: number;
  /** Unread: the channel closed while the worker was alive, so its later emissions cannot arrive. */
  channelLostAlive: number;
  /**
   * Unscoped: its whole snapshot is in hand, but its owner document could not
   * be recorded (no answer, or one the worker did not vouch for, by the end of
   * the drain), or the frame trees at the freeze could not be read. Each one's
   * snapshot is in `unscopedSnapshots`, never in `unreadRealms`: the
   * observer's collection counts it unread unless it records nothing.
   */
  ownerUnknown: number;
  /** Unread: witnessed by the browser but never attached by the channel. */
  unattachedDedicated: number;
  /** The shared workers of the scan's browser context, term by term. */
  sharedWorkers: SharedWorkerFingerprintReadoutDiagnostics;
};

export type WorkerFingerprintRealmReadout = FingerprintWorkerRealmReadout & {
  readonly diagnostics: WorkerFingerprintReadoutDiagnostics;
};

type OwnerDocument = { frameId: string; loaderId: string };

/** The page's documents at a freeze: every frame's loader, and the main frame's document. */
type DocumentsAtFreeze = {
  loaders: Map<string, string>;
  main: { frameId: string; loaderId: string; securityOrigin: string | null } | null;
};

/**
 * One worker's freeze, when its state at the call is not final. A running
 * worker's freeze point is its answer to the readout barrier, and until that
 * answer `freezeSeq` is null. Once answered, the slot holds the closed
 * snapshot the answer found, or takes the first closed snapshot with a
 * sequence after `freezeSeq`.
 */
type FreezeSlot = { barrier: "pending" | "answered"; freezeSeq: number | null; snapshot: string | null };

type WorkerRealmRecord = {
  readonly worker: AttachedWorker;
  /** The channel the worker's commands go over: the dedicated channel, or a shared visit's channel through the attacher. */
  channel: DevtoolsChannel | null;
  /** Null until the install reached its terminal record. */
  install: "installed" | "failed" | "attached-late" | null;
  /**
   * Null when no read was started, "reading" while the read or the worker's
   * vouch for it is in flight, and "unknown" when it gave no vouched answer.
   */
  owner: OwnerDocument | "unknown" | "reading" | null;
  /** The owner read, once started, which a nested worker's own read follows. */
  ownerRead: Promise<OwnerDocument | "unknown"> | null;
  /** Settles when the browser detaches the worker's target. */
  readonly gone: Promise<void>;
  markGone: () => void;
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
      reason: "installFailed" | "attachedLate" | "streamBroken" | "channelLostAlive" | "unreached";
    }
  | { record: WorkerRealmRecord; state: "closed"; snapshot: string }
  | { record: WorkerRealmRecord; state: "waiting"; slot: FreezeSlot }
  | { record: WorkerRealmRecord; state: "ended-at-once" }
  /** A shared worker attached and not yet paused at the freeze: its state is its first move after it. */
  | { record: WorkerRealmRecord; state: "reaching" }
  /**
   * A shared worker the main thread sees held at its main script. That view
   * lags the attacher's thread, which may already have found the hold broken,
   * or may find it so moments later, so it is unsettled until the worker's
   * next move (released, late or detached): see resolveHeld.
   */
  | { record: WorkerRealmRecord; state: "held" };

/**
 * The fingerprint observer's installer on the worker realm channel, in every
 * arm, and the ledger of what each worker realm streamed back. It runs after
 * the GPC installer in the GPC arm's pause, so the GPC outcome never depends
 * on it; for the same reason the owner document is read here, after GPC, and
 * not by the channel before every installer. Only the install itself holds
 * the worker: the owner read runs beside it and is never waited for.
 *
 * Dedicated workers on the channel. The channel does not receive shared
 * workers from a page session; should one ever attach there, nothing is
 * installed into it on that path, and it stays in the channel's shared attach
 * count. Shared workers come from the attacher instead (`watchSharedWorkers`),
 * and the readout counts each one once: by the attacher's record, joined with
 * the channel's discovery witness by target.
 */
export class FingerprintWorkerRealmInstaller implements WorkerRealmInstaller {
  /** The sink's name on every worker session of this scan; random, so no page can guess it. */
  readonly sinkName: string;
  /** Opens every emission of this scan; anything else on the sink is ignored. */
  readonly capability: string;
  /** Installs into dedicated workers on the channel's path, and never into a shared one there. */
  readonly workerKinds = ["dedicated"] as const;
  private readonly expression: string;
  private readonly sharedExpression: string;
  /** Attached workers whose install reached its terminal record. */
  private readonly settledWorkers = new WeakSet<AttachedWorker>();
  private readonly records = new Map<string, WorkerRealmRecord>();
  /** Shared workers the attacher reported, by session on the attacher's connection. */
  private readonly sharedRecords = new Map<string, WorkerRealmRecord>();
  private readonly changeWaiters = new Set<() => void>();
  private installedWorkerCount = 0;
  private installFailedWorkerCount = 0;
  private sharedInstalledWorkerCount = 0;
  private sharedInstallFailedWorkerCount = 0;
  private sharedLateWorkerCount = 0;
  private channelLost = false;
  /** The shared workers' visit channel, or null when the attacher was unavailable. */
  private sharedVisit: SharedWorkerVisitChannel | null = null;

  /** `firstPartySiteKey` is the value the scan's documents get from their init script. */
  constructor(firstPartySiteKey: string, options: { randomBytes?: Uint8Array } = {}) {
    const randomBytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(24));
    if (randomBytes.length < 16) throw new Error("The worker realm sink requires at least 128 bits of capability entropy.");
    this.capability = bytesToHex(randomBytes);
    this.sinkName = `__siteBehaviorLabFingerprintSink_${this.capability.slice(0, 16)}`;
    const sink = { sinkName: this.sinkName, capability: this.capability };
    this.expression = fingerprintObserverWorkerInstallExpression(firstPartySiteKey, sink, "dedicated-worker");
    this.sharedExpression = fingerprintObserverWorkerInstallExpression(firstPartySiteKey, sink, "shared-worker");
  }

  async install(worker: AttachedWorker, channel: DevtoolsChannel): Promise<void> {
    if (worker.kind !== "dedicated") return;
    const record = this.recordFor(worker, this.records, channel);
    // Beside the install, never awaited here: its answer comes from the page's
    // main thread, and the worker must not wait on the page's long task or
    // pending navigation to run.
    this.startOwnerRead(record, channel);
    if (!worker.waitingForDebugger) {
      // Already running when it attached: its first statements ran before any
      // install could, so nothing is installed and its realm is unread.
      this.concludeWorker(worker, "attached-late");
      return;
    }
    // One burst on the worker's own session, processed in order by the
    // browser: the sink, then the observer, which finds the sink already on
    // its global. The worker stays held for these two answers only.
    const answers = await Promise.all(
      installCommands(this.sinkName, this.expression).map((command) =>
        channel.send(command.method, command.params, worker.sessionId).then(
          (value): SettledCommandAnswer => ({ status: "fulfilled", value }),
          (error: unknown): SettledCommandAnswer => ({ status: "rejected", reason: String(error) })
        )
      )
    );
    // Terminal here, while the channel still holds the worker. A watchdog or
    // settle that concluded the worker first already recorded the install as
    // failed, and this late answer cannot upgrade it.
    this.concludeWorker(worker, installAnswered(record, answers) ? "installed" : "failed");
  }

  /** A worker concluded without an answer of its own is uninstrumented. After an answer this is a no-op. */
  concluded(worker: AttachedWorker): void {
    if (worker.kind !== "dedicated") return;
    this.recordFor(worker, this.records, null);
    this.concludeWorker(worker, "failed");
  }

  /**
   * The commands the attacher's thread sends, in order, in each shared
   * worker's main-script pause: the same sink and the same observer as a
   * dedicated worker's install, with the shared-worker realm.
   */
  sharedWorkerInstallCommands(): readonly SharedWorkerInstallCommand[] {
    return installCommands(this.sinkName, this.sharedExpression);
  }

  /** Hears every shared worker of the visit's context the attacher holds, reads and releases. */
  watchSharedWorkers(visit: SharedWorkerVisitChannel): void {
    if (this.sharedVisit !== null) throw new Error("This installer already watches a shared-worker visit.");
    this.sharedVisit = visit;
    visit.onWorkerChange((worker, change, answers) => this.onSharedWorkerChange(worker, change, answers));
    visit.channel.onEvent((event) => this.onRealmEvent(event, this.sharedRecords));
    visit.channel.onClose(() => {
      for (const record of this.sharedRecords.values()) {
        if (!record.worker.detached) record.lostWithChannel = true;
      }
      this.announceChange();
    });
  }

  onEvent(event: DevtoolsEvent): void {
    if (event.method === "Target.attachedToTarget" || event.method === "Target.targetCreated") {
      // A drain may be waiting for the channel's attaches to reach the
      // witness, or for the attacher to report a shared worker the channel's
      // discovery just saw.
      this.announceChange();
      return;
    }
    this.onRealmEvent(event, this.records);
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

  sharedInstallDiagnostics(): SharedWorkerFingerprintInstallDiagnostics {
    return {
      installedWorkerCount: this.sharedInstalledWorkerCount,
      installFailedWorkerCount: this.sharedInstallFailedWorkerCount,
      lateWorkerCount: this.sharedLateWorkerCount
    };
  }

  /**
   * Each shared worker's last closed snapshot as the host holds it now, by
   * script URL, for the operator's real-site check that names which realm
   * recorded what. Never read by the scanner.
   */
  sharedWorkerSnapshotsForTests(): readonly { url: string; hold: string; lastClosed: string | null }[] {
    return [...this.sharedRecords.values()].map((record) => {
      const worker = record.worker as AttachedSharedWorker;
      return { url: worker.url, hold: worker.hold, lastClosed: record.lastClosed };
    });
  }

  /**
   * The worker realms at one freeze, run at exactly the instants the page
   * realm is read (the passive boundary and the final state read).
   *
   * 1. The freeze is this call, before its first await. A worker that is
   *    excluded or unread at the call stays so. A worker that has gone has
   *    its whole stream in hand, and its last word so far is its state. A
   *    running worker's emissions may still be in flight, since delivery can
   *    lag the realm by seconds under an emission backlog, so its last word
   *    so far is not its state at the freeze: it gets the readout barrier,
   *    and its state is its last word when the barrier's answer arrives,
   *    which is behind everything the realm emitted before answering.
   *    The page's frame trees are read at the call too, so that each
   *    worker's scope is judged at the freeze and not at the end of the
   *    drain, when a frame may have navigated since.
   * 2. The drain, bounded by `settleMs`: wait until the channel's attaches
   *    reach the witness's count at the freeze (a witnessed worker not yet
   *    attached is still paused, not lost), for each running worker's
   *    answer, for each owner read still in flight, and, for each worker
   *    whose last word at its freeze point was "open", for the first closed
   *    snapshot after it. That is a page evaluate waiting for the current
   *    task to end. The drain never waits for a worker's latest state to be
   *    closed, which a worker drawing every frame could starve, and a worker
   *    without its answer or its closed snapshot at the bound is cut off,
   *    never read at an older state. It also waits for the attacher to
   *    report each shared worker the channel's discovery saw, and for each
   *    shared worker attached but not yet paused at the freeze to make its
   *    first move: a pause at its main script means it ran nothing before
   *    the freeze, anything else that it may have. A shared worker the main
   *    thread sees held at its main script, at the freeze, after reaching, or
   *    attached during the drain, waits for its next move too: the attacher's
   *    thread may already have found that hold broken, its "late" report
   *    still in flight, and a broken hold ran its main script unobserved, so
   *    it is unread. Released, died while held, or still held at the bound,
   *    it ran nothing before the freeze and is excluded.
   * 3. Every dedicated worker, attached or gone, is checked against the frame
   *    trees read at the freeze first: one whose document was not current
   *    then is excluded whatever state its stream was left in, and one whose
   *    document was current then is classified by its state, even if it has
   *    gone since. A worker that went mid-task after the freeze is therefore
   *    cut off, a disclosed loss, never excluded. Attached is not taken to
   *    mean current: a worker whose document was just replaced can still be
   *    attached, its detach not yet arrived. A worker with its whole snapshot
   *    in hand whose document can be shown neither current nor replaced is
   *    returned unscoped, for the collection to count. A shared worker is
   *    classified by its state first and never excluded for its document:
   *    read in full, it is credited only under the ownership rule in the
   *    module's docblock, and unscoped otherwise.
   *
   * Shared workers are counted for the whole visit so far, once each: the
   * union of the attacher's reports and the channel's discovery after the
   * drain, joined by target.
   *
   * Never rejects. With no channel (it was never established), every
   * witnessed dedicated worker is unread, and no shared worker is witnessed.
   */
  async readout(options: {
    session: DedicatedWorkerAttachSession | null;
    witness: Pick<DedicatedWorkerWitness, "count">;
    settleMs: number;
  }): Promise<WorkerFingerprintRealmReadout> {
    const observedDedicated = options.witness.count();
    // Sent now, before anything is awaited: the page's documents at the
    // freeze. Its answer is awaited only after the drain.
    const documentsAtFreeze = currentDocuments(options.session);
    const frozen: FrozenRealm[] = [];
    for (const record of this.records.values()) frozen.push(this.freeze(record));
    const sharedFrozen: FrozenRealm[] = [];
    for (const record of this.sharedRecords.values()) sharedFrozen.push(this.freezeShared(record));
    const frozenShared = new Set(sharedFrozen.map((realm) => realm.record));
    // A dedicated worker this installer has neither installed nor heard
    // concluded is still held by an installer before it (GPC, in its arm).
    const heldBeforeInstall = Math.max(
      0,
      (options.session?.attachCounts().attachedDedicatedWorkerCount ?? 0) - frozen.length
    );

    try {
      await this.drain(options.session, observedDedicated, frozen, sharedFrozen, options.settleMs);
    } finally {
      for (const realm of [...frozen, ...sharedFrozen]) {
        if (realm.state === "waiting") realm.record.slots.delete(realm.slot);
      }
    }
    const documents = await documentsAtFreeze;
    const loaders = documents === null ? null : documents.loaders;

    const attachCounts = options.session?.attachCounts() ?? {
      attachedDedicatedWorkerCount: 0,
      attachedNestedDedicatedWorkerCount: 0,
      attachedSharedWorkerCount: 0
    };
    const shared: SharedWorkerFingerprintReadoutDiagnostics = {
      discovered: 0,
      attached: 0,
      pausedAtReadout: 0,
      diedPaused: 0,
      readable: 0,
      ownerUnscoped: 0,
      installFailed: 0,
      attachedLate: 0,
      unreached: 0,
      cutOff: 0,
      streamBroken: 0,
      channelLostAlive: 0,
      unattached: 0,
      endedAtOnce: 0
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
      unattachedDedicated: Math.max(0, observedDedicated - attachCounts.attachedDedicatedWorkerCount),
      sharedWorkers: shared
    };

    // Scope before state. A worker of a document the page did not show at the
    // freeze ran no code of the page's documents then, so it is excluded,
    // like a replaced frame, whatever its stream says: cut off by the
    // navigation mid-task, broken, or never installed. Only a known owner
    // shown replaced in frame trees that could be read excludes it; anything
    // less leaves the worker to the term its state gives it.
    const ownerOf = (record: WorkerRealmRecord): OwnerDocument | null =>
      typeof record.owner === "object" ? record.owner : null;

    const readableSnapshots: string[] = [];
    const unscopedSnapshots: string[] = [];
    for (const realm of frozen) {
      if (realm.state === "excluded") {
        diagnostics[realm.reason] += 1;
        continue;
      }
      const owner = ownerOf(realm.record);
      if (owner !== null && loaders !== null && loaders.get(owner.frameId) !== owner.loaderId) {
        diagnostics.ownerReplaced += 1;
        continue;
      }
      if (realm.state === "unread") {
        if (realm.reason !== "unreached") diagnostics[realm.reason] += 1;
        continue;
      }
      // Shared-worker states only; a dedicated realm never takes them.
      if (realm.state === "ended-at-once" || realm.state === "reaching" || realm.state === "held") continue;
      const snapshot = realm.state === "closed" ? realm.snapshot : realm.slot.snapshot;
      if (snapshot === null) {
        // No whole state for the freeze when the drain ended: open at its
        // freeze point and still open (terminated mid-task, or a task longer
        // than the bound), or its barrier's answer never came (a delivery
        // backlog longer than the bound), or its stream broke or its channel
        // closed first.
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
      // A realm with its snapshot in hand still needs an owner shown current:
      // one with no vouched owner, or with frames at the freeze that could not
      // be read, cannot be shown current or replaced. It is never credited and
      // never excluded silently: the collection reads its snapshot unscoped.
      if (owner === null || loaders === null) {
        diagnostics.ownerUnknown += 1;
        unscopedSnapshots.push(snapshot);
        continue;
      }
      diagnostics.readable += 1;
      readableSnapshots.push(snapshot);
    }

    // Shared workers: state first, then the ownership rule. The attacher's
    // records, frozen at the call or attached during the drain, joined with
    // the channel's discovery witness by target, each counted once.
    const discovered = options.session?.discoveredSharedWorkerTargets() ?? new Set<string>();
    shared.discovered = discovered.size;
    const reportedTargets = new Set<string>();
    const sharedRealms: FrozenRealm[] = [...sharedFrozen];
    for (const record of this.sharedRecords.values()) {
      // Attached after the freeze: whatever it did came after the call,
      // unless it was not held at its main script.
      if (!frozenShared.has(record)) sharedRealms.push(this.freezeShared(record, { attachedAfterFreeze: true }));
    }
    for (const realm of sharedRealms) {
      const worker = realm.record.worker as AttachedSharedWorker;
      reportedTargets.add(worker.targetId);
      shared.attached += 1;
      const reached = realm.state === "reaching" ? this.resolveReaching(realm.record) : realm;
      // A hold settles by the worker's next move by the end of the drain.
      const resolved = reached.state === "held" ? this.resolveHeld(reached.record) : reached;
      if (resolved.state === "excluded") {
        shared[resolved.reason] += 1;
        continue;
      }
      if (resolved.state === "ended-at-once") {
        shared.endedAtOnce += 1;
        continue;
      }
      if (resolved.state === "unread") {
        shared[resolved.reason] += 1;
        continue;
      }
      if (resolved.state === "reaching") {
        shared.unreached += 1;
        continue;
      }
      const snapshot = resolved.state === "closed" ? resolved.snapshot : resolved.slot.snapshot;
      if (snapshot === null) {
        if (resolved.record.lostWithChannel) shared.channelLostAlive += 1;
        else if (resolved.record.broken) shared.streamBroken += 1;
        else shared.cutOff += 1;
        continue;
      }
      if (snapshot === "null") {
        shared.streamBroken += 1;
        continue;
      }
      if (sharedWorkerCredited(worker, documents)) {
        shared.readable += 1;
        readableSnapshots.push(snapshot);
      } else {
        shared.ownerUnscoped += 1;
        unscopedSnapshots.push(snapshot);
      }
    }
    for (const targetId of discovered) if (!reportedTargets.has(targetId)) shared.unattached += 1;

    return {
      readableSnapshots,
      unscopedSnapshots,
      unreadRealms:
        diagnostics.installFailed +
        diagnostics.attachedLate +
        diagnostics.cutOff +
        diagnostics.streamBroken +
        diagnostics.channelLostAlive +
        diagnostics.unattachedDedicated +
        shared.installFailed +
        shared.attachedLate +
        shared.unreached +
        shared.cutOff +
        shared.streamBroken +
        shared.channelLostAlive +
        shared.unattached,
      sharedWorkersEndedAtOnce: shared.endedAtOnce,
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
    return this.freezeStream(record);
  }

  /**
   * A shared worker at the freeze. It is held by its main-script pause, not
   * from its start, so the state before that pause is not "paused": an
   * attached worker with no pause yet is reaching, and its first move
   * decides. One attached after the call was not yet paused at it, so only
   * its hold at the main script can show it ran nothing then.
   */
  private freezeShared(record: WorkerRealmRecord, options: { attachedAfterFreeze?: boolean } = {}): FrozenRealm {
    const worker = record.worker as AttachedSharedWorker;
    if (record.lostWithChannel) return { record, state: "unread", reason: "channelLostAlive" };
    if (worker.detachedWhilePaused) return { record, state: "excluded", reason: "diedPaused" };
    // Held as far as the main thread knows: its next move decides (resolveHeld).
    if (worker.hold === "held") return { record, state: "held" };
    if (worker.hold === "late") return { record, state: "unread", reason: "attachedLate" };
    if (worker.hold === "pending") {
      if (worker.detached) {
        // Gone with no pause: it ended at once only when the attacher never
        // saw it run and its life fits the bound.
        return sharedWorkerEndedAtOnce(worker)
          ? { record, state: "ended-at-once" }
          : { record, state: "unread", reason: "unreached" };
      }
      return { record, state: "reaching" };
    }
    // Released after its hold at its main script.
    if (options.attachedAfterFreeze) return { record, state: "excluded", reason: "pausedAtReadout" };
    if (record.install !== "installed") return { record, state: "unread", reason: "installFailed" };
    return this.freezeStream(record);
  }

  /** A shared worker reaching at the freeze, by its first move by the end of the drain. */
  private resolveReaching(record: WorkerRealmRecord): FrozenRealm {
    const worker = record.worker as AttachedSharedWorker;
    if (record.lostWithChannel) return { record, state: "unread", reason: "channelLostAlive" };
    // Paused at its main script after the freeze: it ran nothing before it,
    // unless that hold broke, which only its next move shows (resolveHeld).
    if (worker.hold === "held") return { record, state: "held" };
    if (worker.hold === "released") return { record, state: "excluded", reason: "pausedAtReadout" };
    if (worker.hold === "late") return { record, state: "unread", reason: "attachedLate" };
    if (worker.detached) {
      return sharedWorkerEndedAtOnce(worker)
        ? { record, state: "ended-at-once" }
        : { record, state: "unread", reason: "unreached" };
    }
    return { record, state: "reaching" };
  }

  /**
   * A shared worker seen held at its main script, by its next move by the end
   * of the drain. The main thread's view of a hold lags the attacher's
   * thread, so a "late" report behind "held" means the hold broke before the
   * install answered (resumed-while-held): its main script ran unobserved,
   * and it is unread. Released, died while held, or still held at the bound,
   * it ran nothing before the freeze and is excluded, as it always was. Still
   * held when the attacher's channel closed, it made no move the readout
   * saw, so the hold the main thread last saw may already have broken: it
   * is unread, as a worker the closed channel left running is at the
   * freeze. This only ever turns an exclusion into an unread realm.
   */
  private resolveHeld(record: WorkerRealmRecord): Extract<FrozenRealm, { state: "unread" | "excluded" }> {
    const worker = record.worker as AttachedSharedWorker;
    if (worker.hold === "late") return { record, state: "unread", reason: "attachedLate" };
    if (worker.hold === "held" && record.lostWithChannel) return { record, state: "unread", reason: "channelLostAlive" };
    return { record, state: "excluded", reason: "pausedAtReadout" };
  }

  /** Whether a held shared worker has made its next move: released, late or detached. */
  private heldSettled(record: WorkerRealmRecord): boolean {
    const worker = record.worker as AttachedSharedWorker;
    return worker.hold !== "held" || worker.detached;
  }

  /** An installed worker's state at the freeze, from its stream; the same for both kinds. */
  private freezeStream(record: WorkerRealmRecord): FrozenRealm {
    const worker = record.worker;
    if (record.broken || record.lastWord === null) return { record, state: "unread", reason: "streamBroken" };
    if (worker.detached) {
      // Gone: it can emit nothing more. A task it left open still gets the
      // drain's wait for that task's closed snapshot.
      if (record.lastWord === "closed" && record.lastClosed !== null) {
        return { record, state: "closed", snapshot: record.lastClosed };
      }
      const slot: FreezeSlot = { barrier: "answered", freezeSeq: record.lastSeq, snapshot: null };
      record.slots.add(slot);
      return { record, state: "waiting", slot };
    }
    const slot: FreezeSlot = { barrier: "pending", freezeSeq: null, snapshot: null };
    record.slots.add(slot);
    const answer = () => this.answerBarrier(record, slot);
    // An error while the worker is still attached answers nothing: the slot
    // waits for the worker's detach, the channel's loss, or the bound.
    record.channel
      ?.send(READOUT_BARRIER_METHOD, {}, worker.sessionId)
      .then(answer, () => {
        if (worker.detached) answer();
      });
    return { record, state: "waiting", slot };
  }

  /**
   * A running worker's freeze point: the host now holds everything the realm
   * emitted before it answered the barrier, or the worker has gone. A closed
   * last word is the state at the freeze; an open one waits for the task's
   * closed snapshot.
   */
  private answerBarrier(record: WorkerRealmRecord, slot: FreezeSlot): void {
    if (slot.barrier !== "pending") return;
    slot.barrier = "answered";
    if (record.lastWord === "closed" && record.lastClosed !== null) slot.snapshot = record.lastClosed;
    else slot.freezeSeq = record.lastSeq;
    this.announceChange();
  }

  private async drain(
    session: DedicatedWorkerAttachSession | null,
    observedDedicated: number,
    frozen: readonly FrozenRealm[],
    sharedFrozen: readonly FrozenRealm[],
    settleMs: number
  ): Promise<void> {
    const realmSettled = (realm: FrozenRealm): boolean =>
      realm.state === "excluded" ||
      (realm.record.owner !== "reading" &&
        (realm.state !== "waiting" ||
          realm.slot.snapshot !== null ||
          realm.record.broken ||
          realm.record.lostWithChannel));
    const dedicatedDrained = (): boolean => {
      if (this.channelLost || session === null || session.isChannelLost()) return true;
      if (session.attachCounts().attachedDedicatedWorkerCount < observedDedicated) return false;
      return frozen.every(realmSettled);
    };
    const frozenShared = new Set(sharedFrozen.map((realm) => realm.record));
    const sharedRealmSettled = (realm: FrozenRealm): boolean => {
      if (realm.state === "held") return this.heldSettled(realm.record);
      if (realm.state !== "reaching") return realmSettled(realm);
      // Its first move, and then, if that was a hold, the next one.
      const reached = this.resolveReaching(realm.record);
      if (reached.state === "reaching") return false;
      return reached.state !== "held" || this.heldSettled(realm.record);
    };
    const sharedDrained = (): boolean => {
      const visit = this.sharedVisit;
      if (visit === null || visit.isChannelLost()) return true;
      const reported = new Set<string>();
      for (const record of this.sharedRecords.values()) reported.add((record.worker as AttachedSharedWorker).targetId);
      for (const targetId of session?.discoveredSharedWorkerTargets() ?? []) if (!reported.has(targetId)) return false;
      // A worker attached during the drain and held now makes its next move
      // too, before it is classified.
      for (const record of this.sharedRecords.values()) {
        if (!frozenShared.has(record) && !this.heldSettled(record)) return false;
      }
      return sharedFrozen.every(sharedRealmSettled);
    };
    const drained = () => dedicatedDrained() && sharedDrained();
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

  /** A realm's stream and its detach, for the records of the channel it came on. */
  private onRealmEvent(event: DevtoolsEvent, records: Map<string, WorkerRealmRecord>): void {
    if (event.method === "Target.detachedFromTarget") {
      // A worker that has gone can emit nothing more, so what the host holds
      // is its whole stream: a barrier still waiting on it is answered by the
      // detach, which the channel recorded before this.
      const record = typeof event.params.sessionId === "string" ? records.get(event.params.sessionId) : undefined;
      if (!record) return;
      for (const slot of record.slots) this.answerBarrier(record, slot);
      record.markGone();
      this.announceChange();
      return;
    }
    if (event.method !== "Runtime.bindingCalled" || event.params.name !== this.sinkName) return;
    const record = typeof event.sessionId === "string" ? records.get(event.sessionId) : undefined;
    if (!record) return;
    this.receive(record, event.params.payload);
    this.announceChange();
  }

  private onSharedWorkerChange(
    worker: AttachedSharedWorker,
    change: SharedWorkerChange,
    answers: readonly SettledCommandAnswer[] | null
  ): void {
    const record = this.recordFor(worker, this.sharedRecords, this.sharedVisit?.channel ?? null);
    if (change === "installed") {
      // Judged by the dedicated install's own rule, on the answers the thread
      // sent back while the worker was still held. No answers means the
      // thread's watchdog let it run first.
      this.concludeShared(worker, answers !== null && installAnswered(record, answers) ? "installed" : "failed");
    } else if (change === "late") {
      this.concludeShared(worker, "attached-late");
    }
    this.announceChange();
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
      if (slot.snapshot === null && slot.freezeSeq !== null && sequence > slot.freezeSeq) slot.snapshot = snapshot;
    }
  }

  /** Starts the worker's one owner read; its result lands on the record whenever it answers. */
  private startOwnerRead(record: WorkerRealmRecord, channel: DevtoolsChannel): void {
    if (record.ownerRead !== null) return;
    record.owner = "reading";
    record.ownerRead = this.readOwner(record, channel).then((owner) => {
      record.owner = owner;
      this.announceChange();
      return owner;
    });
  }

  /**
   * The worker's owner document: the attach's `parentFrameId`, found in
   * `Page.getFrameTree` on the session the attach arrived on (the page, or
   * the out-of-process frame that started it). A worker started by another
   * worker has its parent's owner, once its parent's read has answered.
   *
   * The tree is answered on the page's main thread: at once on an idle page,
   * after the current task on a busy one, and only once a pending navigation
   * has committed or been abandoned. An answer can therefore describe the
   * tree after a navigation replaced the worker's owner, with the new
   * document's loader in the owner's frame. The worker vouches for the
   * answer: a command on the worker's own session, sent once the answer has
   * arrived, is answered only if the worker is still running, so its owner
   * was still current when the tree was read. A worker whose document is
   * replaced stops answering at the replacement, before the new document's
   * tree can be read; it gives no vouch, and its owner stays unknown, a
   * disclosed loss rather than a guess either way. That is a platform
   * assumption, which the real-Chromium tests pin for pending same-origin and
   * cross-site navigations, and for a long task, a 204 and a download, whose
   * late answers are vouched.
   */
  private async readOwner(record: WorkerRealmRecord, channel: DevtoolsChannel): Promise<OwnerDocument | "unknown"> {
    const worker = record.worker;
    if (worker.nested) {
      const parent = worker.arrivedOnSessionId === null ? undefined : this.records.get(worker.arrivedOnSessionId);
      return parent?.ownerRead ?? "unknown";
    }
    if (worker.ownerFrameId === null || worker.arrivedOnSessionId === null) return "unknown";
    try {
      const tree = await channel.send("Page.getFrameTree", {}, worker.arrivedOnSessionId);
      const loaderId = frameLoaderIds(tree.frameTree).get(worker.ownerFrameId);
      if (loaderId === undefined || worker.detached) return "unknown";
      // A detach cancels the vouch: the browser answers nothing more on the
      // session of a worker that has gone.
      const vouched = await Promise.race([
        channel.send(READOUT_BARRIER_METHOD, {}, worker.sessionId).then(() => true),
        record.gone.then(() => false)
      ]);
      return vouched ? { frameId: worker.ownerFrameId, loaderId } : "unknown";
    } catch {
      return "unknown";
    }
  }

  private recordFor(
    worker: AttachedWorker,
    records: Map<string, WorkerRealmRecord>,
    channel: DevtoolsChannel | null
  ): WorkerRealmRecord {
    let record = records.get(worker.sessionId);
    if (!record) {
      let markGone: () => void = () => undefined;
      const gone = new Promise<void>((resolve) => {
        markGone = resolve;
      });
      if (worker.detached) markGone();
      record = {
        worker,
        channel,
        install: null,
        owner: null,
        ownerRead: null,
        gone,
        markGone,
        lastSeq: 0,
        lastWord: null,
        lastClosed: null,
        broken: false,
        lostWithChannel:
          records === this.sharedRecords ? (this.sharedVisit?.isChannelLost() ?? false) && !worker.detached : this.channelLost,
        slots: new Set()
      };
      records.set(worker.sessionId, record);
    } else if (record.channel === null && channel !== null) {
      record.channel = channel;
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

  /** Exactly one terminal state per shared worker the attacher reported held or late. */
  private concludeShared(worker: AttachedWorker, install: "installed" | "failed" | "attached-late"): void {
    if (this.settledWorkers.has(worker)) return;
    this.settledWorkers.add(worker);
    const record = this.sharedRecords.get(worker.sessionId);
    if (record) record.install = install;
    if (install === "installed") this.sharedInstalledWorkerCount += 1;
    else if (install === "failed") this.sharedInstallFailedWorkerCount += 1;
    else this.sharedLateWorkerCount += 1;
  }
}

/**
 * The install's commands, one burst on the worker's own session, processed in
 * order by the browser: the sink, then the observer, which finds the sink
 * already on its global. The dedicated install sends them on the channel; the
 * attacher's thread sends the same list in a shared worker's main-script
 * pause.
 */
function installCommands(sinkName: string, expression: string): readonly SharedWorkerInstallCommand[] {
  return [
    { method: "Runtime.addBinding", params: { name: sinkName } },
    { method: "Runtime.evaluate", params: { expression, returnByValue: true } }
  ];
}

/**
 * Whether the install's two answers show the observer in place: the sink
 * added, the evaluation answering `true` without an exception, and the
 * realm's first closed snapshot already received. That snapshot is emitted
 * during the evaluation, so it precedes the evaluation's answer on the
 * worker's session; an answer without it means the realm cannot reach the
 * host.
 */
function installAnswered(record: WorkerRealmRecord, answers: readonly SettledCommandAnswer[]): boolean {
  const [bound, evaluated] = answers;
  if (answers.length !== 2 || bound?.status !== "fulfilled" || evaluated?.status !== "fulfilled") return false;
  const result = evaluated.value.result as { value?: unknown } | undefined;
  return evaluated.value.exceptionDetails === undefined && result?.value === true && record.lastSeq >= 1 && !record.broken;
}

/**
 * Whether a shared worker read in full is credited to the visit's main
 * document: its creation document, read by the attacher on its own connection
 * when the worker attached, is the main frame's document at the freeze, and
 * its script's origin is that document's origin. A `blob:` URL carries its
 * creator's origin, and a `data:` URL's is opaque and never matches.
 */
function sharedWorkerCredited(worker: AttachedSharedWorker, documents: DocumentsAtFreeze | null): boolean {
  const main = documents?.main ?? null;
  const created = worker.creationDocument;
  if (main === null || created === null || main.securityOrigin === null) return false;
  if (created.frameId !== main.frameId || created.loaderId !== main.loaderId) return false;
  const origin = scriptOrigin(worker.url);
  return origin !== null && origin === main.securityOrigin;
}

function scriptOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" || origin === "" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The page's current documents, as frame id to loader id, and its main
 * frame's document, from the channel's current frame trees. Null when there
 * is no channel or the trees could not all be read.
 */
async function currentDocuments(session: DedicatedWorkerAttachSession | null): Promise<DocumentsAtFreeze | null> {
  if (session === null) return null;
  const trees = await session.currentFrameTrees();
  if (trees === null) return null;
  const loaders = new Map<string, string>();
  for (const tree of trees) {
    for (const [frameId, loaderId] of frameLoaderIds(tree)) loaders.set(frameId, loaderId);
  }
  // The page target's tree comes first, and its root is the main frame.
  const root = (trees[0] as { frame?: { id?: unknown; loaderId?: unknown; securityOrigin?: unknown } } | undefined)?.frame;
  const main =
    root && typeof root.id === "string" && typeof root.loaderId === "string"
      ? {
          frameId: root.id,
          loaderId: root.loaderId,
          securityOrigin: typeof root.securityOrigin === "string" ? root.securityOrigin : null
        }
      : null;
  return { loaders, main };
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

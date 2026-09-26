import type { AttachedWorker, DevtoolsChannel, WorkerRealmInstaller } from "./devtools-worker-channel";
import { fingerprintObserverInitScript, type FingerprintObserverRealmArgs } from "./fingerprint-observer";

/**
 * The fingerprint observer inside dedicated Web Worker realms.
 *
 * A worker's canvas, font and WebGL calls run in the worker's own realm, where
 * the document observer's wrappers never reach. The worker realm channel
 * (lib/devtools-worker-channel.ts) holds each dedicated worker of the measured
 * page paused before its first statement; this module puts the observer into
 * that paused realm.
 *
 * ONE SOURCE. What runs in the worker is the document observer itself,
 * `fingerprintObserverInitScript`, serialized and called with the worker realm
 * argument. This module restates no wrapper, threshold or heuristic, and
 * imports nothing else from the observer, so a worker's calls are recorded by
 * exactly the code that records a document's.
 *
 * CRASH HAZARD. The install runs while the worker's global is only partly
 * initialized, and there a read of a lazily initialized global or a WebGL
 * context creation crashes the renderer, destroying the measured page in
 * every arm. The observer's docblock states the rule, and
 * lib/worker-fingerprint-realm.test.ts installs this exact expression into
 * paused workers of every shape in real Chromium and fails on a crash.
 */

/** Serialized once per process: the same text for every worker of every scan. */
const FINGERPRINT_OBSERVER_SOURCE = fingerprintObserverInitScript.toString();

const WORKER_REALM_ARGS: FingerprintObserverRealmArgs = { realm: "dedicated-worker" };

/**
 * The exact expression evaluated inside a paused dedicated worker: the
 * observer's own function, called with the scan's first-party site key (the
 * value the document's init script gets) and the worker realm argument. It
 * evaluates to `true` only when the whole observer ran inside the realm.
 */
export function fingerprintObserverWorkerInstallExpression(firstPartySiteKey: string): string {
  return `(${FINGERPRINT_OBSERVER_SOURCE})(${JSON.stringify(firstPartySiteKey)}, ${JSON.stringify(WORKER_REALM_ARGS)})`;
}

export type WorkerFingerprintInstallDiagnostics = {
  /** Dedicated workers whose install answered `true` while the channel still held them. */
  installedWorkerCount: number;
  /**
   * Attached dedicated workers the observer is not known to precede: the
   * install threw, answered anything but `true`, or came back only after the
   * pause had been concluded (watchdog or settle), when the worker may
   * already have run its first statements uninstrumented.
   */
  installFailedWorkerCount: number;
};

/**
 * The fingerprint observer's installer on the worker realm channel, in every
 * arm. It runs after the GPC installer in the GPC arm's pause, so the GPC
 * outcome never depends on it.
 *
 * Dedicated workers only. The channel does not receive shared workers from a
 * page session; should one ever attach, nothing is installed into it here,
 * since this installer's paused-install guard covers dedicated worker shapes
 * only, and it stays in the channel's shared attach count.
 */
export class FingerprintWorkerRealmInstaller implements WorkerRealmInstaller {
  private readonly expression: string;
  /** Attached dedicated workers whose install reached its terminal record. */
  private readonly settledWorkers = new WeakSet<AttachedWorker>();
  private installedWorkerCount = 0;
  private installFailedWorkerCount = 0;

  /** `firstPartySiteKey` is the value the scan's documents get from their init script. */
  constructor(firstPartySiteKey: string) {
    this.expression = fingerprintObserverWorkerInstallExpression(firstPartySiteKey);
  }

  async install(worker: AttachedWorker, channel: DevtoolsChannel): Promise<void> {
    if (worker.kind !== "dedicated") return;
    let installed = false;
    try {
      const evaluated = await channel.send(
        "Runtime.evaluate",
        { expression: this.expression, returnByValue: true },
        worker.sessionId
      );
      const result = evaluated.result as { value?: unknown } | undefined;
      installed = evaluated.exceptionDetails === undefined && result?.value === true;
    } catch {
      installed = false;
    }
    // Terminal here, while the channel still holds the worker. A watchdog or
    // settle that concluded the worker first already recorded the install as
    // failed, and this late answer cannot upgrade it.
    this.concludeWorker(worker, installed);
  }

  /** A worker concluded without an answer of its own is uninstrumented. After an answer this is a no-op. */
  concluded(worker: AttachedWorker): void {
    if (worker.kind !== "dedicated") return;
    this.concludeWorker(worker, false);
  }

  installDiagnostics(): WorkerFingerprintInstallDiagnostics {
    return {
      installedWorkerCount: this.installedWorkerCount,
      installFailedWorkerCount: this.installFailedWorkerCount
    };
  }

  /** Exactly one terminal state per attached dedicated worker. */
  private concludeWorker(worker: AttachedWorker, installed: boolean): void {
    if (this.settledWorkers.has(worker)) return;
    this.settledWorkers.add(worker);
    if (installed) this.installedWorkerCount += 1;
    else this.installFailedWorkerCount += 1;
  }
}

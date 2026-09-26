import type {
  AttachedWorker,
  DevtoolsChannel,
  WorkerAttachCounts,
  WorkerRealmInstaller
} from "./devtools-worker-channel";
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
 * This module replaces both with one mechanism, an installer of the worker
 * realm channel (lib/devtools-worker-channel.ts). That channel attaches the
 * scanner's own DevTools client to the measured page target in every arm and
 * holds every worker of the page, recursively, paused before its first
 * statement. In the GPC arm this installer runs first in that pause: it
 * installs the GPC property inside the worker's own realm and reads it back in
 * the same evaluation. Only a `true` readback from inside the worker, taken
 * while the worker is still held, marks it verified; anything else is a
 * terminal handshake failure the caller must disclose. The channel releases
 * the worker afterwards either way, so the measured site keeps its workers.
 *
 * Arms: every arm opens the same channel and pauses the same workers, but only
 * the GPC arm passes this installer, so no other arm's workers see the signal.
 *
 * The outcome is fixed at the readback, not at the release. Installers that
 * run after this one in the same pause therefore cannot change it through
 * their latency or their failure: a watchdog firing during a later installer
 * leaves a verified worker verified.
 *
 * SharedWorker is outside this mechanism: the channel cannot attach shared
 * workers from a page session. Shared workers therefore run untouched and are
 * disclosed as unverified through the construction counts kept by
 * lib/gpc-injection.ts.
 */

export type GpcWorkerVerificationDiagnostics = WorkerAttachCounts & {
  verifiedWorkerCount: number;
  unverifiedAttachedWorkerCount: number;
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

export class GpcWorkerRealmInstaller implements WorkerRealmInstaller {
  /** Attached workers whose handshake reached its terminal record. */
  private readonly settledWorkers = new WeakSet<AttachedWorker>();
  private verifiedWorkerCount = 0;
  private unverifiedAttachedWorkerCount = 0;

  async install(worker: AttachedWorker, channel: DevtoolsChannel): Promise<void> {
    let verified = false;
    try {
      const evaluated = await channel.send(
        "Runtime.evaluate",
        { expression: GPC_WORKER_HANDSHAKE_EXPRESSION, returnByValue: true },
        worker.sessionId
      );
      const result = evaluated.result as { value?: unknown } | undefined;
      verified = result?.value === true;
    } catch {
      verified = false;
    }
    // Terminal here, while the channel still holds the worker. A watchdog or
    // settle that concluded the worker first already recorded it unverified,
    // and this late readback cannot upgrade it.
    this.concludeWorker(worker, verified);
  }

  /**
   * A worker concluded without a readback of its own (the watchdog fired, a
   * settle froze the accounting, or the recursion could not be armed) is
   * unattested. After a readback this is a no-op.
   */
  concluded(worker: AttachedWorker): void {
    this.concludeWorker(worker, false);
  }

  /** The handshake counters, joined with the channel's attach counts. */
  verificationDiagnostics(attachCounts: WorkerAttachCounts): GpcWorkerVerificationDiagnostics {
    return {
      ...attachCounts,
      verifiedWorkerCount: this.verifiedWorkerCount,
      unverifiedAttachedWorkerCount: this.unverifiedAttachedWorkerCount
    };
  }

  /** Exactly one terminal state per attached worker. */
  private concludeWorker(worker: AttachedWorker, verified: boolean): void {
    if (this.settledWorkers.has(worker)) return;
    this.settledWorkers.add(worker);
    if (verified) this.verifiedWorkerCount += 1;
    else this.unverifiedAttachedWorkerCount += 1;
  }
}

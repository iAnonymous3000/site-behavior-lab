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

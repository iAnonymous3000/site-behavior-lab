export const GPC_WORKER_CAPTURE_LOSS_WARNING =
  "The scan blocked or could not verify one or more Web Workers while applying the simulated GPC signal; request evidence may be incomplete.";

const MAX_REGISTERED_WORKER_URL_LENGTH = 16_384;

type WorkerConstructor = new (...args: unknown[]) => object;

export type GpcWorkerInitScriptArgs = {
  bindingName: string;
  capability: string;
};

type GpcWorkerRegistration = {
  capability: string;
  kind: "dedicated" | "shared";
  protocol: string;
};

/**
 * Worker-side delivery and verification live in lib/gpc-worker-verification.ts
 * (a DevTools client that installs the signal inside each paused worker realm
 * and reads it back). This module keeps the page-side half of the mechanism:
 *
 * 1. the realm-local GPC initializer shared by documents and worker realms;
 * 2. a page-scoped constructor wrap that COUNTS Worker and SharedWorker
 *    constructions without changing them.
 *
 * The construction counts exist so an unverified worker is never silent. The
 * DevTools client can only account for workers it attached; if the channel
 * never establishes, drops mid-scan, or the worker kind cannot be attached
 * from a page session (SharedWorker), the construction count is what turns
 * that gap into a disclosed capture loss instead of a silently unverified
 * realm. The wrap never blocks, rewrites, or rejects a construction: every
 * worker the site asks for runs, in both arms, with the caller's exact
 * arguments.
 */
export type GpcWorkerInjectionDiagnostics = {
  dedicatedWorkerConstructionCount: number;
  sharedWorkerConstructionCount: number;
  attachedDedicatedWorkerCount: number;
  attachedSharedWorkerCount: number;
  verifiedWorkerCount: number;
  unverifiedAttachedWorkerCount: number;
  captureLossCount: number;
};

export type GpcWorkerInjectionCheckpoint = {
  diagnostics: GpcWorkerInjectionDiagnostics;
};

type GpcWorkerRawCounters = Omit<GpcWorkerInjectionDiagnostics, "captureLossCount">;

/**
 * One definition of the disclosed loss, used by the live checkpoint and by the
 * excluded-interval recomputation in lib/scanner.ts so the two cannot drift.
 *
 * Three terms, each a fact with no inference stapled on:
 * - an attached worker whose handshake did not return `true` from inside its
 *   realm ran without a verified signal;
 * - a dedicated construction the DevTools client never attached ran outside
 *   the verification channel entirely (channel down or never established);
 * - a shared construction beyond the attached shared count cannot be paused
 *   from a page session, so its realm is never attested.
 *
 * Verified workers contribute nothing: for them the asymmetry this warning
 * discloses no longer exists.
 */
export function gpcWorkerCaptureLossCount(counters: GpcWorkerRawCounters): number {
  return (
    counters.unverifiedAttachedWorkerCount +
    Math.max(0, counters.dedicatedWorkerConstructionCount - counters.attachedDedicatedWorkerCount) +
    Math.max(0, counters.sharedWorkerConstructionCount - counters.attachedSharedWorkerCount)
  );
}

/** Small realm-local initializer used in documents and injected worker realms. */
export function installGlobalPrivacyControl(): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "globalPrivacyControl");
  if (!descriptor || descriptor.configurable) {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: false,
      enumerable: true,
      get: () => true
    });
  }
}

/**
 * Document initializer that exposes GPC and records native Worker construction
 * without changing the constructor's behavior. A per-context capability
 * authenticates the page-to-host binding; knowing the randomized binding name
 * is insufficient to affect the host's accounting.
 *
 * The wrap intervenes in nothing: every construction, any scheme, proceeds
 * through the native constructor with the caller's exact arguments, so
 * TrustedScriptURL handling, document.baseURI resolution, Worker options,
 * subclassing/newTarget, and worker-visible location are all preserved, and a
 * construction that fails natively fails identically to the baseline arm.
 * Registration happens only after native construction succeeds.
 */
export function installGlobalPrivacyControlWithWorkerRegistration(args: GpcWorkerInitScriptArgs): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "globalPrivacyControl");
  if (!descriptor || descriptor.configurable) {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: false,
      enumerable: true,
      get: () => true
    });
  }

  const constructorMarker = Symbol.for("site-behavior-lab.gpc-worker-registration");
  const NativeURL = URL;
  const NativeProxy = Proxy;
  const nativeConstruct = Reflect.construct;
  const nativeDefineProperty = Object.defineProperty;
  const register = Reflect.get(globalThis, args.bindingName) as ((payload: GpcWorkerRegistration) => unknown) | undefined;
  const registeredSharedWorkers = new Set<string>();

  const notify = (payload: GpcWorkerRegistration) => {
    if (typeof register !== "function") return;
    try {
      const pending = register(payload);
      if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
        (pending as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // A missing host callback leaves the count to the DevTools attach side.
    }
  };

  const wrapConstructor = (name: "Worker" | "SharedWorker") => {
    const NativeConstructor = Reflect.get(globalThis, name) as WorkerConstructor | undefined;
    if (!NativeConstructor || Reflect.get(NativeConstructor, constructorMarker) === true) return;

    const WrappedConstructor = new NativeProxy(NativeConstructor, {
      construct(target, constructorArgs, newTarget) {
        // Invoke the native constructor first, with the caller's exact
        // arguments. Only a construction the site actually obtained is
        // counted; a natively rejected construction throws here exactly as it
        // would in the baseline arm, before any accounting.
        const worker = nativeConstruct(target, constructorArgs, newTarget);

        const scriptURL = constructorArgs[0];
        const options = constructorArgs[1];
        const baseURL = typeof document === "object" && document ? document.baseURI : globalThis.location.href;
        let protocol = "unresolved";
        let resolvedHref: string | null = null;
        try {
          const resolved = new NativeURL(String(scriptURL), baseURL);
          resolved.hash = "";
          protocol = resolved.protocol;
          resolvedHref = resolved.href;
        } catch {
          // The native constructor accepted what this wrap could not resolve
          // (a TrustedScriptURL policy, for instance). The construction still
          // counts; only the protocol detail is unavailable.
        }

        if (name === "SharedWorker") {
          // Primitive SharedWorker names have a stable, side-effect-free
          // identity, and repeat constructions join the same worker realm.
          // Never read a page-controlled dictionary getter here; dictionary
          // identities stay distinct registrations.
          const sharedIdentity =
            resolvedHref !== null && (options === undefined || typeof options === "string")
              ? JSON.stringify([resolvedHref, typeof options === "string" ? options : ""])
              : null;
          if (sharedIdentity && registeredSharedWorkers.has(sharedIdentity)) return worker;
          if (sharedIdentity) registeredSharedWorkers.add(sharedIdentity);
        }

        notify({
          capability: args.capability,
          kind: name === "Worker" ? "dedicated" : "shared",
          protocol
        });
        return worker;
      }
    });
    nativeDefineProperty(WrappedConstructor, constructorMarker, { value: true });
    nativeDefineProperty(globalThis, name, {
      configurable: true,
      value: WrappedConstructor,
      writable: true
    });
  };

  wrapConstructor("Worker");
  wrapConstructor("SharedWorker");
}

export class GpcWorkerInjectionSession {
  readonly bindingName: string;
  readonly initScriptArgs: GpcWorkerInitScriptArgs;

  private dedicatedWorkerConstructionCount = 0;
  private sharedWorkerConstructionCount = 0;
  private verificationDiagnostics: (() => {
    attachedDedicatedWorkerCount: number;
    attachedSharedWorkerCount: number;
    verifiedWorkerCount: number;
    unverifiedAttachedWorkerCount: number;
  }) | null = null;

  constructor(options: { randomBytes?: Uint8Array } = {}) {
    const randomBytes = options.randomBytes ?? crypto.getRandomValues(new Uint8Array(24));
    if (randomBytes.length < 16) throw new Error("GPC worker injection requires at least 128 bits of capability entropy.");
    const capability = bytesToHex(randomBytes);
    this.bindingName = `__siteBehaviorLabGpcWorker_${capability.slice(0, 16)}`;
    this.initScriptArgs = Object.freeze({ bindingName: this.bindingName, capability });
  }

  /** Callback target for BrowserContext.exposeBinding. Invalid page calls are ignored. */
  register(_bindingSource: { frame?: object }, value: unknown): void {
    if (!isWorkerRegistration(value) || value.capability !== this.initScriptArgs.capability) return;
    if (value.kind === "dedicated") this.dedicatedWorkerConstructionCount += 1;
    else this.sharedWorkerConstructionCount += 1;
  }

  /**
   * Wire in the DevTools verification counters. Without a source (channel
   * never established), every construction stays unmatched and therefore
   * counts as disclosed loss: verification failure is loud by construction.
   */
  setVerificationDiagnosticsSource(
    source: () => {
      attachedDedicatedWorkerCount: number;
      attachedSharedWorkerCount: number;
      verifiedWorkerCount: number;
      unverifiedAttachedWorkerCount: number;
    }
  ): void {
    this.verificationDiagnostics = source;
  }

  diagnostics(): GpcWorkerInjectionDiagnostics {
    const verification = this.verificationDiagnostics?.() ?? {
      attachedDedicatedWorkerCount: 0,
      attachedSharedWorkerCount: 0,
      verifiedWorkerCount: 0,
      unverifiedAttachedWorkerCount: 0
    };
    const counters: GpcWorkerRawCounters = {
      dedicatedWorkerConstructionCount: this.dedicatedWorkerConstructionCount,
      sharedWorkerConstructionCount: this.sharedWorkerConstructionCount,
      attachedDedicatedWorkerCount: verification.attachedDedicatedWorkerCount,
      attachedSharedWorkerCount: verification.attachedSharedWorkerCount,
      verifiedWorkerCount: verification.verifiedWorkerCount,
      unverifiedAttachedWorkerCount: verification.unverifiedAttachedWorkerCount
    };
    return {
      ...counters,
      captureLossCount: gpcWorkerCaptureLossCount(counters)
    };
  }

  checkpoint(): GpcWorkerInjectionCheckpoint {
    return { diagnostics: this.diagnostics() };
  }
}

export function createGpcWorkerInjectionSession(
  options: { randomBytes?: Uint8Array } = {}
): GpcWorkerInjectionSession {
  return new GpcWorkerInjectionSession(options);
}

function isWorkerRegistration(value: unknown): value is GpcWorkerRegistration {
  if (!isRecord(value)) return false;
  return (
    typeof value.capability === "string" &&
    value.capability.length <= MAX_REGISTERED_WORKER_URL_LENGTH &&
    (value.kind === "dedicated" || value.kind === "shared") &&
    typeof value.protocol === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

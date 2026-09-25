import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  createGpcWorkerInjectionSession,
  GPC_WORKER_CAPTURE_LOSS_WARNING,
  gpcWorkerCaptureLossCount,
  installGlobalPrivacyControl,
  installGlobalPrivacyControlWithWorkerRegistration
} from "./gpc-injection";

const FIXED_RANDOM_BYTES = new Uint8Array(Array.from({ length: 24 }, (_, index) => index + 1));

test("the producer scopes the GPC registration initializer to the measured page", async () => {
  const nodeProducer = await readFile(path.join(process.cwd(), "lib", "scanner.ts"), "utf8");
  for (const source of [nodeProducer]) {
    assert.doesNotMatch(
      source,
      /context\.addInitScript\(\s*installGlobalPrivacyControlWithWorkerRegistration/
    );
    assert.match(
      source,
      /page\.addInitScript\(\s*installGlobalPrivacyControlWithWorkerRegistration/
    );
    const registrationIndex = source.search(
      /page\.addInitScript\(\s*installGlobalPrivacyControlWithWorkerRegistration/
    );
    assert.ok(
      source.indexOf("const page =") < registrationIndex,
      "the measured Page must exist before its registration initializer is installed"
    );
  }
});

test("the GPC initializer exposes a readable, immutable true signal", () => {
  const isolatedNavigator: Record<string, unknown> = {};
  const context = { navigator: isolatedNavigator };
  runInNewContext(`(${installGlobalPrivacyControl.toString()})();(${installGlobalPrivacyControl.toString()})()`, context);

  assert.equal(isolatedNavigator.globalPrivacyControl, true);
  assert.equal(Object.getOwnPropertyDescriptor(isolatedNavigator, "globalPrivacyControl")?.enumerable, true);
  assert.equal(Reflect.deleteProperty(isolatedNavigator, "globalPrivacyControl"), false);
  assert.throws(() =>
    Object.defineProperty(isolatedNavigator, "globalPrivacyControl", {
      configurable: true,
      get: () => false
    })
  );
  assert.equal(isolatedNavigator.globalPrivacyControl, true);
});

type WrapContext = Record<string, unknown> & {
  Worker: unknown;
  SharedWorker: unknown;
};

function wrappedRealm(session: ReturnType<typeof createGpcWorkerInjectionSession>): {
  context: WrapContext;
  registrations: unknown[];
} {
  class FakeWorker {
    constructor(readonly url: unknown, readonly options?: unknown) {
      if (String(url).startsWith("throwing:")) {
        throw new TypeError("native constructor rejected this URL");
      }
    }
  }
  class FakeSharedWorker {
    constructor(readonly url: unknown, readonly options?: unknown) {}
  }
  const registrations: unknown[] = [];
  const context: WrapContext = {
    DOMException,
    SharedWorker: FakeSharedWorker,
    URL,
    Worker: FakeWorker,
    document: { baseURI: "https://example.test/assets/subdirectory/" },
    location: { href: "https://example.test/page" },
    navigator: {}
  };
  context[session.bindingName] = (value: unknown) => {
    registrations.push(value);
    session.register({}, value);
  };
  runInNewContext(
    `(${installGlobalPrivacyControlWithWorkerRegistration.toString()})(${JSON.stringify(session.initScriptArgs)})`,
    context
  );
  return { context, registrations };
}

test("constructions of every scheme run natively, keep exact arguments, and are counted", () => {
  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  const { context, registrations } = wrappedRealm(session);
  const Dedicated = context.Worker as new (url: unknown, options?: unknown) => { url: unknown; options?: unknown };
  const Shared = context.SharedWorker as new (url: unknown, options?: unknown) => { url: unknown; options?: unknown };

  const dedicated = new Dedicated("../worker.js?signature=abc~def#entry", { type: "module", credentials: "omit" });
  assert.equal(dedicated.url, "../worker.js?signature=abc~def#entry");
  assert.deepEqual(dedicated.options, { type: "module", credentials: "omit" });

  // The two shapes the retired route-transform design could only block. The
  // wrap must let both through untouched: verification happens inside the
  // worker realm over the DevTools channel, not by rewriting the constructor.
  const blob = new Dedicated("blob:https://example.test/e145c076");
  const data = new Dedicated("data:text/javascript,postMessage(1)");
  assert.equal(blob.url, "blob:https://example.test/e145c076");
  assert.equal(data.url, "data:text/javascript,postMessage(1)");

  const shared = new Shared("shared.js?name=unchanged", "scan-name");
  assert.equal(shared.url, "shared.js?name=unchanged");
  assert.equal(shared.options, "scan-name");

  assert.deepEqual(
    JSON.parse(JSON.stringify(registrations)),
    [
      { capability: session.initScriptArgs.capability, kind: "dedicated", protocol: "https:" },
      { capability: session.initScriptArgs.capability, kind: "dedicated", protocol: "blob:" },
      { capability: session.initScriptArgs.capability, kind: "dedicated", protocol: "data:" },
      { capability: session.initScriptArgs.capability, kind: "shared", protocol: "https:" }
    ]
  );
  const diagnostics = session.diagnostics();
  assert.equal(diagnostics.dedicatedWorkerConstructionCount, 3);
  assert.equal(diagnostics.sharedWorkerConstructionCount, 1);
});

test("a natively rejected construction throws exactly as unwrapped and is never counted", () => {
  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  const { context, registrations } = wrappedRealm(session);
  const Dedicated = context.Worker as new (url: unknown) => object;
  assert.throws(() => new Dedicated("throwing://rejected.js"), TypeError);
  assert.deepEqual(registrations, []);
  assert.equal(session.diagnostics().dedicatedWorkerConstructionCount, 0);
});

test("repeat primitive-name SharedWorker constructions join one realm and count once", () => {
  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  const { context } = wrappedRealm(session);
  const Shared = context.SharedWorker as new (url: unknown, options?: unknown) => object;
  new Shared("shared.js", "scan-name");
  new Shared("shared.js", "scan-name");
  new Shared("shared.js", "another-name");
  assert.equal(session.diagnostics().sharedWorkerConstructionCount, 2);
});

test("registrations without the per-context capability are ignored", () => {
  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  session.register({}, { capability: "forged", kind: "dedicated", protocol: "https:" });
  session.register({}, { capability: session.initScriptArgs.capability, kind: "dedicated" });
  session.register({}, "not-a-registration");
  assert.equal(session.diagnostics().dedicatedWorkerConstructionCount, 0);
});

function rawCounters(
  overrides: Partial<Parameters<typeof gpcWorkerCaptureLossCount>[0]>
): Parameters<typeof gpcWorkerCaptureLossCount>[0] {
  return {
    dedicatedWorkerConstructionCount: 0,
    sharedWorkerConstructionCount: 0,
    observedDedicatedWorkerCount: 0,
    attachedDedicatedWorkerCount: 0,
    attachedNestedDedicatedWorkerCount: 0,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 0,
    unverifiedAttachedWorkerCount: 0,
    ...overrides
  };
}

test("the disclosed loss counts exactly the unattested workers, in both directions", () => {
  // Every construction attached and attested: the asymmetry is gone and the
  // loss must be zero, or every clean GPC report reads as degraded.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 3,
        observedDedicatedWorkerCount: 3,
        attachedDedicatedWorkerCount: 3,
        verifiedWorkerCount: 3
      })
    ),
    0
  );
  // An attached worker whose realm never attested is loss even when the
  // construction counts balance.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 2,
        observedDedicatedWorkerCount: 2,
        attachedDedicatedWorkerCount: 2,
        verifiedWorkerCount: 1,
        unverifiedAttachedWorkerCount: 1
      })
    ),
    1
  );
  // Constructions the channel never attached (channel down, or shared workers
  // a page session cannot attach) are loss even though no handshake failed.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 2,
        sharedWorkerConstructionCount: 1,
        observedDedicatedWorkerCount: 2
      })
    ),
    3
  );
  // A nested worker attaches with no page-level construction behind it; its
  // attach is tagged, so it neither goes negative nor offsets anything, and
  // only the unattachable shared construction remains.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 1,
        sharedWorkerConstructionCount: 1,
        observedDedicatedWorkerCount: 2,
        attachedDedicatedWorkerCount: 2,
        attachedNestedDedicatedWorkerCount: 1,
        verifiedWorkerCount: 2
      })
    ),
    1
  );
});

test("a nested or constructor-bypassing attach cannot stand in for a page-level worker the channel never reached", () => {
  // One page worker spawned a child (both attached), then the channel missed
  // a later page worker. Netting pooled counts read 2 - 2 = 0.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 2,
        observedDedicatedWorkerCount: 3,
        attachedDedicatedWorkerCount: 2,
        attachedNestedDedicatedWorkerCount: 1,
        verifiedWorkerCount: 2
      })
    ),
    1
  );
  // The same visit with the browser-side witness short one worker: the
  // construction count against page-level attaches still catches it.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 2,
        observedDedicatedWorkerCount: 2,
        attachedDedicatedWorkerCount: 2,
        attachedNestedDedicatedWorkerCount: 1,
        verifiedWorkerCount: 2
      })
    ),
    1
  );
  // A page worker built through the native constructor the wrap never sees
  // attaches uncounted and offsets a counted construction the channel never
  // attached; only the witness exposes it.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 2,
        observedDedicatedWorkerCount: 4,
        attachedDedicatedWorkerCount: 3,
        verifiedWorkerCount: 3
      })
    ),
    1
  );
  // Both records are lower bounds on the same unattached workers, so a
  // channel that never established discloses the larger of the two, not their
  // sum.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 2,
        observedDedicatedWorkerCount: 3
      })
    ),
    3
  );
  // The full clean matrix (five page workers, one nested child, all attached
  // and attested) stays at zero: the witness adds no false loss.
  assert.equal(
    gpcWorkerCaptureLossCount(
      rawCounters({
        dedicatedWorkerConstructionCount: 5,
        observedDedicatedWorkerCount: 6,
        attachedDedicatedWorkerCount: 6,
        attachedNestedDedicatedWorkerCount: 1,
        verifiedWorkerCount: 6
      })
    ),
    0
  );
});

test("a session without a verification source discloses every construction as loss", () => {
  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  session.register({}, { capability: session.initScriptArgs.capability, kind: "dedicated", protocol: "https:" });
  session.register({}, { capability: session.initScriptArgs.capability, kind: "shared", protocol: "https:" });
  assert.equal(session.checkpoint().diagnostics.captureLossCount, 2);

  session.setVerificationDiagnosticsSource(() => ({
    attachedDedicatedWorkerCount: 1,
    attachedNestedDedicatedWorkerCount: 0,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 1,
    unverifiedAttachedWorkerCount: 0
  }));
  // The dedicated construction is attached and attested; only the shared
  // construction, which a page session cannot attach, remains disclosed.
  assert.equal(session.checkpoint().diagnostics.captureLossCount, 1);
});

test("the browser-side witness discloses dedicated workers the construction count never saw", () => {
  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  session.register({}, { capability: session.initScriptArgs.capability, kind: "dedicated", protocol: "https:" });
  session.observeDedicatedWorker();
  session.observeDedicatedWorker();
  // No channel: one wrapped construction, two workers the browser started.
  // The disclosed loss is the larger record, never the smaller.
  const unattached = session.checkpoint().diagnostics;
  assert.equal(unattached.observedDedicatedWorkerCount, 2);
  assert.equal(unattached.captureLossCount, 2);

  session.setVerificationDiagnosticsSource(() => ({
    attachedDedicatedWorkerCount: 2,
    attachedNestedDedicatedWorkerCount: 0,
    attachedSharedWorkerCount: 0,
    verifiedWorkerCount: 2,
    unverifiedAttachedWorkerCount: 0
  }));
  assert.equal(session.checkpoint().diagnostics.captureLossCount, 0);
});

test("the disclosed warning names verification, not blocking as policy", () => {
  // The admitted string is frozen by the public-string policy and must not
  // move; this pins the exact sentence the r2 sanitizer admits.
  assert.equal(
    GPC_WORKER_CAPTURE_LOSS_WARNING,
    "The scan blocked or could not verify one or more Web Workers while applying the simulated GPC signal; request evidence may be incomplete."
  );
});

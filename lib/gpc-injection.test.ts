import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import {
  createGpcWorkerInjectionSession,
  MAX_MODULE_TOKENS,
  GPC_WORKER_CAPTURE_LOSS_WARNING,
  GPC_WORKER_ROUTE_FETCH_TIMEOUT_MS,
  GPC_WORKER_SCRIPT_MAX_BYTES,
  GpcWorkerInjectionError,
  injectGlobalPrivacyControlIntoWorkerSource,
  installGlobalPrivacyControl,
  installGlobalPrivacyControlWithWorkerRegistration
} from "./gpc-injection";

const FIXED_RANDOM_BYTES = new Uint8Array(Array.from({ length: 24 }, (_, index) => index + 1));

test("the producer scopes the GPC registration initializer to the routed measured page", async () => {
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

test("constructor registration preserves exact arguments and document base while local schemes fail closed", () => {
  class FakeWorker {
    constructor(readonly url: unknown, readonly options?: unknown) {}
  }
  class FakeSharedWorker {
    constructor(readonly url: unknown, readonly options?: unknown) {}
  }

  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  const registrations: unknown[] = [];
  const context: Record<string, unknown> = {
    DOMException,
    SharedWorker: FakeSharedWorker,
    URL,
    Worker: FakeWorker,
    document: { baseURI: "https://example.test/assets/subdirectory/" },
    location: { href: "https://example.test/page" },
    navigator: {}
  };
  context[session.bindingName] = (value: unknown) => registrations.push(value);
  runInNewContext(
    `(${installGlobalPrivacyControlWithWorkerRegistration.toString()})(${JSON.stringify(session.initScriptArgs)})`,
    context
  );

  const Dedicated = context.Worker as typeof FakeWorker;
  const Shared = context.SharedWorker as typeof FakeSharedWorker;
  const dedicated = new Dedicated("../worker.js?signature=abc~def#entry", { type: "module", credentials: "omit" });
  const shared = new Shared("shared.js?name=unchanged", "scan-name");

  assert.equal(dedicated.url, "../worker.js?signature=abc~def#entry");
  assert.deepEqual(dedicated.options, { type: "module", credentials: "omit" });
  assert.equal(shared.url, "shared.js?name=unchanged");
  assert.equal(shared.options, "scan-name");
  assert.deepEqual(
    JSON.parse(JSON.stringify(registrations)),
    [
      {
        capability: session.initScriptArgs.capability,
        kind: "dedicated",
        outcome: "network",
        protocol: "https:",
        type: "module",
        url: "https://example.test/assets/worker.js?signature=abc~def"
      },
      {
        capability: session.initScriptArgs.capability,
        kind: "shared",
        outcome: "network",
        protocol: "https:",
        type: "classic",
        url: "https://example.test/assets/subdirectory/shared.js?name=unchanged"
      }
    ]
  );

  assert.throws(
    () => new Dedicated("data:text/javascript,postMessage(1)"),
    (error: unknown) => error instanceof DOMException && error.name === "NotSupportedError"
  );
  assert.deepEqual(JSON.parse(JSON.stringify(registrations.at(-1))), {
    capability: session.initScriptArgs.capability,
    kind: "dedicated",
    outcome: "unsupported",
    protocol: "data:",
    type: "classic"
  });
});

test("the wrapper never reads a page-controlled Worker options dictionary", () => {
  let nativeObservedType: unknown;
  class WebIdlLikeWorker {
    constructor(readonly url: unknown, readonly options?: unknown) {
      nativeObservedType = (options as { type?: unknown } | undefined)?.type;
    }
  }

  const session = createGpcWorkerInjectionSession({ randomBytes: FIXED_RANDOM_BYTES });
  const registrations: unknown[] = [];
  const context: Record<string, unknown> = {
    DOMException,
    URL,
    Worker: WebIdlLikeWorker,
    document: { baseURI: "https://example.test/" },
    location: { href: "https://example.test/page" },
    navigator: {}
  };
  context[session.bindingName] = (value: unknown) => registrations.push(value);
  runInNewContext(
    `(${installGlobalPrivacyControlWithWorkerRegistration.toString()})(${JSON.stringify(session.initScriptArgs)})`,
    context
  );

  let typeReads = 0;
  const options = {
    get type() {
      typeReads += 1;
      return typeReads === 1 ? "classic" : "module";
    }
  };
  const Dedicated = context.Worker as typeof WebIdlLikeWorker;
  const worker = new Dedicated("worker.js", options);

  assert.equal(worker.options, options);
  assert.equal(typeReads, 1);
  assert.equal(nativeObservedType, "classic");
  assert.deepEqual(JSON.parse(JSON.stringify(registrations)), [
    {
      capability: session.initScriptArgs.capability,
      kind: "dedicated",
      outcome: "network",
      protocol: "https:",
      type: "module",
      url: "https://example.test/worker.js"
    }
  ]);
});

test("forged registrations and ordinary marker-like scripts never authorize rewriting", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register(
    { frame },
    {
      capability: "attacker-controlled",
      kind: "dedicated",
      outcome: "network",
      protocol: "https:",
      type: "classic",
      url: "https://example.test/app.js?__site_behavior_lab_gpc_worker=1"
    }
  );

  let fetched = false;
  const fulfillment = await session.buildRouteFulfillment({
    request: () => ({
      frame: () => frame,
      headerValue: async (name) => name === "user-agent" ? "Chromium" : "https://example.test/",
      resourceType: () => "script",
      url: () => "https://example.test/app.js?__site_behavior_lab_gpc_worker=1"
    }),
    fetch: async () => {
      fetched = true;
      return response(200, "ordinaryPageScript()", {});
    }
  });

  assert.equal(fulfillment, null);
  assert.equal(fetched, false);
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 0,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 0,
    unsupportedWorkerCount: 0
  });
});

test("diagnostic checkpoints give pending registrations stable target-free identities", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/one.js", "classic"));
  session.register({ frame }, networkRegistration(session, "https://example.test/two.js", "classic"));

  assert.deepEqual(session.checkpoint().pendingWorkerRegistrationIds, [1, 2]);
  await session.buildRouteFulfillment({
    request: () => workerRequest(frame, "https://example.test/one.js"),
    fetch: async () => response(200, "postMessage(1)", {})
  });
  assert.deepEqual(session.checkpoint().pendingWorkerRegistrationIds, [2]);

  session.register({ frame }, networkRegistration(session, "https://example.test/three.js", "classic"));
  assert.deepEqual(session.checkpoint().pendingWorkerRegistrationIds, [2, 3]);
});

test("redirects fail closed without an out-of-band follow or Location rewrite", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/worker.js", "classic"));
  const redirectResponse = response(302, "", { location: "/worker-final.js?signature=abc~def" });
  const fetchOptions: Array<{ maxRedirects: number; timeout: number }> = [];
  await assert.rejects(
    session.buildRouteFulfillment({
      request: () => workerRequest(frame, "https://example.test/worker.js"),
      fetch: async (options) => {
        fetchOptions.push(options);
        return redirectResponse;
      }
    }),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "unsupported-worker"
  );

  assert.deepEqual(fetchOptions, [{
    maxRedirects: 0,
    timeout: GPC_WORKER_ROUTE_FETCH_TIMEOUT_MS
  }]);
  assert.equal(redirectResponse.headers().location, "/worker-final.js?signature=abc~def");
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 1,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 0,
    unsupportedWorkerCount: 1
  });
});

test("a worker fetch never outlives the deadline that has to wait for it", async () => {
  // Route.fetch has no AbortSignal, so a fixed 30s timeout on a fetch starting
  // at t=40s of a 45s scan leaves a route handler in flight AT the deadline.
  // The evidence boundary waits for those handlers, so one stalled worker
  // script discarded a measurement that had already finished.
  const frame = {};
  const remaining = [30_000, 4_000, 400];
  const fetchOptions: Array<{ maxRedirects: number; timeout: number }> = [];
  const session = createGpcWorkerInjectionSession({
    registrationWaitMs: 0,
    randomBytes: FIXED_RANDOM_BYTES,
    routeFetchTimeoutMs: () => remaining.shift() ?? 0
  });
  const fetchWorker = async (url: string) => {
    session.register({ frame }, networkRegistration(session, url, "classic"));
    return session.buildRouteFulfillment({
      request: () => workerRequest(frame, url),
      fetch: async (options) => {
        fetchOptions.push(options);
        return response(200, "postMessage(1)", {});
      }
    });
  };

  await fetchWorker("https://example.test/plenty.js");
  await fetchWorker("https://example.test/tight.js");
  // Under the floor the fetch is declined outright rather than started and
  // abandoned, and it is counted as the transform failure it is.
  await assert.rejects(
    fetchWorker("https://example.test/too-late.js"),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "worker-transform-failed"
  );

  assert.deepEqual(fetchOptions, [
    { maxRedirects: 0, timeout: GPC_WORKER_ROUTE_FETCH_TIMEOUT_MS },
    { maxRedirects: 0, timeout: 4_000 }
  ]);
  assert.equal(session.diagnostics().transformFailureCount, 1);
});

test("authenticated tickets fail closed when Chromium request metadata drifts", async () => {
  const frame = {};
  const resourceTypeDrift = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  resourceTypeDrift.register(
    { frame },
    networkRegistration(resourceTypeDrift, "https://example.test/worker.js", "classic")
  );
  await assert.rejects(
    resourceTypeDrift.buildRouteFulfillment({
      request: () => ({
        frame: () => frame,
        headerValue: async () => null,
        resourceType: () => "other",
        url: () => "https://example.test/worker.js"
      }),
      fetch: async () => response(200, "", {})
    }),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "ambiguous-worker-request"
  );

  const entryHeaderDrift = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  entryHeaderDrift.register(
    { frame },
    networkRegistration(entryHeaderDrift, "https://example.test/worker.js", "classic")
  );
  await assert.rejects(
    entryHeaderDrift.buildRouteFulfillment({
      request: () => ({
        frame: () => frame,
        headerValue: async (name) => name === "user-agent" ? "Chromium" : "https://example.test/",
        resourceType: () => "script",
        url: () => "https://example.test/worker.js"
      }),
      fetch: async () => response(200, "", {})
    }),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "ambiguous-worker-request"
  );

  const moduleReferrerDrift = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  moduleReferrerDrift.register(
    { frame },
    networkRegistration(moduleReferrerDrift, "https://example.test/root.js", "module")
  );
  await moduleReferrerDrift.buildRouteFulfillment({
    request: () => workerRequest(frame, "https://example.test/root.js"),
    fetch: async () => response(200, "import './dependency.js';", {})
  });
  await assert.rejects(
    moduleReferrerDrift.buildRouteFulfillment({
      request: () => ({
        frame: () => frame,
        headerValue: async (name) => name === "user-agent" ? "Chromium" : null,
        resourceType: () => "script",
        url: () => "https://example.test/dependency.js"
      }),
      fetch: async () => response(200, "", {})
    }),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "ambiguous-worker-request"
  );

  assert.equal(resourceTypeDrift.diagnostics().ambiguousWorkerRequestCount, 1);
  assert.equal(entryHeaderDrift.diagnostics().ambiguousWorkerRequestCount, 1);
  assert.equal(moduleReferrerDrift.diagnostics().ambiguousWorkerRequestCount, 1);
});

test("upstream response failures become one explicit Worker capture-loss unit", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/worker.js", "classic"));

  await assert.rejects(
    session.buildRouteFulfillment({
      request: () => workerRequest(frame, "https://example.test/worker.js"),
      fetch: async () => { throw new Error("fixture transport failure"); }
    }),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "worker-transform-failed"
  );
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 1,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 1,
    unsupportedWorkerCount: 0
  });
});

test("division inside template substitutions stays parseable and keeps the module instrumented", async () => {
  // Every case here is legitimate module source that must still be injected.
  // A digit that leaves the scanner regex-permitting turns the division into a
  // regex literal that swallows the substitution and fails the whole parse.
  const substitutions = [
    "`${(bytes / 1024 / 1024).toFixed(2)} MB`",
    "`${1000 / 2}`",
    "`${.5 / 2}`",
    "`${0x20 / 2}`",
    "`${1e3 / 2}`",
    "`${(1024 / bytes)}`",
    "`${`${8 / 2}`}`",
    "`${/* comment */ 4 / 2}`",
    "`${ // line comment\n 4 / 2}`",
    "`${'`'} ${1 / 2}`",
    // Controls for the branches the numeric rule must not disturb: a real
    // regex literal, and division after a closing bracket or parenthesis.
    "`${'ab'.replace(/a/g, 'b')}`",
    "`${[4][0] / 2}`",
    "`${(4) / 2}`"
  ];

  for (const substitution of substitutions) {
    const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
    const frame = {};
    session.register({ frame }, networkRegistration(session, "https://example.test/module.js", "module"));
    const fulfillment = await session.buildRouteFulfillment({
      request: () => workerRequest(frame, "https://example.test/module.js"),
      fetch: async () => response(200, `import { bytes } from './bytes.js';\npostMessage(${substitution});`, {})
    });

    assert.ok(fulfillment?.body?.includes("installGlobalPrivacyControl"), substitution);
    assert.equal(session.diagnostics().transformFailureCount, 0, substitution);
    // The static dependency has to be ticketed, otherwise the scanner parsed
    // the source but lost the graph it needs to instrument.
    assert.deepEqual(session.checkpoint().pendingWorkerRegistrationIds, [2], substitution);
  }
});

test("an unparsed module fails open with its own bytes and one disclosed capture-loss unit", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/module.js", "module"));
  // Import attributes are outside the scanner's grammar, and page-controlled
  // source can always leave it outside. Aborting would alter the measured
  // page, so the Worker keeps its own bytes and the gap is counted instead.
  const fetched = response(200, `import data from './data.json' with { type: 'json' };\npostMessage(data);`, {});
  const fulfillment = await session.buildRouteFulfillment({
    request: () => workerRequest(frame, "https://example.test/module.js"),
    fetch: async () => fetched
  });

  assert.deepEqual(fulfillment, { response: fetched });
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 1,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 1,
    unsupportedWorkerCount: 0
  });

  // The unparsed module authorized nothing, so its dependency must be left
  // alone rather than cascading into a blocked request.
  const dependency = await session.buildRouteFulfillment({
    request: () => ({
      frame: () => frame,
      headerValue: async (name: string) => name === "user-agent" ? "Chromium" : "https://example.test/module.js",
      resourceType: () => "script",
      url: () => "https://example.test/data.json"
    }),
    fetch: async () => response(200, "{}", {})
  });
  assert.equal(dependency, null);
  assert.equal(session.diagnostics().captureLossCount, 1);
});

test("a declared oversized Worker script fails open before APIResponse body access", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/worker.js", "classic"));
  let bodyRead = false;
  const fetched = {
    body: async () => {
      bodyRead = true;
      return new Uint8Array();
    },
    headers: () => ({ "Content-Length": String(GPC_WORKER_SCRIPT_MAX_BYTES + 1) }),
    status: () => 200
  };

  const fulfillment = await session.buildRouteFulfillment({
    request: () => workerRequest(frame, "https://example.test/worker.js"),
    fetch: async () => fetched
  });

  assert.deepEqual(fulfillment, { response: fetched });
  assert.equal(bodyRead, false);
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 1,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 1,
    unsupportedWorkerCount: 0
  });
});

test("a post-buffer oversized Worker body fails open when Content-Length is absent or dishonest", async () => {
  const headerCases: Array<Record<string, string>> = [{}, { "content-length": "1" }];
  for (const headers of headerCases) {
    const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
    const frame = {};
    session.register({ frame }, networkRegistration(session, "https://example.test/worker.js", "classic"));
    const fetched = {
      body: async () => new Uint8Array(GPC_WORKER_SCRIPT_MAX_BYTES + 1),
      headers: () => headers,
      status: () => 200
    };

    const fulfillment = await session.buildRouteFulfillment({
      request: () => workerRequest(frame, "https://example.test/worker.js"),
      fetch: async () => fetched
    });

    assert.deepEqual(fulfillment, { response: fetched });
    assert.equal(session.diagnostics().captureLossCount, 1);
    assert.equal(session.diagnostics().transformFailureCount, 1);
  }
});

test("deeply nested template substitutions fail open instead of escaping as a stack overflow", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/module.js", "module"));
  // Substitutions are scanned recursively. Chromium rejects nesting this deep
  // itself, so this pins the boundary of route handling rather than fidelity:
  // no page-controlled body may leave the route without a terminal action.
  const nested = `const deep = ${"`${".repeat(6_000)}1${"}`".repeat(6_000)};\npostMessage(deep);`;
  const fulfillment = await session.buildRouteFulfillment({
    request: () => workerRequest(frame, "https://example.test/module.js"),
    fetch: async () => response(200, nested, {})
  });

  assert.equal(fulfillment?.body, undefined);
  assert.equal(session.diagnostics().transformFailureCount, 1);
});

test("an unresolvable module specifier blocks through the accounted path instead of throwing", async () => {
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  session.register({ frame }, networkRegistration(session, "https://example.test/module.js", "module"));
  // The specifier is the measured site's text, so a scheme-shaped but invalid
  // URL must not leave route handling as a raw TypeError: that stranded the
  // request with no terminal action and no capture-loss record.
  await assert.rejects(
    session.buildRouteFulfillment({
      request: () => workerRequest(frame, "https://example.test/module.js"),
      fetch: async () => response(200, `import "http://[";\npostMessage(1);`, {})
    }),
    (error: unknown) => error instanceof GpcWorkerInjectionError && error.reason === "unsupported-worker"
  );
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 1,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 0,
    unsupportedWorkerCount: 1
  });
});

test("source injection preserves hashbangs, comments, and the directive prologue", () => {
  const original = [
    "#!/usr/bin/env worker",
    "// license comment",
    "'use strict';",
    "/* retained directive boundary */",
    "try { accidentalGlobal = 1; result = 'sloppy'; } catch { result = 'strict'; }"
  ].join("\n");
  const transformed = injectGlobalPrivacyControlIntoWorkerSource(original);
  const context = { navigator: {}, result: "pending" };

  assert.equal(transformed.startsWith("#!/usr/bin/env worker\n// license comment\n'use strict';"), true);
  assert.ok(transformed.indexOf("installGlobalPrivacyControl") > transformed.indexOf("'use strict';"));
  runInNewContext(transformed, context);
  assert.equal(context.result, "strict");
  assert.equal((context.navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl, true);
});

test("source injection does not turn a continued string expression into a directive", () => {
  const original = `"use strict"\n(function () { result = "changed"; })()`;
  const transformed = injectGlobalPrivacyControlIntoWorkerSource(original);
  const context = { navigator: {}, result: "pending" };

  assert.ok(transformed.indexOf("installGlobalPrivacyControl") < transformed.indexOf("\"use strict\""));
  assert.throws(
    () => runInNewContext(transformed, context),
    (error: unknown) => Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === "TypeError"
  );
  assert.equal(context.result, "pending");
  assert.equal((context.navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl, true);
});

test("real Chromium preserves worker URLs, injects full module graphs, and fails closed when required", { timeout: 20_000 }, async (t) => {
  const originRequests: string[] = [];
  const server = createServer((request, response_) => {
    originRequests.push(request.url ?? "");
    const requestUrl = new URL(request.url ?? "/", "http://fixture.test");
    if (requestUrl.pathname === "/") {
      response_.setHeader("content-type", "text/html; charset=utf-8");
      response_.end(`<!doctype html>
        <base href="/assets/">
        <title>pending</title>
        <script src="ordinary.js?__site_behavior_lab_gpc_worker=1"></script>
        <script>
          const results = [];
          globalThis.__testResults = results;
          globalThis.__workerErrors = [];
          const receive = event => {
            results.push(event.data);
            if (results.length === 8) document.title = JSON.stringify(results.slice().sort((a, b) => a.kind.localeCompare(b.kind)));
          };
          let adversarialTypeReads = 0;
          const adversarial = new Worker('adversarial-module.js?entry=abc~def', {
            get type() {
              adversarialTypeReads += 1;
              return adversarialTypeReads === 1 ? 'module' : 'classic';
            }
          });
          const classic = new Worker('classic.js?signature=abc~def');
          const moduleWorker = new Worker('module.js?root=abc~def', { type: 'module' });
          const unparsed = new Worker('unparsed-module.js', { type: 'module' });
          const redirected = new Worker('redirect.js');
          const gzipWorker = new Worker('gzip.js');
          const shared = new SharedWorker('shared.js?shared=abc~def');
          adversarial.onmessage = event => receive({
            data: { ...event.data, typeReads: adversarialTypeReads }
          });
          classic.onmessage = receive;
          moduleWorker.onmessage = receive;
          unparsed.onmessage = receive;
          redirected.onmessage = receive;
          gzipWorker.onmessage = receive;
          shared.port.onmessage = receive;
          shared.port.start();
          redirected.onerror = event => {
            event.preventDefault();
            receive({ data: { kind: 'redirect', blocked: true } });
          };
          for (const worker of [adversarial, classic, moduleWorker, unparsed, gzipWorker]) {
            worker.onerror = event => globalThis.__workerErrors.push(String(event.message || event.type));
          }
          shared.onerror = event => globalThis.__workerErrors.push(String(event.message || event.type));

          const blobUrl = URL.createObjectURL(new Blob(['postMessage(navigator.globalPrivacyControl)'], { type: 'text/javascript' }));
          let blobBlocked = false;
          let blobRevoked = false;
          try {
            new Worker(blobUrl);
          } catch (error) {
            blobBlocked = error && error.name === 'NotSupportedError';
          } finally {
            URL.revokeObjectURL(blobUrl);
            blobRevoked = true;
          }
          receive({ data: { kind: 'blob', blocked: blobBlocked, revoked: blobRevoked } });
        </script>`);
      return;
    }

    response_.setHeader("content-type", "application/javascript; charset=utf-8");
    if (requestUrl.pathname === "/assets/ordinary.js") {
      response_.end("globalThis.ordinaryMarkerScriptLoaded = true;");
    } else if (requestUrl.pathname === "/assets/adversarial-module.js") {
      response_.end(`import { dependencyAtEntry } from './adversarial-dependency.js?dep=abc~def';
        postMessage({
          kind: 'adversarial',
          gpc: navigator.globalPrivacyControl,
          dependencyAtEntry,
          href: location.href,
          meta: import.meta.url
        });`);
    } else if (requestUrl.pathname === "/assets/adversarial-dependency.js") {
      response_.end("export const dependencyAtEntry = navigator.globalPrivacyControl;");
    } else if (requestUrl.pathname === "/assets/classic.js") {
      response_.end(`#!/usr/bin/env worker
        'use strict';
        let strict = false;
        try { accidentalWorkerGlobal = 1; } catch { strict = true; }
        postMessage({ kind: 'classic', gpc: navigator.globalPrivacyControl, strict, href: location.href });`);
    } else if (requestUrl.pathname === "/assets/module.js") {
      // The template substitution carries division after a numeric literal,
      // the shape that regressed the dependency scanner into aborting ordinary
      // module Workers. It must parse and still be instrumented.
      response_.end(`import { dependencyAtEntry, leafAtEntry } from './dependency.js?dep=abc~def';
        const bytes = 2097152;
        const megabytes = \`\${(bytes / 1024 / 1024).toFixed(2)} MB\`;
        postMessage({
          kind: 'module',
          gpc: navigator.globalPrivacyControl,
          dependencyAtEntry,
          leafAtEntry,
          megabytes,
          href: location.href,
          meta: import.meta.url
        });`);
    } else if (requestUrl.pathname === "/assets/unparsed-module.js") {
      // Import attributes are outside the scanner's grammar. A module it
      // cannot parse keeps its own bytes and runs uninstrumented rather than
      // being aborted, because aborting would alter the measured page. The
      // compressed representation is served back untouched.
      const compressed = gzipSync(`import manifest from './manifest.json' with { type: 'json' };
        postMessage({
          kind: 'unparsed',
          gpc: navigator.globalPrivacyControl === true,
          manifest: manifest.ok,
          href: location.href
        });`);
      response_.setHeader("content-encoding", "gzip");
      response_.setHeader("content-length", String(compressed.byteLength));
      response_.end(compressed);
    } else if (requestUrl.pathname === "/assets/manifest.json") {
      response_.setHeader("content-type", "application/json; charset=utf-8");
      response_.end(`{"ok":true}`);
    } else if (requestUrl.pathname === "/assets/dependency.js") {
      response_.end(`import { leafAtEntry } from './leaf.js?leaf=abc~def';
        const dependencyAtEntry = navigator.globalPrivacyControl;
        export { dependencyAtEntry, leafAtEntry };`);
    } else if (requestUrl.pathname === "/assets/leaf.js") {
      response_.end("export const leafAtEntry = navigator.globalPrivacyControl;");
    } else if (requestUrl.pathname === "/assets/redirect.js") {
      response_.statusCode = 302;
      response_.setHeader("location", "final.js?redirect=abc~def");
      response_.end();
    } else if (requestUrl.pathname === "/assets/final.js") {
      response_.end("postMessage({ kind: 'redirect', gpc: navigator.globalPrivacyControl, href: location.href });");
    } else if (requestUrl.pathname === "/assets/gzip.js") {
      const compressed = gzipSync("postMessage({ kind: 'gzip', gpc: navigator.globalPrivacyControl, href: location.href });");
      response_.setHeader("content-encoding", "gzip");
      response_.setHeader("content-length", String(compressed.byteLength));
      response_.setHeader("etag", "stale-after-rewrite");
      response_.end(compressed);
    } else if (requestUrl.pathname === "/assets/shared.js") {
      response_.end(`onconnect = event => event.ports[0].postMessage({
        kind: 'shared',
        gpc: navigator.globalPrivacyControl,
        href: location.href
      });`);
    } else {
      response_.statusCode = 404;
      response_.end("not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // Registered the moment the resource exists, rather than in a finally block
  // twenty lines below. Everything between acquiring the server and entering
  // that block can throw -- chromium.launch on a runner missing browser deps,
  // exposeBinding, addInitScript -- and a leaked listening server keeps the
  // node:test process alive after its own timeout has already failed the test.
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const session = createGpcWorkerInjectionSession();
  await context.exposeBinding(session.bindingName, (source, value) => session.register(source, value));
  const page = await context.newPage();
  await page.addInitScript(installGlobalPrivacyControlWithWorkerRegistration, session.initScriptArgs);
  const transformedUrls: string[] = [];
  const routeErrors: string[] = [];
  const runtimeErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.url()}:${request.failure()?.errorText}`));
  await page.route("**/*", async (route) => {
    try {
      const fulfillment = await session.buildRouteFulfillment(route);
      if (fulfillment) {
        // A fail-open fulfillment carries the fetched response with no body of
        // ours, so only a rewritten body counts as a transformed Worker.
        if (fulfillment.body) transformedUrls.push(route.request().url());
        await route.fulfill(fulfillment);
        return;
      }
      await route.continue();
    } catch (error) {
      if (!(error instanceof GpcWorkerInjectionError)) throw error;
      routeErrors.push(`${error.reason}:${route.request().url()}`);
      await route.abort();
    }
  });

  await page.goto(`http://127.0.0.1:${address.port}/`);
  try {
    await page.waitForFunction(() => {
      try { return JSON.parse(document.title).length === 8; } catch { return false; }
    }, undefined, { timeout: 10_000 });
  } catch (error) {
    throw new Error(JSON.stringify({
      cause: error instanceof Error ? error.message : String(error),
      diagnostics: session.diagnostics(),
      originRequests,
      requestFailures,
      routeErrors,
      runtimeErrors,
      title: await page.title(),
      transformedUrls,
      workerErrors: await page.evaluate(() => (globalThis as typeof globalThis & { __workerErrors?: unknown }).__workerErrors),
      workerResults: await page.evaluate(() => (globalThis as typeof globalThis & { __testResults?: unknown }).__testResults)
    }));
  }
  assert.equal(await page.evaluate(() => (globalThis as typeof globalThis & { ordinaryMarkerScriptLoaded?: boolean }).ordinaryMarkerScriptLoaded), true);
  assert.deepEqual(JSON.parse(await page.title()), [
    {
      kind: "adversarial",
      gpc: true,
      dependencyAtEntry: true,
      href: `http://127.0.0.1:${address.port}/assets/adversarial-module.js?entry=abc~def`,
      meta: `http://127.0.0.1:${address.port}/assets/adversarial-module.js?entry=abc~def`,
      typeReads: 1
    },
    { kind: "blob", blocked: true, revoked: true },
    {
      kind: "classic",
      gpc: true,
      strict: true,
      href: `http://127.0.0.1:${address.port}/assets/classic.js?signature=abc~def`
    },
    {
      kind: "gzip",
      gpc: true,
      href: `http://127.0.0.1:${address.port}/assets/gzip.js`
    },
    {
      kind: "module",
      gpc: true,
      dependencyAtEntry: true,
      leafAtEntry: true,
      megabytes: "2.00 MB",
      href: `http://127.0.0.1:${address.port}/assets/module.js?root=abc~def`,
      meta: `http://127.0.0.1:${address.port}/assets/module.js?root=abc~def`
    },
    {
      kind: "redirect",
      blocked: true
    },
    {
      kind: "shared",
      gpc: true,
      href: `http://127.0.0.1:${address.port}/assets/shared.js?shared=abc~def`
    },
    {
      kind: "unparsed",
      gpc: false,
      manifest: true,
      href: `http://127.0.0.1:${address.port}/assets/unparsed-module.js`
    }
  ]);
  assert.equal(
    transformedUrls.some((url) => url.includes("__site_behavior_lab_gpc_worker")),
    false
  );
  assert.equal(originRequests.includes("/assets/ordinary.js?__site_behavior_lab_gpc_worker=1"), true);
  assert.equal(originRequests.includes("/assets/adversarial-module.js?entry=abc~def"), true);
  assert.equal(originRequests.includes("/assets/adversarial-dependency.js?dep=abc~def"), true);
  assert.equal(originRequests.includes("/assets/classic.js?signature=abc~def"), true);
  assert.equal(originRequests.includes("/assets/dependency.js?dep=abc~def"), true);
  assert.equal(originRequests.includes("/assets/leaf.js?leaf=abc~def"), true);
  assert.equal(originRequests.includes("/assets/shared.js?shared=abc~def"), true);
  assert.equal(originRequests.includes("/assets/final.js?redirect=abc~def"), false);
  // The unparsed module authorized nothing, so its own request is served
  // untransformed and its dependency is left to load on its own terms.
  assert.equal(originRequests.includes("/assets/unparsed-module.js"), true);
  assert.equal(originRequests.includes("/assets/manifest.json"), true);
  assert.equal(transformedUrls.some((url) => url.includes("unparsed-module.js")), false);
  assert.deepEqual(routeErrors, [
    `unsupported-worker:http://127.0.0.1:${address.port}/assets/redirect.js`
  ]);
  const constructorMarker = "site-behavior-lab.gpc-worker-registration";
  assert.equal(
    await page.evaluate((marker) => Reflect.get(Worker, Symbol.for(marker)) === true, constructorMarker),
    true
  );
  const unroutedPage = await context.newPage();
  assert.equal(
    await unroutedPage.evaluate((marker) => Reflect.get(Worker, Symbol.for(marker)) === true, constructorMarker),
    false,
    "a context sibling without this Page's route transformer must not receive the registration wrapper"
  );
  await unroutedPage.close();
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 3,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 1,
    unsupportedWorkerCount: 2
  });
  assert.match(GPC_WORKER_CAPTURE_LOSS_WARNING, /request evidence may be incomplete/);
});

function networkRegistration(
  session: ReturnType<typeof createGpcWorkerInjectionSession>,
  url: string,
  type: "classic" | "module"
) {
  return {
    capability: session.initScriptArgs.capability,
    kind: "dedicated" as const,
    outcome: "network" as const,
    protocol: new URL(url).protocol,
    type,
    url
  };
}

function workerRequest(frame: object, url: string) {
  return {
    frame: () => frame,
    headerValue: async (name: string) => name === "user-agent" ? null : "https://example.test/",
    resourceType: () => "script",
    url: () => url
  };
}

function response(status: number, body: string, headers: Record<string, string>) {
  const bytes = new TextEncoder().encode(body);
  return {
    body: async () => bytes,
    headers: () => headers,
    status: () => status
  };
}

test("a token-dense module worker fails open instead of buying unbounded parse work", async () => {
  // Page-controlled Worker source is tokenized synchronously inside the route
  // callback, and no scan deadline can preempt synchronous work. The byte cap
  // does not bound the object graph the tokenizer builds: punctuation-dense
  // source reaches roughly one token per byte, an order of magnitude denser
  // than any real bundle, so the token budget is what actually bounds it.
  // Exceeding it must take the same fail-open path an unparsed module takes.
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  const url = "https://example.test/worker.js";
  session.register({ frame }, networkRegistration(session, url, "module"));

  const hostile = ";".repeat(MAX_MODULE_TOKENS + 1);
  const started = Date.now();
  const fulfillment = await session.buildRouteFulfillment({
    request: () => workerRequest(frame, url),
    fetch: async () => response(200, hostile, {})
  });
  const elapsed = Date.now() - started;

  // Fail open: the site's own response, unchanged, with the loss counted.
  assert.ok(fulfillment, "an over-budget module must still be fulfilled, not dropped");
  assert.equal(fulfillment?.body, undefined);
  assert.equal(session.diagnostics().transformFailureCount, 1);
  assert.ok(elapsed < 5_000, `refusing an over-budget module must be cheap, took ${elapsed}ms`);
});

test("a real module under the token budget still has its specifiers rewritten", async () => {
  // The budget must not refuse genuine work.
  const session = createGpcWorkerInjectionSession({ registrationWaitMs: 0, randomBytes: FIXED_RANDOM_BYTES });
  const frame = {};
  const url = "https://example.test/real.js";
  session.register({ frame }, networkRegistration(session, url, "module"));

  const fulfillment = await session.buildRouteFulfillment({
    request: () => workerRequest(frame, url),
    fetch: async () => response(200, 'import helper from "./helper.js";\nexport const ready = helper;\n', {})
  });

  assert.ok(fulfillment?.body?.includes("installGlobalPrivacyControl"));
  assert.equal(session.diagnostics().transformFailureCount, 0);
});

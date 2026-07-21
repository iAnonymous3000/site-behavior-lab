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
  GPC_WORKER_CAPTURE_LOSS_WARNING,
  GpcWorkerInjectionError,
  injectGlobalPrivacyControlIntoWorkerSource,
  installGlobalPrivacyControl,
  installGlobalPrivacyControlWithWorkerRegistration
} from "./gpc-injection";

const FIXED_RANDOM_BYTES = new Uint8Array(Array.from({ length: 24 }, (_, index) => index + 1));

test("both producers scope the GPC registration initializer to the routed measured page", async () => {
  const [nodeProducer, cloudflareProducer] = await Promise.all([
    readFile(path.join(process.cwd(), "lib", "scanner.ts"), "utf8"),
    readFile(path.join(process.cwd(), "cloudflare", "worker.ts"), "utf8")
  ]);
  for (const source of [nodeProducer, cloudflareProducer]) {
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
  const fetchOptions: Array<{ maxRedirects: number }> = [];
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

  assert.deepEqual(fetchOptions, [{ maxRedirects: 0 }]);
  assert.equal(redirectResponse.headers().location, "/worker-final.js?signature=abc~def");
  assert.deepEqual(session.diagnostics(), {
    ambiguousWorkerRequestCount: 0,
    captureLossCount: 1,
    pendingWorkerRegistrationCount: 0,
    transformFailureCount: 0,
    unsupportedWorkerCount: 1
  });
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

test("real Chromium preserves worker URLs, injects full module graphs, and fails closed when required", { timeout: 20_000 }, async () => {
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
            if (results.length === 7) document.title = JSON.stringify(results.slice().sort((a, b) => a.kind.localeCompare(b.kind)));
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
          const redirected = new Worker('redirect.js');
          const gzipWorker = new Worker('gzip.js');
          const shared = new SharedWorker('shared.js?shared=abc~def');
          adversarial.onmessage = event => receive({
            data: { ...event.data, typeReads: adversarialTypeReads }
          });
          classic.onmessage = receive;
          moduleWorker.onmessage = receive;
          redirected.onmessage = receive;
          gzipWorker.onmessage = receive;
          shared.port.onmessage = receive;
          shared.port.start();
          redirected.onerror = event => {
            event.preventDefault();
            receive({ data: { kind: 'redirect', blocked: true } });
          };
          for (const worker of [adversarial, classic, moduleWorker, gzipWorker]) {
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
      response_.end(`import { dependencyAtEntry, leafAtEntry } from './dependency.js?dep=abc~def';
        postMessage({
          kind: 'module',
          gpc: navigator.globalPrivacyControl,
          dependencyAtEntry,
          leafAtEntry,
          href: location.href,
          meta: import.meta.url
        });`);
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

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
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
        transformedUrls.push(route.request().url());
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

  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    try {
      await page.waitForFunction(() => {
        try { return JSON.parse(document.title).length === 7; } catch { return false; }
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
      captureLossCount: 2,
      pendingWorkerRegistrationCount: 0,
      transformFailureCount: 0,
      unsupportedWorkerCount: 2
    });
    assert.match(GPC_WORKER_CAPTURE_LOSS_WARNING, /request evidence may be incomplete/);
  } finally {
    await context.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  return {
    headers: () => headers,
    status: () => status,
    text: async () => body
  };
}

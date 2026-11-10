import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { scrollCheckEvidence } from "./node-scan-measurement";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";
import type { ScrollCheckTiming } from "./scroll-check";

/**
 * What a visit registers on its browser context, its page and its DevTools
 * session, in order: every init script, binding, route, header, session and
 * listener the scanner's own code asks Playwright for, and every listener it
 * takes off again.
 *
 * The lists below are a change detector for the visit an ordinary caller
 * gets. They were first recorded against the scanner as it stood before any
 * optional visit hook existed, so a hook that added an init script or a
 * listener to a visit that did not ask for it would change a list here. A
 * deliberate change to what a visit registers updates the list in the same
 * commit and says why.
 *
 * Only calls the scanner's own modules make are recorded. Playwright
 * registers listeners of its own on the same objects (a navigation's waiters,
 * say), and whether it does depends on timing, so a call whose caller is
 * inside node_modules is left out.
 *
 * What this does not show: the order of awaits between these calls, how long
 * anything took, or what the scanner asks its own DevTools client for (the
 * worker realm channel is not Playwright's).
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

// Four screens at the desktop viewport, so a check has something to scroll,
// with no form field, no link and no banner: nothing for the input probe, the
// policy visit or a consent click to act on.
const PAGE = `<!doctype html><title>Setup fixture</title>
<style>body { margin: 0 } section { height: 980px }</style>
<img src="http://static.example.com/hero.png" alt="">
<section>One</section><section>Two</section><section>Three</section><section>Four</section>`;

const CHECK_TIMING: ScrollCheckTiming = {
  settleAfterNavigationMs: 6_000,
  controlWindowMs: 1_500,
  scrollWindowMs: 3_000,
  stepDwellMs: 250,
  deepestDwellMs: 500,
  phaseDeadlineMs: 30_000
};

/** The calls an ordinary single visit makes, in order. */
const ORDINARY_VISIT_CALLS: readonly string[] = [
  "context.addInitScript installBoundedPageCollector",
  "context.newPage",
  "page.on crash",
  "context.newCDPSession",
  "session.on Network.requestWillBeSent",
  "session.send Network.enable",
  "page.on request noteInitiatorRequest",
  "page.on worker",
  "context.newCDPSession",
  "session.send Target.getTargetInfo",
  "page.addInitScript fingerprintObserverInitScript",
  "context.route **/*",
  "page.on popup",
  "page.route **/*",
  "page.on request recordRequest",
  "page.on response recordResponse",
  "page.on request",
  "page.on request onRequest",
  "page.off request onRequest",
  "page.off request recordRequest",
  "page.off response recordResponse",
  "page.off request noteInitiatorRequest"
];

/** The calls a "Check after scrolling" visit makes, in order. */
const CHECK_VISIT_CALLS: readonly string[] = [
  "context.addInitScript installBoundedPageCollector",
  "context.newPage",
  "page.on crash",
  "context.newCDPSession",
  "session.on Network.requestWillBeSent",
  "session.send Network.enable",
  "page.on request noteInitiatorRequest",
  "page.on worker",
  "context.newCDPSession",
  "session.send Target.getTargetInfo",
  "page.addInitScript fingerprintObserverInitScript",
  "context.route **/*",
  "page.on popup",
  "page.route **/*",
  "page.on request recordRequest",
  "page.on request",
  "page.on response recordResponse",
  "page.on request",
  "page.on request onRequest",
  "page.off request onRequest",
  "page.off request recordRequest",
  "page.off response recordResponse",
  "page.off request noteInitiatorRequest",
  "page.on response noteResponse",
  "page.on requestfailed",
  "page.on framenavigated noteMainFrameNavigation",
  "page.off request",
  "page.off response noteResponse",
  "page.off requestfailed",
  "page.off framenavigated noteMainFrameNavigation"
];

type Recorder = {
  /** The calls of the visit now running, in order. */
  calls: string[];
  /** Every page a recorded context opened, oldest first. */
  pages: Page[];
  restore(): void;
};

/** Whether the code that called the wrapper is the scanner's own, not Playwright's. */
function calledByScannerCode(): boolean {
  // Frame 0 is this function and frame 1 the wrapper that asked; frame 2 is
  // the wrapper's caller.
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const caller = frames[2] ?? "";
  return !caller.includes("node_modules");
}

function describeArgument(value: unknown): string {
  if (typeof value === "function") return value.name;
  if (typeof value === "string") return `text:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
  if (value && typeof value === "object" && typeof (value as { content?: unknown }).content === "string") {
    return `content:${createHash("sha256").update((value as { content: string }).content).digest("hex").slice(0, 12)}`;
  }
  return typeof value;
}

/**
 * Wrap the named methods of one Playwright object so each call the scanner's
 * own code makes is recorded before it runs. Every wrapper calls through
 * unchanged.
 */
function record<T extends object>(target: T, label: string, methods: readonly string[], calls: string[], describe: (method: string, args: unknown[]) => string): void {
  for (const method of methods) {
    const original = (target as Record<string, unknown>)[method];
    if (typeof original !== "function") continue;
    (target as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
      if (calledByScannerCode()) calls.push(`${label}.${method}${describe(method, args)}`);
      return (original as (...inner: unknown[]) => unknown).apply(target, args);
    };
  }
}

const describeListener = (_method: string, args: unknown[]): string => {
  const name = typeof args[1] === "function" ? args[1].name : "";
  return ` ${String(args[0])}${name ? ` ${name}` : ""}`;
};

function recordSession(session: CDPSession, calls: string[]): void {
  record(session, "session", ["on", "once", "addListener", "prependListener", "off", "removeListener"], calls, describeListener);
  record(session, "session", ["send"], calls, (_method, args) => ` ${String(args[0])}`);
}

function recordPage(page: Page, calls: string[]): void {
  record(page, "page", ["on", "once", "addListener", "prependListener", "off", "removeListener"], calls, describeListener);
  record(page, "page", ["addInitScript"], calls, (_method, args) => ` ${describeArgument(args[0])}`);
  record(page, "page", ["route"], calls, (_method, args) => ` ${String(args[0])}`);
  record(page, "page", ["exposeBinding", "exposeFunction", "setExtraHTTPHeaders"], calls, () => "");
}

function recordContext(context: BrowserContext, calls: string[], pages: Page[]): void {
  record(context, "context", ["on", "once", "addListener", "prependListener", "off", "removeListener"], calls, describeListener);
  record(context, "context", ["addInitScript"], calls, (_method, args) => ` ${describeArgument(args[0])}`);
  record(context, "context", ["route"], calls, (_method, args) => ` ${String(args[0])}`);
  record(context, "context", ["exposeBinding", "exposeFunction", "setExtraHTTPHeaders"], calls, () => "");
  const newPage = context.newPage;
  context.newPage = async (...args: Parameters<BrowserContext["newPage"]>) => {
    if (calledByScannerCode()) calls.push("context.newPage");
    const page = await newPage.apply(context, args);
    recordPage(page, calls);
    pages.push(page);
    return page;
  };
  const newCDPSession = context.newCDPSession;
  context.newCDPSession = async (...args: Parameters<BrowserContext["newCDPSession"]>) => {
    if (calledByScannerCode()) calls.push("context.newCDPSession");
    const session = await newCDPSession.apply(context, args);
    recordSession(session, calls);
    return session;
  };
}

/** Record every context the scanner's own Chromium opens, until restored. */
function recordScannerChromium(): Recorder {
  const recorder: Recorder = {
    calls: [],
    pages: [],
    restore: () => {
      chromium.launch = originalLaunch;
    }
  };
  const originalLaunch = chromium.launch;
  chromium.launch = async (...args: Parameters<typeof chromium.launch>) => {
    const browser: Browser = await originalLaunch.apply(chromium, args);
    const newContext = browser.newContext;
    browser.newContext = async (...contextArgs: Parameters<Browser["newContext"]>) => {
      const context = await newContext.apply(browser, contextArgs);
      recordContext(context, recorder.calls, recorder.pages);
      return context;
    };
    return browser;
  };
  return recorder;
}

async function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    if (host === "www.example.com" && (request.url ?? "/") === "/setup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
      return;
    }
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

function visitOptions(port: number, extra: Partial<ScanSiteOptions> = {}): ScanSiteOptions {
  // The name is one a report could publish; the scanner's own proxy hook
  // routes it to the local server, so nothing leaves this machine.
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    ...extra
  };
}

const PAYLOAD = { url: "http://www.example.com/setup", device: "desktop" as const, gpcEnabled: false, consentMode: "observe" as const };

test("an ordinary visit and a check visit register exactly the listed calls, in order", { timeout: 180_000 }, async () => {
  const fixture = await startFixture();
  const recorder = recordScannerChromium();
  try {
    recorder.calls.length = 0;
    const ordinary = await scanSiteWithMeasurement(PAYLOAD, visitOptions(fixture.port));
    const ordinaryCalls = [...recorder.calls];
    assert.equal(ordinary.result.summary.status, 200);
    assert.deepEqual(ordinaryCalls, ORDINARY_VISIT_CALLS);

    recorder.calls.length = 0;
    const checked = await scanSiteWithMeasurement(
      PAYLOAD,
      visitOptions(fixture.port, { scrollCheck: true, scrollCheckTimingForTests: CHECK_TIMING })
    );
    const checkCalls = [...recorder.calls];
    // The check ran its whole sequence, so its own listeners were registered
    // and taken off again.
    assert.equal(scrollCheckEvidence(checked)?.outcome, "reached-end");
    assert.deepEqual(checkCalls, CHECK_VISIT_CALLS);

    // The recorder notices what it exists to notice. This visit is an
    // ordinary one, except that the test itself adds one init script and one
    // listener to the visit's page just before it navigates, as an unwanted
    // hook would. The list gains exactly those two calls, at that point.
    recorder.calls.length = 0;
    recorder.pages.length = 0;
    const noted = (): void => undefined;
    await scanSiteWithMeasurement(
      PAYLOAD,
      visitOptions(fixture.port, {
        onProgress: (phase) => {
          if (phase !== "navigating") return;
          const page = recorder.pages[0];
          assert.ok(page, "the recorder did not see the visit's page");
          void page.addInitScript({ content: "window.__setupFixtureAdded = true;" });
          page.on("console", noted);
        }
      })
    );
    const added = ["page.addInitScript content:cb6fe2b9a4ec", "page.on console noted"];
    const at = recorder.calls.indexOf(added[0]);
    assert.ok(at > 0, `the added init script was not recorded: ${recorder.calls.join(", ")}`);
    assert.deepEqual(recorder.calls.slice(at, at + 2), added);
    assert.equal(recorder.calls[at - 1], "page.on request", "the added calls sit where the visit was about to navigate");
    assert.deepEqual([...recorder.calls.slice(0, at), ...recorder.calls.slice(at + 2)], ORDINARY_VISIT_CALLS);
  } finally {
    recorder.restore();
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

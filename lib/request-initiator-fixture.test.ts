import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { chromium, type Browser, type CDPSession, type Request } from "playwright";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import { isRecord } from "./guards";
import { initiatorObservationFromCdpParams, RequestInitiatorIndex } from "./request-initiator";
import { browserProcessEnvironment, SCAN_CHROMIUM_LAUNCH_ARGS } from "./scanner";

/**
 * What request attribution publishes, case by case, in the browser the
 * scanner launches.
 *
 * lib/request-initiator.test.ts proves the join on hand-written CDP payloads.
 * This file feeds it Chromium's own. Each visit repeats the scanner's setup
 * (lib/scanner.ts, "Request attribution"): a fresh context, a CDP session
 * opened on the page while it is still about:blank, a bare Network.enable,
 * every Network.requestWillBeSent read by initiatorObservationFromCdpParams
 * into a RequestInitiatorIndex, every request Playwright reports counted with
 * noteRequest, and after the visit one claim() per Playwright row, keyed by
 * request.url(). Each case then pins the raw initiator shape the page-target
 * session received and what claim() returned for every row, so a Chromium
 * roll that changes either fails here instead of silently changing published
 * attribution. Cases are numbered as in the fixture table of the 2026-10-19
 * request attribution design note.
 *
 * WHAT THE PAGE SESSION DOES NOT SEE (observed on Chromium 153, the
 * chrome-headless-shell that Playwright 1.63 launches for headless: true).
 *
 * A dedicated worker is a target of its own. The page session sees the
 * worker's script request, typed "other" and naming the document that created
 * the worker, and none of the requests the worker makes, while Playwright's
 * request log, which the report publishes, holds them all. So a worker-only URL
 * is unattributed (case 11). A URL the worker shares with the page has more
 * rows than observations, so the join refuses every row of it (case 9): it
 * cannot tell which row was the observed one. Before the join counted
 * requests, both rows published the page's initiator.
 *
 * An out-of-process frame is invisible the same way, but the scanner's browser
 * makes none: chrome-headless-shell does not isolate sites by default, and
 * nothing in the scanner's launch turns isolation on. A cross-site iframe
 * therefore shares the page's process and target, its requests are observed,
 * and a URL it shares with the page is refused as conflicting (case 10). The
 * last test launches with --site-per-process to pin what would change if the
 * scanner's browser ever isolated sites.
 *
 * Left out: the scanner's init scripts, proxy, context route and worker realm
 * channel. None of them enables Network or feeds the index, and no init script
 * wraps fetch, XMLHttpRequest or sendBeacon or carries a sourceURL. The GPC
 * arm's init script does wrap Worker construction, so worker script rows in
 * that arm are not covered here.
 */

type Origins = { main: string; cross: string };

/** What Chromium sent as `initiator`, reduced to the parts the join reads. */
type InitiatorShape = {
  type: string;
  /** `initiator.url`, when Chromium sent one. */
  url?: string;
  /** The URL of every stack frame, innermost first, when Chromium sent a stack. */
  frames?: string[];
  /** Present only when the stack carried an async parent (`parent` or `parentId`). */
  asyncParent?: true;
};

type UrlOutcome = {
  /** Every initiator the page-target session received for this URL, in arrival order. */
  observed: InitiatorShape[];
  /** claim() for each Playwright row with this URL, in row order: the provenance.initiatorUrl the scanner writes, before redaction. */
  published: Array<string | null>;
};

type Visit = {
  outcomes: Record<string, UrlOutcome>;
  /** The visit's own targets as "type url", sorted: which contexts had a target of their own. */
  targets: string[];
};

type FixtureCase = {
  name: string;
  page: string;
  expected: (origins: Origins) => Visit;
};

const VISIT_TIMEOUT_MS = 10_000;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/**
 * Every file the fixture serves, by path, on both hosts. Every request the
 * pages make comes from this markup and these scripts, never from
 * page.evaluate, which would put Playwright's own frames on the stack.
 */
function fixtureFiles({ main, cross }: Origins): Record<string, string> {
  return {
    "/case1/page.html": `<!doctype html><title>1</title><img src="/case1/pixel.png">`,

    "/case2/page.html": `<!doctype html><title>2</title><script>fetch("/case2/target");</script>`,
    "/case2/target": "",

    "/case3/page.html": `<!doctype html><title>3</title><script src="/case3/loader.js"></script>`,
    "/case3/loader.js": `const tag = document.createElement("script"); tag.src = "/case3/tag.js"; document.head.appendChild(tag);`,
    "/case3/tag.js": `fetch("/case3/target");`,
    "/case3/target": "",

    // A wrapper that calls through, as monitoring agents do. fetch.bind() would
    // leave no wrap.js frame on the stack.
    "/case4/page.html":
      `<!doctype html><title>4</title><script src="/case4/wrap.js"></script><script src="/case4/app.js"></script>`,
    "/case4/wrap.js":
      `const originalFetch = window.fetch; window.fetch = function (...args) { return originalFetch.apply(this, args); };`,
    "/case4/app.js": `fetch("/case4/target");`,
    "/case4/target": "",

    "/case5/page.html": `<!doctype html><title>5</title><script src="/case5/tag.js"></script>`,
    "/case5/tag.js": `setTimeout(() => { fetch("/case5/target"); }, 0);`,
    "/case5/target": "",

    // The way a tag manager injects a custom HTML tag: a script element with
    // text and no src. The second one fetches synchronously, while its loader
    // is still on the stack.
    "/case6/page.html": `<!doctype html><title>6</title><script src="/case6/loader.js"></script>`,
    "/case6/loader.js":
      `const later = document.createElement("script");` +
      ` later.textContent = 'setTimeout(function () { fetch("/case6/target"); }, 0);';` +
      ` document.head.appendChild(later);` +
      ` const now = document.createElement("script");` +
      ` now.textContent = 'fetch("/case6/sync-target");';` +
      ` document.head.appendChild(now);`,
    "/case6/target": "",
    "/case6/sync-target": "",

    // Fixture code for the browser, a fixed string: eval is the subject of the
    // case, and it runs from a named script so the pragma competes with a
    // real name further down the stack.
    "/case7/page.html": `<!doctype html><title>7</title><script src="/case7/eval.js"></script>`,
    "/case7/eval.js": `eval('fetch("/case7/target");\\n//# sourceURL=https://forged.example/x.js');`,
    "/case7/target": "",

    "/case8/page.html":
      `<!doctype html><title>8</title><link rel="stylesheet" href="/case8/style.css"><div class="painted">x</div>`,
    "/case8/style.css": `.painted { width: 10px; height: 10px; background-image: url("/case8/background.png"); }`,

    // The worker requests the page's URL from a different script, so an
    // observation of it would conflict with the page's and be refused. The
    // page fetches /done only after the worker's request completed: done's
    // observation proves the session was still listening by then.
    "/case9/page.html": `<!doctype html><title>9</title><script src="/case9/main.js"></script>`,
    "/case9/main.js":
      `fetch("/case9/shared"); const worker = new Worker("/case9/worker.js");` +
      ` worker.onmessage = () => { fetch("/case9/done"); };`,
    "/case9/worker.js": `fetch("/case9/shared").then(() => postMessage("done"), () => postMessage("done"));`,
    "/case9/shared": "",
    "/case9/done": "",

    // The iframe is on the other loopback site and requests the page's URL by
    // its absolute form: a relative one would resolve to the iframe's own host
    // and join nothing. Its load event fires after its images, and only then
    // does the page fetch /done.
    "/case10/page.html":
      `<!doctype html><title>10</title><script src="/case10/listen.js"></script>` +
      `<img src="/case10/shared.png"><iframe src="${cross}/case10/frame.html"></iframe>`,
    "/case10/listen.js": `addEventListener("message", () => { fetch("/case10/done"); });`,
    "/case10/frame.html":
      `<!doctype html><title>10 frame</title><img src="${main}/case10/shared.png">` +
      `<img src="/case10/frame-only.png"><script src="/case10/frame.js"></script>`,
    "/case10/frame.js": `addEventListener("load", () => { parent.postMessage("done", "*"); });`,
    "/case10/done": "",

    "/case11/page.html": `<!doctype html><title>11</title><script src="/case11/main.js"></script>`,
    "/case11/main.js":
      `const worker = new Worker("/case11/worker.js"); worker.onmessage = () => { fetch("/case11/done"); };`,
    "/case11/worker.js": `fetch("/case11/worker-only").then(() => postMessage("done"), () => postMessage("done"));`,
    "/case11/worker-only": "",
    "/case11/done": ""
  };
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  return "text/plain";
}

type Fixture = {
  origins: Origins;
  /** Requests the server answered in the current visit, by absolute URL. */
  hits: Map<string, number>;
};

/**
 * One handler on 127.0.0.1 and on [::1] at the same port, so both loopback
 * sites reach it: `localhost` may resolve to ::1 first, and a port held only
 * on 127.0.0.1 could be someone else's there. A host with no IPv6 loopback
 * cannot be reached that way, so only that refusal is tolerated.
 */
async function startFixture(t: TestContext): Promise<Fixture> {
  const hits = new Map<string, number>();
  let files: Record<string, string> = {};
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0];
    const url = `http://${request.headers.host ?? ""}${path}`;
    hits.set(url, (hits.get(url) ?? 0) + 1);
    // no-store: a cached response makes no request, and the scanner's own
    // page route already disables Chromium's cache.
    const headers = { "cache-control": "no-store" };
    if (path.endsWith(".png")) {
      response.writeHead(200, { ...headers, "content-type": "image/png" });
      response.end(PNG);
    } else if (Object.hasOwn(files, path)) {
      response.writeHead(200, { ...headers, "content-type": contentType(path) });
      response.end(files[path]);
    } else {
      response.writeHead(404, headers);
      response.end();
    }
  };
  const ipv4 = createServer(handler);
  await listen(ipv4, 0, "127.0.0.1");
  t.after(() => closeServer(ipv4));
  const port = (ipv4.address() as AddressInfo).port;
  const ipv6 = createServer(handler);
  try {
    await listen(ipv6, port, "::1");
    t.after(() => closeServer(ipv6));
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") throw error;
  }
  const origins = { main: `http://127.0.0.1:${port}`, cross: `http://localhost:${port}` };
  files = fixtureFiles(origins);
  return { origins, hits };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

// closeAllConnections first: Chromium holds keep-alive sockets, and a plain
// close() would wait on them if browser teardown ever stalls.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = createNetServer();
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const port = (reservation.address() as AddressInfo).port;
      reservation.close(() => resolve(port));
    });
  });
}

type ScanBrowser = { browser: Browser; targetInfo: CDPSession };

/**
 * getSharedBrowser's launch, option for option. The flags come from the
 * scanner's own constant; nothing is added to them except `extraArgs`, which
 * only the control below passes.
 */
async function launchScanBrowser(t: TestContext, extraArgs: readonly string[] = []): Promise<ScanBrowser> {
  const devtoolsPort = await reserveLoopbackPort();
  const browser = await chromium.launch({
    headless: true,
    args: [...SCAN_CHROMIUM_LAUNCH_ARGS, `--remote-debugging-port=${devtoolsPort}`, ...extraArgs],
    chromiumSandbox: chromiumSandboxEnabled(),
    env: browserProcessEnvironment()
  });
  t.after(() => browser.close());
  t.diagnostic(`Chromium ${browser.version()} ${[...SCAN_CHROMIUM_LAUNCH_ARGS, ...extraArgs].join(" ")}`);
  // Target info comes from a browser-level session of its own, never from the
  // initiator session, which must stay exactly as the scanner leaves it.
  const targetInfo = await browser.newBrowserCDPSession();
  return { browser, targetInfo };
}

function shapeOf(initiator: unknown): InitiatorShape {
  if (!isRecord(initiator)) return { type: "<no initiator>" };
  const shape: InitiatorShape = { type: String(initiator.type) };
  if (typeof initiator.url === "string") shape.url = initiator.url;
  const stack = initiator.stack;
  if (isRecord(stack)) {
    const frames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
    shape.frames = frames.map((frame) => (isRecord(frame) && typeof frame.url === "string" ? frame.url : "<no url>"));
    if (stack.parent !== undefined || stack.parentId !== undefined) shape.asyncParent = true;
  }
  return shape;
}

async function waitFor(settled: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + VISIT_TIMEOUT_MS;
  while (!settled()) {
    if (Date.now() > deadline) throw new Error(`The fixture visit did not settle: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * One scan-shaped visit. It is over once the server has answered every
 * request the expectation names, as many times as it names it, and every row
 * Playwright reported has finished or failed. A round trip on the initiator
 * session then delivers anything the renderer sent that session before it.
 */
async function visit(scan: ScanBrowser, fixture: Fixture, page: string, expected: Visit): Promise<Visit> {
  fixture.hits.clear();
  const awaited = Object.entries(expected.outcomes)
    .filter(([, outcome]) => outcome.published.length > 0)
    .map(([url, outcome]) => [url, outcome.published.length] as const);
  const context = await scan.browser.newContext({ serviceWorkers: "block" });
  try {
    const measured = await context.newPage();

    // The scanner's order: the session opens on about:blank, its listener is
    // registered, and a bare Network.enable is sent before anything else.
    const index = new RequestInitiatorIndex();
    const received: Array<{ url: string; initiator: unknown }> = [];
    const session = await context.newCDPSession(measured);
    session.on("Network.requestWillBeSent", (params: unknown) => {
      if (isRecord(params) && isRecord(params.request) && typeof params.request.url === "string") {
        received.push({ url: params.request.url, initiator: params.initiator });
      }
      const observation = initiatorObservationFromCdpParams(params);
      if (observation) index.record(observation);
    });
    await session.send("Network.enable");

    // The scanner always routes every page request and continues those it
    // allows. That turns on interception, which also disables the cache.
    await measured.route("**/*", (route) => route.continue());
    const rows: Request[] = [];
    const ended = new Set<Request>();
    measured.on("request", (request) => {
      rows.push(request);
      index.noteRequest(request.url());
    });
    measured.on("requestfinished", (request) => ended.add(request));
    measured.on("requestfailed", (request) => ended.add(request));

    await measured.goto(`${fixture.origins.main}${page}`, { waitUntil: "domcontentloaded", timeout: VISIT_TIMEOUT_MS });
    await waitFor(
      () => awaited.every(([url, count]) => (fixture.hits.get(url) ?? 0) >= count) && rows.every((row) => ended.has(row)),
      () => JSON.stringify({ hits: [...fixture.hits], rows: rows.map((row) => [row.url(), ended.has(row)]) })
    );
    await session.send("Runtime.evaluate", { expression: "0" });

    const { targetInfos } = (await scan.targetInfo.send("Target.getTargets")) as {
      targetInfos: Array<{ type: string; url: string }>;
    };
    const targets = targetInfos
      .filter((info) => [fixture.origins.main, fixture.origins.cross].some((origin) => info.url.startsWith(`${origin}/`)))
      .map((info) => `${info.type} ${info.url}`)
      .sort();

    // Claimed after the visit, once per row in row order, as publicRecords does.
    const outcomes: Record<string, UrlOutcome> = {};
    const outcomeFor = (url: string) => (outcomes[url] ??= { observed: [], published: [] });
    for (const event of received) outcomeFor(event.url).observed.push(shapeOf(event.initiator));
    for (const row of rows) outcomeFor(row.url()).published.push(index.claim(row.url()));
    return { outcomes, targets };
  } finally {
    await context.close();
  }
}

const navigation: InitiatorShape = { type: "other" };
const parser = (url: string): InitiatorShape => ({ type: "parser", url });
const script = (...frames: string[]): InitiatorShape => ({ type: "script", frames });
/** The worker's script request: fetched by the browser, typed "other", naming the creating document. */
const workerScript = (documentUrl: string): InitiatorShape => ({ type: "other", url: documentUrl });

/** The visit's own navigation: browser-initiated, so it is observed and never attributed. */
function documentRow(page: string): Record<string, UrlOutcome> {
  return { [page]: { observed: [navigation], published: [null] } };
}

const SCANNER_CASES: FixtureCase[] = [
  {
    name: "1. an <img> in markup is typed parser and credited to the document",
    page: "/case1/page.html",
    expected: ({ main }) => {
      const page = `${main}/case1/page.html`;
      return {
        outcomes: {
          ...documentRow(page),
          [`${main}/case1/pixel.png`]: { observed: [parser(page)], published: [page] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "2. a parser-inserted inline script is a stack frame named by the document, so it publishes what case 1 does",
    page: "/case2/page.html",
    expected: ({ main }) => {
      const page = `${main}/case2/page.html`;
      return {
        outcomes: {
          ...documentRow(page),
          [`${main}/case2/target`]: { observed: [script(page)], published: [page] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "3. a script inserted by a loader is credited with its own fetch, and the loader with the script",
    page: "/case3/page.html",
    expected: ({ main }) => {
      const page = `${main}/case3/page.html`;
      const loader = `${main}/case3/loader.js`;
      const tag = `${main}/case3/tag.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [loader]: { observed: [parser(page)], published: [page] },
          [tag]: { observed: [script(loader)], published: [loader] },
          [`${main}/case3/target`]: { observed: [script(tag)], published: [tag] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "4. a fetch wrapper is the innermost named frame, so it is credited with the call it relayed",
    page: "/case4/page.html",
    expected: ({ main }) => {
      const page = `${main}/case4/page.html`;
      const wrap = `${main}/case4/wrap.js`;
      const app = `${main}/case4/app.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [wrap]: { observed: [parser(page)], published: [page] },
          [app]: { observed: [parser(page)], published: [page] },
          [`${main}/case4/target`]: { observed: [script(wrap, app)], published: [wrap] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "5. a setTimeout callback is credited to its own script, and the stack has no async parent",
    page: "/case5/page.html",
    expected: ({ main }) => {
      const page = `${main}/case5/page.html`;
      const tag = `${main}/case5/tag.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [tag]: { observed: [parser(page)], published: [page] },
          [`${main}/case5/target`]: { observed: [script(tag)], published: [tag] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "6. a script-inserted inline script is unnamed: from a timer it is not attributed, run at once it goes to its loader",
    page: "/case6/page.html",
    expected: ({ main }) => {
      const page = `${main}/case6/page.html`;
      const loader = `${main}/case6/loader.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [loader]: { observed: [parser(page)], published: [page] },
          [`${main}/case6/target`]: { observed: [script("")], published: [null] },
          [`${main}/case6/sync-target`]: { observed: [script("", loader)], published: [loader] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "7. a sourceURL pragma renames eval code, and the chosen name is what the join publishes",
    page: "/case7/page.html",
    expected: ({ main }) => {
      const page = `${main}/case7/page.html`;
      const evaluator = `${main}/case7/eval.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [evaluator]: { observed: [parser(page)], published: [page] },
          [`${main}/case7/target`]: {
            observed: [script("https://forged.example/x.js", evaluator)],
            published: ["https://forged.example/x.js"]
          }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "8. a stylesheet's background image is typed parser and credited to the stylesheet",
    page: "/case8/page.html",
    expected: ({ main }) => {
      const page = `${main}/case8/page.html`;
      const style = `${main}/case8/style.css`;
      return {
        outcomes: {
          ...documentRow(page),
          [style]: { observed: [parser(page)], published: [page] },
          [`${main}/case8/background.png`]: { observed: [parser(style)], published: [style] }
        },
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "9. a worker's request is never observed, so a URL it shares with the page is refused on both rows",
    page: "/case9/page.html",
    expected: ({ main }) => {
      const page = `${main}/case9/page.html`;
      const mainScript = `${main}/case9/main.js`;
      const worker = `${main}/case9/worker.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [mainScript]: { observed: [parser(page)], published: [page] },
          [worker]: { observed: [workerScript(page)], published: [page] },
          // Two rows, one observation: nothing says which row was observed,
          // so both are refused. Without the count, both published main.js,
          // which never made the worker's request.
          [`${main}/case9/shared`]: { observed: [script(mainScript)], published: [null, null] },
          [`${main}/case9/done`]: { observed: [script(mainScript)], published: [mainScript] }
        },
        targets: [`page ${page}`, `worker ${worker}`]
      };
    }
  },
  {
    name: "10. a cross-site iframe runs in the page's process, so its requests are observed and a shared URL is refused",
    page: "/case10/page.html",
    expected: ({ main, cross }) => {
      const page = `${main}/case10/page.html`;
      const listener = `${main}/case10/listen.js`;
      const frame = `${cross}/case10/frame.html`;
      return {
        outcomes: {
          ...documentRow(page),
          [listener]: { observed: [parser(page)], published: [page] },
          // Both observations reached the index, they disagree, and both rows
          // are refused: what the coverage boundary says happens.
          [`${main}/case10/shared.png`]: { observed: [parser(page), parser(frame)], published: [null, null] },
          // The iframe's own document request is observed on the page session.
          [frame]: { observed: [parser(page)], published: [page] },
          [`${cross}/case10/frame-only.png`]: { observed: [parser(frame)], published: [frame] },
          [`${cross}/case10/frame.js`]: { observed: [parser(frame)], published: [frame] },
          [`${main}/case10/done`]: { observed: [script(listener)], published: [listener] }
        },
        // No iframe target: the frame is not out of process.
        targets: [`page ${page}`]
      };
    }
  },
  {
    name: "11. a worker-only URL is never observed, so it is not attributed",
    page: "/case11/page.html",
    expected: ({ main }) => {
      const page = `${main}/case11/page.html`;
      const mainScript = `${main}/case11/main.js`;
      const worker = `${main}/case11/worker.js`;
      return {
        outcomes: {
          ...documentRow(page),
          [mainScript]: { observed: [parser(page)], published: [page] },
          [worker]: { observed: [workerScript(page)], published: [page] },
          [`${main}/case11/worker-only`]: { observed: [], published: [null] },
          [`${main}/case11/done`]: { observed: [script(mainScript)], published: [mainScript] }
        },
        targets: [`page ${page}`, `worker ${worker}`]
      };
    }
  }
];

test("real Chromium, launched as the scanner launches it: what the initiator join publishes for each initiator shape", { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture(t);
  const scan = await launchScanBrowser(t);
  for (const fixtureCase of SCANNER_CASES) {
    await t.test(fixtureCase.name, { timeout: 30_000 }, async () => {
      const expected = fixtureCase.expected(fixture.origins);
      assert.deepEqual(await visit(scan, fixture, fixtureCase.page, expected), expected);
    });
  }
});

/**
 * A control, not the scanner's configuration: case 10's page in a browser that
 * isolates sites. The iframe is then a target of its own, and the page session
 * still sees its document request but none of its subresource requests, exactly
 * as for a worker. The shared URL then has more rows than observations, so it
 * is refused for that reason rather than as conflicting, and the iframe's own
 * URLs go unattributed.
 */
test("real Chromium with --site-per-process: an out-of-process iframe's requests are never observed", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture(t);
  const scan = await launchScanBrowser(t, ["--site-per-process"]);
  const { main, cross } = fixture.origins;
  const page = `${main}/case10/page.html`;
  const listener = `${main}/case10/listen.js`;
  const frame = `${cross}/case10/frame.html`;
  const expected: Visit = {
    outcomes: {
      ...documentRow(page),
      [listener]: { observed: [parser(page)], published: [page] },
      [`${main}/case10/shared.png`]: { observed: [parser(page)], published: [null, null] },
      [frame]: { observed: [parser(page)], published: [page] },
      [`${cross}/case10/frame-only.png`]: { observed: [], published: [null] },
      [`${cross}/case10/frame.js`]: { observed: [], published: [null] },
      [`${main}/case10/done`]: { observed: [script(listener)], published: [listener] }
    },
    targets: [`iframe ${frame}`, `page ${page}`]
  };
  assert.deepEqual(await visit(scan, fixture, "/case10/page.html", expected), expected);
});

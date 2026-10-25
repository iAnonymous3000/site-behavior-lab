import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { scrollCheckEvidence } from "./node-scan-measurement";
import { redactHostnameV2 } from "./redaction-v2";
import { saveScanReport } from "./report-store";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { readScanTransportPayload } from "./scan-report-view";
import { SCROLL_CHECK_ROUTE_SETTLE_MS, type ScrollCheckTiming } from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";

/**
 * Answers (build brief 2026-10-25, part A) through the real scanner, against
 * a local page. Every host is a registrable name a report could publish,
 * routed by the scanner's own proxy hook to one local server that answers by
 * Host header, so nothing leaves this machine. Three hosts are dialled to a
 * closed port instead, so the proxy itself refuses them (plain HTTP twice,
 * and a CONNECT tunnel), and one is refused by the scanner's own route.
 *
 * In the window without input, the page's timers reach one host that
 * answers and one the proxy refuses. Once it scrolls, it sends a
 * navigator.sendBeacon beacon, a keepalive fetch, an image, fetches answered
 * 204, 404 and 302 (whose hop lands on a new host), a dedicated worker's
 * fetch, a GA4-format beacon to a third party and one to the site's own
 * tagging host that the proxy refuses, a fetch whose first try the server
 * drops and whose retry it answers, a fetch answered 1.5 s later, one
 * answered after the scroll window ends but within the settle, and one
 * answered 12 s later, past the settle's bound.
 */

const TEST_TIMING: ScrollCheckTiming = {
  settleAfterNavigationMs: 8_000,
  controlWindowMs: 3_000,
  scrollWindowMs: 3_000,
  stepDwellMs: 250,
  deepestDwellMs: 500,
  phaseDeadlineMs: 30_000
};

const SCREEN = 980;
const CONTROL_TIMER_MS = TEST_TIMING.settleAfterNavigationMs + Math.floor(TEST_TIMING.controlWindowMs / 2);
// How long the server holds each slow answer, from the moment it receives the request.
const SLOW = {
  "slow.juliet.net": 1_500,
  // Past the scroll window's end, which the first scroll opened, and within the settle.
  "late.lima.net": TEST_TIMING.scrollWindowMs + 600,
  // Past the settle's bound.
  "never.mike.net": TEST_TIMING.scrollWindowMs + SCROLL_CHECK_ROUTE_SETTLE_MS + 4_000
} as Record<string, number>;
const REFUSED_UPSTREAM = new Set(["down.papa.net", "dead.refused.net", "tls.refused.net", "gtm.example.com"]);
const GA = "v=2&tid=G-FIXTURE1&gtm=45je5a&_p=1&cid=111.222";

// Fixture code for the browser, fixed strings served only to the scanner's
// own Chromium.
const PAGE = `<!doctype html><title>Answers fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<section>One</section><section>Two</section><section>Three</section><section>Four</section><section>Five</section>
<script>
  var worker = new Worker("/answers-worker.js");
  setTimeout(function () {
    new Image().src = "http://pixel.timer.org/t.png";
    fetch("http://down.papa.net/t", { mode: "no-cors" });
  }, ${CONTROL_TIMER_MS});
  addEventListener("scroll", function () {
    navigator.sendBeacon("http://beacon.alpha.net/b", "x=1");
    fetch("http://keepalive.bravo.net/k", { method: "POST", body: "y=1", keepalive: true, mode: "no-cors" });
    new Image().src = "http://pixel.charlie.net/p.png";
    fetch("http://nocontent.echo.net/p204", { mode: "no-cors" });
    fetch("http://missing.foxtrot.net/p404", { mode: "no-cors" });
    fetch("http://redir.golf.net/r", { mode: "no-cors" });
    fetch("http://dead.refused.net/x", { mode: "no-cors" });
    fetch("https://tls.refused.net/x", { mode: "no-cors" });
    fetch("http://blocked.kilo.net/x", { mode: "no-cors" });
    navigator.sendBeacon("http://collect.tally.net/g/collect?${GA}&en=page_view", "");
    navigator.sendBeacon("http://gtm.example.com/g/collect?${GA}&en=scroll", "");
    fetch("http://retry.oscar.net/r?try=1", { mode: "no-cors" }).catch(function () {
      fetch("http://retry.oscar.net/r?try=2", { mode: "no-cors" });
    });
    fetch("http://slow.juliet.net/s", { mode: "no-cors" });
    fetch("http://late.lima.net/s", { mode: "no-cors" });
    fetch("http://never.mike.net/s", { mode: "no-cors" });
    worker.postMessage("go");
  }, { once: true });
</script>`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type Fixture = { server: Server; port: number; closedPort: number; hits: string[]; timers: Set<ReturnType<typeof setTimeout>> };

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function startFixture(): Promise<Fixture> {
  const hits: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let retries = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    request.resume();
    request.on("end", () => {
      if (host === "retry.oscar.net" && retries++ === 0) {
        // The first try never gets an answer.
        hits.push(`${host}${url.pathname}${url.search} dropped`);
        request.socket.destroy();
        return;
      }
      hits.push(`${host}${url.pathname}${url.search}`);
      if (host === "www.example.com" && url.pathname === "/answers") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
        return;
      }
      if (host === "www.example.com" && url.pathname === "/answers-worker.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(`onmessage = function () { fetch("http://worker.india.net/w", { mode: "no-cors" }); };`);
        return;
      }
      if (url.pathname === "/p204") {
        response.writeHead(204, { "access-control-allow-origin": "*" });
        response.end();
        return;
      }
      if (url.pathname === "/p404") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not here.");
        return;
      }
      if (host === "redir.golf.net") {
        response.writeHead(302, { location: "http://hop.hotel.net/end" });
        response.end();
        return;
      }
      const answer = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
        response.end(PNG);
      };
      const delay = SLOW[host];
      if (delay === undefined) {
        answer();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, delay);
      timers.add(timer);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port, closedPort: await freePort(), hits, timers };
}

async function stopFixture(fixture: Fixture): Promise<void> {
  for (const timer of fixture.timers) clearTimeout(timer);
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}

function visitOptions(fixture: Fixture, extra: Partial<ScanSiteOptions> = {}): ScanSiteOptions {
  return {
    publicUrlAlreadyVerified: true,
    // The scanner's own route refuses one host, as it refuses an address it cannot verify as public.
    verifyPublicUrl: async (url) => {
      if (url.hostname === "blocked.kilo.net") throw new Error("Not a public address (fixture).");
    },
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: (target) => connect(REFUSED_UPSTREAM.has(target.hostname) ? fixture.closedPort : fixture.port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    scrollCheckTimingForTests: TEST_TIMING,
    ...extra
  };
}

const PAYLOAD = { url: "http://www.example.com/answers", device: "desktop" as const, gpcEnabled: false, consentMode: "observe" as const };
const published = (host: string) => redactHostnameV2(host).value;
const listed = (window: ScrollCheckEvidence["control"]) => window?.hosts.flatMap((group) => group.hosts) ?? [];

// Every host the scroll window may list: answered, at any status.
const ANSWERED_SCROLL_HOSTS = [
  "beacon.alpha.net",
  "keepalive.bravo.net",
  "pixel.charlie.net",
  "nocontent.echo.net",
  "missing.foxtrot.net",
  "redir.golf.net",
  "hop.hotel.net",
  "worker.india.net",
  "collect.tally.net",
  "retry.oscar.net",
  "slow.juliet.net",
  "late.lima.net"
];

function assertAnswers(evidence: ScrollCheckEvidence, hits: string[]): void {
  const seen = hits.join(", ");
  assert.equal(evidence.outcome, "reached-end", JSON.stringify(evidence));
  // The window without input: the timer pixel's host is listed; the refused
  // timer is not, and counts as one with no answer.
  assert.deepEqual(listed(evidence.control), [published("pixel.timer.org")], seen);
  assert.equal(evidence.control?.requests, 1);
  assert.equal(evidence.control?.unanswered, 1);
  // While scrolling: every host that answered, at any status, the redirect's
  // hop, the worker's, the retried host and the late answer included, and no
  // host that never answered.
  assert.deepEqual([...listed(evidence.scroll)].sort(), ANSWERED_SCROLL_HOSTS.map(published).sort(), seen);
  for (const host of ["refused.net", "mike.net", "kilo.net", "papa.net"]) {
    assert.equal(JSON.stringify(evidence.scroll?.hosts).includes(host), false, `${host} is listed`);
  }
  // One answered request per listed host, the retry's second try only.
  assert.equal(evidence.scroll?.requests, ANSWERED_SCROLL_HOSTS.length);
  assert.equal(evidence.scroll?.knownHostRequests, 0);
  // No answer: the two refused upstreams, the refused tunnel's request, the
  // answer past the bound, the retry's first try, and the site's own beacon,
  // each once. The request the scanner's route refused is never one of them.
  assert.equal(evidence.scroll?.unanswered, 5, JSON.stringify(evidence.scroll));
  assert.deepEqual(evidence.incomplete, ["refused"]);
  // The answered third-party beacon is decoded; the site's own, unanswered, is not.
  const scrollEvents = evidence.events?.scroll;
  assert.ok(scrollEvents, JSON.stringify(evidence.events));
  assert.equal(scrollEvents.beacons, 1);
  assert.equal(scrollEvents.notDecoded, 0);
  assert.deepEqual(
    scrollEvents.destinations.map((destination) => [destination.format, destination.host, destination.ownSite, destination.events]),
    [["GA4", "collect.tally.net", false, [{ name: "page_view", percent: null, count: 1 }]]]
  );
  // The call stacks cover the listed hosts, and count answered requests only.
  const stacks = evidence.scroll?.stacks;
  assert.ok(stacks);
  assert.deepEqual(stacks.map((entry) => entry.host), listed(evidence.scroll));
  assert.equal(stacks.reduce((sum, entry) => sum + entry.requests, 0), ANSWERED_SCROLL_HOSTS.length);
}

test("a check counts only what got an answer, at any status, and counts the rest once as no answer", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  try {
    const envelope = await scanSiteWithMeasurement(PAYLOAD, visitOptions(fixture, { scrollCheck: true }));
    const evidence = scrollCheckEvidence(envelope) as ScrollCheckEvidence | undefined;
    assert.ok(evidence, "the check returned no evidence");
    assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
    assertAnswers(evidence, fixture.hits);
    // What the server saw: the retry's first try dropped, the late answer and
    // the one past the bound received; nothing from the refused upstreams.
    assert.ok(fixture.hits.includes("retry.oscar.net/r?try=1 dropped") && fixture.hits.includes("retry.oscar.net/r?try=2"), fixture.hits.join(", "));
    assert.ok(fixture.hits.includes("late.lima.net/s") && fixture.hits.includes("never.mike.net/s"), fixture.hits.join(", "));
    assert.equal(fixture.hits.some((hit) => /refused\.net|papa\.net|gtm\.example\.com|kilo\.net/.test(hit)), false, fixture.hits.join(", "));
  } finally {
    await closeSharedBrowserForTests();
    await stopFixture(fixture);
  }
});

test("without the option, and with it, the visit has the same response and failure listeners until its result is built", { timeout: 60_000 }, async () => {
  const fixture = await startFixture();
  try {
    const listeners = async (extra: Partial<ScanSiteOptions>): Promise<[number, number]> => {
      let counts: [number, number] = [-1, -1];
      await scanSiteWithMeasurement(
        PAYLOAD,
        visitOptions(fixture, {
          ...extra,
          // The shortest sequence the check runs, so the visit ends at once.
          scrollCheckTimingForTests: {
            settleAfterNavigationMs: 1,
            controlWindowMs: 1,
            scrollWindowMs: 9,
            stepDwellMs: 1,
            deepestDwellMs: 1,
            phaseDeadlineMs: 1
          },
          beforePassiveShieldsBoundaryForTests: async (page: Page) => {
            // Playwright's page is an event emitter; its type does not say so.
            const emitter = page as unknown as { listenerCount(event: string): number };
            counts = [emitter.listenerCount("response"), emitter.listenerCount("requestfailed")];
          }
        })
      );
      return counts;
    };
    const without = await listeners({});
    const withCheck = await listeners({ scrollCheck: true });
    assert.ok(without[0] > 0, `response listeners: ${without[0]}`);
    assert.deepEqual(withCheck, without, `response and requestfailed listeners: ${without} without the check, ${withCheck} with it`);
  } finally {
    await closeSharedBrowserForTests();
    await stopFixture(fixture);
  }
});

test("through the scan API, the immediate result carries the no-answer counts, the client reads it, and nothing is saved", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-scroll-check-answers-store-"));
  const env = {
    SITE_BEHAVIOR_LAB_REPORT_STORE_DIR: storeDir,
    [PUBLIC_R2_REPORTS_ENV]: "1",
    [BUILD_COMMIT_ENV]: "c".repeat(40),
    [CONSENT_VERIFICATION_ENV]: "1"
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    const scan: ScanRunner = (payload, options) => scanSiteWithMeasurement(payload, { ...options, ...visitOptions(fixture) });
    const prepared: PreparedScanRequest = {
      clientKey: "scroll-check-answers-fixture",
      url: PAYLOAD.url,
      device: "desktop",
      gpcEnabled: false,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 2,
      check: "scroll"
    };
    const checked = await executePreparedScan(prepared, scan, saveScanReport, undefined, false);
    if (checked.schemaVersion !== 2 || checked.reportType !== "single") throw new Error("expected an r2 single shell");
    const evidence = checked.ephemeral.scrollCheck;
    assert.ok(evidence, "the immediate result carries no check");
    assertAnswers(evidence, fixture.hits);
    // The client's own reader accepts the shell as it arrives.
    const read = readScanTransportPayload(JSON.parse(JSON.stringify(checked)));
    assert.equal(read.kind === "report" && read.loaded.source, "v2-r2-ephemeral");
    assert.equal((checked as { share?: unknown }).share, undefined);
    assert.deepEqual(await readdir(storeDir), [], "a check wrote to the share store");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await closeSharedBrowserForTests();
    await stopFixture(fixture);
    await rm(storeDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { scrollCheckEvidence } from "./node-scan-measurement";
import { saveScanReport } from "./report-store";
import { redactHostnameV2 } from "./redaction-v2";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { readScanTransportPayload } from "./scan-report-view";
import type { ScrollCheckTiming } from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence, type ScrollCheckHostStacks } from "./scroll-check-evidence";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";

/**
 * A check's call-stack hosts through the real scanner, against a local page,
 * the brief's fixture (2026-10-24, section 5). Every host is a registrable
 * name a report could publish, routed by the scanner's own proxy hook to one
 * local server that answers by Host header, so nothing leaves this machine.
 *
 * The page loads a loader from host A (cdn.alpha.net). Once the page scrolls:
 * - the loader inserts a tag script from host B (static.bravo.org) and, when
 *   it loads, calls the tag's function, which fetches from host C
 *   (pixel.charlie.com), so C's stack is B, then A; the loader also sends a
 *   request to its own host, which is not new, and draws an image a script
 *   creates (img.delta.net), which Chromium 153 sends with no stack;
 * - the loader fetches an address on api.echo.net that redirects to
 *   cdn.foxtrot.net, whose only request is the hop;
 * - the loader fetches from one unreviewed name under lima.net and draws an
 *   image from another, two raw hosts that publish as one listed host;
 * - a dedicated worker the page started fetches from cdn.golf.net, which the
 *   page reports and its session never observes;
 * - two self-named scripts run from a timer: one whose sourceURL names an
 *   address nothing requested (its fetch to cdn.hotel.net names no script),
 *   one whose sourceURL is the loader's (its fetch to cdn.juliet.net names A).
 * And in the window without input, a script's timer fetches from
 * api.kilo.net: listed there, given no stacks.
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
const CONTROL_FETCH_MS = TEST_TIMING.settleAfterNavigationMs + Math.floor(TEST_TIMING.controlWindowMs / 2);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

// Fixture code for the browser, fixed strings served only to the scanner's
// own Chromium. Every script address is a local stand-in this test's server
// answers, as in lib/connection-inspection-fixture.test.ts, so no integrity
// attribute applies, and eval with a sourceURL comment is the subject of two
// cases, as there.
const FILES: Record<string, Record<string, string>> = {
  "www.example.com": {
    "/stacks": `<!doctype html><title>Stacks fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<script src="http://cdn.alpha.net/loader.js"></script>
<section>One</section><section>Two</section><section>Three</section><section>Four</section><section>Five</section>
<script>
  var worker = new Worker("/stacks-worker.js");
  setTimeout(function () { fetch("http://api.kilo.net/timer", { mode: "no-cors" }); }, ${CONTROL_FETCH_MS});
  addEventListener("scroll", function () {
    worker.postMessage("go");
    setTimeout(eval('(function () { fetch("http://cdn.hotel.net/forged", { mode: "no-cors" }); })\\n//# sourceURL=http://forged.india.com/named.js'), 0);
    setTimeout(eval('(function () { fetch("http://cdn.juliet.net/borrowed", { mode: "no-cors" }); })\\n//# sourceURL=http://cdn.alpha.net/loader.js'), 0);
  }, { once: true });
</script>`,
    "/stacks-worker.js": `onmessage = function () { fetch("http://cdn.golf.net/beacon", { mode: "no-cors" }); };`
  },
  "cdn.alpha.net": {
    "/loader.js":
      `addEventListener("scroll", function () {` +
      ` var tag = document.createElement("script");` +
      ` tag.src = "http://static.bravo.org/tag.js";` +
      ` tag.onload = function () { window.bravoTag.send(); };` +
      ` document.head.appendChild(tag);` +
      ` new Image().src = "http://img.delta.net/i.png";` +
      ` fetch("http://cdn.alpha.net/beacon", { mode: "no-cors" });` +
      ` fetch("http://api.echo.net/redirect", { mode: "no-cors" });` +
      ` fetch("http://north.lima.net/a", { mode: "no-cors" });` +
      ` new Image().src = "http://south.lima.net/b.png";` +
      ` }, { once: true });`
  },
  "static.bravo.org": {
    "/tag.js": `window.bravoTag = { send: function () { fetch("http://pixel.charlie.com/collect", { mode: "no-cors" }); } };`
  }
};

type Fixture = { server: Server; port: number; hits: string[] };

async function startFixture(): Promise<Fixture> {
  const hits: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    hits.push(`${host}${url.pathname}`);
    if (host === "api.echo.net" && url.pathname === "/redirect") {
      response.writeHead(302, { location: "http://cdn.foxtrot.net/landing", "access-control-allow-origin": "*" });
      response.end();
      return;
    }
    const body = FILES[host]?.[url.pathname];
    if (body !== undefined) {
      const type = url.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
      response.writeHead(200, { "content-type": type });
      response.end(body);
      return;
    }
    response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
    response.end(PNG);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port, hits };
}

function visitOptions(port: number): ScanSiteOptions {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    scrollCheckTimingForTests: TEST_TIMING
  };
}

const PAGE = "http://www.example.com/stacks";
const LIMA = redactHostnameV2("north.lima.net").value;

/** The entry a listed host carries, or the test stops. */
function entry(evidence: ScrollCheckEvidence, host: string): ScrollCheckHostStacks {
  const found = evidence.scroll?.stacks?.find((candidate) => candidate.host === host);
  assert.ok(found, `no stacks for ${host}: ${JSON.stringify(evidence.scroll)}`);
  return found;
}

const NONE = { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 0, unobserved: 0 };

test("a check gives each host it first contacted while scrolling the call-stack hosts of its requests", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  try {
    const envelope = await scanSiteWithMeasurement(
      { url: PAGE, device: "desktop", gpcEnabled: false, consentMode: "observe" },
      { ...visitOptions(fixture.port), scrollCheck: true }
    );
    const evidence = scrollCheckEvidence(envelope) as ScrollCheckEvidence | undefined;
    assert.ok(evidence, "the check returned no evidence");
    assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
    const hits = fixture.hits.join(", ");
    assert.equal(evidence.outcome, "reached-end", JSON.stringify(evidence));
    for (const hit of ["static.bravo.org/tag.js", "pixel.charlie.com/collect", "cdn.foxtrot.net/landing", "cdn.golf.net/beacon", "cdn.hotel.net/forged", "cdn.juliet.net/borrowed", "south.lima.net/b.png", "cdn.alpha.net/beacon"]) {
      assert.ok(fixture.hits.includes(hit), `the page never requested ${hit}: ${hits}`);
    }
    const scroll = evidence.scroll;
    assert.ok(scroll && scroll.stacks, `no scroll window or no stacks: ${JSON.stringify(evidence)}`);
    const listed = scroll.hosts.flatMap((group) => group.hosts);
    assert.deepEqual(
      [...listed].sort(),
      ["api.echo.net", "cdn.foxtrot.net", "cdn.golf.net", "cdn.hotel.net", "cdn.juliet.net", "img.delta.net", "pixel.charlie.com", "static.bravo.org", LIMA].sort(),
      JSON.stringify(scroll)
    );
    // One entry per listed host, in the listed order.
    assert.deepEqual(scroll.stacks.map((candidate) => candidate.host), listed);
    // C's request names B, then A, innermost first; A's own request stays out.
    assert.deepEqual(entry(evidence, "pixel.charlie.com"), {
      host: "pixel.charlie.com",
      requests: 1,
      groups: [{ count: 1, hosts: ["static.bravo.org", "cdn.alpha.net"] }],
      ...NONE
    });
    assert.deepEqual(entry(evidence, "static.bravo.org").groups, [{ count: 1, hosts: ["cdn.alpha.net"] }]);
    assert.equal(listed.some((host) => host.includes("alpha")), false);
    // An image a script created on scroll: no call stack.
    assert.deepEqual(entry(evidence, "img.delta.net"), { host: "img.delta.net", requests: 1, groups: [], ...NONE, withoutStack: 1 });
    // The redirect hop is counted apart.
    assert.deepEqual(entry(evidence, "api.echo.net").groups, [{ count: 1, hosts: ["cdn.alpha.net"] }]);
    assert.deepEqual(entry(evidence, "cdn.foxtrot.net"), { host: "cdn.foxtrot.net", requests: 1, groups: [], ...NONE, redirected: 1 });
    // The worker's request on scroll: counted, never observed.
    assert.deepEqual(entry(evidence, "cdn.golf.net"), { host: "cdn.golf.net", requests: 1, groups: [], ...NONE, unobserved: 1 });
    // A self-named script is named only when its name is a requested address.
    assert.deepEqual(entry(evidence, "cdn.hotel.net"), { host: "cdn.hotel.net", requests: 1, groups: [], ...NONE, withoutNamedScript: 1 });
    assert.deepEqual(entry(evidence, "cdn.juliet.net").groups, [{ count: 1, hosts: ["cdn.alpha.net"] }]);
    // Two raw hosts that publish as one listed host: one entry for both.
    assert.deepEqual(entry(evidence, LIMA), {
      host: LIMA,
      requests: 2,
      groups: [{ count: 1, hosts: ["cdn.alpha.net"] }],
      ...NONE,
      withoutStack: 1
    });
    // The window without input lists its host and gives it no stacks.
    assert.deepEqual(evidence.control?.hosts.flatMap((group) => group.hosts), ["api.kilo.net"]);
    assert.equal(JSON.stringify(evidence.control).includes("stacks"), false);
    // The one count: each entry's requests are the requests the page made to
    // that host's raw hosts, every one of them inside the scroll window here,
    // and together they never exceed the window's own count of requests to
    // hosts it had not contacted before.
    const hitsTo = (raw: string[]) => fixture.hits.filter((hit) => raw.some((host) => hit.startsWith(`${host}/`))).length;
    const rawHosts: Record<string, string[]> = {
      "static.bravo.org": ["static.bravo.org"],
      "pixel.charlie.com": ["pixel.charlie.com"],
      "img.delta.net": ["img.delta.net"],
      "api.echo.net": ["api.echo.net"],
      "cdn.foxtrot.net": ["cdn.foxtrot.net"],
      "cdn.golf.net": ["cdn.golf.net"],
      "cdn.hotel.net": ["cdn.hotel.net"],
      "cdn.juliet.net": ["cdn.juliet.net"],
      [LIMA]: ["north.lima.net", "south.lima.net"]
    };
    for (const candidate of scroll.stacks) {
      assert.equal(candidate.requests, hitsTo(rawHosts[candidate.host]), `${candidate.host}: ${hits}`);
    }
    const total = scroll.stacks.reduce((sum, candidate) => sum + candidate.requests, 0);
    assert.ok(total <= scroll.requests - scroll.knownHostRequests, `${total} against ${scroll.requests} - ${scroll.knownHostRequests}`);
    // Hosts only: no script address, path, query or name.
    const serialized = JSON.stringify(scroll.stacks);
    for (const forbidden of ["/{seg}", "loader.js", "tag.js", "collect", "forged", "named", "send", "onload", "http:"]) {
      assert.equal(serialized.includes(forbidden), false, `the stacks carry ${forbidden}`);
    }
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("a check's stacks travel in its immediate result, which the client reads, and nothing is saved", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-scroll-stacks-store-"));
  const env = {
    SITE_BEHAVIOR_LAB_REPORT_STORE_DIR: storeDir,
    [PUBLIC_R2_REPORTS_ENV]: "1",
    [BUILD_COMMIT_ENV]: "c".repeat(40),
    [CONSENT_VERIFICATION_ENV]: "1"
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    const scan: ScanRunner = (payload, options) => scanSiteWithMeasurement(payload, { ...options, ...visitOptions(fixture.port) });
    const prepared: PreparedScanRequest = {
      clientKey: "scroll-stacks-fixture",
      url: PAGE,
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
    const stacks = checked.ephemeral.scrollCheck?.scroll?.stacks;
    assert.ok(stacks && stacks.length > 0, JSON.stringify(checked.ephemeral.scrollCheck));
    assert.deepEqual(stacks.find((candidate) => candidate.host === "pixel.charlie.com")?.groups, [{ count: 1, hosts: ["static.bravo.org", "cdn.alpha.net"] }]);
    // The client's own reader takes the shell, stacks and all, as it arrives.
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
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(storeDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getAdblockEngine, mapRequestType } from "./adblock-engine";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { scrollCheckEvidence } from "./node-scan-measurement";
import { redactHostnameV2 } from "./redaction-v2";
import { saveScanReport } from "./report-store";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { readScanTransportPayload } from "./scan-report-view";
import type { ScrollCheckTiming } from "./scroll-check";
import { scrollCheckPanelCopy } from "./scroll-check-copy";
import { scrollCheckEventsCopy } from "./scroll-check-events-copy";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";

/**
 * Same-visit list labels (build brief 2026-10-25, part B) through the real
 * scanner, its engine and the vendored lists, against a local page. Every
 * host is a registrable name a report could publish, routed by the scanner's
 * own proxy hook to one local server that answers by Host header, so nothing
 * leaves this machine. The lists' generic rules need no real host name:
 * Adobe Analytics' classic beacons match on any host, and GA4's collection
 * format matches on the site's own.
 *
 * Once the page scrolls, it sends:
 * - an Adobe beacon to a third party (metrics.adobeprobe.net): matched;
 * - a fetch and a script to two third parties that match nothing
 *   (cdn.quiet.net, static.quiet.org): no match;
 * - a fetch to api.echo.net that redirects to cdn.foxtrot.net, whose only
 *   request is the hop, which the route never sees: not compared;
 * - an Adobe beacon and a plain image to two names under lima.net that
 *   publish as one host: matched, the stronger state;
 * - a plain image to one name under mike.net and a fetch that redirects to
 *   another (through go.echo.net): no match, the stronger state;
 * - a GA4 beacon to the site's own tagging host (gtm.example.com): a
 *   destination on the site, matched.
 * In the window without input, a timer's image to a third party that matches
 * nothing.
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
const GA = "v=2&tid=G-FIXTURE1&gtm=45je5a&_p=1&cid=111.222";
const ADOBE = "/b/ss/fixturersid/1/JS-2.22.0";

// Fixture code for the browser, fixed strings served only to the scanner's
// own Chromium.
const PAGE = `<!doctype html><title>Labels fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<section>One</section><section>Two</section><section>Three</section><section>Four</section><section>Five</section>
<script>
  setTimeout(function () { new Image().src = "http://static.timer.org/t.png"; }, ${CONTROL_TIMER_MS});
  addEventListener("scroll", function () {
    new Image().src = "http://metrics.adobeprobe.net${ADOBE}/s1?AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&AQE=1";
    fetch("http://cdn.quiet.net/data.json", { mode: "no-cors" });
    var script = document.createElement("script");
    script.src = "http://static.quiet.org/lib.js";
    document.head.appendChild(script);
    fetch("http://api.echo.net/r", { mode: "no-cors" });
    new Image().src = "http://north.lima.net${ADOBE}/s3?AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2050&AQE=1";
    new Image().src = "http://south.lima.net/plain.png";
    new Image().src = "http://east.mike.net/plain.png";
    fetch("http://go.echo.net/r2", { mode: "no-cors" });
    navigator.sendBeacon("http://gtm.example.com/g/collect?${GA}&en=scroll&epn.percent_scrolled=90", "");
  }, { once: true });
</script>`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type Fixture = { server: Server; port: number; hits: string[] };

async function startFixture(): Promise<Fixture> {
  const hits: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    request.resume();
    request.on("end", () => {
      hits.push(`${host}${url.pathname}`);
      if (host === "www.example.com" && url.pathname === "/labels") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
        return;
      }
      const redirects: Record<string, string> = { "api.echo.net": "http://cdn.foxtrot.net/landing", "go.echo.net": "http://west.mike.net/landing" };
      if (redirects[host] !== undefined) {
        response.writeHead(302, { location: redirects[host] });
        response.end();
        return;
      }
      if (url.pathname.endsWith(".js")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("window.quietLibrary = true;");
        return;
      }
      response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      response.end(PNG);
    });
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

const PAYLOAD = { url: "http://www.example.com/labels", device: "desktop" as const, gpcEnabled: false, consentMode: "observe" as const };
const published = (host: string) => redactHostnameV2(host).value;

// The listed hosts in their listed order: echo.net has two, then the rest by site name.
const LISTED = ["api.echo.net", published("go.echo.net"), "metrics.adobeprobe.net", "cdn.foxtrot.net", published("north.lima.net"), published("east.mike.net"), "cdn.quiet.net", "static.quiet.org"];

function assertLabels(evidence: ScrollCheckEvidence, hits: string[]): void {
  const seen = hits.join(", ");
  assert.equal(evidence.outcome, "reached-end", JSON.stringify(evidence));
  assert.equal(evidence.filterLists, "compared");
  assert.deepEqual(evidence.scroll?.hosts.flatMap((group) => group.hosts), LISTED, seen);
  // Matched: the Adobe beacon's host, and the lima.net host whose other name matched nothing.
  assert.deepEqual(evidence.scroll?.matchedHosts, ["metrics.adobeprobe.net", published("north.lima.net")]);
  // Not compared: the host reached only by a redirect's hop. The mike.net
  // host, one of whose names was also reached only by a hop, had no match.
  assert.deepEqual(evidence.scroll?.uncomparedHosts, ["cdn.foxtrot.net"]);
  assert.deepEqual(evidence.control?.hosts.flatMap((group) => group.hosts), ["static.timer.org"]);
  assert.deepEqual([evidence.control?.matchedHosts, evidence.control?.uncomparedHosts], [[], []]);
  // Every destination carries its state; the site's own GA4 address matched.
  assert.deepEqual(
    evidence.events?.scroll?.destinations.map((destination) => [destination.format, destination.host, destination.ownSite, destination.lists]),
    [
      ["GA4", published("gtm.example.com"), true, "matched"],
      ["Adobe Analytics", "metrics.adobeprobe.net", false, "matched"],
      ["Adobe Analytics", published("north.lima.net"), false, "matched"]
    ]
  );
  // The window without input sent no analytics beacon.
  assert.deepEqual(evidence.events?.control, { beacons: 0, destinations: [], notDecoded: 0 });
}

test("a check labels each listed host and destination with the same visit's list decisions, in three states", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  try {
    const envelope = await scanSiteWithMeasurement(PAYLOAD, { ...visitOptions(fixture.port), scrollCheck: true });
    const evidence = scrollCheckEvidence(envelope) as ScrollCheckEvidence | undefined;
    assert.ok(evidence, "the check returned no evidence");
    assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
    assertLabels(evidence, fixture.hits);
    // Each label is what the scanner's own engine says of that request, as
    // the route asked it: no other rule.
    const engine = await getAdblockEngine();
    assert.ok(engine);
    const source = "http://www.example.com/labels";
    const verdict = (url: string, type: string) => engine.checkWithMethod(url, source, mapRequestType(type), "GET");
    assert.equal(verdict(`http://metrics.adobeprobe.net${ADOBE}/s1?AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&AQE=1`, "image"), true);
    assert.equal(verdict("http://cdn.quiet.net/data.json", "fetch"), false);
    assert.equal(verdict("http://south.lima.net/plain.png", "image"), false);
    // The hop's address would match nothing either way: what makes it not
    // compared is that the route never saw it. Both hops reached the server.
    assert.equal(verdict("http://cdn.foxtrot.net/landing", "fetch"), false);
    assert.ok(fixture.hits.includes("cdn.foxtrot.net/landing") && fixture.hits.includes("west.mike.net/landing"), fixture.hits.join(", "));
    // The words the result shows for this very evidence.
    const panel = scrollCheckPanelCopy(evidence);
    assert.deepEqual(panel.control?.groups, [{ state: "no-match", heading: "1 had none that matched:", sites: ["timer.org: static.timer.org"] }]);
    assert.deepEqual(panel.scroll?.groups, [
      {
        state: "matched",
        heading: "2 had a request that matched the default filter lists of Brave Shields:",
        sites: ["adobeprobe.net: metrics.adobeprobe.net", "lima.net: *.lima.net"]
      },
      { state: "no-match", heading: "5 had none that matched:", sites: ["echo.net: api.echo.net, *.echo.net", "mike.net: *.mike.net", "quiet.net: cdn.quiet.net", "quiet.org: static.quiet.org"] },
      {
        state: "not-compared",
        heading: "1 had no request this check compared with the lists; it does not compare requests that followed a redirect:",
        sites: ["foxtrot.net: cdn.foxtrot.net"]
      }
    ]);
    assert.deepEqual(panel.caveats.slice(0, 2), [
      "Matching is computed while the page loads normally; it is not a measured block.",
      "With blocking on, what a matched request would load never runs, so a visit with Shields might also skip hosts that had no match."
    ]);
    const section = scrollCheckEventsCopy(evidence);
    assert.deepEqual(section?.destinations, [
      "GA4 events to *.example.com, an address on this site (matched the default filter lists of Brave Shields): scroll (90%).",
      "Adobe Analytics events to metrics.adobeprobe.net (matched the default filter lists of Brave Shields): scroll depth 25%.",
      "Adobe Analytics events to *.lima.net (matched the default filter lists of Brave Shields): scroll depth 50%."
    ]);
    assert.equal(
      section?.standardSetting,
      "Brave says its default Standard setting does not apply these lists to requests to a site's own addresses; its Aggressive setting does."
    );
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("through the scan API, the immediate result carries the labels, the client reads it, and nothing is saved", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-scroll-check-labels-store-"));
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
      clientKey: "scroll-check-labels-fixture",
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
    assertLabels(evidence, fixture.hits);
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

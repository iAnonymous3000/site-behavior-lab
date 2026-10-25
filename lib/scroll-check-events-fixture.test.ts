import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SCROLL_DEPTH_EVENT } from "./analytics-event-vocabulary";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { scrollCheckEvidence } from "./node-scan-measurement";
import { saveScanReport } from "./report-store";
import { redactHostnameV2 } from "./redaction-v2";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { readScanTransportPayload } from "./scan-report-view";
import type { ScrollCheckTiming } from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";

/**
 * A check's analytics events through the real scanner, against a local page,
 * the brief's fixture (2026-10-25, section 5). Every host is a registrable
 * name a report could publish, outside the HSTS preload list, routed by the
 * scanner's own proxy hook to one local server that answers by Host header,
 * so nothing leaves this machine.
 *
 * The page sends:
 * - in the window without input, a GA4-format beacon on a timer, to a third
 *   party (collect.tally.net);
 * - once it scrolls, GA4 batched beacons with navigator.sendBeacon to the
 *   site's own tagging host (gtm.example.com), one more GA4 beacon whose body
 *   is past the scanner's 64,000-character cap, Adobe-format links to a third
 *   party (metrics.adobeprobe.net), one by image and one long enough to go by
 *   POST, and a Universal Analytics beacon, which the check does not read.
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
const CONTROL_BEACON_MS = TEST_TIMING.settleAfterNavigationMs + Math.floor(TEST_TIMING.controlWindowMs / 2);
const GA = "v=2&tid=G-FIXTURE1&gtm=45je5a&_p=1&cid=111.222&ul=en-us";
const ADOBE = "http://metrics.adobeprobe.net/b/ss/fixturersid/1/JS-2.22.0";

// Fixture code for the browser, fixed strings served only to the scanner's
// own Chromium.
const PAGE = `<!doctype html><title>Events fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<section>One</section><section>Two</section><section>Three</section><section>Four</section><section>Five</section>
<script>
  var GA = ${JSON.stringify(GA)} + "&dl=" + encodeURIComponent(location.href) + "&dt=Events%20fixture";
  setTimeout(function () {
    navigator.sendBeacon("http://collect.tally.net/g/collect?" + GA + "&en=user_engagement&_et=4000", "");
  }, ${CONTROL_BEACON_MS});
  addEventListener("scroll", function () {
    navigator.sendBeacon("http://gtm.example.com/g/collect?" + GA + "&en=scroll_depth_20%25", "en=scroll&epn.percent_scrolled=90&_et=12\\r\\nen=video_player_load\\r\\nen=page_view");
    navigator.sendBeacon("http://gtm.example.com/g/collect?" + GA, "en=scroll_depth_40%25\\r\\nen=scroll_depth_60%25&ep.section=two");
    fetch("http://gtm.example.com/g/collect?" + GA + "&en=page_view", { method: "POST", body: "en=scroll\\r\\nen=load&ep.pad=" + new Array(100001).join("y"), mode: "no-cors" });
    new Image().src = ${JSON.stringify(ADOBE)} + "/s1?AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&events=event41&AQE=1";
    var xhr = new XMLHttpRequest();
    xhr.open("POST", ${JSON.stringify(ADOBE)} + "/s2");
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    xhr.send("AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2050&events=event42&c1=" + new Array(3001).join("x") + "&AQE=1");
    new Image().src = "http://collect.tally.net/collect?v=1&tid=UA-1-1&t=event&ec=scroll";
  }, { once: true });
</script>`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type Hit = { host: string; path: string; method: string; bodyChars: number };
type Fixture = { server: Server; port: number; hits: Hit[] };

async function startFixture(): Promise<Fixture> {
  const hits: Hit[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    let bodyChars = 0;
    request.on("data", (chunk: Buffer) => {
      bodyChars += chunk.length;
    });
    request.on("end", () => {
      hits.push({ host, path: url.pathname, method: request.method ?? "", bodyChars });
      if (host === "www.example.com" && url.pathname === "/events") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
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

const URL_UNDER_TEST = "http://www.example.com/events";
const OWN = redactHostnameV2("gtm.example.com").value;
const line = (name: string, percent: number | null = null, count = 1) => ({ name, percent, count });
const depth = (percent: number) => line(SCROLL_DEPTH_EVENT, percent);

const EXPECTED_EVENTS = {
  control: {
    beacons: 1,
    destinations: [{ format: "GA4", host: "collect.tally.net", ownSite: false, beacons: 1, events: [line("user_engagement")], customEvents: 0 }],
    notDecoded: 0
  },
  scroll: {
    beacons: 5,
    destinations: [
      {
        format: "GA4",
        host: OWN,
        ownSite: true,
        beacons: 3,
        events: [line("page_view", null, 2), line("scroll", 90), depth(20), depth(40), depth(60)],
        customEvents: 1
      },
      { format: "Adobe Analytics", host: "metrics.adobeprobe.net", ownSite: false, beacons: 2, events: [depth(25), depth(50)], customEvents: 0 }
    ],
    // The beacon whose body passed the scanner's cap: its URL's event is
    // counted, its body's are not guessed at.
    notDecoded: 1
  }
};

test("a check reports the GA4 and Adobe Analytics events its page sent in each window, the site's own collection host included", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  try {
    const envelope = await scanSiteWithMeasurement(
      { url: URL_UNDER_TEST, device: "desktop", gpcEnabled: false, consentMode: "observe" },
      { ...visitOptions(fixture.port), scrollCheck: true }
    );
    const evidence = scrollCheckEvidence(envelope) as ScrollCheckEvidence | undefined;
    assert.ok(evidence, "the check returned no evidence");
    assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
    assert.equal(evidence.outcome, "reached-end", JSON.stringify(evidence));
    const hits = JSON.stringify(fixture.hits.filter((hit) => hit.host !== "www.example.com"));
    // Every beacon reached the local server through the scanner's proxy,
    // the batched bodies whole.
    const received = (host: string, pathname: string, method: string) => fixture.hits.filter((hit) => hit.host === host && hit.path === pathname && hit.method === method);
    assert.equal(received("collect.tally.net", "/g/collect", "POST").length, 1, hits);
    assert.equal(received("gtm.example.com", "/g/collect", "POST").length, 3, hits);
    assert.ok(received("gtm.example.com", "/g/collect", "POST").some((hit) => hit.bodyChars > 100_000), hits);
    assert.equal(received("metrics.adobeprobe.net", "/b/ss/fixturersid/1/JS-2.22.0/s1", "GET").length, 1, hits);
    assert.equal(received("metrics.adobeprobe.net", "/b/ss/fixturersid/1/JS-2.22.0/s2", "POST").length, 1, hits);
    assert.equal(received("collect.tally.net", "/collect", "GET").length, 1, hits);
    assert.deepEqual(evidence.events, EXPECTED_EVENTS, JSON.stringify(evidence.events));
    // The host lists stay as the check always made them: the site's own
    // tagging host is never listed; the two third parties are listed in the
    // window that first contacted each.
    assert.deepEqual(evidence.control?.hosts, [{ site: "tally.net", hosts: ["collect.tally.net"] }]);
    assert.deepEqual(evidence.scroll?.hosts, [{ site: "adobeprobe.net", hosts: ["metrics.adobeprobe.net"] }]);
    // Names in the scanner's words only: no site name, parameter, id or address.
    const serialized = JSON.stringify(evidence.events);
    for (const forbidden of ["video_player_load", "scroll_depth", "On scroll_tracking", "G-FIXTURE1", "fixturersid", "event41", "111.222", "Events fixture", "/g/collect", "/b/ss/", "http", "UA-1-1"]) {
      assert.equal(serialized.includes(forbidden), false, `the events carry ${forbidden}`);
    }
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("a check's events travel in its immediate result, which the client reads, and nothing is saved", { timeout: 120_000 }, async () => {
  const fixture = await startFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-scroll-events-store-"));
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
      clientKey: "scroll-events-fixture",
      url: URL_UNDER_TEST,
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
    const events = checked.ephemeral.scrollCheck?.events;
    assert.deepEqual(events, EXPECTED_EVENTS, JSON.stringify(checked.ephemeral.scrollCheck));
    // The client's own reader takes the shell, events and all, as it arrives.
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

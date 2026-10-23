import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import type { Page } from "playwright";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { scrollCheckEvidence, type NodeScanMeasurementEnvelope } from "./node-scan-measurement";
import { BUILD_COMMIT_ENV } from "./runtime-scan-report";
import { SCROLL_CHECK_TIMING, type ScrollCheckTiming } from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";

/**
 * "Check after scrolling" through the real scanner, against local pages.
 *
 * Every host below is a registrable name a report could publish, routed by
 * the scanner's own proxy hook to one local server that answers by Host
 * header, so nothing leaves this machine. The check runs on test timing (the
 * same sequence, shortened) except in one visit at the production timing.
 *
 * The pages are the design note's (section 4, item 1) under programmatic
 * scrolling, and the brief's own: a timer pixel in the window without input,
 * lazy third-party content below the fold, an overflow lock under a modal, an
 * address the page changes as it scrolls, a page that leaves its site, an
 * endless feed, an inner scroll container, a page that fits the window, a
 * page that snaps back, and a page that makes more than 1,000 requests before
 * the check.
 */

const TEST_TIMING: ScrollCheckTiming = {
  settleAfterNavigationMs: 8_000,
  controlWindowMs: 3_000,
  scrollWindowMs: 3_000,
  stepDwellMs: 250,
  deepestDwellMs: 500,
  phaseDeadlineMs: 30_000
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** When the page's own timers fire, from its first script, for a timing. */
function timersFor(timing: ScrollCheckTiming) {
  return {
    // After the single scan's evidence boundary, before the window without input.
    betweenMs: timing.settleAfterNavigationMs - 2_500,
    // Inside the window without input, well clear of both its edges.
    controlPixelMs: timing.settleAfterNavigationMs + Math.min(3_000, Math.floor(timing.controlWindowMs / 2))
  };
}

// A screen's worth of content at the desktop viewport (1440 x 980).
const SCREEN = 980;

// Fixture code for the browser, fixed strings served only to the scanner's
// own Chromium. Every script address is a local stand-in this test's server
// answers, as in lib/connection-inspection-fixture.test.ts, so no integrity
// attribute applies.
function pages(timing: ScrollCheckTiming): Record<string, Record<string, string>> {
  const timers = timersFor(timing);
  const watchInput = `
  for (const type of ["wheel", "mousemove", "mousedown", "pointerdown", "keydown", "touchstart", "click"]) {
    addEventListener(type, function () { fetch("http://input.watch.net/" + type, { mode: "no-cors" }); }, { once: true, capture: true });
  }`;
  // The rich page: seven screens, so eight steps reach its end. The compared
  // page leaves out the native lazy image, whose row Chromium attributes in
  // some visits and not others with no check at all (the initiator event
  // races the request event), so two visits of it could differ for a reason
  // that has nothing to do with the check.
  const rich = (nativeLazyImage: boolean) => `<!doctype html><title>Lazy fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px } #banner { position: fixed; bottom: 0 }</style>
<script src="http://early.tracker.net/a.js"></script>
<img src="http://static.example.com/hero.png" alt="">
<iframe src="http://frame.inview.net/embed" width="300" height="200"></iframe>
<div id="banner">This site uses cookies.</div>
<section>One</section>
<section>Two${nativeLazyImage ? ` <img loading="lazy" src="http://static.example.com/lazy.png" alt="">` : ""}</section>
<section>Three</section>
<section id="io-target">Four</section>
<section id="embed-slot">Five</section>
<section>Six</section>
<section>Seven</section>
<script>
  ${watchInput}
  setTimeout(function () { new Image().src = "http://between.tracker.net/p.png"; }, ${timers.betweenMs});
  setTimeout(function () { new Image().src = "http://pixel.timer.org/p.png"; }, ${timers.controlPixelMs});
  var depth50 = false, depth90 = false, pushed = false, consented = false;
  addEventListener("scroll", function () {
    var depth = (scrollY + innerHeight) / document.documentElement.scrollHeight;
    if (depth >= 0.5 && !depth50) { depth50 = true; fetch("http://depth.beacon.org/50", { mode: "no-cors" }); }
    if (depth >= 0.9 && !depth90) { depth90 = true; fetch("http://depth.beacon.org/90", { mode: "no-cors" }); }
    if (scrollY > ${2 * SCREEN} && !pushed) { pushed = true; history.pushState({}, "", "/lazy/next-article"); }
    if (!consented) {
      // A consent tool that records consent on scroll, and a banner that only hides.
      consented = true;
      document.cookie = "OptanonConsent=groups=C0001%3A1%2CC0002%3A1; path=/";
      new Image().src = "http://vendor.consent.net/c.png";
      document.getElementById("banner").hidden = true;
    }
  });
  // A script lock on the wheel, which programmatic scrolling never meets.
  addEventListener("wheel", function (event) { event.preventDefault(); }, { passive: false });
  new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) new Image().src = "http://pixel.io.net/seen.png";
  }).observe(document.getElementById("io-target"));
  // A lazy third-party iframe, inserted when its slot comes into view.
  new IntersectionObserver(function (entries, observer) {
    if (!entries[0].isIntersecting) return;
    observer.disconnect();
    var frame = document.createElement("iframe");
    frame.src = "http://player.lazy.net/embed";
    document.getElementById("embed-slot").appendChild(frame);
  }).observe(document.getElementById("embed-slot"));
</script>`;
  return {
    "www.example.com": {
      "/lazy": rich(true),
      "/compare": rich(false),
      // Scrolling turned off under a modal: never scrolled.
      "/locked": `<!doctype html><title>Locked fixture</title>
<style>html, body { margin: 0; overflow: hidden } section { height: ${SCREEN}px }
.modal { position: fixed; inset: 20%; background: white }</style>
<div class="modal">Subscribe to read on.</div>
<section>One</section><section>Two</section><section>Three</section><section>Four</section>
<script>
  addEventListener("scroll", function () { fetch("http://after.lock.net/moved", { mode: "no-cors" }); }, { once: true });
</script>`,
      "/short": `<!doctype html><title>Short fixture</title><p>Short page.</p>
<script>setTimeout(function () { new Image().src = "http://pixel.timer.org/short.png"; }, ${timers.controlPixelMs});</script>`,
      // An inner scroll container: the document itself fits the window.
      "/inner": `<!doctype html><title>Inner fixture</title>
<style>body { margin: 0 } .scroller { height: 100vh; overflow: auto } .scroller div { height: ${SCREEN * 5}px }</style>
<div class="scroller"><div>Tall inner content.</div></div>`,
      // An endless feed: every scroll near the bottom adds two screens and an ad slot.
      "/feed": `<!doctype html><title>Feed fixture</title>
<style>body { margin: 0 } article { height: ${SCREEN}px }</style>
<main id="feed"><article>One</article><article>Two</article></main>
<script>
  var slots = 0;
  addEventListener("scroll", function () {
    if (scrollY + innerHeight < document.documentElement.scrollHeight - ${SCREEN}) return;
    for (var index = 0; index < 2; index += 1) document.getElementById("feed").appendChild(document.createElement("article"));
    slots += 1;
    fetch("http://feed.ads.net/slot?n=" + slots, { mode: "no-cors" });
  });
</script>`,
      // A page that snaps back to its top whenever it is scrolled.
      "/stuck": `<!doctype html><title>Stuck fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<section>One</section><section>Two</section><section>Three</section>
<script>addEventListener("scroll", function () { scrollTo(0, 0); });</script>`,
      // A page that leaves its site on its first scroll.
      "/leaves": `<!doctype html><title>Leaving fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<section>One</section><section>Two</section><section>Three</section>
<script>addEventListener("scroll", function () { location.href = "http://www.elsewhere.org/"; }, { once: true });</script>`,
      // More than 1,000 requests before the check, then one more on scroll.
      "/many": `<!doctype html><title>Many fixture</title>
<style>body { margin: 0 } section { height: ${SCREEN}px }</style>
<section>One</section><section>Two</section><section>Three</section>
<div id="bulk"></div>
<script>
  var bulk = document.getElementById("bulk");
  for (var index = 0; index < 1100; index += 1) {
    var image = document.createElement("img");
    image.src = "http://bulk.images.net/i/" + index + ".png";
    bulk.appendChild(image);
  }
  addEventListener("scroll", function () { fetch("http://late.after-cap.net/p", { mode: "no-cors" }); }, { once: true });
</script>`
    },
    "frame.inview.net": {
      "/embed": `<!doctype html><title>Frame</title><p>An embedded frame.</p><script>${watchInput.replaceAll("input.watch.net", "frame.inview.net/input")}</script>`
    },
    "player.lazy.net": { "/embed": `<!doctype html><title>Player</title><p>A lazy player.</p>` },
    "www.elsewhere.org": { "/": `<!doctype html><title>Elsewhere</title><p>Another site.</p>` },
    "early.tracker.net": { "/a.js": `window.earlyTag = true;` }
  };
}

type Fixture = { server: Server; port: number; hits: string[] };

async function startFixture(timing: ScrollCheckTiming): Promise<Fixture> {
  const files = pages(timing);
  const hits: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    hits.push(`${host}${url.pathname}${url.search}`);
    // A page the visit cannot load normally: the check must not run on it.
    if (host === "www.example.com" && url.pathname === "/missing") {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Not found</title><p>This page does not exist.</p>");
      return;
    }
    const body = files[host]?.[url.pathname];
    if (body !== undefined) {
      const type = url.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
      response.writeHead(200, { "content-type": type });
      response.end(body);
      return;
    }
    // Every other address answers with a pixel, so a page's lazy, timed and
    // scrolled requests all load.
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

function visitOptions(port: number, extra: Partial<ScanSiteOptions> = {}): ScanSiteOptions {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    ...extra
  };
}

const PAYLOAD = (path: string) => ({ url: `http://www.example.com${path}`, device: "desktop" as const, gpcEnabled: false, consentMode: "observe" as const });

async function visit(fixture: Fixture, path: string, extra: Partial<ScanSiteOptions> = {}): Promise<NodeScanMeasurementEnvelope> {
  return scanSiteWithMeasurement(PAYLOAD(path), visitOptions(fixture.port, extra));
}

async function checkVisit(
  fixture: Fixture,
  path: string,
  extra: Partial<ScanSiteOptions> = {}
): Promise<{ envelope: NodeScanMeasurementEnvelope; evidence: ScrollCheckEvidence }> {
  const envelope = await visit(fixture, path, { scrollCheck: true, scrollCheckTimingForTests: TEST_TIMING, ...extra });
  const evidence = scrollCheckEvidence(envelope) as ScrollCheckEvidence | undefined;
  assert.ok(evidence, `the check of ${path} returned no evidence`);
  assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
  return { envelope, evidence };
}

const listed = (window: ScrollCheckEvidence["control"]) => window?.hosts.flatMap((group) => group.hosts) ?? [];

/** The runtime report's public part, with what differs between any two visits (ids, times, durations) blanked. */
function ordinaryReport(envelope: NodeScanMeasurementEnvelope): unknown {
  const shell = buildRuntimeScanReportV2R2(envelope, "public-api", { ...process.env, [BUILD_COMMIT_ENV]: "c".repeat(40) });
  const { ephemeral: _ephemeral, ...publicPart } = shell as unknown as Record<string, unknown>;
  return blankVisitNoise(publicPart);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
function blankVisitNoise(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => blankVisitNoise(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, blankVisitNoise(item, name)]));
  }
  if (typeof value === "number" && (/Ms$|At$/.test(key) || key === "durationMs")) return "<time>";
  if (typeof value === "string" && (ISO_TIME.test(value) || /^(?:runId|reportId|pairId)$/.test(key))) return "<id-or-time>";
  if (typeof value === "string" && key === "id" && /^\d{8}-[0-9a-f]{32}$/.test(value)) return "<id>";
  return value;
}

async function withR2Env<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env[CONSENT_VERIFICATION_ENV];
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[CONSENT_VERIFICATION_ENV];
    else process.env[CONSENT_VERIFICATION_ENV] = previous;
  }
}

test("a check lists what the page first contacted in each window, by the report's own rule", { timeout: 120_000 }, async () => {
  const fixture = await startFixture(TEST_TIMING);
  try {
    await withR2Env(async () => {
      const { envelope, evidence } = await checkVisit(fixture, "/lazy");
      const hits = fixture.hits.join(", ");
      assert.equal(evidence.outcome, "reached-end", JSON.stringify(evidence));
      assert.ok(evidence.screens >= 6, `the check scrolled only ${evidence.screens} screens`);
      // The timer pixel arrived in the window without input, not the scroll window.
      assert.deepEqual(listed(evidence.control), ["pixel.timer.org"], hits);
      // What scrolling reached: the lazy iframe, the in-view pixel, the depth
      // beacons and the consent vendor, each first contacted while scrolling.
      assert.deepEqual(
        evidence.scroll?.hosts,
        [
          { site: "beacon.org", hosts: ["{label}.beacon.org"] },
          { site: "consent.net", hosts: ["{label}.consent.net"] },
          { site: "io.net", hosts: ["pixel.io.net"] },
          { site: "lazy.net", hosts: ["{label}.lazy.net"] }
        ],
        hits
      );
      assert.equal(evidence.scroll?.hostCount, 4);
      // Both depth beacons reached the server; one host.
      assert.ok(fixture.hits.includes("depth.beacon.org/50") && fixture.hits.includes("depth.beacon.org/90"), hits);
      // Contacted before the boundary, or after it and before the window: new in neither.
      assert.ok(fixture.hits.includes("between.tracker.net/p.png"), `the between timer never fired: ${hits}`);
      assert.equal(JSON.stringify(evidence).includes("tracker"), false);
      // The single scan's own report holds none of it: the boundary came first.
      assert.equal(JSON.stringify(envelope.result).includes("between.tracker"), false, "the between timer fired before the evidence boundary");
      assert.equal(JSON.stringify(envelope.result).includes("pixel.timer"), false);
      // The page changed its own address while scrolling; the visit's own
      // address is the single scan's, read before the check began.
      assert.equal(evidence.addressChanged, true);
      assert.equal(envelope.measurement.emissionInputs.observedUrl, "http://www.example.com/lazy");
      // No pointer, wheel, key, touch or click reached the page or its frame.
      assert.equal(fixture.hits.some((hit) => hit.startsWith("input.watch.net") || hit.startsWith("frame.inview.net/input")), false, hits);
      assert.deepEqual(evidence.incomplete, []);
    });
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("each page ends the check as the outline says", { timeout: 180_000 }, async () => {
  const fixture = await startFixture(TEST_TIMING);
  try {
    const [locked, short, inner, feed, stuck, leaves, missing] = await Promise.all(
      ["/locked", "/short", "/inner", "/feed", "/stuck", "/leaves", "/missing"].map((path) => checkVisit(fixture, path))
    );
    const hits = fixture.hits.join(", ");
    // A page the visit could not load normally (HTTP 404): the load gate the
    // consent click and the typing probe use keeps the check from running.
    assert.equal(missing.envelope.result.summary.status, 404);
    assert.deepEqual([missing.evidence.outcome, missing.evidence.control, missing.evidence.scroll], ["not-run", null, null]);
    // Locked under a modal: never scrolled, so the page never moved.
    assert.deepEqual([locked.evidence.outcome, locked.evidence.screens, locked.evidence.scroll], ["locked", 0, null]);
    assert.ok(locked.evidence.control, "the window without input ran on the locked page");
    assert.equal(fixture.hits.includes("after.lock.net/moved"), false, `the locked page moved: ${hits}`);
    assert.deepEqual([short.evidence.outcome, short.evidence.screens], ["nothing-to-scroll", 0]);
    assert.deepEqual(listed(short.evidence.control), ["pixel.timer.org"]);
    assert.deepEqual([inner.evidence.outcome, inner.evidence.screens], ["nothing-to-scroll", 0]);
    assert.deepEqual([feed.evidence.outcome, feed.evidence.screens], ["depth-limit", 8]);
    assert.deepEqual(listed(feed.evidence.scroll), ["{label}.ads.net"]);
    assert.deepEqual([stuck.evidence.outcome, stuck.evidence.screens, stuck.evidence.scroll], ["did-not-move", 0, null]);
    assert.equal(leaves.evidence.outcome, "left-site");
    assert.equal(leaves.evidence.scroll, null);
    assert.ok(fixture.hits.includes("www.elsewhere.org/"), hits);
    // The single scan's own result kept its own address throughout.
    assert.equal(leaves.envelope.measurement.emissionInputs.observedUrl, "http://www.example.com/leaves");
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("a check that uses up its own allowance says so, and lists no host it refused", { timeout: 120_000 }, async () => {
  const fixture = await startFixture(TEST_TIMING);
  try {
    // Room for one routed request after the single scan's result is built.
    const { evidence } = await checkVisit(fixture, "/lazy", { scrollCheckRequestAllowanceForTests: 1 });
    assert.ok(evidence.incomplete.includes("check-allowance"), JSON.stringify(evidence));
    assert.ok(listed(evidence.scroll).length < 4, `the check listed hosts its allowance refused: ${JSON.stringify(evidence.scroll)}`);
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("the check never touches the ordinary result: with or without it, thrown or timed out, the report is the same", { timeout: 180_000 }, async () => {
  const fixture = await startFixture(TEST_TIMING);
  try {
    await withR2Env(async () => {
      const ordinary = await visit(fixture, "/compare");
      assert.equal(scrollCheckEvidence(ordinary), undefined);
      const baseline = ordinaryReport(ordinary);
      // The comparison holds the report itself: its request log and its warnings.
      const baselineText = JSON.stringify(baseline);
      // Published as the report publishes hosts: "{label}.tracker.net" and so on.
      assert.ok(baselineText.includes(".tracker.net/") && baselineText.includes(".inview.net/"), "the compared report lost its request log");
      assert.ok(baselineText.includes("Counts are a lower bound"), "the compared report lost its warnings");
      let atEnvelope: unknown = null;
      const [checked, thrown, timedOut] = await Promise.all([
        visit(fixture, "/compare", {
          scrollCheck: true,
          scrollCheckTimingForTests: TEST_TIMING,
          onEnvelopeBuiltForTests: (envelope) => {
            atEnvelope = structuredClone({ result: envelope.result, measurement: envelope.measurement });
          }
        }),
        visit(fixture, "/compare", { scrollCheck: true, scrollCheckTimingForTests: TEST_TIMING, scrollCheckFaultForTests: "throw" }),
        // A page call that never answers: the check's own deadline ends it.
        visit(fixture, "/compare", { scrollCheck: true, scrollCheckTimingForTests: TEST_TIMING, scrollCheckFaultForTests: "hang" })
      ]);
      // The same visit, before and after its check: not one byte moved.
      assert.deepEqual({ result: checked.result, measurement: checked.measurement }, atEnvelope);
      // And the visit's own duration was taken before the check began: it
      // ends well before the settle the check waits for.
      for (const envelope of [checked]) {
        assert.ok(envelope.result.summary.durationMs < TEST_TIMING.settleAfterNavigationMs, `durationMs ${envelope.result.summary.durationMs}`);
        assert.equal(envelope.measurement.emissionInputs.durationMs < TEST_TIMING.settleAfterNavigationMs, true);
      }
      assert.equal(scrollCheckEvidence(checked)?.outcome, "reached-end");
      assert.equal(scrollCheckEvidence(thrown)?.outcome, "cut-short");
      assert.ok(scrollCheckEvidence(thrown)?.control, "the window that ran before the error is kept");
      assert.equal(scrollCheckEvidence(timedOut)?.outcome, "cut-short");
      for (const [name, envelope] of [["with the check", checked], ["thrown", thrown], ["timed out", timedOut]] as const) {
        assert.deepEqual(ordinaryReport(envelope), baseline, `the ordinary report changed ${name}`);
      }
    });
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("without the option nothing attaches, and with it one listener does", { timeout: 60_000 }, async () => {
  const fixture = await startFixture(TEST_TIMING);
  try {
    const listeners = async (extra: Partial<ScanSiteOptions>): Promise<number> => {
      let count = -1;
      await visit(fixture, "/short", {
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
          count = (page as unknown as { listenerCount(event: string): number }).listenerCount("request");
        }
      });
      return count;
    };
    const without = await listeners({});
    const withCheck = await listeners({ scrollCheck: true });
    assert.ok(without > 0);
    assert.equal(withCheck, without + 1, `listeners: ${without} without the check, ${withCheck} with it`);
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("a page past the visit's 1,000-request cap: the same capture loss with or without the check, and the check loads within its own allowance", { timeout: 180_000 }, async () => {
  const fixture = await startFixture(TEST_TIMING);
  try {
    await withR2Env(async () => {
      const [ordinary, { envelope, evidence }] = await Promise.all([
        visit(fixture, "/many"),
        checkVisit(fixture, "/many")
      ]);
      const lossOf = (value: NodeScanMeasurementEnvelope) =>
        JSON.stringify(value.measurement.measurement.qualityFacts).match(/request-capture[^}]*/g);
      assert.ok(lossOf(ordinary), "the page did not reach the visit's cap");
      assert.deepEqual(lossOf(envelope), lossOf(ordinary));
      assert.deepEqual(
        ordinary.result.warnings.filter((warning) => warning.includes("1000 requests")),
        envelope.result.warnings.filter((warning) => warning.includes("1000 requests"))
      );
      assert.deepEqual(listed(evidence.scroll), ["{label}.after-cap.net"]);
      assert.ok(fixture.hits.includes("late.after-cap.net/p"), "the check's allowance did not load the scrolled request");
      assert.deepEqual(evidence.incomplete, ["visit-budget"]);
    });
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("one check at the production timing", { timeout: 150_000 }, async () => {
  const fixture = await startFixture(SCROLL_CHECK_TIMING);
  try {
    const started = Date.now();
    const envelope = await visit(fixture, "/lazy", { scrollCheck: true });
    const elapsed = Date.now() - started;
    const evidence = scrollCheckEvidence(envelope) as ScrollCheckEvidence;
    assert.equal(isScrollCheckEvidence(evidence), true);
    assert.equal(evidence.outcome, "reached-end");
    assert.deepEqual(listed(evidence.control), ["pixel.timer.org"]);
    assert.equal(evidence.scroll?.hostCount, 4);
    // Settle to 25 s after the navigation, then two 10.5 s windows.
    assert.ok(elapsed >= 46_000 && elapsed < 60_000, `the check took ${elapsed} ms`);
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

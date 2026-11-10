import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import type { Page } from "playwright";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import type { FingerprintObservationCollection } from "./fingerprint-observer";
import {
  describeInvestigationSeam,
  INVESTIGATION_SEAM_MARKER,
  INVESTIGATION_SEAM_VERSION,
  InvestigationSeamHookTimeoutError,
  investigationSeamUse,
  isSeamVisit,
  SeamVisitRefusal,
  type InvestigationSeam,
  type InvestigationSeamFingerprintSource,
  type InvestigationSeamFrameValue
} from "./investigation-seam";
import { scrollCheckEvidence, type NodeScanMeasurementEnvelope } from "./node-scan-measurement";
import { prepareScanReportBundle } from "./report-store";
import { BUILD_COMMIT_ENV } from "./runtime-scan-report";
import { MAX_SCAN_DURATION_MS } from "./scan-deadlines";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { closeSharedBrowserForTests, SCAN_SETUP_TIMEOUT_MESSAGE, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";
import type { ScrollCheckBoundary, ScrollCheckTiming } from "./scroll-check";

/**
 * The investigation seam through the real scanner and a real page.
 *
 * Every host below is a registrable name routed by the scanner's own proxy
 * hook to one local server, so nothing leaves this machine. The pure half
 * (description, refusals, bounds on a scripted clock) is in
 * lib/investigation-seam.test.ts and lib/scroll-check.test.ts.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

// The page's first script says what it found when it ran, to the page (for a
// hook to read) and to the server (for a visit with no hook), then reads a
// canvas back: a call the scanner's observer counts. Neither the page's
// address nor its title names the seam, so a walk for that name in a visit's
// result finds only what the scanner put there.
const PAGE = `<!doctype html><title>Hook fixture</title>
<script>
  window.__pageSaw = typeof window.__hookLog;
  new Image().src = "http://static.example.com/saw-" + window.__pageSaw + ".png";
  document.createElement("canvas").toDataURL();
</script>
<style>body { margin: 0 } section { height: 980px }</style>
<iframe src="http://frame.example.net/inner" width="300" height="100"></iframe>
<section>One</section><section>Two</section><section>Three</section><section>Four</section>`;

// A stand-in for a capture's API logger. It notes what the scanner had
// installed when it ran, then wraps one canvas method and notes, on each
// call, how many frames sit between itself and the page's own script.
const INIT_SCRIPT = `(function () {
  window.__hookOrder = {
    collector: Object.getOwnPropertyNames(window).some(function (name) { return name.indexOf("__sbl_bounded_page_") === 0; }),
    observer: typeof window.__siteBehaviorLabFingerprintSnapshot === "function"
  };
  window.__hookLog = [];
  var native = HTMLCanvasElement.prototype.toDataURL;
  window.__hookWrapper = function () {
    var frames = String(new Error().stack).split("\\n").slice(1);
    var page = -1;
    for (var index = 0; index < frames.length; index += 1) {
      if (frames[index].indexOf("www.example.com/page") !== -1) { page = index; break; }
    }
    window.__hookLog.push({ api: "toDataURL", framesBeforePage: page });
    return native.apply(this, arguments);
  };
  HTMLCanvasElement.prototype.toDataURL = window.__hookWrapper;
})();`;

const READ_LOGGER = `({
  saw: window.__pageSaw === undefined ? null : window.__pageSaw,
  order: window.__hookOrder,
  log: window.__hookLog,
  observerWrapsOver: HTMLCanvasElement.prototype.toDataURL !== window.__hookWrapper
})`;

// The check's sequence, shortened. With a phase budget this small the
// deadline is the sequence's own end plus the margin, so the margin decides.
const CHECK_TIMING: ScrollCheckTiming = {
  settleAfterNavigationMs: 3_000,
  controlWindowMs: 1_000,
  scrollWindowMs: 3_000,
  stepDwellMs: 250,
  deepestDwellMs: 500,
  phaseDeadlineMs: 1_000
};

const NEVER = (): Promise<void> => new Promise<void>(() => undefined);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let server: Server;
let port = 0;
const hits: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const path = request.url ?? "/";
    hits.push(`${host}${path}`);
    if (host === "www.example.com" && path === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
      return;
    }
    if (host === "frame.example.net") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Inner</title><p>Inner frame.</p>");
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
  port = address.port;
});

after(async () => {
  await closeSharedBrowserForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const PAYLOAD = { url: "http://www.example.com/page", device: "desktop" as const, gpcEnabled: false, consentMode: "observe" as const };

function visit(extra: Partial<ScanSiteOptions> = {}): Promise<NodeScanMeasurementEnvelope> {
  return scanSiteWithMeasurement(PAYLOAD, {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    ...extra
  });
}

const checkVisit = (seam: InvestigationSeam, extra: Partial<ScanSiteOptions> = {}): Promise<NodeScanMeasurementEnvelope> =>
  visit({ scrollCheck: true, scrollCheckTimingForTests: CHECK_TIMING, investigationSeam: seam, ...extra });

const canvasReads = (collection: FingerprintObservationCollection): number =>
  collection.observations.events.find((event) => event.api === "canvas.toDataURL")?.count ?? 0;

/** Every key, and every string, anywhere in a value. */
function keysAndStrings(value: unknown, found: { keys: string[]; strings: string[] } = { keys: [], strings: [] }): { keys: string[]; strings: string[] } {
  if (typeof value === "string") found.strings.push(value);
  else if (Array.isArray(value)) for (const item of value) keysAndStrings(item, found);
  else if (value && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      found.keys.push(String(key));
      keysAndStrings((value as Record<PropertyKey, unknown>)[key], found);
    }
  }
  return found;
}

test("a seam visit calls each hook at its point, hands it what it promises, and is marked", { timeout: 120_000 }, async () => {
  const order: string[] = [];
  let pageReadyFinished = false;
  let pageAtReady = "";
  let ownRead: FingerprintObservationCollection | undefined;
  let sources: InvestigationSeamFingerprintSource[] = [];
  let logger: InvestigationSeamFrameValue[] = [];
  let failing: InvestigationSeamFrameValue[] = [];
  let budgets: { first: unknown; second: unknown } | undefined;
  const boundaryReads: [ScrollCheckBoundary, number][] = [];
  const seam: InvestigationSeam = {
    pageReady: async (page: Page) => {
      order.push("pageReady");
      pageAtReady = page.url();
      await pause(60);
      pageReadyFinished = true;
    },
    initScript: INIT_SCRIPT,
    finalFingerprintRead: (collection) => {
      order.push("finalFingerprintRead");
      ownRead = structuredClone(collection);
      // The hook's copy is its own: emptying it must not reach the result.
      collection.observations.events.length = 0;
    },
    afterEnvelope: async (read) => {
      order.push("afterEnvelope");
      sources = await read.fingerprintBySource();
      const first = read.budgets();
      (first.request as unknown as Record<string, unknown>).tampered = true;
      budgets = { first, second: read.budgets() };
      logger = await read.evaluateInFrames(READ_LOGGER);
      failing = await read.evaluateInFrames("(function () { throw new Error('no such reading'); })()");
    },
    scrollCheckBoundary: async (boundary, readFingerprint) => {
      order.push(`boundary:${boundary}`);
      boundaryReads.push([boundary, canvasReads(await readFingerprint())]);
    },
    scrollCheckDeadlineMarginMs: 20_000
  };
  hits.length = 0;
  const envelope = await checkVisit(seam, {
    onProgress: (phase) => {
      order.push(phase);
      // pageReady is awaited: the visit does not navigate until it settles.
      if (phase === "navigating") assert.equal(pageReadyFinished, true, "the visit navigated before pageReady settled");
    },
    onEnvelopeBuiltForTests: () => order.push("envelope")
  });

  assert.deepEqual(order, [
    "launching",
    "pageReady",
    "navigating",
    "collecting",
    "finalFingerprintRead",
    "envelope",
    "afterEnvelope",
    "boundary:check-start",
    "boundary:control-start",
    "boundary:control-end",
    "boundary:scroll-end"
  ]);
  assert.equal(pageAtReady, "about:blank");

  // The init script ran before the page's own first script, in the page and
  // in its frame, after the scanner's collector and before its observer.
  assert.ok(hits.includes("static.example.com/saw-object.png"), hits.join(", "));
  assert.equal(logger.length, 2);
  const main = logger.find((frame) => frame.isMain);
  const inner = logger.find((frame) => !frame.isMain);
  assert.ok(main && inner);
  assert.equal(main.url, "http://www.example.com/page");
  assert.equal(inner.url, "http://frame.example.net/inner");
  const mainValue = main.value as { saw: string; order: { collector: boolean; observer: boolean }; log: { api: string; framesBeforePage: number }[]; observerWrapsOver: boolean };
  assert.equal(mainValue.saw, "object");
  assert.deepEqual(mainValue.order, { collector: true, observer: false });
  assert.deepEqual((inner.value as typeof mainValue).order, { collector: true, observer: false });
  // The observer wraps over the seam's wrapper: the page's one call reached
  // the seam's logger through the observer, whose frame sits between them.
  assert.equal(mainValue.observerWrapsOver, true);
  assert.equal(mainValue.log.length, 1);
  assert.equal(mainValue.log[0].api, "toDataURL");
  assert.ok(mainValue.log[0].framesBeforePage >= 2, `the page's frame is ${mainValue.log[0].framesBeforePage} below the logger's`);
  // And the observer still counted that call, in its own read and the result.
  assert.ok(ownRead);
  assert.equal(canvasReads(ownRead), 1);
  assert.equal(envelope.result.fingerprintEvents.find((event) => event.api === "canvas.toDataURL")?.count, 1);
  // A frame that cannot evaluate an expression says so, and the rest answer.
  assert.equal(failing.length, 2);
  for (const frame of failing) assert.match(String(frame.error), /no such reading/);

  // Per source: the page, its frame, then the worker realms together.
  assert.deepEqual(sources.map((source) => [source.source, source.url]), [
    ["main", "http://www.example.com/page"],
    ["frame", "http://frame.example.net/inner"],
    ["workers", ""]
  ]);
  assert.equal(canvasReads(sources[0].collection), 1);
  assert.equal(canvasReads(sources[1].collection), 0);
  for (const source of sources) assert.ok(source.startedAt <= source.endedAt);
  // Each call hands back a new snapshot: what a hook does to one does not
  // show in the next, or in the budgets the visit still counts on.
  assert.ok(budgets);
  const first = budgets.first as { request: Record<string, unknown>; proxy: Record<string, unknown> };
  const second = budgets.second as typeof first;
  assert.equal(typeof first.proxy, "object");
  assert.equal(first.request.tampered, true);
  assert.equal("tampered" in second.request, false);

  // The check ran whole, and each boundary could read the page.
  assert.equal(scrollCheckEvidence(envelope)?.outcome, "reached-end");
  assert.deepEqual(boundaryReads, [
    ["check-start", 1],
    ["control-start", 1],
    ["control-end", 1],
    ["scroll-end", 1]
  ]);

  // The use record: the description a runner could take before the visit,
  // and what each hook call cost by the scanner's clock.
  const use = investigationSeamUse(envelope);
  assert.ok(use);
  assert.deepEqual(use.description, describeInvestigationSeam(seam));
  assert.equal(use.description.scrollCheckDeadlineMarginMs, 20_000);
  const durations = use.hookDurationsMs;
  assert.ok(typeof durations.pageReady === "number" && durations.pageReady >= 50, `pageReady took ${durations.pageReady} ms by the record`);
  assert.equal(typeof durations.finalFingerprintRead, "number");
  assert.equal(typeof durations.afterEnvelope, "number");
  assert.deepEqual(durations.scrollCheckBoundary.map((call) => call.boundary), ["check-start", "control-start", "control-end", "scroll-end"]);
  for (const call of durations.scrollCheckBoundary) assert.equal(typeof call.ms, "number", call.boundary);

  // The mark, on the real visit's own objects, and every refusal it meets.
  const result = envelope.result as unknown as Record<string, unknown>;
  const measurement = envelope.measurement as unknown as Record<string, unknown>;
  assert.equal(result[INVESTIGATION_SEAM_MARKER], INVESTIGATION_SEAM_VERSION);
  assert.equal(measurement[INVESTIGATION_SEAM_MARKER], INVESTIGATION_SEAM_VERSION);
  assert.equal(isSeamVisit(envelope), true);
  const env = { ...process.env, [BUILD_COMMIT_ENV]: "c".repeat(40) };
  assert.throws(() => buildRuntimeScanReportV2R2(envelope, "operator-cli", env), SeamVisitRefusal);
  assert.throws(() => prepareScanReportBundle(envelope.result), SeamVisitRefusal);
  assert.throws(() => prepareScanReportBundle(JSON.parse(JSON.stringify(envelope.result))), SeamVisitRefusal);
});

test("a visit that sets no seam carries no key and no value of one, and its page ran no script of one", { timeout: 60_000 }, async () => {
  const previous = { commit: process.env[BUILD_COMMIT_ENV], verification: process.env[CONSENT_VERIFICATION_ENV] };
  process.env[BUILD_COMMIT_ENV] = "c".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  try {
    hits.length = 0;
    const envelope = await visit();
    // The page's own first script found nothing a seam's script would leave.
    assert.ok(hits.includes("static.example.com/saw-undefined.png"), hits.join(", "));
    assert.equal(hits.some((hit) => hit.includes("saw-object")), false);

    assert.equal(investigationSeamUse(envelope), undefined);
    assert.equal(isSeamVisit(envelope), false);
    assert.deepEqual(Object.keys(envelope), ["result", "measurement"]);
    const report = buildRuntimeScanReportV2R2(envelope, "operator-cli");
    const prepared = prepareScanReportBundle(report);
    const names = /seam/i;
    for (const [what, value] of [
      ["the result", envelope.result],
      ["the measurement", envelope.measurement],
      ["the built report", report],
      ["the prepared report", JSON.parse(prepared.reportWire)],
      ["the prepared sidecar", JSON.parse(prepared.sidecarWire)]
    ] as const) {
      const found = keysAndStrings(value);
      assert.ok(found.keys.length >= 3 && found.strings.length >= 3, `${what} was not walked`);
      assert.deepEqual(found.keys.filter((key) => names.test(key)), [], `${what} has a key that names the seam`);
      assert.deepEqual(found.strings.filter((text) => names.test(text)), [], `${what} has a value that names the seam`);
    }
    // The walk finds a mark when there is one: the same check on a seam visit.
    const marked = await visit({ investigationSeam: {} });
    assert.deepEqual(keysAndStrings(marked.result).keys.filter((key) => names.test(key)), [INVESTIGATION_SEAM_MARKER]);
    assert.deepEqual(keysAndStrings(marked.measurement).strings.filter((text) => names.test(text)), [INVESTIGATION_SEAM_VERSION]);
    // An empty seam marks its visit and does nothing else to the page.
    assert.deepEqual(investigationSeamUse(marked)?.hookDurationsMs, { pageReady: null, finalFingerprintRead: null, afterEnvelope: null, scrollCheckBoundary: [] });
  } finally {
    for (const [name, value] of [[BUILD_COMMIT_ENV, previous.commit], [CONSENT_VERIFICATION_ENV, previous.verification]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("every wait on a hook has a bound: the scan deadline, the hook's own timeout, the check's deadline, and the caller's signal", { timeout: 240_000 }, async () => {
  const elapsed = async <T>(work: Promise<T>): Promise<{ ms: number; outcome: T | { error: unknown } }> => {
    const started = Date.now();
    const outcome = await work.catch((error: unknown) => ({ error }));
    return { ms: Date.now() - started, outcome };
  };
  const errorOf = (outcome: unknown): unknown => (outcome as { error?: unknown }).error;

  // pageReady, by the visit's own scan deadline: a visit with 4 s of its
  // budget left ends as any visit whose setup ran out of time does.
  const never = new AbortController();
  const setup = await elapsed(
    visit({ investigationSeam: { pageReady: NEVER }, scanBudgetSpentMsForTests: MAX_SCAN_DURATION_MS - 4_000, signal: never.signal })
  );
  assert.equal((errorOf(setup.outcome) as Error | undefined)?.message, SCAN_SETUP_TIMEOUT_MESSAGE);
  assert.ok(setup.ms >= 2_000 && setup.ms < 20_000, `the scan deadline ended pageReady after ${setup.ms} ms`);
  // The hook is still pending, and the visit is over: nothing of it is left
  // listening on the caller's signal.
  assert.equal(getEventListeners(never.signal, "abort").length, 0);

  // afterEnvelope, by its own timeout.
  const late = await elapsed(visit({ investigationSeam: { afterEnvelope: NEVER, afterEnvelopeTimeoutMs: 1_000 } }));
  assert.ok(errorOf(late.outcome) instanceof InvestigationSeamHookTimeoutError, String(errorOf(late.outcome)));
  assert.ok(late.ms < 30_000, `afterEnvelope's timeout ended the visit after ${late.ms} ms`);

  // A boundary callback, by the check's deadline with the margin: the check
  // is cut short there, and the visit still returns its result.
  const hung = await elapsed(checkVisit({ scrollCheckBoundary: (boundary) => (boundary === "control-start" ? NEVER() : undefined) }));
  const hungEnvelope = hung.outcome as NodeScanMeasurementEnvelope;
  assert.equal(errorOf(hung.outcome), undefined, String(errorOf(hung.outcome)));
  assert.equal(scrollCheckEvidence(hungEnvelope)?.outcome, "cut-short");
  assert.deepEqual(investigationSeamUse(hungEnvelope)?.hookDurationsMs.scrollCheckBoundary.map((call) => [call.boundary, call.ms === null]), [
    ["check-start", false],
    ["control-start", true]
  ]);
  assert.ok(hung.ms < 40_000, `the check's deadline ended the callback after ${hung.ms} ms`);

  // Each of the three, by the caller's signal.
  const reason = new Error("the caller cancelled");
  const cancelled = async (seam: InvestigationSeam, extra: Partial<ScanSiteOptions>, afterMs: number) => {
    const cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(reason), afterMs);
    try {
      return await elapsed(visit({ investigationSeam: seam, signal: cancel.signal, ...extra }));
    } finally {
      clearTimeout(timer);
    }
  };
  const readyCancelled = await cancelled({ pageReady: NEVER }, {}, 1_500);
  assert.equal(errorOf(readyCancelled.outcome), reason);
  assert.ok(readyCancelled.ms < 15_000, `the signal ended pageReady after ${readyCancelled.ms} ms`);
  const afterCancelled = await cancelled({ afterEnvelope: NEVER, afterEnvelopeTimeoutMs: 600_000 }, {}, 6_000);
  assert.equal(errorOf(afterCancelled.outcome), reason);
  assert.ok(afterCancelled.ms < 25_000, `the signal ended afterEnvelope after ${afterCancelled.ms} ms`);
  const boundaryCancelled = await cancelled(
    { scrollCheckBoundary: (boundary) => (boundary === "check-start" ? NEVER() : undefined), scrollCheckDeadlineMarginMs: 600_000 },
    { scrollCheck: true, scrollCheckTimingForTests: CHECK_TIMING },
    6_000
  );
  // A cancelled check ends as one cut short, as it always has; what matters
  // here is that the wait ended with the signal and not ten minutes later.
  assert.ok(boundaryCancelled.ms < 25_000, `the signal ended the boundary callback after ${boundaryCancelled.ms} ms`);
});

test("the margin a seam names is the one its check runs under", { timeout: 120_000 }, async () => {
  // A callback that takes 3.5 s before the window with no input. The check's
  // sequence then ends 3.5 s later than the deadline was sized for.
  const slow: InvestigationSeam["scrollCheckBoundary"] = async (boundary) => {
    if (boundary === "control-start") await pause(3_500);
  };
  // Under the scanner's own 2 s margin the deadline cuts the check.
  const cut = await checkVisit({ scrollCheckBoundary: slow });
  assert.equal(scrollCheckEvidence(cut)?.outcome, "cut-short");
  assert.equal(investigationSeamUse(cut)?.description.scrollCheckDeadlineMarginMs, 2_000);
  // Under a margin of its own the same check runs to its end.
  const whole = await checkVisit({ scrollCheckBoundary: slow, scrollCheckDeadlineMarginMs: 15_000 });
  assert.equal(scrollCheckEvidence(whole)?.outcome, "reached-end");
  const slowCall = investigationSeamUse(whole)?.hookDurationsMs.scrollCheckBoundary.find((call) => call.boundary === "control-start");
  assert.ok(slowCall && typeof slowCall.ms === "number" && slowCall.ms >= 3_400, `the slow callback took ${slowCall?.ms} ms by the record`);
});

test("a hook that throws fails the visit with its own error, and a seam the scanner cannot read fails it before any work", { timeout: 120_000 }, async () => {
  const thrown = new Error("the hook threw");
  const failing: [string, InvestigationSeam, Partial<ScanSiteOptions>][] = [
    ["pageReady", { pageReady: () => Promise.reject(thrown) }, {}],
    [
      "finalFingerprintRead",
      {
        finalFingerprintRead: () => {
          throw thrown;
        }
      },
      {}
    ],
    ["afterEnvelope", { afterEnvelope: () => Promise.reject(thrown) }, {}],
    // The check itself would end as cut short; the visit fails instead.
    [
      "scrollCheckBoundary",
      {
        scrollCheckBoundary: (boundary) => {
          if (boundary === "control-end") throw thrown;
        }
      },
      { scrollCheck: true, scrollCheckTimingForTests: CHECK_TIMING }
    ]
  ];
  for (const [hook, seam, extra] of failing) {
    await assert.rejects(visit({ investigationSeam: seam, ...extra }), (error) => error === thrown, hook);
  }
  let progressed = false;
  await assert.rejects(
    visit({ investigationSeam: { pageRedy: () => undefined } as unknown as InvestigationSeam, onProgress: () => (progressed = true) }),
    /has no field pageRedy/
  );
  assert.equal(progressed, false, "the visit began before its seam was read");
  // The browser is still good for an ordinary visit afterwards.
  assert.equal((await visit()).result.summary.status, 200);
});

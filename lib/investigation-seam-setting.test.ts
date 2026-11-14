import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "playwright";
import { createGpcComparisonReport } from "./compare-reports";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import {
  DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS,
  describeInvestigationSeam,
  INVESTIGATION_SEAM_VERSION,
  InvestigationSeamHookTimeoutError,
  investigationSeamUse,
  type InvestigationSeam,
  type InvestigationSeamFrameValue
} from "./investigation-seam";
import {
  createNodeScanMeasurementEnvelope,
  scrollCheckEvidence,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { redactScanReportV1, redactScanResultV1 } from "./redact-scan-report-v1";
import { prepareScanReportBundle } from "./report-store";
import { BUILD_COMMIT_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest } from "./scan-api";
import { MAX_SCAN_DURATION_MS } from "./scan-deadlines";
import { resetScanLimitStateForTests } from "./scan-limits";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import { buildRuntimeComparisonScanReportV2R2, buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { writeV2ShadowArtifact } from "./scan-report-v2-shadow-store";
import { readScanTransportPayload } from "./scan-report-view";
import { closeSharedBrowserForTests, SCAN_SETUP_TIMEOUT_MESSAGE, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";
import { isSeamVisit, SEAM_VISIT_MARKER, SeamVisitRefusal } from "./seam-visit-mark";
import { SCROLL_CHECK_DEADLINE_MARGIN_MS, type ScrollCheckBoundary, type ScrollCheckTiming } from "./scroll-check";
import type { ScanResult } from "./types";

/**
 * Workspace stage S3: the suite that sets the scanner's investigation seam
 * through the real scanner, in a real Chromium, against a local fixture
 * server, and holds five properties of a seam visit:
 *
 * 1. Order: the seam's init script runs after the scanner's bounded page
 *    collector and before its fingerprint observer, in each document of the
 *    fixture, at the Playwright version package.json pins; and the hooks are
 *    called in their stated order.
 * 2. Bounds: each hook is called at most once for each of its points, and
 *    each wait on a hook ends at its stated bound or at the caller's signal,
 *    whichever comes first, leaving no listener on that signal.
 * 3. Isolation: over the seam behaviours this file writes out (SEAM_BEHAVIOURS
 *    and the throwing hooks), a seam visit's recorded evidence equals an
 *    ordinary visit's, except for the mark and the fields TIMING_FIELDS
 *    names. TIMING_FIELDS is held to the fields that two ordinary visits of
 *    the same fixture themselves differ in, so the comparison is blind to
 *    exactly those fields and to nothing else.
 * 4. The mark: a real seam visit's result, its measurement and their copies
 *    are refused by each publishing step docs/runtime-boundaries.md lists, and
 *    each refusal names its own step, so a step whose own check is gone and
 *    that is refused further in fails here. Each refusal has a control: the
 *    same visit's copy with the mark taken off gets past that step.
 * 5. Readback: the visit's use record says which hooks were set, the init
 *    script's sha256, the two bounds and each hook's time, and each matches
 *    what the test set and what the hook saw.
 *
 * Every host below is a registrable name routed by the scanner's own proxy
 * hook to one local server, so nothing leaves this machine.
 *
 * Waits. Every wait in this file ends on a signal the visit or a hook gives,
 * under the test's own timeout. The slow hooks of SEAM_BEHAVIOURS pause on a
 * timer: that pause is the behaviour under test, not a wait of the test.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

// The page reads a canvas back, sets a cookie and a storage key, asks for an
// image and a third-party script, and holds a cross-site frame that holds a
// frame of its own. Each of those leaves evidence in the visit's result.
// Nothing on it runs on a timer, so a longer window sees no more of it, and
// nothing on it reads what a seam's script defines, so what it does is the
// same with and without one (property 3 compares the scanner's record of
// one page's behaviour, not two pages).
const PAGE = `<!doctype html><title>Seam setting fixture</title>
<script>
  document.cookie = "fixture_first=1; path=/";
  try { localStorage.setItem("fixture_key", "1"); } catch (error) {}
  new Image().src = "http://static.example.com/pixel.png";
  document.createElement("canvas").toDataURL();
</script>
<script src="http://cdn.example.org/lib.js"></script>
<style>body { margin: 0 } section { height: 980px }</style>
<iframe src="http://frame.example.net/inner" width="300" height="200"></iframe>
<section>One</section><section>Two</section><section>Three</section><section>Four</section>`;

const LIB = `(function () {
  var canvas = document.createElement("canvas");
  var context = canvas.getContext("2d");
  if (context) context.fillText("fixture", 1, 1);
  new Image().src = "http://static.example.com/lib-pixel.png";
})();`;

const INNER = `<!doctype html><title>Inner</title><p>Inner frame.</p>
<script>document.createElement("canvas").toDataURL();</script>
<iframe src="http://deep.example.org/deep" width="100" height="50"></iframe>`;

const DEEP = `<!doctype html><title>Deep</title><p>Deep frame.</p>`;

// A stand-in for a capture's API logger: it notes what the scanner had
// installed when it ran, then wraps one canvas method and logs each call.
const LOGGER_SCRIPT = `(function () {
  window.__seamS3Order = {
    collector: Object.getOwnPropertyNames(window).some(function (name) { return name.indexOf("__sbl_bounded_page_") === 0; }),
    observer: typeof window.__siteBehaviorLabFingerprintSnapshot === "function"
  };
  window.__seamS3Log = [];
  var native = HTMLCanvasElement.prototype.toDataURL;
  window.__seamS3Wrapper = function () {
    window.__seamS3Log.push("toDataURL");
    return native.apply(this, arguments);
  };
  HTMLCanvasElement.prototype.toDataURL = window.__seamS3Wrapper;
})();`;

const READ_LOGGER = `({
  order: window.__seamS3Order === undefined ? null : window.__seamS3Order,
  calls: window.__seamS3Log === undefined ? null : window.__seamS3Log.length,
  observerWrapsOver: HTMLCanvasElement.prototype.toDataURL !== window.__seamS3Wrapper
})`;

// The check's sequence, shortened, as the fixture test runs it.
const CHECK_TIMING: ScrollCheckTiming = {
  settleAfterNavigationMs: 3_000,
  controlWindowMs: 1_000,
  scrollWindowMs: 3_000,
  stepDwellMs: 250,
  deepestDwellMs: 500,
  phaseDeadlineMs: 1_000
};

const NEVER = (): Promise<void> => new Promise<void>(() => undefined);
// The pause a slow hook takes. It is the behaviour under test, not a wait.
const SLOW_HOOK_MS = 300;
const slowly = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SLOW_HOOK_MS));

let server: Server;
let port = 0;

before(async () => {
  server = createServer((request, response) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const where = request.url ?? "/";
    const html = (body: string): void => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    if (host === "www.example.com" && where === "/page") return html(PAGE);
    if (host === "frame.example.net") return html(INNER);
    if (host === "deep.example.org") return html(DEEP);
    if (host === "cdn.example.org") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(LIB);
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

function visit(extra: Partial<ScanSiteOptions> = {}, gpcEnabled = false): Promise<NodeScanMeasurementEnvelope> {
  return scanSiteWithMeasurement({ ...PAYLOAD, gpcEnabled }, {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    ...extra
  });
}

const CHECKED: Partial<ScanSiteOptions> = { scrollCheck: true, scrollCheckTimingForTests: CHECK_TIMING };

/** A promise and the call that settles it, for a hook to signal the test. */
function signal<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** How long a promise took to settle, and with what. */
async function elapsed<T>(work: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const started = Date.now();
  try {
    const value = await work;
    return { ms: Date.now() - started, value };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

// ---------------------------------------------------------------------------
// Property 3's comparison.
// ---------------------------------------------------------------------------

/**
 * What a visit recorded: its result, its measurement and its check's
 * evidence, as JSON, with the mark's one key taken off the result and the
 * measurement, where the mark sits.
 */
function recorded(envelope: NodeScanMeasurementEnvelope): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(envelope.result)) as Record<string, unknown>;
  const measurement = JSON.parse(JSON.stringify(envelope.measurement)) as Record<string, unknown>;
  delete result[SEAM_VISIT_MARKER];
  delete measurement[SEAM_VISIT_MARKER];
  const check = scrollCheckEvidence(envelope);
  return { result, measurement, check: check === undefined ? null : JSON.parse(JSON.stringify(check)) };
}

/**
 * Where two JSON values differ: each leaf whose value differs, each key one
 * has and the other lacks, and each array whose length differs, by its path
 * with array indexes written as [].
 */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const found = a.length === b.length ? [] : [`${at}.length`];
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) found.push(...differences(a[index], b[index], `${at}[]`));
    return found;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const found: string[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      if (!(key in a) || !(key in b)) found.push(`${at}.${key}`);
      else found.push(...differences(left, right, `${at}.${key}`));
    }
    return found;
  }
  return Object.is(a, b) ? [] : [at];
}

/**
 * The fields the comparison excludes: each is a clock reading or a length of
 * time. Filled from what two ordinary visits of this fixture differ in, and
 * held to that below, so a field that moves between ordinary visits and is
 * not listed fails, and so does a listed field no ordinary pair moves.
 */
const TIMING_FIELDS: readonly string[] = [
  ".measurement.emissionInputs.durationMs",
  ".measurement.emissionInputs.startedAt",
  ".measurement.evidence.requests[].startedAtMs",
  ".measurement.measurement.phases[].endedAtMs",
  ".measurement.measurement.phases[].startedAtMs",
  ".result.conditions.scannedAt",
  ".result.requests[].startedAtMs",
  ".result.summary.durationMs"
];

const timing = (where: string): boolean => TIMING_FIELDS.includes(where);
const beyondTiming = (a: NodeScanMeasurementEnvelope, b: NodeScanMeasurementEnvelope): string[] =>
  [...new Set(differences(recorded(a), recorded(b)))].filter((where) => !timing(where)).sort();

/** The seam behaviours property 3 runs, each as a seam a visit sets. */
const SEAM_BEHAVIOURS: readonly (readonly [string, () => InvestigationSeam])[] = [
  [
    "reads at each hook",
    () => ({
      pageReady: async (page: Page) => {
        await page.evaluate("document.readyState");
      },
      finalFingerprintRead: (collection) => void collection.observations.events.length,
      afterEnvelope: async (read) => {
        await read.fingerprintBySource();
        read.budgets();
      },
      scrollCheckBoundary: async (_boundary, readFingerprint) => {
        await readFingerprint();
      }
    })
  ],
  [
    "slow hooks",
    () => ({
      pageReady: slowly,
      afterEnvelope: slowly,
      scrollCheckBoundary: slowly,
      scrollCheckDeadlineMarginMs: 20_000
    })
  ],
  [
    "a hook that evaluates in frames",
    () => ({
      afterEnvelope: async (read) => {
        await read.evaluateInFrames("({ title: document.title, frames: window.frames.length })");
      }
    })
  ],
  ["an init script that wraps a canvas method", () => ({ initScript: LOGGER_SCRIPT })]
];

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------

test("S3 order: the seam's init script runs after the bounded page collector and before the fingerprint observer in each document of the fixture, at the pinned Playwright version", { timeout: 120_000 }, async () => {
  // The order is Playwright's, which it does not document, so it is held at the version package.json pins.
  const pinned = (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> });
  const pin = pinned.devDependencies?.playwright ?? pinned.dependencies?.playwright;
  const installed = (JSON.parse(readFileSync(path.join(process.cwd(), "node_modules", "playwright", "package.json"), "utf8")) as { version: string }).version;
  assert.equal(installed, pin, "the installed Playwright is not the one package.json pins");

  const order: string[] = [];
  let frames: InvestigationSeamFrameValue[] = [];
  const envelope = await visit({
    ...CHECKED,
    investigationSeam: {
      pageReady: () => void order.push("pageReady"),
      initScript: LOGGER_SCRIPT,
      finalFingerprintRead: () => void order.push("finalFingerprintRead"),
      afterEnvelope: async (read) => {
        order.push("afterEnvelope");
        frames = await read.evaluateInFrames(READ_LOGGER);
      },
      scrollCheckBoundary: (boundary) => void order.push(`boundary:${boundary}`),
      scrollCheckDeadlineMarginMs: 20_000
    },
    onProgress: (phase) => void order.push(phase),
    onEnvelopeBuiltForTests: () => void order.push("envelope")
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
  assert.deepEqual(
    frames.map((frame) => frame.url),
    ["http://www.example.com/page", "http://frame.example.net/inner", "http://deep.example.org/deep"]
  );
  for (const frame of frames) {
    const value = frame.value as { order: { collector: boolean; observer: boolean } | null; calls: number | null; observerWrapsOver: boolean };
    assert.equal(frame.error, undefined, frame.url);
    assert.deepEqual(value.order, { collector: true, observer: false }, `${frame.url}: what was installed when the seam's script ran`);
    assert.equal(value.observerWrapsOver, true, `${frame.url}: the observer does not wrap over the seam's wrapper`);
  }
  // The page's own call reached the seam's wrapper, and the observer still counted it.
  assert.equal((frames[0].value as { calls: number }).calls, 1);
  assert.equal((frames[1].value as { calls: number }).calls, 1);
  assert.equal(envelope.result.fingerprintEvents.find((event) => event.api === "canvas.toDataURL")?.count, 2);
});

test("S3 bounds: each hook is called at most once for each of its points on a seam visit with a check", { timeout: 120_000 }, async () => {
  const calls = { pageReady: 0, finalFingerprintRead: 0, afterEnvelope: 0, boundary: [] as ScrollCheckBoundary[] };
  const envelope = await visit({
    ...CHECKED,
    investigationSeam: {
      pageReady: () => void (calls.pageReady += 1),
      finalFingerprintRead: () => void (calls.finalFingerprintRead += 1),
      afterEnvelope: () => void (calls.afterEnvelope += 1),
      scrollCheckBoundary: (boundary) => void calls.boundary.push(boundary),
      scrollCheckDeadlineMarginMs: 20_000
    }
  });
  assert.equal(scrollCheckEvidence(envelope)?.outcome, "reached-end");
  assert.deepEqual(calls, { pageReady: 1, finalFingerprintRead: 1, afterEnvelope: 1, boundary: ["check-start", "control-start", "control-end", "scroll-end"] });
  // The use record holds one entry for each boundary call, and no more.
  assert.deepEqual(investigationSeamUse(envelope)?.hookDurationsMs.scrollCheckBoundary.map((call) => call.boundary), calls.boundary);
});

test("S3 bounds: a hook that hangs ends its wait at its own bound, within the visit's own deadline, and leaves no listener on the caller's signal", { timeout: 240_000 }, async () => {
  // How long an ordinary visit of the fixture takes here, with and without a check.
  const plain = await elapsed(visit());
  const checked = await elapsed(visit(CHECKED));
  assert.equal(plain.error, undefined, String(plain.error));
  assert.equal(checked.error, undefined, String(checked.error));

  // pageReady, by the visit's scan deadline: a visit with 4 s of its budget left.
  const ready = new AbortController();
  const setup = await elapsed(
    visit({ investigationSeam: { pageReady: NEVER }, scanBudgetSpentMsForTests: MAX_SCAN_DURATION_MS - 4_000, signal: ready.signal })
  );
  assert.equal((setup.error as Error | undefined)?.message, SCAN_SETUP_TIMEOUT_MESSAGE);
  assert.ok(setup.ms < 4_000 + 15_000, `the scan deadline ended pageReady after ${setup.ms} ms`);
  assert.equal(getEventListeners(ready.signal, "abort").length, 0, "pageReady's wait left a listener");

  // afterEnvelope, by its own timeout, set to its minimum.
  const late = new AbortController();
  const after = await elapsed(visit({ investigationSeam: { afterEnvelope: NEVER, afterEnvelopeTimeoutMs: 1_000 }, signal: late.signal }));
  assert.ok(after.error instanceof InvestigationSeamHookTimeoutError, String(after.error));
  assert.ok(after.ms < plain.ms + 1_000 + 15_000, `afterEnvelope's timeout ended the visit after ${after.ms} ms, an ordinary visit took ${plain.ms} ms`);
  assert.equal(getEventListeners(late.signal, "abort").length, 0, "afterEnvelope's wait left a listener");

  // A boundary callback, by the check's deadline: the check is cut short there, and the visit returns.
  const hung = new AbortController();
  const boundary = await elapsed(
    visit({ ...CHECKED, investigationSeam: { scrollCheckBoundary: (name) => (name === "control-start" ? NEVER() : undefined) }, signal: hung.signal })
  );
  assert.equal(boundary.error, undefined, String(boundary.error));
  assert.equal(scrollCheckEvidence(boundary.value as NodeScanMeasurementEnvelope)?.outcome, "cut-short");
  assert.ok(boundary.ms < checked.ms + SCROLL_CHECK_DEADLINE_MARGIN_MS + 15_000, `the check's deadline ended the callback after ${boundary.ms} ms, a checked visit took ${checked.ms} ms`);
  assert.equal(getEventListeners(hung.signal, "abort").length, 0, "the boundary callback's wait left a listener");
});

test("S3 bounds: the caller's signal ends a wait on each awaited hook as soon as it aborts, and leaves no listener on it", { timeout: 240_000 }, async () => {
  const reason = new Error("the caller cancelled");
  // Each hook says when it has been entered, and the test aborts then: the
  // abort follows a signal of the visit, never a timer.
  const cases: [string, (entered: () => void) => InvestigationSeam, Partial<ScanSiteOptions>][] = [
    ["pageReady", (entered) => ({ pageReady: () => (entered(), NEVER()) }), {}],
    ["afterEnvelope", (entered) => ({ afterEnvelope: () => (entered(), NEVER()), afterEnvelopeTimeoutMs: 600_000 }), {}],
    [
      "scrollCheckBoundary",
      (entered) => ({ scrollCheckBoundary: (name) => (name === "check-start" ? (entered(), NEVER()) : undefined), scrollCheckDeadlineMarginMs: 600_000 }),
      CHECKED
    ]
  ];
  for (const [hook, seam, extra] of cases) {
    const cancel = new AbortController();
    const entered = signal();
    const running = elapsed(visit({ investigationSeam: seam(() => entered.resolve()), signal: cancel.signal, ...extra }));
    await entered.promise;
    const abortedAt = Date.now();
    cancel.abort(reason);
    const outcome = await running;
    const afterAbort = Date.now() - abortedAt;
    // A cancelled check ends as one cut short, as it always has; the visit then ends with the caller's reason or returns that check.
    if (hook !== "scrollCheckBoundary") assert.equal(outcome.error, reason, `${hook}: ${String(outcome.error)}`);
    else assert.ok(outcome.error === reason || scrollCheckEvidence(outcome.value as NodeScanMeasurementEnvelope)?.outcome === "cut-short", `${hook}: ${String(outcome.error)}`);
    assert.ok(afterAbort < 15_000, `${hook}: the visit ended ${afterAbort} ms after the abort`);
    assert.equal(getEventListeners(cancel.signal, "abort").length, 0, `${hook}: its wait left a listener`);
  }
});

test("S3 isolation: over the suite's seam behaviours, a seam visit records what an ordinary visit records, but for the mark and the timing fields", { timeout: 360_000 }, async () => {
  const moved = new Set<string>();
  for (const extra of [{}, CHECKED]) {
    const label = extra === CHECKED ? "with a check" : "without a check";
    const first = await visit(extra);
    const seamVisits: [string, NodeScanMeasurementEnvelope][] = [];
    for (const [behaviour, seam] of SEAM_BEHAVIOURS) seamVisits.push([behaviour, await visit({ ...extra, investigationSeam: seam() })]);
    const last = await visit(extra);

    // The excluded fields are exactly those two ordinary visits differ in, here.
    const ordinary = [...new Set(differences(recorded(first), recorded(last)))].sort();
    for (const where of ordinary) moved.add(where);
    assert.deepEqual(ordinary.filter((where) => !timing(where)), [], `${label}: two ordinary visits differ beyond the timing fields`);

    for (const [behaviour, envelope] of seamVisits) {
      assert.equal(isSeamVisit(envelope), true, `${label}, ${behaviour}: not marked`);
      // The mark is the one key the seam adds, on the result and the measurement.
      for (const part of [envelope.result, envelope.measurement]) assert.equal((part as unknown as Record<string, unknown>)[SEAM_VISIT_MARKER], INVESTIGATION_SEAM_VERSION);
      assert.deepEqual(beyondTiming(first, envelope), [], `${label}, ${behaviour}: differs from the ordinary visit before it`);
      assert.deepEqual(beyondTiming(last, envelope), [], `${label}, ${behaviour}: differs from the ordinary visit after it`);
    }
  }
  // And each excluded field moved between some pair of ordinary visits here, so the list excludes nothing it need not.
  assert.deepEqual([...moved].sort(), [...TIMING_FIELDS].sort(), "the timing fields are not the fields two ordinary visits differ in");
});

test("S3 isolation: a seam visit whose hook throws leaves the next ordinary visit recording what an ordinary visit records", { timeout: 240_000 }, async () => {
  const before = await visit();
  const thrown = new Error("the hook threw");
  const throwing: [string, InvestigationSeam, Partial<ScanSiteOptions>][] = [
    ["pageReady", { pageReady: () => Promise.reject(thrown) }, {}],
    ["finalFingerprintRead", { finalFingerprintRead: () => { throw thrown; } }, {}],
    ["afterEnvelope", { afterEnvelope: () => Promise.reject(thrown) }, {}],
    ["scrollCheckBoundary", { scrollCheckBoundary: (boundary) => { if (boundary === "control-end") throw thrown; } }, CHECKED]
  ];
  for (const [hook, seam, extra] of throwing) {
    await assert.rejects(visit({ investigationSeam: seam, ...extra }), (error) => error === thrown, hook);
    const next = await visit();
    assert.equal(isSeamVisit(next), false, hook);
    assert.deepEqual(beyondTiming(before, next), [], `the ordinary visit after a throwing ${hook} differs`);
  }
});

// ---------------------------------------------------------------------------
// Property 4: each publishing step refuses a real seam visit, by its own check.
// ---------------------------------------------------------------------------

// Read when the refusals run, so it carries the environment markRefusals sets.
const buildEnv = (): NodeJS.ProcessEnv => ({ ...process.env, [BUILD_COMMIT_ENV]: "c".repeat(40) });

/** A refusal made by the named step's own check, not by a step further in. */
const refusedAt = (step: string) => (error: unknown): boolean => {
  assert.ok(error instanceof SeamVisitRefusal, `expected a refusal at ${step}, got ${String(error)}`);
  assert.match(error.message, new RegExp(`at ${step}: it is never published\\.$`));
  return true;
};

/** A JSON copy of a value with the mark's key taken off, and so no identity either. */
function unmarked<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete copy[SEAM_VISIT_MARKER];
  return copy as T;
}

const SINGLE: PreparedScanRequest = {
  clientKey: "seam-setting",
  url: "http://www.example.com/page",
  device: "desktop",
  gpcEnabled: false,
  compareGpc: false,
  compareShields: false,
  compareConsent: false,
  rateLimitCost: 1
};

test("S3 mark: each publishing step refuses a real seam visit and its copies by its own check, and takes the same visit with the mark taken off", { timeout: 120_000 }, async () => {
  // The r2 builders need a build commit, and a visit made with consent verification on, as the fixture test makes its own.
  const previous = { commit: process.env[BUILD_COMMIT_ENV], verification: process.env[CONSENT_VERIFICATION_ENV] };
  process.env[BUILD_COMMIT_ENV] = "c".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  try {
    await markRefusals();
  } finally {
    for (const [name, value] of [[BUILD_COMMIT_ENV, previous.commit], [CONSENT_VERIFICATION_ENV, previous.verification]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

async function markRefusals(): Promise<void> {
  const seam = (): InvestigationSeam => ({ afterEnvelope: async (read) => void (await read.fingerprintBySource()) });
  // A GPC comparison's two arms: a seam visit of each, and an ordinary visit of each. The
  // builder holds a comparison's first arm to the earlier visit, and these run in this order.
  const envelope = await visit({ investigationSeam: seam() });
  const envelopeOn = await visit({ investigationSeam: seam() }, true);
  const ordinary = await visit();
  const ordinaryOn = await visit({}, true);
  assert.equal(isSeamVisit(envelope) && isSeamVisit(envelopeOn), true);
  assert.equal(isSeamVisit(ordinary) || isSeamVisit(ordinaryOn), false);
  const jsonEnvelopeOn = createNodeScanMeasurementEnvelope(JSON.parse(JSON.stringify(envelopeOn.result)) as ScanResult, JSON.parse(JSON.stringify(envelopeOn.measurement)) as NodeScanMeasurement);
  const cleanEnvelopeOn = createNodeScanMeasurementEnvelope(unmarked(envelopeOn.result), unmarked(envelopeOn.measurement) as NodeScanMeasurement);
  const result = envelope.result;
  const json = JSON.parse(JSON.stringify(result)) as ScanResult;
  const spread = { ...result } as ScanResult;
  const cleanResult = unmarked(result);
  const cleanEnvelope = createNodeScanMeasurementEnvelope(cleanResult, unmarked(envelope.measurement) as NodeScanMeasurement);
  const jsonEnvelope = createNodeScanMeasurementEnvelope(json, JSON.parse(JSON.stringify(envelope.measurement)) as NodeScanMeasurement);
  assert.equal(isSeamVisit(cleanResult) || isSeamVisit(cleanEnvelope), false, "the control still carries the mark");

  // The scan API, at its one call of a runner: nothing is saved or announced.
  for (const [what, handedBack] of [["the visit's own envelope", envelope], ["an envelope around a JSON copy", jsonEnvelope]] as const) {
    let saves = 0;
    let announced = 0;
    await assert.rejects(
      executePreparedScan(SINGLE, async () => handedBack, async (report) => ((saves += 1), report), undefined, false, { beforeSave: () => void (announced += 1) }),
      refusedAt("the scan API"),
      what
    );
    assert.deepEqual([saves, announced], [0, 0], what);
    resetScanLimitStateForTests();
  }
  const saved: unknown[] = [];
  await executePreparedScan(SINGLE, async () => cleanEnvelope, async (report) => (saved.push(report), report), undefined, false);
  resetScanLimitStateForTests();
  assert.equal(saved.length, 1, "the scan API did not take the control");

  // The runtime builders.
  for (const [what, one, oneOn] of [["the visit's own envelope", envelope, envelopeOn], ["an envelope around a JSON copy", jsonEnvelope, jsonEnvelopeOn]] as const) {
    assert.throws(() => buildRuntimeScanReportV2R2(one, "operator-cli", buildEnv()), refusedAt("the runtime report builder"), what);
    assert.throws(() => buildRuntimeComparisonScanReportV2R2(one, ordinaryOn, "baseline", "operator-cli", buildEnv()), refusedAt("the runtime comparison builder"), `${what}, as the baseline`);
    assert.throws(() => buildRuntimeComparisonScanReportV2R2(ordinary, oneOn, "variant", "operator-cli", buildEnv()), refusedAt("the runtime comparison builder"), `${what}, as the variant`);
  }
  assert.equal(buildRuntimeScanReportV2R2(cleanEnvelope, "operator-cli", buildEnv()).reportType, "single");
  assert.equal(buildRuntimeComparisonScanReportV2R2(cleanEnvelope, ordinaryOn, "baseline", "operator-cli", buildEnv()).reportType, "comparison");
  assert.equal(buildRuntimeComparisonScanReportV2R2(ordinary, cleanEnvelopeOn, "variant", "operator-cli", buildEnv()).reportType, "comparison");

  // The report store, the v1 redactor and the v1 public projection, on the result and its copies.
  for (const [what, one] of [["the visit's own result", result], ["a JSON copy", json], ["an object spread", spread]] as const) {
    assert.throws(() => prepareScanReportBundle(one), refusedAt("the report store"), what);
    assert.throws(() => redactScanResultV1(one), refusedAt("the v1 redactor"), what);
    assert.throws(() => redactScanReportV1(one), refusedAt("the v1 redactor"), what);
    assert.throws(() => toPublicScanReportV1(one), refusedAt("the v1 public projection"), what);
    assert.throws(() => toPublicScanReportV1(createGpcComparisonReport(one, ordinaryOn.result)), refusedAt("the v1 public projection"), `${what}, as the baseline`);
    await assert.rejects(writeV2ShadowArtifact(one as unknown as Parameters<typeof writeV2ShadowArtifact>[0], buildEnv()), refusedAt("the shadow store"), what);
  }
  // A comparison of two unmarked copies that carries the key itself: only the redactor's check at its report's own entry can refuse it.
  const aroundClean = { ...createGpcComparisonReport(cleanResult, ordinaryOn.result), [SEAM_VISIT_MARKER]: INVESTIGATION_SEAM_VERSION } as unknown as ScanResult;
  assert.throws(() => redactScanReportV1(aroundClean), refusedAt("the v1 redactor"), "a comparison of unmarked copies that carries the key itself");
  // The controls: the same visit with the mark taken off gets past each of those steps.
  assert.doesNotThrow(() => prepareScanReportBundle(cleanResult));
  assert.doesNotThrow(() => redactScanResultV1(cleanResult));
  assert.equal(redactScanReportV1(createGpcComparisonReport(cleanResult, ordinaryOn.result)).report.reportType, "comparison");
  const projected = toPublicScanReportV1(cleanResult);
  assert.equal(isSeamVisit(projected), false);
  await assert.rejects(writeV2ShadowArtifact(cleanResult as unknown as Parameters<typeof writeV2ShadowArtifact>[0], buildEnv()), (error) => !(error instanceof SeamVisitRefusal));

  // The two readers decline the mark, as they decline anything that is not a report, and take the same report without it.
  const projectedWithKey = { ...projected, [SEAM_VISIT_MARKER]: INVESTIGATION_SEAM_VERSION };
  assert.equal(readStoredScanReport(projected).ok, true, "the stored reader does not take the control");
  assert.deepEqual(readStoredScanReport(projectedWithKey), { ok: false, error: "invalid" });
  assert.equal(readScanTransportPayload(JSON.parse(JSON.stringify(cleanResult))).kind, "report", "the transport reader does not take the control");
  assert.deepEqual(readScanTransportPayload(json), { kind: "unreadable", error: "invalid" });
  assert.equal(readScanTransportPayload({ status: "succeeded", jobId: "job", report: JSON.parse(JSON.stringify(cleanResult)) }).kind, "report");
  assert.deepEqual(readScanTransportPayload({ status: "succeeded", jobId: "job", report: json }), { kind: "unreadable", error: "invalid" });
  // A job envelope that carries the key itself, around the unmarked copy: the stored reader
  // further in reads only the report, so only the transport reader's own check declines this.
  assert.deepEqual(
    readScanTransportPayload({ status: "succeeded", jobId: "job", report: JSON.parse(JSON.stringify(cleanResult)), [SEAM_VISIT_MARKER]: INVESTIGATION_SEAM_VERSION }),
    { kind: "unreadable", error: "invalid" },
    "a job envelope that carries the key around an unmarked report"
  );
}

// ---------------------------------------------------------------------------
// Property 5: readback.
// ---------------------------------------------------------------------------

test("S3 readback: a seam visit's use record says which hooks were set, the init script's sha256, both bounds and each hook's time, as set and as the hooks saw them", { timeout: 120_000 }, async () => {
  const own = { pageReady: 0, afterEnvelope: 0, boundary: new Map<ScrollCheckBoundary, number>() };
  const timed = async (work: () => Promise<void>): Promise<number> => {
    const started = Date.now();
    await work();
    return Date.now() - started;
  };
  const seam: InvestigationSeam = {
    pageReady: async () => void (own.pageReady = await timed(slowly)),
    initScript: LOGGER_SCRIPT,
    finalFingerprintRead: () => undefined,
    afterEnvelope: async () => void (own.afterEnvelope = await timed(slowly)),
    afterEnvelopeTimeoutMs: 45_000,
    scrollCheckBoundary: async (boundary) => void own.boundary.set(boundary, await timed(slowly)),
    scrollCheckDeadlineMarginMs: 20_000
  };
  const expected = {
    version: INVESTIGATION_SEAM_VERSION,
    pageReady: true,
    initScriptSha256: createHash("sha256").update(LOGGER_SCRIPT, "utf8").digest("hex"),
    finalFingerprintRead: true,
    afterEnvelope: true,
    afterEnvelopeTimeoutMs: 45_000,
    scrollCheckBoundary: true,
    scrollCheckDeadlineMarginMs: 20_000
  };
  // Known before the visit, and the same after it.
  assert.deepEqual(describeInvestigationSeam(seam), expected);
  const run = await elapsed(visit({ ...CHECKED, investigationSeam: seam }));
  assert.equal(run.error, undefined, String(run.error));
  const envelope = run.value as NodeScanMeasurementEnvelope;
  const use = investigationSeamUse(envelope);
  assert.ok(use);
  assert.deepEqual(use.description, expected);
  assert.equal(JSON.stringify(use).includes("__seamS3"), false, "the record holds the init script's text");

  const durations = use.hookDurationsMs;
  // Each hook's time, by the scanner's clock, is at least what the hook itself measured and at most the visit's.
  const held = (what: string, recordedMs: number | null, hookMs: number): void => {
    assert.ok(typeof recordedMs === "number", `${what}: no time recorded`);
    assert.ok(recordedMs >= hookMs && recordedMs <= run.ms, `${what}: recorded ${recordedMs} ms, the hook measured ${hookMs} ms, the visit took ${run.ms} ms`);
  };
  held("pageReady", durations.pageReady, own.pageReady);
  held("afterEnvelope", durations.afterEnvelope, own.afterEnvelope);
  assert.equal(typeof durations.finalFingerprintRead, "number");
  assert.deepEqual(durations.scrollCheckBoundary.map((call) => call.boundary), [...own.boundary.keys()]);
  for (const call of durations.scrollCheckBoundary) held(call.boundary, call.ms, own.boundary.get(call.boundary) ?? Number.NaN);

  // A copy of the envelope has no record: the record is the visit's own.
  assert.equal(investigationSeamUse({ ...envelope }), undefined);
  // A seam that sets only hooks reads back the two default bounds, and a visit with no seam has no record.
  const defaults = await visit({ investigationSeam: { afterEnvelope: () => undefined } });
  assert.deepEqual(investigationSeamUse(defaults)?.description, {
    version: INVESTIGATION_SEAM_VERSION,
    pageReady: false,
    initScriptSha256: null,
    finalFingerprintRead: false,
    afterEnvelope: true,
    afterEnvelopeTimeoutMs: DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS,
    scrollCheckBoundary: false,
    scrollCheckDeadlineMarginMs: SCROLL_CHECK_DEADLINE_MARGIN_MS
  });
  assert.deepEqual(investigationSeamUse(defaults)?.hookDurationsMs.pageReady, null);
  assert.equal(investigationSeamUse(await visit()), undefined);
});

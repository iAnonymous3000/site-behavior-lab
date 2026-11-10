import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import type { Page } from "playwright";
import { createGpcComparisonReport } from "./compare-reports";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import type { FingerprintObservationCollection } from "./fingerprint-observer";
import {
  DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS,
  describeInvestigationSeam,
  INVESTIGATION_SEAM_MARKER,
  INVESTIGATION_SEAM_VERSION,
  InvestigationSeamHookTimeoutError,
  investigationSeamUse,
  isSeamVisit,
  MAX_AFTER_ENVELOPE_TIMEOUT_MS,
  MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS,
  MIN_AFTER_ENVELOPE_TIMEOUT_MS,
  openInvestigationSeam,
  refuseSeamOption,
  refuseSeamVisit,
  SeamVisitRefusal,
  type InvestigationSeam,
  type InvestigationSeamReadings,
  type OpenInvestigationSeam
} from "./investigation-seam";
import {
  createNodeScanMeasurementEnvelope,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { prepareScanReportBundle } from "./report-store";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { resetScanLimitStateForTests } from "./scan-limits";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import { buildRuntimeComparisonScanReportV2R2, buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";
import { writeV2ShadowArtifact } from "./scan-report-v2-shadow-store";
import type { ScanSiteOptions } from "./scanner";
import { SCROLL_CHECK_DEADLINE_MARGIN_MS } from "./scroll-check";
import type { ScanResult } from "./types";

/**
 * The investigation seam without a browser: its description, what it
 * refuses, how its hooks are bounded and timed, the mark, and every place a
 * marked visit is refused. The visits with a real page are in
 * lib/investigation-seam-fixture.test.ts.
 */

const BUILD_ENV = { ...process.env, [BUILD_COMMIT_ENV]: "c".repeat(40) };
const NEVER = (): Promise<void> => new Promise<void>(() => undefined);
const PAGE = { marker: "the visit's page" } as unknown as Page;
const READINGS = {} as InvestigationSeamReadings;
const COLLECTION: FingerprintObservationCollection = {
  observations: { events: [{ api: "CanvasRenderingContext2D.fillText", count: 2 }], detections: [] },
  attemptedFrames: 1,
  readableFrames: 1,
  listenerAttributionLostFrames: 0,
  canvasEvidenceBoundedFrames: 0,
  canvasFontEvidenceBoundedFrames: 0,
  summaryWithheldFrames: 0,
  attemptedWorkerRealms: 0,
  readableWorkerRealms: 0,
  sharedWorkersEndedAtOnce: 0
};

afterEach(() => {
  delete process.env[PUBLIC_R2_REPORTS_ENV];
  delete process.env[BUILD_COMMIT_ENV];
  delete process.env[CONSENT_VERIFICATION_ENV];
  resetScanLimitStateForTests();
});

function cleanEnvelope(): NodeScanMeasurementEnvelope {
  return scanMeasurementEnvelopeWithR2Run(makeScanRunV2R2());
}

/** A seam visit's envelope, marked exactly as the scanner marks one. */
function seamEnvelope(seam: InvestigationSeam = {}): { envelope: NodeScanMeasurementEnvelope; open: OpenInvestigationSeam } {
  const clean = cleanEnvelope();
  const result = structuredClone(clean.result);
  const measurement = structuredClone(clean.measurement) as NodeScanMeasurement;
  const open = openInvestigationSeam(seam);
  open.markParts(result, measurement);
  const envelope = createNodeScanMeasurementEnvelope(result, measurement);
  open.markVisit(envelope);
  return { envelope, open };
}

/** The three ordinary ways to copy a result, none of which keeps its identity. */
const COPIES: readonly (readonly [string, (result: ScanResult) => ScanResult])[] = [
  ["a structured clone", (result) => structuredClone(result)],
  ["a JSON copy", (result) => JSON.parse(JSON.stringify(result)) as ScanResult],
  ["an object spread", (result) => ({ ...result })]
];

/** An envelope rebuilt around a copied result, with a measurement no seam touched. */
function envelopeAround(result: ScanResult): NodeScanMeasurementEnvelope {
  return createNodeScanMeasurementEnvelope(result, structuredClone(cleanEnvelope().measurement) as NodeScanMeasurement);
}

const isRefusal = (error: unknown): boolean => error instanceof SeamVisitRefusal;

const SINGLE: PreparedScanRequest = {
  clientKey: "seam",
  url: "https://www.example.com/",
  device: "desktop",
  gpcEnabled: false,
  compareGpc: false,
  compareShields: false,
  compareConsent: false,
  rateLimitCost: 1
};

test("a seam's description says which hooks are set, its two bounds and the init script's sha256, and never the script", () => {
  const initScript = "window.__logger = []; /* a secret marker: 4f1c */";
  const full: InvestigationSeam = {
    pageReady: () => undefined,
    initScript,
    finalFingerprintRead: () => undefined,
    afterEnvelope: () => undefined,
    afterEnvelopeTimeoutMs: 45_000,
    scrollCheckBoundary: () => undefined,
    scrollCheckDeadlineMarginMs: 60_000
  };
  const description = describeInvestigationSeam(full);
  const sha256 = createHash("sha256").update(initScript, "utf8").digest("hex");
  // The exact bytes a runner records: these keys, in this order.
  assert.equal(
    JSON.stringify(description),
    `{"version":"investigation-seam@1","pageReady":true,"initScriptSha256":"${sha256}","finalFingerprintRead":true,"afterEnvelope":true,"afterEnvelopeTimeoutMs":45000,"scrollCheckBoundary":true,"scrollCheckDeadlineMarginMs":60000}`
  );
  assert.equal(JSON.stringify(description).includes("4f1c"), false, "the script's text is in the description");
  assert.equal(Object.isFrozen(description), true);
  // The description a visit runs under is the one a caller can take first.
  assert.deepEqual(openInvestigationSeam(full).description, description);

  // An empty seam: no hook, and the bounds that apply when none is given.
  assert.deepEqual(describeInvestigationSeam({}), {
    version: INVESTIGATION_SEAM_VERSION,
    pageReady: false,
    initScriptSha256: null,
    finalFingerprintRead: false,
    afterEnvelope: false,
    afterEnvelopeTimeoutMs: DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS,
    scrollCheckBoundary: false,
    scrollCheckDeadlineMarginMs: SCROLL_CHECK_DEADLINE_MARGIN_MS
  });
  assert.equal(DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS, 30_000);
  assert.equal(SCROLL_CHECK_DEADLINE_MARGIN_MS, 2_000, "the scanner's own margin did not move");
  // The sha256 is over the script's UTF-8 bytes.
  assert.equal(
    describeInvestigationSeam({ initScript: "// café" }).initScriptSha256,
    createHash("sha256").update(Buffer.from("// café", "utf8")).digest("hex")
  );
});

test("a seam the scanner cannot read is refused before a visit starts", () => {
  const refused: [string, unknown, RegExp][] = [
    ["an unknown field", { pageReady: () => undefined, pageReadyy: () => undefined }, /has no field pageReadyy/],
    ["a symbol field", { [Symbol("hook")]: () => undefined }, /has no field Symbol\(hook\)/],
    ["a hook that is not a function", { afterEnvelope: "later" }, /afterEnvelope must be a function/],
    ["an empty init script", { initScript: "" }, /initScript must be script source text/],
    ["an init script that is not text", { initScript: { content: "x" } }, /initScript must be script source text/],
    ["a margin under the scanner's own", { scrollCheckDeadlineMarginMs: SCROLL_CHECK_DEADLINE_MARGIN_MS - 1 }, /scrollCheckDeadlineMarginMs must be an integer from 2000 to 600000/],
    ["a margin over the bound", { scrollCheckDeadlineMarginMs: MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS + 1 }, /scrollCheckDeadlineMarginMs must be an integer/],
    ["a margin that is not an integer", { scrollCheckDeadlineMarginMs: 2_500.5 }, /scrollCheckDeadlineMarginMs must be an integer/],
    ["a timeout under its range", { afterEnvelopeTimeoutMs: MIN_AFTER_ENVELOPE_TIMEOUT_MS - 1 }, /afterEnvelopeTimeoutMs must be an integer from 1000 to 600000/],
    ["a timeout over its range", { afterEnvelopeTimeoutMs: MAX_AFTER_ENVELOPE_TIMEOUT_MS + 1 }, /afterEnvelopeTimeoutMs must be an integer/],
    ["a timeout that is not a number", { afterEnvelopeTimeoutMs: "30000" }, /afterEnvelopeTimeoutMs must be an integer/],
    ["an array", [], /must be a plain object/],
    ["null", null, /must be a plain object/],
    ["a class instance", new (class Seam {})(), /must be a plain object/],
    ["true", true, /must be a plain object/]
  ];
  for (const [what, seam, message] of refused) {
    assert.throws(() => openInvestigationSeam(seam as InvestigationSeam), message, what);
    assert.throws(() => describeInvestigationSeam(seam as InvestigationSeam), message, what);
  }
  // The ranges' ends, and a field set to undefined, are read.
  for (const seam of [
    { scrollCheckDeadlineMarginMs: SCROLL_CHECK_DEADLINE_MARGIN_MS },
    { scrollCheckDeadlineMarginMs: MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS },
    { afterEnvelopeTimeoutMs: MIN_AFTER_ENVELOPE_TIMEOUT_MS },
    { afterEnvelopeTimeoutMs: MAX_AFTER_ENVELOPE_TIMEOUT_MS },
    { pageReady: undefined, initScript: undefined }
  ]) {
    assert.doesNotThrow(() => openInvestigationSeam(seam));
  }
});

test("a visit keeps the hooks its seam had when it began", async () => {
  const called: string[] = [];
  const seam: InvestigationSeam = { pageReady: () => void called.push("first"), initScript: "1;" };
  const open = openInvestigationSeam(seam);
  seam.pageReady = () => void called.push("swapped");
  seam.initScript = "2;";
  await open.pageReady(PAGE, undefined);
  assert.deepEqual(called, ["first"]);
  assert.equal(open.initScript, "1;");
});

test("pageReady gets the page, is timed, and ends as soon as the visit is cancelled", async () => {
  const pages: Page[] = [];
  const open = openInvestigationSeam({
    pageReady: async (page) => {
      pages.push(page);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  });
  assert.equal(open.use().hookDurationsMs.pageReady, null);
  await open.pageReady(PAGE, undefined);
  assert.deepEqual(pages, [PAGE]);
  const took = open.use().hookDurationsMs.pageReady;
  assert.ok(typeof took === "number" && took >= 30 && took < 5_000, `pageReady took ${took} ms by the record`);

  // A hook that never settles: the caller's signal ends the wait.
  const cancel = new AbortController();
  const reason = new Error("the caller cancelled");
  const hung = openInvestigationSeam({ pageReady: NEVER }).pageReady(PAGE, cancel.signal);
  setTimeout(() => cancel.abort(reason), 20);
  await assert.rejects(hung, (error) => error === reason);
  // Already cancelled: the hook's own error is not what the visit hears.
  await assert.rejects(
    openInvestigationSeam({ pageReady: () => Promise.reject(new Error("late")) }).pageReady(PAGE, cancel.signal),
    (error) => error === reason
  );
  // A hook that throws, at once or later, fails with its own error.
  const thrown = new Error("the hook threw");
  await assert.rejects(
    openInvestigationSeam({
      pageReady: () => {
        throw thrown;
      }
    }).pageReady(PAGE, undefined),
    (error) => error === thrown
  );
  // No hook: nothing is called and nothing is timed.
  const none = openInvestigationSeam({});
  await none.pageReady(PAGE, undefined);
  assert.equal(none.use().hookDurationsMs.pageReady, null);
});

test("afterEnvelope is bounded by its own timeout and by the caller's signal", async () => {
  // A hook that never settles fails the visit when its bound passes.
  const bounded = openInvestigationSeam({ afterEnvelope: NEVER, afterEnvelopeTimeoutMs: MIN_AFTER_ENVELOPE_TIMEOUT_MS });
  const before = Date.now();
  await assert.rejects(
    bounded.afterEnvelope(READINGS, undefined),
    (error) => error instanceof InvestigationSeamHookTimeoutError && error.timeoutMs === 1_000 && /did not settle within 1000 ms/.test(error.message)
  );
  const waited = Date.now() - before;
  assert.ok(waited >= 950 && waited < 10_000, `the bound ended the wait after ${waited} ms`);
  assert.equal(bounded.use().hookDurationsMs.afterEnvelope, null, "a hook that never settled has no time");

  // The caller's signal ends it sooner.
  const cancel = new AbortController();
  const reason = new Error("the caller cancelled");
  const hung = openInvestigationSeam({ afterEnvelope: NEVER }).afterEnvelope(READINGS, cancel.signal);
  setTimeout(() => cancel.abort(reason), 20);
  await assert.rejects(hung, (error) => error === reason);

  // A hook that settles is handed the readings, and is timed.
  const seen: InvestigationSeamReadings[] = [];
  const open = openInvestigationSeam({ afterEnvelope: (read) => void seen.push(read) });
  await open.afterEnvelope(READINGS, undefined);
  assert.deepEqual(seen, [READINGS]);
  assert.equal(typeof open.use().hookDurationsMs.afterEnvelope, "number");
  // A hook that rejects fails with its own error.
  const thrown = new Error("the hook threw");
  await assert.rejects(
    openInvestigationSeam({ afterEnvelope: () => Promise.reject(thrown) }).afterEnvelope(READINGS, undefined),
    (error) => error === thrown
  );
});

test("finalFingerprintRead gets a copy at once, and a hook that returns a promise fails the visit", () => {
  const seen: FingerprintObservationCollection[] = [];
  const open = openInvestigationSeam({
    finalFingerprintRead: (collection) => {
      seen.push(collection);
      // What a hook does to its copy never reaches the scanner's own read.
      collection.observations.events.length = 0;
      collection.readableFrames = 99;
    }
  });
  const own = structuredClone(COLLECTION);
  open.finalFingerprintRead(own);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], own);
  assert.notEqual(seen[0].observations, own.observations);
  assert.deepEqual(own, COLLECTION, "the hook altered the scanner's own read");
  assert.equal(typeof open.use().hookDurationsMs.finalFingerprintRead, "number");

  const thrown = new Error("the hook threw");
  assert.throws(
    () =>
      openInvestigationSeam({
        finalFingerprintRead: () => {
          throw thrown;
        }
      }).finalFingerprintRead(own),
    (error) => error === thrown
  );
  // Nothing would hear an async hook reject, so it is refused outright.
  const asyncHook = (async () => {
    throw new Error("nobody hears this");
  }) as unknown as InvestigationSeam["finalFingerprintRead"];
  assert.throws(
    () => openInvestigationSeam({ finalFingerprintRead: asyncHook }).finalFingerprintRead(own),
    /finalFingerprintRead is synchronous and must not return a promise/
  );
  // No hook: nothing is called.
  const none = openInvestigationSeam({});
  none.finalFingerprintRead(own);
  assert.equal(none.use().hookDurationsMs.finalFingerprintRead, null);
});

test("each boundary call is timed by name, one that never settles has no time, and one that throws is kept for the visit", async () => {
  const read = async (): Promise<FingerprintObservationCollection> => structuredClone(COLLECTION);
  const reads: FingerprintObservationCollection[] = [];
  const open = openInvestigationSeam({
    scrollCheckBoundary: async (boundary, readFingerprint) => {
      if (boundary === "control-end") return NEVER();
      if (boundary === "control-start") reads.push(await readFingerprint());
    }
  });
  assert.equal(open.hasScrollCheckBoundary, true);
  await open.scrollCheckBoundary("check-start", read);
  await open.scrollCheckBoundary("control-start", read);
  // The check bounds this one by its own deadline: here nothing waits for it.
  void open.scrollCheckBoundary("control-end", read);
  await open.scrollCheckBoundary("scroll-end", read);
  assert.deepEqual(reads, [COLLECTION]);
  const calls = open.use().hookDurationsMs.scrollCheckBoundary;
  assert.deepEqual(calls.map((call) => call.boundary), ["check-start", "control-start", "control-end", "scroll-end"]);
  assert.deepEqual(calls.map((call) => typeof call.ms), ["number", "number", "object", "number"]);
  assert.equal(calls[2].ms, null);
  assert.doesNotThrow(() => open.rethrowBoundaryFailure());

  const thrown = new Error("the boundary hook threw");
  const failing = openInvestigationSeam({
    scrollCheckBoundary: (boundary) => {
      if (boundary === "control-start") throw thrown;
    }
  });
  await failing.scrollCheckBoundary("check-start", read);
  await assert.rejects(failing.scrollCheckBoundary("control-start", read), (error) => error === thrown);
  assert.throws(() => failing.rethrowBoundaryFailure(), (error) => error === thrown);

  // No callback and no margin: a check is handed neither.
  const none = openInvestigationSeam({});
  assert.equal(none.hasScrollCheckBoundary, false);
  assert.equal(none.scrollCheckDeadlineMarginMs, null);
  assert.equal(openInvestigationSeam({ scrollCheckDeadlineMarginMs: 60_000 }).scrollCheckDeadlineMarginMs, 60_000);
});

test("a seam visit is marked by identity and in band, and its use can be read back from its envelope alone", async () => {
  const seam: InvestigationSeam = { pageReady: () => undefined, initScript: "1;", scrollCheckDeadlineMarginMs: 10_000 };
  const { envelope, open } = seamEnvelope(seam);
  await open.pageReady(PAGE, undefined);

  const use = investigationSeamUse(envelope);
  assert.ok(use);
  assert.deepEqual(use.description, describeInvestigationSeam(seam));
  assert.equal(typeof use.hookDurationsMs.pageReady, "number");
  assert.deepEqual(use.hookDurationsMs, { pageReady: use.hookDurationsMs.pageReady, finalFingerprintRead: null, afterEnvelope: null, scrollCheckBoundary: [] });
  assert.equal(Object.isFrozen(use) && Object.isFrozen(use.hookDurationsMs) && Object.isFrozen(use.hookDurationsMs.scrollCheckBoundary), true);
  // The use is the envelope's alone: no part and no copy reads it back.
  assert.equal(investigationSeamUse(envelope.result), undefined);
  assert.equal(investigationSeamUse({ ...envelope }), undefined);

  // In band: one key, on the result and on the measurement, which cannot be
  // taken off the visit's own objects.
  const result = envelope.result as unknown as Record<string, unknown>;
  const measurement = envelope.measurement as unknown as Record<string, unknown>;
  assert.equal(result[INVESTIGATION_SEAM_MARKER], INVESTIGATION_SEAM_VERSION);
  assert.equal(measurement[INVESTIGATION_SEAM_MARKER], INVESTIGATION_SEAM_VERSION);
  assert.equal(Object.keys(result).includes(INVESTIGATION_SEAM_MARKER), true);
  assert.throws(() => {
    "use strict";
    delete result[INVESTIGATION_SEAM_MARKER];
  }, TypeError);
  assert.equal(INVESTIGATION_SEAM_MARKER in result, true);

  for (const marked of [envelope, envelope.result, envelope.measurement]) assert.equal(isSeamVisit(marked), true);
  // Identity alone is a mark: an envelope remembered as a seam visit's is
  // one, and so are its parts, with no key on any of them.
  const remembered = cleanEnvelope();
  openInvestigationSeam({}).markVisit(remembered);
  assert.equal(INVESTIGATION_SEAM_MARKER in remembered.result, false);
  for (const marked of [remembered, remembered.result, remembered.measurement]) assert.equal(isSeamVisit(marked), true);
  assert.throws(() => refuseSeamVisit(remembered.result, "a test"), /Refusing a visit made with the investigation seam at a test: it is never published\./);
  // Every ordinary copy of the result and of the measurement is still one.
  for (const [what, copy] of COPIES) {
    const copied = copy(envelope.result);
    assert.notEqual(copied, envelope.result);
    assert.equal(isSeamVisit(copied), true, what);
    assert.equal(isSeamVisit({ baseline: copied, variant: cleanEnvelope().result }), true, `${what}, held by another object`);
    assert.equal(isSeamVisit(copy(envelope.measurement as unknown as ScanResult)), true, `${what} of the measurement`);
  }
  assert.equal(isSeamVisit({ ...envelope }), true, "a spread of the envelope still holds its marked parts");
  assert.equal(isSeamVisit(structuredClone({ result: envelope.result, measurement: envelope.measurement })), true);
});

test("a visit that used no seam has no mark, and neither do the values the refusals read past", () => {
  const clean = cleanEnvelope();
  assert.equal(investigationSeamUse(clean), undefined);
  for (const value of [clean, clean.result, clean.measurement, structuredClone(clean.result), { ...clean }, null, undefined, 7, "investigationSeamVisit", [], {}]) {
    assert.equal(isSeamVisit(value), false);
    assert.doesNotThrow(() => refuseSeamVisit(value, "a test"));
  }
  assert.equal(JSON.stringify(clean.result).toLowerCase().includes("seam"), false);
  assert.equal(JSON.stringify(clean.measurement).toLowerCase().includes("seam"), false);
});

test("what the mark does not survive: a key deleted from a copy on purpose, and an object rebuilt from named fields", () => {
  // Nothing claims otherwise (docs/runtime-boundaries.md). These pin the two
  // limits, so a change to either is seen.
  const { envelope } = seamEnvelope();
  const stripped = { ...envelope.result } as unknown as Record<string, unknown>;
  delete stripped[INVESTIGATION_SEAM_MARKER];
  assert.equal(isSeamVisit(stripped), false);
  // The v1 sanitizer builds its output field by field, so the key is not in it.
  const sanitized = redactScanReportV1(envelope.result).report;
  assert.equal(INVESTIGATION_SEAM_MARKER in sanitized, false);
  assert.equal(isSeamVisit(sanitized), false);
});

test("options that carry the seam's field are refused, whether the key is their own or inherited, whatever its value", () => {
  assert.throws(() => refuseSeamOption({ investigationSeam: {} }), isRefusal);
  assert.throws(() => refuseSeamOption({ investigationSeam: undefined }), isRefusal, "the key alone is enough");
  assert.throws(() => refuseSeamOption(Object.create({ investigationSeam: {} }) as object), isRefusal, "an inherited key is carried too");
  assert.doesNotThrow(() => refuseSeamOption({ publicUrlAlreadyVerified: true, scrollCheck: true }));
});

// The places a seam visit is refused: the scan API, both runtime builders,
// the report store and the shadow store.

test("the scan API refuses a seam visit and every copy of one, before anything is built, saved or announced", async () => {
  const { envelope } = seamEnvelope();
  const returned: [string, NodeScanMeasurementEnvelope][] = [
    ["the visit's own envelope", envelope],
    ...COPIES.map(([what, copy]): [string, NodeScanMeasurementEnvelope] => [`an envelope around ${what} of its result`, envelopeAround(copy(envelope.result))])
  ];
  for (const [what, handedBack] of returned) {
    let saves = 0;
    let announced = 0;
    await assert.rejects(
      executePreparedScan(SINGLE, async () => handedBack, async (report) => {
        saves += 1;
        return report;
      }, undefined, false, {
        beforeSave: () => {
          announced += 1;
        }
      }),
      isRefusal,
      what
    );
    assert.deepEqual([saves, announced], [0, 0], what);
  }

  // A comparison stops at the arm that handed one back: the other never runs.
  for (const mode of [{ compareGpc: true }, { compareShields: true }, { compareConsent: true }]) {
    let visits = 0;
    let saves = 0;
    const scan: ScanRunner = async () => {
      visits += 1;
      return envelope;
    };
    await assert.rejects(
      executePreparedScan({ ...SINGLE, ...mode }, scan, async (report) => {
        saves += 1;
        return report;
      }, undefined, false, { drawComparisonFirstArm: () => "baseline" }),
      isRefusal
    );
    assert.deepEqual([visits, saves], [1, 0], JSON.stringify(mode));
  }

  // The same path with a visit that used no seam goes through.
  const saved: unknown[] = [];
  const report = await executePreparedScan(SINGLE, async () => cleanEnvelope(), async (ordinary) => {
    saved.push(ordinary);
    return ordinary;
  }, undefined, false);
  assert.equal(report.schemaVersion, 1);
  assert.equal(saved.length, 1);
});

test("the scan API starts no visit whose options carry the seam, however the key got there", async () => {
  // The public path builds its own options, so the only way a test can make
  // them carry the key is from underneath: every object inherits it here.
  let visits = 0;
  const scan: ScanRunner = async () => {
    visits += 1;
    return cleanEnvelope();
  };
  Object.defineProperty(Object.prototype, "investigationSeam", { value: {}, configurable: true, enumerable: false, writable: true });
  let outcome: unknown;
  try {
    outcome = await executePreparedScan(SINGLE, scan, async (report) => report, undefined, false).then(
      () => "the visit ran",
      (error: unknown) => error
    );
  } finally {
    delete (Object.prototype as Record<string, unknown>).investigationSeam;
  }
  assert.equal("investigationSeam" in {}, false, "the test left its key behind");
  assert.ok(outcome instanceof SeamVisitRefusal, String(outcome));
  assert.match(outcome.message, /Refusing to start a public visit whose options carry the investigation seam/);
  assert.equal(visits, 0, "the runner was called");
});

test("the public path hands a runner exactly the options it always did, in every mode", async () => {
  process.env[PUBLIC_R2_REPORTS_ENV] = "1";
  process.env[BUILD_COMMIT_ENV] = "a".repeat(40);
  process.env[CONSENT_VERIFICATION_ENV] = "1";
  const stop = new Error("the test stops each visit once it has its options");
  const cancel = new AbortController();
  const keysOf = async (prepared: PreparedScanRequest, first: "baseline" | "variant" = "baseline"): Promise<string[]> => {
    let seen: ScanSiteOptions | undefined;
    await assert.rejects(
      executePreparedScan(prepared, async (_payload, options) => {
        seen = options;
        throw stop;
      }, async (report) => report, undefined, false, { signal: cancel.signal, drawComparisonFirstArm: () => first }),
      (error) => error === stop
    );
    resetScanLimitStateForTests();
    assert.ok(seen);
    return Object.keys(seen).sort();
  };
  const ordinary = ["onProgress", "publicUrlAlreadyVerified", "signal"];
  assert.deepEqual(await keysOf(SINGLE), ordinary);
  assert.deepEqual(await keysOf({ ...SINGLE, inspect: "https://cdn.example.net/collect" }), ["inspect", ...ordinary]);
  assert.deepEqual(await keysOf({ ...SINGLE, check: "scroll", rateLimitCost: 2 }), [...ordinary, "scrollCheck"].sort());
  for (const first of ["baseline", "variant"] as const) {
    assert.deepEqual(await keysOf({ ...SINGLE, compareGpc: true }, first), ordinary);
    assert.deepEqual(await keysOf({ ...SINGLE, compareConsent: true }, first), ordinary);
  }
  assert.deepEqual(await keysOf({ ...SINGLE, compareShields: true }, "baseline"), ordinary);
  assert.deepEqual(await keysOf({ ...SINGLE, compareShields: true }, "variant"), [...ordinary, "shieldsBlockingEnabled"].sort());
});

test("both runtime builders refuse a seam visit and every copy of one", () => {
  const { envelope } = seamEnvelope();
  const clean = cleanEnvelope();
  const marked: [string, NodeScanMeasurementEnvelope][] = [
    ["the visit's own envelope", envelope],
    ["its parts in another object", { result: envelope.result, measurement: envelope.measurement } as NodeScanMeasurementEnvelope],
    ["a clean result beside its measurement", { result: clean.result, measurement: envelope.measurement } as NodeScanMeasurementEnvelope],
    ...COPIES.map(([what, copy]): [string, NodeScanMeasurementEnvelope] => [`an envelope around ${what} of its result`, envelopeAround(copy(envelope.result))])
  ];
  for (const [what, one] of marked) {
    assert.throws(() => buildRuntimeScanReportV2R2(one, "operator-cli", BUILD_ENV), isRefusal, what);
    assert.throws(() => buildRuntimeComparisonScanReportV2R2(one, clean, "baseline", "operator-cli", BUILD_ENV), isRefusal, `${what}, as the baseline`);
    assert.throws(() => buildRuntimeComparisonScanReportV2R2(clean, one, "baseline", "operator-cli", BUILD_ENV), isRefusal, `${what}, as the variant`);
  }
  // The same builder, the same environment, a visit that used no seam.
  assert.equal(buildRuntimeScanReportV2R2(clean, "operator-cli", BUILD_ENV).reportType, "single");
});

test("the report store refuses a seam visit's result and every copy of one, alone or as an arm of a comparison", () => {
  const { envelope } = seamEnvelope();
  const clean = cleanEnvelope().result;
  const marked: [string, ScanResult][] = [["the visit's own result", envelope.result], ...COPIES.map(([what, copy]): [string, ScanResult] => [what, copy(envelope.result)])];
  for (const [what, result] of marked) {
    assert.throws(() => prepareScanReportBundle(result), isRefusal, what);
    assert.throws(() => prepareScanReportBundle(createGpcComparisonReport(result, clean)), isRefusal, `${what}, as the baseline`);
    assert.throws(() => prepareScanReportBundle(createGpcComparisonReport(clean, result)), isRefusal, `${what}, as the variant`);
  }
  // A visit that used no seam is prepared, and its bytes name no seam.
  const prepared = prepareScanReportBundle(clean);
  assert.equal(prepared.reportWire.toLowerCase().includes("seam"), false);
  assert.equal(prepared.sidecarWire.toLowerCase().includes("seam"), false);
});

test("the shadow store refuses a seam visit's result and every copy of one before it reads anything", async () => {
  const { envelope } = seamEnvelope();
  type Shadowed = Parameters<typeof writeV2ShadowArtifact>[0];
  const marked: [string, unknown][] = [
    ["the visit's own result", envelope.result],
    ["the visit's own envelope", envelope],
    ...COPIES.map(([what, copy]): [string, unknown] => [what, copy(envelope.result)])
  ];
  for (const [what, value] of marked) {
    await assert.rejects(writeV2ShadowArtifact(value as Shadowed, BUILD_ENV), isRefusal, what);
  }
  // A visit that used no seam gets past that check, to the store's own.
  await assert.rejects(
    writeV2ShadowArtifact(cleanEnvelope().result as unknown as Shadowed, BUILD_ENV),
    (error) => !(error instanceof SeamVisitRefusal)
  );
});

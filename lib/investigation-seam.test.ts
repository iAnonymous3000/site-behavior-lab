import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { Page } from "playwright";
import { readLoadedReport } from "./client-report-reader";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { createGpcComparisonReport } from "./compare-reports";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import type { FingerprintObservationCollection } from "./fingerprint-observer";
import {
  DEFAULT_AFTER_ENVELOPE_TIMEOUT_MS,
  describeInvestigationSeam,
  INVESTIGATION_SEAM_VERSION,
  InvestigationSeamHookTimeoutError,
  investigationSeamUse,
  MAX_AFTER_ENVELOPE_TIMEOUT_MS,
  MAX_SEAM_SCROLL_CHECK_DEADLINE_MARGIN_MS,
  MIN_AFTER_ENVELOPE_TIMEOUT_MS,
  openInvestigationSeam,
  type InvestigationSeam,
  type InvestigationSeamReadings,
  type OpenInvestigationSeam
} from "./investigation-seam";
import {
  createNodeScanMeasurementEnvelope,
  type NodeScanMeasurement,
  type NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import { readManagedReport } from "./managed-report-reader";
import { planPrivacyReplacement } from "./privacy-replacement";
import { planR2ReportRemediation } from "./r2-report-remediation";
import { redactScanReportV1, redactScanResultV1 } from "./redact-scan-report-v1";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { privacyReplaceReport, remediateReports } from "./remediate-reports-cli";
import { buildStaticReportShare } from "./report-locator";
import { prepareScanReportBundle, readStoredScanReportById, saveScanReport } from "./report-store";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { resetScanLimitStateForTests } from "./scan-limits";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import { makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import { buildRuntimeComparisonScanReportV2R2, buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { scanMeasurementEnvelopeWithR2Run } from "./scan-report-v2-runtime-fixtures";
import { writeV2ShadowArtifact } from "./scan-report-v2-shadow-store";
import { publicWireForExportOrPersistence, readScanTransportPayload, type LoadedReport } from "./scan-report-view";
import { isSeamVisit, refuseSeamOption, refuseSeamVisit, SEAM_VISIT_MARKER, SeamVisitRefusal } from "./seam-visit-mark";
import type { ScanSiteOptions } from "./scanner";
import { SCROLL_CHECK_DEADLINE_MARGIN_MS } from "./scroll-check";
import type { ScanReport, ScanResult } from "./types";

/**
 * The investigation seam without a browser: its description, what it
 * refuses, how its hooks are bounded and timed, the mark, and every place a
 * marked visit is refused, the v1 redactor among them. The visits with a
 * real page are in
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

const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";

afterEach(() => {
  delete process.env[PUBLIC_R2_REPORTS_ENV];
  delete process.env[BUILD_COMMIT_ENV];
  delete process.env[CONSENT_VERIFICATION_ENV];
  delete process.env[REPORT_STORE_DIR_ENV];
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

test("a boundary call the check awaited is timed and its error kept; one the check gave up on is neither, whatever it does later", async () => {
  const read = async (): Promise<FingerprintObservationCollection> => structuredClone(COLLECTION);
  const waiting = (): AbortController => new AbortController();
  const reads: FingerprintObservationCollection[] = [];
  // control-end is the callback the check gives up on: the test settles it later.
  let settleAbandoned = (): void => undefined;
  const open = openInvestigationSeam({
    scrollCheckBoundary: async (boundary, readFingerprint) => {
      if (boundary === "control-end") return new Promise<void>((resolve) => (settleAbandoned = resolve));
      if (boundary === "control-start") reads.push(await readFingerprint());
    }
  });
  assert.equal(open.hasScrollCheckBoundary, true);
  await open.scrollCheckBoundary("check-start", read, waiting().signal);
  await open.scrollCheckBoundary("control-start", read, waiting().signal);
  const gaveUp = waiting();
  const abandoned = open.scrollCheckBoundary("control-end", read, gaveUp.signal);
  // The check's deadline passes: it stops waiting, as its signal says.
  gaveUp.abort();
  await open.scrollCheckBoundary("scroll-end", read, waiting().signal);
  assert.deepEqual(reads, [COLLECTION]);
  const record = (): (readonly [string, string])[] => open.use().hookDurationsMs.scrollCheckBoundary.map((call) => [call.boundary, typeof call.ms] as const);
  const whenTheCheckReturned = [
    ["check-start", "number"],
    ["control-start", "number"],
    ["control-end", "object"],
    ["scroll-end", "number"]
  ];
  assert.deepEqual(record(), whenTheCheckReturned);
  assert.equal(open.use().hookDurationsMs.scrollCheckBoundary[2].ms, null);
  // The abandoned callback settles after all: the visit's record does not move.
  settleAbandoned();
  await abandoned;
  assert.deepEqual(record(), whenTheCheckReturned);
  assert.equal(open.use().hookDurationsMs.scrollCheckBoundary[2].ms, null);
  assert.doesNotThrow(() => open.rethrowBoundaryFailure());

  // A callback the check was still awaiting when it threw fails the visit.
  const thrown = new Error("the boundary hook threw");
  const failing = openInvestigationSeam({
    scrollCheckBoundary: (boundary) => {
      if (boundary === "control-start") throw thrown;
    }
  });
  await failing.scrollCheckBoundary("check-start", read, waiting().signal);
  await assert.rejects(failing.scrollCheckBoundary("control-start", read, waiting().signal), (error) => error === thrown);
  assert.throws(() => failing.rethrowBoundaryFailure(), (error) => error === thrown);

  // One the check had given up on does not, though it rejects before the
  // visit asks: a check that kept its outcome keeps it.
  let rejectAbandoned = (_error: Error): void => undefined;
  const late = openInvestigationSeam({ scrollCheckBoundary: () => new Promise<void>((_resolve, reject) => (rejectAbandoned = reject)) });
  const lateWaiting = waiting();
  const lateCall = late.scrollCheckBoundary("scroll-end", read, lateWaiting.signal);
  lateWaiting.abort();
  rejectAbandoned(new Error("late"));
  await assert.rejects(lateCall, /late/);
  assert.doesNotThrow(() => late.rethrowBoundaryFailure());
  assert.deepEqual(late.use().hookDurationsMs.scrollCheckBoundary, [{ boundary: "scroll-end", ms: null }]);

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
  assert.equal(result[SEAM_VISIT_MARKER], INVESTIGATION_SEAM_VERSION);
  assert.equal(measurement[SEAM_VISIT_MARKER], INVESTIGATION_SEAM_VERSION);
  assert.equal(Object.keys(result).includes(SEAM_VISIT_MARKER), true);
  assert.throws(() => {
    "use strict";
    delete result[SEAM_VISIT_MARKER];
  }, TypeError);
  assert.equal(SEAM_VISIT_MARKER in result, true);

  for (const marked of [envelope, envelope.result, envelope.measurement]) assert.equal(isSeamVisit(marked), true);
  // Identity alone is a mark: an envelope remembered as a seam visit's is
  // one, and so are its parts, with no key on any of them.
  const remembered = cleanEnvelope();
  openInvestigationSeam({}).markVisit(remembered);
  assert.equal(SEAM_VISIT_MARKER in remembered.result, false);
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

test("what the mark does not survive: a caller who removes it on purpose, by deleting the key from a copy or by rebuilding the result by hand", () => {
  // Nothing claims otherwise (docs/runtime-boundaries.md). These pin the two
  // limits, so a change to either is seen.
  const { envelope } = seamEnvelope();
  const marked = envelope.result;
  const stripped = { ...marked } as unknown as Record<string, unknown>;
  delete stripped[SEAM_VISIT_MARKER];
  assert.equal(isSeamVisit(stripped), false);
  assert.doesNotThrow(() => redactScanReportV1(stripped as unknown as ScanResult));
  // Rebuilt by hand, one named field at a time, before any refusal sees it:
  // a new object with no key, which nothing remembered. The redactor takes
  // it, as it takes any result. Handing the marked result to the redactor
  // itself no longer does this: the test below holds that it refuses.
  const rebuilt: ScanResult = {
    ok: marked.ok,
    schemaVersion: marked.schemaVersion,
    reportType: marked.reportType,
    summary: marked.summary,
    conditions: marked.conditions,
    requests: marked.requests,
    domains: marked.domains,
    cookies: marked.cookies,
    storage: marked.storage,
    fingerprintEvents: marked.fingerprintEvents,
    screenshot: marked.screenshot,
    warnings: marked.warnings
  };
  assert.equal(isSeamVisit(rebuilt), false);
  assert.equal(isSeamVisit(redactScanReportV1(rebuilt).report), false);
});

test("the v1 redactor refuses a seam visit's result and every copy of one before it reads anything of it", () => {
  const { envelope } = seamEnvelope();
  const clean = cleanEnvelope().result;
  const marked: [string, ScanResult][] = [["the visit's own result", envelope.result], ...COPIES.map(([what, copy]): [string, ScanResult] => [what, copy(envelope.result)])];
  for (const [what, result] of marked) {
    assert.throws(() => redactScanReportV1(result), isRefusal, what);
    assert.throws(() => redactScanResultV1(result), isRefusal, `${what}, handed over as one result`);
    assert.throws(() => redactScanReportV1(createGpcComparisonReport(result, clean)), isRefusal, `${what}, as the baseline`);
    assert.throws(() => redactScanReportV1(createGpcComparisonReport(clean, result)), isRefusal, `${what}, as the variant`);
  }
  // A report that carries the key itself, around two results that do not:
  // only the check at the report's own entry can refuse it.
  const aroundClean = { ...createGpcComparisonReport(clean, clean), [SEAM_VISIT_MARKER]: INVESTIGATION_SEAM_VERSION };
  assert.throws(() => redactScanReportV1(aroundClean), isRefusal);

  // Refused before anything is read: every field of this report records a
  // read, and none is recorded, whether it is marked in band or by identity.
  const reads: string[] = [];
  const recording = (): ScanResult => {
    const report = {} as Record<string, unknown>;
    for (const field of ["reportType", "requests", "cookies", "conditions", "warnings"]) {
      Object.defineProperty(report, field, {
        enumerable: false,
        get: () => {
          reads.push(field);
          return undefined;
        }
      });
    }
    return report as unknown as ScanResult;
  };
  const inBand = recording();
  Object.defineProperty(inBand, SEAM_VISIT_MARKER, { value: INVESTIGATION_SEAM_VERSION, enumerable: true });
  const byIdentity = recording();
  openInvestigationSeam({}).markVisit({ result: byIdentity, measurement: {} });
  for (const report of [inBand, byIdentity]) {
    assert.throws(() => redactScanReportV1(report), isRefusal);
    assert.throws(() => redactScanResultV1(report), isRefusal);
  }
  assert.deepEqual(reads, []);

  // A result no seam touched is sanitized as before, and names no seam.
  const sanitized = redactScanReportV1(clean);
  assert.deepEqual(sanitized, redactScanResultV1(clean));
  assert.equal(isSeamVisit(sanitized.report), false);
  assert.equal(JSON.stringify(sanitized).toLowerCase().includes("seam"), false);
  assert.equal(redactScanReportV1(createGpcComparisonReport(clean, clean)).report.reportType, "comparison");
});

test("a wait the visit abandons leaves nothing on the caller's signal once the visit releases its seam", async () => {
  const cancel = new AbortController();
  const open = openInvestigationSeam({ pageReady: NEVER, afterEnvelope: NEVER, afterEnvelopeTimeoutMs: MIN_AFTER_ENVELOPE_TIMEOUT_MS });
  // Two waits the visit stops waiting for, as when the scan deadline ends it.
  let settled = 0;
  for (const wait of [open.pageReady(PAGE, cancel.signal), open.afterEnvelope(READINGS, cancel.signal)]) {
    wait.then(
      () => (settled += 1),
      () => (settled += 1)
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(cancel.signal, "abort").length, 2);
  open.release();
  assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
  // The timer went with the listener: the bound does not fire afterwards.
  await new Promise((resolve) => setTimeout(resolve, MIN_AFTER_ENVELOPE_TIMEOUT_MS + 300));
  assert.equal(settled, 0);
  // A wait that ended on its own has already taken its listener off.
  const done = openInvestigationSeam({ pageReady: () => undefined });
  await done.pageReady(PAGE, cancel.signal);
  assert.equal(getEventListeners(cancel.signal, "abort").length, 0);
  done.release();
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

// A JSON copy of a seam visit's result, as a private runner would write one
// beside its capture, and a stored report that carries the key. Each reader
// declines it with its declared outcome, and none throws.

const REPORT_ID = `20261110-${"a".repeat(32)}`;
const WRITTEN_AT = "2026-11-10T12:00:00.000Z";
const OTHER_REPORT_ID = `20261110-${"c".repeat(32)}`;

test("the v1 public projector refuses a seam visit's result and every copy of one, so the export boundary does too", () => {
  const { envelope } = seamEnvelope();
  const clean = cleanEnvelope().result;
  const marked: [string, ScanResult][] = [["the visit's own result", envelope.result], ...COPIES.map(([what, copy]): [string, ScanResult] => [what, copy(envelope.result)])];
  for (const [what, result] of marked) {
    assert.throws(() => toPublicScanReportV1(result), isRefusal, what);
    assert.throws(() => toPublicScanReportV1(createGpcComparisonReport(result, clean)), isRefusal, `${what}, as the baseline`);
    assert.throws(() => toPublicScanReportV1(createGpcComparisonReport(clean, result)), isRefusal, `${what}, as the variant`);
    // The boundary every download, the publish CLI and both acquirers
    // serialize through, handed a loaded v1 report that is one.
    const loaded = { source: "v1", wire: result, view: {} } as unknown as LoadedReport;
    assert.throws(() => publicWireForExportOrPersistence(loaded), isRefusal, `${what}, at the export boundary`);
  }
  // A result no seam touched is projected as before, and the store takes it.
  const projected = toPublicScanReportV1(clean);
  assert.equal(isSeamVisit(projected), false);
  assert.doesNotThrow(() => prepareScanReportBundle(projected));
  assert.deepEqual(publicWireForExportOrPersistence({ source: "v1", wire: clean, view: {} } as unknown as LoadedReport), projected);
});

test("both readers decline a payload that carries the mark, also inside a job envelope and on an arm, and neither throws", async () => {
  const { envelope } = seamEnvelope();
  const clean = cleanEnvelope().result;
  const copy = JSON.parse(JSON.stringify(envelope.result)) as ScanResult;
  // A mark on one member of one arm: not on the comparison, not on the arm.
  const armMember = createGpcComparisonReport(clean, clean) as unknown as { baseline: { summary: Record<string, unknown> } };
  armMember.baseline = { ...armMember.baseline, summary: { ...armMember.baseline.summary, [SEAM_VISIT_MARKER]: 1 } };
  const payloads: [string, unknown][] = [
    ["the visit's own result", envelope.result],
    ...COPIES.map(([what, make]): [string, unknown] => [what, make(envelope.result)]),
    ["a comparison that holds a copy", createGpcComparisonReport(copy, clean)],
    ["a comparison with the key on one member of one arm", armMember],
    ["a result with the key on one member", { ...clean, summary: { ...clean.summary, [SEAM_VISIT_MARKER]: null } }]
  ];
  for (const [what, payload] of payloads) {
    assert.deepEqual(readStoredScanReport(payload), { ok: false, error: "invalid" }, what);
    assert.deepEqual(readScanTransportPayload(payload), { kind: "unreadable", error: "invalid" }, what);
    // The job envelope a finished scan is polled in, around the same payload.
    assert.deepEqual(readScanTransportPayload({ status: "succeeded", jobId: "job", report: payload }), { kind: "unreadable", error: "invalid" }, `${what}, in a job envelope`);
  }
  // The reader the viewer opens a file with gives a declared answer, in
  // words. Its own preflight turns away an inline screenshot first, which a
  // result as a runner would write it has, so the same file is also opened
  // without one: what is declined then is the key.
  const NOT_A_REPORT = { ok: false, message: "This file is not a Site Behavior Lab report (or its data is damaged)." };
  const bare = (result: ScanResult): ScanResult => ({ ...result, screenshot: null });
  assert.equal((await readLoadedReport(copy)).ok, false);
  assert.deepEqual(await readLoadedReport(bare(copy)), NOT_A_REPORT);
  assert.deepEqual(await readLoadedReport({ status: "succeeded", jobId: "job", report: bare(copy) }), NOT_A_REPORT);
  assert.deepEqual(await readLoadedReport(createGpcComparisonReport(bare(copy), bare(clean))), NOT_A_REPORT);
  assert.equal((await readLoadedReport(bare(clean))).ok, true);
  assert.equal((await readLoadedReport(createGpcComparisonReport(bare(clean), bare(clean)))).ok, true);
  // An envelope that carries the key itself is declined before its report is read.
  assert.deepEqual(readScanTransportPayload({ status: "succeeded", report: clean, [SEAM_VISIT_MARKER]: "x" }), { kind: "unreadable", error: "invalid" });
  // The same payloads without the key are read as before.
  const ordinary = readScanTransportPayload(JSON.parse(JSON.stringify(clean)));
  assert.equal(ordinary.kind, "report");
  assert.equal(readScanTransportPayload({ status: "succeeded", jobId: "job", report: clean }).kind, "report");
  assert.equal(readStoredScanReport(createGpcComparisonReport(clean, clean)).ok, true);
});

/** A stored v1 report and its sidecar, valid but for what `tamper` adds. */
function storedPair(tamper: (report: Record<string, unknown>) => void): { wire: string; sidecar: string; createdAt: string } {
  const good = { ...toPublicScanReportV1(cleanEnvelope().result), share: buildStaticReportShare(REPORT_ID) } as ScanReport;
  const read = readStoredScanReport(good);
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("the fixture is not a report");
  const createdAt = committedReportCreatedAt(read.stored);
  const tampered = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  tamper(tampered);
  const wire = `${JSON.stringify(tampered, null, 2)}\n`;
  const sidecar = `${JSON.stringify(buildProvenanceEntry({ reportId: REPORT_ID, publicReport: tampered, writtenAt: WRITTEN_AT, createdAt, expiresAt: null }), null, 2)}\n`;
  return { wire, sidecar, createdAt };
}

const STORED_WITH_KEY: readonly (readonly [string, (report: Record<string, unknown>) => void])[] = [
  ["the key on the report", (report) => void (report[SEAM_VISIT_MARKER] = "investigation-seam@1")],
  ["the key on its summary", (report) => void ((report.summary as Record<string, unknown>)[SEAM_VISIT_MARKER] = 1)],
  ["the key on its conditions", (report) => void ((report.conditions as Record<string, unknown>)[SEAM_VISIT_MARKER] = null)]
];

test("a stored report that carries the key is a declared failure that names the report, in the managed reader and in remediation", async () => {
  for (const [what, tamper] of STORED_WITH_KEY) {
    const { wire, sidecar, createdAt } = storedPair(tamper);
    assert.deepEqual(
      readManagedReport({ reportId: REPORT_ID, reportContents: wire, sidecarContents: sidecar, retention: { createdAt, expiresAt: null } }),
      { ok: false, error: "invalid", reason: "invalid-report" },
      what
    );
    assert.deepEqual(
      planR2ReportRemediation({
        reportId: REPORT_ID,
        reportContents: wire,
        sidecarContents: sidecar,
        retentionSource: { kind: "metadata", retention: { createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString() } },
        writtenAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString(),
        now: new Date(Date.parse(createdAt) + 3_600_000).toISOString()
      }),
      { ok: false, reportId: REPORT_ID, issue: "invalid-report", detail: "invalid" },
      what
    );
    // The committed corpus's own remediation names the file it stops at.
    const reportsDir = mkdtempSync(path.join(tmpdir(), "sbl-seam-remediate-"));
    try {
      writeFileSync(path.join(reportsDir, `${REPORT_ID}.json`), wire);
      writeFileSync(path.join(reportsDir, committedSidecarFilename(REPORT_ID)), sidecar);
      await assert.rejects(
        remediateReports({ reportsDir, writtenAt: WRITTEN_AT }),
        (error) => error instanceof Error && !(error instanceof SeamVisitRefusal) && error.message === `Cannot remediate ${REPORT_ID}.json: unreadable report (invalid).`,
        what
      );
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
    }
  }
  // What the fixture is without the key, and with a key of another name: the
  // answers these readers gave before, so the decline is the key's alone.
  const good = storedPair(() => undefined);
  assert.equal(readManagedReport({ reportId: REPORT_ID, reportContents: good.wire, sidecarContents: good.sidecar, retention: { createdAt: good.createdAt, expiresAt: null } }).ok, true);
  const other = storedPair((report) => void (report.somethingElse = "x"));
  const otherRead = readManagedReport({ reportId: REPORT_ID, reportContents: other.wire, sidecarContents: other.sidecar, retention: { createdAt: other.createdAt, expiresAt: null } });
  assert.deepEqual([otherRead.ok, otherRead.ok ? null : otherRead.reason], [false, "redaction-not-idempotent"]);
});

/**
 * Where the key was put in a stored v1 report, and what each function that
 * reads a stored report must answer. `declined` is where the readers' check
 * looks. `refused` is the three shapes the readers pass and the sanitizer
 * still refuses, because it makes the same check again on each arm of a
 * comparison. `kept` is deeper than either looks: an unknown member, which
 * the sanitizer drops, so the stored bytes are no fixed point.
 */
const KEY_POSITIONS: readonly (readonly ["single" | "comparison", readonly string[], "declined" | "refused" | "kept" | "none"])[] = [
  ["single", [SEAM_VISIT_MARKER], "declined"],
  ["single", ["summary", SEAM_VISIT_MARKER], "declined"],
  ["single", ["conditions", "device", SEAM_VISIT_MARKER], "kept"],
  ["single", ["baseline", "x", SEAM_VISIT_MARKER], "declined"],
  ["single", ["extra", "x", SEAM_VISIT_MARKER], "kept"],
  ["comparison", [SEAM_VISIT_MARKER], "declined"],
  ["comparison", ["baseline", SEAM_VISIT_MARKER], "declined"],
  ["comparison", ["variant", "summary", SEAM_VISIT_MARKER], "declined"],
  ["comparison", ["diff", SEAM_VISIT_MARKER], "declined"],
  ["comparison", ["baseline", "conditions", "device", SEAM_VISIT_MARKER], "kept"],
  ["comparison", ["baseline", "baseline", "x", SEAM_VISIT_MARKER], "refused"],
  ["comparison", ["variant", "variant", "x", SEAM_VISIT_MARKER], "refused"],
  ["comparison", ["baseline", "variant", "x", SEAM_VISIT_MARKER], "refused"],
  ["comparison", ["baseline", "extra", SEAM_VISIT_MARKER], "declined"],
  ["single", [], "none"],
  ["comparison", [], "none"]
];

/** A stored v1 report of one kind with the key set at a path (members made on the way), and its sidecar. */
function storedWithKeyAt(kind: "single" | "comparison", keyPath: readonly string[]): { wire: string; sidecar: string; createdAt: string; parsed: () => unknown } {
  const clean = cleanEnvelope().result;
  const good = { ...toPublicScanReportV1(kind === "single" ? clean : createGpcComparisonReport(clean, clean)), share: buildStaticReportShare(REPORT_ID) };
  const read = readStoredScanReport(good);
  if (!read.ok) throw new Error("the fixture is not a report");
  const createdAt = committedReportCreatedAt(read.stored);
  const tampered = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  let at = tampered;
  for (const [index, key] of keyPath.entries()) {
    if (index === keyPath.length - 1) at[key] = 1;
    else at = (at[key] ??= {}) as Record<string, unknown>;
  }
  const wire = `${JSON.stringify(tampered, null, 2)}\n`;
  const sidecar = `${JSON.stringify(buildProvenanceEntry({ reportId: REPORT_ID, publicReport: tampered, writtenAt: WRITTEN_AT, createdAt, expiresAt: null }), null, 2)}\n`;
  return { wire, sidecar, createdAt, parsed: () => JSON.parse(wire) as unknown };
}

test("wherever the key sits in a stored report, no function that reads one throws, and each gives its declared answer for that report", async () => {
  assert.equal(KEY_POSITIONS.length, 16);
  const seen = { declined: 0, refused: 0, kept: 0, none: 0 };
  for (const [kind, keyPath, expected] of KEY_POSITIONS) {
    const what = `${kind}: ${keyPath.join(".") || "no key"}`;
    seen[expected] += 1;
    const { wire, sidecar, createdAt, parsed } = storedWithKeyAt(kind, keyPath);
    const answer = <T>(step: string, run: () => T): T => {
      try {
        return run();
      } catch (error) {
        throw new assert.AssertionError({ message: `${step} threw for ${what}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` });
      }
    };

    // The two readers decline where their check looks, and pass the rest.
    const stored = answer("the stored reader", () => readStoredScanReport(parsed()));
    const transport = answer("the transport reader", () => readScanTransportPayload(parsed()));
    const inJob = answer("the transport reader, in a job envelope", () => readScanTransportPayload({ status: "succeeded", jobId: "job", report: parsed() }));
    if (expected === "declined") {
      assert.deepEqual(stored, { ok: false, error: "invalid" }, what);
      assert.deepEqual(transport, { kind: "unreadable", error: "invalid" }, what);
      assert.deepEqual(inJob, { kind: "unreadable", error: "invalid" }, what);
    } else {
      assert.equal(stored.ok, true, what);
      assert.equal(transport.kind, "report", what);
      assert.equal(inJob.kind, "report", what);
    }

    // The managed reader: not a report where a reader declines or the
    // sanitizer refuses; no fixed point where the key is only dropped.
    const managed = answer("the managed reader", () =>
      readManagedReport({ reportId: REPORT_ID, reportContents: wire, sidecarContents: sidecar, retention: { createdAt, expiresAt: null } })
    );
    if (expected === "none") assert.equal(managed.ok, true, what);
    else if (expected === "kept") assert.deepEqual([managed.ok, managed.ok ? null : managed.reason], [false, "redaction-not-idempotent"], what);
    else assert.deepEqual(managed, { ok: false, error: "invalid", reason: "invalid-report" }, what);

    // The remediation plan names the report it stops at.
    const plan = answer("the remediation plan", () =>
      planR2ReportRemediation({
        reportId: REPORT_ID,
        reportContents: wire,
        sidecarContents: sidecar,
        retentionSource: { kind: "metadata", retention: { createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString() } },
        writtenAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString(),
        now: new Date(Date.parse(createdAt) + 3_600_000).toISOString()
      })
    );
    if (expected === "declined" || expected === "refused") assert.deepEqual(plan, { ok: false, reportId: REPORT_ID, issue: "invalid-report", detail: "invalid" }, what);
    else assert.deepEqual([plan.ok, plan.reportId], [true, REPORT_ID], what);

    // The privacy-replacement plan is made from what the stored reader
    // returned, so it is reached only for a report that reader passed.
    if (stored.ok && stored.stored.schemaVersion === 1) {
      const original = stored.stored.report;
      const replacement = answer("the privacy-replacement plan", () => planPrivacyReplacement(original, OTHER_REPORT_ID));
      if (expected === "refused") assert.deepEqual(replacement, { ok: false, issue: "invalid-report", detail: "invalid" }, what);
      else assert.deepEqual([replacement.ok, replacement.ok ? replacement.replacement.share?.id : null], [true, OTHER_REPORT_ID], what);
    }

    // The committed corpus's own remediation run stops at the file, by name,
    // for a shape the sanitizer refuses as for one a reader declines.
    if (expected === "declined" || expected === "refused") {
      const reportsDir = mkdtempSync(path.join(tmpdir(), "sbl-seam-positions-"));
      try {
        writeFileSync(path.join(reportsDir, `${REPORT_ID}.json`), wire);
        writeFileSync(path.join(reportsDir, committedSidecarFilename(REPORT_ID)), sidecar);
        await assert.rejects(
          remediateReports({ reportsDir, writtenAt: WRITTEN_AT }),
          (error) => error instanceof Error && !(error instanceof SeamVisitRefusal) && error.message === `Cannot remediate ${REPORT_ID}.json: unreadable report (invalid).`,
          what
        );
        // The privacy replacement run names the report too. It reads through
        // the stored reader and then the managed reader, so it stops at
        // whichever declines first and never reaches its plan.
        const stopsAt = expected === "declined" ? "unreadable report (invalid)" : "its committed bundle is not an attested current pair (invalid-report)";
        await assert.rejects(
          privacyReplaceReport({ reportsDir, reportId: REPORT_ID, writtenAt: WRITTEN_AT, _testReplacementReportId: OTHER_REPORT_ID }),
          (error) => error instanceof Error && !(error instanceof SeamVisitRefusal) && error.message === `Cannot replace ${REPORT_ID} for privacy: ${stopsAt}.`,
          what
        );
        assert.deepEqual(readdirSync(reportsDir).sort(), [committedSidecarFilename(REPORT_ID), `${REPORT_ID}.json`].sort(), `${what}: a run that stopped left something behind`);
      } finally {
        rmSync(reportsDir, { recursive: true, force: true });
      }
    }
  }
  assert.deepEqual(seen, { declined: 8, refused: 3, kept: 3, none: 2 });

  // The three shapes are what this test is for: the sanitizer does refuse
  // each, so the answers above came from the callers, not from a sanitizer
  // that let them through.
  for (const [kind, keyPath, expected] of KEY_POSITIONS) {
    if (expected !== "refused") continue;
    assert.throws(() => redactScanReportV1(storedWithKeyAt(kind, keyPath).parsed() as ScanReport), isRefusal, keyPath.join("."));
  }
  // Anything else the sanitizer throws is still thrown: the callers turn the
  // seam's refusal into their declared failure, and nothing more.
  const broken = { get conditions(): never { throw new RangeError("not the seam's refusal"); } } as unknown as ScanReport;
  assert.throws(() => planPrivacyReplacement(broken, OTHER_REPORT_ID), RangeError);
});

test("the report store answers unreadable for a stored report that gained the key, and does not throw", async () => {
  const storeDir = mkdtempSync(path.join(tmpdir(), "sbl-seam-store-"));
  process.env[REPORT_STORE_DIR_ENV] = storeDir;
  try {
    const saved = await saveScanReport(cleanEnvelope().result);
    const id = saved.share?.id;
    assert.ok(id);
    assert.equal((await readStoredScanReportById(id)).outcome, "found");
    const file = readdirSync(storeDir, { recursive: true }).map(String).find((name) => name.endsWith(`${id}.json`));
    assert.ok(file, `the stored report was not found under ${storeDir}`);
    const stored = JSON.parse(readFileSync(path.join(storeDir, file), "utf8")) as Record<string, unknown>;
    stored[SEAM_VISIT_MARKER] = "investigation-seam@1";
    writeFileSync(path.join(storeDir, file), `${JSON.stringify(stored, null, 2)}\n`);
    assert.deepEqual(await readStoredScanReportById(id), { outcome: "unreadable", error: "invalid" });
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test("the publish CLI refuses a JSON copy of a seam visit's result, exits non-zero and writes nothing", () => {
  const { envelope } = seamEnvelope();
  const cli = path.join(__dirname, "publish-scan-report-cli.js");
  const publish = (input: unknown): { status: number | null; stderr: string; written: string[] } => {
    const dir = mkdtempSync(path.join(tmpdir(), "sbl-seam-publish-"));
    try {
      const inputPath = path.join(dir, "input.json");
      const outDir = path.join(dir, "out");
      writeFileSync(inputPath, JSON.stringify(input, null, 2));
      const run = spawnSync(process.execPath, [cli, inputPath, path.join(outDir, `${REPORT_ID}.json`), REPORT_ID], { encoding: "utf8" });
      return { status: run.status, stderr: run.stderr, written: existsSync(outDir) ? readdirSync(outDir) : [] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const [what, input] of [
    ["a JSON copy of the result", envelope.result],
    ["the copy in a finished job's envelope", { status: "succeeded", jobId: "job", report: envelope.result }]
  ] as const) {
    const refused = publish(input);
    assert.equal(refused.status, 1, `${what}: ${refused.stderr}`);
    assert.equal(refused.stderr.trim(), "Refusing to publish: the scan result is not a readable report (invalid).", what);
    assert.deepEqual(refused.written, [], what);
  }
  // The same CLI publishes the same result when no seam marked it.
  const published = publish(cleanEnvelope().result);
  assert.equal(published.status, 0, published.stderr);
  assert.deepEqual(published.written.sort(), [committedSidecarFilename(REPORT_ID), `${REPORT_ID}.json`].sort());
});

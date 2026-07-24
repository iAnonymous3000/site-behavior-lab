import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSER_REPORT_COLLECTION_LIMITS,
  hasBrowserSafeReportCollections
} from "./client-report-resource-policy";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { NODE_R2_PUBLIC_LIMITS } from "./scan-report-v2-r2-producer-contract";
import { readStoredScanReport } from "./scan-report-reader";
import { parseStrictJson } from "./strict-json";
import {
  makePublicSingleReportV2,
  makeScanReportV1
} from "./scan-report-v2-fixtures";
import {
  makePublicSingleReportV2R2,
  makeSupportingPairInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";

type AnyRecord = Record<string, any>;

function assertUnderBrowserWireCap(payload: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  assert.ok(bytes < BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES, `fixture unexpectedly used ${bytes} bytes`);
}

test("browser report limits stay pinned to the active r2 producer ceilings", () => {
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.phases, NODE_R2_PUBLIC_LIMITS.phases);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.warnings, NODE_R2_PUBLIC_LIMITS.warnings);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.requests, NODE_R2_PUBLIC_LIMITS.requests);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.cookieMutations, NODE_R2_PUBLIC_LIMITS.cookieMutations);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.cookies, NODE_R2_PUBLIC_LIMITS.cookieRecords);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.storageMutations, NODE_R2_PUBLIC_LIMITS.storageMutations);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.storage, NODE_R2_PUBLIC_LIMITS.storageRecords);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.fingerprintEvents, NODE_R2_PUBLIC_LIMITS.fingerprintEvents);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.fingerprintDetections, NODE_R2_PUBLIC_LIMITS.fingerprintDetections);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.cnameCloaks, NODE_R2_PUBLIC_LIMITS.cnameCloaks);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.pixelEvents, NODE_R2_PUBLIC_LIMITS.pixelEvents);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.consentObservations, NODE_R2_PUBLIC_LIMITS.consentObservations);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.policyClaims, NODE_R2_PUBLIC_LIMITS.policyClaims);
  assert.equal(BROWSER_REPORT_COLLECTION_LIMITS.policyEntities, NODE_R2_PUBLIC_LIMITS.policyEntities);
});

test("version-aware preflight rejects compact v2-r1 and r2 evidence amplification", () => {
  for (const payload of [makePublicSingleReportV2(), makePublicSingleReportV2R2()]) {
    const draft = structuredClone(payload) as unknown as AnyRecord;
    const request = draft.run.evidence.requests[0] ?? {
      id: 1,
      url: "https://x.test/a",
      domain: "x.test",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      tracker: null,
      startedAtMs: 1,
      phaseId: 0
    };
    draft.run.evidence.requests = Array.from(
      { length: BROWSER_REPORT_COLLECTION_LIMITS.requests + 1 },
      () => request
    );
    assertUnderBrowserWireCap(draft);
    assert.equal(hasBrowserSafeReportCollections(draft), false);
  }
});

test("r2 supporting pairs and nested comparison diff arrays have independent caps", () => {
  const supporting = makeSupportingPairInterventionReportV2R2() as unknown as AnyRecord;
  supporting.experiment.supportingPairs = [
    supporting.experiment.supportingPairs[0],
    structuredClone(supporting.experiment.supportingPairs[0])
  ];
  assertUnderBrowserWireCap(supporting);
  assert.equal(hasBrowserSafeReportCollections(supporting), false);

  const diff = makeSupportingPairInterventionReportV2R2() as unknown as AnyRecord;
  diff.diff.families["tracker-classification"].addedTrackerDomains = Array.from(
    { length: BROWSER_REPORT_COLLECTION_LIMITS.diffTrackerDomains + 1 },
    (_, index) => `tracker-${index}.test`
  );
  assertUnderBrowserWireCap(diff);
  assert.equal(hasBrowserSafeReportCollections(diff), false);
});

test("v1 also receives a pre-validation total collection budget", () => {
  const payload = makeScanReportV1() as unknown as AnyRecord;
  payload.extra = Array.from({ length: BROWSER_REPORT_COLLECTION_LIMITS.maxAnyArray + 1 }, () => 0);
  assertUnderBrowserWireCap(payload);
  assert.equal(hasBrowserSafeReportCollections(payload), false);
});

test("a compact huge-key object is refused before an attacker-sized values allocation", () => {
  const payload = makeScanReportV1() as unknown as AnyRecord;
  payload.extra = Object.fromEntries(
    Array.from({ length: 100_000 }, (_, index) => [`k${index}`, 0])
  );
  assertUnderBrowserWireCap(payload);
  assert.equal(hasBrowserSafeReportCollections(payload), false);
});

test("multi-megabyte render strings are refused while a real bounded screenshot remains admissible", () => {
  const payload = makeScanReportV1() as unknown as AnyRecord;
  payload.warnings = ["w".repeat(2 * 1024 * 1024)];
  assertUnderBrowserWireCap(payload);
  assert.equal(hasBrowserSafeReportCollections(payload), false);

  const screenshot = makeScanReportV1() as unknown as AnyRecord;
  screenshot.screenshot =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(hasBrowserSafeReportCollections(screenshot), true);
});

test("image-looking screenshot strings must pass the bounded decoder preflight", () => {
  for (const value of [
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,AAAA",
    "data:image/webp;base64,AAAA",
    "https://attacker.test/screenshot.png"
  ]) {
    const payload = makeScanReportV1() as unknown as AnyRecord;
    payload.screenshot = value;
    assert.equal(hasBrowserSafeReportCollections(payload), false, value);
  }
});

test("a structurally and semantically valid report at the request ceiling remains admissible", () => {
  const payload = makePublicSingleReportV2R2();
  const request = payload.run.evidence.requests[0];
  payload.run.evidence.requests = Array.from(
    { length: BROWSER_REPORT_COLLECTION_LIMITS.requests },
    (_, index) => ({ ...request, id: index + 1 })
  );
  payload.run.summary.counts.totalRequests = BROWSER_REPORT_COLLECTION_LIMITS.requests;
  payload.run.summary.countsByPhase[0].totalRequests = BROWSER_REPORT_COLLECTION_LIMITS.requests;

  const parsed = parseStrictJson(JSON.stringify(payload));
  assertUnderBrowserWireCap(parsed);
  assert.equal(hasBrowserSafeReportCollections(parsed), true);
  assert.equal(readStoredScanReport(parsed).ok, true);
});

test("strict JSON yields own plain data properties and exotic graphs fail closed", () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true},"schemaVersion":1}') as AnyRecord;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(({} as AnyRecord).polluted, undefined);
  assert.equal(hasBrowserSafeReportCollections(parsed), true);

  const inherited = Object.create(Object.defineProperty({}, "inherited", {
    enumerable: true,
    get() {
      throw new Error("must not enumerate inherited accessors");
    }
  })) as AnyRecord;
  inherited.schemaVersion = 1;
  assert.doesNotThrow(() => hasBrowserSafeReportCollections(inherited));
  assert.equal(hasBrowserSafeReportCollections(inherited), false);

  const proxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("proxy trap");
    }
  });
  assert.doesNotThrow(() => hasBrowserSafeReportCollections(proxy));
  assert.equal(hasBrowserSafeReportCollections(proxy), false);
});

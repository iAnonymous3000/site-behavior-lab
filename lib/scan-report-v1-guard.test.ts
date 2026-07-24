/**
 * Guard-level regressions for the frozen v1 read path. The deep guard exists to
 * reject malformed uploads before the projector dereferences them, but it must
 * not turn an honest observation into "invalid": that error is indistinguishable
 * from corrupt bytes and permanently 500s a stored permalink.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_V1_EVIDENCE_LIMITS, deepValidateScanReportV1 } from "./scan-report-v1-guard";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { MAX_RECORDED_REQUESTS } from "./scan-runtime";
import { NODE_R2_PUBLIC_LIMITS } from "./scan-report-v2-r2-producer-contract";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";
import { createGpcComparisonReport } from "./compare-reports";
import type { ScanReport, ScanResult } from "./types";

type AnyRecord = Record<string, any>;

function makeRun(apply: (draft: AnyRecord) => void = () => {}): ScanReport {
  const draft = makeScanReportV1() as unknown as AnyRecord;
  apply(draft);
  return draft as unknown as ScanReport;
}

/** One recorded request plus the domain row and counts it implies. */
function withRequest(draft: AnyRecord, status: number | null): void {
  draft.requests = [
    {
      id: 1,
      url: "https://tracker.example/pixel",
      domain: "tracker.example",
      method: "GET",
      resourceType: "image",
      status,
      thirdParty: true,
      tracker: null,
      startedAtMs: 12
    }
  ];
  draft.domains = [
    {
      domain: "tracker.example",
      requests: 1,
      thirdParty: true,
      tracker: null,
      blockedByShields: false,
      statuses: status === null ? [] : [status],
      resourceTypes: ["image"]
    }
  ];
  draft.summary.totalRequests = 1;
  draft.summary.thirdPartyRequests = 1;
  draft.summary.thirdPartyDomains = 1;
}

test("v1 accepts the whole three-digit status grammar, not just 1xx-5xx", () => {
  // LinkedIn answers 999 and assorted WAFs answer other 9xx codes; recording
  // one is honest evidence, so the guard must not call the report damaged.
  for (const status of [100, 200, 451, 599, 600, 799, 999]) {
    assert.equal(deepValidateScanReportV1(makeRun((draft) => (draft.summary.status = status))), true, `summary ${status}`);
    assert.equal(deepValidateScanReportV1(makeRun((draft) => withRequest(draft, status))), true, `request ${status}`);
  }

  // A status is still an observation of a response, so "no response" stays null.
  assert.equal(deepValidateScanReportV1(makeRun((draft) => (draft.summary.status = null))), true);
  assert.equal(deepValidateScanReportV1(makeRun((draft) => withRequest(draft, null))), true);
});

test("v1 still rejects status shapes no server can send", () => {
  for (const status of [99, 1000, -1, 0, 12.5, Number.NaN, "200"]) {
    assert.equal(
      deepValidateScanReportV1(makeRun((draft) => (draft.summary.status = status))),
      false,
      `summary ${String(status)}`
    );
    assert.equal(
      deepValidateScanReportV1(makeRun((draft) => withRequest(draft, status as number))),
      false,
      `request ${String(status)}`
    );
  }

  // The domain table's status vocabulary is guarded on the same grammar.
  assert.equal(
    deepValidateScanReportV1(
      makeRun((draft) => {
        withRequest(draft, 200);
        draft.domains[0].statuses = [200, 1000];
      })
    ),
    false
  );
  assert.equal(
    deepValidateScanReportV1(
      makeRun((draft) => {
        withRequest(draft, 200);
        draft.domains[0].statuses = [200, 200];
      })
    ),
    false,
    "statuses remain a set"
  );
});

test("v1 still rejects the malformed uploads the deep guard was added for", () => {
  const malformed: Array<[string, (draft: AnyRecord) => void]> = [
    ["null request entry", (draft) => (draft.requests = [null])],
    ["cookie without a name", (draft) => (draft.cookies = [{ domain: "example.com" }])],
    ["negative storage size", (draft) => (draft.storage = [{ area: "localStorage", key: "k", valueBytes: -1 }])],
    ["unknown storage area", (draft) => (draft.storage = [{ area: "cookieJar", key: "k", valueBytes: 1 }])],
    ["missing conditions", (draft) => delete draft.conditions],
    ["zero viewport", (draft) => (draft.conditions.viewport.width = 0)],
    ["free-text consent mode", (draft) => (draft.conditions.consentMode = "whatever")]
  ];
  for (const [label, apply] of malformed) {
    assert.equal(deepValidateScanReportV1(makeRun(apply)), false, label);
  }
});

test("browser v1 collection ceilings stay pinned to active producer limits", () => {
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.requests, MAX_RECORDED_REQUESTS);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.requests, NODE_R2_PUBLIC_LIMITS.requests);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.cookies, NODE_R2_PUBLIC_LIMITS.cookieRecords);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.storage, NODE_R2_PUBLIC_LIMITS.storageRecords);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.fingerprintEvents, NODE_R2_PUBLIC_LIMITS.fingerprintEvents);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.fingerprintDetections, NODE_R2_PUBLIC_LIMITS.fingerprintDetections);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.cnameCloaks, NODE_R2_PUBLIC_LIMITS.cnameCloaks);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.pixelEvents, NODE_R2_PUBLIC_LIMITS.pixelEvents);
  assert.equal(BROWSER_V1_EVIDENCE_LIMITS.warnings, NODE_R2_PUBLIC_LIMITS.warnings);
});

test("an under-8MiB v1 upload cannot carry an attacker-sized request collection", () => {
  const draft = makeRun() as unknown as AnyRecord;
  const request = {
    id: 1,
    url: "https://x.test/a",
    domain: "x.test",
    method: "GET",
    resourceType: "image",
    status: 200,
    thirdParty: true,
    tracker: null,
    startedAtMs: 1
  };
  draft.requests = Array.from({ length: 20_000 }, () => request);
  const wireBytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength;
  assert.ok(wireBytes < BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES, `fixture unexpectedly used ${wireBytes} bytes`);
  assert.equal(deepValidateScanReportV1(draft as ScanReport), false);
});

test("an under-8MiB v1 comparison cannot amplify its independently supplied diff arrays", () => {
  const run = makeScanReportV1() as AnyRecord;
  const comparison = createGpcComparisonReport(
    structuredClone(run) as ScanResult,
    structuredClone(run) as ScanResult
  ) as unknown as AnyRecord;
  const change = { domain: "x.test", requests: 1, tracker: null };
  comparison.diff.addedDomains = Array.from(
    { length: BROWSER_V1_EVIDENCE_LIMITS.diffDomains + 1 },
    () => change
  );
  const wireBytes = new TextEncoder().encode(JSON.stringify(comparison)).byteLength;
  assert.ok(wireBytes < BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES, `fixture unexpectedly used ${wireBytes} bytes`);
  assert.equal(deepValidateScanReportV1(comparison as ScanReport), false);
});

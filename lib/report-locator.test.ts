import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportShare, committedReportLocation, locateReport } from "./report-locator";

const VALID_ID = "20260619-1cae9eb5a7b2fae0d49af5acda78031b";

test("buildReportShare produces the canonical path scheme", () => {
  assert.deepEqual(buildReportShare(VALID_ID), {
    id: VALID_ID,
    path: `/reports/${VALID_ID}`,
    jsonPath: `/api/reports/${VALID_ID}`
  });
});

test("buildReportShare rejects malformed ids", () => {
  assert.throws(() => buildReportShare("not-a-real-id"), /Invalid report share id/);
});

test("locateReport serves Node reports from the API route with a permalink", () => {
  assert.deepEqual(locateReport(VALID_ID, { staticExport: false, liveApiBacked: false, basePath: "" }), {
    id: VALID_ID,
    backend: "node-api",
    pagePath: `/reports/${VALID_ID}`,
    dataUrl: `/api/reports/${VALID_ID}`
  });
});

test("locateReport serves committed static reports from the static file with a prefixed permalink", () => {
  assert.deepEqual(locateReport(VALID_ID, { staticExport: true, liveApiBacked: false, basePath: "/site-behavior-lab" }), {
    id: VALID_ID,
    backend: "static-file",
    pagePath: `/site-behavior-lab/reports/${VALID_ID}/`,
    dataUrl: `/site-behavior-lab/reports/${VALID_ID}.json`
  });
});

test("locateReport withholds a permalink when a static export is backed by a live API", () => {
  const locator = locateReport(VALID_ID, { staticExport: true, liveApiBacked: true, basePath: "" });
  assert.equal(locator.backend, "live-api-unshareable");
  assert.equal(locator.pagePath, null);
  // The JSON path still resolves to the static file convention; it simply will
  // not exist for a fresh API-only report, which is why no permalink is offered.
  assert.equal(locator.dataUrl, `/reports/${VALID_ID}.json`);
});

test("committedReportLocation always resolves a servable page for committed artifacts", () => {
  assert.deepEqual(committedReportLocation(VALID_ID, { staticExport: false, liveApiBacked: false, basePath: "" }), {
    backend: "node-api",
    pagePath: `/reports/${VALID_ID}`,
    dataUrl: `/api/reports/${VALID_ID}`
  });

  assert.deepEqual(committedReportLocation(VALID_ID, { staticExport: true, liveApiBacked: true, basePath: "/site-behavior-lab" }), {
    backend: "static-file",
    pagePath: `/site-behavior-lab/reports/${VALID_ID}/`,
    dataUrl: `/site-behavior-lab/reports/${VALID_ID}.json`
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  REPORT_READ_RATE_LIMIT_PER_MINUTE,
  parsePublicReportReadPath
} from "./report-read-edge";

const REPORT_ID = `20260721-${"a".repeat(32)}`;

test("the edge recognizes every storage/rendering report representation with the canonical id", () => {
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}`), {
    reportId: REPORT_ID,
    resource: "page"
  });
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/`), {
    reportId: REPORT_ID,
    resource: "page"
  });
  assert.deepEqual(parsePublicReportReadPath("HEAD", `/reports/${REPORT_ID}/opengraph-image`), {
    reportId: REPORT_ID,
    resource: "opengraph-image"
  });
  assert.deepEqual(parsePublicReportReadPath("GET", `/reports/${REPORT_ID}/twitter-image/`), {
    reportId: REPORT_ID,
    resource: "twitter-image"
  });
  assert.deepEqual(
    parsePublicReportReadPath(
      "GET",
      `/%72eports/${REPORT_ID.slice(0, -1)}%61/%6fpengraph-image`
    ),
    { reportId: REPORT_ID, resource: "opengraph-image" },
    "percent-encoded route segments must not bypass a quota Next applies after decoding"
  );

  for (const [method, pathname] of [
    ["POST", `/reports/${REPORT_ID}`],
    ["GET", `/api/reports/${REPORT_ID}`],
    ["GET", "/reports/not-a-report"],
    ["GET", `/reports/${REPORT_ID}/other`],
    ["GET", `/reports/${REPORT_ID}%2Fopengraph-image`],
    ["GET", `/reports/${REPORT_ID}/%zz`]
  ]) {
    assert.equal(parsePublicReportReadPath(method, pathname), null, `${method} ${pathname}`);
  }
});

test("report-read ceilings are finite and retain the established per-client policy", () => {
  assert.equal(REPORT_READ_RATE_LIMIT_PER_MINUTE, 120);
  assert.equal(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE, 1_200);
  assert.ok(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE > REPORT_READ_RATE_LIMIT_PER_MINUTE);
});

test("container ingress charges recognized report reads before any container forward", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const ingress = source.slice(
    source.indexOf("const reportRead = parsePublicReportReadPath"),
    source.indexOf("const durableAdmission = durableScanJobsEnabled")
  );
  assert.match(ingress, /await enforcePublicReportReadRateLimit\(request, env\)/);
  assert.ok(
    ingress.indexOf("enforcePublicReportReadRateLimit") < ingress.indexOf("forwardToContainer(request, env)"),
    "quota must settle before report storage or rendering can start"
  );

  const response = source.slice(
    source.indexOf("function reportReadGateResponse("),
    source.indexOf("function gateErrorResponse(")
  );
  assert.match(response, /"cache-control": "no-store"/);
  assert.match(response, /"retry-after"/);
});

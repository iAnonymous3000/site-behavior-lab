import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReportStoreFailure } from "./report-store-failure-reason";
import {
  ReportStoreConfigError,
  ReportStoreListBoundsError,
  ReportStoreRequestTimeoutError,
  ReportStoreResponseInvalidUtf8Error,
  ReportStoreWriteConflictError
} from "./report-store-r2";

test("every report-store failure class maps to a closed public reason", () => {
  assert.equal(
    classifyReportStoreFailure(new ReportStoreConfigError("SITE_BEHAVIOR_LAB_R2_BUCKET is required")),
    "misconfigured"
  );
  assert.equal(classifyReportStoreFailure(new ReportStoreListBoundsError("too many keys")), "bounds-exceeded");
  assert.equal(classifyReportStoreFailure(new ReportStoreRequestTimeoutError("slow")), "timed-out");
  assert.equal(classifyReportStoreFailure(new ReportStoreResponseInvalidUtf8Error()), "malformed-response");
  assert.equal(classifyReportStoreFailure(new ReportStoreWriteConflictError("etag")), "write-conflict");
});

test("upstream status codes and filesystem errnos classify without reading the message", () => {
  // The whole point is that no branch consults `message`: an R2 failure carries
  // the upstream response body, and a filesystem failure carries an absolute
  // container path. Both are given here and must not change the answer.
  const secretish = "/srv/site-behavior-lab/reports: <Error><Code>AccessDenied</Code></Error>";
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { status: 403 })), "unauthorized");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { status: 401 })), "unauthorized");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { status: 503 })), "unreachable");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { status: 429 })), "unreachable");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { status: 404 })), "malformed-response");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "ENOENT" })), "misconfigured");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "EACCES" })), "misconfigured");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "ECONNREFUSED" })), "unreachable");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "ETIMEDOUT" })), "timed-out");
  assert.equal(classifyReportStoreFailure(new SyntaxError("Unexpected token < in JSON")), "malformed-response");
});

test("an unrecognized throw degrades to unknown rather than to its own text", () => {
  assert.equal(classifyReportStoreFailure(new Error("bucket sbl-prod key AKIAEXAMPLE denied")), "unknown");
  assert.equal(classifyReportStoreFailure("plain string failure"), "unknown");
  assert.equal(classifyReportStoreFailure(null), "unknown");
  assert.equal(classifyReportStoreFailure({ status: 700 }), "unknown");
  assert.equal(classifyReportStoreFailure({ code: "not-an-errno" }), "unknown");
});

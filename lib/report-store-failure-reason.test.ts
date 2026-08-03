import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReportStoreFailure } from "./report-store-failure-reason";
import {
  ReportStoreConfigError,
  ReportStoreHttpError,
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
  // A 404 is a configuration fault, not a malformed answer. Every object-level
  // 404 the backend can legitimately meet (missing report, missing sidecar,
  // delete of something already gone) is handled before the error is built, so
  // one that reaches here names a bucket or endpoint that does not exist. This
  // assertion used to pin "malformed-response", which blamed response parsing
  // for a store that had answered correctly.
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { status: 404 })), "misconfigured");
  // Classify the error the R2 backend actually throws, not only a hand-made
  // stand-in carrying a status. assertOk threw a bare Error, so every real R2
  // HTTP failure classified "unknown" and these three tokens were unreachable
  // for the only backend that produces HTTP failures.
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 403)), "unauthorized");
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 401)), "unauthorized");
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 503)), "unreachable");
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 429)), "unreachable");
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 408)), "unreachable");
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 404)), "misconfigured");
  // The split is at 404 only. A 400 really is an answer this client could not
  // have expected, so it keeps the parsing-flavored token.
  assert.equal(classifyReportStoreFailure(new ReportStoreHttpError(secretish, 400)), "malformed-response");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "ENOENT" })), "misconfigured");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "EACCES" })), "misconfigured");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "ECONNREFUSED" })), "unreachable");
  assert.equal(classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "ETIMEDOUT" })), "timed-out");
  assert.equal(classifyReportStoreFailure(new SyntaxError("Unexpected token < in JSON")), "malformed-response");
});

test("a transport failure classifies from its cause, not only from its head", () => {
  // This is the shape Node's fetch actually rejects with, and it is the most
  // likely production R2 fault: the top-level TypeError carries no status and
  // no code, so inspecting only the head published "unknown" for every
  // connection refusal, DNS failure, and stalled connect.
  const secretish = "bucket sbl-prod endpoint https://ACCOUNT.r2.cloudflarestorage.com";
  assert.equal(
    classifyReportStoreFailure(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(secretish), { code: "ECONNREFUSED" })
      })
    ),
    "unreachable"
  );
  assert.equal(
    classifyReportStoreFailure(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(secretish), { code: "ENOTFOUND" })
      })
    ),
    "unreachable"
  );
  // Underscore-bearing codes are errnos too; the old pattern rejected them.
  assert.equal(
    classifyReportStoreFailure(Object.assign(new Error(secretish), { code: "EAI_AGAIN" })),
    "unreachable"
  );
  assert.equal(
    classifyReportStoreFailure(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(secretish), { code: "UND_ERR_CONNECT_TIMEOUT" })
      })
    ),
    "unreachable"
  );
  // A status nested one level down is classified the same way as one at the head.
  assert.equal(
    classifyReportStoreFailure(new Error("wrapped", { cause: new ReportStoreHttpError(secretish, 503) })),
    "unreachable"
  );
  // The head still wins when it carries its own evidence.
  assert.equal(
    classifyReportStoreFailure(
      Object.assign(new Error(secretish), {
        status: 403,
        cause: Object.assign(new Error(secretish), { code: "ECONNREFUSED" })
      })
    ),
    "unauthorized"
  );
});

test("a self-referential cause chain terminates instead of spinning", () => {
  const looping = new Error("outer") as Error & { cause?: unknown };
  looping.cause = looping;
  assert.equal(classifyReportStoreFailure(looping), "unknown");
  const pair = new Error("a") as Error & { cause?: unknown };
  const other = new Error("b") as Error & { cause?: unknown };
  pair.cause = other;
  other.cause = pair;
  assert.equal(classifyReportStoreFailure(pair), "unknown");
});

test("an unrecognized throw degrades to unknown rather than to its own text", () => {
  assert.equal(classifyReportStoreFailure(new Error("bucket sbl-prod key AKIAEXAMPLE denied")), "unknown");
  assert.equal(classifyReportStoreFailure("plain string failure"), "unknown");
  assert.equal(classifyReportStoreFailure(null), "unknown");
  assert.equal(classifyReportStoreFailure({ status: 700 }), "unknown");
  assert.equal(classifyReportStoreFailure({ code: "not-an-errno" }), "unknown");
});

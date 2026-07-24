import assert from "node:assert/strict";
import test from "node:test";
import { ClientInvalidJsonError } from "./client-fetch-policy";
import {
  ClientReportIntegrityError,
  parseDigestBoundReportJson
} from "./client-report-integrity";
import { sha256BytesHex } from "./sha256";

test("digest-bound report JSON verifies exact bytes before parsing", async () => {
  const bytes = new TextEncoder().encode('{"report":"current"}\n');
  assert.deepEqual(
    await parseDigestBoundReportJson(bytes, sha256BytesHex(bytes), "Report evidence"),
    { report: "current" }
  );

  const changed = new TextEncoder().encode('{"report":"changed"}\n');
  await assert.rejects(
    () => parseDigestBoundReportJson(changed, sha256BytesHex(bytes), "Report evidence"),
    ClientReportIntegrityError
  );
});

test("digest-bound report JSON still rejects digest-matching invalid UTF-8", async () => {
  const bytes = new Uint8Array([0xff]);
  await assert.rejects(
    () => parseDigestBoundReportJson(bytes, sha256BytesHex(bytes), "Report evidence"),
    ClientInvalidJsonError
  );
});

test("a matching digest does not make duplicate-key JSON admissible", async () => {
  const bytes = new TextEncoder().encode('{"report":"first","\\u0072eport":"second"}');
  await assert.rejects(
    () => parseDigestBoundReportJson(bytes, sha256BytesHex(bytes), "Report evidence"),
    ClientInvalidJsonError
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverSavedReport, type RecoveryResponse } from "./saved-report-recovery";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";

/**
 * Pins the recovery semantics: only a genuine 404 means "not available, keep
 * waiting" (null). A stored report the server refuses to serve (its
 * intentional 500 for unreadable or newer-schema payloads) and a payload the
 * canonical reader rejects must surface their NAMED reason instead of
 * dissolving into a generic "still running" message.
 */

function response(status: number, body: unknown): RecoveryResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body)
  };
}

test("a 404 means the report is genuinely absent and recovery may keep waiting", async () => {
  assert.equal(await recoverSavedReport(response(404, { ok: false, error: "not found" })), null);
});

test("a 500 surfaces the server's named reason instead of null", async () => {
  await assert.rejects(
    recoverSavedReport(response(500, { ok: false, error: "This stored report uses a newer schema than this deployment can read." })),
    /newer schema/
  );
});

test("a non-JSON 500 body still throws with the HTTP status, never null", async () => {
  const broken: RecoveryResponse = {
    status: 500,
    ok: false,
    json: () => Promise.reject(new Error("not json"))
  };
  await assert.rejects(recoverSavedReport(broken), /HTTP 500/);
});

test("a 200 payload that fails the canonical reader throws its named reason", async () => {
  await assert.rejects(recoverSavedReport(response(200, { ok: true, schemaVersion: 1, requests: [null] })), /saved report/i);
});

test("a 200 payload that reads cleanly returns the report", async () => {
  const report = makeScanReportV1();
  const recovered = await recoverSavedReport(response(200, report));
  assert.ok(recovered);
  assert.equal(recovered.schemaVersion, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeScanUrl, scannerHealthPending } from "../app/scan-form";

test("scan URL normalization strips private query data and rejects malformed input", () => {
  assert.equal(normalizeScanUrl("example.com/account?token=secret#receipt"), "https://example.com/account");
  assert.equal(normalizeScanUrl("https://exa mple.com/account?token=secret#receipt"), null);
  assert.equal(normalizeScanUrl("   "), null);
});

test("live scan submission stays blocked until health resolves or fails", () => {
  const initial = { liveScanEnabled: true, reportPage: false, healthResolved: false, healthError: null };
  assert.equal(scannerHealthPending(initial), true);
  assert.equal(scannerHealthPending({ ...initial, healthResolved: true }), false);
  assert.equal(scannerHealthPending({ ...initial, healthError: "unavailable" }), false);
  assert.equal(scannerHealthPending({ ...initial, liveScanEnabled: false }), false);
  assert.equal(scannerHealthPending({ ...initial, reportPage: true }), false);
});

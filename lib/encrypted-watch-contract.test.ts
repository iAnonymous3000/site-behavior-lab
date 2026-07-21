import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENCRYPTED_WATCH_CADENCE_MS,
  ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET,
  ENCRYPTED_WATCH_MAX_ACTIVE,
  ENCRYPTED_WATCH_MAX_RUNS,
  ENCRYPTED_WATCH_TTL_MS,
  deriveEncryptedWatchIdFromCapabilityToken,
  encryptedWatchKeyIsIsolated,
  encryptedWatchOperationAllowed,
  encryptedWatchReadinessState,
  encryptedWatchesFlagState,
  isCanonicalEncryptedWatchKeyWire,
  isEncryptedWatchCapabilityToken,
  isEncryptedWatchId,
  isEncryptedWatchPayload
} from "./encrypted-watch-contract";

const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url");

test("encrypted-watch policy is fixed and deliberately bounded", () => {
  assert.equal(ENCRYPTED_WATCH_CADENCE_MS, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(ENCRYPTED_WATCH_TTL_MS, 30 * 24 * 60 * 60 * 1_000);
  assert.equal(ENCRYPTED_WATCH_MAX_RUNS, 5);
  assert.equal(ENCRYPTED_WATCH_MAX_ACTIVE, 32);
  assert.equal(ENCRYPTED_WATCH_GLOBAL_DAILY_RUN_BUDGET, 100);
});

test("payload validation is exact, single-mode, and excludes URL secrets", () => {
  const payload = {
    version: 1,
    target: { url: "https://private.example/sensitive-path" },
    options: { device: "desktop", gpcEnabled: true, reportMode: "r2", comparison: "none" }
  };
  assert.equal(isEncryptedWatchPayload(payload), true);
  assert.equal(isEncryptedWatchPayload({ ...payload, clientIp: "203.0.113.10" }), false);
  assert.equal(isEncryptedWatchPayload({ ...payload, target: { ...payload.target, extra: true } }), false);
  assert.equal(isEncryptedWatchPayload({ ...payload, target: { url: "https://private.example/path?secret=yes" } }), false);
  assert.equal(isEncryptedWatchPayload({ ...payload, target: { url: "https://private.example/path?" } }), false);
  assert.equal(isEncryptedWatchPayload({ ...payload, target: { url: "https://private.example/path#" } }), false);
  assert.equal(isEncryptedWatchPayload({ ...payload, target: { url: "https://private.example/path%3Fpart%23part" } }), true);
  assert.equal(isEncryptedWatchPayload({ ...payload, target: { url: "https://user:pass@private.example/" } }), false);
  assert.equal(isEncryptedWatchPayload({ ...payload, options: { ...payload.options, comparison: "gpc" } }), false);
});

test("flag and readiness gates fail closed while metadata deletion stays rollback-safe", () => {
  assert.equal(encryptedWatchesFlagState(undefined), "disabled");
  assert.equal(encryptedWatchesFlagState("0"), "disabled");
  assert.equal(encryptedWatchesFlagState("1"), "enabled");
  assert.equal(encryptedWatchesFlagState("true"), "misconfigured");
  assert.equal(encryptedWatchesFlagState(" 1"), "misconfigured");

  const ready = encryptedWatchReadinessState({
    flagValue: "1",
    encryptionKeyConfigured: true,
    encryptionKeyIsolated: true,
    durableJobsRequested: true,
    durableJobsReady: true
  });
  assert.equal(ready, "ready");
  assert.equal(encryptedWatchOperationAllowed("create", ready), true);
  assert.equal(encryptedWatchOperationAllowed("claim-due", ready), true);
  assert.equal(encryptedWatchOperationAllowed("read-target", ready), true);

  const unavailable = encryptedWatchReadinessState({
    flagValue: "1",
    encryptionKeyConfigured: false,
    encryptionKeyIsolated: false,
    durableJobsRequested: false,
    durableJobsReady: false
  });
  assert.equal(unavailable, "key-unavailable");
  assert.equal(encryptedWatchOperationAllowed("create", unavailable), false);
  assert.equal(encryptedWatchOperationAllowed("claim-due", unavailable), false);
  assert.equal(encryptedWatchOperationAllowed("read-target", unavailable), false);
  assert.equal(encryptedWatchOperationAllowed("read-metadata", unavailable), true);
  assert.equal(encryptedWatchOperationAllowed("delete", unavailable), true);
});

test("key, watch, and capability wires are canonical", () => {
  assert.equal(isCanonicalEncryptedWatchKeyWire(KEY), true);
  assert.equal(isCanonicalEncryptedWatchKeyWire(`${KEY}=`), false);
  assert.equal(isCanonicalEncryptedWatchKeyWire(KEY.slice(1)), false);
  assert.equal(encryptedWatchKeyIsIsolated(KEY, ["different-secret"]), true);
  assert.equal(encryptedWatchKeyIsIsolated(KEY, [KEY]), false);
  const syntheticMonitorCredential = KEY;
  assert.equal(encryptedWatchKeyIsIsolated(KEY, [syntheticMonitorCredential]), false);
  assert.equal(encryptedWatchKeyIsIsolated("not-a-key", []), false);
  assert.equal(isEncryptedWatchId("a".repeat(32)), true);
  assert.equal(isEncryptedWatchId("A".repeat(32)), false);
  assert.equal(isEncryptedWatchCapabilityToken("A".repeat(43)), true);
  assert.equal(isEncryptedWatchCapabilityToken("A".repeat(42)), false);
  assert.equal(isEncryptedWatchCapabilityToken(`${"A".repeat(42)}B`), false);
});

test("watch ID derivation is domain-separated, deterministic, and browser-safe", async () => {
  const token = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index)).toString("base64url");
  assert.equal(await deriveEncryptedWatchIdFromCapabilityToken(token), "103d0ebdaea7dce9e2910bd227af5c2c");
  assert.equal(await deriveEncryptedWatchIdFromCapabilityToken(token), await deriveEncryptedWatchIdFromCapabilityToken(token));
  await assert.rejects(() => deriveEncryptedWatchIdFromCapabilityToken(`${token}=`), /Invalid encrypted-watch capability token/);
});

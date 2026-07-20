import assert from "node:assert/strict";
import test from "node:test";
import {
  encryptedWatchIngressIsTokenGated,
  encryptedWatchPayloadFromPreparation,
  isEncryptedWatchCreationBody,
  parseEncryptedWatchPublicPath
} from "./encrypted-watch-edge-wiring";
import type { DurableScanJobPreparation } from "./durable-scan-job-contract";

const PREPARATION: DurableScanJobPreparation = {
  submission: {
    ok: true,
    jobId: "20260719-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "queued",
    statusPath: "/api/scans/20260719-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    reportId: "20260719-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  payload: {
    version: 1,
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1,
    admittedAt: Date.UTC(2026, 6, 19),
    reportMode: "r2",
    alreadyCharged: true
  }
};

test("watch routes distinguish the collection, valid opaque IDs, and uniformly-invalid items", () => {
  assert.deepEqual(parseEncryptedWatchPublicPath("/api/watches"), { kind: "collection" });
  assert.deepEqual(parseEncryptedWatchPublicPath(`/api/watches/${"a".repeat(32)}`), {
    kind: "item",
    watchId: "a".repeat(32)
  });
  assert.deepEqual(parseEncryptedWatchPublicPath("/api/watches/not-an-id"), { kind: "item", watchId: null });
  assert.deepEqual(parseEncryptedWatchPublicPath("/api/watches/a/extra"), { kind: "item", watchId: null });
  assert.equal(parseEncryptedWatchPublicPath("/api/watch"), null);
});

test("watch readiness requires the authenticated gate and rejects open public ingress", () => {
  assert.equal(encryptedWatchIngressIsTokenGated({ accessToken: "operator-token" }), true);
  assert.equal(
    encryptedWatchIngressIsTokenGated({
      accessToken: " operator-token ",
      allowUnauthenticated: "1",
      turnstileSecret: "turnstile-secret"
    }),
    true
  );
  assert.equal(
    encryptedWatchIngressIsTokenGated({ allowUnauthenticated: "1", turnstileSecret: "turnstile-secret" }),
    false
  );
  assert.equal(encryptedWatchIngressIsTokenGated({}), false);
});

test("watch creation accepts only the fixed single-mode public body", () => {
  assert.equal(
    isEncryptedWatchCreationBody({
      url: "https://example.com/",
      device: "mobile",
      gpcEnabled: false,
      turnstileToken: "challenge"
    }),
    true
  );
  assert.equal(
    isEncryptedWatchCreationBody({
      url: "https://example.com/",
      device: "desktop",
      gpcEnabled: true,
      compareGpc: true
    }),
    false
  );
  assert.equal(
    isEncryptedWatchCreationBody({ url: "https://example.com/", device: "tablet", gpcEnabled: true }),
    false
  );
  assert.equal(
    isEncryptedWatchCreationBody({ url: "https://example.com/?secret=1", device: "desktop", gpcEnabled: true }),
    false
  );
  assert.equal(
    isEncryptedWatchCreationBody({ url: "https://example.com/path?", device: "desktop", gpcEnabled: true }),
    false
  );
  assert.equal(
    isEncryptedWatchCreationBody({ url: "https://example.com/path#", device: "desktop", gpcEnabled: true }),
    false
  );
  assert.equal(
    isEncryptedWatchCreationBody({ url: "https://example.com/path%3Fpart%23part", device: "desktop", gpcEnabled: true }),
    true
  );
});

test("retained watch plaintext is derived only from a single-mode Node preparation", () => {
  assert.deepEqual(encryptedWatchPayloadFromPreparation(PREPARATION), {
    version: 1,
    target: { url: "https://example.com/" },
    options: { device: "desktop", gpcEnabled: true, reportMode: "r2", comparison: "none" }
  });
  assert.equal(
    encryptedWatchPayloadFromPreparation({
      ...PREPARATION,
      payload: { ...PREPARATION.payload, compareGpc: true, rateLimitCost: 2 }
    }),
    null
  );
});

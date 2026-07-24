import assert from "node:assert/strict";
import test from "node:test";
import {
  encryptedWatchAccessTokenIsIsolated,
  encryptedWatchAccessTokenMatches,
  encryptedWatchPayloadFromPreparation,
  isEncryptedWatchCreationBody,
  parseEncryptedWatchPublicPath
} from "./encrypted-watch-edge-wiring";
import { ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER } from "./encrypted-watch-contract";
import type { DurableScanJobPreparation } from "./durable-scan-job-contract";
import { publicScanGateStatus } from "./edge-scan-gate";

const WATCH_ACCESS_TOKEN = "watch-only-operator-token-0123456789abcdef";

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

test("public self-service and an optional watch second factor both coexist with open Turnstile ingress", async () => {
  assert.deepEqual(
    publicScanGateStatus({ allowUnauthenticated: "1", turnstileSecret: "turnstile-secret" }),
    { authenticated: false, openAccess: true, turnstile: true }
  );
  assert.equal(encryptedWatchAccessTokenIsIsolated(WATCH_ACCESS_TOKEN), true);
  assert.equal(
    await encryptedWatchAccessTokenMatches(
      new Headers({ [ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER]: WATCH_ACCESS_TOKEN }),
      WATCH_ACCESS_TOKEN
    ),
    true
  );
});

test("watch authorization rejects absent, malformed, wrong, or aliased endpoint credentials", async () => {
  assert.equal(await encryptedWatchAccessTokenMatches(new Headers(), WATCH_ACCESS_TOKEN), false);
  assert.equal(
    await encryptedWatchAccessTokenMatches(
      new Headers({ [ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER]: "wrong-watch-token-0123456789abcdef" }),
      WATCH_ACCESS_TOKEN
    ),
    false
  );
  assert.equal(encryptedWatchAccessTokenIsIsolated("short"), false);
  assert.equal(encryptedWatchAccessTokenIsIsolated(`${WATCH_ACCESS_TOKEN}\n`), false);
  assert.equal(encryptedWatchAccessTokenIsIsolated(WATCH_ACCESS_TOKEN, [WATCH_ACCESS_TOKEN]), false);
  assert.equal(encryptedWatchAccessTokenIsIsolated(` ${WATCH_ACCESS_TOKEN} `, [` ${WATCH_ACCESS_TOKEN}`]), false);
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

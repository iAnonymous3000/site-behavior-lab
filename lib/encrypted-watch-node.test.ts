import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PublicScanError } from "./public-errors";
import { prepareEncryptedWatchRun } from "./scan-jobs";

const WATCH_PAYLOAD = {
  version: 1,
  target: { url: "https://example.com/" },
  options: {
    device: "mobile",
    gpcEnabled: true,
    reportMode: "r2",
    comparison: "none"
  }
} as const;

test("scheduled watch preparation freshly validates every run and emits a single-mode durable payload", async () => {
  let validationCount = 0;
  let idCounter = 0;
  const prepare = () =>
    prepareEncryptedWatchRun(WATCH_PAYLOAD, {
      requireReady: () => undefined,
      verifyPublicUrl: async (url) => {
        validationCount += 1;
        assert.equal(url.href, "https://example.com/");
      },
      now: () => 1_750_000_000_000,
      createId: () => `20250615-${(++idCounter).toString(16).padStart(32, "0")}`
    });

  const first = await prepare();
  await prepare();

  assert.equal(validationCount, 2);
  assert.deepEqual(first, {
    submission: {
      ok: true,
      jobId: "20250615-00000000000000000000000000000001",
      status: "queued",
      statusPath: "/api/scans/20250615-00000000000000000000000000000001",
      reportId: "20250615-00000000000000000000000000000002"
    },
    payload: {
      version: 1,
      url: "https://example.com/",
      device: "mobile",
      gpcEnabled: true,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 1,
      admittedAt: 1_750_000_000_000,
      reportMode: "r2",
      alreadyCharged: true
    }
  });
  assert.equal("clientKey" in first.payload, false);
});

test("scheduled watch preparation rejects non-contract plaintext and a fresh private-DNS verdict", async () => {
  await assert.rejects(
    prepareEncryptedWatchRun(
      { ...WATCH_PAYLOAD, extra: true },
      { requireReady: () => undefined, verifyPublicUrl: async () => undefined }
    ),
    (error) => error instanceof PublicScanError && error.status === 400
  );

  await assert.rejects(
    prepareEncryptedWatchRun(WATCH_PAYLOAD, {
      requireReady: () => undefined,
      verifyPublicUrl: async () => {
        throw new PublicScanError("Local and private network targets are blocked.");
      }
    }),
    /Local and private network targets are blocked/
  );
});

test("scheduled watch preparation fails closed when its Node feature gates are off", async () => {
  const durableBefore = process.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS;
  const watchesBefore = process.env.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES;
  process.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS = "0";
  process.env.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES = "0";
  let verified = false;
  try {
    await assert.rejects(
      prepareEncryptedWatchRun(WATCH_PAYLOAD, {
        verifyPublicUrl: async () => {
          verified = true;
        }
      }),
      (error) => error instanceof PublicScanError && error.status === 503
    );
    assert.equal(verified, false, "a disabled private route must not resolve the retained target");
  } finally {
    if (durableBefore === undefined) delete process.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS;
    else process.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS = durableBefore;
    if (watchesBefore === undefined) delete process.env.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES;
    else process.env.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES = watchesBefore;
  }
});

test("the watch preparation route is private, authenticated, and cache-proof", async () => {
  const source = await readFile(
    path.join(process.cwd(), "app/api/internal/durable-scans/prepare-watch/route.ts"),
    "utf8"
  );
  assert.match(source, /assertDurableScanJobInternalRequest\(request\)/);
  assert.match(source, /readRequestBodyWithinLimit\(request, MAX_BODY_BYTES\)/);
  assert.match(source, /prepareEncryptedWatchRun\(payload\)/);
  assert.match(source, /DURABLE_SCAN_JOB_PREPARED_HEADER/);
  assert.match(source, /"cache-control": "no-store"/);
});

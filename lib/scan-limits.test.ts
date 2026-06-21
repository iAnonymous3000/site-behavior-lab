import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PublicScanError } from "./public-errors";
import {
  acquireScanSlot,
  assertRateLimit,
  assertReportReadRateLimit,
  clientKeyFromRequest,
  MAX_CONCURRENT_SCANS,
  MAX_QUEUED_SCANS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  REPORT_READ_RATE_LIMIT_MAX,
  REPORT_READ_RATE_LIMIT_WINDOW_MS,
  resetScanLimitStateForTests,
  scanLimitStateForTests
} from "./scan-limits";

const TRUST_PROXY_ENV = "SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS";

afterEach(() => {
  resetScanLimitStateForTests();
  delete process.env[TRUST_PROXY_ENV];
});

test("clientKeyFromRequest ignores forwarded headers unless proxy trust is enabled", () => {
  const request = new Request("http://localhost/api/scan", {
    headers: {
      "x-forwarded-for": "198.51.100.10, 203.0.113.20",
      "x-real-ip": "192.0.2.30"
    }
  });

  assert.equal(clientKeyFromRequest(request), "local");
});

test("clientKeyFromRequest can trust proxy-provided client headers explicitly", () => {
  process.env[TRUST_PROXY_ENV] = "1";

  const realIpRequest = new Request("http://localhost/api/scan", {
    headers: {
      "x-forwarded-for": "198.51.100.10, 203.0.113.20",
      "x-real-ip": "192.0.2.30"
    }
  });
  assert.equal(clientKeyFromRequest(realIpRequest), "192.0.2.30");

  const forwardedRequest = new Request("http://localhost/api/scan", {
    headers: {
      "x-forwarded-for": "198.51.100.10, 203.0.113.20"
    }
  });
  assert.equal(clientKeyFromRequest(forwardedRequest), "198.51.100.10");
});

test("assertRateLimit enforces the window and evicts stale client keys", () => {
  for (let index = 0; index < RATE_LIMIT_MAX; index += 1) {
    assertRateLimit("client-a", 1_000 + index);
  }

  assert.throws(() => assertRateLimit("client-a", 2_000), isStatus(429));
  assertRateLimit("client-a", 1_000 + RATE_LIMIT_WINDOW_MS + 1);

  resetScanLimitStateForTests();
  assertRateLimit("stale-client", 1);
  assert.equal(scanLimitStateForTests().trackedClients, 1);
  assertRateLimit("fresh-client", RATE_LIMIT_WINDOW_MS + 2);
  assert.equal(scanLimitStateForTests().trackedClients, 1);
});

test("assertRateLimit charges multi-scan requests atomically", () => {
  assertRateLimit("client-a", 1_000, RATE_LIMIT_MAX - 1);

  assert.throws(() => assertRateLimit("client-a", 1_001, 2), isStatus(429));
  assertRateLimit("client-a", 1_002);
  assert.throws(() => assertRateLimit("client-a", 1_003), isStatus(429));
});

test("assertReportReadRateLimit throttles report reads separately from scans", () => {
  for (let index = 0; index < REPORT_READ_RATE_LIMIT_MAX; index += 1) {
    assertReportReadRateLimit("client-a", 1_000 + index);
  }

  assert.throws(() => assertReportReadRateLimit("client-a", 2_000), isStatus(429));
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 1
  });

  assertRateLimit("client-a", 2_001);
  assertReportReadRateLimit("client-a", 1_000 + REPORT_READ_RATE_LIMIT_WINDOW_MS + 1);
});

test("acquireScanSlot queues past the concurrency cap and transfers a released slot", async () => {
  const releases: Array<() => void> = [];
  for (let index = 0; index < MAX_CONCURRENT_SCANS; index += 1) {
    releases.push(await acquireScanSlot());
  }

  const queued = acquireScanSlot(1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: MAX_CONCURRENT_SCANS,
    queuedScans: 1,
    trackedClients: 0,
    trackedReportReadClients: 0
  });

  releases[0]();
  const queuedRelease = await queued;
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: MAX_CONCURRENT_SCANS,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });

  queuedRelease();
  releases.slice(1).forEach((release) => release());
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });
});

test("acquireScanSlot rejects and removes timed-out waiters", async () => {
  const releases: Array<() => void> = [];
  for (let index = 0; index < MAX_CONCURRENT_SCANS; index += 1) {
    releases.push(await acquireScanSlot());
  }

  await assert.rejects(() => acquireScanSlot(5), isStatus(503));
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: MAX_CONCURRENT_SCANS,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });

  releases.forEach((release) => release());
});

test("acquireScanSlot rejects bursts beyond the bounded queue depth", async () => {
  const releases: Array<() => void> = [];
  for (let index = 0; index < MAX_CONCURRENT_SCANS; index += 1) {
    releases.push(await acquireScanSlot());
  }

  const queued: Array<Promise<() => void>> = [];
  for (let index = 0; index < MAX_QUEUED_SCANS; index += 1) {
    queued.push(acquireScanSlot(1_000));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scanLimitStateForTests().queuedScans, MAX_QUEUED_SCANS);

  // The queue is full, so the next request is rejected immediately rather than
  // parked as another waiter.
  await assert.rejects(() => acquireScanSlot(1_000), isStatus(503));
  assert.equal(scanLimitStateForTests().queuedScans, MAX_QUEUED_SCANS);

  // Drain every parked waiter so no timers or unhandled rejections leak. Each
  // release transfers the freed slot to the next waiter in FIFO order.
  releases.forEach((release) => release());
  for (const pending of queued) {
    const release = await pending;
    release();
  }
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0
  });
});

test("scan slot release handles are idempotent", async () => {
  const release = await acquireScanSlot();
  assert.equal(scanLimitStateForTests().activeScans, 1);

  release();
  release();
  assert.equal(scanLimitStateForTests().activeScans, 0);
});

function isStatus(status: number): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PublicScanError && error.status === status;
}

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PublicScanError } from "./public-errors";
import {
  acquireScanSlot,
  assertRateLimit,
  assertReportPdfRateLimit,
  assertReportReadRateLimit,
  clientKeyFromRequest,
  MAX_CONCURRENT_SCANS,
  MAX_QUEUED_SCANS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  REPORT_PDF_RATE_LIMIT_MAX,
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

  // RIGHTMOST. Each proxy appends the address of the peer it received from, so
  // only the last entry was written by the nearest trusted hop. This assertion
  // read "198.51.100.10" (the leftmost) and so pinned the bug below.
  const forwardedRequest = new Request("http://localhost/api/scan", {
    headers: {
      "x-forwarded-for": "198.51.100.10, 203.0.113.20"
    }
  });
  assert.equal(clientKeyFromRequest(forwardedRequest), "203.0.113.20");
});

test("a client cannot choose its own rate-limit identity through X-Forwarded-For", () => {
  process.env[TRUST_PROXY_ENV] = "1";

  // The shape a self-host sees behind a proxy that APPENDS rather than
  // replaces, which is the default for most reverse proxies: whatever the
  // client sent arrives first, and the trusted hop appends the address it
  // actually observed. Reading leftmost let a client rotate the value freely
  // and, at MAX_CONCURRENT_SCANS = 2, deny scanning to everyone else.
  const realClient = "203.0.113.20";
  const keys = new Set<string>();
  for (const spoofed of ["198.51.100.10", "198.51.100.11", "not-an-ip", ""]) {
    const request = new Request("http://localhost/api/scan", {
      headers: { "x-forwarded-for": `${spoofed}, ${realClient}` }
    });
    keys.add(clientKeyFromRequest(request));
  }
  assert.deepEqual([...keys], [realClient], "a rotating client-supplied entry must not move the quota identity");

  // A proxy that REPLACES the header is unaffected: one entry is both ends.
  const replaced = new Request("http://localhost/api/scan", {
    headers: { "x-forwarded-for": realClient }
  });
  assert.equal(clientKeyFromRequest(replaced), realClient);

  // An all-empty header still falls back rather than keying on "".
  const empty = new Request("http://localhost/api/scan", {
    headers: { "x-forwarded-for": " , " }
  });
  assert.equal(clientKeyFromRequest(empty), "local");
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
    trackedReportReadClients: 1,
    trackedReportPdfClients: 0
  });

  assertRateLimit("client-a", 2_001);
  assertReportReadRateLimit("client-a", 1_000 + REPORT_READ_RATE_LIMIT_WINDOW_MS + 1);
});

test("assertReportPdfRateLimit meters renders far tighter than reads, in its own bucket", () => {
  // A PDF is a browser navigation against a single render slot, not a byte
  // read. If the two shared a bucket, one client's 120 reads a minute would be
  // 120 renders a minute and nobody else would ever get one.
  assert.ok(
    REPORT_PDF_RATE_LIMIT_MAX < REPORT_READ_RATE_LIMIT_MAX,
    "a render must not be admitted at the rate of a byte read"
  );

  for (let index = 0; index < REPORT_PDF_RATE_LIMIT_MAX; index += 1) {
    assertReportPdfRateLimit("client-a", 1_000 + index);
  }
  assert.throws(() => assertReportPdfRateLimit("client-a", 2_000), isStatus(429));

  // Separate maps: spending the render allowance must not lock this client out
  // of the JSON, and must not touch anybody else.
  assertReportReadRateLimit("client-a", 2_001);
  assertReportPdfRateLimit("client-b", 2_002);
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 1,
    trackedReportPdfClients: 2
  });

  // And it is a window, not a permanent ban.
  assertReportPdfRateLimit("client-a", 1_000 + REPORT_READ_RATE_LIMIT_WINDOW_MS + 1);
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
    trackedReportReadClients: 0,
    trackedReportPdfClients: 0
  });

  releases[0]();
  const queuedRelease = await queued;
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: MAX_CONCURRENT_SCANS,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0,
    trackedReportPdfClients: 0
  });

  queuedRelease();
  releases.slice(1).forEach((release) => release());
  assert.deepEqual(scanLimitStateForTests(), {
    activeScans: 0,
    queuedScans: 0,
    trackedClients: 0,
    trackedReportReadClients: 0,
    trackedReportPdfClients: 0
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
    trackedReportReadClients: 0,
    trackedReportPdfClients: 0
  });

  releases.forEach((release) => release());
});

test("acquireScanSlot cooperatively removes an aborted waiter", async () => {
  const releases: Array<() => void> = [];
  for (let index = 0; index < MAX_CONCURRENT_SCANS; index += 1) {
    releases.push(await acquireScanSlot());
  }

  const controller = new AbortController();
  const queued = acquireScanSlot(1_000, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scanLimitStateForTests().queuedScans, 1);

  controller.abort();
  await assert.rejects(
    () => queued,
    (error) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(scanLimitStateForTests().queuedScans, 0);

  releases.forEach((release) => release());
  assert.equal(scanLimitStateForTests().activeScans, 0);
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
    trackedReportReadClients: 0,
    trackedReportPdfClients: 0
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

test("resetScanLimitStateForTests settles parked waiters instead of stranding them", async () => {
  // Draining the queue without rejecting left a parked acquireScanSlot caller
  // awaiting a promise nothing could resolve: the reset clears its timer and
  // removes its abort listener, so no other settlement path remains. A suite
  // that reset between cases hung on the previous case's waiter.
  const releases: Array<() => void> = [];
  for (let index = 0; index < MAX_CONCURRENT_SCANS; index += 1) {
    releases.push(await acquireScanSlot());
  }

  const parked = acquireScanSlot(60_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(scanLimitStateForTests().queuedScans, 1);

  resetScanLimitStateForTests();

  // Must settle promptly. Before the fix this awaited the 60s queue timeout
  // that the reset had already cleared, i.e. forever.
  await assert.rejects(() => parked, isStatus(503));
  assert.equal(scanLimitStateForTests().queuedScans, 0);
  releases.forEach((release) => release());
});

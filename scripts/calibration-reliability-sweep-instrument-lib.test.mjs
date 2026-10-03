import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  SWEEP_CLOCK_DRIFT_TOLERANCE_MS,
  caseClockVerdict,
  checkoutBindingVerdict,
  parseEgressProbeUrl,
  probeEgress
} from "./calibration-reliability-sweep-instrument-lib.mjs";

// Every server here listens on loopback; the probe reaches it through the
// loopback NAME, so the resolver is exercised without leaving the machine.

async function withServer(handler, fn) {
  let connections = 0;
  const server = createServer(handler);
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(new URL(`http://localhost:${port}/egress-probe`), () => connections);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the probe URL must be http(s), carry no credentials, and NAME its host", () => {
  assert.equal(parseEgressProbeUrl("https://sitebehavior.org/").href, "https://sitebehavior.org/");
  assert.equal(parseEgressProbeUrl("http://localhost:4321/egress-probe").hostname, "localhost");
  for (const [raw, expected] of [
    ["not a url", /is not a URL/],
    ["ftp://localhost/", /must be an http or https URL/],
    ["https://user:secret@sitebehavior.org/", /must not carry credentials/],
    ["http://127.0.0.1:4321/", /must name its host, not the address 127\.0\.0\.1/],
    ["http://[::1]:4321/", /must name its host, not the address ::1/],
    ["https://93.184.215.14/", /must name its host/]
  ]) {
    assert.throws(() => parseEgressProbeUrl(raw), expected, raw);
  }
});

test("any HTTP answer proves egress, and every probe opens its own connection", async () => {
  for (const status of [204, 200, 404, 503]) {
    await withServer(
      (request, response) => {
        assert.equal(request.method, "HEAD");
        response.writeHead(status);
        response.end();
      },
      async (url, connections) => {
        assert.deepEqual(await probeEgress(url), { ok: true, detail: `HTTP ${status}` });
        assert.deepEqual(await probeEgress(url), { ok: true, detail: `HTTP ${status}` });
        // A pooled keep-alive connection would answer while the resolver is
        // dead; two probes must be two lookups and two connects.
        assert.equal(connections(), 2, `HTTP ${status}`);
      }
    );
  }
});

test("a reset, a refused connection, or no answer in time is a failed probe, never a throw", async () => {
  await withServer(
    (request, response) => response.socket.destroy(),
    async (url) => {
      const result = await probeEgress(url);
      assert.equal(result.ok, false);
      assert.match(result.detail, /socket hang up|ECONNRESET/);
    }
  );

  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const refused = await probeEgress(new URL(`http://localhost:${port}/`));
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /ECONNREFUSED/);

  // Accepts the connection and never answers.
  await withServer(
    () => undefined,
    async (url) => {
      const started = Date.now();
      const result = await probeEgress(url, { timeoutMs: 200 });
      assert.deepEqual(result, { ok: false, detail: "no answer within 200 ms" });
      assert.ok(Date.now() - started < 5_000, "the probe's own timeout ended it");
    }
  );
});

test("a scan's answer stands only while its wall-clock and monotonic durations agree inside the deadline", () => {
  const deadlineMs = 180_000;
  const verdict = (wallElapsedMs, monotonicElapsedMs) =>
    caseClockVerdict({ wallElapsedMs, monotonicElapsedMs, deadlineMs });
  assert.equal(SWEEP_CLOCK_DRIFT_TOLERANCE_MS, 5_000);

  // Awake: the clocks agree to within the tolerance, at its boundary too.
  assert.equal(verdict(31_000, 30_990), null);
  assert.equal(verdict(35_000, 30_000), null);
  assert.equal(verdict(25_000, 30_000), null);
  assert.equal(verdict(deadlineMs, deadlineMs), null);

  // Slept: the wall clock ran past the monotonic one by more than the
  // tolerance (August's gaps were 449 to 1,609 s), or a clock step backwards.
  assert.match(verdict(35_001, 30_000), /the wall clock moved 35\.0 s while this process ran 30\.0 s: the machine slept/);
  assert.match(verdict(640_000, 40_000), /the machine slept, or its clock was stepped/);
  assert.match(verdict(24_999, 30_000), /the machine slept, or its clock was stepped/);

  // A platform whose monotonic clock counts the sleep: no drift, but no awake
  // scan outlives the driver's deadline.
  assert.match(verdict(deadlineMs + 1, deadlineMs + 1), /the scan took 180\.0 s of wall-clock time, beyond the driver's 180\.0 s deadline/);
  assert.match(verdict(640_000, 640_000), /beyond the driver's 180\.0 s deadline/);

  for (const bad of [Number.NaN, Infinity, "30000", undefined]) {
    assert.throws(() => verdict(bad, 30_000), TypeError);
    assert.throws(() => verdict(30_000, bad), TypeError);
  }
});

test("the checkout binds only at the declared build with no tracked change", () => {
  const buildCommit = "a".repeat(40);
  assert.equal(checkoutBindingVerdict({ head: buildCommit, dirtyPaths: [], buildCommit }), null);
  assert.match(
    checkoutBindingVerdict({ head: "b".repeat(40), dirtyPaths: [], buildCommit }),
    new RegExp(`checkout is at ${"b".repeat(40)}, not the declared SITE_BEHAVIOR_LAB_BUILD_COMMIT ${buildCommit}`)
  );
  // A mismatched head is named first even when the tree is also dirty.
  assert.match(
    checkoutBindingVerdict({ head: "b".repeat(40), dirtyPaths: ["lib/scanner.ts"], buildCommit }),
    /not the declared/
  );
  assert.match(
    checkoutBindingVerdict({ head: buildCommit, dirtyPaths: ["lib/scanner.ts", "next-env.d.ts"], buildCommit }),
    /has 2 tracked change\(s\) against a{40} \(lib\/scanner\.ts, next-env\.d\.ts\)/
  );
  const many = Array.from({ length: 23 }, (_, index) => `file-${index}.ts`);
  const truncated = checkoutBindingVerdict({ head: buildCommit, dirtyPaths: many, buildCommit });
  assert.match(truncated, /has 23 tracked change\(s\)/);
  assert.match(truncated, /file-19\.ts and 3 more\)/);
  assert.doesNotMatch(truncated, /file-20\.ts/);
});

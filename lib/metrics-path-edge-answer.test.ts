import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

// Miniflare's dispatcher adds these to every response. They say how the bytes
// travelled, not what the Worker set.
const isTransportHeader = (name: string) =>
  name.startsWith("mf-") || ["content-encoding", "content-length", "transfer-encoding"].includes(name);

test("the production Worker answers /api/metrics with a bare 404 and never forwards it to the container", { timeout: 45_000 }, async () => {
  // Every other path the Worker does not serve is forwarded to the container,
  // which answers with its not-found page and is woken to do it. This path
  // has always been answered at the edge instead: 404, no body, two headers,
  // whatever the method. The harness is the real Worker with the container
  // replaced by a stand-in that accepts and records whatever reaches it.
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-metrics-path-"));
  let mf: Miniflare | undefined;
  try {
    execFileSync(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "deploy", "test-fixtures/scan-admission-path-runtime.test.ts",
      "--dry-run", "--outdir", dir, "--name", "metrics-path", "--compatibility-date", "2026-06-19",
      "--compatibility-flags", "nodejs_compat"
    ], { cwd: process.cwd(), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
    mf = new Miniflare({
      modules: true, scriptPath: path.join(dir, "scan-admission-path-runtime.test.js"), modulesRoot: dir,
      compatibilityDate: "2026-06-19", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SCANNER: { className: "ScanAdmissionPathHarness", useSQLite: true } },
      durableObjectsPersist: false, log: new Log(LogLevel.ERROR)
    });
    const forwardedPaths = async () =>
      ((await (await mf!.dispatchFetch("https://scanner.invalid/__harness/state")).json()) as {
        forwarded: Array<{ path: string }>;
      }).forwarded.map((entry) => entry.path);

    const json = JSON.stringify({ any: "body" });
    const requests: Array<{ method: string; path: string; headers?: Record<string, string>; body?: string }> = [
      { method: "GET", path: "/api/metrics" },
      { method: "HEAD", path: "/api/metrics" },
      { method: "GET", path: "/api/metrics?x=1" },
      { method: "POST", path: "/api/metrics" },
      {
        method: "POST",
        path: "/api/metrics",
        headers: { origin: "https://sitebehavior.org", "content-type": "application/json" },
        body: json
      },
      {
        method: "OPTIONS",
        path: "/api/metrics",
        headers: { origin: "https://sitebehavior.org", "access-control-request-method": "POST" }
      },
      { method: "PUT", path: "/api/metrics", headers: { "content-type": "application/json" }, body: json },
      { method: "DELETE", path: "/api/metrics" }
    ];
    for (const { method, path: requestPath, headers, body } of requests) {
      const label = `${method} ${requestPath}`;
      const response = await mf.dispatchFetch(`https://scanner.invalid${requestPath}`, {
        method,
        headers: { "cf-connecting-ip": "203.0.113.9", ...headers },
        body
      });
      assert.equal(response.status, 404, label);
      assert.equal((await response.arrayBuffer()).byteLength, 0, label);
      assert.deepEqual(
        [...response.headers].filter(([name]) => !isTransportHeader(name)).sort(([a], [b]) => a.localeCompare(b)),
        [["cache-control", "no-store"], ["x-content-type-options", "nosniff"]],
        label
      );
    }
    assert.deepEqual(await forwardedPaths(), []);

    // The nearest other path is forwarded like any unserved one. So the match
    // is exact, and the stand-in does record a forward: the empty list above
    // is a fact about this path and not about the harness.
    const neighbour = await mf.dispatchFetch("https://scanner.invalid/api/metrics/", {
      headers: { "cf-connecting-ip": "203.0.113.9" }
    });
    await neighbour.arrayBuffer();
    assert.deepEqual(await forwardedPaths(), ["/api/metrics/"]);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

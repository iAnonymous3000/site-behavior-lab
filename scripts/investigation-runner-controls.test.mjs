// The S4 runner harness's stop paths: a stop kills the running child at once, one crash counter spans
// the run, error output naming a non-loopback host stops it, and the fixture guard proxy forwards only
// the listed loopback origins. A dummy `sleep` stands in for the recorder; nothing of the recorder runs.
// HARNESS may name a mutated copy of the harness folder, to show each test fails against its mutation.
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
const H = process.env.HARNESS ?? fileURLToPath(new URL("../investigation/runner/s4/harness", import.meta.url));
const { createRunControl } = await import(`${H}/run-control.mjs`);
const { startGuardProxy } = await import(`${H}/guard-proxy.mjs`);
const tmp = () => mkdtempSync(path.join(tmpdir(), "s4-t-"));

test("a stop kills the running child at once and records the reason", async () => {
  const dir = tmp(); const c = createRunControl({ workDir: dir });
  const child = spawn("sleep", ["60"]); c.state.child = child;
  const closed = new Promise((r) => child.on("close", (code, sig) => r(sig)));
  const t0 = Date.now(); c.stop("test-stop", "x");
  assert.equal(await closed, "SIGKILL"); assert.ok(Date.now() - t0 < 2000);
  assert.ok(existsSync(`${dir}/STOPPED.json`)); assert.equal(c.state.stopped.reason, "test-stop");
});

test("the crash counter spans browsers: one exit does not stop, the second does", () => {
  const c = createRunControl({ workDir: tmp() });
  c.state.browser = { exitCode: 1, signalCode: null }; c.browserExitedUnexpectedly("a");
  assert.equal(c.state.stopped, null);
  c.state.browser = { exitCode: 1, signalCode: null }; c.browserExitedUnexpectedly("b");
  assert.equal(c.state.stopped?.reason, "repeated-crash");
});

test("stderr naming a non-loopback host stops; loopback does not", () => {
  const a = createRunControl({ workDir: tmp() });
  a.scanStderr("s", "Error: connect ECONNREFUSED 127.0.0.1:9222");
  assert.equal(a.state.stopped, null);
  a.scanStderr("s", "Error: getaddrinfo ENOTFOUND example.invalid");
  assert.equal(a.state.stopped?.reason, "connection-attempt-in-stderr");
});

function viaProxy(proxyPort, url) {
  return new Promise((r) => { const q = http.request({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET" }, (s) => { s.resume(); s.on("end", () => r(s.statusCode)); }); q.on("error", () => r("error")); q.end(); });
}
test("the guard forwards the listed origins and refuses the rest, calling onRefusal", async () => {
  const up = http.createServer((q, s) => s.end("ok")); await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const cdp = http.createServer((q, s) => s.end("{}")); await new Promise((r) => cdp.listen(0, "127.0.0.1", r));
  const refusals = [];
  const g = await startGuardProxy({ port: 0, allowedOrigins: [`http://127.0.0.1:${up.address().port}`, `http://127.0.0.1:${cdp.address().port}`], logPath: `${tmp()}/g.jsonl`, onRefusal: (x) => refusals.push(x) });
  const p = g.address().port;
  assert.equal(await viaProxy(p, `http://127.0.0.1:${up.address().port}/x`), 200);
  assert.equal(await viaProxy(p, `http://127.0.0.1:${cdp.address().port}/json/version`), 200);
  assert.equal(refusals.length, 0);
  assert.equal(await viaProxy(p, "http://192.0.2.1/probe"), 403);
  assert.equal(refusals.length, 1);
  g.close(); up.close(); cdp.close();
});

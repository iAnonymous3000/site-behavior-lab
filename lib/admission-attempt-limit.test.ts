import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import {
  chargeAdmissionAttempt,
  enforceAdmissionAttemptLimit,
  isAdmissionAttempt
} from "./admission-attempt-limit";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

function database() {
  const db = new DatabaseSync(":memory:");
  const sql: DurableScanJobStoreSql = {
    exec<T extends Record<string, ArrayBuffer | string | number | null>>(query: string, ...bindings: Array<ArrayBuffer | string | number | null>) {
      const statement = db.prepare(query);
      const values = bindings.map((v) => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
      const rows = /^\s*SELECT/.test(query) ? statement.all(...values) as T[] : [];
      if (!/^\s*SELECT/.test(query)) statement.run(...values);
      return { toArray: () => rows };
    }
  };
  return { db, sql };
}
const client = (index: number) => index.toString(16).padStart(64, "0");

test("attempts obey a rolling ten-second ceiling across wall-clock boundaries", () => {
  const { db, sql } = database();
  try {
    for (let n = 0; n < 10; n++) assert.deepEqual(chargeAdmissionAttempt(sql, client(1), 9_999), { allowed: true });
    assert.deepEqual(chargeAdmissionAttempt(sql, client(1), 10_001), { allowed: false, retryAfterSeconds: 10 });
    assert.deepEqual(chargeAdmissionAttempt(sql, client(1), 19_998), { allowed: false, retryAfterSeconds: 1 });
    assert.deepEqual(chargeAdmissionAttempt(sql, client(1), 19_999), { allowed: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admission_attempts").get()?.n, 1);
  } finally { db.close(); }
});

test("rotating identities cannot exceed the global budget or grow rejected-client storage", () => {
  const { db, sql } = database();
  try {
    for (let n = 0; n < 100; n++) assert.deepEqual(chargeAdmissionAttempt(sql, client(n), 1_000), { allowed: true });
    for (let n = 100; n < 1_000; n++) assert.deepEqual(chargeAdmissionAttempt(sql, client(n), 1_001), { allowed: false, retryAfterSeconds: 10 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admission_attempts").get()?.n, 100);
    assert.deepEqual(chargeAdmissionAttempt(sql, client(1_001), 11_000), { allowed: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admission_attempts").get()?.n, 1);
  } finally { db.close(); }
});

test("SQL decisions agree with an independent event-history oracle over interleaved clients and expiries", () => {
  const { db, sql } = database();
  const accepted: Array<{ at: number; who: number }> = [];
  let seed = 29;
  let now = 0;
  try {
    for (let n = 0; n < 5_000; n++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      now += seed % 71;
      const who = seed % 19;
      const live = accepted.filter((event) => event.at > now - 10_000);
      const expected = live.length < 100 && live.filter((event) => event.who === who).length < 10;
      const decision = chargeAdmissionAttempt(sql, client(who), now);
      assert.equal(decision.allowed, expected, `event ${n} at ${now}`);
      if (expected) accepted.push({ at: now, who });
      else if (!decision.allowed) assert.ok(decision.retryAfterSeconds >= 1 && decision.retryAfterSeconds <= 10);
    }
    assert.ok(Number(db.prepare("SELECT COUNT(*) AS n FROM admission_attempts").get()?.n) <= 100);
  } finally { db.close(); }
});

test("a store failure refuses before body consumption, leaks no details, and preserves CORS", async () => {
  const request = new Request("https://scan.sitebehavior.org/api/scan", {
    method: "POST", body: "secret request body", headers: { origin: "https://sitebehavior.org" }
  });
  const response = await enforceAdmissionAttemptLimit(request, "https://sitebehavior.org", async () => {
    throw new Error("private storage failure");
  });
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("retry-after"), "5");
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.equal(response?.headers.get("access-control-allow-origin"), "https://sitebehavior.org");
  assert.equal(request.bodyUsed, false);
  assert.doesNotMatch(await response!.text(), /secret|private storage/);
});

test("only the provider client identity changes an attempt bucket", async () => {
  const hashes: string[] = [];
  const inputs: Record<string, string>[] = [
    { "x-forwarded-for": "1.2.3.4" },
    { "x-forwarded-for": "5.6.7.8", "x-real-ip": "8.8.8.8" },
    { "cf-connecting-ip": "1.2.3.4" }
  ];
  for (const headers of inputs) {
    await enforceAdmissionAttemptLimit(new Request("https://scanner.invalid/api/scan", { headers }), undefined, async (hash) => {
      hashes.push(hash); return { allowed: true };
    });
  }
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[1], hashes[2]);
  assert.ok(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
});

test("both routes count, including query variants, but polling and preflight do not", () => {
  for (const url of ["https://s.invalid/api/scan", "https://s.invalid/api/scan?q=1"]) {
    assert.equal(isAdmissionAttempt("POST", new URL(url).pathname), true);
  }
  assert.equal(isAdmissionAttempt("GET", "/api/scan/admission"), true);
  assert.equal(isAdmissionAttempt("OPTIONS", "/api/scan"), false);
  assert.equal(isAdmissionAttempt("GET", "/api/scan-jobs/id"), false);
});

test("the production Worker refuses concurrent malformed requests before container or Siteverify work", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-admission-runtime-"));
  let mf: Miniflare | undefined;
  try {
    execFileSync(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "deploy", "test-fixtures/admission-attempt-runtime.test.ts",
      "--dry-run", "--outdir", dir, "--name", "admission-runtime", "--compatibility-date", "2026-06-19",
      "--compatibility-flags", "nodejs_compat"
    ], { cwd: process.cwd(), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
    mf = new Miniflare({
      modules: true, scriptPath: path.join(dir, "admission-attempt-runtime.test.js"), modulesRoot: dir,
      compatibilityDate: "2026-06-19", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SCANNER: { className: "AdmissionAttemptHarness", useSQLite: true } },
      durableObjectsPersist: false, log: new Log(LogLevel.ERROR)
    });
    // Warm only the runtime with an edge-only OPTIONS request; it must not
    // consume one of the ten attempts or invoke a nonexistent container.
    assert.equal((await mf.dispatchFetch("https://scanner.invalid/api/scan/admission", { method: "OPTIONS" })).status, 204);
    const responses = await Promise.all(Array.from({ length: 40 }, (_, n) =>
      mf!.dispatchFetch(`https://scanner.invalid${n % 2 ? "/api/scan" : "/api/scan/admission"}`, {
        method: n % 2 ? "POST" : "GET", ...(n % 2 ? { body: "invalid JSON" } : {}),
        headers: { "cf-connecting-ip": "203.0.113.10" }
      })
    ));
    assert.equal(responses.filter((response) => response.status === 429).length, 30);
    assert.equal(responses.filter((response) => [400, 404].includes(response.status)).length, 10);
    for (const response of responses) {
      if (response.status === 429) assert.match(response.headers.get("retry-after") ?? "", /^(?:[1-9]|10)$/);
      await response.text();
    }
    const workerSource = await readFile("cloudflare/container-worker.ts", "utf8");
    assert.match(workerSource, /chargeAdmissionAttempt\(input: \{ clientHash: string \}\)[\s\S]*?transactionSync\(\(\) =>\s*chargeAdmissionAttemptInStore/);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

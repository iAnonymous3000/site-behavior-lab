import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest } from "miniflare";
import {
  ADMISSION_ATTEMPT_MAX_STORED_ROWS,
  chargeAdmissionAttempt,
  enforceAdmissionAttemptLimit,
  isAdmissionAttempt
} from "./admission-attempt-limit";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import { publicClientHash } from "./edge-scan-gate";

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

test("rotating attacker identities never lock out legitimate clients and storage stays bounded", () => {
  const { db, sql } = database();
  try {
    // 200 distinct rotating IPs sending 10 attempts each (2,000 attempts in 1ms)
    // must NEVER deny service to an unrelated legitimate client.
    for (let ip = 0; ip < 200; ip++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        assert.deepEqual(chargeAdmissionAttempt(sql, client(ip), 1_000), { allowed: true });
      }
      // Each individual abusive IP is still capped at 10 per 10s.
      assert.deepEqual(chargeAdmissionAttempt(sql, client(ip), 1_001), { allowed: false, retryAfterSeconds: 10 });
    }
    assert.deepEqual(chargeAdmissionAttempt(sql, client(999_999), 1_001), { allowed: true });

    // A massive rotating flood cannot grow SQLite storage past ADMISSION_ATTEMPT_MAX_STORED_ROWS.
    for (let ip = 1_000; ip < 1_000 + ADMISSION_ATTEMPT_MAX_STORED_ROWS + 500; ip++) {
      assert.deepEqual(chargeAdmissionAttempt(sql, client(ip), 1_500), { allowed: true });
    }
    assert.ok(
      Number(db.prepare("SELECT COUNT(*) AS n FROM admission_attempts").get()?.n) <= ADMISSION_ATTEMPT_MAX_STORED_ROWS
    );
  } finally { db.close(); }
});

test("SQL decisions agree with an independent per-client event-history oracle over interleaved clients and expiries", () => {
  const { db, sql } = database();
  const accepted: Array<{ at: number; who: number }> = [];
  let seed = 29;
  let now = 0;
  try {
    for (let n = 0; n < 5_000; n++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      now += seed % 71;
      const who = seed % 19;
      const liveForClient = accepted.filter((event) => event.who === who && event.at > now - 10_000);
      const expected = liveForClient.length < 10;
      const decision = chargeAdmissionAttempt(sql, client(who), now);
      assert.equal(decision.allowed, expected, `event ${n} at ${now}`);
      if (expected) accepted.push({ at: now, who });
      else if (!decision.allowed) assert.ok(decision.retryAfterSeconds >= 1 && decision.retryAfterSeconds <= 10);
    }
    assert.ok(
      Number(db.prepare("SELECT COUNT(*) AS n FROM admission_attempts").get()?.n) <= ADMISSION_ATTEMPT_MAX_STORED_ROWS
    );
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

test("a refused scan submission declares the quota cause and its wait; a recovery lookup does not", async () => {
  // Both buckets (per-client and global) refuse through this one branch, so the
  // declared cause makes no claim about whose attempts filled the window.
  const refuse = async () => ({ allowed: false as const, retryAfterSeconds: 7 });
  const submit = await enforceAdmissionAttemptLimit(
    new Request("https://scanner.invalid/api/scan", { method: "POST", body: "{}" }),
    undefined,
    refuse
  );
  assert.equal(submit?.status, 429);
  assert.equal(submit?.headers.get("retry-after"), "7");
  assert.deepEqual(await submit!.json(), {
    ok: false,
    error: "Too many scan admission requests. Try again shortly.",
    cause: "request-limit",
    retryAfterSeconds: 7
  });

  // The recovery lookup is not a scan being held back.
  const recovery = await enforceAdmissionAttemptLimit(
    new Request("https://scanner.invalid/api/scan/admission"),
    undefined,
    refuse
  );
  assert.equal(recovery?.status, 429);
  assert.equal(recovery?.headers.get("retry-after"), "7");
  assert.deepEqual(await recovery!.json(), {
    ok: false,
    error: "Too many scan admission requests. Try again shortly."
  });
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

test("every address of one IPv6 /64 spends the same attempt bucket", async () => {
  const hashFor = async (address: string) => {
    let seen = "";
    await enforceAdmissionAttemptLimit(
      new Request("https://scanner.invalid/api/scan", { method: "POST", headers: { "cf-connecting-ip": address } }),
      undefined,
      async (hash) => { seen = hash; return { allowed: true }; }
    );
    return seen;
  };
  const first = await hashFor("2001:db8:aaaa:bbbb::1");
  assert.equal(await hashFor("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff"), first);
  assert.notEqual(await hashFor("2001:db8:aaaa:bbbc::1"), first);
  assert.equal(await hashFor("::ffff:203.0.113.10"), await hashFor("203.0.113.10"));
  // The attempt budget and the scan quota name one client the same way.
  assert.equal(first, await publicClientHash(new Headers({ "cf-connecting-ip": "2001:db8:aaaa:bbbb::2" })));
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
    assert.equal((await mf.dispatchFetch("https://scanner.invalid/api/v3/scan", { method: "OPTIONS" })).status, 204);
    // Retired legacy scan routes return 410 Gone at the edge without touching
    // quota or invoking the container.
    for (const [method, retiredPath] of [
      ["POST", "/api/scan"],
      ["GET", "/api/scan/admission"],
      ["GET", "/api/scans/20260101-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
    ] as const) {
      const retired = await mf.dispatchFetch(`https://scanner.invalid${retiredPath}`, {
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
        headers: { "cf-connecting-ip": "203.0.113.10", origin: "https://sitebehavior.org" }
      });
      assert.equal(retired.status, 410, `${method} ${retiredPath}`);
      assert.equal(retired.headers.get("access-control-allow-origin"), "https://sitebehavior.org");
      assert.deepEqual(await retired.json(), {
        ok: false,
        error: "The legacy v1/v2 scan endpoint has been retired. Submit scans to POST /api/v3/scan.",
        migration: "/api/v3/scan",
        cause: "feature-unavailable"
      });
    }
    const responses = await Promise.all(Array.from({ length: 40 }, () =>
      mf!.dispatchFetch("https://scanner.invalid/api/v3/scan", {
        method: "POST",
        body: "invalid JSON",
        headers: { "cf-connecting-ip": "203.0.113.10" }
      })
    ));
    assert.equal(responses.filter((response) => response.status === 429).length, 30);
    assert.equal(responses.filter((response) => response.status === 400).length, 10);
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

test("the production Worker admits a scan once per client, and Cloudflare's address alone names the client", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-scan-admission-path-"));
  const siteverifyAddresses: Array<string | null> = [];
  let mf: Miniflare | undefined;
  try {
    execFileSync(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "deploy", "test-fixtures/scan-admission-path-runtime.test.ts",
      "--dry-run", "--outdir", dir, "--name", "scan-admission-path", "--compatibility-date", "2026-06-19",
      "--compatibility-flags", "nodejs_compat"
    ], { cwd: process.cwd(), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
    mf = new Miniflare({
      modules: true, scriptPath: path.join(dir, "scan-admission-path-runtime.test.js"), modulesRoot: dir,
      compatibilityDate: "2026-06-19", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SCANNER: { className: "ScanAdmissionPathHarness", useSQLite: true } },
      durableObjectsPersist: false, log: new Log(LogLevel.ERROR),
      // Siteverify lands here, never on the network, and accepts every token.
      outboundService: async (request: MiniflareRequest) => {
        siteverifyAddresses.push(new URLSearchParams(await request.text()).get("remoteip"));
        return new MiniflareResponse(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
      }
    });
    let token = 0;
    const scan = (headers: Record<string, string>, solved = true) =>
      mf!.dispatchFetch("https://scanner.invalid/api/v3/scan", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ url: "https://example.org/", ...(solved ? { turnstileToken: `token-${(token += 1)}` } : {}) })
      });
    const state = async () =>
      (await (await mf!.dispatchFetch("https://scanner.invalid/__harness/state")).json()) as {
        forwarded: Array<{ path: string; forwardedFor: string | null; realIp: string | null }>;
        clientMinuteCharges: number[];
      };
    // The quota is a fixed minute window; start where every request below
    // lands in one window.
    const untilNextMinute = 60_000 - (Date.now() % 60_000);
    if (untilNextMinute < 20_000) await new Promise((resolve) => setTimeout(resolve, untilNextMinute + 100));

    // A scan with no solved challenge is refused before Siteverify, the quota
    // and the container.
    const subscriber = (host: number) => `2001:db8:aaaa:bbbb::${host.toString(16)}`;
    const unsolved = await scan({ "cf-connecting-ip": subscriber(1) }, false);
    assert.equal(unsolved.status, 400);
    assert.equal(((await unsolved.json()) as { error: string }).error, "Turnstile verification is required.");
    assert.deepEqual(await state(), { forwarded: [], clientMinuteCharges: [] });
    assert.deepEqual(siteverifyAddresses, []);

    // Retired POST /api/scan is refused with 410 Gone before Siteverify, quota,
    // and container forwarding.
    const retired = await mf!.dispatchFetch("https://scanner.invalid/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": subscriber(1) },
      body: JSON.stringify({ url: "https://example.org/", turnstileToken: "unused" })
    });
    assert.equal(retired.status, 410);
    assert.equal(((await retired.json()) as { migration?: string }).migration, "/api/v3/scan");
    assert.deepEqual(await state(), { forwarded: [], clientMinuteCharges: [] });
    assert.deepEqual(siteverifyAddresses, []);

    // One admitted scan is charged once and forwarded once. The container is
    // handed Cloudflare's address as the only X-Forwarded-For entry, whatever
    // forwarding headers the caller sent, and Siteverify the full address.
    const admitted = await scan({
      "cf-connecting-ip": subscriber(1),
      "x-forwarded-for": "198.51.100.1, 198.51.100.2",
      "x-real-ip": "198.51.100.3"
    });
    assert.equal(admitted.status, 200);
    await admitted.text();
    assert.deepEqual(await state(), {
      forwarded: [{ path: "/api/v3/scan", forwardedFor: subscriber(1), realIp: subscriber(1) }],
      clientMinuteCharges: [1]
    });
    assert.deepEqual(siteverifyAddresses, [subscriber(1)]);

    // Every address of that /64 is the same client: five more scans spend its
    // six a minute, and a seventh from yet another of its addresses is refused.
    for (let host = 2; host <= 6; host += 1) {
      const next = await scan({ "cf-connecting-ip": subscriber(host) });
      assert.equal(next.status, 200, `scan ${host} of the subscriber`);
      await next.text();
    }
    const seventh = await scan({ "cf-connecting-ip": subscriber(7) });
    assert.equal(seventh.status, 429);
    assert.equal(((await seventh.json()) as { cause?: string }).cause, "request-limit");
    // The neighbouring /64 is another client with its own allowance.
    const neighbour = await scan({ "cf-connecting-ip": "2001:db8:aaaa:bbbc::1" });
    assert.equal(neighbour.status, 200);
    await neighbour.text();
    assert.deepEqual((await state()).clientMinuteCharges, [1, 6]);

    // A request that carries no Cloudflare address shares one bucket with every
    // other such request: a caller header cannot choose a fresh one.
    const unnamed: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await scan({
        "x-harness-no-client-address": "1",
        "x-real-ip": `198.51.100.${index}`,
        "x-forwarded-for": `203.0.113.${index}`
      });
      unnamed.push(response.status);
      await response.text();
    }
    assert.deepEqual(unnamed, [200, 200, 200, 200, 200, 200, 429]);
    const final = await state();
    assert.deepEqual(final.clientMinuteCharges, [1, 6, 6]);
    assert.equal(final.forwarded.length, 13);
    assert.ok(final.forwarded.slice(7).every((entry) => entry.forwardedFor === null && entry.realIp === null));
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest } from "miniflare";
import { PUBLIC_INGRESS_PREFLIGHT_REFUSAL } from "./public-ingress-preflight";
import { PUBLIC_INGRESS_PREFLIGHT_RATE_LIMIT_PER_MINUTE } from "./public-scan-rate-limit-store";

// The origin test-fixtures/scan-admission-path-runtime.test.ts configures.
const ALLOWED_ORIGIN = "https://sitebehavior.org";
const OTHER_ORIGIN = "https://other-origin.invalid";

test("the production Worker refuses a client past the ingress preflight ceiling with the sentence and its headers", { timeout: 60_000 }, async () => {
  // The harness is the real Worker with the container-owning Durable Object
  // replaced by a stand-in that runs the real quota store. Siteverify lands on
  // the outbound service below, never on the network.
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-ingress-preflight-"));
  const siteverifyCalls: string[] = [];
  let mf: Miniflare | undefined;
  try {
    execFileSync(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "deploy", "test-fixtures/scan-admission-path-runtime.test.ts",
      "--dry-run", "--outdir", dir, "--name", "ingress-preflight", "--compatibility-date", "2026-06-19",
      "--compatibility-flags", "nodejs_compat"
    ], { cwd: process.cwd(), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
    mf = new Miniflare({
      modules: true, scriptPath: path.join(dir, "scan-admission-path-runtime.test.js"), modulesRoot: dir,
      compatibilityDate: "2026-06-19", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SCANNER: { className: "ScanAdmissionPathHarness", useSQLite: true } },
      durableObjectsPersist: false, log: new Log(LogLevel.ERROR),
      // A recognized secret with the probe's dummy token: Siteverify's answer
      // for a configured key.
      outboundService: async (request: MiniflareRequest) => {
        siteverifyCalls.push(new URL(request.url).host);
        return new MiniflareResponse(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { headers: { "content-type": "application/json" } }
        );
      }
    });
    const preflight = (client: string, origin: string) =>
      mf!.dispatchFetch("https://scanner.invalid/api/health/public-ingress", {
        headers: { "cf-connecting-ip": client, origin }
      });

    // The charge is a fixed minute window; start where every request below
    // lands in one window.
    const untilNextMinute = 60_000 - (Date.now() % 60_000);
    if (untilNextMinute < 20_000) await new Promise((resolve) => setTimeout(resolve, untilNextMinute + 100));

    const client = "203.0.113.20";
    for (let request = 1; request <= PUBLIC_INGRESS_PREFLIGHT_RATE_LIMIT_PER_MINUTE; request += 1) {
      const answered = await preflight(client, ALLOWED_ORIGIN);
      assert.equal(answered.status, 200, `request ${request} is within the per-client ceiling`);
      if (request === 1) {
        assert.equal(answered.headers.get("x-content-type-options"), "nosniff", "the preflight's answer is never sniffed");
        assert.equal(answered.headers.get("cache-control"), "no-store", "the preflight's answer is never cached");
        assert.equal(
          ((await answered.json()) as { scope: string }).scope,
          "public-ingress-preflight",
          "the answer is the preflight's own"
        );
      } else {
        await answered.arrayBuffer();
      }
    }
    assert.ok(siteverifyCalls.length > 0, "the preflight did reach the stand-in Siteverify");
    assert.ok(
      siteverifyCalls.every((host) => host === "challenges.cloudflare.com"),
      "no outbound request went anywhere but Siteverify"
    );

    const refused = await preflight(client, ALLOWED_ORIGIN);
    assert.equal(refused.status, 429, "the request past the per-client ceiling is refused");
    const body = (await refused.json()) as { ok: boolean; error: string; retryAfterSeconds: number };
    assert.equal(body.error, PUBLIC_INGRESS_PREFLIGHT_REFUSAL, "the refusal is the health check sentence");
    assert.deepEqual(
      Object.keys(body).sort(),
      ["error", "ok", "retryAfterSeconds"],
      "the body is the gate's refusal shape, without a cause"
    );
    assert.ok(
      Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= 60,
      "the wait is what is left of the minute window"
    );
    assert.equal(refused.headers.get("retry-after"), String(body.retryAfterSeconds), "the refusal sends its wait as Retry-After");
    assert.equal(refused.headers.get("cache-control"), "no-store", "the refusal is never cached");
    assert.equal(refused.headers.get("x-content-type-options"), "nosniff", "the refusal is never sniffed");
    assert.equal(
      refused.headers.get("access-control-allow-origin"),
      ALLOWED_ORIGIN,
      "the allowed origin may read the refusal"
    );

    const foreign = await preflight(client, OTHER_ORIGIN);
    assert.equal(foreign.status, 429, "the same client is still over the ceiling from another origin");
    await foreign.arrayBuffer();
    assert.equal(
      foreign.headers.get("access-control-allow-origin"),
      null,
      "another origin is not allowed to read the refusal"
    );

    const neighbour = await preflight("203.0.113.21", ALLOWED_ORIGIN);
    assert.equal(neighbour.status, 200, "another client is not refused by this client's charges");
    await neighbour.arrayBuffer();
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

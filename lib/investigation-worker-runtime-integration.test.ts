import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest } from "miniflare";
import ts from "typescript";
import {
  AUDIENCE,
  base64url,
  generateSigningKey,
  HEALTH_CLIENT,
  ISSUER,
  OWNER,
  ownerClaims,
  serviceClaims,
  signToken,
  type SigningKey
} from "../investigation/test/token-fixture";

/**
 * The workspace's real bundle on real workerd, where the verifier's WebCrypto, atob
 * and fetch options actually run. Node's differ: workerd refuses redirect: "error",
 * for one. The keys and Access team are generated, so this shows nothing about what
 * the real Access service mints. That waits for a real application to exist.
 */

const ROOT = process.cwd();
const COMMIT = "c".repeat(40);
const BINDINGS = {
  INVESTIGATION_ACCESS_ISSUER: ISSUER,
  INVESTIGATION_ACCESS_AUDIENCE: AUDIENCE,
  INVESTIGATION_OWNER_SUBJECT: OWNER,
  INVESTIGATION_HEALTH_CLIENT_ID: HEALTH_CLIENT,
  SITE_BEHAVIOR_LAB_BUILD_COMMIT: COMMIT
};

const liveTimes = () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return { iat: nowSeconds - 60, nbf: nowSeconds - 60, exp: nowSeconds + 3600 };
};

/** What the real config says, so a changed compatibility date moves this test with it. */
const CONFIG_PATH = "wrangler.investigation.jsonc";
const config = ts.parseConfigFileTextToJson(CONFIG_PATH, readFileSync(path.join(ROOT, CONFIG_PATH), "utf8")).config as { compatibility_date: string };

function bundleWorker(outputDirectory: string): string {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--config", CONFIG_PATH, "--dry-run", "--outdir", outputDirectory],
    // The test's own bound cannot fire while this blocks the event loop.
    { cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe", timeout: 120_000 }
  );
  return path.join(outputDirectory, "investigation-worker.js");
}

function certsBody(key: SigningKey): string {
  return JSON.stringify({ keys: [{ ...key.publicJwk, kid: key.id, alg: "RS256", use: "sig" }] });
}

test(
  "workerd runs the bundled workspace gate: a real signature admits the owner, and everything else is refused",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sbl-investigation-runtime-"));
    let miniflare: Miniflare | undefined;
    let outage: Miniflare | undefined;
    let unconfigured: Miniflare | undefined;
    try {
      const [signing, foreign] = await Promise.all([generateSigningKey("key-1"), generateSigningKey("key-1")]);
      const scriptPath = bundleWorker(directory);
      const outbound: string[] = [];
      const shared = { modules: true, scriptPath, modulesRoot: directory, compatibilityDate: config.compatibility_date, log: new Log(LogLevel.ERROR) };
      miniflare = new Miniflare({
        ...shared,
        bindings: BINDINGS,
        outboundService: (request: MiniflareRequest) => {
          outbound.push(request.url);
          return new MiniflareResponse(certsBody(signing), { headers: { "content-type": "application/json" } });
        }
      });
      const get = (url: string, token?: string, init: { method?: string } = {}) =>
        (miniflare as Miniflare).dispatchFetch(url, {
          ...init,
          headers: token === undefined ? {} : { "cf-access-jwt-assertion": token }
        });
      const workspace = "https://workspace.invalid";

      const noToken = await get(`${workspace}/health`);
      assert.equal(noToken.status, 401);
      assert.deepEqual(await noToken.json(), { error: "access-refused" });
      assert.deepEqual(outbound, [], "no token fetches no key");

      const owner = await signToken(signing, ownerClaims(liveTimes()));
      const health = await get(`${workspace}/health`, owner);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "deny-all", commit: COMMIT });
      assert.deepEqual(outbound, [`${ISSUER}/cdn-cgi/access/certs`], "the keys come from the team's address alone");
      assert.equal(health.headers.get("cache-control"), "no-store");

      const noRoute = await get(`${workspace}/`, owner);
      assert.equal(noRoute.status, 404);
      await noRoute.text();

      const service = await signToken(signing, serviceClaims(liveTimes()));
      const serviceHealth = await get(`${workspace}/health`, service);
      assert.equal(serviceHealth.status, 200);
      await serviceHealth.text();
      const serviceElsewhere = await get(`${workspace}/cases`, service);
      assert.equal(serviceElsewhere.status, 403);
      await serviceElsewhere.text();

      const [header, payload] = owner.split(".");
      const hmac = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(JSON.stringify(signing.publicJwk)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const confusedHeader = base64url(JSON.stringify({ alg: "HS256", kid: signing.id }));
      const confused = `${confusedHeader}.${payload}.${base64url(
        new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${confusedHeader}.${payload}`)))
      )}`;
      for (const [name, token, status] of [
        ["signed by another key", await signToken(foreign, ownerClaims(liveTimes())), 401],
        ["a payload changed after signing", `${header}.${base64url(JSON.stringify(ownerClaims({ ...liveTimes(), email: "x@example.org" })))}.${owner.split(".")[2]}`, 401],
        ["another application's audience", await signToken(signing, ownerClaims({ ...liveTimes(), aud: ["b".repeat(64)] })), 401],
        ["expired", await signToken(signing, ownerClaims({ ...liveTimes(), exp: 1 })), 401],
        ["another person", await signToken(signing, ownerClaims({ ...liveTimes(), sub: "someone-else" })), 401],
        ["a signature of the wrong length", `${header}.${payload}.AAAA`, 401],
        ["alg none", `${base64url(JSON.stringify({ alg: "none", kid: signing.id }))}.${payload}.c2ln`, 401],
        ["HMAC over the public key", confused, 401]
      ] as const) {
        const refused = await get(`${workspace}/health`, token);
        assert.equal(refused.status, status, name);
        assert.deepEqual(await refused.json(), { error: "access-refused" }, name);
      }

      outage = new Miniflare({
        ...shared,
        bindings: BINDINGS,
        outboundService: () => new MiniflareResponse("no", { status: 500 })
      });
      const unavailable = await outage.dispatchFetch(`${workspace}/health`, { headers: { "cf-access-jwt-assertion": owner } });
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), { error: "unavailable" });

      const fetchedWhileUnconfigured: string[] = [];
      unconfigured = new Miniflare({
        ...shared,
        outboundService: (request: MiniflareRequest) => {
          fetchedWhileUnconfigured.push(request.url);
          return new MiniflareResponse("no", { status: 500 });
        }
      });
      const notConfigured = await unconfigured.dispatchFetch(`${workspace}/health`, { headers: { "cf-access-jwt-assertion": owner } });
      assert.equal(notConfigured.status, 503);
      await notConfigured.text();
      assert.deepEqual(fetchedWhileUnconfigured, []);
    } finally {
      await Promise.all([miniflare?.dispose(), outage?.dispose(), unconfigured?.dispose()]);
      await rm(directory, { recursive: true, force: true });
    }
  }
);

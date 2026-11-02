import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { ACCESS_TOKEN_HEADER } from "../core/access-token";
import { VIEWER_ROUTES } from "../core/viewer-routes";
import { BASE_POLICY } from "../core/workspace-response";
import { VIEWER_ORIGIN } from "./memory-case-world";
import { generateSigningKey, serviceClaims, signToken } from "./token-fixture";
import { claimsAt, VIEWER_ENV } from "./viewer-fixture";
import { accessKeysOnly, bundleForWorkerd, COMPATIBILITY_DATE } from "./workerd-bundle";

/**
 * The production entry, as its own config bundles it, on real workerd. It configures no case
 * service, so every case route must answer 503, as a missing configuration does, for the owner
 * and by every method, while health still answers and every other request is refused as before.
 * Nothing deploys: the bundle is `wrangler deploy --dry-run`'s.
 */

const SAMPLE: Readonly<Record<string, string>> = { case: "case-one", slot: "B1", row: "row-one", fact: "fact-one", assertion: "said-one", interpretation: "reading-one", digest: "ab".repeat(32) };

/** A route's path with a well-formed value in each place. */
function concrete(pattern: string): string {
  return pattern.replace(/:([a-z]+)/g, (_, name: string) => SAMPLE[name]);
}

test("the production entry's own bundle answers 503 on every case route, and health still answers", { timeout: 180_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-workspace-entry-"));
  const signing = await generateSigningKey("key-1");
  const nowMs = Date.now();
  const seconds = Math.floor(nowMs / 1000);
  const ownerToken = await signToken(signing, claimsAt(nowMs));
  const serviceToken = await signToken(signing, serviceClaims({ iat: seconds - 60, exp: seconds + 3600 }));
  const outbound = accessKeysOnly(signing);
  let miniflare: Miniflare | undefined;
  try {
    const scriptPath = bundleForWorkerd(null, directory, "investigation-worker.js");
    miniflare = new Miniflare({ modules: true, scriptPath, modulesRoot: directory, compatibilityDate: COMPATIBILITY_DATE, log: new Log(LogLevel.ERROR), bindings: VIEWER_ENV as Record<string, string>, outboundService: outbound.handler });
    const send = async (pathname: string, method: string, token: string | null) => {
      const headers: Record<string, string> = { origin: VIEWER_ORIGIN, "content-type": "application/x-www-form-urlencoded" };
      if (token !== null) headers[ACCESS_TOKEN_HEADER] = token;
      const response = await miniflare?.dispatchFetch(`${VIEWER_ORIGIN}${pathname}`, { method, headers, body: method === "GET" ? undefined : `head=${"0".repeat(64)}` });
      return { status: response?.status, body: await response?.text(), headers: Object.fromEntries(response?.headers ?? []) };
    };

    const health = await send("/health", "GET", ownerToken);
    assert.deepEqual([health.status, JSON.parse(health.body as string)], [200, { status: "deny-all", commit: VIEWER_ENV.SITE_BEHAVIOR_LAB_BUILD_COMMIT }]);
    assert.equal((await send("/health", "GET", serviceToken)).status, 200);
    // The bundle's own gate: a service token's HEAD of health answers, and a write with no Origin, or a cross-site load, is refused before any route.
    const head = await miniflare.dispatchFetch(`${VIEWER_ORIGIN}/health`, { method: "HEAD", headers: { [ACCESS_TOKEN_HEADER]: serviceToken } });
    assert.equal(head.status, 200);
    const unsaid = await miniflare.dispatchFetch(`${VIEWER_ORIGIN}/cases/case-one/assertions`, { method: "POST", headers: { [ACCESS_TOKEN_HEADER]: ownerToken, "content-type": "application/x-www-form-urlencoded" }, body: "head=x" });
    assert.deepEqual([unsaid.status, await unsaid.text()], [403, '{"error":"origin-refused"}']);
    const loaded = await miniflare.dispatchFetch(`${VIEWER_ORIGIN}/cases/case-one`, { headers: { [ACCESS_TOKEN_HEADER]: ownerToken, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } });
    assert.deepEqual([loaded.status, await loaded.text()], [403, '{"error":"origin-refused"}']);

    let routes = 0;
    for (const route of VIEWER_ROUTES) {
      const pathname = concrete(route.path);
      for (const method of [route.method, route.method === "GET" ? "POST" : "GET"]) {
        const answer = await send(pathname, method, ownerToken);
        assert.deepEqual([answer.status, answer.body], [503, '{"error":"unavailable"}'], `${method} ${pathname}`);
        assert.equal(answer.headers["content-security-policy"], BASE_POLICY, `${method} ${pathname}`);
        assert.equal(answer.headers["x-content-type-options"], "nosniff");
        assert.equal(answer.headers["cache-control"], "no-store");
        assert.equal(answer.headers["referrer-policy"], "same-origin");
        assert.equal(answer.headers["cross-origin-opener-policy"], "same-origin");
        assert.equal(answer.headers["cross-origin-resource-policy"], "same-origin");
        for (const token of [null, serviceToken]) assert.equal((await send(pathname, method, token)).status, 401, `${method} ${pathname} with ${token === null ? "no token" : "a service token"}`);
        routes += 1;
      }
    }
    assert.equal(routes, VIEWER_ROUTES.length * 2);
    // What no route names stays not found, with a service or without.
    for (const pathname of ["/", "/cases", "/cases/case-one/approve", "/cases/case-one/export"]) assert.equal((await send(pathname, "GET", ownerToken)).status, 404, pathname);
    assert.deepEqual(outbound.refused, []);
    assert.ok(outbound.keyFetches() >= 1);
  } finally {
    await miniflare?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

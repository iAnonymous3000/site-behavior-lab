import assert from "node:assert/strict";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import { AccessKeySet, ACCESS_TOKEN_HEADER, type VerifiedIdentity } from "../core/access-token";
import * as productionGate from "../core/workspace-gate";
import { handleWorkspaceRequest, type WorkspaceEnv, type WorkspaceRoutes } from "../core/workspace-gate";
import {
  AUDIENCE,
  certsFor,
  generateSigningKey,
  HEALTH_AUDIENCE,
  HEALTH_CLIENT,
  ISSUER,
  NOW_MS,
  OWNER,
  OWNER_EMAIL,
  ownerClaims,
  serviceClaims,
  signToken,
  type SigningKey
} from "./token-fixture";

type GateModule = typeof productionGate;

const COMMIT = "b".repeat(40);
const HOSTNAME = "workspace.example";
const ENV: WorkspaceEnv = {
  INVESTIGATION_ACCESS_ISSUER: ISSUER,
  INVESTIGATION_ACCESS_AUDIENCE: AUDIENCE,
  INVESTIGATION_OWNER_SUBJECT: OWNER,
  INVESTIGATION_OWNER_EMAIL: OWNER_EMAIL,
  INVESTIGATION_HEALTH_CLIENT_ID: HEALTH_CLIENT,
  INVESTIGATION_HEALTH_ACCESS_AUDIENCE: HEALTH_AUDIENCE,
  INVESTIGATION_WORKSPACE_HOSTNAME: HOSTNAME,
  SITE_BEHAVIOR_LAB_BUILD_COMMIT: COMMIT
};

let signing: SigningKey;
let ownerToken: string;
let serviceToken: string;
let otherPersonToken: string;

before(async () => {
  signing = await generateSigningKey("key-1");
  ownerToken = await signToken(signing, ownerClaims());
  serviceToken = await signToken(signing, serviceClaims());
  otherPersonToken = await signToken(signing, ownerClaims({ sub: "11111111-61da-459d-899c-0a01c76a2f94" }));
});

function runtime(routes?: WorkspaceRoutes, fetcher = certsFor(signing).fetcher) {
  const keySet = new AccessKeySet(ISSUER, fetcher, () => NOW_MS);
  // The team's keys and no other's, so a gate that asks for the wrong issuer's set fails here.
  const keySetFor = (issuer: string) => {
    assert.equal(issuer, ISSUER, "the gate asked for another issuer's key set");
    return keySet;
  };
  return { keySetFor, now: () => NOW_MS, ...(routes ? { routes } : {}) };
}

function request(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set(ACCESS_TOKEN_HEADER, token);
  return new Request(`https://${HOSTNAME}${path}`, { ...init, headers });
}

test("positive control: the owner reads health, which reports only that it denies everything", async () => {
  const response = await handleWorkspaceRequest(request("/health", ownerToken), ENV, runtime());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "deny-all", commit: COMMIT });
});

test("positive control: the health service token reads health", async () => {
  const response = await handleWorkspaceRequest(request("/health", serviceToken), ENV, runtime());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "deny-all", commit: COMMIT });
});

test("one application for both kinds works with no change: equal audiences admit the owner and the service token", async () => {
  const oneApplication = { ...ENV, INVESTIGATION_HEALTH_ACCESS_AUDIENCE: AUDIENCE };
  const sharedAudienceToken = await signToken(signing, serviceClaims({ aud: [AUDIENCE] }));
  for (const token of [ownerToken, sharedAudienceToken]) {
    assert.equal((await handleWorkspaceRequest(request("/health", token), oneApplication, runtime())).status, 200);
  }
  assert.equal((await handleWorkspaceRequest(request("/cases", sharedAudienceToken), oneApplication, runtime())).status, 401);
});

test("with two applications, a token bearing the other kind's audience is refused like any other", async () => {
  const routes: WorkspaceRoutes = () => assert.fail("a token bearing the other kind's audience reached a route");
  for (const token of [await signToken(signing, serviceClaims({ aud: [AUDIENCE] })), await signToken(signing, ownerClaims({ aud: [HEALTH_AUDIENCE] }))]) {
    const response = await handleWorkspaceRequest(request("/health", token), ENV, runtime(routes));
    assert.equal(`${response.status} ${await response.text()}`, '401 {"error":"access-refused"}');
  }
});

test("a half-configured health path fails closed for everyone, before any key is fetched", async () => {
  for (const half of [{ INVESTIGATION_HEALTH_ACCESS_AUDIENCE: undefined }, { INVESTIGATION_HEALTH_CLIENT_ID: undefined }, { INVESTIGATION_HEALTH_ACCESS_AUDIENCE: "" }, { INVESTIGATION_HEALTH_CLIENT_ID: "" }]) {
    const certs = certsFor(signing);
    const response = await handleWorkspaceRequest(request("/health", ownerToken), { ...ENV, ...half }, runtime(undefined, certs.fetcher));
    assert.equal(response.status, 503, JSON.stringify(half));
    assert.deepEqual(await response.json(), { error: "unavailable" });
    assert.equal(certs.calls(), 0);
  }
});

test("a build commit that is not a full commit reads as none", async () => {
  const check = async (module: GateModule) => {
    for (const commit of ["main", "abcdef1", "b".repeat(39), "b".repeat(41), "B".repeat(40), `x${"b".repeat(40)}`, `${"b".repeat(40)}\n`, ""]) {
      const response = await module.handleWorkspaceRequest(request("/health", ownerToken), { ...ENV, SITE_BEHAVIOR_LAB_BUILD_COMMIT: commit }, runtime());
      const body = (await response.json()) as { commit: unknown };
      holds("anything but a full commit reads as none", body.commit === null, () => commit);
    }
    const none = await module.handleWorkspaceRequest(request("/health", ownerToken), { ...ENV, SITE_BEHAVIOR_LAB_BUILD_COMMIT: undefined }, runtime());
    holds("no commit reads as none", ((await none.json()) as { commit: unknown }).commit === null, () => "undefined");
  };
  await check(productionGate);
  const pattern = "const FULL_COMMIT = /^[0-9a-f]{40}$/;";
  for (const replace of ["const FULL_COMMIT = /^[0-9a-f]{7,40}$/;", "const FULL_COMMIT = /[0-9a-f]{40}/;", "const FULL_COMMIT = /^[0-9a-f]{40}/;", "const FULL_COMMIT = /[0-9a-f]{40}$/;", "const FULL_COMMIT = /^[0-9a-fA-F]{40}$/;"]) {
    await assertCaughtBy(replace, "anything but a full commit reads as none", () => check(gateVariant({ find: pattern, replace })));
  }
});

test("HEAD is a health read, for the owner and the service token", async () => {
  const check = async (module: GateModule) => {
    for (const token of [ownerToken, serviceToken]) {
      const response = await module.handleWorkspaceRequest(request("/health", token, { method: "HEAD" }), ENV, runtime());
      holds("a HEAD of health answers as a read", response.status === 200, () => response.status);
    }
  };
  await check(productionGate);
  await assertCaughtBy("HEAD dropped from a health read", "a HEAD of health answers as a read", () =>
    check(gateVariant({ find: '(request.method === "GET" || request.method === "HEAD")', replace: 'request.method === "GET"' }))
  );
});

const ALLOWED_HEADERS = { accept: "application/json", "accept-language": "en", "content-length": "7", "content-type": "text/plain", "if-none-match": "tag" };
const DISALLOWED_HEADERS = {
  authorization: "Bearer forged",
  cookie: "a=b",
  "cf-access-authenticated-user-email": "someone-else@example.org",
  "cf-access-client-id": "forged",
  "cf-connecting-ip": "203.0.113.1",
  "cf-ipcountry": "XX",
  "cf-ray": "ray",
  "cf-visitor": "visitor",
  forwarded: "for=203.0.113.1",
  host: "attacker.example",
  origin: "https://attacker.example",
  referer: "https://attacker.example/",
  "remote-user": "someone-else",
  "true-client-ip": "203.0.113.1",
  "user-agent": "agent",
  via: "proxy",
  "x-custom-identity": "someone-else",
  "x-forwarded-email": "someone-else@example.org",
  "x-forwarded-for": "203.0.113.1",
  "x-forwarded-host": "attacker.example",
  "x-real-ip": "203.0.113.1"
};

test("a route's request holds exactly the headers it may read, and is built to follow no redirect", async () => {
  const check = async (module: GateModule) => {
    let seen: Request | undefined;
    const routes: WorkspaceRoutes = (forwarded) => {
      seen = forwarded;
      return new Response("reached");
    };
    await module.handleWorkspaceRequest(
      request("/cases", ownerToken, { method: "POST", body: "payload", headers: { ...ALLOWED_HEADERS, ...DISALLOWED_HEADERS } }),
      ENV,
      runtime(routes)
    );
    const names = [...(seen as Request).headers.keys()].sort();
    holds("a route reads exactly the allowed headers", JSON.stringify(names) === JSON.stringify(Object.keys(ALLOWED_HEADERS).sort()), () => names);
    for (const [name, value] of Object.entries(ALLOWED_HEADERS)) {
      holds("an allowed header arrives as it was sent", (seen as Request).headers.get(name) === value, () => name);
    }
    holds("a route's request follows no redirect", (seen as Request).redirect === "manual", () => (seen as Request).redirect);
  };
  await check(productionGate);
  const forwarded = '"accept", "accept-language", "content-length", "content-type", "if-none-match"';
  await assertCaughtBy("a client's address passed on", "a route reads exactly the allowed headers", () =>
    check(gateVariant({ find: forwarded, replace: `${forwarded}, "cf-connecting-ip", "x-forwarded-for", "true-client-ip"` }))
  );
  await assertCaughtBy("a shorter list", "a route reads exactly the allowed headers", () => check(gateVariant({ find: forwarded, replace: '"accept", "content-type"' })));
  await assertCaughtBy("the redirect rule", "a route's request follows no redirect", () => check(gateVariant({ find: 'headers, redirect: "manual" }', replace: "headers }" })));
});

test("every response holds exactly the headers it should", async () => {
  const check = async (module: GateModule) => {
    for (const token of [ownerToken, null]) {
      const response = await module.handleWorkspaceRequest(request("/health", token), ENV, runtime());
      holds(
        "a response's headers are the stated ones",
        JSON.stringify([...response.headers.entries()].sort()) ===
          JSON.stringify([
            ["cache-control", "no-store"],
            ["content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"],
            ["content-type", "application/json; charset=utf-8"],
            ["referrer-policy", "no-referrer"],
            ["x-content-type-options", "nosniff"]
          ]),
        () => [...response.headers.entries()]
      );
    }
  };
  await check(productionGate);
  for (const [name, edit] of [
    ["the referrer policy", { find: '"referrer-policy": "no-referrer",', replace: "" }],
    ["base-uri", { find: "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", replace: "default-src 'none'; frame-ancestors 'none'" }],
    ["the content type", { find: '"content-type": "application/json; charset=utf-8",', replace: "" }],
    ["the cache rule", { find: '"cache-control": "no-store",', replace: "" }],
    ["nosniff", { find: '"x-content-type-options": "nosniff"', replace: '"x-other": "nosniff"' }]
  ] as const) {
    await assertCaughtBy(name, "a response's headers are the stated ones", () => check(gateVariant(edit)));
  }
});

test("the keys come from the configured team and no other", async () => {
  const asked: string[] = [];
  const check = async (module: GateModule) => {
    asked.length = 0;
    const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, () => NOW_MS);
    await module.handleWorkspaceRequest(request("/health", ownerToken), ENV, {
      keySetFor: (issuer) => {
        asked.push(issuer);
        return keySet;
      },
      now: () => NOW_MS
    });
    holds("the gate asks for the configured team's key set", JSON.stringify(asked) === JSON.stringify([ISSUER]), () => asked);
  };
  await check(productionGate);
  await assertCaughtBy("another team's key set", "the gate asks for the configured team's key set", () =>
    check(gateVariant({ find: "runtime.keySetFor(config.policy.issuer)", replace: 'runtime.keySetFor("https://attacker.cloudflareaccess.com")' }))
  );
});

test("a genuine service token out of its scope answers exactly as a forged token does", async () => {
  const check = async (module: GateModule) => {
    const answer = async (token: string) => {
      const response = await module.handleWorkspaceRequest(request("/cases", token), ENV, runtime());
      return JSON.stringify([response.status, await response.text(), [...response.headers.entries()].sort()]);
    };
    const genuine = await answer(serviceToken);
    const forged = await answer("a.b.c");
    holds("a refusal cannot tell a genuine service token from a forged one", genuine === forged, () => ({ genuine, forged }));
  };
  await check(productionGate);
  await assertCaughtBy("a status of its own", "a refusal cannot tell a genuine service token from a forged one", () =>
    check(gateVariant({ find: 'if (decision.identity.kind === "health-service" && !isHealthRead(request))\n        return refusalResponse(401);', replace: 'if (decision.identity.kind === "health-service" && !isHealthRead(request))\n        return refusalResponse(403);' }))
  );
});

test("a GET or HEAD that declares a body passes none on, and does not fail for it", async () => {
  // Node's Request cannot build this, so the stream is laid over one here. The real
  // input, on real workerd, is in lib/investigation-worker-runtime-integration.test.ts.
  const declaring = (method: string, token: string) => {
    const built = request("/health", token, { method });
    Object.defineProperty(built, "body", { value: new Response("declared").body });
    return built;
  };
  const check = async (module: GateModule) => {
    for (const method of ["GET", "HEAD"]) {
      for (const token of [ownerToken, serviceToken]) {
        let status: number | string;
        try {
          status = (await module.handleWorkspaceRequest(declaring(method, token), ENV, runtime())).status;
        } catch {
          status = "threw";
        }
        holds("a declared body on a read costs nothing", status === 200, () => ({ method, status }));
      }
    }
  };
  await check(productionGate);
  await assertCaughtBy("copying the body for any method", "a declared body on a read costs nothing", () =>
    check(gateVariant({ find: 'if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {', replace: "if (request.body !== null) {" }))
  );
  await assertCaughtBy("copying the body on HEAD", "a declared body on a read costs nothing", () =>
    check(gateVariant({ find: 'if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {', replace: 'if (request.method !== "GET" && request.body !== null) {' }))
  );
});

test("the owner has no route but health yet", async () => {
  for (const path of ["/", "/cases", "/health/", "/health.json", "/HEALTH"]) {
    assert.equal((await handleWorkspaceRequest(request(path, ownerToken), ENV, runtime())).status, 404, path);
  }
  const post = await handleWorkspaceRequest(request("/health", ownerToken, { method: "POST" }), ENV, runtime());
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("a service token reaches health and nothing else, whatever the method", async () => {
  const reached: string[] = [];
  const routes: WorkspaceRoutes = (seen) => {
    reached.push(`${seen.method} ${new URL(seen.url).pathname}`);
    return new Response("reached");
  };
  for (const [path, method] of [
    ["/", "GET"],
    ["/cases", "GET"],
    ["/health/", "GET"],
    ["/health", "POST"],
    ["/health", "DELETE"]
  ] as const) {
    const response = await handleWorkspaceRequest(request(path, serviceToken, { method }), ENV, runtime(routes));
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "access-refused" });
  }
  assert.deepEqual(reached, []);
  assert.equal((await handleWorkspaceRequest(request("/health", serviceToken), ENV, runtime(routes))).status, 200);
  assert.deepEqual(reached, ["GET /health"]);
});

test("no token, or anyone else's, reaches no route", async () => {
  const routes: WorkspaceRoutes = () => assert.fail("a refused request reached a route");
  assert.equal((await handleWorkspaceRequest(request("/health", null), ENV, runtime(routes))).status, 401);
  assert.equal((await handleWorkspaceRequest(request("/health", "not-a-token"), ENV, runtime(routes))).status, 401);
  assert.equal((await handleWorkspaceRequest(request("/health", otherPersonToken), ENV, runtime(routes))).status, 401);
});

test("a forged identity header admits no one", async () => {
  const forged = {
    "cf-access-authenticated-user-email": "owner@example.org",
    "x-forwarded-email": "owner@example.org",
    "x-auth-request-email": "owner@example.org",
    "remote-user": OWNER,
    authorization: "Bearer forged",
    cookie: "CF_Authorization=forged"
  };
  const routes: WorkspaceRoutes = () => assert.fail("a forged identity reached a route");
  const noToken = await handleWorkspaceRequest(request("/health", null, { headers: forged }), ENV, runtime(routes));
  assert.equal(noToken.status, 401);
  const someoneElse = await handleWorkspaceRequest(request("/health", otherPersonToken, { headers: forged }), ENV, runtime(routes));
  assert.equal(someoneElse.status, 401);
});

test("a token in the session cookie alone is not read", async () => {
  // Access does not guarantee the cookie reaches an origin, so the header decides.
  const routes: WorkspaceRoutes = () => assert.fail("a cookie admitted a request");
  const response = await handleWorkspaceRequest(
    request("/health", null, { headers: { cookie: `CF_Authorization=${ownerToken}` } }),
    ENV,
    runtime(routes)
  );
  assert.equal(response.status, 401);
});

test("a route receives the verified identity and a request with no identity left in it", async () => {
  let seenHeaders: Headers | undefined;
  let seenIdentity: VerifiedIdentity | undefined;
  const routes: WorkspaceRoutes = (seen, identity) => {
    seenHeaders = seen.headers;
    seenIdentity = identity;
    return new Response("reached");
  };
  await handleWorkspaceRequest(
    request("/cases", ownerToken, {
      method: "POST",
      body: "{}",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: `CF_Authorization=${ownerToken}`,
        authorization: "Bearer forged",
        "cf-access-authenticated-user-email": "someone-else@example.org",
        "cf-access-client-id": "forged",
        "cf-access-client-secret": "forged",
        "x-forwarded-email": "someone-else@example.org",
        "x-forwarded-user": "someone-else",
        "x-auth-request-email": "someone-else@example.org",
        "remote-user": "someone-else",
        "x-custom-identity": "someone-else"
      }
    }),
    ENV,
    runtime(routes)
  );
  assert.deepEqual([...(seenHeaders as Headers).keys()].sort(), ["accept", "content-type"]);
  assert.equal(seenIdentity?.kind, "owner");
  assert.equal(seenIdentity?.kind === "owner" ? seenIdentity.email : null, OWNER_EMAIL);
});

test("nothing the platform attached to a request reaches a route", async () => {
  // A Worker's request carries request.cf, which can hold client certificate details.
  const attached = request("/cases", ownerToken);
  Object.defineProperty(attached, "cf", { value: { tlsClientAuth: { certSubjectDN: "CN=someone-else" } } });
  const seen = async (module: GateModule) => {
    let hasCf = false;
    await module.handleWorkspaceRequest(attached.clone() as Request, ENV, runtime((forwarded) => {
      hasCf = "cf" in forwarded;
      return new Response("reached");
    }));
    return hasCf;
  };
  assert.equal(await seen(productionGate), false);
  let copied = false;
  const copying = gateVariant({ find: "return new Request(request.url, init);", replace: "const copy = new Request(request, init); copy.cf = request.cf; return copy;" });
  const withCf = request("/cases", ownerToken);
  Object.defineProperty(withCf, "cf", { value: { tlsClientAuth: {} } });
  await copying.handleWorkspaceRequest(withCf, ENV, runtime((forwarded) => {
    copied = "cf" in forwarded;
    return new Response("reached");
  }));
  assert.equal(copied, true);
});

test("a route still receives the request's method, address and body", async () => {
  let body: string | undefined;
  let method: string | undefined;
  let url: string | undefined;
  const routes: WorkspaceRoutes = async (seen) => {
    method = seen.method;
    url = seen.url;
    body = await seen.text();
    return new Response("reached");
  };
  await handleWorkspaceRequest(request("/cases?x=1", ownerToken, { method: "POST", body: "payload" }), ENV, runtime(routes));
  assert.deepEqual([method, url, body], ["POST", "https://workspace.example/cases?x=1", "payload"]);
});

test("missing or malformed configuration fails closed, before any key is fetched", async () => {
  for (const name of [
    "INVESTIGATION_ACCESS_ISSUER",
    "INVESTIGATION_ACCESS_AUDIENCE",
    "INVESTIGATION_OWNER_SUBJECT",
    "INVESTIGATION_OWNER_EMAIL",
    "INVESTIGATION_WORKSPACE_HOSTNAME"
  ] as const) {
    for (const value of [undefined, "", "has a space"]) {
      const certs = certsFor(signing);
      const response = await handleWorkspaceRequest(request("/health", ownerToken), { ...ENV, [name]: value }, runtime(undefined, certs.fetcher));
      assert.equal(response.status, 503, `${name}=${value}`);
      assert.deepEqual(await response.json(), { error: "unavailable" });
      assert.equal(certs.calls(), 0);
    }
  }
});

test("a key set that cannot be read fails closed as unavailable, not as a refusal or a pass", async () => {
  const certs = certsFor(signing);
  certs.respond(() => Promise.reject(new Error("offline")));
  const routes: WorkspaceRoutes = () => assert.fail("a request reached a route with no key set");
  const response = await handleWorkspaceRequest(request("/health", ownerToken), ENV, runtime(routes, certs.fetcher));
  assert.equal(response.status, 503);
});

test("a refused token learns nothing of why, not even that it was genuine, and every response forbids caching and framing", async () => {
  const answers = new Set<string>();
  for (const token of [
    null,
    "not-a-token",
    await signToken(signing, ownerClaims({ aud: ["b".repeat(64)] })),
    await signToken(signing, ownerClaims({ exp: 1 })),
    otherPersonToken,
    await signToken(signing, ownerClaims({ email: "someone-else@example.org" })),
    await signToken(signing, serviceClaims({ common_name: "other.access" }))
  ]) {
    const response = await handleWorkspaceRequest(request("/health", token), ENV, runtime());
    answers.add(`${response.status} ${await response.text()}`);
  }
  assert.deepEqual([...answers], ['401 {"error":"access-refused"}']);
  for (const response of [
    await handleWorkspaceRequest(request("/health", ownerToken), ENV, runtime()),
    await handleWorkspaceRequest(request("/nope", ownerToken), ENV, runtime()),
    await handleWorkspaceRequest(request("/health", null), ENV, runtime())
  ]) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

const gatePath = require.resolve("../core/workspace-gate");
const gateVariant = (...edits: SourceEdit[]) => loadVariant<GateModule>(gatePath, edits);

test("removing the service token scope lets it reach a route, so that check is what stops it", async () => {
  const reached = async (module: GateModule) => {
    let hit = false;
    await module.handleWorkspaceRequest(request("/cases", serviceToken), ENV, runtime(() => ((hit = true), new Response("reached"))));
    return hit;
  };
  assert.equal(await reached(productionGate), false);
  const broken = gateVariant({
    find: 'if (decision.identity.kind === "health-service" && !isHealthRead(request))\n        return refusalResponse(401);',
    replace: ""
  });
  assert.equal(await reached(broken), true);
});

test("removing the header strip hands a route the forged identity, so that step is what removes it", async () => {
  const seen = async (module: GateModule) => {
    let email: string | null = null;
    await module.handleWorkspaceRequest(
      request("/cases", ownerToken, { headers: { "cf-access-authenticated-user-email": "someone-else@example.org" } }),
      ENV,
      runtime((forwarded) => {
        email = forwarded.headers.get("cf-access-authenticated-user-email");
        return new Response("reached");
      })
    );
    return email;
  };
  assert.equal(await seen(productionGate), null);
  const broken = gateVariant({ find: "withoutInboundIdentity(request), decision.identity", replace: "request, decision.identity" });
  assert.equal(await seen(broken), "someone-else@example.org");
});

test("removing the verdict check lets a refused token through, so that check is what stops it", async () => {
  const statusOf = async (module: GateModule) => {
    try {
      return (await module.handleWorkspaceRequest(request("/health", otherPersonToken), ENV, runtime())).status;
    } catch {
      return "threw";
    }
  };
  assert.equal(await statusOf(productionGate), 401);
  const broken = gateVariant({
    find: 'if (!decision.ok)\n        return refusalResponse(decision.refusal === "keys-unavailable" ? 503 : 401);',
    replace: 'if (!decision.ok)\n        decision.identity = { kind: "owner" };'
  });
  assert.equal(await statusOf(broken), 200);
});

test("removing the outage status reads a key set outage as a refused token", async () => {
  const statusOf = async (module: GateModule) => {
    const certs = certsFor(signing);
    certs.respond(() => Promise.reject(new Error("offline")));
    return (await module.handleWorkspaceRequest(request("/health", ownerToken), ENV, runtime(undefined, certs.fetcher))).status;
  };
  assert.equal(await statusOf(productionGate), 503);
  assert.equal(await statusOf(gateVariant({ find: 'decision.refusal === "keys-unavailable" ? 503 : 401', replace: "401" })), 401);
});

test("the configuration check is what answers: without it, a missing policy throws instead", async () => {
  const statusOf = async (module: GateModule) => {
    try {
      return (await module.handleWorkspaceRequest(request("/health", ownerToken), { ...ENV, INVESTIGATION_OWNER_SUBJECT: undefined }, runtime())).status;
    } catch {
      return "threw";
    }
  };
  assert.equal(await statusOf(productionGate), 503);
  const broken = gateVariant({ find: "if (config === null)\n        return refusalResponse(503);", replace: "" });
  assert.equal(await statusOf(broken), "threw");
});

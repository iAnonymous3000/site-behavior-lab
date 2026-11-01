import assert from "node:assert/strict";
import { before, test } from "node:test";
import { loadVariant, type SourceEdit } from "../../lib/finite-check";
import { AccessKeySet, ACCESS_TOKEN_HEADER, type VerifiedIdentity } from "../core/access-token";
import * as productionGate from "../core/workspace-gate";
import { handleWorkspaceRequest, type WorkspaceEnv, type WorkspaceRoutes } from "../core/workspace-gate";
import {
  AUDIENCE,
  certsFor,
  generateSigningKey,
  HEALTH_CLIENT,
  ISSUER,
  NOW_MS,
  OWNER,
  ownerClaims,
  serviceClaims,
  signToken,
  type SigningKey
} from "./token-fixture";

type GateModule = typeof productionGate;

const COMMIT = "b".repeat(40);
const ENV: WorkspaceEnv = {
  INVESTIGATION_ACCESS_ISSUER: ISSUER,
  INVESTIGATION_ACCESS_AUDIENCE: AUDIENCE,
  INVESTIGATION_OWNER_SUBJECT: OWNER,
  INVESTIGATION_HEALTH_CLIENT_ID: HEALTH_CLIENT,
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
  return { keySetFor: () => keySet, now: () => NOW_MS, ...(routes ? { routes } : {}) };
}

function request(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set(ACCESS_TOKEN_HEADER, token);
  return new Request(`https://workspace.example${path}`, { ...init, headers });
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

test("a build commit that is not a full commit reads as none", async () => {
  const response = await handleWorkspaceRequest(request("/health", ownerToken), { ...ENV, SITE_BEHAVIOR_LAB_BUILD_COMMIT: "main" }, runtime());
  assert.deepEqual(await response.json(), { status: "deny-all", commit: null });
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
    assert.equal(response.status, 403, `${method} ${path}`);
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
  assert.equal(seenIdentity?.kind === "owner" ? seenIdentity.email : null, "owner@example.org");
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
  for (const name of ["INVESTIGATION_ACCESS_ISSUER", "INVESTIGATION_ACCESS_AUDIENCE", "INVESTIGATION_OWNER_SUBJECT"] as const) {
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
    find: 'if (decision.identity.kind === "health-service" && !isHealthRead(request))\n        return refusalResponse(403);',
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
  const broken = gateVariant({ find: "if (policy === null)\n        return refusalResponse(503);", replace: "" });
  assert.equal(await statusOf(broken), "threw");
});

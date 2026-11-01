import assert from "node:assert/strict";
import { before, test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "../../lib/finite-check";
import * as productionModule from "../core/access-token";
import { accessPolicyFrom, AccessKeySet, KEY_SET_REFETCH_INTERVAL_MS, KEY_SET_TRUST_MS, verifyAccessToken } from "../core/access-token";
import {
  AUDIENCE,
  base64url,
  certsFor,
  certsResponse,
  generateSigningKey,
  HEALTH_AUDIENCE,
  HEALTH_CLIENT,
  ISSUER,
  NOW_MS,
  NOW_SECONDS,
  OWNER,
  OWNER_EMAIL,
  ownerClaims,
  POLICY,
  serviceClaims,
  signPayloadBytes,
  signToken,
  type SigningKey
} from "./token-fixture";

/**
 * The verifier against generated keys. Every refusal has a positive control beside
 * it, and the guards named at the end each have a broken variant, so a test cannot
 * pass because some other guard answered first. No real Access token, team or key
 * is involved: whether the real service mints what this expects is checked against
 * it once an application exists.
 */

type TokenModule = typeof productionModule;

let signing: SigningKey;
let foreign: SigningKey;
let rotated: SigningKey;

before(async () => {
  [signing, foreign, rotated] = await Promise.all(["key-1", "key-1", "key-2"].map((id) => generateSigningKey(id)));
});

const clock = (at = NOW_MS) => () => at;

async function decide(token: string | null, module: TokenModule = productionModule) {
  const keySet = new module.AccessKeySet(ISSUER, certsFor(signing).fetcher, clock());
  return module.verifyAccessToken(token, POLICY, keySet, clock());
}

async function refusalOf(token: string | null, module: TokenModule = productionModule) {
  const decision = await decide(token, module);
  return decision.ok ? "accepted" : decision.refusal;
}

test("positive control: the owner's token is accepted, and identity comes from its claims", async () => {
  const decision = await decide(await signToken(signing, ownerClaims()));
  assert.deepEqual(decision, {
    ok: true,
    identity: { kind: "owner", issuer: ISSUER, subject: OWNER, email: "owner@example.org", issuedAt: NOW_SECONDS - 60, expiresAt: NOW_SECONDS + 3600 }
  });
});

test("positive control: the health service token is accepted as that and nothing more", async () => {
  const decision = await decide(await signToken(signing, serviceClaims()));
  assert.deepEqual(decision, {
    ok: true,
    identity: { kind: "health-service", issuer: ISSUER, clientId: HEALTH_CLIENT, issuedAt: NOW_SECONDS - 60, expiresAt: NOW_SECONDS + 3600 }
  });
});

test("positive control: aud as a single string, and a token without nbf, are accepted", async () => {
  assert.equal(await refusalOf(await signToken(signing, ownerClaims({ aud: AUDIENCE }))), "accepted");
  assert.equal(await refusalOf(await signToken(signing, ownerClaims({ nbf: undefined }))), "accepted");
});

test("a request with no token is refused", async () => {
  assert.equal(await refusalOf(null), "missing-token");
  assert.equal(await refusalOf(""), "missing-token");
});

test("a token of the wrong shape is refused before any key is fetched", async () => {
  const token = await signToken(signing, ownerClaims());
  const [header, payload, signature] = token.split(".");
  const certs = certsFor(signing);
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, clock());
  for (const malformed of [
    "abc",
    `${header}.${payload}`,
    `${token}.extra`,
    `${header}.${payload}.`,
    `${header}.${payload}.${signature}=`,
    `${header}.${payload}.${signature.replaceAll("-", "+")}+`,
    `${base64url("not json")}.${payload}.${signature}`,
    `${base64url("[1]")}.${payload}.${signature}`,
    `!!!.${payload}.${signature}`,
    `${header}.!!!.${signature}`,
    `${header}.${payload}.!!!`,
    "A".repeat(16_385)
  ]) {
    const decision = await verifyAccessToken(malformed, POLICY, keySet, clock());
    assert.deepEqual(decision, { ok: false, refusal: "malformed-token" }, malformed.slice(0, 60));
  }
  const noKeyId = await signToken(signing, ownerClaims(), { kid: undefined });
  assert.deepEqual(await verifyAccessToken(noKeyId, POLICY, keySet, clock()), { ok: false, refusal: "malformed-token" });
  assert.equal(certs.calls(), 0);
});

test("a signature spelled with stray trailing bits is refused", async () => {
  // A 256-byte signature leaves unused bits in its last base64url character.
  const token = await signToken(signing, ownerClaims());
  const [header, payload, signature] = token.split(".");
  const last = signature.at(-1) as string;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const respelled = alphabet[alphabet.indexOf(last) + 1];
  assert.equal(await refusalOf(`${header}.${payload}.${signature.slice(0, -1)}${respelled}`), "malformed-token");
});

test("only RS256 is accepted, and no key is fetched for anything else", async () => {
  const claims = base64url(JSON.stringify(ownerClaims()));
  const certs = certsFor(signing);
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, clock());
  for (const alg of ["none", "None", "NONE", "HS256", "RS512", "ES256", "PS256", "rs256", "", null, undefined]) {
    const header = base64url(JSON.stringify({ alg, kid: signing.id }));
    assert.deepEqual(await verifyAccessToken(`${header}.${claims}.c2ln`, POLICY, keySet, clock()), { ok: false, refusal: "unsupported-algorithm" }, String(alg));
  }
  assert.equal(certs.calls(), 0);
});

test("a token signed with HMAC over the public key is refused (algorithm confusion)", async () => {
  const header = base64url(JSON.stringify({ alg: "HS256", kid: signing.id }));
  const payload = base64url(JSON.stringify(ownerClaims()));
  const secret = new TextEncoder().encode(JSON.stringify(signing.publicJwk));
  const hmac = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${header}.${payload}`));
  assert.equal(await refusalOf(`${header}.${payload}.${base64url(new Uint8Array(signature))}`), "unsupported-algorithm");
});

test("a critical header extension is refused", async () => {
  assert.equal(await refusalOf(await signToken(signing, ownerClaims(), { crit: ["exp"] })), "unsupported-algorithm");
});

test("a key named in the token itself is never used", async () => {
  // Signed by a foreign key that names itself in the header: the set decides.
  const token = await signToken(foreign, ownerClaims(), { jwk: foreign.publicJwk, jku: "https://attacker.example/keys" });
  assert.equal(await refusalOf(token), "bad-signature");
});

test("a token signed by another key under the same id is refused", async () => {
  assert.equal(await refusalOf(await signToken(foreign, ownerClaims())), "bad-signature");
});

test("a payload changed after signing is refused", async () => {
  const signed = await signToken(signing, ownerClaims({ sub: "someone-else" }));
  const [header, , signature] = signed.split(".");
  assert.equal(await refusalOf(`${header}.${base64url(JSON.stringify(ownerClaims()))}.${signature}`), "bad-signature");
});

for (const [name, claims, refusal] of [
  ["another team's issuer", { iss: "https://other.cloudflareaccess.com" }, "wrong-issuer"],
  ["no issuer", { iss: undefined }, "wrong-issuer"],
  ["another application's audience", { aud: ["b".repeat(64)] }, "wrong-audience"],
  ["an empty audience", { aud: [] }, "wrong-audience"],
  ["no audience", { aud: undefined }, "wrong-audience"],
  ["an organization token", { type: "org" }, "wrong-token-type"],
  ["no token type", { type: undefined }, "wrong-token-type"],
  ["an expiry just reached", { exp: NOW_SECONDS }, "expired"],
  ["an expiry past", { exp: NOW_SECONDS - 1 }, "expired"],
  ["no expiry", { exp: undefined }, "malformed-claims"],
  ["a text expiry", { exp: String(NOW_SECONDS + 3600) }, "malformed-claims"],
  ["no issue time", { iat: undefined }, "malformed-claims"],
  ["a text not-before", { nbf: "soon" }, "malformed-claims"],
  ["a not-before past the skew", { nbf: NOW_SECONDS + 11 }, "not-yet-valid"],
  ["an issue time past the skew", { iat: NOW_SECONDS + 11 }, "not-yet-valid"],
  ["another person", { sub: "11111111-61da-459d-899c-0a01c76a2f94" }, "not-the-owner-subject"],
  ["the owner's email under another subject", { sub: "11111111-61da-459d-899c-0a01c76a2f94", email: OWNER_EMAIL }, "not-the-owner-subject"],
  ["the owner's subject with another email", { email: "someone-else@example.org" }, "not-the-owner-email"],
  ["the owner's email spelled in another case", { email: "Owner@Example.org" }, "not-the-owner-email"],
  ["no subject", { sub: undefined }, "malformed-claims"],
  ["a number subject", { sub: 7 }, "malformed-claims"],
  ["no email", { email: undefined }, "malformed-claims"],
  ["an empty email", { email: "" }, "malformed-claims"],
  ["the owner's subject and a client id", { common_name: HEALTH_CLIENT }, "malformed-claims"]
] as const) {
  test(`a token with ${name} is refused as ${refusal}`, async () => {
    assert.equal(await refusalOf(await signToken(signing, ownerClaims(claims))), refusal);
  });
}

test("the clock allowance covers a token just minted and nothing further", async () => {
  assert.equal(await refusalOf(await signToken(signing, ownerClaims({ nbf: NOW_SECONDS + 10, iat: NOW_SECONDS + 10 }))), "accepted");
  assert.equal(await refusalOf(await signToken(signing, ownerClaims({ exp: NOW_SECONDS + 1 }))), "accepted");
});

for (const [name, claims, refusal] of [
  ["another client id", { common_name: "other.access" }, "unrecognized-service-token"],
  ["no client id", { common_name: undefined }, "malformed-claims"],
  ["an empty client id", { common_name: "" }, "malformed-claims"],
  ["another team's issuer", { iss: "https://other.cloudflareaccess.com" }, "wrong-issuer"],
  ["an expiry past", { exp: NOW_SECONDS - 1 }, "expired"]
] as const) {
  test(`a service token with ${name} is refused as ${refusal}`, async () => {
    assert.equal(await refusalOf(await signToken(signing, serviceClaims(claims))), refusal);
  });
}

test("with no health client configured, no service token is admitted", async () => {
  const policy = { ...POLICY, healthClientId: null, healthAudience: null };
  const keySet = new AccessKeySet(ISSUER, certsFor(signing).fetcher, clock());
  for (const claims of [serviceClaims(), serviceClaims({ aud: [AUDIENCE] })]) {
    const decision = await verifyAccessToken(await signToken(signing, claims), policy, keySet, clock());
    assert.deepEqual(decision, { ok: false, refusal: "unrecognized-service-token" });
  }
});

test("an unknown key id refetches once, and a flood of them costs nothing more", async () => {
  const certs = certsFor(signing);
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const unknown = await signToken(rotated, ownerClaims());
  assert.deepEqual(await verifyAccessToken(unknown, POLICY, keySet, () => now), { ok: false, refusal: "unknown-key" });
  assert.equal(certs.calls(), 1, "a first miss fetches once");
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(await verifyAccessToken(unknown, POLICY, keySet, () => now), { ok: false, refusal: "unknown-key" });
  }
  assert.equal(certs.calls(), 1, "misses inside the interval fetch nothing");
  now += KEY_SET_REFETCH_INTERVAL_MS;
  await verifyAccessToken(unknown, POLICY, keySet, () => now);
  assert.equal(certs.calls(), 2, "a miss after the interval fetches once more");
});

test("a rotated key is picked up on its first miss after the interval", async () => {
  const certs = certsFor(signing);
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const decisionAt = async (key: SigningKey) => verifyAccessToken(await signToken(key, ownerClaims()), POLICY, keySet, () => now);
  assert.equal((await decisionAt(signing)).ok, true);
  certs.respond(() => certsResponse(signing, rotated));
  now += KEY_SET_REFETCH_INTERVAL_MS;
  assert.equal((await decisionAt(rotated)).ok, true);
  assert.equal(certs.calls(), 2);
});

test("a known key does not refetch while the set is trusted", async () => {
  const certs = certsFor(signing);
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const token = await signToken(signing, ownerClaims());
  for (let step = 0; step < 4; step += 1) {
    assert.equal((await verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
    now += KEY_SET_TRUST_MS / 5;
  }
  assert.equal(certs.calls(), 1);
});

test("a key removed from the set stops working when the set is next read", async () => {
  const certs = certsFor(signing, rotated);
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const token = await signToken(signing, ownerClaims());
  assert.equal((await verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
  certs.respond(() => certsResponse(rotated));
  now += KEY_SET_TRUST_MS;
  assert.deepEqual(await verifyAccessToken(token, POLICY, keySet, () => now), { ok: false, refusal: "unknown-key" });
});

/** Each answer but the plain failures carries a good key set, so only the guard named can refuse it. */
const keySetBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ keys: [{ ...signing.publicJwk, kid: signing.id, alg: "RS256", use: "sig" }], ...extra });

for (const [name, response] of [
  ["a network failure", () => Promise.reject(new Error("offline"))],
  ["a server error", () => new Response(keySetBody(), { status: 500 })],
  ["a redirect", () => new Response(keySetBody(), { status: 302, headers: { location: "https://attacker.example/keys" } })],
  ["not JSON", () => new Response("<html>")],
  ["no key list", () => Response.json({ public_cert: {} })],
  ["an empty key list", () => Response.json({ keys: [] })],
  ["an oversized key set", () => new Response(keySetBody({ padding: "x".repeat(70_000) }))],
  ["a declared oversize", () => new Response(keySetBody(), { headers: { "content-length": "70000" } })]
] as const) {
  test(`${name} from the key set fails closed`, async () => {
    const certs = certsFor(signing);
    certs.respond(response);
    const keySet = new AccessKeySet(ISSUER, certs.fetcher, clock());
    const decision = await verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
    assert.deepEqual(decision, { ok: false, refusal: "keys-unavailable" });
  });
}

test("a key set arriving in many chunks is read whole, and the size bound counts them all", async () => {
  const chunked = (text: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(text);
          for (let offset = 0; offset < bytes.length; offset += 4096) controller.enqueue(bytes.slice(offset, offset + 4096));
          controller.close();
        }
      })
    );
  const run = async (text: string) => {
    const certs = certsFor(signing);
    certs.respond(() => chunked(text));
    const keySet = new AccessKeySet(ISSUER, certs.fetcher, clock());
    return verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
  };
  assert.equal((await run(keySetBody())).ok, true);
  assert.deepEqual(await run(keySetBody({ padding: "x".repeat(70_000) })), { ok: false, refusal: "keys-unavailable" });
});

for (const [name, edits, response] of [
  ["the status check", [{ find: "if (response.status !== 200)\n                return null;", replace: "" }], () => new Response(keySetBody(), { status: 302 })],
  [
    "the size bound",
    [
      { find: 'if (Number((_a = response.headers.get("content-length")) !== null && _a !== void 0 ? _a : 0) > MAX_KEY_SET_BYTES)\n        return null;', replace: "" },
      { find: "if (total > MAX_KEY_SET_BYTES) {", replace: "if (false) {" }
    ],
    () => new Response(keySetBody({ padding: "x".repeat(70_000) }))
  ]
] as const) {
  test(`removing ${name} lets its key set sign a token`, async () => {
    const certs = certsFor(signing);
    certs.respond(response);
    const keySet = new (variant(...edits).AccessKeySet)(ISSUER, certs.fetcher, clock());
    assert.equal((await verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock())).ok, true);
  });
}

test("a set that can no longer be refreshed is not trusted past its time, and recovers", async () => {
  const certs = certsFor(signing);
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const token = await signToken(signing, ownerClaims());
  assert.equal((await verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
  certs.respond(() => Promise.reject(new Error("offline")));
  now += KEY_SET_TRUST_MS;
  assert.deepEqual(await verifyAccessToken(token, POLICY, keySet, () => now), { ok: false, refusal: "keys-unavailable" });
  certs.respond(() => certsResponse(signing));
  now += KEY_SET_REFETCH_INTERVAL_MS;
  assert.equal((await verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
});

test("an outage costs one fetch per interval, however many requests arrive", async () => {
  const certs = certsFor(signing);
  certs.respond(() => Promise.reject(new Error("offline")));
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const token = await signToken(signing, ownerClaims());
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(await verifyAccessToken(token, POLICY, keySet, () => now), { ok: false, refusal: "keys-unavailable" });
  }
  assert.equal(certs.calls(), 1);
  now += KEY_SET_REFETCH_INTERVAL_MS;
  await verifyAccessToken(token, POLICY, keySet, () => now);
  assert.equal(certs.calls(), 2);
});

test("a forged key id during an outage cannot lock out a key the set still trusts", async () => {
  const certs = certsFor(signing);
  let now = NOW_MS;
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, () => now);
  const token = await signToken(signing, ownerClaims());
  const forged = await signToken(rotated, ownerClaims());
  assert.equal((await verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
  certs.respond(() => Promise.reject(new Error("offline")));
  now += KEY_SET_REFETCH_INTERVAL_MS;
  assert.deepEqual(await verifyAccessToken(forged, POLICY, keySet, () => now), { ok: false, refusal: "keys-unavailable" });
  assert.equal((await verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
  now = NOW_MS + KEY_SET_TRUST_MS;
  assert.deepEqual(await verifyAccessToken(token, POLICY, keySet, () => now), { ok: false, refusal: "keys-unavailable" });
});

type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void };

function deferred(): Deferred {
  let resolve: Deferred["resolve"] = () => undefined;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A fetch that started first and finished last, holding a key the later fetch had removed. */
async function revokedKeyAfterOverlap(module: TokenModule): Promise<{ revoked: boolean; rotated: boolean; calls: number }> {
  const older = deferred();
  const newer = deferred();
  const pending = [older, newer];
  let calls = 0;
  const keySet = new module.AccessKeySet(
    ISSUER,
    async () => {
      calls += 1;
      return (pending.shift() as Deferred).promise;
    },
    clock()
  );
  const revokedToken = await signToken(signing, ownerClaims());
  const first = module.verifyAccessToken(revokedToken, POLICY, keySet, clock());
  const second = module.verifyAccessToken(revokedToken, POLICY, keySet, clock());
  newer.resolve(certsResponse(rotated));
  await second;
  older.resolve(certsResponse(signing));
  await first;
  return {
    revoked: (await module.verifyAccessToken(revokedToken, POLICY, keySet, clock())).ok,
    rotated: (await module.verifyAccessToken(await signToken(rotated, ownerClaims()), POLICY, keySet, clock())).ok,
    calls
  };
}

test("a fetch that finishes after a newer one cannot bring back a key the newer one removed", async () => {
  assert.deepEqual(await revokedKeyAfterOverlap(productionModule), { revoked: false, rotated: true, calls: 2 });
});

test("removing the order check brings the revoked key back, so that check is what stops it", async () => {
  const broken = variant({ find: "if (fetched !== null && sequence > this.newestFetchApplied) {", replace: "if (fetched !== null) {" });
  assert.deepEqual(await revokedKeyAfterOverlap(broken), { revoked: true, rotated: false, calls: 2 });
});

/** A slow fetch, then a revocation: is the key still honored once its fetch began a full trust ago? */
async function honoredAfterSlowFetch(module: TokenModule): Promise<boolean> {
  const slow = deferred();
  let now = NOW_MS;
  const certs = certsFor(signing, rotated);
  certs.respond(() => slow.promise);
  const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, () => now);
  const token = await signToken(signing, ownerClaims());
  const first = module.verifyAccessToken(token, POLICY, keySet, () => now);
  now += 4_000;
  slow.resolve(certsResponse(signing, rotated));
  assert.equal((await first).ok, true);
  certs.respond(() => certsResponse(rotated));
  now = NOW_MS + KEY_SET_TRUST_MS;
  return (await module.verifyAccessToken(token, POLICY, keySet, () => now)).ok;
}

test("a key's trust runs from when its fetch began, so a slow fetch earns no extra", async () => {
  assert.equal(await honoredAfterSlowFetch(productionModule), false);
  const broken = variant({ find: "this.keysFetchStartedAt = startedAt;", replace: "this.keysFetchStartedAt = finishedAt;" });
  assert.equal(await honoredAfterSlowFetch(broken), true);
});

test("a clock that moves backward earns no trust", async () => {
  const run = async (module: TokenModule) => {
    const certs = certsFor(signing);
    let now = NOW_MS;
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, () => now);
    const token = await signToken(signing, ownerClaims());
    await module.verifyAccessToken(token, POLICY, keySet, () => now);
    now -= 3_600_000;
    await module.verifyAccessToken(token, POLICY, keySet, () => now);
    return certs.calls();
  };
  assert.equal(await run(productionModule), 2, "the set is read again");
  assert.equal(await run(variant({ find: "return since !== null && now >= since && now - since < span;", replace: "return since !== null && now - since < span;" })), 1);
});

test("concurrent first requests each fetch, and none is refused for it", async () => {
  // A Worker cannot await another request's fetch, so this cost is accepted and bounded by traffic Access admits.
  const certs = certsFor(signing);
  const keySet = new AccessKeySet(ISSUER, certs.fetcher, clock());
  const token = await signToken(signing, ownerClaims());
  const decisions = await Promise.all(Array.from({ length: 5 }, () => verifyAccessToken(token, POLICY, keySet, clock())));
  assert.ok(decisions.every((decision) => decision.ok));
  assert.equal(certs.calls(), 5);
});

test("a fetch that hangs is cut off, and the request fails closed", async () => {
  const hung = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as productionModule.KeySetFetch;
  const decide = async (module: TokenModule) => {
    const keySet = new module.AccessKeySet(ISSUER, hung, clock(), 5);
    const decision = module.verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
    return Promise.race([decision, new Promise((settle) => setTimeout(settle, 250, "still waiting"))]);
  };
  assert.deepEqual(await decide(productionModule), { ok: false, refusal: "keys-unavailable" });
  assert.equal(
    await decide(variant({ find: "signal: AbortSignal.timeout(this.fetchBoundMs)", replace: "signal: new AbortController().signal" })),
    "still waiting"
  );
});

test("a runtime that throws on a signature check reads as a bad signature", async () => {
  // Verifying with an HMAC key throws everywhere, which stands in for a runtime that throws on a short signature.
  const wrongKind = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const keySet = { keyFor: async () => wrongKind };
  const token = await signToken(signing, ownerClaims());
  assert.deepEqual(await verifyAccessToken(token, POLICY, keySet, clock()), { ok: false, refusal: "bad-signature" });
  const [header, payload] = token.split(".");
  assert.equal(await refusalOf(`${header}.${payload}.AAAA`), "bad-signature");
});

test("a validly signed payload that is not an object is refused", async () => {
  assert.equal(await refusalOf(await signToken(signing, [1] as unknown as Record<string, unknown>)), "malformed-claims");
});

test("a key set fetch follows no redirect, takes no cached copy, carries a bound, and reads only the team's address", async () => {
  let seen: RequestInit | undefined;
  const keySet = new AccessKeySet(
    ISSUER,
    async (url, init) => {
      assert.equal(url, `${ISSUER}/cdn-cgi/access/certs`);
      seen = init;
      return certsResponse(signing);
    },
    clock()
  );
  assert.equal((await verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock())).ok, true);
  assert.equal(seen?.redirect, "manual");
  assert.equal(seen?.cache, "no-store");
  assert.ok(seen?.signal instanceof AbortSignal);
});

/** A set whose one usable key is this entry, and a token that key really signed. */
async function refusalWithKeyEntry(module: TokenModule, key: SigningKey, entry: Record<string, unknown>) {
  const certs = certsFor(key);
  certs.respond(() => Response.json({ keys: [entry] }));
  const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
  const decision = await module.verifyAccessToken(await signToken(key, ownerClaims()), POLICY, keySet, clock());
  return decision.ok ? "accepted" : decision.refusal;
}

for (const [name, entry] of [
  ["a key for encryption", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", use: "enc" })],
  ["a key for another algorithm", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", alg: "RS512" })],
  ["a non-RSA key", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", kty: "EC" })],
  ["a key with no id", (jwk: JsonWebKey) => ({ ...jwk, kid: undefined })],
  ["a key with another exponent", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", e: "Aw" })],
  ["a misspelled modulus", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", n: `${jwk.n as string}=` })]
] as const) {
  test(`${name} in the set is not used, though another key is`, async () => {
    const certs = certsFor(signing);
    certs.respond(() => Response.json({ keys: [entry(signing.publicJwk), { ...rotated.publicJwk, kid: "key-2" }] }));
    const keySet = new AccessKeySet(ISSUER, certs.fetcher, clock());
    assert.deepEqual(await verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock()), { ok: false, refusal: "unknown-key" });
    assert.equal((await verifyAccessToken(await signToken(rotated, ownerClaims()), POLICY, keySet, clock())).ok, true);
  });
}

test("a 1024-bit key is not used, even padded to look long, and removing that check lets it sign", async () => {
  const weak = await generateSigningKey("key-1", 1024);
  const plain = { ...weak.publicJwk, kid: "key-1" };
  const padded = { ...plain, n: base64url(new Uint8Array([...new Uint8Array(128), ...Uint8Array.from(atob((weak.publicJwk.n as string).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))])) };
  assert.equal(await refusalWithKeyEntry(productionModule, weak, plain), "keys-unavailable");
  assert.equal(await refusalWithKeyEntry(productionModule, weak, padded), "keys-unavailable");
  const noBits = variant({ find: "return (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0])) >= MIN_RSA_MODULUS_BITS;", replace: "return true;" });
  assert.equal(await refusalWithKeyEntry(noBits, weak, plain), "accepted");
  const countsPadding = variant({ find: "if (modulus[0] === 0)\n        return false;\n    return (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0])) >= MIN_RSA_MODULUS_BITS;", replace: "return modulus.length * 8 >= MIN_RSA_MODULUS_BITS;" });
  assert.equal(await refusalWithKeyEntry(countsPadding, weak, padded), "accepted");
});

test("a real 2048-bit key passes the size check", async () => {
  assert.equal(await refusalWithKeyEntry(productionModule, signing, { ...signing.publicJwk, kid: "key-1" }), "accepted");
});

test("a policy exists only from complete, well-formed configuration", () => {
  const good = { issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER, ownerEmail: OWNER_EMAIL, healthClientId: HEALTH_CLIENT, healthAudience: HEALTH_AUDIENCE };
  assert.deepEqual(accessPolicyFrom(good), good);
  for (const absent of [undefined, ""]) {
    const policy = accessPolicyFrom({ ...good, healthClientId: absent, healthAudience: absent });
    assert.deepEqual([policy?.healthClientId, policy?.healthAudience], [null, null]);
  }
  for (const bad of [
    { issuer: undefined },
    { issuer: "" },
    { issuer: "http://sbl-test.cloudflareaccess.com" },
    { issuer: "https://sbl-test.cloudflareaccess.com/" },
    { issuer: "https://sbl-test.cloudflareaccess.com.attacker.example" },
    { issuer: "https://attacker.example" },
    { audience: undefined },
    { audience: "" },
    { audience: "short" },
    { audience: "A".repeat(64) },
    { ownerSubject: undefined },
    { ownerSubject: "" },
    { ownerSubject: "has a space" },
    { ownerEmail: undefined },
    { ownerEmail: "" },
    { ownerEmail: 7 },
    { ownerEmail: "owner" },
    { ownerEmail: "@example.org" },
    { ownerEmail: "owner@" },
    { ownerEmail: "owner@example.org@example.org" },
    { ownerEmail: "has space@example.org" },
    { ownerEmail: "owner@exa mple.org" },
    { ownerEmail: "owner@example.org\n" },
    { healthClientId: "has a space" },
    { healthClientId: 7 },
    { healthAudience: "short" },
    { healthAudience: "A".repeat(64) },
    { healthAudience: 7 }
  ]) {
    assert.equal(accessPolicyFrom({ ...good, ...bad }), null, JSON.stringify(bad));
  }
});

const tokenModulePath = require.resolve("../core/access-token");
const variant = (...edits: SourceEdit[]) => loadVariant<TokenModule>(tokenModulePath, edits);

/** Each guard removed, the attack it stops, and what then happens. Only that guard may stand in the way. */
for (const [name, find, replace, attack, withGuard, withoutGuard] of [
  ["the signature check", "if (!verified)\n        return refuse(\"bad-signature\");", "", async () => signToken(foreign, ownerClaims()), "bad-signature", "accepted"],
  ["the issuer check", "if (payload.iss !== policy.issuer)\n        return refuse(\"wrong-issuer\");", "", async () => signToken(signing, ownerClaims({ iss: "https://other.cloudflareaccess.com" })), "wrong-issuer", "accepted"],
  ["the audience check", "if (!audiences.includes(requiredAudience))\n        return refuse(\"wrong-audience\");", "", async () => signToken(signing, ownerClaims({ aud: ["b".repeat(64)] })), "wrong-audience", "accepted"],
  ["the token type check", "if (payload.type !== \"app\")\n        return refuse(\"wrong-token-type\");", "", async () => signToken(signing, ownerClaims({ type: "org" })), "wrong-token-type", "accepted"],
  ["the expiry check", "if (nowSeconds >= exp)\n        return refuse(\"expired\");", "", async () => signToken(signing, ownerClaims({ exp: NOW_SECONDS - 1 })), "expired", "accepted"],
  ["the not-before check", "if (nbf !== undefined && nbf > nowSeconds + ISSUED_AT_SKEW_SECONDS)\n        return refuse(\"not-yet-valid\");", "", async () => signToken(signing, ownerClaims({ nbf: NOW_SECONDS + 3600 })), "not-yet-valid", "accepted"],
  ["the issue time check", "if (iat > nowSeconds + ISSUED_AT_SKEW_SECONDS)\n        return refuse(\"not-yet-valid\");", "", async () => signToken(signing, ownerClaims({ iat: NOW_SECONDS + 3600 })), "not-yet-valid", "accepted"],
  ["the owner subject check", "if (sub !== policy.ownerSubject)\n        return refuse(\"not-the-owner-subject\");", "", async () => signToken(signing, ownerClaims({ sub: "11111111-61da-459d-899c-0a01c76a2f94" })), "not-the-owner-subject", "accepted"],
  ["the service token check", "if (commonName !== policy.healthClientId)\n            return refuse(\"unrecognized-service-token\");", "", async () => signToken(signing, serviceClaims({ common_name: "other.access" })), "unrecognized-service-token", "accepted"],
  ["the rule that one token cannot be both", 'if (commonName !== undefined && commonName !== "")\n        return refuse("malformed-claims");', "", async () => signToken(signing, ownerClaims({ common_name: HEALTH_CLIENT })), "malformed-claims", "accepted"],
  ["the claim date types", 'if (!isNumericDate(exp) || !isNumericDate(iat))\n        return refuse("malformed-claims");', "", async () => signToken(signing, ownerClaims({ exp: String(NOW_SECONDS + 3600) })), "malformed-claims", "accepted"],
  ["the not-before type", 'if (nbf !== undefined && !isNumericDate(nbf))\n        return refuse("malformed-claims");', "", async () => signToken(signing, ownerClaims({ nbf: "soon" })), "malformed-claims", "accepted"],
  ["the email requirement", 'if (typeof email !== "string" || email === "")\n        return refuse("malformed-claims");', "", async () => signToken(signing, ownerClaims({ email: undefined })), "malformed-claims", "not-the-owner-email"],
  ["the subject type", 'if (typeof sub !== "string")\n        return refuse("malformed-claims");', "", async () => signToken(signing, ownerClaims({ sub: 7 })), "malformed-claims", "not-the-owner-subject"],
  ["the client id requirement", 'if (typeof commonName !== "string" || commonName === "")\n            return refuse("malformed-claims");', "", async () => signToken(signing, serviceClaims({ common_name: undefined })), "malformed-claims", "unrecognized-service-token"],
  ["the token length bound", "if (token.length > MAX_TOKEN_CHARS)\n        return refuse(\"malformed-token\");", "", async () => signToken(signing, ownerClaims({ padding: "x".repeat(16_384) })), "malformed-token", "accepted"],
  ["the key id type", 'if (typeof header.kid !== "string" || header.kid === "")\n        return refuse("malformed-token");', "", async () => signToken(signing, ownerClaims(), { kid: 1 }), "malformed-token", "unknown-key"],
  ["the algorithm check", 'if (header.alg !== "RS256")\n        return refuse("unsupported-algorithm");', "", async () => signToken(signing, ownerClaims(), { alg: "RS512" }), "unsupported-algorithm", "accepted"],
  ["the critical extension check", 'if (header.crit !== undefined)\n        return refuse("unsupported-algorithm");', "", async () => signToken(signing, ownerClaims(), { crit: ["exp"] }), "unsupported-algorithm", "accepted"],
  ["the one-spelling rule", 'if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== value)\n        return null;', "", async () => {
    const [header, payload, signature] = (await signToken(signing, ownerClaims())).split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    return `${header}.${payload}.${signature.slice(0, -1)}${alphabet[alphabet.indexOf(signature.at(-1) as string) + 1]}`;
  }, "malformed-token", "accepted"]
] as const) {
  test(`removing ${name} lets its attack through, so that guard is what stops it`, async () => {
    const token = await attack();
    assert.equal(await refusalOf(token), withGuard);
    assert.equal(await refusalOf(token, variant({ find, replace })), withoutGuard);
  });
}

for (const [name, entry, find, replace] of [
  ["the key use filter", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", use: "enc" }), 'if ((alg !== undefined && alg !== "RS256") || (use !== undefined && use !== "sig"))\n        return null;', ""],
  ["the key algorithm filter", (jwk: JsonWebKey) => ({ ...jwk, kid: "key-1", alg: "RS512" }), 'if ((alg !== undefined && alg !== "RS256") || (use !== undefined && use !== "sig"))\n        return null;', ""]
] as const) {
  test(`removing ${name} lets a key that names another purpose sign`, async () => {
    const respond = () => Response.json({ keys: [entry(signing.publicJwk)] });
    const refusalWith = async (module: TokenModule) => {
      const certs = certsFor(signing);
      certs.respond(respond);
      const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
      const decision = await module.verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
      return decision.ok ? "accepted" : decision.refusal;
    };
    assert.equal(await refusalWith(productionModule), "keys-unavailable");
    assert.equal(await refusalWith(variant({ find, replace })), "accepted");
  });
}

test("removing the trust limit keeps a revoked key working", async () => {
  const run = async (module: TokenModule) => {
    const certs = certsFor(signing, rotated);
    let now = NOW_MS;
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, () => now);
    const token = await signToken(signing, ownerClaims());
    assert.equal((await module.verifyAccessToken(token, POLICY, keySet, () => now)).ok, true);
    certs.respond(() => certsResponse(rotated));
    now += KEY_SET_TRUST_MS;
    return (await module.verifyAccessToken(token, POLICY, keySet, () => now)).ok;
  };
  assert.equal(await run(productionModule), false);
  assert.equal(await run(variant({ find: "const trusted = isWithin(this.keysFetchStartedAt, now, exports.KEY_SET_TRUST_MS);", replace: "const trusted = this.keysFetchStartedAt !== null;" })), true);
});

const REFETCH_GUARD = 'if (isWithin(this.lastFetchFinishedAt, now, exports.KEY_SET_REFETCH_INTERVAL_MS))\n            return trusted ? "unknown-key" : "keys-unavailable";';

test("removing the refetch interval lets a stream of unknown key ids fetch every time", async () => {
  const calls = async (module: TokenModule) => {
    const certs = certsFor(signing);
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
    const unknown = await signToken(rotated, ownerClaims());
    for (let index = 0; index < 3; index += 1) await module.verifyAccessToken(unknown, POLICY, keySet, clock());
    return certs.calls();
  };
  assert.equal(await calls(productionModule), 1);
  assert.equal(await calls(variant({ find: REFETCH_GUARD, replace: "" })), 3);
});

test("removing the refetch interval lets an outage fetch on every request", async () => {
  const calls = async (module: TokenModule) => {
    const certs = certsFor(signing);
    certs.respond(() => Promise.reject(new Error("offline")));
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
    const token = await signToken(signing, ownerClaims());
    for (let index = 0; index < 3; index += 1) await module.verifyAccessToken(token, POLICY, keySet, clock());
    return certs.calls();
  };
  assert.equal(await calls(productionModule), 1);
  assert.equal(await calls(variant({ find: REFETCH_GUARD, replace: "" })), 3);
});

test("clearing the set on a failed fetch would let a forged key id lock the owner out", async () => {
  const lockedOut = async (module: TokenModule) => {
    const certs = certsFor(signing);
    let now = NOW_MS;
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, () => now);
    const token = await signToken(signing, ownerClaims());
    await module.verifyAccessToken(token, POLICY, keySet, () => now);
    certs.respond(() => Promise.reject(new Error("offline")));
    now += KEY_SET_REFETCH_INTERVAL_MS;
    await module.verifyAccessToken(await signToken(rotated, ownerClaims()), POLICY, keySet, () => now);
    return !(await module.verifyAccessToken(token, POLICY, keySet, () => now)).ok;
  };
  assert.equal(await lockedOut(productionModule), false);
  const clears = variant({
    find: "this.lastFetchFinishedAt = finishedAt;",
    replace: "this.lastFetchFinishedAt = finishedAt;\n        if (fetched === null) {\n            this.keys = new Map();\n            this.keysFetchStartedAt = null;\n        }"
  });
  assert.equal(await lockedOut(clears), true);
});

const checkOwnerPins = async (module: TokenModule) => {
  const otherSubject = await refusalOf(await signToken(signing, ownerClaims({ sub: "11111111-61da-459d-899c-0a01c76a2f94" })), module);
  holds("another subject with the owner's email is refused by name", otherSubject === "not-the-owner-subject", () => otherSubject);
  const otherEmail = await refusalOf(await signToken(signing, ownerClaims({ email: "someone-else@example.org" })), module);
  holds("the owner's subject with another email is refused by name", otherEmail === "not-the-owner-email", () => otherEmail);
  const otherCase = await refusalOf(await signToken(signing, ownerClaims({ email: "Owner@Example.org" })), module);
  holds("an email spelled in another case is refused", otherCase === "not-the-owner-email", () => otherCase);
};

test("the owner is both pinned values, and each is refused by its own name", async () => {
  await checkOwnerPins(productionModule);
  await assertCaughtBy("the subject check", "another subject with the owner's email is refused by name", () =>
    checkOwnerPins(variant({ find: 'if (sub !== policy.ownerSubject)\n        return refuse("not-the-owner-subject");', replace: "" }))
  );
  await assertCaughtBy("the email check", "the owner's subject with another email is refused by name", () =>
    checkOwnerPins(variant({ find: 'if (email !== policy.ownerEmail)\n        return refuse("not-the-owner-email");', replace: "" }))
  );
  await assertCaughtBy("a comparison that ignores case", "an email spelled in another case is refused", () =>
    checkOwnerPins(variant({ find: "if (email !== policy.ownerEmail)", replace: "if (email.toLowerCase() !== policy.ownerEmail.toLowerCase())" }))
  );
});

// Two Access applications mean two audiences, and a token's kind decides which it must carry.

const EQUAL_AUDIENCES: productionModule.AccessPolicy = { ...POLICY, healthClientId: HEALTH_CLIENT, healthAudience: AUDIENCE };

async function refusalUnder(module: TokenModule, policy: productionModule.AccessPolicy, claims: Record<string, unknown>) {
  const keySet = new module.AccessKeySet(ISSUER, certsFor(signing).fetcher, clock());
  const decision = await module.verifyAccessToken(await signToken(signing, claims), policy, keySet, clock());
  return decision.ok ? decision.identity.kind : decision.refusal;
}

const checkAudiences = async (module: TokenModule) => {
  const outcome = (property: string, actual: string, expected: string) => holds(property, actual === expected, () => actual);
  outcome("a service token carries the health audience", await refusalUnder(module, POLICY, serviceClaims()), "health-service");
  outcome("the owner carries the owner's audience", await refusalUnder(module, POLICY, ownerClaims()), "owner");
  outcome("a service token bearing the owner's audience is refused", await refusalUnder(module, POLICY, serviceClaims({ aud: [AUDIENCE] })), "wrong-audience");
  outcome("an owner token bearing the health audience is refused", await refusalUnder(module, POLICY, ownerClaims({ aud: [HEALTH_AUDIENCE] })), "wrong-audience");
  outcome("with equal audiences a service token is admitted", await refusalUnder(module, EQUAL_AUDIENCES, serviceClaims({ aud: [AUDIENCE] })), "health-service");
  outcome("with equal audiences the owner is admitted", await refusalUnder(module, EQUAL_AUDIENCES, ownerClaims()), "owner");
};

test("each kind of token must carry its own application's audience, and equal audiences serve both", async () => {
  await checkAudiences(productionModule);
});

for (const [name, property, find, replace] of [
  [
    "a service token accepted on the owner's audience as well",
    "a service token bearing the owner's audience is refused",
    "if (!audiences.includes(requiredAudience))\n        return refuse(\"wrong-audience\");",
    "if (!audiences.includes(requiredAudience) && !(isServiceToken && audiences.includes(policy.audience)))\n        return refuse(\"wrong-audience\");"
  ],
  [
    "an owner token accepted on the health audience as well",
    "an owner token bearing the health audience is refused",
    "if (!audiences.includes(requiredAudience))\n        return refuse(\"wrong-audience\");",
    "if (!audiences.includes(requiredAudience) && !(!isServiceToken && audiences.includes(policy.healthAudience)))\n        return refuse(\"wrong-audience\");"
  ],
  [
    "one audience compared for every kind, as W0 did",
    "a service token carries the health audience",
    "const requiredAudience = isServiceToken ? policy.healthAudience : policy.audience;",
    "const requiredAudience = policy.audience;"
  ],
  [
    "only the health audience compared",
    "a service token carries the health audience",
    "const requiredAudience = isServiceToken ? policy.healthAudience : policy.audience;",
    "const requiredAudience = isServiceToken ? policy.audience : policy.healthAudience;"
  ]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkAudiences(variant({ find, replace })));
  });
}

const checkHealthConfig = (module: TokenModule) => {
  const good = { issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER, ownerEmail: OWNER_EMAIL };
  for (const absent of [undefined, ""]) {
    holds("a health client id with no health audience is no policy", module.accessPolicyFrom({ ...good, healthClientId: HEALTH_CLIENT, healthAudience: absent }) === null, () => absent);
    holds("a health audience with no client id is no policy", module.accessPolicyFrom({ ...good, healthClientId: absent, healthAudience: HEALTH_AUDIENCE }) === null, () => absent);
  }
  const equal = module.accessPolicyFrom({ ...good, healthClientId: HEALTH_CLIENT, healthAudience: AUDIENCE });
  holds("the two audiences may be equal", equal !== null && equal.healthAudience === AUDIENCE && equal.audience === AUDIENCE, () => equal);
  const neither = module.accessPolicyFrom(good);
  holds("neither is a policy with no service token", neither !== null && neither.healthClientId === null && neither.healthAudience === null, () => neither);
};

test("a half-configured health path gives no policy, and equal audiences are allowed", () => {
  checkHealthConfig(productionModule);
});

for (const [name, property, find, replace] of [
  ["a client id allowed with no audience", "a health client id with no health audience is no policy", "if (noClientId && noHealthAudience) {", "if (noHealthAudience) {"],
  ["an audience allowed with no client id", "a health audience with no client id is no policy", "if (noClientId && noHealthAudience) {", "if (noClientId) {"],
  ["the health audience's shape unchecked", "a health client id with no health audience is no policy", 'if (typeof healthAudience !== "string" || !AUD_TAG.test(healthAudience))\n        return null;', ""],
  ["the health client id's shape unchecked", "a health audience with no client id is no policy", 'if (typeof healthClientId !== "string" || !SAFE_IDENTIFIER.test(healthClientId))\n        return null;', ""],
  ["equal audiences refused", "the two audiences may be equal", 'if (typeof healthAudience !== "string" || !AUD_TAG.test(healthAudience))\n        return null;', 'if (typeof healthAudience !== "string" || !AUD_TAG.test(healthAudience) || healthAudience === audience)\n        return null;']
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkHealthConfig(variant({ find, replace })));
  });
}

// Numbers are written here, so a changed constant cannot move a test with it.

test("how long a key set is trusted, and how often a miss may fetch, are the stated numbers", () => {
  assert.equal(KEY_SET_TRUST_MS, 300_000);
  assert.equal(KEY_SET_REFETCH_INTERVAL_MS, 30_000);
});

const UNUSABLE_TOKEN_TIMES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["an expiry too large to be a time", { exp: 1e308 }],
  ["an issue time far before the epoch", { iat: -1e308 }],
  ["a fractional expiry", { exp: NOW_SECONDS + 10.5 }],
  ["a fractional issue time", { iat: NOW_SECONDS - 60.5 }],
  ["a negative issue time", { iat: -5 }],
  ["an expiry past the safe integers", { exp: 2 ** 53 + 2 }],
  ["a fractional not-before", { nbf: NOW_SECONDS - 60.5 }],
  ["a negative not-before", { nbf: -5 }]
];

const checkTokenTimes = async (module: TokenModule) => {
  for (const [name, claims] of UNUSABLE_TOKEN_TIMES) {
    for (const [kind, build] of [["owner", ownerClaims], ["service", serviceClaims]] as const) {
      const refusal = await refusalOf(await signToken(signing, build(claims)), module);
      holds("a token time must be a non-negative safe integer", refusal === "malformed-claims", () => ({ name, kind, refusal }));
    }
  }
  const zero = await refusalOf(await signToken(signing, ownerClaims({ iat: 0, nbf: 0 })), module);
  holds("the epoch itself is a time", zero === "accepted", () => zero);
};

test("a token time must be a non-negative safe integer, even under a good signature", async () => {
  await checkTokenTimes(productionModule);
  const infinite = new TextEncoder().encode(JSON.stringify(ownerClaims()).replace(/"exp":\d+/, '"exp":1e999'));
  assert.equal(await refusalOf(await signPayloadBytes(signing, infinite)), "malformed-claims");
});

test("negative zero is no token time, since an entry has no form for it", async () => {
  const negativeZero = (claim: string) => new TextEncoder().encode(JSON.stringify(ownerClaims()).replace(new RegExp(`"${claim}":\\d+`), `"${claim}":-0`));
  const check = async (module: TokenModule) => {
    for (const claim of ["iat", "nbf", "exp"]) {
      const refusal = await refusalOf(await signPayloadBytes(signing, negativeZero(claim)), module);
      holds("a signed -0 is malformed", refusal === "malformed-claims", () => ({ claim, refusal }));
    }
  };
  await check(productionModule);
  await assertCaughtBy("the -0 rule", "a signed -0 is malformed", () => check(variant({ find: " && !Object.is(value, -0)", replace: "" })));
});

for (const [name, property, replace] of [
  ["any finite number", "a token time must be a non-negative safe integer", "Number.isFinite(value)"],
  ["any integer", "a token time must be a non-negative safe integer", "Number.isInteger(value) && value >= 0"],
  ["negative integers", "a token time must be a non-negative safe integer", "Number.isSafeInteger(value)"],
  ["no epoch", "the epoch itself is a time", "Number.isSafeInteger(value) && value > 0"]
] as const) {
  test(`a variant allowing ${name} is caught`, async () => {
    await assertCaughtBy(name, property, () => checkTokenTimes(variant({ find: "Number.isSafeInteger(value) && value >= 0", replace })));
  });
}

const checkAudienceLists = async (module: TokenModule) => {
  const other = "b".repeat(64);
  const owner = await refusalOf(await signToken(signing, ownerClaims({ aud: [other, AUDIENCE] })), module);
  holds("the required audience may be anywhere in the list", owner === "accepted", () => owner);
  const service = await refusalOf(await signToken(signing, serviceClaims({ aud: [other, HEALTH_AUDIENCE] })), module);
  holds("the required audience may be anywhere in the list", service === "accepted", () => service);
};

test("a token's audience may be a list, with the one it must carry anywhere in it", async () => {
  await checkAudienceLists(productionModule);
  await assertCaughtBy("only the first audience compared", "the required audience may be anywhere in the list", () =>
    checkAudienceLists(variant({ find: "if (!audiences.includes(requiredAudience))", replace: "if (audiences[0] !== requiredAudience)" }))
  );
});

test("an owner's token with an empty client id is an owner's token", async () => {
  const check = async (module: TokenModule) => {
    const refusal = await refusalOf(await signToken(signing, ownerClaims({ common_name: "" })), module);
    holds("an empty client id claims nothing", refusal === "accepted", () => refusal);
  };
  await check(productionModule);
  await assertCaughtBy("refusing it", "an empty client id claims nothing", () =>
    check(variant({ find: 'if (commonName !== undefined && commonName !== "")', replace: "if (commonName !== undefined)" }))
  );
});

test("a 1024-bit key padded with enough zeros to count as 2048 bits is still refused", async () => {
  const weak = await generateSigningKey("key-1", 1024);
  const modulus = Uint8Array.from(atob((weak.publicJwk.n as string).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  // 129 zeros: past the first byte there are 256 more, which is what a bare byte count sees as 2048 bits.
  const padded = { ...weak.publicJwk, kid: "key-1", n: base64url(new Uint8Array([...new Uint8Array(129), ...modulus])) };
  const check = async (module: TokenModule) => {
    const refusal = await refusalWithKeyEntry(module, weak, padded);
    holds("zero padding earns a key no bits", refusal === "keys-unavailable", () => refusal);
  };
  await check(productionModule);
  await assertCaughtBy("the leading zero check", "zero padding earns a key no bits", () =>
    check(variant({ find: "if (modulus[0] === 0)\n        return false;", replace: "" }))
  );
});

/** A token of exactly this many characters, signed and otherwise good. */
async function tokenOfLength(length: number): Promise<string> {
  const signatureChars = 342;
  for (let pad = 0; pad < 4; pad += 1) {
    const headerPad = "x".repeat(pad);
    const header = base64url(JSON.stringify({ alg: "RS256", kid: signing.id, typ: "JWT", pad: headerPad }));
    for (let payloadPad = Math.floor(((length - signatureChars - header.length - 2) * 3) / 4) - 400; payloadPad < length; payloadPad += 1) {
      const claims = ownerClaims({ padding: "x".repeat(payloadPad) });
      const total = header.length + base64url(JSON.stringify(claims)).length + signatureChars + 2;
      if (total > length) break;
      if (total === length) return signToken(signing, claims, { pad: headerPad });
    }
  }
  throw new Error(`No token of ${length} characters could be built`);
}

test("a token exactly at the length bound is read, and one past it is refused before any key is fetched", async () => {
  const atBound = await tokenOfLength(16_384);
  const overBound = await tokenOfLength(16_385);
  assert.equal(atBound.length, 16_384);
  assert.equal(overBound.length, 16_385);
  const check = async (module: TokenModule) => {
    const at = await refusalOf(atBound, module);
    holds("a token exactly at the bound is read", at === "accepted", () => at);
    const over = await refusalOf(overBound, module);
    holds("a token past the bound is refused", over === "malformed-token", () => over);
  };
  await check(productionModule);
  await assertCaughtBy("the bound's edge", "a token exactly at the bound is read", () => check(variant({ find: "if (token.length > MAX_TOKEN_CHARS)", replace: "if (token.length >= MAX_TOKEN_CHARS)" })));
  await assertCaughtBy("a higher bound", "a token past the bound is refused", () => check(variant({ find: "const MAX_TOKEN_CHARS = 16384;", replace: "const MAX_TOKEN_CHARS = 16385;" })));
});

const KEY_SET_LIMIT = 65_536;

test("a key set exactly at its bound is read, and one past it is not, declared or streamed", async () => {
  const sized = (bytes: number): string => {
    const base = keySetBody({ padding: "" });
    return keySetBody({ padding: "x".repeat(bytes - base.length) });
  };
  const streamed = (text: string) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        }
      })
    );
  const check = async (module: TokenModule) => {
    const outcome = async (respond: () => Response) => {
      const certs = certsFor(signing);
      certs.respond(respond);
      const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
      const decision = await module.verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
      return decision.ok ? "accepted" : decision.refusal;
    };
    const atBound = await outcome(() => streamed(sized(KEY_SET_LIMIT)));
    holds("a key set exactly at the bound is read", atBound === "accepted", () => atBound);
    const overBound = await outcome(() => streamed(sized(KEY_SET_LIMIT + 1)));
    holds("a key set past the bound is refused, whatever it declares", overBound === "keys-unavailable", () => overBound);
    const declaredAt = await outcome(() => new Response(keySetBody(), { headers: { "content-length": String(KEY_SET_LIMIT) } }));
    holds("a declared length exactly at the bound is read", declaredAt === "accepted", () => declaredAt);
    const declaredOver = await outcome(() => new Response(keySetBody(), { headers: { "content-length": String(KEY_SET_LIMIT + 1) } }));
    holds("a declared length past the bound is refused unread", declaredOver === "keys-unavailable", () => declaredOver);
  };
  await check(productionModule);
  await assertCaughtBy("the read bound's edge", "a key set exactly at the bound is read", () => check(variant({ find: "if (total > MAX_KEY_SET_BYTES) {", replace: "if (total >= MAX_KEY_SET_BYTES) {" })));
  await assertCaughtBy("the declared bound's edge", "a declared length exactly at the bound is read", () => check(variant({ find: "_a !== void 0 ? _a : 0) > MAX_KEY_SET_BYTES)", replace: "_a !== void 0 ? _a : 0) >= MAX_KEY_SET_BYTES)" })));
  await assertCaughtBy("a higher bound", "a key set past the bound is refused, whatever it declares", () => check(variant({ find: "const MAX_KEY_SET_BYTES = 65536;", replace: "const MAX_KEY_SET_BYTES = 65537;" })));
});

test("only a plain 200 carries a key set, not any success", async () => {
  const check = async (module: TokenModule) => {
    for (const status of [201, 202, 203, 206, 299]) {
      const certs = certsFor(signing);
      certs.respond(() => new Response(keySetBody(), { status }));
      const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
      const decision = await module.verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
      holds("a status other than 200 carries no key set", !decision.ok && decision.refusal === "keys-unavailable", () => ({ status, decision }));
    }
  };
  await check(productionModule);
  await assertCaughtBy("any success", "a status other than 200 carries no key set", () => check(variant({ find: "if (response.status !== 200)", replace: "if (response.status >= 300)" })));
});

test("a signed payload of invalid UTF-8 is refused, not repaired", async () => {
  const text = JSON.stringify(ownerClaims({ country: "__" }));
  const at = text.indexOf("__");
  const bytes = new TextEncoder().encode(text);
  bytes[at] = 0xff;
  bytes[at + 1] = 0xff;
  const token = await signPayloadBytes(signing, bytes);
  const check = async (module: TokenModule) => {
    const refusal = await refusalOf(token, module);
    holds("invalid UTF-8 in a claim is malformed", refusal === "malformed-claims", () => refusal);
  };
  await check(productionModule);
  await assertCaughtBy("a decoder that repairs", "invalid UTF-8 in a claim is malformed", () =>
    check(variant({ find: 'JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))', replace: "JSON.parse(new TextDecoder().decode(bytes))" }))
  );
});

test("something in a key set that is not an object costs nothing but itself", async () => {
  const check = async (module: TokenModule) => {
    const certs = certsFor(signing);
    certs.respond(() => Response.json({ keys: [null, 7, "text", { ...signing.publicJwk, kid: signing.id }] }));
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, clock());
    const decision = await module.verifyAccessToken(await signToken(signing, ownerClaims()), POLICY, keySet, clock());
    holds("the good key in a set still works", decision.ok, () => decision);
  };
  await check(productionModule);
  await assertCaughtBy("the check of each entry", "the good key in a set still works", () =>
    check(variant({ find: 'if (entry === null || typeof entry !== "object")\n        return null;', replace: "" }))
  );
});

test("the interval between fetches runs from when one finished, so a slow fetch cannot start another at once", async () => {
  const check = async (module: TokenModule) => {
    let now = NOW_MS;
    const certs = certsFor(signing);
    certs.respond(() => {
      now += KEY_SET_REFETCH_INTERVAL_MS + 10_000;
      return certsResponse(signing);
    });
    const keySet = new module.AccessKeySet(ISSUER, certs.fetcher, () => now);
    const unknown = await signToken(rotated, ownerClaims());
    await module.verifyAccessToken(unknown, POLICY, keySet, () => now);
    await module.verifyAccessToken(unknown, POLICY, keySet, () => now);
    holds("a miss right after a slow fetch does not fetch again", certs.calls() === 1, () => certs.calls());
  };
  await check(productionModule);
  await assertCaughtBy("timing the interval from the start", "a miss right after a slow fetch does not fetch again", () =>
    check(variant({ find: "this.lastFetchFinishedAt = finishedAt;", replace: "this.lastFetchFinishedAt = startedAt;" }))
  );
});

const GOOD_POLICY_VALUES = { issuer: ISSUER, audience: AUDIENCE, ownerSubject: OWNER, ownerEmail: OWNER_EMAIL };

const POLICY_BOUNDS: readonly (readonly [string, Record<string, unknown>, boolean])[] = [
  ["a subject of 256 characters", { ownerSubject: "s".repeat(256) }, true],
  ["a subject of 257 characters", { ownerSubject: "s".repeat(257) }, false],
  ["a client id of 256 characters", { healthClientId: "c".repeat(256), healthAudience: HEALTH_AUDIENCE }, true],
  ["a client id of 257 characters", { healthClientId: "c".repeat(257), healthAudience: HEALTH_AUDIENCE }, false],
  ["a local part of 64 characters", { ownerEmail: `${"l".repeat(64)}@example.org` }, true],
  ["a local part of 65 characters", { ownerEmail: `${"l".repeat(65)}@example.org` }, false],
  ["an email domain ending in a hyphen", { ownerEmail: "owner@example-" }, false],
  ["an email domain starting with a hyphen", { ownerEmail: "owner@-example.org" }, false],
  ["an audience with a newline after it", { audience: `${AUDIENCE}\n` }, false],
  ["an audience of 65 digits", { audience: "a".repeat(65) }, false],
  ["an audience of 63 digits", { audience: "a".repeat(63) }, false],
  ["a team of one letter", { issuer: "https://a.cloudflareaccess.com" }, true],
  ["a team of 63 characters", { issuer: `https://${"t".repeat(63)}.cloudflareaccess.com` }, true],
  ["a team of 64 characters", { issuer: `https://${"t".repeat(64)}.cloudflareaccess.com` }, false],
  ["a team starting with a hyphen", { issuer: "https://-team.cloudflareaccess.com" }, false],
  ["a team ending in a hyphen", { issuer: "https://team-.cloudflareaccess.com" }, false],
  ["a team with a dot in it", { issuer: "https://a.team.cloudflareaccess.com" }, false],
  ["a team in uppercase", { issuer: "https://TEAM.cloudflareaccess.com" }, false]
];

const checkPolicyBounds = (module: TokenModule) => {
  for (const [name, values, accepted] of POLICY_BOUNDS) {
    const policy = module.accessPolicyFrom({ ...GOOD_POLICY_VALUES, ...values });
    holds("a configured value is held to its stated shape, at each edge", (policy !== null) === accepted, () => ({ name, policy }));
  }
};

test("each configured value is held to its stated shape, at each edge", () => {
  checkPolicyBounds(productionModule);
});

for (const [name, find, replace] of [
  ["a longer identifier", "const SAFE_IDENTIFIER = /^[\\x21-\\x7e]{1,256}$/;", "const SAFE_IDENTIFIER = /^[\\x21-\\x7e]{1,257}$/;"],
  ["a shorter identifier", "const SAFE_IDENTIFIER = /^[\\x21-\\x7e]{1,256}$/;", "const SAFE_IDENTIFIER = /^[\\x21-\\x7e]{1,255}$/;"],
  ["a longer local part", "{1,64}@[a-zA-Z0-9]", "{1,65}@[a-zA-Z0-9]"],
  ["a shorter local part", "{1,64}@[a-zA-Z0-9]", "{1,63}@[a-zA-Z0-9]"],
  ["the audience's end", "const AUD_TAG = /^[0-9a-f]{64}$/;", "const AUD_TAG = /^[0-9a-f]{64}/;"],
  ["the audience's length", "const AUD_TAG = /^[0-9a-f]{64}$/;", "const AUD_TAG = /^[0-9a-f]{63,64}$/;"],
  ["a looser team label", "const TEAM_ISSUER = /^https:\\/\\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/;", "const TEAM_ISSUER = /^https:\\/\\/[a-z0-9-]+\\.cloudflareaccess\\.com$/;"],
  ["dots in the team label", "const TEAM_ISSUER = /^https:\\/\\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/;", "const TEAM_ISSUER = /^https:\\/\\/[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/;"]
] as const) {
  test(`a variant with ${name} is caught`, async () => {
    await assertCaughtBy(name, "a configured value is held to its stated shape, at each edge", () => checkPolicyBounds(variant({ find, replace })));
  });
}

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { serializeCanonicalEvidence } from "./operator-evidence-common.mjs";
import {
  createStagingTeardownGitHubAppTokenProvider,
  STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS
} from "./staging-teardown-github-app-token.mjs";
import {
  withStagingTeardownGitHubTokenCleanup
} from "./staging-teardown-hosted-capture-lib.mjs";

const CLIENT_ID = "Iv1.stagingteardownclient";
const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const INSTALLATION_ID = 90210;
const START = Date.parse("2026-08-09T12:00:00.000Z");

function keyPair() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKey: pair.publicKey
  };
}

function installation(overrides = {}) {
  return {
    id: INSTALLATION_ID,
    account: { login: "iAnonymous3000" },
    repository_selection: "selected",
    permissions: { administration: "write", metadata: "read" },
    suspended_at: null,
    ...overrides
  };
}

function tokenResponse({ token, now, ...overrides }) {
  return {
    token,
    expires_at: new Date(now + (60 * 60 * 1000)).toISOString(),
    permissions: { administration: "write", metadata: "read" },
    repository_selection: "selected",
    repositories: [{
      id: 42,
      name: "site-behavior-lab",
      full_name: REPOSITORY,
      owner: { login: "iAnonymous3000" }
    }],
    ...overrides
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function decodeJwt(jwt) {
  const [header, payload, signature] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url")
  };
}

function fixture({
  mutateInstallation,
  mutateToken,
  revokeStatus = 204,
  persistFailureName = null,
  mintContentType = "application/json"
} = {}) {
  const keys = keyPair();
  let clock = START;
  let mintNumber = 0;
  let revokeNumber = 0;
  let scheduled = null;
  const calls = [];
  const raw = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url.href, init });
    if (url.pathname === "/repos/iAnonymous3000/site-behavior-lab/installation") {
      const value = installation();
      mutateInstallation?.(value);
      return json(value);
    }
    if (url.pathname === "/installation/token") {
      revokeNumber += 1;
      const status = typeof revokeStatus === "function"
        ? revokeStatus(revokeNumber)
        : revokeStatus;
      return status === 204
        ? new Response(null, { status: 204 })
        : json({ message: "refused" }, status);
    }
    assert.equal(
      url.pathname,
      `/app/installations/${INSTALLATION_ID}/access_tokens`
    );
    mintNumber += 1;
    const value = tokenResponse({
      token: `ghs_refresh_${String(mintNumber).padStart(2, "0")}_${"x".repeat(24)}`,
      now: clock
    });
    mutateToken?.(value);
    return new Response(JSON.stringify(value), {
      status: 201,
      headers: mintContentType === null ? {} : { "content-type": mintContentType }
    });
  };
  const provider = createStagingTeardownGitHubAppTokenProvider({
    clientId: CLIENT_ID,
    privateKey: keys.privateKey,
    fetchImpl,
    now: () => new Date(clock),
    persistRaw: async (name, bytes) => {
      raw.push({ name, bytes: Buffer.from(bytes) });
      if (name === persistFailureName) {
        throw new Error("mint raw persistence failed");
      }
    },
    setTimeoutImpl(callback, delay) {
      const handle = { unref() {} };
      scheduled = { callback, delay, handle };
      return handle;
    },
    clearTimeoutImpl(handle) {
      if (scheduled?.handle === handle) scheduled = null;
    }
  });
  return {
    provider,
    calls,
    raw,
    publicKey: keys.publicKey,
    setClock(value) { clock = value; },
    scheduled: () => scheduled
  };
}

test("the App provider signs RS256 JWTs and mints only exact repository Administration write tokens", async () => {
  const state = fixture();
  const token = await state.provider.getToken();
  assert.match(token, /^ghs_refresh_01_/);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].init.method, "GET");
  assert.equal(state.calls[1].init.method, "POST");
  assert.equal(state.calls[0].init.redirect, "error");
  assert.equal(state.calls[1].init.redirect, "error");
  assert.equal(
    state.calls[1].init.body,
    serializeCanonicalEvidence({
      repositories: ["site-behavior-lab"],
      permissions: { administration: "write" }
    })
  );

  const jwt = state.calls[0].init.headers.authorization.replace(/^Bearer /, "");
  assert.equal(state.calls[1].init.headers.authorization, `Bearer ${jwt}`);
  const decoded = decodeJwt(jwt);
  assert.deepEqual(decoded.header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decoded.payload, {
    iat: Math.floor(START / 1000) - 60,
    exp: Math.floor(START / 1000) + (9 * 60),
    iss: CLIENT_ID
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(decoded.signingInput, "ascii"),
      state.publicKey,
      decoded.signature
    ),
    true
  );
  assert.deepEqual(
    state.raw.map((entry) => entry.name),
    ["github-app-installation-1.json", "github-app-token-1.json"]
  );
  assert.match(state.raw[1].bytes.toString("utf8"), /ghs_refresh_01/);
});

test("the cached token is reused and refreshed with five minutes remaining", async () => {
  const state = fixture();
  const first = await state.provider.getToken();
  state.setClock(
    START + (60 * 60 * 1000) -
      STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS - 1
  );
  assert.equal(await state.provider.getToken(), first);
  assert.equal(state.calls.length, 2);

  state.setClock(
    START + (60 * 60 * 1000) -
      STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS
  );
  const second = await state.provider.getToken();
  assert.notEqual(second, first);
  assert.equal(state.calls.length, 5);
  assert.equal(new URL(state.calls[4].url).pathname, "/installation/token");
  assert.equal(state.calls[4].init.method, "DELETE");
  assert.equal(state.calls[4].init.headers.authorization, `Bearer ${first}`);
  assert.equal(state.provider.refreshCount(), 2);
});

test("the scheduled refresh revokes its predecessor and final cleanup revokes the current token", async () => {
  const state = fixture();
  const first = await state.provider.getToken();
  assert.equal(state.scheduled().delay, 55 * 60 * 1000);
  state.setClock(START + (55 * 60 * 1000));
  await state.scheduled().callback();
  assert.equal(state.provider.refreshCount(), 2);
  assert.equal(new URL(state.calls[4].url).pathname, "/installation/token");
  assert.equal(state.calls[4].init.headers.authorization, `Bearer ${first}`);

  const second = await state.provider.getToken();
  assert.notEqual(second, first);
  await state.provider.revoke();
  assert.equal(state.calls.length, 6);
  assert.equal(new URL(state.calls[5].url).pathname, "/installation/token");
  assert.equal(state.calls[5].init.headers.authorization, `Bearer ${second}`);
  assert.deepEqual(
    state.raw.map((entry) => entry.name),
    [
      "github-app-installation-1.json",
      "github-app-token-1.json",
      "github-app-installation-2.json",
      "github-app-token-2.json",
      "github-app-token-1-revoke.json",
      "github-app-token-2-revoke.json"
    ]
  );
  assert.equal(state.raw[4].bytes.length, 0);
  assert.equal(state.raw[5].bytes.length, 0);
  await assert.rejects(state.provider.getToken(), /token provider is closing/);
});

test("revocation refusal is persisted privately and fails cleanup closed", async () => {
  const state = fixture({ revokeStatus: 500 });
  await state.provider.getToken();
  await assert.rejects(
    state.provider.revoke(),
    /GitHub App installation token revocation failed/
  );
  assert.equal(state.raw.at(-1).name, "github-app-token-1-revoke.json");
  assert.match(state.raw.at(-1).bytes.toString("utf8"), /refused/);
});

test("a failed predecessor revocation remains authoritative after replacement cleanup", async () => {
  const state = fixture({
    revokeStatus: (attempt) => attempt === 1 ? 500 : 204
  });
  await state.provider.getToken();
  state.setClock(START + (55 * 60 * 1000));
  await assert.rejects(
    state.provider.getToken(),
    /GitHub App installation token revocation failed/
  );
  await assert.rejects(
    state.provider.revoke(),
    /GitHub App installation token revocation failed/
  );
  assert.equal(
    state.raw.filter((entry) => entry.name.endsWith("-revoke.json")).length,
    2
  );
});

test("a 201 token is revoked even when its raw-response persistence fails", async () => {
  const state = fixture({ persistFailureName: "github-app-token-1.json" });
  await assert.rejects(
    state.provider.getToken(),
    /mint raw persistence failed/
  );
  await state.provider.revoke();
  assert.deepEqual(
    state.calls.map((call) => [new URL(call.url).pathname, call.init.method]),
    [
      ["/repos/iAnonymous3000/site-behavior-lab/installation", "GET"],
      [`/app/installations/${INSTALLATION_ID}/access_tokens`, "POST"],
      ["/installation/token", "DELETE"]
    ]
  );
  assert.match(
    state.calls[2].init.headers.authorization,
    /^Bearer ghs_refresh_01_/
  );
  assert.equal(state.raw.at(-1).name, "github-app-token-1-revoke.json");
});

test("a 201 token is registered for revocation before missing or wrong Content-Type fails", async () => {
  for (const mintContentType of [null, "text/plain"]) {
    const state = fixture({ mintContentType });
    await assert.rejects(
      state.provider.getToken(),
      /did not return application\/json/
    );
    await state.provider.revoke();
    assert.deepEqual(
      state.calls.map((call) => [new URL(call.url).pathname, call.init.method]),
      [
        ["/repos/iAnonymous3000/site-behavior-lab/installation", "GET"],
        [`/app/installations/${INSTALLATION_ID}/access_tokens`, "POST"],
        ["/installation/token", "DELETE"]
      ]
    );
    assert.match(state.calls[2].init.headers.authorization, /^Bearer ghs_refresh_01_/);
  }
});

test("hosted capture revokes on success and failure, and cleanup failure is authoritative", async () => {
  for (const operation of [
    async () => "complete",
    async () => { throw new Error("ceremony failed"); }
  ]) {
    let revoked = 0;
    const provider = { async revoke() { revoked += 1; } };
    try {
      await withStagingTeardownGitHubTokenCleanup(provider, operation);
    } catch (error) {
      assert.match(error.message, /ceremony failed/);
    }
    assert.equal(revoked, 1);
  }

  await assert.rejects(
    withStagingTeardownGitHubTokenCleanup(
      { async revoke() { throw new Error("credential cleanup failed"); } },
      async () => { throw new Error("ceremony failed first"); }
    ),
    /credential cleanup failed/
  );
});

test("concurrent callers collapse to one bounded two-request mint", async () => {
  const state = fixture();
  const tokens = await Promise.all([
    state.provider.getToken(),
    state.provider.getToken(),
    state.provider.getToken()
  ]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(state.calls.length, 2);
  assert.equal(state.provider.refreshCount(), 1);
});

test("installation and minted-token scope mismatches fail closed", async () => {
  for (const [options, pattern] of [
    [
      { mutateInstallation: (value) => { value.repository_selection = "all"; } },
      /selected-repository access/
    ],
    [
      { mutateInstallation: (value) => { value.permissions.contents = "write"; } },
      /permissions must be exactly Administration write/
    ],
    [
      { mutateToken: (value) => { value.repositories[0].full_name = "iAnonymous3000/other"; } },
      /repository does not match/
    ],
    [
      { mutateToken: (value) => { value.permissions.actions = "write"; } },
      /permissions must be exactly Administration write/
    ]
  ]) {
    const state = fixture(options);
    await assert.rejects(state.provider.getToken(), pattern);
    await state.provider.revoke();
  }
});

test("short-lived tokens, backward clocks, and excess refreshes are refused", async () => {
  const short = fixture({
    mutateToken(value) {
      value.expires_at = new Date(START + (20 * 60 * 1000)).toISOString();
    }
  });
  await assert.rejects(
    short.provider.getToken(),
    /bounded approximately one-hour lifetime/
  );
  await short.provider.revoke();
  assert.equal(
    new URL(short.calls.at(-1).url).pathname,
    "/installation/token"
  );

  const keys = keyPair();
  let clock = START;
  const responses = [];
  const oneRefresh = createStagingTeardownGitHubAppTokenProvider({
    clientId: CLIENT_ID,
    privateKey: keys.privateKey,
    refreshMaxCount: 1,
    now: () => new Date(clock),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("/installation")) return json(installation());
      responses.push(url.pathname);
      return json(tokenResponse({
        token: `ghs_once_${"x".repeat(32)}`,
        now: clock
      }), 201);
    }
  });
  await oneRefresh.getToken();
  clock += 55 * 60 * 1000;
  await assert.rejects(oneRefresh.getToken(), /refresh budget of 1 was exceeded/);
  clock = START;
  await assert.rejects(oneRefresh.getToken(), /clock moved backwards/);
  assert.equal(responses.length, 1);
});

test("invalid keys and noncanonical repositories are rejected before HTTP", () => {
  assert.throws(
    () => createStagingTeardownGitHubAppTokenProvider({
      clientId: CLIENT_ID,
      privateKey: "not a private key"
    }),
    /valid PEM private key/
  );
  const keys = keyPair();
  assert.throws(
    () => createStagingTeardownGitHubAppTokenProvider({
      clientId: CLIENT_ID,
      privateKey: keys.privateKey,
      repository: "iAnonymous3000/another-repository"
    }),
    /must be exactly iAnonymous3000\/site-behavior-lab/
  );
});

test("the hosted workflow supplies refreshable App credentials instead of one pre-minted token", () => {
  const workflow = readFileSync(
    ".github/workflows/staging-teardown-evidence.yml",
    "utf8"
  );
  assert.match(
    workflow,
    /STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID: \$\{\{ vars\.STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID \}\}/
  );
  assert.match(
    workflow,
    /STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY: \$\{\{ secrets\.STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY \}\}/
  );
  assert.doesNotMatch(
    workflow,
    /STAGING_TEARDOWN_GITHUB_RUNNER_ADMIN_TOKEN|staging_runner_admin_token/
  );
  assert.doesNotMatch(workflow, /actions\/create-github-app-token/);
});

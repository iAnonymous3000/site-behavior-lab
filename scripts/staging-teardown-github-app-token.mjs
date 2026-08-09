import { createPrivateKey, sign } from "node:crypto";
import { isRecord } from "./operator-evidence-common.mjs";
import {
  createBoundedProviderClient,
  createProviderRequestLedger
} from "./staging-teardown-provider-http.mjs";

export const STAGING_TEARDOWN_GITHUB_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS =
  5 * 60 * 1000;
export const STAGING_TEARDOWN_GITHUB_APP_TOKEN_MINIMUM_LIFETIME_MS =
  55 * 60 * 1000;
export const STAGING_TEARDOWN_GITHUB_APP_TOKEN_MAXIMUM_LIFETIME_MS =
  65 * 60 * 1000;
export const STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT = 8;
export const STAGING_TEARDOWN_GITHUB_APP_REQUEST_BUDGET =
  STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT * 3;

const CLIENT_ID = /^[A-Za-z0-9._-]{8,128}$/;
const INSTALLATION_TOKEN = /^[A-Za-z0-9._~+\/-]{20,4096}$/;
const PRIVATE_KEY_MAX_BYTES = 32 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function clockMilliseconds(now, previous) {
  const raw = now();
  const value = raw instanceof Date ? raw : new Date(raw);
  const milliseconds = value.getTime();
  requireValue(Number.isFinite(milliseconds), "GitHub App token clock is invalid");
  requireValue(
    previous === null || milliseconds >= previous,
    "GitHub App token clock moved backwards"
  );
  return milliseconds;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parsePrivateKey(privateKey) {
  requireValue(
    typeof privateKey === "string" &&
      Buffer.byteLength(privateKey, "utf8") >= 1 &&
      Buffer.byteLength(privateKey, "utf8") <= PRIVATE_KEY_MAX_BYTES,
    "STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY must be a bounded PEM private key"
  );
  let key;
  try {
    key = createPrivateKey(privateKey);
  } catch {
    throw new Error(
      "STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY must be a valid PEM private key"
    );
  }
  requireValue(
    key.type === "private" && key.asymmetricKeyType === "rsa" &&
      Number(key.asymmetricKeyDetails?.modulusLength) >= 2048,
    "STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY must be an RSA private key of at least 2048 bits"
  );
  return key;
}

function createAppJwt(clientId, privateKey, nowMilliseconds) {
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + (9 * 60),
    iss: clientId
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput, "ascii"),
    privateKey
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

function exactAdministrationPermissions(value, label) {
  requireValue(isRecord(value), `${label} permissions must be an object`);
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const allowed = [
    [["administration", "write"]],
    [["administration", "write"], ["metadata", "read"]]
  ];
  requireValue(
    allowed.some((candidate) => JSON.stringify(entries) === JSON.stringify(candidate)),
    `${label} permissions must be exactly Administration write plus optional implicit Metadata read`
  );
}

function validateInstallation(value, owner) {
  requireValue(isRecord(value), "GitHub App repository installation must be an object");
  requireValue(
    Number.isSafeInteger(value.id) && value.id >= 1,
    "GitHub App repository installation id is invalid"
  );
  requireValue(
    isRecord(value.account) && value.account.login === owner,
    "GitHub App installation account does not match the canonical repository owner"
  );
  requireValue(
    value.repository_selection === "selected",
    "GitHub App installation must use selected-repository access"
  );
  requireValue(
    value.suspended_at === null,
    "GitHub App installation is suspended"
  );
  exactAdministrationPermissions(value.permissions, "GitHub App installation");
  return value.id;
}

function validateInstallationToken(value, repository, nowMilliseconds) {
  requireValue(isRecord(value), "GitHub App installation-token response must be an object");
  requireValue(
    typeof value.token === "string" && INSTALLATION_TOKEN.test(value.token),
    "GitHub App installation-token response did not contain a bounded token"
  );
  requireValue(
    value.repository_selection === "selected",
    "GitHub App installation token must use selected-repository access"
  );
  exactAdministrationPermissions(value.permissions, "GitHub App installation token");
  const [owner, name] = repository.split("/");
  requireValue(
    Array.isArray(value.repositories) && value.repositories.length === 1,
    "GitHub App installation token must name exactly one repository"
  );
  const selected = value.repositories[0];
  requireValue(
    isRecord(selected) && Number.isSafeInteger(selected.id) && selected.id >= 1 &&
      selected.name === name && selected.full_name === repository &&
      isRecord(selected.owner) && selected.owner.login === owner,
    "GitHub App installation token repository does not match the canonical repository"
  );
  requireValue(
    typeof value.expires_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.expires_at),
    "GitHub App installation-token expiry must be a UTC instant"
  );
  const expiresAt = Date.parse(value.expires_at);
  const lifetime = expiresAt - nowMilliseconds;
  requireValue(
    Number.isFinite(expiresAt) &&
      lifetime >= STAGING_TEARDOWN_GITHUB_APP_TOKEN_MINIMUM_LIFETIME_MS &&
      lifetime <= STAGING_TEARDOWN_GITHUB_APP_TOKEN_MAXIMUM_LIFETIME_MS,
    "GitHub App installation token must have a bounded approximately one-hour lifetime"
  );
  return { token: value.token, expiresAt };
}

/**
 * Mint and cache a repository-restricted GitHub App installation token.
 * Every caller obtains a token that remains valid for at least the refresh
 * skew; concurrent refreshes collapse to one two-request mint operation. Each
 * superseded token and the final current token is explicitly revoked through
 * its own bounded one-request client.
 */
export function createStagingTeardownGitHubAppTokenProvider({
  clientId,
  privateKey,
  repository = STAGING_TEARDOWN_GITHUB_REPOSITORY,
  fetchImpl = globalThis.fetch,
  persistRaw = async () => undefined,
  now = () => new Date(),
  apiBaseUrl = "https://api.github.com",
  refreshMaxCount = STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout
}) {
  requireValue(
    typeof clientId === "string" && CLIENT_ID.test(clientId),
    "STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID must be a bounded GitHub App client id"
  );
  requireValue(
    repository === STAGING_TEARDOWN_GITHUB_REPOSITORY,
    `GitHub App token repository must be exactly ${STAGING_TEARDOWN_GITHUB_REPOSITORY}`
  );
  requireValue(typeof fetchImpl === "function", "GitHub App token provider requires fetch");
  requireValue(typeof persistRaw === "function", "GitHub App token provider requires a private raw sink");
  requireValue(typeof now === "function", "GitHub App token provider requires a clock");
  requireValue(typeof setTimeoutImpl === "function", "GitHub App token provider requires a timer scheduler");
  requireValue(typeof clearTimeoutImpl === "function", "GitHub App token provider requires a timer canceller");
  requireValue(
    Number.isSafeInteger(refreshMaxCount) && refreshMaxCount >= 1 &&
      refreshMaxCount <= STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT,
    `GitHub App token refresh count must be between 1 and ${STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT}`
  );
  const rsaPrivateKey = parsePrivateKey(privateKey);
  const [owner, name] = repository.split("/");
  let cached = null;
  let inFlight = null;
  let refreshCount = 0;
  let lastClock = null;
  let refreshTimer = null;
  let closing = false;
  let backgroundFailure = null;
  let revocationFailure = null;
  let cleanupFailure = null;
  const issuedTokens = new Map();
  const revocationAttempts = new Set();
  const requestLedger = createProviderRequestLedger({
    label: "GitHub App credential mint-and-revocation authority",
    requestLimit: STAGING_TEARDOWN_GITHUB_APP_REQUEST_BUDGET
  });

  function registerCleanupCandidate(value, ordinal) {
    if (
      isRecord(value) && typeof value.token === "string" &&
      INSTALLATION_TOKEN.test(value.token)
    ) {
      issuedTokens.set(ordinal, {
        token: value.token,
        expiresAt: Number.NaN,
        ordinal
      });
    }
  }

  async function mint(nowMilliseconds) {
    refreshCount += 1;
    requireValue(
      refreshCount <= refreshMaxCount,
      `GitHub App token refresh budget of ${refreshMaxCount} was exceeded`
    );
    const jwt = createAppJwt(clientId, rsaPrivateKey, nowMilliseconds);
    const client = createBoundedProviderClient({
      provider: "github",
      baseUrl: apiBaseUrl,
      token: jwt,
      allowedMethods: ["GET", "POST"],
      requestLimit: 2,
      requestLedger,
      fetchImpl,
      persistRaw
    });
    const installation = await client.request({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      label: "GitHub App canonical repository installation lookup",
      rawName: `github-app-installation-${refreshCount}.json`
    });
    const installationId = validateInstallation(installation.value, owner);
    const minted = await client.request({
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      label: "GitHub App repository-only runner administration token mint",
      rawName: `github-app-token-${refreshCount}.json`,
      acceptedStatuses: [201],
      jsonBody: {
        repositories: [name],
        permissions: { administration: "write" }
      },
      // A 201 response creates a live credential before the private sink runs.
      // Register it synchronously so a subsequent persistence failure still
      // leaves the finally path enough authority to revoke that token.
      onAcceptedJsonBeforePersist: (value) => {
        registerCleanupCandidate(value, refreshCount);
      }
    });
    const validated = validateInstallationToken(
      minted.value,
      repository,
      nowMilliseconds
    );
    const record = { ...validated, ordinal: refreshCount };
    issuedTokens.set(record.ordinal, record);
    return record;
  }

  async function revokeRecord(record) {
    if (revocationAttempts.has(record.ordinal)) return;
    revocationAttempts.add(record.ordinal);
    const client = createBoundedProviderClient({
      provider: "github",
      baseUrl: apiBaseUrl,
      token: record.token,
      requestLimit: 1,
      requestLedger,
      fetchImpl,
      persistRaw
    });
    try {
      await client.request({
        method: "DELETE",
        path: "/installation/token",
        label: `GitHub App installation token ${record.ordinal} revocation`,
        rawName: `github-app-token-${record.ordinal}-revoke.json`,
        acceptedStatuses: [204]
      });
    } catch {
      revocationFailure ??= new Error(
        "GitHub App installation token revocation failed"
      );
      throw revocationFailure;
    }
    issuedTokens.delete(record.ordinal);
  }

  function cancelRefreshTimer() {
    if (refreshTimer !== null) {
      clearTimeoutImpl(refreshTimer);
      refreshTimer = null;
    }
  }

  function scheduleRefresh(record, nowMilliseconds) {
    cancelRefreshTimer();
    if (closing) return;
    const delay = Math.max(
      1,
      record.expiresAt -
        STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS -
        nowMilliseconds
    );
    refreshTimer = setTimeoutImpl(async () => {
      refreshTimer = null;
      if (closing) return;
      try {
        const scheduledNow = clockMilliseconds(now, lastClock);
        lastClock = scheduledNow;
        await beginRefresh(scheduledNow);
      } catch {
        backgroundFailure = new Error(
          "scheduled GitHub App installation token refresh failed"
        );
      }
    }, delay);
    try {
      refreshTimer?.unref?.();
    } catch {
      // Timer unref is only a process-liveness optimization. The scheduled
      // refresh remains authoritative if a host timer does not expose unref.
    }
  }

  function beginRefresh(nowMilliseconds) {
    if (inFlight !== null) return inFlight;
    const previous = cached;
    inFlight = (async () => {
      const replacement = await mint(nowMilliseconds);
      if (previous !== null) await revokeRecord(previous);
      cached = replacement;
      scheduleRefresh(replacement, nowMilliseconds);
      return replacement;
    })();
    void inFlight.finally(() => {
      inFlight = null;
    }).catch(() => undefined);
    return inFlight;
  }

  async function getToken() {
    requireValue(!closing, "GitHub App token provider is closing");
    if (backgroundFailure !== null) throw backgroundFailure;
    const nowMilliseconds = clockMilliseconds(now, lastClock);
    lastClock = nowMilliseconds;
    if (
      cached !== null &&
      nowMilliseconds <
        cached.expiresAt - STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_SKEW_MS
    ) {
      return cached.token;
    }
    return (await beginRefresh(nowMilliseconds)).token;
  }

  async function revoke() {
    closing = true;
    cancelRefreshTimer();
    if (cleanupFailure !== null) throw cleanupFailure;
    if (inFlight !== null) {
      try {
        await inFlight;
      } catch {
        // Every successfully minted token is tracked independently below, so
        // cleanup still attempts all credentials after a failed rotation.
      }
    }
    let failed = backgroundFailure ?? revocationFailure;
    const remaining = [...issuedTokens.values()]
      .sort((left, right) => right.ordinal - left.ordinal);
    for (const record of remaining) {
      if (revocationAttempts.has(record.ordinal)) continue;
      try {
        await revokeRecord(record);
      } catch {
        failed ??= new Error(
          "final GitHub App installation token revocation failed"
        );
      }
    }
    cached = null;
    if (failed !== null) {
      cleanupFailure = failed;
      throw failed;
    }
  }

  return Object.freeze({
    getToken,
    revoke,
    refreshCount: () => refreshCount,
    requestBudgetSnapshot: () => requestLedger.snapshot()
  });
}

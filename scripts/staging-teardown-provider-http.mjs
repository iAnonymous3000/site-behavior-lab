import { serializeCanonicalEvidence, sha256Bytes } from "./operator-evidence-common.mjs";
import { parseStrictJson } from "../lib/strict-json.ts";
import { assertStagingTeardownProjectionNfc } from "./staging-teardown-target-projections.mjs";

export const STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;
export const STAGING_TEARDOWN_PROVIDER_REQUEST_BODY_MAX_BYTES = 16 * 1024;
export const STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS = 14_000;
export const STAGING_TEARDOWN_PROVIDER_REQUEST_MAX_COUNT = 250;

const TOKEN = /^[A-Za-z0-9._~+\/-]{20,4096}$/;
const RAW_NAME = /^[a-z0-9][a-z0-9.-]{0,99}\.json$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function boundedToken(value, label) {
  requireValue(
    typeof value === "string" && TOKEN.test(value),
    `${label} must be a bounded non-whitespace bearer token`
  );
  return value;
}

/**
 * Share one deterministic request/deadline allocation across every client
 * created for the same bearer authority. This prevents helper-specific client
 * construction from resetting the safety budget.
 */
export function createProviderRequestLedger({
  label,
  requestLimit,
  deadlineBudgetMilliseconds = requestLimit * STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS
}) {
  requireValue(
    typeof label === "string" && label.length >= 1 && label.length <= 160,
    "provider request ledger label must be bounded"
  );
  requireValue(
    Number.isSafeInteger(requestLimit) && requestLimit >= 1 && requestLimit <= 2_000,
    `${label} request ledger limit must be between 1 and 2000`
  );
  requireValue(
    Number.isSafeInteger(deadlineBudgetMilliseconds) &&
      deadlineBudgetMilliseconds >= requestLimit &&
      deadlineBudgetMilliseconds <= 24 * 60 * 60 * 1000,
    `${label} request deadline budget is invalid`
  );
  let requestCount = 0;
  let reservedDeadlineMilliseconds = 0;
  return Object.freeze({
    consume(timeoutMilliseconds) {
      requireValue(
        Number.isSafeInteger(timeoutMilliseconds) && timeoutMilliseconds >= 1 &&
          timeoutMilliseconds <= 60_000,
        `${label} request timeout allocation is invalid`
      );
      requireValue(
        requestCount < requestLimit,
        `${label} cumulative request budget of ${requestLimit} was exceeded`
      );
      requireValue(
        reservedDeadlineMilliseconds + timeoutMilliseconds <= deadlineBudgetMilliseconds,
        `${label} cumulative request deadline budget was exceeded`
      );
      requestCount += 1;
      reservedDeadlineMilliseconds += timeoutMilliseconds;
    },
    snapshot() {
      return Object.freeze({
        requestCount,
        requestLimit,
        reservedDeadlineMilliseconds,
        deadlineBudgetMilliseconds
      });
    }
  });
}

async function boundedResponseBytes(response, label) {
  const declaredLength = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  // Undici exposes the decoded stream but preserves wire Content-Length for
  // gzip/br responses. The header can therefore bound and describe this body
  // only when the response is unencoded (or explicitly identity-encoded).
  const declaredLengthDescribesBody =
    contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  let expectedLength = null;
  if (declaredLengthDescribesBody && declaredLength !== null) {
    if (
      !/^[0-9]+$/.test(declaredLength) ||
      Number(declaredLength) > STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES
    ) {
      cancelBodyDetached(response);
      throw new Error(
        `${label} exceeds the ${STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES}-byte response limit`
      );
    }
    expectedLength = Number(declaredLength);
  }
  if (response.body === null) {
    requireValue(
      expectedLength === null || expectedLength === 0,
      `${label} response length does not match its Content-Length`
    );
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  // Retain one fixed-capacity buffer. A chunks array lets a hostile provider
  // allocate unbounded array/object metadata with empty or one-byte chunks
  // while remaining under the byte ceiling.
  const bytes = new Uint8Array(STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      if (value.byteLength > STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES - total) {
        cancelReaderDetached(reader);
        throw new Error(
          `${label} exceeds the ${STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES}-byte response limit`
        );
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cleanup failure must not mask the authoritative response refusal.
    }
  }
  requireValue(
    expectedLength === null || total === expectedLength,
    `${label} response length does not match its Content-Length`
  );
  return Buffer.from(bytes.subarray(0, total));
}

function observeDetached(value) {
  void value?.catch(() => undefined);
}

function cancelBodyDetached(response) {
  try {
    observeDetached(response.body?.cancel());
  } catch {
    // Provider refusal remains authoritative if cleanup itself fails.
  }
}

function cancelReaderDetached(reader) {
  try {
    observeDetached(reader.cancel());
  } catch {
    // Provider refusal remains authoritative if cleanup itself fails.
  }
}

function parseJson(bytes, label) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = parseStrictJson(text, STAGING_TEARDOWN_PROVIDER_RESPONSE_MAX_BYTES);
    return assertStagingTeardownProjectionNfc(value, `${label} provider JSON`);
  } catch {
    throw new Error(`${label} did not return bounded, strict UTF-8 JSON`);
  }
}

/**
 * A deliberately small provider client. It accepts only child paths of one
 * pinned API origin, follows no redirects, limits both response size and total
 * requests, persists every raw response to the private sink before parsing,
 * and never places a response body or credential in an error message.
 */
export function createBoundedProviderClient({
  provider,
  baseUrl,
  token,
  tokenProvider,
  allowedMethods = ["GET", "DELETE"],
  fetchImpl = globalThis.fetch,
  persistRaw = async () => undefined,
  timeoutMs = STAGING_TEARDOWN_PROVIDER_REQUEST_TIMEOUT_MS,
  requestLimit = STAGING_TEARDOWN_PROVIDER_REQUEST_MAX_COUNT,
  requestLedger
}) {
  requireValue(
    provider === "cloudflare" || provider === "github",
    "provider client must be cloudflare or github"
  );
  const base = new URL(baseUrl);
  requireValue(
    base.protocol === "https:" && base.pathname === "/" &&
      base.search === "" && base.hash === "",
    `${provider} API base URL must be an HTTPS origin`
  );
  const hasStaticToken = token !== undefined;
  const hasTokenProvider = tokenProvider !== undefined;
  requireValue(
    hasStaticToken !== hasTokenProvider,
    `${provider} client requires exactly one static token or token provider`
  );
  const staticBearer = hasStaticToken
    ? boundedToken(token, `${provider} API token`)
    : null;
  requireValue(
    hasTokenProvider ? typeof tokenProvider === "function" : true,
    `${provider} API token provider must be a function`
  );
  requireValue(
    Array.isArray(allowedMethods) && allowedMethods.length >= 1 &&
      allowedMethods.length <= 3 &&
      allowedMethods.every((method) => ["GET", "DELETE", "POST"].includes(method)) &&
      new Set(allowedMethods).size === allowedMethods.length,
    `${provider} allowed method set is invalid`
  );
  const methodSet = new Set(allowedMethods);
  requireValue(typeof fetchImpl === "function", `${provider} fetch implementation is required`);
  requireValue(typeof persistRaw === "function", `${provider} private raw sink is required`);
  requireValue(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000,
    `${provider} request timeout must be between 1 and 60000 milliseconds`
  );
  requireValue(
    Number.isSafeInteger(requestLimit) && requestLimit >= 1 && requestLimit <= 500,
    `${provider} request limit must be between 1 and 500`
  );
  requireValue(
    requestLedger === undefined ||
      (requestLedger !== null && typeof requestLedger === "object" &&
        typeof requestLedger.consume === "function" &&
        typeof requestLedger.snapshot === "function"),
    `${provider} shared request ledger is invalid`
  );
  let requestCount = 0;

  return Object.freeze({
    provider,
    async request({
      method = "GET",
      path,
      label,
      rawName,
      acceptedStatuses = [200],
      emptyResponseStatuses = [],
      jsonBody,
      cloudflareR2Jurisdiction,
      onAcceptedJsonBeforePersist
    }) {
      requireValue(
        methodSet.has(method),
        `${provider} staging teardown client does not permit ${String(method)}`
      );
      requireValue(
        typeof path === "string" && path.startsWith("/") &&
          !path.startsWith("//") && !/[\u0000-\u001f\u007f]/.test(path),
        `${provider} request path must be an absolute bounded API path`
      );
      requireValue(
        cloudflareR2Jurisdiction === undefined ||
          (provider === "cloudflare" &&
            ["default", "eu", "fedramp"].includes(cloudflareR2Jurisdiction) &&
            /^\/client\/v4\/accounts\/[^/?]+\/(?:r2\/buckets|event_notifications\/r2)(?:[/?]|$)/
              .test(path)),
        "cf-r2-jurisdiction is permitted only on a bounded Cloudflare R2 bucket request"
      );
      requireValue(
        typeof label === "string" && label.length >= 1 && label.length <= 160,
        `${provider} request label must be bounded`
      );
      requireValue(RAW_NAME.test(rawName), `${provider} private response name is invalid`);
      requireValue(
        Array.isArray(acceptedStatuses) && acceptedStatuses.length >= 1 &&
          acceptedStatuses.every((status) => Number.isInteger(status) && status >= 200 && status <= 599),
        `${provider} accepted status set is invalid`
      );
      requireValue(
        Array.isArray(emptyResponseStatuses) &&
          emptyResponseStatuses.every(
            (status) => status !== 204 && acceptedStatuses.includes(status)
          ),
        `${provider} empty-response status set is invalid`
      );
      requireValue(
        onAcceptedJsonBeforePersist === undefined ||
          typeof onAcceptedJsonBeforePersist === "function",
        `${provider} pre-persistence JSON observer must be a function`
      );
      requireValue(
        method === "POST" ? jsonBody !== undefined : jsonBody === undefined,
        method === "POST"
          ? "staging teardown POST requests require one canonical JSON body"
          : "staging teardown GET and DELETE requests must not carry request bodies"
      );
      let requestBody;
      if (jsonBody !== undefined) {
        requestBody = serializeCanonicalEvidence(jsonBody);
        requireValue(
          Buffer.byteLength(requestBody, "utf8") >= 1 &&
            Buffer.byteLength(requestBody, "utf8") <=
              STAGING_TEARDOWN_PROVIDER_REQUEST_BODY_MAX_BYTES,
          `${provider} request body exceeds the ${STAGING_TEARDOWN_PROVIDER_REQUEST_BODY_MAX_BYTES}-byte limit`
        );
      }
      requireValue(
        requestCount < requestLimit,
        `${provider} request budget of ${requestLimit} was exceeded`
      );
      requestLedger?.consume(timeoutMs);
      requestCount += 1;
      const url = new URL(path, base);
      requireValue(url.origin === base.origin, `${provider} request escaped its pinned API origin`);

      let bearer = staticBearer;
      if (hasTokenProvider) {
        try {
          bearer = boundedToken(
            await tokenProvider(),
            `${provider} refreshed API token`
          );
        } catch {
          throw new Error(`${label} credential refresh failed`);
        }
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${bearer}`,
            ...(requestBody === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(cloudflareR2Jurisdiction === undefined
              ? {}
              : { "cf-r2-jurisdiction": cloudflareR2Jurisdiction }),
            ...(provider === "github"
              ? {
                  "x-github-api-version": "2022-11-28",
                  "user-agent": "site-behavior-lab-staging-teardown-v1"
                }
              : {})
          },
          ...(requestBody === undefined ? {} : { body: requestBody }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        throw new Error(`${label} failed before an HTTP response`);
      }
      const bytes = await boundedResponseBytes(response, label);
      let prePersistError;
      if (onAcceptedJsonBeforePersist !== undefined) {
        try {
          requireValue(
            acceptedStatuses.includes(response.status),
            `${label} returned HTTP ${response.status}`
          );
          requireValue(
            bytes.length >= 1,
            `${label} did not return non-empty JSON for pre-persistence observation`
          );
          const observerResult = onAcceptedJsonBeforePersist(
            parseJson(bytes, label)
          );
          requireValue(
            observerResult === undefined,
            `${label} pre-persistence JSON observer must be synchronous`
          );
          // Register cleanup authority from bounded strict JSON before checking
          // metadata that can be missing on an otherwise credential-creating
          // response. A bad Content-Type still fails authoritatively below,
          // after the caller has retained enough opaque state to revoke.
          const contentType = response.headers.get("content-type") ?? "";
          requireValue(
            /^application\/json(?:;|$)/i.test(contentType),
            `${label} did not return application/json`
          );
        } catch (error) {
          prePersistError = error;
        }
      }
      // Persistence remains authoritative. Even a pre-persistence observer or
      // response-validation failure cannot bypass the private raw sink, and a
      // sink failure is the error returned to the caller.
      await persistRaw(rawName, bytes);
      if (prePersistError !== undefined) throw prePersistError;
      requireValue(
        acceptedStatuses.includes(response.status),
        `${label} returned HTTP ${response.status}`
      );
      if (bytes.length === 0) {
        requireValue(
          response.status === 204 || emptyResponseStatuses.includes(response.status),
          `${label} returned an empty non-204 response`
        );
        return { status: response.status, value: null };
      }
      const contentType = response.headers.get("content-type") ?? "";
      requireValue(
        /^application\/json(?:;|$)/i.test(contentType),
        `${label} did not return application/json`
      );
      return { status: response.status, value: parseJson(bytes, label) };
    },
    requestCount() {
      return requestCount;
    }
  });
}

export function unwrapCloudflareResponse(response, label) {
  requireValue(
    response !== null && typeof response === "object" && !Array.isArray(response),
    `${label} must be a Cloudflare response object`
  );
  requireValue(response.success === true, `${label} did not report success`);
  requireValue(
    response.errors === undefined ||
      (Array.isArray(response.errors) && response.errors.length === 0),
    `${label} reported provider errors`
  );
  return response.result;
}

/** Return an evidence artifact containing only a digest of selected facts. */
export function stagingTeardownProviderEvidence({
  kind,
  sessionId,
  provider,
  logicalName,
  phase,
  selectedFacts
}) {
  requireValue(
    kind === "provider-inventory-response" || kind === "provider-removal-response",
    "provider evidence kind is invalid"
  );
  const bytes = serializeCanonicalEvidence({
    schemaVersion: 1,
    provider,
    logicalName,
    phase,
    selectedFactsSha256: sha256Bytes(serializeCanonicalEvidence(selectedFacts))
  });
  return { kind, sessionId, bytes };
}

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import {
  isRecord,
  serializeCanonicalEvidence
} from "./operator-evidence-common.mjs";
import {
  buildWafCeilingEvidence,
  executeWafCeilingProbe,
  PRODUCTION_WAF_ORIGIN,
  serializeWafCeilingEvidence,
  serializeWafProbeTranscript,
  validateWafCeilingEvidence,
  WAF_PROVIDER_QUERY_MAX_WINDOW_MS,
  WAF_ROUTE_CONTRACT
} from "./waf-ceiling-evidence-lib.mjs";

export const WAF_HOSTED_MANIFEST_KIND =
  "site-behavior-waf-ceiling-sanitized-provider-manifest";
export const WAF_HOSTED_PRODUCER_CLOSURE_KIND =
  "site-behavior-waf-ceiling-producer-closure";
export const WAF_HOSTED_PRODUCER_CLOSURE_PATHS = Object.freeze([
  ".github/workflows/waf-ceiling-evidence.yml",
  "lib/canonical-json.ts",
  "lib/sha256.ts",
  "package-lock.json",
  "package.json",
  "scripts/operator-evidence-common.mjs",
  "scripts/waf-ceiling-evidence-lib.mjs",
  "scripts/waf-hosted-capture-lib.mjs",
  "scripts/waf-hosted-capture.mjs",
  "tsconfig.json",
  "tsconfig.schema.json"
]);
export const WAF_HOSTED_RULE_PHASE = "http_ratelimit";
// Cloudflare assigns this API ref independently of the dashboard display name.
// Read back from the production rule's displayed API request on 2026-09-06.
export const WAF_HOSTED_RULE_REF = "dcfa52c1a2664133be6f4ae2a5d95d39";
export const WAF_HOSTED_RULESET_ENDPOINT =
  "https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint";
export const WAF_HOSTED_GRAPHQL_ENDPOINT =
  "https://api.cloudflare.com/client/v4/graphql";
export const WAF_HOSTED_ADAPTER_NAME =
  "site-behavior-lab-cloudflare-waf-hosted-adapter";
export const WAF_HOSTED_ADAPTER_VERSION = "1";
export const WAF_HOSTED_SAFE_FILES = Object.freeze([
  "receipt.json",
  "sanitized-provider-manifest.json"
]);
export const WAF_HOSTED_GRAPHQL_LIMIT = 100;
export const WAF_HOSTED_EVENT_POLL_ATTEMPTS = 12;
export const WAF_HOSTED_EVENT_POLL_INTERVAL_MS = 5_000;
export const WAF_HOSTED_PROVIDER_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const WAF_HOSTED_REQUEST_TIMEOUT_MS = 10_000;
export const WAF_HOSTED_PRODUCER_FILE_MAX_BYTES = 1024 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/;
const ZONE_ID = /^[0-9a-f]{32}$/;
const RULE_ID = /^[0-9a-f]{32}$/;
const RULE_VERSION = /^[1-9][0-9]*$/;
const RAY_ID = /^([0-9a-fA-F]{16})(?:-[A-Za-z]{3})?$/;
const TOKEN = /^[A-Za-z0-9_-]{20,4096}$/;
const GRAPHQL_EVENT_KEYS = Object.freeze([
  "action",
  "clientRequestHTTPMethodName",
  "clientRequestPath",
  "datetime",
  "rayName",
  "ruleId"
]);
const EXPECTED_CHARACTERISTICS = Object.freeze(["cf.colo.id", "ip.src"]);
const EXPECTED_EXPRESSION_PARTS = Object.freeze([
  '(http.request.method eq "GET" and http.request.uri.path eq "/api/scan/admission")',
  '(http.request.method eq "POST" and http.request.uri.path eq "/api/scan")'
]);

export const WAF_HOSTED_SECURITY_EVENTS_QUERY = `
query SiteBehaviorWafEvents(
  $zoneTag: string!
  $startedAt: Time!
  $endedAt: Time!
) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(
        filter: { datetime_geq: $startedAt, datetime_leq: $endedAt }
        limit: ${WAF_HOSTED_GRAPHQL_LIMIT}
        orderBy: [datetime_ASC]
      ) {
        action
        clientRequestHTTPMethodName
        clientRequestPath
        datetime
        rayName
        ruleId
      }
    }
  }
}`.trim();

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  requireValue(isRecord(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireValue(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    `${label} must contain exactly ${wanted.join(", ")}`
  );
}

function canonicalInstant(value, label) {
  requireValue(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(Date.parse(value)).toISOString() === value,
    `${label} must be a canonical millisecond-precision UTC instant`
  );
  return value;
}

function currentInstant(now) {
  const value = now();
  const instant = value instanceof Date ? value : new Date(value);
  requireValue(
    Number.isFinite(instant.getTime()),
    "hosted WAF capture clock returned an invalid instant"
  );
  return instant.toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildWafHostedProducerClosure(readSourceBytes) {
  requireValue(
    typeof readSourceBytes === "function",
    "WAF producer closure requires a source-byte reader"
  );
  return {
    schemaVersion: 1,
    artifactKind: WAF_HOSTED_PRODUCER_CLOSURE_KIND,
    files: WAF_HOSTED_PRODUCER_CLOSURE_PATHS.map((repositoryPath) => {
      const value = readSourceBytes(repositoryPath);
      requireValue(
        Buffer.isBuffer(value) || value instanceof Uint8Array,
        `WAF producer closure ${repositoryPath} must resolve to exact bytes`
      );
      const bytes = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength
      );
      requireValue(
        bytes.byteLength >= 1 &&
          bytes.byteLength <= WAF_HOSTED_PRODUCER_FILE_MAX_BYTES,
        `WAF producer closure ${repositoryPath} must contain 1 through ${WAF_HOSTED_PRODUCER_FILE_MAX_BYTES} bytes`
      );
      return {
        path: repositoryPath,
        sha256: sha256(bytes)
      };
    })
  };
}

export function wafHostedProducerClosureFromDirectory(
  repositoryRoot = process.cwd()
) {
  const root = realpathSync(path.resolve(repositoryRoot));
  return buildWafHostedProducerClosure((repositoryPath) => {
    const absolute = path.join(root, ...repositoryPath.split("/"));
    const info = lstatSync(absolute);
    requireValue(
      info.isFile() && !info.isSymbolicLink(),
      `WAF producer closure ${repositoryPath} must be a regular file`
    );
    const resolved = realpathSync(absolute);
    const relative = path.relative(root, resolved);
    requireValue(
      relative === repositoryPath,
      `WAF producer closure ${repositoryPath} must not traverse a symbolic link`
    );
    return readFileSync(resolved);
  });
}

function validatedProducerClosure(value) {
  exactKeys(
    value,
    ["schemaVersion", "artifactKind", "files"],
    "WAF producer closure"
  );
  requireValue(
    value.schemaVersion === 1 &&
      value.artifactKind === WAF_HOSTED_PRODUCER_CLOSURE_KIND,
    "WAF producer closure has the wrong identity"
  );
  requireValue(
    Array.isArray(value.files) &&
      value.files.length === WAF_HOSTED_PRODUCER_CLOSURE_PATHS.length,
    "WAF producer closure must enumerate the exact source path set"
  );
  for (const [index, expectedPath] of
    WAF_HOSTED_PRODUCER_CLOSURE_PATHS.entries()) {
    const entry = value.files[index];
    exactKeys(entry, ["path", "sha256"], `WAF producer closure file ${index}`);
    requireValue(
      entry.path === expectedPath &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
      `WAF producer closure file ${index} must bind ${expectedPath}`
    );
  }
  return value;
}

function parseUtf8Json(bytes, label) {
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
  return value;
}

function observeDetached(value) {
  void Promise.resolve(value).catch(() => undefined);
}

function cancelResponseBodyDetached(response) {
  try {
    observeDetached(response.body?.cancel?.());
  } catch {
    // The authoritative response refusal must not depend on cleanup.
  }
}

function cancelReaderDetached(reader, reason) {
  try {
    observeDetached(reader.cancel(reason));
  } catch {
    // The authoritative response refusal must not depend on cleanup.
  }
}

export async function boundedWafResponseBytes(response, label) {
  const declaredLength = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  // Node's Fetch implementation transparently decodes encoded response
  // bodies but preserves the wire Content-Length header. That header is an
  // exact decoded-body contract only for an unencoded (or explicit identity)
  // response; for gzip/br/etc. the decoded byte ceiling remains authoritative.
  const declaredLengthDescribesBody =
    contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  let declaredBytes = null;
  if (
    declaredLengthDescribesBody &&
    declaredLength !== null &&
    (!/^[0-9]+$/.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength)) ||
      Number(declaredLength) > WAF_HOSTED_PROVIDER_RESPONSE_MAX_BYTES)
  ) {
    cancelResponseBodyDetached(response);
    throw new Error(
      `${label} exceeds the ${WAF_HOSTED_PROVIDER_RESPONSE_MAX_BYTES}-byte response limit`
    );
  }
  if (declaredLength !== null && declaredLengthDescribesBody) {
    declaredBytes = Number(declaredLength);
  }
  if (response.body === null) {
    requireValue(
      declaredBytes === null || declaredBytes === 0,
      `${label} body length changed in transit`
    );
    throw new Error(`${label} returned an empty response`);
  }
  const reader = response.body.getReader();
  // Keep one fixed buffer. A byte ceiling does not bound an array of chunk
  // objects when a peer emits arbitrarily many empty or one-byte chunks.
  const capacity =
    declaredBytes === null
      ? WAF_HOSTED_PROVIDER_RESPONSE_MAX_BYTES
      : declaredBytes;
  const bytes = Buffer.allocUnsafe(capacity);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error(`${label} returned a non-byte response chunk`);
      }
      if (value.byteLength === 0) continue;
      if (
        value.byteLength >
        WAF_HOSTED_PROVIDER_RESPONSE_MAX_BYTES - total
      ) {
        throw new Error(
          `${label} exceeds the ${WAF_HOSTED_PROVIDER_RESPONSE_MAX_BYTES}-byte response limit`
        );
      }
      if (value.byteLength > capacity - total) {
        throw new Error(`${label} body length changed in transit`);
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } catch (error) {
    cancelReaderDetached(reader, "WAF hosted response was refused");
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Broken transport cleanup must not mask the authoritative verdict.
    }
  }
  requireValue(total > 0, `${label} returned an empty response`);
  requireValue(
    declaredBytes === null || total === declaredBytes,
    `${label} body length changed in transit`
  );
  return Buffer.from(bytes.subarray(0, total));
}

async function providerRequest({
  fetchImpl,
  url,
  label,
  rawName,
  token,
  method = "GET",
  body,
  persistRaw
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(WAF_HOSTED_REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new Error(`${label} failed before an HTTP response`);
  }
  if (response.status !== 200) {
    cancelResponseBodyDetached(response);
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    cancelResponseBodyDetached(response);
    throw new Error(`${label} did not return application/json`);
  }
  const bytes = await boundedWafResponseBytes(response, label);
  await persistRaw(rawName, bytes);
  return bytes;
}

function normalizedExpression(value) {
  requireValue(
    typeof value === "string" && value.length <= 2_000,
    "selected WAF rule expression must be a bounded string"
  );
  return value.replace(/\s+/g, "");
}

function expectedExpressions() {
  const forward = `${EXPECTED_EXPRESSION_PARTS[0]} or ${EXPECTED_EXPRESSION_PARTS[1]}`;
  const reverse = `${EXPECTED_EXPRESSION_PARTS[1]} or ${EXPECTED_EXPRESSION_PARTS[0]}`;
  const host = `http.host eq "${new URL(PRODUCTION_WAF_ORIGIN).hostname}"`;
  return new Set(
    [forward, reverse, `(${forward})`, `(${reverse})`,
      `(${host} and (${forward}))`, `(${host} and (${reverse}))`
    ].map(normalizedExpression)
  );
}

export function selectCloudflareWafRule(rawValue) {
  requireValue(isRecord(rawValue), "Cloudflare rulesets response must be an object");
  requireValue(
    rawValue.success === true,
    "Cloudflare rulesets response did not report success"
  );
  requireValue(
    rawValue.errors === undefined ||
      (Array.isArray(rawValue.errors) && rawValue.errors.length === 0),
    "Cloudflare rulesets response contains errors"
  );
  const result = rawValue.result;
  requireValue(isRecord(result), "Cloudflare rulesets response has no result");
  requireValue(
    result.phase === WAF_HOSTED_RULE_PHASE,
    `Cloudflare ruleset phase must be exactly ${WAF_HOSTED_RULE_PHASE}`
  );
  requireValue(
    Array.isArray(result.rules),
    "Cloudflare ruleset result must contain rules"
  );
  const matches = result.rules.filter(
    (rule) => isRecord(rule) && rule.ref === WAF_HOSTED_RULE_REF
  );
  requireValue(
    matches.length === 1,
    `Cloudflare ruleset must contain exactly one rule with ref ${WAF_HOSTED_RULE_REF}`
  );
  const rule = matches[0];
  requireValue(
    typeof rule.id === "string" && RULE_ID.test(rule.id),
    "selected WAF rule id must be an immutable lowercase Cloudflare API id"
  );
  requireValue(
    typeof rule.version === "string" && RULE_VERSION.test(rule.version),
    "selected WAF rule version must be an immutable positive API version"
  );
  requireValue(rule.enabled === true, "selected WAF rule must be enabled");
  requireValue(rule.action === "block", "selected WAF rule action must be block");
  requireValue(
    expectedExpressions().has(normalizedExpression(rule.expression)),
    "selected WAF rule expression must cover only the exact GET and POST admission method/path pairs"
  );
  requireValue(
    isRecord(rule.ratelimit),
    "selected WAF rule must contain a rate-limit policy"
  );
  requireValue(
    rule.ratelimit.requests_per_period === 10,
    "selected WAF rule requests_per_period must be exactly 10"
  );
  requireValue(
    rule.ratelimit.period === 10,
    "selected WAF rule period must be exactly 10 seconds"
  );
  requireValue(
    rule.ratelimit.mitigation_timeout === 10,
    "selected WAF rule mitigation_timeout must be exactly 10 seconds"
  );
  requireValue(
    Array.isArray(rule.ratelimit.characteristics) &&
      rule.ratelimit.characteristics.length === EXPECTED_CHARACTERISTICS.length &&
      JSON.stringify([...rule.ratelimit.characteristics].sort()) ===
        JSON.stringify(EXPECTED_CHARACTERISTICS),
    "selected WAF rule characteristics must be exactly cf.colo.id and ip.src"
  );
  requireValue(
    rule.ratelimit.counting_expression === undefined ||
      rule.ratelimit.counting_expression === "" ||
      (typeof rule.ratelimit.counting_expression === "string" &&
        normalizedExpression(rule.ratelimit.counting_expression) ===
          normalizedExpression(rule.expression)),
    "selected WAF rule counting_expression must be absent, empty, or equal the exact admission expression"
  );
  requireValue(
    rule.ratelimit.requests_to_origin === undefined ||
      rule.ratelimit.requests_to_origin === false,
    "selected WAF rule requests_to_origin must be absent or false"
  );
  requireValue(
    rule.ratelimit.score_per_period === undefined &&
      rule.ratelimit.score_response_header_name === undefined,
    "selected WAF rule must not use score-based rate limiting"
  );
  return {
    provider: "cloudflare",
    ruleId: rule.id,
    ruleVersion: rule.version,
    requestLimit: 10,
    windowSeconds: 10,
    mitigationTimeoutSeconds: 10,
    routes: WAF_ROUTE_CONTRACT.map((route) => ({ ...route }))
  };
}

export function parseCloudflareRulesetBytes(bytes) {
  return selectCloudflareWafRule(
    parseUtf8Json(bytes, "Cloudflare rulesets response")
  );
}

function normalizeBaseRayId(value, label) {
  requireValue(typeof value === "string", `${label} must be a Cloudflare Ray ID`);
  const match = value.match(RAY_ID);
  requireValue(match !== null, `${label} must be a Cloudflare Ray ID`);
  return match[1].toLowerCase();
}

function normalizeEventTimestamp(value, label, probeWindow) {
  const match =
    typeof value === "string"
      ? value.match(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.([0-9]{1,9}))?Z$/
        )
      : null;
  requireValue(
    match !== null && Number.isFinite(Date.parse(value)),
    `${label} datetime must be a valid UTC instant`
  );
  const providerStart = Date.parse(value);
  const fractionalDigits = match[1]?.length ?? 0;
  const providerEnd =
    providerStart +
    (fractionalDigits === 0
      ? 999
      : fractionalDigits === 1
        ? 99
        : fractionalDigits === 2
          ? 9
          : 0);
  if (probeWindow === undefined) {
    return new Date(providerStart).toISOString();
  }
  requireValue(
    isRecord(probeWindow),
    `${label} probe window must be an object`
  );
  const probeStartedAt = Date.parse(
    canonicalInstant(probeWindow.startedAt, `${label} probe startedAt`)
  );
  const probeCompletedAt = Date.parse(
    canonicalInstant(probeWindow.completedAt, `${label} probe completedAt`)
  );
  const overlapStartedAt = Math.max(providerStart, probeStartedAt);
  requireValue(
    overlapStartedAt <= Math.min(providerEnd, probeCompletedAt),
    `${label} provider timestamp precision does not overlap its exact probe window`
  );
  return new Date(overlapStartedAt).toISOString();
}

export function normalizeCloudflareSecurityEvents({
  rawValue,
  rulePolicy,
  expectedRayIds,
  probeWindows
}) {
  requireValue(isRecord(rawValue), "Cloudflare GraphQL response must be an object");
  requireValue(
    rawValue.errors === undefined ||
      rawValue.errors === null ||
      (Array.isArray(rawValue.errors) && rawValue.errors.length === 0),
    "Cloudflare GraphQL response contains errors"
  );
  const zones = rawValue.data?.viewer?.zones;
  requireValue(
    Array.isArray(zones) && zones.length === 1 && isRecord(zones[0]),
    "Cloudflare GraphQL response must contain exactly one selected zone"
  );
  const events = zones[0].firewallEventsAdaptive;
  requireValue(
    Array.isArray(events),
    "Cloudflare GraphQL response has no firewallEventsAdaptive events"
  );
  requireValue(
    events.length < WAF_HOSTED_GRAPHQL_LIMIT,
    `Cloudflare GraphQL result reached the ${WAF_HOSTED_GRAPHQL_LIMIT}-event bound; pagination is ambiguous`
  );
  requireValue(
    Array.isArray(expectedRayIds) &&
      expectedRayIds.length === WAF_ROUTE_CONTRACT.length,
    "exactly two private probe Ray IDs are required"
  );
  requireValue(
    probeWindows === undefined ||
      (Array.isArray(probeWindows) &&
        probeWindows.length === WAF_ROUTE_CONTRACT.length),
    "probeWindows must contain the exact two route windows"
  );
  const expected = expectedRayIds.map((value, index) => ({
    rayId: normalizeBaseRayId(value, `probe ${index + 1} Ray ID`),
    route: WAF_ROUTE_CONTRACT[index],
    ...(probeWindows === undefined
      ? {}
      : { probeWindow: probeWindows[index] })
  }));
  requireValue(
    new Set(expected.map((entry) => entry.rayId)).size === expected.length,
    "private probe Ray IDs must be distinct"
  );

  const normalized = [];
  for (const [index, event] of events.entries()) {
    if (!isRecord(event) || typeof event.rayName !== "string") continue;
    const rawRayMatch = event.rayName.match(RAY_ID);
    if (rawRayMatch === null) continue;
    const rayId = rawRayMatch[1].toLowerCase();
    const match = expected.find((entry) => entry.rayId === rayId);
    if (!match) continue;
    exactKeys(event, GRAPHQL_EVENT_KEYS, `matching Security Event ${index}`);
    requireValue(
      event.ruleId === rulePolicy.ruleId,
      "matching Security Event ruleId does not equal the immutable selected WAF rule id"
    );
    requireValue(
      event.action === "block",
      "matching Security Event action must be block"
    );
    requireValue(
      event.clientRequestHTTPMethodName === match.route.method,
      "matching Security Event method does not equal its probed admission route"
    );
    requireValue(
      event.clientRequestPath === match.route.path,
      "matching Security Event path does not equal its probed admission route"
    );
    normalized.push({
      ruleId: event.ruleId,
      method: event.clientRequestHTTPMethodName,
      path: event.clientRequestPath,
      action: event.action,
      timestamp: normalizeEventTimestamp(
        event.datetime,
        `matching Security Event ${index}`,
        match.probeWindow
      ),
      requestId: rayId
    });
  }

  const ordered = expected.map((entry) => {
    const matches = normalized.filter(
      (event) => event.requestId === entry.rayId
    );
    requireValue(
      matches.length <= 1,
      `Cloudflare Security Events returned ambiguous duplicate ${entry.route.id} events`
    );
    return matches[0] ?? null;
  });
  return {
    complete: ordered.every((event) => event !== null),
    events: ordered.filter((event) => event !== null)
  };
}

export function requiredHostedWafEnvironment(env) {
  const required = (name) => {
    const value = typeof env[name] === "string" ? env[name].trim() : "";
    requireValue(value.length > 0, `${name} is required`);
    return value;
  };
  const rulesToken = required("WAF_RULES_API_TOKEN");
  const analyticsToken = required("WAF_ANALYTICS_API_TOKEN");
  const zoneId = required("CLOUDFLARE_ZONE_ID");
  const githubSha = required("GITHUB_SHA");
  requireValue(
    env.GITHUB_ACTIONS === "true",
    "hosted WAF capture requires GitHub Actions"
  );
  requireValue(
    env.RUNNER_ENVIRONMENT === "github-hosted",
    "hosted WAF capture requires an isolated GitHub-hosted runner"
  );
  requireValue(
    TOKEN.test(rulesToken),
    "WAF_RULES_API_TOKEN has an invalid API-token shape"
  );
  requireValue(
    TOKEN.test(analyticsToken),
    "WAF_ANALYTICS_API_TOKEN has an invalid API-token shape"
  );
  requireValue(
    rulesToken !== analyticsToken,
    "WAF_RULES_API_TOKEN and WAF_ANALYTICS_API_TOKEN must be distinct least-privilege tokens"
  );
  requireValue(
    ZONE_ID.test(zoneId),
    "CLOUDFLARE_ZONE_ID must be a lowercase 32-character Cloudflare zone id"
  );
  requireValue(
    FULL_SHA.test(githubSha),
    "GITHUB_SHA must be a full lowercase Git commit"
  );
  return { rulesToken, analyticsToken, zoneId, githubSha };
}

async function readProductionHealth({ fetchImpl, candidateCommit }) {
  let response;
  try {
    response = await fetchImpl(
      new URL("/api/health", PRODUCTION_WAF_ORIGIN),
      {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(WAF_HOSTED_REQUEST_TIMEOUT_MS)
      }
    );
  } catch {
    throw new Error("production health read failed before an HTTP response");
  }
  if (response.status !== 200) {
    cancelResponseBodyDetached(response);
    throw new Error(`production health read returned HTTP ${response.status}`);
  }
  const bytes = await boundedWafResponseBytes(
    response,
    "production health read"
  );
  const health = parseUtf8Json(bytes, "production health response");
  requireValue(isRecord(health), "production health response must be an object");
  requireValue(
    health.deployment === candidateCommit,
    "production deployment does not equal the exact hosted capture candidate"
  );
  requireValue(health.status === "ok", "production health status must be ok");
  requireValue(
    Array.isArray(health.warnings) && health.warnings.length === 0,
    "production health warnings must be empty"
  );
  return health.deployment;
}

async function readRuleset({
  fetchImpl,
  zoneId,
  rulesToken,
  persistRaw
}) {
  const url = WAF_HOSTED_RULESET_ENDPOINT.replace("{zone_id}", zoneId);
  const bytes = await providerRequest({
    fetchImpl,
    url,
    label: "Cloudflare WAF rulesets read",
    rawName: "rulesets-phase-entrypoint.json",
    token: rulesToken,
    persistRaw
  });
  return parseCloudflareRulesetBytes(bytes);
}

function privateRayCapturingFetch(fetchImpl, privateRayIds, recordObservation, now) {
  const counts = new Map();
  return async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const route = WAF_ROUTE_CONTRACT.find(
      (candidate) =>
        candidate.method === method && candidate.path === url.pathname
    );
    requireValue(route, "WAF probe attempted an undeclared route");
    const count = (counts.get(route.id) ?? 0) + 1;
    counts.set(route.id, count);
    const response = await fetchImpl(input, init);
    try {
      // Record only fixed fields before correlation/receipt validation can
      // fail. A failed eleventh response is still an observation to preserve.
      const retryAfter = response.headers.get("retry-after");
      recordObservation({
        routeId: route.id,
        ordinal: count,
        observedAt: currentInstant(now),
        status: response.status,
        retryAfterSeconds: /^[0-9]{1,4}$/.test(retryAfter ?? "") ? Number(retryAfter) : null
      });
      if (count === 11) {
        privateRayIds.push(
          normalizeBaseRayId(
            response.headers.get("cf-ray"),
            `${route.id} request 11 Cf-Ray`
          )
        );
      }
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } finally {
      cancelResponseBodyDetached(response);
    }
  };
}

async function readSecurityEvents({
  fetchImpl,
  zoneId,
  analyticsToken,
  rulePolicy,
  expectedRayIds,
  transcript,
  persistRaw,
  now,
  wait,
  eventPollAttempts,
  eventPollIntervalMs
}) {
  const firstProbeStarted = Date.parse(transcript.probes[0].startedAt);
  const queryStartedAt = new Date(firstProbeStarted - 1_000).toISOString();
  for (let attempt = 1; attempt <= eventPollAttempts; attempt += 1) {
    const queryEndedAt = currentInstant(now);
    requireValue(
      Date.parse(queryEndedAt) >=
        Date.parse(transcript.probes.at(-1).completedAt),
      "Cloudflare Security Events query ended before the probes completed"
    );
    requireValue(
      Date.parse(queryEndedAt) - Date.parse(queryStartedAt) <=
        WAF_PROVIDER_QUERY_MAX_WINDOW_MS,
      "Cloudflare Security Events polling exceeded the five-minute query window"
    );
    const body = JSON.stringify({
      query: WAF_HOSTED_SECURITY_EVENTS_QUERY,
      variables: {
        zoneTag: zoneId,
        startedAt: queryStartedAt,
        endedAt: queryEndedAt
      }
    });
    const bytes = await providerRequest({
      fetchImpl,
      url: WAF_HOSTED_GRAPHQL_ENDPOINT,
      label: "Cloudflare Security Events GraphQL read",
      rawName: `security-events-${String(attempt).padStart(2, "0")}.json`,
      token: analyticsToken,
      method: "POST",
      body,
      persistRaw
    });
    const normalized = normalizeCloudflareSecurityEvents({
      rawValue: parseUtf8Json(bytes, "Cloudflare Security Events response"),
      rulePolicy,
      expectedRayIds,
      probeWindows: transcript.probes.map((probe) => ({
        startedAt: probe.startedAt,
        completedAt: probe.completedAt
      }))
    });
    if (normalized.complete) {
      return {
        tool: {
          name: WAF_HOSTED_ADAPTER_NAME,
          version: WAF_HOSTED_ADAPTER_VERSION
        },
        query: {
          provider: "cloudflare",
          zoneId,
          startedAt: queryStartedAt,
          endedAt: queryEndedAt
        },
        exportedAt: queryEndedAt,
        events: normalized.events
      };
    }
    if (attempt < eventPollAttempts) await wait(eventPollIntervalMs);
  }
  throw new Error(
    "Cloudflare Security Events did not expose exactly one correlated event for both admission probes within the bounded polling budget"
  );
}

export function buildWafHostedSanitizedManifest(
  receipt,
  producerClosure
) {
  const verdict = validateWafCeilingEvidence(receipt);
  requireValue(
    verdict.ok,
    `hosted WAF receipt is invalid: ${verdict.problems.join("; ")}`
  );
  return {
    schemaVersion: 1,
    artifactKind: WAF_HOSTED_MANIFEST_KIND,
    candidateCommit: receipt.candidateCommit,
    deploymentCommit: receipt.deploymentCommit,
    capturedAt: receipt.capturedAt,
    session: {
      startedAt: receipt.probes[0].startedAt,
      completedAt: receipt.capturedAt
    },
    ruleSelector: {
      phase: WAF_HOSTED_RULE_PHASE,
      ref: WAF_HOSTED_RULE_REF
    },
    rulePolicy: receipt.rulePolicy,
    producerClosure: validatedProducerClosure(producerClosure),
    wafRulesDigest: receipt.wafRulesDigest,
    providerEventReadbackDigest: receipt.providerEventReadbackDigest,
    sourceArtifacts: receipt.sourceArtifacts,
    receiptSha256: verdict.receiptDigest
  };
}

/** Provider access diagnostics only: no probes, release receipt, or manifest. */
export async function preflightHostedWafProviderAccess({ zoneId, rulesToken, analyticsToken,
  fetchImpl = globalThis.fetch, now = () => new Date() }) {
  requireValue(ZONE_ID.test(zoneId ?? ""), "zoneId must be a lowercase Cloudflare zone id");
  requireValue(TOKEN.test(rulesToken ?? "") && TOKEN.test(analyticsToken ?? "") && rulesToken !== analyticsToken,
    "two distinct scoped Cloudflare API tokens are required");
  // Responses stay in process memory; nothing raw is written or returned.
  const persistRaw = async () => undefined;
  const checkAnalytics = async () => {
    const endedAt = currentInstant(now);
    const bytes = await providerRequest({ fetchImpl, url: WAF_HOSTED_GRAPHQL_ENDPOINT,
      label: "Cloudflare Security Events preflight", rawName: "preflight.json", token: analyticsToken,
      method: "POST", persistRaw, body: JSON.stringify({ query: WAF_HOSTED_SECURITY_EVENTS_QUERY,
        variables: { zoneTag: zoneId, startedAt: new Date(Date.parse(endedAt) - 60_000).toISOString(), endedAt } }) });
    const value = parseUtf8Json(bytes, "Cloudflare Security Events preflight");
    requireValue(isRecord(value) && (value.errors == null || (Array.isArray(value.errors) && value.errors.length === 0)),
      "Cloudflare Security Events preflight contains GraphQL errors");
    const zones = value.data?.viewer?.zones;
    requireValue(Array.isArray(zones) && zones.length === 1 && Array.isArray(zones[0]?.firewallEventsAdaptive),
      "Cloudflare Security Events preflight did not return the selected zone's dataset");
  };
  const outcomes = await Promise.allSettled([
    readRuleset({ fetchImpl, zoneId, rulesToken, persistRaw }), checkAnalytics()
  ]);
  const failures = outcomes.filter(outcome => outcome.status === "rejected");
  if (failures.length) throw new Error(failures.map(outcome => outcome.reason.message).join("; "));
  return { providerAccess: "verified", rulePolicy: outcomes[0].value, releaseEvidence: false };
}

export async function captureHostedWafEvidence({
  candidateCommit,
  zoneId,
  rulesToken,
  analyticsToken,
  fetchImpl = globalThis.fetch,
  persistRaw = async () => undefined,
  recordObservation = () => undefined,
  now = () => new Date(),
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  eventPollAttempts = WAF_HOSTED_EVENT_POLL_ATTEMPTS,
  eventPollIntervalMs = WAF_HOSTED_EVENT_POLL_INTERVAL_MS,
  repositoryRoot = process.cwd()
}) {
  requireValue(
    FULL_SHA.test(candidateCommit ?? ""),
    "candidateCommit must be a full lowercase Git commit"
  );
  requireValue(
    ZONE_ID.test(zoneId ?? ""),
    "zoneId must be a lowercase 32-character Cloudflare zone id"
  );
  requireValue(
    TOKEN.test(rulesToken ?? "") && TOKEN.test(analyticsToken ?? ""),
    "both scoped Cloudflare API tokens are required"
  );
  requireValue(
    rulesToken !== analyticsToken,
    "the WAF rules and analytics tokens must be distinct"
  );
  requireValue(typeof fetchImpl === "function", "a fetch implementation is required");
  requireValue(typeof persistRaw === "function", "a private raw-byte sink is required");
  requireValue(typeof recordObservation === "function", "an observation sink is required");
  requireValue(
    Number.isSafeInteger(eventPollAttempts) &&
      eventPollAttempts >= 1 &&
      eventPollAttempts <= WAF_HOSTED_EVENT_POLL_ATTEMPTS,
    `eventPollAttempts must be from 1 through ${WAF_HOSTED_EVENT_POLL_ATTEMPTS}`
  );
  requireValue(
    Number.isSafeInteger(eventPollIntervalMs) &&
      eventPollIntervalMs >= 0 &&
      eventPollIntervalMs <= WAF_HOSTED_EVENT_POLL_INTERVAL_MS,
    `eventPollIntervalMs must be from 0 through ${WAF_HOSTED_EVENT_POLL_INTERVAL_MS}`
  );

  const deploymentCommit = await readProductionHealth({
    fetchImpl,
    candidateCommit
  });
  const rulePolicy = await readRuleset({
    fetchImpl,
    zoneId,
    rulesToken,
    persistRaw
  });
  const privateRayIds = [];
  const transcript = await executeWafCeilingProbe({
    baseUrl: PRODUCTION_WAF_ORIGIN,
    candidateCommit,
    deploymentCommit,
    rulePolicy,
    requestMaterial: {
      get: { headers: {} },
      post: { headers: {} }
    },
    fetchImpl: privateRayCapturingFetch(fetchImpl, privateRayIds, recordObservation, now),
    now,
    wait
  });
  requireValue(
    privateRayIds.length === WAF_ROUTE_CONTRACT.length,
    "both probe routes must retain one private Ray ID until provider correlation completes"
  );
  const providerExport = await readSecurityEvents({
    fetchImpl,
    zoneId,
    analyticsToken,
    rulePolicy,
    expectedRayIds: privateRayIds,
    transcript,
    persistRaw,
    now,
    wait,
    eventPollAttempts,
    eventPollIntervalMs
  });
  const receipt = buildWafCeilingEvidence({
    probeTranscriptBytes: serializeWafProbeTranscript(transcript),
    providerEventsExportBytes: serializeCanonicalEvidence(providerExport)
  });
  const producerClosure =
    wafHostedProducerClosureFromDirectory(repositoryRoot);
  return {
    receipt,
    manifest: buildWafHostedSanitizedManifest(receipt, producerClosure)
  };
}

export function verifyWafHostedSafeDirectory(
  directory,
  { repositoryRoot = process.cwd() } = {}
) {
  const entries = readdirSync(directory, { withFileTypes: true });
  requireValue(
    entries.every((entry) => entry.isFile()) &&
      JSON.stringify(entries.map((entry) => entry.name).sort()) ===
        JSON.stringify([...WAF_HOSTED_SAFE_FILES]),
    "hosted WAF output must contain only receipt.json and sanitized-provider-manifest.json"
  );
  for (const entry of entries) {
    requireValue(
      lstatSync(path.join(directory, entry.name)).isFile(),
      "hosted WAF output members must be regular files"
    );
  }
  const receiptBytes = readFileSync(path.join(directory, "receipt.json"));
  const manifestBytes = readFileSync(
    path.join(directory, "sanitized-provider-manifest.json")
  );
  const receipt = parseUtf8Json(receiptBytes, "hosted WAF receipt");
  const manifest = parseUtf8Json(
    manifestBytes,
    "hosted WAF sanitized provider manifest"
  );
  const verdict = validateWafCeilingEvidence(receipt);
  requireValue(verdict.ok, verdict.problems.join("; "));
  requireValue(
    Buffer.from(serializeWafCeilingEvidence(receipt), "utf8").equals(
      receiptBytes
    ),
    "hosted WAF receipt bytes are not canonical"
  );
  const expectedManifest = buildWafHostedSanitizedManifest(
    receipt,
    wafHostedProducerClosureFromDirectory(repositoryRoot)
  );
  requireValue(
    serializeCanonicalEvidence(manifest) ===
      serializeCanonicalEvidence(expectedManifest) &&
      Buffer.from(serializeCanonicalEvidence(manifest), "utf8").equals(
        manifestBytes
      ),
    "hosted WAF sanitized provider manifest does not canonically rederive the receipt"
  );
  return {
    ok: true,
    candidateCommit: receipt.candidateCommit,
    deploymentCommit: receipt.deploymentCommit,
    receiptSha256: sha256(receiptBytes)
  };
}

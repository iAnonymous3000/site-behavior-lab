import {
  boundedString,
  canonicalEvidenceDigest,
  exactKeys,
  isRecord,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const LOG_RETENTION_EVIDENCE_KIND =
  "site-behavior-log-retention-query-receipt";
export const LOG_RETENTION_EVIDENCE_SCHEMA_VERSION = 1;
export const LOG_RETENTION_EVIDENCE_PATH =
  "research/ops-evidence/log-retention.json";

export const LOG_QUERY_CONTRACT = Object.freeze([
  Object.freeze({ id: "health", routePrefix: "/api/health" }),
  Object.freeze({ id: "reports", routePrefix: "/reports/" })
]);
export const LOG_REDACTION_CONTRACT = Object.freeze({
  retainedEventFields: Object.freeze(["observedAt"]),
  discardedSensitiveClasses: Object.freeze([
    "target-url",
    "query-value",
    "raw-credential",
    "request-body",
    "personal-data-payload",
    "report-identifier"
  ])
});

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "candidateCommit",
  "deploymentCommit",
  "capturedAt",
  "policy",
  "logPolicyDigest",
  "retentionReadback",
  "results",
  "sourceArtifact"
];
const POLICY_KEYS = [
  "provider",
  "policyId",
  "retentionDays",
  "queryWindow",
  "maxEventsPerQuery",
  "queries",
  "redaction"
];
const QUERY_WINDOW_KEYS = ["startedAt", "endedAt"];
const QUERY_KEYS = ["id", "routePrefix"];
const REDACTION_KEYS = ["retainedEventFields", "discardedSensitiveClasses"];
const READBACK_KEYS = ["readAt", "configuredRetentionDays", "providerPolicyRef"];
const RESULT_KEYS = [
  "queryId",
  "matchCount",
  "firstMatchedAt",
  "lastMatchedAt",
  "events"
];
const EVENT_KEYS = ["observedAt"];
const SOURCE_ARTIFACT_KEYS = [
  "kind",
  "digest",
  "byteLength",
  "tool",
  "query",
  "retentionReadbackDigest"
];
const SOURCE_TOOL_KEYS = ["name", "version"];
const SOURCE_QUERY_KEYS = [
  "providerQueryRef",
  "startedAt",
  "endedAt"
];
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
export const LOG_PROVIDER_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
const PROVIDER_POLICY_REF_DOMAIN =
  "site-behavior-lab-log-retention-provider-policy-ref-v1\u0000";
const POLICY_ID_DOMAIN =
  "site-behavior-lab-log-retention-policy-id-v1\u0000";

export function logPolicyDigest(policy) {
  return canonicalEvidenceDigest(policy);
}

function policyProblems(policy) {
  const problems = [];
  if (!exactKeys(policy, POLICY_KEYS, "log policy", problems)) return problems;
  if (!boundedString(policy.provider, { maximum: 100 })) {
    problems.push("log policy.provider must be a bounded, trimmed string");
  }
  if (
    typeof policy.policyId !== "string" ||
    !SHA256_REF.test(policy.policyId)
  ) {
    problems.push(
      "log policy.policyId must be a domain-separated sha256 reference"
    );
  }
  if (
    !Number.isSafeInteger(policy.retentionDays) ||
    policy.retentionDays < 1 ||
    policy.retentionDays > 30
  ) {
    problems.push("log policy.retentionDays must be an integer from 1 through 30");
  }
  let windowStart = null;
  let windowEnd = null;
  if (exactKeys(policy.queryWindow, QUERY_WINDOW_KEYS, "log policy.queryWindow", problems)) {
    windowStart = requireCanonicalInstant(
      policy.queryWindow.startedAt,
      "log policy.queryWindow.startedAt",
      problems
    );
    windowEnd = requireCanonicalInstant(
      policy.queryWindow.endedAt,
      "log policy.queryWindow.endedAt",
      problems
    );
    if (windowStart !== null && windowEnd !== null) {
      if (windowEnd < windowStart) {
        problems.push("log policy query window must not run backwards");
      } else if (windowEnd - windowStart > policy.retentionDays * 86_400_000) {
        problems.push("log policy query window must not exceed the configured retention");
      }
    }
  }
  if (
    !Number.isSafeInteger(policy.maxEventsPerQuery) ||
    policy.maxEventsPerQuery < 1 ||
    policy.maxEventsPerQuery > 1_000
  ) {
    problems.push("log policy.maxEventsPerQuery must be an integer from 1 through 1000");
  }
  if (!Array.isArray(policy.queries) || policy.queries.length !== LOG_QUERY_CONTRACT.length) {
    problems.push("log policy.queries must contain the canonical health and reports queries");
  } else {
    for (const [index, expected] of LOG_QUERY_CONTRACT.entries()) {
      const query = policy.queries[index];
      if (!exactKeys(query, QUERY_KEYS, `log policy.queries[${index}]`, problems)) continue;
      for (const field of QUERY_KEYS) {
        if (query[field] !== expected[field]) {
          problems.push(
            `log policy.queries[${index}].${field} must be exactly ${expected[field]}`
          );
        }
      }
    }
  }
  if (exactKeys(policy.redaction, REDACTION_KEYS, "log policy.redaction", problems)) {
    for (const field of REDACTION_KEYS) {
      const expected = LOG_REDACTION_CONTRACT[field];
      if (
        !Array.isArray(policy.redaction[field]) ||
        policy.redaction[field].length !== expected.length ||
        policy.redaction[field].some((entry, index) => entry !== expected[index])
      ) {
        problems.push(`log policy.redaction.${field} must be the canonical list`);
      }
    }
  }
  return problems;
}

function resultProblems(result, expectedQuery, policy) {
  const problems = [];
  if (!exactKeys(result, RESULT_KEYS, `log result ${expectedQuery.id}`, problems)) {
    return problems;
  }
  if (result.queryId !== expectedQuery.id) {
    problems.push(`log result queryId must be exactly ${expectedQuery.id}`);
  }
  if (
    !Number.isSafeInteger(result.matchCount) ||
    result.matchCount < 1 ||
    result.matchCount > policy.maxEventsPerQuery
  ) {
    problems.push(
      `${expectedQuery.id}.matchCount must be from 1 through maxEventsPerQuery`
    );
  }
  if (!Array.isArray(result.events) || result.events.length !== result.matchCount) {
    problems.push(`${expectedQuery.id}.events length must equal matchCount`);
    return problems;
  }
  const eventTimes = [];
  for (const [index, event] of result.events.entries()) {
    if (!exactKeys(event, EVENT_KEYS, `${expectedQuery.id}.events[${index}]`, problems)) {
      continue;
    }
    const observedAt = requireCanonicalInstant(
      event.observedAt,
      `${expectedQuery.id}.events[${index}].observedAt`,
      problems
    );
    if (observedAt !== null) eventTimes.push(observedAt);
  }
  const sorted = [...eventTimes].sort((left, right) => left - right);
  if (
    eventTimes.length === sorted.length &&
    eventTimes.some((value, index) => value !== sorted[index])
  ) {
    problems.push(`${expectedQuery.id}.events must be sorted by observedAt`);
  }
  const first = requireCanonicalInstant(
    result.firstMatchedAt,
    `${expectedQuery.id}.firstMatchedAt`,
    problems
  );
  const last = requireCanonicalInstant(
    result.lastMatchedAt,
    `${expectedQuery.id}.lastMatchedAt`,
    problems
  );
  if (sorted.length > 0) {
    if (first !== sorted[0]) {
      problems.push(`${expectedQuery.id}.firstMatchedAt must be derived from events`);
    }
    if (last !== sorted.at(-1)) {
      problems.push(`${expectedQuery.id}.lastMatchedAt must be derived from events`);
    }
    const start = Date.parse(policy.queryWindow.startedAt);
    const end = Date.parse(policy.queryWindow.endedAt);
    if (sorted.some((instant) => instant < start || instant > end)) {
      problems.push(`${expectedQuery.id} contains an event outside the bounded query window`);
    }
  }
  return problems;
}

function sourceArtifactProblems(sourceArtifact, policy, retentionReadback) {
  const problems = [];
  if (
    !exactKeys(
      sourceArtifact,
      SOURCE_ARTIFACT_KEYS,
      "sourceArtifact",
      problems
    )
  ) {
    return problems;
  }
  if (sourceArtifact.kind !== "provider-log-retention-export") {
    problems.push(
      "sourceArtifact.kind must be exactly provider-log-retention-export"
    );
  }
  if (
    typeof sourceArtifact.digest !== "string" ||
    !SHA256_REF.test(sourceArtifact.digest)
  ) {
    problems.push("sourceArtifact.digest must be an exact sha256:<64 lowercase hex> reference");
  }
  if (
    !Number.isSafeInteger(sourceArtifact.byteLength) ||
    sourceArtifact.byteLength < 1 ||
    sourceArtifact.byteLength > LOG_PROVIDER_EXPORT_MAX_BYTES
  ) {
    problems.push(
      `sourceArtifact.byteLength must be between 1 and ${LOG_PROVIDER_EXPORT_MAX_BYTES}`
    );
  }
  if (
    exactKeys(
      sourceArtifact.tool,
      SOURCE_TOOL_KEYS,
      "sourceArtifact.tool",
      problems
    )
  ) {
    for (const field of SOURCE_TOOL_KEYS) {
      if (
        !boundedString(sourceArtifact.tool[field], {
          maximum: 100,
          pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
        })
      ) {
        problems.push(`sourceArtifact.tool.${field} must be a bounded identifier`);
      }
    }
  }
  if (
    exactKeys(
      sourceArtifact.query,
      SOURCE_QUERY_KEYS,
      "sourceArtifact.query",
      problems
    )
  ) {
    if (
      typeof sourceArtifact.query.providerQueryRef !== "string" ||
      !SHA256_REF.test(sourceArtifact.query.providerQueryRef)
    ) {
      problems.push(
        "sourceArtifact.query.providerQueryRef must be a domain-separated sha256 reference"
      );
    }
    if (
      sourceArtifact.query.startedAt !== policy?.queryWindow?.startedAt ||
      sourceArtifact.query.endedAt !== policy?.queryWindow?.endedAt
    ) {
      problems.push(
        "sourceArtifact.query must bind the exact log policy query window"
      );
    }
  }
  requireSha256(
    sourceArtifact.retentionReadbackDigest,
    "sourceArtifact.retentionReadbackDigest",
    problems
  );
  let expectedReadbackDigest = null;
  try {
    expectedReadbackDigest = canonicalEvidenceDigest(retentionReadback);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (
    expectedReadbackDigest !== null &&
    sourceArtifact.retentionReadbackDigest !== expectedReadbackDigest
  ) {
    problems.push(
      "sourceArtifact.retentionReadbackDigest must bind the exact retention readback"
    );
  }
  return problems;
}

export function validateLogRetentionEvidence(value) {
  const problems = [];
  if (!exactKeys(value, RECEIPT_KEYS, "log-retention receipt", problems)) {
    return { ok: false, problems, bindings: null, receiptDigest: null };
  }
  if (value.schemaVersion !== LOG_RETENTION_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be exactly ${LOG_RETENTION_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (value.artifactKind !== LOG_RETENTION_EVIDENCE_KIND) {
    problems.push(`artifactKind must be exactly ${LOG_RETENTION_EVIDENCE_KIND}`);
  }
  requireCommit(value.candidateCommit, "candidateCommit", problems);
  requireCommit(value.deploymentCommit, "deploymentCommit", problems);
  const capturedAt = requireCanonicalInstant(value.capturedAt, "capturedAt", problems);
  problems.push(...policyProblems(value.policy));
  let expectedPolicyDigest = null;
  try {
    expectedPolicyDigest = logPolicyDigest(value.policy);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  requireSha256(value.logPolicyDigest, "logPolicyDigest", problems);
  if (expectedPolicyDigest !== null && value.logPolicyDigest !== expectedPolicyDigest) {
    problems.push("logPolicyDigest does not match the exact canonical policy bytes");
  }
  if (
    exactKeys(
      value.retentionReadback,
      READBACK_KEYS,
      "retentionReadback",
      problems
    )
  ) {
    const readAt = requireCanonicalInstant(
      value.retentionReadback.readAt,
      "retentionReadback.readAt",
      problems
    );
    if (value.retentionReadback.configuredRetentionDays !== value.policy?.retentionDays) {
      problems.push("retentionReadback must equal policy.retentionDays");
    }
    if (
      typeof value.retentionReadback.providerPolicyRef !== "string" ||
      !SHA256_REF.test(value.retentionReadback.providerPolicyRef)
    ) {
      problems.push(
        "retentionReadback.providerPolicyRef must be a domain-separated sha256 reference"
      );
    }
    if (capturedAt !== null && readAt !== null && readAt > capturedAt) {
      problems.push("retentionReadback.readAt must not follow capturedAt");
    }
    if (
      capturedAt !== null &&
      readAt !== null &&
      value.capturedAt !== value.retentionReadback.readAt
    ) {
      problems.push(
        "capturedAt must exactly equal the effective source observation time"
      );
    }
    const queryEndedAt = Date.parse(value.policy?.queryWindow?.endedAt);
    if (
      readAt !== null &&
      Number.isFinite(queryEndedAt) &&
      readAt < queryEndedAt
    ) {
      problems.push("retentionReadback.readAt must not precede the query-window end");
    }
  }
  const queryEndedAt = Date.parse(value.policy?.queryWindow?.endedAt);
  if (
    capturedAt !== null &&
    Number.isFinite(queryEndedAt) &&
    queryEndedAt > capturedAt
  ) {
    problems.push("log policy query-window end must not follow capturedAt");
  }
  if (!Array.isArray(value.results) || value.results.length !== LOG_QUERY_CONTRACT.length) {
    problems.push("results must contain exactly the health and reports query results");
  } else {
    for (const [index, expected] of LOG_QUERY_CONTRACT.entries()) {
      problems.push(...resultProblems(value.results[index], expected, value.policy));
    }
  }
  problems.push(
    ...sourceArtifactProblems(
      value.sourceArtifact,
      value.policy,
      value.retentionReadback
    )
  );
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    bindings: ok
      ? {
          candidateCommit: value.candidateCommit,
          deploymentCommit: value.deploymentCommit,
          logPolicyDigest: expectedPolicyDigest,
          providerExportDigest: value.sourceArtifact.digest.slice(
            "sha256:".length
          ),
          providerQueryRef: value.sourceArtifact.query.providerQueryRef,
          retentionReadbackDigest:
            value.sourceArtifact.retentionReadbackDigest,
          sourceTool: `${value.sourceArtifact.tool.name}@${value.sourceArtifact.tool.version}`,
          effectiveSourceObservedAt: value.retentionReadback.readAt
        }
      : null,
    receiptDigest: ok ? canonicalEvidenceDigest(value) : null
  };
}

function sanitizeResults(policy, rawResults) {
  if (!Array.isArray(rawResults)) throw new Error("rawResults must be an array");
  return LOG_QUERY_CONTRACT.map((query) => {
    const matches = rawResults
      .filter((entry) => isRecord(entry) && entry.queryId === query.id)
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.observedAt !== "string") {
          throw new Error(`${query.id} raw result must contain observedAt`);
        }
        return { observedAt: entry.observedAt };
      })
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    if (matches.length === 0 || matches.length > policy.maxEventsPerQuery) {
      throw new Error(
        `${query.id} raw results must contain 1-${policy.maxEventsPerQuery} events`
      );
    }
    return {
      queryId: query.id,
      matchCount: matches.length,
      firstMatchedAt: matches[0].observedAt,
      lastMatchedAt: matches.at(-1).observedAt,
      events: matches
    };
  });
}

/**
 * Raw result objects may contain provider-specific data. This producer retains
 * only queryId for grouping and observedAt in the committed output.
 */
export function buildLogRetentionEvidence({
  sourceBytes
}) {
  let exactBytes;
  if (typeof sourceBytes === "string") {
    exactBytes = Buffer.from(sourceBytes, "utf8");
  } else if (sourceBytes instanceof Uint8Array) {
    exactBytes = Buffer.from(
      sourceBytes.buffer,
      sourceBytes.byteOffset,
      sourceBytes.byteLength
    );
  } else {
    throw new Error("provider log export must be supplied as exact bytes");
  }
  if (
    exactBytes.length < 1 ||
    exactBytes.length > LOG_PROVIDER_EXPORT_MAX_BYTES
  ) {
    throw new Error(
      `provider log export must contain 1 through ${LOG_PROVIDER_EXPORT_MAX_BYTES} bytes`
    );
  }
  let source;
  try {
    source = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(exactBytes)
    );
  } catch {
    throw new Error("provider log export must contain valid UTF-8 JSON");
  }
  const sourceProblems = [];
  if (
    !exactKeys(
      source,
      [
        "candidateCommit",
        "deploymentCommit",
        "policy",
        "retentionReadback",
        "rawResults",
        "sourceTool",
        "providerQueryId"
      ],
      "provider log export",
      sourceProblems
    )
  ) {
    throw new Error(sourceProblems.join("; "));
  }
  const {
    candidateCommit,
    deploymentCommit,
    policy,
    retentionReadback,
    rawResults,
    sourceTool,
    providerQueryId
  } = source;
  if (
    typeof policy?.policyId !== "string" ||
    retentionReadback?.providerPolicyRef !== policy.policyId
  ) {
    sourceProblems.push(
      "retentionReadback.providerPolicyRef must exactly equal policy.policyId before redaction"
    );
  }
  if (
    !exactKeys(sourceTool, SOURCE_TOOL_KEYS, "sourceTool", sourceProblems)
  ) {
    throw new Error(sourceProblems.join("; "));
  }
  for (const field of SOURCE_TOOL_KEYS) {
    if (
      !boundedString(sourceTool[field], {
        maximum: 100,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
      })
    ) {
      sourceProblems.push(`sourceTool.${field} must be a bounded identifier`);
    }
  }
  if (
    !boundedString(providerQueryId, {
      maximum: 200,
      pattern: OPAQUE_REF
    })
  ) {
    sourceProblems.push("providerQueryId must be a bounded opaque identifier");
  }
  if (sourceProblems.length > 0) {
    throw new Error(sourceProblems.join("; "));
  }
  const normalizedRetentionReadback = {
    readAt: retentionReadback?.readAt,
    configuredRetentionDays: retentionReadback?.configuredRetentionDays,
    providerPolicyRef:
      typeof retentionReadback?.providerPolicyRef === "string"
        ? `sha256:${sha256Bytes(
            `${PROVIDER_POLICY_REF_DOMAIN}${retentionReadback.providerPolicyRef}`
          )}`
        : retentionReadback?.providerPolicyRef
  };
  const normalizedPolicy = {
    ...policy,
    policyId:
      typeof policy?.policyId === "string"
        ? `sha256:${sha256Bytes(`${POLICY_ID_DOMAIN}${policy.policyId}`)}`
        : policy?.policyId
  };
  const receipt = {
    schemaVersion: LOG_RETENTION_EVIDENCE_SCHEMA_VERSION,
    artifactKind: LOG_RETENTION_EVIDENCE_KIND,
    candidateCommit,
    deploymentCommit,
    capturedAt: normalizedRetentionReadback.readAt,
    policy: normalizedPolicy,
    logPolicyDigest: logPolicyDigest(normalizedPolicy),
    retentionReadback: normalizedRetentionReadback,
    results: sanitizeResults(normalizedPolicy, rawResults),
    sourceArtifact: {
      kind: "provider-log-retention-export",
      digest: `sha256:${sha256Bytes(exactBytes)}`,
      byteLength: exactBytes.length,
      tool: sourceTool,
      query: {
        providerQueryRef: `sha256:${sha256Bytes(
          `site-behavior-lab-log-query-v1\u0000${providerQueryId}`
        )}`,
        startedAt: normalizedPolicy?.queryWindow?.startedAt,
        endedAt: normalizedPolicy?.queryWindow?.endedAt
      },
      retentionReadbackDigest: canonicalEvidenceDigest(
        normalizedRetentionReadback
      )
    }
  };
  const verdict = validateLogRetentionEvidence(receipt);
  if (!verdict.ok) {
    throw new Error(`Invalid log-retention evidence: ${verdict.problems.join("; ")}`);
  }
  return receipt;
}

export function serializeLogRetentionEvidence(value) {
  const verdict = validateLogRetentionEvidence(value);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return serializeCanonicalEvidence(value);
}

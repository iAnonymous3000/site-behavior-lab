import {
  boundedString,
  canonicalEvidenceDigest,
  exactKeys,
  isRecord,
  parseCanonicalEvidence,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const WAF_CEILING_EVIDENCE_KIND =
  "site-behavior-waf-ceiling-probe-receipt";
export const WAF_CEILING_EVIDENCE_SCHEMA_VERSION = 1;
export const WAF_CEILING_EVIDENCE_PATH =
  "research/ops-evidence/waf-ceilings.json";
export const WAF_PROBE_TRANSCRIPT_KIND =
  "site-behavior-waf-ceiling-probe-transcript";
export const WAF_PROBE_TRANSCRIPT_PATH =
  "research/ops-evidence/waf-probe-transcript.json";
export const PRODUCTION_WAF_ORIGIN = "https://scan.sitebehavior.org";
export const WAF_REQUEST_TIMEOUT_MS = 5_000;
export const WAF_COOLDOWN_MARGIN_MS = 1_000;
export const WAF_PROBE_TRANSCRIPT_MAX_BYTES = 512 * 1024;
export const WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
export const WAF_PROVIDER_QUERY_MAX_WINDOW_MS = 5 * 60 * 1_000;
export const WAF_POST_PROBE_BODY = "{}";
export const WAF_POST_PROBE_BODY_DIGEST =
  `sha256:${sha256Bytes(WAF_POST_PROBE_BODY)}`;

export const WAF_ROUTE_CONTRACT = Object.freeze([
  Object.freeze({
    id: "get-admission",
    method: "GET",
    path: "/api/scan/admission"
  }),
  Object.freeze({
    id: "post-admission",
    method: "POST",
    path: "/api/scan"
  })
]);

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "candidateCommit",
  "deploymentCommit",
  "capturedAt",
  "postProbeBodyDigest",
  "rulePolicy",
  "wafRulesDigest",
  "probes",
  "providerEventReadback",
  "providerEventReadbackDigest",
  "sourceArtifacts"
];
const PROBE_TRANSCRIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "candidateCommit",
  "deploymentCommit",
  "recordedAt",
  "postProbeBodyDigest",
  "rulePolicy",
  "wafRulesDigest",
  "probes"
];
const POLICY_KEYS = [
  "provider",
  "ruleId",
  "ruleVersion",
  "requestLimit",
  "windowSeconds",
  "mitigationTimeoutSeconds",
  "routes"
];
const ROUTE_KEYS = ["id", "method", "path"];
const PROBE_KEYS = ["routeId", "startedAt", "completedAt", "observations"];
const OBSERVATION_KEYS = [
  "ordinal",
  "status",
  "retryAfterSeconds",
  "providerRequestRef"
];
const PROVIDER_READBACK_KEYS = ["queriedAt", "events"];
const PROVIDER_EVENT_KEYS = [
  "ruleId",
  "method",
  "path",
  "action",
  "timestamp",
  "providerRequestRef"
];
const PROVIDER_EXPORT_EVENT_KEYS = [
  "ruleId",
  "method",
  "path",
  "action",
  "timestamp",
  "requestId"
];
const SOURCE_ARTIFACTS_KEYS = ["probeTranscript", "providerEventsExport"];
const PROBE_SOURCE_KEYS = [
  "kind",
  "digest",
  "byteLength",
  "recordedAt"
];
const PROVIDER_SOURCE_KEYS = [
  "kind",
  "digest",
  "byteLength",
  "tool",
  "query",
  "exportedAt"
];
const SOURCE_TOOL_KEYS = ["name", "version"];
const SOURCE_QUERY_KEYS = [
  "provider",
  "zoneRef",
  "startedAt",
  "endedAt"
];
const PROVIDER_EXPORT_KEYS = ["tool", "query", "exportedAt", "events"];
const PROVIDER_EXPORT_QUERY_KEYS = [
  "provider",
  "zoneId",
  "startedAt",
  "endedAt"
];
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const PROVIDER_REQUEST_ID = /^([0-9a-fA-F]{16})(?:-[A-Za-z]{3})?$/;
const PROVIDER_REQUEST_REF_DOMAIN =
  "site-behavior-lab-waf-request-correlation-v1\u0000";

export function wafRulesDigest(rulePolicy) {
  return canonicalEvidenceDigest(rulePolicy);
}

export function wafProviderEventReadbackDigest(providerEventReadback) {
  return canonicalEvidenceDigest(providerEventReadback);
}

export function wafProviderRequestRef(value) {
  if (!boundedString(value, { maximum: 20 })) {
    throw new Error("provider request correlation id must use the Cloudflare Ray ID shape");
  }
  const match = value.match(PROVIDER_REQUEST_ID);
  if (match === null) {
    throw new Error("provider request correlation id must use the Cloudflare Ray ID shape");
  }
  const normalizedRayId = match[1].toLowerCase();
  return `sha256:${sha256Bytes(
    `${PROVIDER_REQUEST_REF_DOMAIN}${normalizedRayId}`
  )}`;
}

function policyProblems(policy) {
  const problems = [];
  if (!exactKeys(policy, POLICY_KEYS, "rulePolicy", problems)) return problems;
  for (const field of ["provider", "ruleId", "ruleVersion"]) {
    if (!boundedString(policy[field], { maximum: 200 })) {
      problems.push(`rulePolicy.${field} must be a bounded, trimmed identifier`);
    }
  }
  if (policy.requestLimit !== 10) {
    problems.push("rulePolicy.requestLimit must be exactly 10");
  }
  if (!Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1 || policy.windowSeconds > 60) {
    problems.push("rulePolicy.windowSeconds must be an integer from 1 through 60");
  }
  if (
    !Number.isSafeInteger(policy.mitigationTimeoutSeconds) ||
    policy.mitigationTimeoutSeconds < 1 ||
    policy.mitigationTimeoutSeconds > 300
  ) {
    problems.push(
      "rulePolicy.mitigationTimeoutSeconds must be an integer from 1 through 300"
    );
  }
  if (
    !Array.isArray(policy.routes) ||
    policy.routes.length !== WAF_ROUTE_CONTRACT.length
  ) {
    problems.push("rulePolicy.routes must contain the exact GET and POST admission routes");
    return problems;
  }
  for (const [index, expected] of WAF_ROUTE_CONTRACT.entries()) {
    const route = policy.routes[index];
    if (!exactKeys(route, ROUTE_KEYS, `rulePolicy.routes[${index}]`, problems)) {
      continue;
    }
    for (const field of ROUTE_KEYS) {
      if (route[field] !== expected[field]) {
        problems.push(
          `rulePolicy.routes[${index}].${field} must be exactly ${expected[field]}`
        );
      }
    }
  }
  return problems;
}

function probeProblems(probe, expectedRoute, policy) {
  const problems = [];
  if (!exactKeys(probe, PROBE_KEYS, `probe ${expectedRoute.id}`, problems)) {
    return problems;
  }
  if (probe.routeId !== expectedRoute.id) {
    problems.push(`probe routeId must be exactly ${expectedRoute.id}`);
  }
  const startedAt = requireCanonicalInstant(
    probe.startedAt,
    `${expectedRoute.id}.startedAt`,
    problems
  );
  const completedAt = requireCanonicalInstant(
    probe.completedAt,
    `${expectedRoute.id}.completedAt`,
    problems
  );
  if (startedAt !== null && completedAt !== null) {
    if (completedAt < startedAt) {
      problems.push(`${expectedRoute.id} completedAt must not precede startedAt`);
    } else if (completedAt - startedAt > policy.windowSeconds * 1_000) {
      problems.push(
        `${expectedRoute.id} requests must complete inside the configured WAF window`
      );
    }
  }
  const expectedCount = policy.requestLimit + 1;
  if (!Array.isArray(probe.observations) || probe.observations.length !== expectedCount) {
    problems.push(
      `${expectedRoute.id}.observations must contain exactly ${expectedCount} requests`
    );
    return problems;
  }
  for (let index = 0; index < probe.observations.length; index += 1) {
    const observation = probe.observations[index];
    const label = `${expectedRoute.id}.observations[${index}]`;
    if (!exactKeys(observation, OBSERVATION_KEYS, label, problems)) continue;
    if (observation.ordinal !== index + 1) {
      problems.push(`${label}.ordinal must be exactly ${index + 1}`);
    }
    if (
      !Number.isSafeInteger(observation.status) ||
      observation.status < 100 ||
      observation.status > 599
    ) {
      problems.push(`${label}.status must be a valid HTTP status`);
    }
    if (index < policy.requestLimit) {
      if (
        expectedRoute.id === "post-admission" &&
        observation.status !== 400
      ) {
        problems.push(
          `${label}.status must be exactly 400 for the fixed invalid POST probe before request 11`
        );
      }
      if (observation.status === 429) {
        problems.push(`${label} must not be rate limited before request 11`);
      }
      if (observation.retryAfterSeconds !== null) {
        problems.push(`${label}.retryAfterSeconds must be null before request 11`);
      }
      if (observation.providerRequestRef !== null) {
        problems.push(
          `${label}.providerRequestRef must be null before request 11`
        );
      }
    } else {
      if (observation.status !== 429) {
        problems.push(`${label}.status must be exactly 429`);
      }
      if (observation.retryAfterSeconds !== policy.mitigationTimeoutSeconds) {
        problems.push(
          `${label}.retryAfterSeconds must equal rulePolicy.mitigationTimeoutSeconds`
        );
      }
      if (
        typeof observation.providerRequestRef !== "string" ||
        !SHA256_REF.test(observation.providerRequestRef)
      ) {
        problems.push(
          `${label}.providerRequestRef must be a domain-separated sha256 reference`
        );
      }
    }
  }
  return problems;
}

function providerEventReadbackProblems(readback, probes, policy, capturedAt) {
  const problems = [];
  if (
    !exactKeys(
      readback,
      PROVIDER_READBACK_KEYS,
      "providerEventReadback",
      problems
    )
  ) {
    return problems;
  }
  const queriedAt = requireCanonicalInstant(
    readback.queriedAt,
    "providerEventReadback.queriedAt",
    problems
  );
  if (
    !Array.isArray(readback.events) ||
    readback.events.length !== WAF_ROUTE_CONTRACT.length
  ) {
    problems.push(
      "providerEventReadback.events must contain exactly one redacted event for each admission route"
    );
    return problems;
  }
  for (const [index, route] of WAF_ROUTE_CONTRACT.entries()) {
    const event = readback.events[index];
    const label = `providerEventReadback.events[${index}]`;
    if (!exactKeys(event, PROVIDER_EVENT_KEYS, label, problems)) continue;
    const expected = {
      ruleId: policy?.ruleId,
      method: route.method,
      path: route.path,
      action: "block",
      providerRequestRef:
        probes?.[index]?.observations?.at(-1)?.providerRequestRef
    };
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (event[field] !== expectedValue) {
        problems.push(`${label}.${field} must be exactly ${expectedValue}`);
      }
    }
    const eventAt = requireCanonicalInstant(
      event.timestamp,
      `${label}.timestamp`,
      problems
    );
    if (
      typeof event.providerRequestRef !== "string" ||
      !SHA256_REF.test(event.providerRequestRef)
    ) {
      problems.push(
        `${label}.providerRequestRef must be a domain-separated sha256 reference`
      );
    }
    const probeStartedAt = Date.parse(probes?.[index]?.startedAt);
    const probeCompletedAt = Date.parse(probes?.[index]?.completedAt);
    if (
      eventAt !== null &&
      Number.isFinite(probeStartedAt) &&
      Number.isFinite(probeCompletedAt) &&
      (eventAt < probeStartedAt || eventAt > probeCompletedAt)
    ) {
      problems.push(`${label}.timestamp must fall inside its route probe window`);
    }
    if (
      queriedAt !== null &&
      Number.isFinite(probeCompletedAt) &&
      queriedAt < probeCompletedAt
    ) {
      problems.push(
        "providerEventReadback.queriedAt must follow both completed route probes"
      );
    }
  }
  if (queriedAt !== null && capturedAt !== null && queriedAt > capturedAt) {
    problems.push("providerEventReadback.queriedAt must not follow capturedAt");
  }
  return problems;
}

function probeTranscriptFromReceipt(value, recordedAt) {
  return {
    schemaVersion: WAF_CEILING_EVIDENCE_SCHEMA_VERSION,
    artifactKind: WAF_PROBE_TRANSCRIPT_KIND,
    candidateCommit: value?.candidateCommit,
    deploymentCommit: value?.deploymentCommit,
    recordedAt,
    postProbeBodyDigest: value?.postProbeBodyDigest,
    rulePolicy: value?.rulePolicy,
    wafRulesDigest: value?.wafRulesDigest,
    probes: value?.probes
  };
}

export function validateWafProbeTranscript(value) {
  const problems = [];
  if (
    !exactKeys(
      value,
      PROBE_TRANSCRIPT_KEYS,
      "WAF probe transcript",
      problems
    )
  ) {
    return { ok: false, problems, transcriptDigest: null };
  }
  if (value.schemaVersion !== WAF_CEILING_EVIDENCE_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be exactly ${WAF_CEILING_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  if (value.artifactKind !== WAF_PROBE_TRANSCRIPT_KIND) {
    problems.push(`artifactKind must be exactly ${WAF_PROBE_TRANSCRIPT_KIND}`);
  }
  requireCommit(value.candidateCommit, "candidateCommit", problems);
  requireCommit(value.deploymentCommit, "deploymentCommit", problems);
  const recordedAt = requireCanonicalInstant(
    value.recordedAt,
    "recordedAt",
    problems
  );
  if (value.postProbeBodyDigest !== WAF_POST_PROBE_BODY_DIGEST) {
    problems.push(
      `postProbeBodyDigest must be exactly ${WAF_POST_PROBE_BODY_DIGEST}`
    );
  }
  problems.push(...policyProblems(value.rulePolicy));
  let expectedPolicyDigest = null;
  try {
    expectedPolicyDigest = wafRulesDigest(value.rulePolicy);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  requireSha256(value.wafRulesDigest, "wafRulesDigest", problems);
  if (
    expectedPolicyDigest !== null &&
    value.wafRulesDigest !== expectedPolicyDigest
  ) {
    problems.push(
      "wafRulesDigest does not match the exact canonical rulePolicy bytes"
    );
  }
  if (
    !Array.isArray(value.probes) ||
    value.probes.length !== WAF_ROUTE_CONTRACT.length
  ) {
    problems.push(
      "probes must contain exactly one GET and one POST admission probe"
    );
  } else {
    for (const [index, route] of WAF_ROUTE_CONTRACT.entries()) {
      problems.push(
        ...probeProblems(value.probes[index], route, value.rulePolicy)
      );
    }
    if (value.probes.every((probe) => isRecord(probe))) {
      for (const probe of value.probes) {
        const completedAt = requireCanonicalInstant(
          probe.completedAt,
          `${probe.routeId ?? "probe"}.completedAt`,
          []
        );
        if (completedAt !== null && recordedAt !== null && completedAt > recordedAt) {
          problems.push(`${probe.routeId}.completedAt must not follow recordedAt`);
        }
      }
      const getCompleted = Date.parse(value.probes[0].completedAt);
      const postStarted = Date.parse(value.probes[1].startedAt);
      if (
        Number.isFinite(getCompleted) &&
        Number.isFinite(postStarted) &&
        postStarted - getCompleted <
          value.rulePolicy.mitigationTimeoutSeconds * 1_000 +
            WAF_COOLDOWN_MARGIN_MS
      ) {
        problems.push(
          "POST probe must start after the GET route's mitigation timeout plus the isolation margin so each route proves its own 11th request"
        );
      }
      const providerRequestRefs = value.probes.map(
        (probe) => probe.observations?.at(-1)?.providerRequestRef
      );
      if (
        providerRequestRefs.every(
          (reference) =>
            typeof reference === "string" && SHA256_REF.test(reference)
        ) &&
        new Set(providerRequestRefs).size !== providerRequestRefs.length
      ) {
        problems.push(
          "each route's eleventh response must have a distinct provider request reference"
        );
      }
    }
  }
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    transcriptDigest: ok ? canonicalEvidenceDigest(value) : null
  };
}

function sourceArtifactProblems(sourceArtifacts, value, capturedAt) {
  const problems = [];
  if (
    !exactKeys(
      sourceArtifacts,
      SOURCE_ARTIFACTS_KEYS,
      "sourceArtifacts",
      problems
    )
  ) {
    return problems;
  }
  const probeSource = sourceArtifacts.probeTranscript;
  if (
    exactKeys(
      probeSource,
      PROBE_SOURCE_KEYS,
      "sourceArtifacts.probeTranscript",
      problems
    )
  ) {
    if (probeSource.kind !== WAF_PROBE_TRANSCRIPT_KIND) {
      problems.push(
        `sourceArtifacts.probeTranscript.kind must be exactly ${WAF_PROBE_TRANSCRIPT_KIND}`
      );
    }
    if (
      typeof probeSource.digest !== "string" ||
      !SHA256_REF.test(probeSource.digest)
    ) {
      problems.push(
        "sourceArtifacts.probeTranscript.digest must be an exact sha256:<64 lowercase hex> reference"
      );
    }
    const probeRecordedAt = requireCanonicalInstant(
      probeSource.recordedAt,
      "sourceArtifacts.probeTranscript.recordedAt",
      problems
    );
    const reconstructedTranscript = probeTranscriptFromReceipt(
      value,
      probeSource.recordedAt
    );
    try {
      const bytes = serializeCanonicalEvidence(reconstructedTranscript);
      const expectedDigest = `sha256:${sha256Bytes(bytes)}`;
      if (probeSource.digest !== expectedDigest) {
        problems.push(
          "sourceArtifacts.probeTranscript.digest must bind the exact canonical probe transcript"
        );
      }
      if (probeSource.byteLength !== Buffer.byteLength(bytes, "utf8")) {
        problems.push(
          "sourceArtifacts.probeTranscript.byteLength must match the exact canonical probe transcript"
        );
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (
      !Number.isSafeInteger(probeSource.byteLength) ||
      probeSource.byteLength < 1 ||
      probeSource.byteLength > WAF_PROBE_TRANSCRIPT_MAX_BYTES
    ) {
      problems.push(
        `sourceArtifacts.probeTranscript.byteLength must be between 1 and ${WAF_PROBE_TRANSCRIPT_MAX_BYTES}`
      );
    }
    if (
      probeRecordedAt !== null &&
      capturedAt !== null &&
      probeRecordedAt > capturedAt
    ) {
      problems.push(
        "sourceArtifacts.probeTranscript.recordedAt must not follow capturedAt"
      );
    }
  }
  const providerSource = sourceArtifacts.providerEventsExport;
  if (
    exactKeys(
      providerSource,
      PROVIDER_SOURCE_KEYS,
      "sourceArtifacts.providerEventsExport",
      problems
    )
  ) {
    if (providerSource.kind !== "cloudflare-security-events-export") {
      problems.push(
        "sourceArtifacts.providerEventsExport.kind must be exactly cloudflare-security-events-export"
      );
    }
    if (
      typeof providerSource.digest !== "string" ||
      !SHA256_REF.test(providerSource.digest)
    ) {
      problems.push(
        "sourceArtifacts.providerEventsExport.digest must be an exact sha256:<64 lowercase hex> reference"
      );
    }
    if (
      !Number.isSafeInteger(providerSource.byteLength) ||
      providerSource.byteLength < 1 ||
      providerSource.byteLength > WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES
    ) {
      problems.push(
        `sourceArtifacts.providerEventsExport.byteLength must be between 1 and ${WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES}`
      );
    }
    if (
      exactKeys(
        providerSource.tool,
        SOURCE_TOOL_KEYS,
        "sourceArtifacts.providerEventsExport.tool",
        problems
      )
    ) {
      for (const field of SOURCE_TOOL_KEYS) {
        if (
          !boundedString(providerSource.tool[field], {
            maximum: 100,
            pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
          })
        ) {
          problems.push(
            `sourceArtifacts.providerEventsExport.tool.${field} must be a bounded identifier`
          );
        }
      }
    }
    let queryStartedAt = null;
    let queryEndedAt = null;
    if (
      exactKeys(
        providerSource.query,
        SOURCE_QUERY_KEYS,
        "sourceArtifacts.providerEventsExport.query",
        problems
      )
    ) {
      if (
        providerSource.query.provider !== "cloudflare" ||
        providerSource.query.provider !== value.rulePolicy?.provider
      ) {
        problems.push(
          "sourceArtifacts.providerEventsExport.query.provider must match the cloudflare rule policy"
        );
      }
      if (
        typeof providerSource.query.zoneRef !== "string" ||
        !SHA256_REF.test(providerSource.query.zoneRef)
      ) {
        problems.push(
          "sourceArtifacts.providerEventsExport.query.zoneRef must be a domain-separated sha256 reference"
        );
      }
      queryStartedAt = requireCanonicalInstant(
        providerSource.query.startedAt,
        "sourceArtifacts.providerEventsExport.query.startedAt",
        problems
      );
      queryEndedAt = requireCanonicalInstant(
        providerSource.query.endedAt,
        "sourceArtifacts.providerEventsExport.query.endedAt",
        problems
      );
      if (
        queryStartedAt !== null &&
        queryEndedAt !== null &&
        queryEndedAt < queryStartedAt
      ) {
        problems.push(
          "provider Security Events query window must not run backwards"
        );
      } else if (
        queryStartedAt !== null &&
        queryEndedAt !== null &&
        queryEndedAt - queryStartedAt > WAF_PROVIDER_QUERY_MAX_WINDOW_MS
      ) {
        problems.push(
          "provider Security Events query window must not exceed five minutes"
        );
      }
      const firstProbeStartedAt = Date.parse(value.probes?.[0]?.startedAt);
      const lastProbeCompletedAt = Date.parse(value.probes?.at(-1)?.completedAt);
      if (
        queryStartedAt !== null &&
        Number.isFinite(firstProbeStartedAt) &&
        queryStartedAt > firstProbeStartedAt
      ) {
        problems.push(
          "provider Security Events query must start no later than the first probe"
        );
      }
      if (
        queryEndedAt !== null &&
        Number.isFinite(lastProbeCompletedAt) &&
        queryEndedAt < lastProbeCompletedAt
      ) {
        problems.push(
          "provider Security Events query must end no earlier than the last probe"
        );
      }
      if (value.providerEventReadback?.queriedAt !== providerSource.query.endedAt) {
        problems.push(
          "providerEventReadback.queriedAt must equal the bound provider query end"
        );
      }
    }
    const exportedAt = requireCanonicalInstant(
      providerSource.exportedAt,
      "sourceArtifacts.providerEventsExport.exportedAt",
      problems
    );
    if (
      exportedAt !== null &&
      queryEndedAt !== null &&
      exportedAt < queryEndedAt
    ) {
      problems.push(
        "provider Security Events export must not precede its query end"
      );
    }
    if (
      exportedAt !== null &&
      capturedAt !== null &&
      exportedAt > capturedAt
    ) {
      problems.push(
        "provider Security Events export must not follow capturedAt"
      );
    }
  }
  return problems;
}

export function validateWafCeilingEvidence(value) {
  const problems = [];
  if (!exactKeys(value, RECEIPT_KEYS, "WAF receipt", problems)) {
    return { ok: false, problems, bindings: null, receiptDigest: null };
  }
  if (value.schemaVersion !== WAF_CEILING_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be exactly ${WAF_CEILING_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (value.artifactKind !== WAF_CEILING_EVIDENCE_KIND) {
    problems.push(`artifactKind must be exactly ${WAF_CEILING_EVIDENCE_KIND}`);
  }
  requireCommit(value.candidateCommit, "candidateCommit", problems);
  requireCommit(value.deploymentCommit, "deploymentCommit", problems);
  const capturedAt = requireCanonicalInstant(value.capturedAt, "capturedAt", problems);
  problems.push(...policyProblems(value.rulePolicy));
  let expectedPolicyDigest = null;
  try {
    expectedPolicyDigest = wafRulesDigest(value.rulePolicy);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  requireSha256(value.wafRulesDigest, "wafRulesDigest", problems);
  if (expectedPolicyDigest !== null && value.wafRulesDigest !== expectedPolicyDigest) {
    problems.push("wafRulesDigest does not match the exact canonical rulePolicy bytes");
  }
  if (!Array.isArray(value.probes) || value.probes.length !== WAF_ROUTE_CONTRACT.length) {
    problems.push("probes must contain exactly one GET and one POST admission probe");
  } else {
    for (const [index, route] of WAF_ROUTE_CONTRACT.entries()) {
      problems.push(...probeProblems(value.probes[index], route, value.rulePolicy));
    }
    if (
      capturedAt !== null &&
      value.probes.every((probe) => isRecord(probe))
    ) {
      for (const probe of value.probes) {
        const completedAt = requireCanonicalInstant(
          probe.completedAt,
          `${probe.routeId ?? "probe"}.completedAt`,
          []
        );
        if (completedAt !== null && completedAt > capturedAt) {
          problems.push(`${probe.routeId}.completedAt must not follow capturedAt`);
        }
      }
      const getCompleted = Date.parse(value.probes[0].completedAt);
      const postStarted = Date.parse(value.probes[1].startedAt);
      if (
        Number.isFinite(getCompleted) &&
        Number.isFinite(postStarted) &&
        postStarted - getCompleted <
          value.rulePolicy.mitigationTimeoutSeconds * 1_000 +
            WAF_COOLDOWN_MARGIN_MS
      ) {
        problems.push(
          "POST probe must start after the GET route's mitigation timeout plus the isolation margin so each route proves its own 11th request"
        );
      }
    }
  }
  problems.push(
    ...providerEventReadbackProblems(
      value.providerEventReadback,
      value.probes,
      value.rulePolicy,
      capturedAt
    )
  );
  let expectedProviderEventReadbackDigest = null;
  try {
    expectedProviderEventReadbackDigest = wafProviderEventReadbackDigest(
      value.providerEventReadback
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  requireSha256(
    value.providerEventReadbackDigest,
    "providerEventReadbackDigest",
    problems
  );
  if (
    expectedProviderEventReadbackDigest !== null &&
    value.providerEventReadbackDigest !== expectedProviderEventReadbackDigest
  ) {
    problems.push(
      "providerEventReadbackDigest does not match the exact canonical provider Security Events readback bytes"
    );
  }
  const reconstructedTranscript = probeTranscriptFromReceipt(
    value,
    value.sourceArtifacts?.probeTranscript?.recordedAt
  );
  const transcriptVerdict = validateWafProbeTranscript(
    reconstructedTranscript
  );
  if (!transcriptVerdict.ok) {
    problems.push(
      ...transcriptVerdict.problems.map(
        (problem) => `bound probe transcript: ${problem}`
      )
    );
  }
  problems.push(
    ...sourceArtifactProblems(value.sourceArtifacts, value, capturedAt)
  );
  const effectiveSourceObservedAt =
    value.sourceArtifacts?.providerEventsExport?.exportedAt;
  const effectiveSourceInstant = requireCanonicalInstant(
    effectiveSourceObservedAt,
    "sourceArtifacts.providerEventsExport.exportedAt",
    []
  );
  if (
    capturedAt !== null &&
    effectiveSourceInstant !== null &&
    value.capturedAt !== effectiveSourceObservedAt
  ) {
    problems.push(
      "capturedAt must exactly equal the effective source observation time"
    );
  }
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    bindings: ok
      ? {
          candidateCommit: value.candidateCommit,
          deploymentCommit: value.deploymentCommit,
          wafRulesDigest: expectedPolicyDigest,
          providerEventReadbackDigest: expectedProviderEventReadbackDigest,
          probeTranscriptDigest:
            value.sourceArtifacts.probeTranscript.digest.slice("sha256:".length),
          providerEventsExportDigest:
            value.sourceArtifacts.providerEventsExport.digest.slice(
              "sha256:".length
            ),
          effectiveSourceObservedAt
        }
      : null,
    receiptDigest: ok ? canonicalEvidenceDigest(value) : null
  };
}

export function buildWafProbeTranscript({
  candidateCommit,
  deploymentCommit,
  recordedAt,
  rulePolicy,
  probes
}) {
  const transcript = {
    schemaVersion: WAF_CEILING_EVIDENCE_SCHEMA_VERSION,
    artifactKind: WAF_PROBE_TRANSCRIPT_KIND,
    candidateCommit,
    deploymentCommit,
    recordedAt,
    postProbeBodyDigest: WAF_POST_PROBE_BODY_DIGEST,
    rulePolicy,
    wafRulesDigest: wafRulesDigest(rulePolicy),
    probes
  };
  const verdict = validateWafProbeTranscript(transcript);
  if (!verdict.ok) {
    throw new Error(
      `Invalid WAF probe transcript: ${verdict.problems.join("; ")}`
    );
  }
  return transcript;
}

function exactSourceBytes(value, label, maximumBytes) {
  let bytes;
  if (typeof value === "string") {
    bytes = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new Error(`${label} must be supplied as exact bytes`);
  }
  if (bytes.length < 1 || bytes.length > maximumBytes) {
    throw new Error(`${label} must contain 1 through ${maximumBytes} bytes`);
  }
  return bytes;
}

function parseProviderEventsExport(bytes) {
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new Error(
      "provider Security Events export must contain valid UTF-8 JSON"
    );
  }
  const problems = [];
  if (
    !exactKeys(
      value,
      PROVIDER_EXPORT_KEYS,
      "provider Security Events export",
      problems
    )
  ) {
    throw new Error(problems.join("; "));
  }
  if (
    exactKeys(
      value.tool,
      SOURCE_TOOL_KEYS,
      "provider Security Events export.tool",
      problems
    )
  ) {
    for (const field of SOURCE_TOOL_KEYS) {
      if (
        !boundedString(value.tool[field], {
          maximum: 100,
          pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
        })
      ) {
        problems.push(
          `provider Security Events export.tool.${field} must be a bounded identifier`
        );
      }
    }
  }
  if (
    exactKeys(
      value.query,
      PROVIDER_EXPORT_QUERY_KEYS,
      "provider Security Events export.query",
      problems
    )
  ) {
    if (value.query.provider !== "cloudflare") {
      problems.push(
        "provider Security Events export.query.provider must be exactly cloudflare"
      );
    }
    if (
      !boundedString(value.query.zoneId, {
        maximum: 200,
        pattern: /^[A-Za-z0-9_-]{1,200}$/
      })
    ) {
      problems.push(
        "provider Security Events export.query.zoneId must be a bounded provider identifier"
      );
    }
    const queryStart = requireCanonicalInstant(
      value.query.startedAt,
      "provider Security Events export.query.startedAt",
      problems
    );
    const queryEnd = requireCanonicalInstant(
      value.query.endedAt,
      "provider Security Events export.query.endedAt",
      problems
    );
    if (
      queryStart !== null &&
      queryEnd !== null &&
      queryEnd < queryStart
    ) {
      problems.push(
        "provider Security Events export query window must not run backwards"
      );
    } else if (
      queryStart !== null &&
      queryEnd !== null &&
      queryEnd - queryStart > WAF_PROVIDER_QUERY_MAX_WINDOW_MS
    ) {
      problems.push(
        "provider Security Events export query window must not exceed five minutes"
      );
    }
  }
  const exportedAt = requireCanonicalInstant(
    value.exportedAt,
    "provider Security Events export.exportedAt",
    problems
  );
  const queryEndedAt = Date.parse(value.query?.endedAt);
  if (
    exportedAt !== null &&
    Number.isFinite(queryEndedAt) &&
    exportedAt < queryEndedAt
  ) {
    problems.push(
      "provider Security Events export.exportedAt must not precede the query end"
    );
  }
  if (
    !Array.isArray(value.events) ||
    value.events.length < WAF_ROUTE_CONTRACT.length ||
    value.events.length > 1_000
  ) {
    problems.push(
      "provider Security Events export.events must contain 2 through 1000 sanitized events"
    );
  } else {
    for (const [index, event] of value.events.entries()) {
      const label = `provider Security Events export.events[${index}]`;
      if (!exactKeys(event, PROVIDER_EXPORT_EVENT_KEYS, label, problems)) {
        continue;
      }
      if (!boundedString(event.ruleId, { maximum: 200 })) {
        problems.push(`${label}.ruleId must be a bounded identifier`);
      }
      if (!["GET", "POST"].includes(event.method)) {
        problems.push(`${label}.method must be GET or POST`);
      }
      if (!boundedString(event.path, { maximum: 200 })) {
        problems.push(`${label}.path must be a bounded path`);
      }
      if (event.action !== "block") {
        problems.push(`${label}.action must be exactly block`);
      }
      requireCanonicalInstant(
        event.timestamp,
        `${label}.timestamp`,
        problems
      );
      if (
        !boundedString(event.requestId, { maximum: 20 }) ||
        !PROVIDER_REQUEST_ID.test(event.requestId)
      ) {
        problems.push(
          `${label}.requestId must use the Cloudflare Ray ID shape`
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid provider Security Events export: ${problems.join("; ")}`
    );
  }
  return value;
}

function selectProviderEvents(providerExport, transcript) {
  return WAF_ROUTE_CONTRACT.map((route, index) => {
    const probeStartedAt = Date.parse(transcript.probes[index].startedAt);
    const probeCompletedAt = Date.parse(transcript.probes[index].completedAt);
    const expectedProviderRequestRef =
      transcript.probes[index].observations.at(-1).providerRequestRef;
    const matches = providerExport.events.filter((event) => {
      const timestamp = Date.parse(event?.timestamp);
      let providerRequestRef = null;
      try {
        providerRequestRef = wafProviderRequestRef(event?.requestId);
      } catch {
        return false;
      }
      return (
        isRecord(event) &&
        event.ruleId === transcript.rulePolicy.ruleId &&
        event.method === route.method &&
        event.path === route.path &&
        event.action === "block" &&
        providerRequestRef === expectedProviderRequestRef &&
        Number.isFinite(timestamp) &&
        timestamp >= probeStartedAt &&
        timestamp <= probeCompletedAt
      );
    });
    if (matches.length !== 1) {
      throw new Error(
        `provider Security Events export must contain exactly one matching ${route.id} block event`
      );
    }
    const event = matches[0];
    return {
      ruleId: event.ruleId,
      method: event.method,
      path: event.path,
      action: event.action,
      timestamp: event.timestamp,
      providerRequestRef: expectedProviderRequestRef
    };
  });
}

export function buildWafCeilingEvidence({
  probeTranscriptBytes,
  providerEventsExportBytes
}) {
  const exactProbeBytes = exactSourceBytes(
    probeTranscriptBytes,
    "WAF probe transcript",
    WAF_PROBE_TRANSCRIPT_MAX_BYTES
  );
  const probeTranscript = parseCanonicalEvidence(
    exactProbeBytes.toString("utf8"),
    "WAF probe transcript"
  );
  const probeVerdict = validateWafProbeTranscript(probeTranscript);
  if (!probeVerdict.ok) {
    throw new Error(
      `Invalid WAF probe transcript: ${probeVerdict.problems.join("; ")}`
    );
  }
  const exactProviderBytes = exactSourceBytes(
    providerEventsExportBytes,
    "provider Security Events export",
    WAF_PROVIDER_EVENTS_EXPORT_MAX_BYTES
  );
  const providerExport = parseProviderEventsExport(exactProviderBytes);
  const queryStartedAt = Date.parse(providerExport.query.startedAt);
  const queryEndedAt = Date.parse(providerExport.query.endedAt);
  const firstProbeStartedAt = Date.parse(probeTranscript.probes[0].startedAt);
  const lastProbeCompletedAt = Date.parse(
    probeTranscript.probes.at(-1).completedAt
  );
  if (queryStartedAt > firstProbeStartedAt) {
    throw new Error(
      "provider Security Events query must start no later than the first probe"
    );
  }
  if (queryEndedAt < lastProbeCompletedAt) {
    throw new Error(
      "provider Security Events query must end no earlier than the last probe"
    );
  }
  const providerEventReadback = {
    queriedAt: providerExport.query.endedAt,
    events: selectProviderEvents(providerExport, probeTranscript)
  };
  const receipt = {
    schemaVersion: WAF_CEILING_EVIDENCE_SCHEMA_VERSION,
    artifactKind: WAF_CEILING_EVIDENCE_KIND,
    candidateCommit: probeTranscript.candidateCommit,
    deploymentCommit: probeTranscript.deploymentCommit,
    capturedAt: providerExport.exportedAt,
    postProbeBodyDigest: probeTranscript.postProbeBodyDigest,
    rulePolicy: probeTranscript.rulePolicy,
    wafRulesDigest: probeTranscript.wafRulesDigest,
    probes: probeTranscript.probes,
    providerEventReadback,
    providerEventReadbackDigest: wafProviderEventReadbackDigest(
      providerEventReadback
    ),
    sourceArtifacts: {
      probeTranscript: {
        kind: WAF_PROBE_TRANSCRIPT_KIND,
        digest: `sha256:${sha256Bytes(exactProbeBytes)}`,
        byteLength: exactProbeBytes.length,
        recordedAt: probeTranscript.recordedAt
      },
      providerEventsExport: {
        kind: "cloudflare-security-events-export",
        digest: `sha256:${sha256Bytes(exactProviderBytes)}`,
        byteLength: exactProviderBytes.length,
        tool: providerExport.tool,
        query: {
          provider: providerExport.query.provider,
          zoneRef: `sha256:${sha256Bytes(
            `site-behavior-lab-waf-zone-v1\u0000${providerExport.query.zoneId}`
          )}`,
          startedAt: providerExport.query.startedAt,
          endedAt: providerExport.query.endedAt
        },
        exportedAt: providerExport.exportedAt
      }
    }
  };
  const verdict = validateWafCeilingEvidence(receipt);
  if (!verdict.ok) {
    throw new Error(`Invalid WAF ceiling evidence: ${verdict.problems.join("; ")}`);
  }
  return receipt;
}

function parseRetryAfter(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function canonicalNow(now) {
  const value = now();
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("probe clock returned an invalid instant");
  return instant.toISOString();
}

/**
 * Execute two isolated route probes. Only ordinal, status, parsed Retry-After,
 * and a domain-separated hash of the eleventh response's provider request id
 * are retained; URLs, request headers, raw request ids, POST bodies, and
 * response bodies never enter the receipt.
 */
export async function executeWafCeilingProbe({
  baseUrl,
  candidateCommit,
  deploymentCommit,
  rulePolicy,
  requestMaterial,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (typeof fetchImpl !== "function") throw new Error("a fetch implementation is required");
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("baseUrl must be a credential-free HTTPS origin");
  }
  if (base.pathname !== "/" && base.pathname !== "") {
    throw new Error("baseUrl must not contain a path");
  }
  const preliminary = policyProblems(rulePolicy);
  if (preliminary.length > 0) {
    throw new Error(`Invalid WAF rule policy: ${preliminary.join("; ")}`);
  }
  if (!isRecord(requestMaterial)) throw new Error("request material is required");
  const materialProblems = [];
  if (
    !exactKeys(
      requestMaterial,
      ["get", "post"],
      "request material",
      materialProblems
    )
  ) {
    throw new Error(materialProblems.join("; "));
  }
  for (const route of WAF_ROUTE_CONTRACT) {
    const material =
      route.method === "GET" ? requestMaterial.get : requestMaterial.post;
    if (
      !exactKeys(
        material,
        ["headers"],
        `${route.id} request material`,
        materialProblems
      ) ||
      !isRecord(material.headers)
    ) {
      materialProblems.push(
        `${route.id} request material must contain only a headers object`
      );
    }
  }
  if (materialProblems.length > 0) {
    throw new Error(materialProblems.join("; "));
  }
  const probes = [];
  for (const [routeIndex, route] of WAF_ROUTE_CONTRACT.entries()) {
    if (routeIndex > 0) {
      // Both routes share the IP/data-center counter. The mitigation timeout
      // alone did not isolate POST from the preceding GET burst in production:
      // an 11s gap throttled POST early, while a 21s gap passed unchanged checks.
      // Let the counting window and mitigation period both elapse. Historical
      // receipt validation keeps its original minimum and exact requirements.
      await wait(
        (rulePolicy.windowSeconds + rulePolicy.mitigationTimeoutSeconds) * 1_000 +
          WAF_COOLDOWN_MARGIN_MS
      );
    }
    const startedAt = canonicalNow(now);
    const observations = [];
    for (let ordinal = 1; ordinal <= rulePolicy.requestLimit + 1; ordinal += 1) {
      const material = route.method === "GET" ? requestMaterial.get : requestMaterial.post;
      const headers = new Headers(material.headers);
      if (route.method === "POST") {
        headers.set("content-type", "application/json");
      }
      let response;
      try {
        response = await fetchImpl(new URL(route.path, base), {
          method: route.method,
          headers,
          ...(route.method === "POST"
            ? { body: WAF_POST_PROBE_BODY }
            : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(WAF_REQUEST_TIMEOUT_MS)
        });
      } catch {
        throw new Error(`${route.id} request ${ordinal} failed before an HTTP response`);
      }
      let providerRequestRef = null;
      if (ordinal === rulePolicy.requestLimit + 1) {
        try {
          providerRequestRef = wafProviderRequestRef(
            response.headers.get("cf-ray")
          );
        } catch {
          throw new Error(
            `${route.id} request 11 did not expose a valid provider request correlation id`
          );
        }
      }
      observations.push({
        ordinal,
        status: response.status,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
        providerRequestRef
      });
    }
    probes.push({
      routeId: route.id,
      startedAt,
      completedAt: canonicalNow(now),
      observations
    });
  }
  return buildWafProbeTranscript({
    candidateCommit,
    deploymentCommit,
    recordedAt: canonicalNow(now),
    rulePolicy,
    probes
  });
}

export function serializeWafProbeTranscript(value) {
  const verdict = validateWafProbeTranscript(value);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return serializeCanonicalEvidence(value);
}

export function serializeWafCeilingEvidence(value) {
  const verdict = validateWafCeilingEvidence(value);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return serializeCanonicalEvidence(value);
}
